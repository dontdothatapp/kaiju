// Match recorder: keeps what it takes to re-render the best moments of a match from any camera
// (game/recap.js plays them back after the final KO). It never steers the simulation: it samples
// what's on screen after each step and listens in on the systems that change it.
//
//   fighters        full pose every frame: root, joints, arm smear, hit flash, bruises, trails
//   moving things   instance matrices of live debris, tumbling cars, the train and the military's
//                   helicopters and tanks, 20 times a second
//   world changes   for the whole match: when each city chunk broke, debris pieces spawning /
//                   settling / vanishing, cars waking / settling / burning out
//   effects         particle, shockwave and comic-word spawns, sounds, screen flashes, camera
//                   shake: the calls themselves, replayed later against the new camera
//
// Moving data and effects older than a few seconds are dropped unless they belong to a highlight.
// Highlights are marked by the game (big launches, smashes through buildings, collapses, sky
// dives, supers, KOs); nearby moments merge into one clip and only the best few are kept.
import * as THREE from 'three';
import { G } from '../core/context.js';
import { JOINTS } from './character.js';

// fighter sample: root pos 3, root quat 4, body scale 3, joints 4 each, smear L/R, flash,
// bruises, velocity 3, trail flags, visible (+2: sword out), plate / emblem glow, thrusters
export const FW = 10 + JOINTS.length * 4 + 11;
const HORIZON = 8;          // seconds of unclaimed history kept (a highlight reaches ~5.5 s back)
const MOVE_DT = 1 / 20;     // debris / cars / train sample interval (game time)
const FIGHTER_DT = 1 / 90;
const KEEP = 7;             // highlight clips held while the match runs
const MAX_CLIP = 12;        // a chain of moments longer than this starts a new clip
export const PREROLL = 2.5; // effects kept before a clip, so smoke is already hanging there
export const SLOT = 65536;  // debris slot id = shape * SLOT + instance

// What each kind of moment is worth and how much of it to show (game seconds before / after).
export const MOMENTS = {
  launch: { pre: 1.3, post: 2.0, score: 2 },
  throw: { pre: 2.0, post: 2.0, score: 3 },
  smash: { pre: 1.5, post: 1.6, score: 3 },
  slam: { pre: 1.5, post: 1.5, score: 2 },
  skydive: { pre: 3.0, post: 2.2, score: 7 },
  super: { pre: 2.6, post: 2.4, score: 7 },
  clash: { pre: 3.4, post: 2.4, score: 9 },
  collapse: { pre: 1.0, post: 4.6, score: 12 },
  train: { pre: 1.4, post: 2.6, score: 6 },
  ko: { pre: 2.0, post: 3.2, score: 10 },
};

// world log entry codes
export const W = { ATTR: 0, BODY: 1, FREEZE: 2, KILL: 3, CAR_WAKE: 4, CAR_SETTLE: 5, CAR_WRECK: 6 };

const CAM = { camera: true }; // stands in for the live camera in recorded calls
const AFFINE = [0, 1, 2, 4, 5, 6, 8, 9, 10, 12, 13, 14];

function cloneArg(a) {
  if (a === null || typeof a !== 'object') return a;
  if (a.isVector3 || a.isColor) return a.clone();
  if (a.isCamera) return CAM;
  return Array.isArray(a) ? a.slice() : { ...a };
}

// Time-ordered items in one-second blocks, so old ones can be dropped wholesale.
class Stream {
  constructor() { this.blocks = []; }
  push(item) {
    let b = this.blocks[this.blocks.length - 1];
    if (!b || item.t - b.t0 >= 1) { b = { t0: item.t, t1: item.t, items: [] }; this.blocks.push(b); }
    b.items.push(item);
    b.t1 = item.t;
    return b.items.length === 1; // a fresh block
  }
  range(ta, tb) {
    const out = [];
    for (const b of this.blocks) {
      if (b.t1 < ta || b.t0 > tb) continue;
      for (const it of b.items) if (it.t >= ta && it.t <= tb) out.push(it);
    }
    return out;
  }
  prune(keep) { this.blocks = this.blocks.filter(keep); }
}

// Upload the whole of each attribute at the next render. Live code uploads only the instances it
// touched (update ranges); a range still pending would cut a full rewrite like this one short.
export function uploadAll(...attrs) {
  for (const a of attrs) {
    if (!a) continue;
    a.clearUpdateRanges();
    a.needsUpdate = true;
  }
}

// Copy of a debris shape's instances (matrices, colours, chunk-material attributes).
export function snapShape(sh, scale, states) {
  const n = sh.mesh.count, a = sh.attrs;
  return {
    n,
    m: sh.mesh.instanceMatrix.array.slice(0, n * 16),
    c: sh.mesh.instanceColor ? sh.mesh.instanceColor.array.slice(0, n * 3) : null,
    style: a.style.array.slice(0, n * 4), parent: a.parent.array.slice(0, n * 4),
    offset: a.offset.array.slice(0, n * 3), cell: a.cell.array.slice(0, n * 3), hit: a.hit.array.slice(0, n * 4),
    scale: scale ? scale.slice(0, n * 3) : null,
    state: states || null,
  };
}

export function restoreShape(sh, s) {
  const a = sh.attrs, M = sh.mesh.instanceMatrix.array;
  M.set(s.m);
  // instances that didn't exist at snapshot time are empty
  for (let i = s.n; i < sh.mesh.count; i++) { M.fill(0, i * 16, i * 16 + 15); M[i * 16 + 15] = 1; }
  if (s.c) sh.mesh.instanceColor.array.set(s.c);
  a.style.array.set(s.style); a.parent.array.set(s.parent); a.offset.array.set(s.offset); a.cell.array.set(s.cell);
  a.hit.array.fill(0); a.hit.array.set(s.hit);
  uploadAll(sh.mesh.instanceMatrix, sh.mesh.instanceColor, a.style, a.parent, a.offset, a.cell, a.hit);
}

export class Recorder {
  constructor() {
    this.samples = new Stream();
    this.events = new Stream();
    this.world = [];     // discrete world changes since the match began (never pruned mid-match)
    this.clips = [];
    this.fns = [];       // recorded call targets: { kind, play(args) }
    this.depth = 0;
    this.paused = false; // the recap is playing: nothing it does gets recorded
    this.matchOn = false;
    this.lastF = -1;
    this.lastM = -1;
    this.base = null;
    this.matchT0 = 0;
    this.roundT0 = 0;
  }

  get now() { return G.time.gameTime; }
  get live() { return !this.paused; }

  // ------------------------------------------------------------------ hooks
  install() {
    const D = G.debris, S = G.destruction, P = G.props;
    const self = this;
    this.debScale = D.shapes.map((sh) => new Float32Array(sh.capacity * 3));
    const slot = (rec) => rec.shape * SLOT + rec.idx;

    const writeAttrs = D._writeAttrs;
    D._writeAttrs = function (rec, o) {
      writeAttrs.call(this, rec, o);
      const sh = this.shapes[rec.shape], i = rec.idx, a = sh.attrs;
      self.debScale[rec.shape].set([rec.scale.x, rec.scale.y, rec.scale.z], i * 3);
      if (!self.live) return;
      const c = sh.mesh.instanceColor.array;
      self.world.push([self.now, W.ATTR, slot(rec), rec.scale.x, rec.scale.y, rec.scale.z,
        ...a.style.array.subarray(i * 4, i * 4 + 4), ...a.parent.array.subarray(i * 4, i * 4 + 4),
        ...a.offset.array.subarray(i * 3, i * 3 + 3), ...a.cell.array.subarray(i * 3, i * 3 + 3), c[i * 3], c[i * 3 + 1], c[i * 3 + 2],
        ...a.hit.array.subarray(i * 4, i * 4 + 4)]);
    };
    const makeBody = D._makeBody;
    D._makeBody = function (rec, pos, quat, vel, angvel) {
      makeBody.call(this, rec, pos, quat, vel, angvel);
      if (self.live) self.world.push([self.now, W.BODY, slot(rec), pos.x, pos.y, pos.z, quat.x, quat.y, quat.z, quat.w]);
    };
    const freeze = D._freeze;
    D._freeze = function (rec) {
      const had = !!rec.body;
      freeze.call(this, rec);
      if (had && self.live) {
        const p = rec.fpos, q = rec.fquat;
        self.world.push([self.now, W.FREEZE, slot(rec), p.x, p.y, p.z, q.x, q.y, q.z, q.w]);
      }
    };
    const kill = D._kill;
    D._kill = function (rec) {
      const was = rec.dead;
      kill.call(this, rec);
      if (!was && self.live) self.world.push([self.now, W.KILL, slot(rec)]);
    };

    // city chunks: when each one broke, and when it first took damage (cracks / soot)
    this.deathT = new Float32Array(S.defs.length).fill(Infinity);
    this.dmgT = new Float32Array(S.defs.length).fill(Infinity);
    const hide = S._hide;
    S._hide = function (id) {
      hide.call(this, id);
      if (self.live) self.deathT[id] = self.now;
    };
    const setDamage = S._setDamage;
    S._setDamage = function (id, v, ...hit) {
      if (self.live && v > this.defs[id].dmg && self.dmgT[id] === Infinity) self.dmgT[id] = self.now;
      setDamage.call(this, id, v, ...hit);
    };

    this.carDyn = P.cars.map((c) => c.dynamic);
    this.carWreck = P.cars.map((c) => c.wrecked);

    // effects, sounds, screen effects and camera shake: record the calls
    const fx = G.fx;
    for (const sys of ['pebbles', 'glass', 'bloodSys', 'sparks', 'smoke']) this._tap(fx[sys], 'spawn', 'part');
    for (const m of ['ring', 'flash', 'star']) this._tap(fx.shock, m, 'shock');
    this._tap(fx.comicText, 'pop', 'comic');
    // beams: re-aimed every frame, so the calls themselves are the recording
    this._tap(fx.beam, 'set', 'beam');
    this._tap(fx.beam, 'flash', 'beam');
    for (const m of ['hit', 'swing', 'whoosh', 'grab', 'crumble', 'glass', 'smashThrough', 'groundSlam', 'field', 'metal', 'skid', 'creak', 'collapse', 'voice']) {
      this._tap(G.audio, m, 'sound');
    }
    this._tap(G.audio, 'sting', 'sound', (args) => args[0] === 'ko' || args[0] === 'streak');
    for (const m of ['impactFrame', 'flashScreen', 'kickCA']) this._tap(G.post, m, 'post');
    this._tap(G.fightCam, 'addTrauma', 'shake');
    this._tap(G.fightCam, 'addTraumaAt', 'shake');
  }

  _tap(obj, name, kind, filter = null) {
    const orig = obj[name];
    const f = this.fns.length;
    this.fns.push({ kind, name, play: (args) => orig.apply(obj, args.map((a) => (a === CAM ? G.camera : a))) });
    const self = this;
    obj[name] = function (...args) {
      if (self.depth === 0 && self.live && (!filter || filter(args))) {
        const e = { t: self.now, f, a: args.map(cloneArg) };
        // flashes were sized for the live camera's distance: the recap re-sizes them for its own
        if (kind === 'shock' && args[0] && args[0].isVector3) e.d = G.camera.position.distanceTo(args[0]);
        self.events.push(e);
      }
      self.depth++;
      try { return orig.apply(this, args); } finally { self.depth--; }
    };
  }

  // ------------------------------------------------------------------ match / round boundaries
  beginMatch() {
    this.clips = [];
    this.world = [];
    this.matchT0 = this.roundT0 = this.now;
    this.matchOn = true;
    const D = G.debris, P = G.props;
    const active = new Set(D.active.map((r) => r.shape * SLOT + r.idx));
    this.base = {
      t: this.now,
      deb: D.shapes.map((sh, k) => {
        const st = new Uint8Array(sh.mesh.count);
        for (let i = 0; i < sh.mesh.count; i++) st[i] = active.has(k * SLOT + i) ? 2 : 1;
        return snapShape(sh, this.debScale[k], st);
      }),
      cars: { m: P.mesh.instanceMatrix.array.slice(), c: P.mesh.instanceColor.array.slice(), dyn: P.cars.map((c) => c.dynamic) },
    };
  }

  // a new round resets the fighters: no clip may run across it
  cut() {
    const t = this.now;
    this.roundT0 = t;
    for (const c of this.clips) c.t1 = Math.min(c.t1, t);
    this.clips = this.clips.filter((c) => c.t1 - c.t0 > 0.6);
  }

  // ------------------------------------------------------------------ highlights
  // o: { pos, dir, by, on (fighters), name, struct, bonus, final }
  mark(kind, o = {}) {
    if (!this.matchOn || !this.live || !o.pos) return;
    const M = MOMENTS[kind], t = this.now;
    const beat = {
      kind, t, pos: o.pos.clone(), dir: o.dir ? o.dir.clone().normalize() : null,
      by: o.by ? o.by.id : -1, on: o.on ? o.on.id : -1, name: o.name || '', struct: o.struct || null,
      score: M.score + (o.bonus || 0) + (o.by && o.by.id === 0 ? 1.5 : 0), // your own work counts a bit more
      round: G.game ? G.game.round : 1, final: !!o.final,
    };
    let t0 = Math.max(this.roundT0, t - M.pre);
    const t1 = t + M.post;
    // joins the latest clip it touches...
    let c = null;
    for (let i = this.clips.length - 1; i >= 0 && !c; i--) {
      const k = this.clips[i];
      if (t0 <= k.t1 + 0.4 && t1 >= k.t0 - 0.4) c = k;
    }
    // ...unless that makes a long chain: then a new clip picks up where that one ends
    if (c && Math.max(c.t1, t1) - Math.min(c.t0, t0) > MAX_CLIP && c.t1 < t - 0.3) {
      t0 = Math.max(t0, c.t1);
      c = null;
    }
    if (c) {
      c.t0 = Math.min(c.t0, t0); c.t1 = Math.max(c.t1, t1);
      c.beats.push(beat);
    } else {
      c = { t0, t1, beats: [beat], round: beat.round };
      this.clips.push(c);
    }
    // a clip is as good as its best moment, plus a little for what comes with it
    // (a chain of small hits never outranks one huge one)
    const sc = c.beats.map((b) => b.score).sort((a, b) => b - a);
    c.score = sc.reduce((s, v, i) => s + v * (i === 0 ? 1 : i === 1 ? 0.5 : 0.2), 0);
    // hold on to the best few (a KO always stays)
    while (this.clips.length > KEEP) {
      let worst = null;
      for (const k of this.clips) {
        if (k === c || k.beats.some((b) => b.kind === 'ko')) continue;
        if (!worst || k.score < worst.score) worst = k;
      }
      if (!worst) break;
      this.clips.splice(this.clips.indexOf(worst), 1);
    }
  }

  // ------------------------------------------------------------------ sampling (after each step)
  update() {
    if (!this.live) return;
    const t = this.now;
    if (t - this.lastF < FIGHTER_DT) return;
    this.lastF = t;
    const s = { t, f: G.fighters.map((f) => this._fighter(f)) };
    if (t - this.lastM >= MOVE_DT - 1e-4) {
      this.lastM = t;
      this._moving(s, t);
    }
    if (this.samples.push(s)) this._prune(t);
  }

  _fighter(f) {
    const m = f.model, o = new Float32Array(FW);
    m.root.position.toArray(o, 0);
    m.root.quaternion.toArray(o, 3);
    m.body.scale.toArray(o, 7);
    JOINTS.forEach((j, i) => m.J[j].quaternion.toArray(o, 10 + i * 4));
    let k = 10 + JOINTS.length * 4;
    o[k++] = m.smearL; o[k++] = m.smearR; o[k++] = m.flash; o[k++] = m.damage;
    f.vel.toArray(o, k); k += 3;
    o[k++] = (f.trailL.emitting ? 1 : 0) | (f.trailR.emitting ? 2 : 0) | (f.trailBody.emitting ? 4 : 0);
    o[k++] = (m.root.visible ? 1 : 0) | (m.sword && m.sword.visible ? 2 : 0);
    o[k++] = m.glow; o[k] = m.thrust;
    return o;
  }

  _moving(s, t) {
    const D = G.debris, P = G.props;
    // live debris bodies (their latest matrix, sleeping or not)
    const deb = new Float32Array(D.active.length * 13);
    D.active.forEach((rec, n) => {
      const M = D.shapes[rec.shape].mesh.instanceMatrix.array, b = rec.idx * 16, o = n * 13;
      deb[o] = rec.shape * SLOT + rec.idx;
      for (let e = 0; e < 12; e++) deb[o + 1 + e] = M[b + AFFINE[e]];
    });
    s.deb = deb;
    // cars: tumbling ones, plus their wake / settle / wreck transitions
    const CM = P.mesh.instanceMatrix.array, CC = P.mesh.instanceColor.array;
    const cars = [];
    P.cars.forEach((car, i) => {
      if (car.dynamic !== this.carDyn[i]) {
        this.carDyn[i] = car.dynamic;
        this.world.push(car.dynamic ? [t, W.CAR_WAKE, i] : [t, W.CAR_SETTLE, i, ...CM.subarray(i * 16, i * 16 + 16)]);
      }
      if (car.wrecked && !this.carWreck[i]) {
        this.carWreck[i] = true;
        this.world.push([t, W.CAR_WRECK, i, CC[i * 3], CC[i * 3 + 1], CC[i * 3 + 2]]);
      }
      if (car.dynamic) { cars.push(i); for (let e = 0; e < 12; e++) cars.push(CM[i * 16 + AFFINE[e]]); }
    });
    s.cars = new Float32Array(cars);
    const tr = new Float32Array(G.train.cars.length * 7);
    G.train.cars.forEach((c, i) => { c.mesh.position.toArray(tr, i * 7); c.mesh.quaternion.toArray(tr, i * 7 + 3); });
    s.train = tr;
    if (G.military) s.mil = G.military.snapshot();
  }

  _prune(t) {
    const keep = (b) => b.t1 >= t - HORIZON || this.clips.some((c) => b.t1 >= c.t0 - PREROLL && b.t0 <= c.t1);
    this.samples.prune(keep);
    this.events.prune(keep);
  }

  // rough size of what's held, for the test hooks
  stats() {
    let floats = 0, samples = 0, events = 0;
    for (const b of this.samples.blocks) for (const s of b.items) {
      samples++;
      floats += FW * 2 + (s.deb ? s.deb.length : 0) + (s.cars ? s.cars.length : 0) + (s.train ? s.train.length : 0) + (s.mil ? s.mil.length : 0);
    }
    for (const b of this.events.blocks) events += b.items.length;
    for (const w of this.world) floats += w.length;
    return { samples, events, world: this.world.length, mb: +((floats * 4 + events * 120) / 1048576).toFixed(1), clips: this.clips.length };
  }
}
