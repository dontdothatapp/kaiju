// Match recap: after the final KO, the best moments of the match come back as a short film,
// letterboxed and shot from new angles (game/recorder.js holds the footage). Playback is
// visual only: the simulation stands still while the city, the debris, the fighters, the
// effects and the sounds of each moment are restored and replayed for a cinematic camera, then
// everything is put back exactly as it was.
//
// Each highlight clip is cut into shots: a wide orbit or a low angle on the way in, a side-on
// close-up of every big hit (slowed right down), a tracking shot on whoever's flying, a tower
// coming down seen from a helicopter, the sky diver from above. The best hit of the match gets
// a second look from the reverse angle.
import * as THREE from 'three';
import { G } from '../core/context.js';
import { clamp, lerp, noise1, UP } from '../core/math.js';
import { JOINTS } from './character.js';
import { W, SLOT, PREROLL, MOMENTS, snapShape, restoreShape, uploadAll } from './recorder.js';
import { chunkUniforms, updateCutaway } from '../world/chunkMaterial.js';
import { followShadow } from '../render/renderer.js';

const BUDGET = 26;    // seconds of film, give or take (a KO or a collapse may stretch it)
const MAX_CLIPS = 6;
// slow motion at each kind of moment (playback speed at the peak)
const SLOW = { ko: 0.16, super: 0.2, skydive: 0.22, throw: 0.3, launch: 0.32, smash: 0.42, slam: 0.36, collapse: 0.62, train: 0.36 };
const AFFINE = [0, 1, 2, 4, 5, 6, 8, 9, 10, 12, 13, 14];

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _q0 = new THREE.Quaternion();
const smooth = (x) => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };
// an instance scaled to nothing, written exactly as makeScale(0, 0, 0) is
const hide = (M, i) => { M.fill(0, i * 16, i * 16 + 15); M[i * 16 + 15] = 1; };

// ------------------------------------------------------------------ editing
function slowAt(clip, T) {
  let s = 1;
  for (const b of clip.feat) {
    const x = T - b.t;
    if (x < -0.45 || x > 1.15) continue;
    const w = x < -0.15 ? smooth((x + 0.45) / 0.3) : x < 0.5 ? 1 : 1 - smooth((x - 0.5) / 0.65);
    const lo = b.kind === 'launch' && b.score < 4 ? 0.55 : SLOW[b.kind]; // small launches: a touch
    s = Math.min(s, 1 - (1 - lo) * w);
  }
  return s;
}

function segDur(g) {
  if (g.speed) return (g.tb - g.ta) / g.speed;
  let d = 0;
  for (let t = g.ta; t < g.tb; t += 0.02) d += Math.min(0.02, g.tb - t) / slowAt(g.clip, t);
  return d;
}

// The moments a clip is built around: its best two, plus any KO or collapse (three at most).
// The rest still happen on screen, just without a shot of their own.
function feature(clip) {
  const byScore = clip.beats.slice().sort((a, b) => b.score - a.score);
  const feat = byScore.filter((b) => b.kind === 'ko' || b.kind === 'collapse').slice(0, 2);
  for (const b of byScore) if (feat.length < 2 || (feat.length < 3 && b.score >= 9)) { if (!feat.includes(b)) feat.push(b); }
  clip.feat = feat.sort((a, b) => a.t - b.t);
  // trimmed to them
  clip.t0 = Math.max(clip.t0, Math.min(...feat.map((b) => b.t - MOMENTS[b.kind].pre)));
  clip.t1 = Math.min(clip.t1, Math.max(...feat.map((b) => b.t + MOMENTS[b.kind].post)));
}

// Cut a clip into shots (game-time ranges). `top`: the best clip of the match, whose biggest
// hit is shown twice.
function plan(clip, top) {
  const beats = clip.feat;
  const main = beats.reduce((a, b) => (b.score > a.score ? b : a));
  const segs = [];
  let cur = clip.t0, prev = null;
  const push = (ta, tb, type, beat, extra = {}) => {
    ta = Math.max(ta, cur);
    tb = Math.min(tb, clip.t1);
    if (tb - ta < 0.3) return;
    segs.push({ clip, ta, tb, type, beat, ...extra });
    cur = tb;
  };
  const lead = (tb, b) => { if (tb - cur > 0.6) push(cur, tb, prev ? 'track' : clip.index % 2 ? 'hero' : 'orbit', prev || b); };
  for (let i = 0; i < beats.length; i++) {
    const b = beats[i], next = beats[i + 1];
    if (b.kind === 'collapse') {
      lead(b.t, b);
      push(b.t, next ? Math.max(b.t + 2.5, next.t - 0.4) : clip.t1, 'tower', b);
    } else if (b.kind === 'skydive') {
      if (b.t - 0.3 - cur > 0.5) push(cur, b.t - 0.3, 'sky', b);
      push(b.t - 0.3, b.t + 0.8, 'impact', b);
    } else {
      if (b.t + 0.5 < cur) { prev = b; continue; } // already in a shot
      const pre = b.kind === 'smash' ? 0.45 : 0.35;
      lead(b.t - pre, b);
      push(b.t - pre, b.t + (b.kind === 'smash' ? 1.1 : 0.75), b.kind === 'smash' ? 'smash' : b.kind === 'slam' ? 'slam' : 'impact', b);
    }
    if (top && b === main && ['launch', 'throw', 'super', 'ko', 'skydive'].includes(b.kind) && b.t - 0.6 >= clip.t0) {
      segs.push({ clip, ta: b.t - 0.6, tb: Math.min(clip.t1, b.t + 0.7), type: 'impact', beat: b, reverse: true, speed: 0.32, again: true });
      cur = Math.max(cur, Math.min(clip.t1, b.t + 0.7));
    }
    prev = b;
  }
  if (prev && clip.t1 - cur > 0.4) push(cur, clip.t1, prev.kind === 'ko' && prev.final ? 'finale' : prev.kind === 'collapse' ? 'tower' : 'track', prev);
  return segs;
}

// The clips worth showing, in match order: the final KO, then the best of the rest that fit.
function pick(src) {
  const clips = src.map((c, i) => ({ ...c, beats: c.beats.slice(), index: i })).filter((c) => c.t1 - c.t0 > 0.8);
  if (!clips.length) return [];
  clips.forEach(feature);
  const top = clips.reduce((a, b) => (b.score > a.score ? b : a));
  for (const c of clips) {
    c.segs = plan(c, c === top);
    c.dur = c.segs.reduce((s, g) => s + segDur(g), 0);
  }
  const ok = clips.filter((c) => c.segs.length);
  const fin = ok.find((c) => c.beats.some((b) => b.final));
  const chosen = fin ? [fin] : [];
  let total = fin ? fin.dur : 0;
  for (const c of ok.slice().sort((a, b) => b.score - a.score)) {
    if (chosen.includes(c) || chosen.length >= MAX_CLIPS) continue;
    if (chosen.length >= 2 && (c.score < 5 || total + c.dur > BUDGET + (c.score >= 14 ? 8 : c.score >= 10 ? 4 : 0))) continue; // a collapse or a KO earns a longer film; filler doesn't
    chosen.push(c);
    total += c.dur;
  }
  return chosen.sort((a, b) => a.t0 - b.t0);
}

function caption(clip) {
  const b = clip.feat.reduce((a, x) => (x.score > a.score ? x : a));
  const name = b.name ? b.name.toUpperCase() : '';
  const title = {
    collapse: name ? `${name} COMES DOWN` : 'BUILDING DOWN',
    smash: name ? `THROUGH ${name}` : 'THROUGH A BUILDING',
    ko: b.final ? 'THE FINAL BLOW' : 'K.O.',
    skydive: 'FROM ABOVE',
    super: 'SUPER',
    train: 'THE TRAIN!',
    throw: 'HURLED ACROSS TOWN',
    slam: 'INTO THE STREET',
    launch: 'KNOCKED FLAT',
  }[b.kind];
  const by = b.by >= 0 && G.fighters[b.by] ? G.fighters[b.by].name : '';
  return [title, `ROUND ${clip.round}${by ? ' · ' + by : ''}`];
}

// last sample at or before T, the next one, and the blend between them
function bracket(arr, T) {
  if (!arr.length) return [null, null, 0];
  let lo = 0, hi = arr.length - 1;
  if (T <= arr[0].t) return [arr[0], arr[0], 0];
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (arr[mid].t <= T) lo = mid; else hi = mid - 1;
  }
  const a = arr[lo], b = arr[lo + 1] || a;
  return [a, b, b === a ? 0 : clamp((T - a.t) / (b.t - a.t), 0, 1)];
}

function offsets(s, key) {
  const k = '_' + key;
  if (!s[k]) {
    const m = new Map(), a = s[key];
    for (let o = 0; o < a.length; o += 13) m.set(a[o], o);
    s[k] = m;
  }
  return s[k];
}

// ------------------------------------------------------------------ the city as it was
class ReplayWorld {
  begin() {
    const R = this.R = G.recorder, D = G.debris, P = G.props;
    this.live = {
      deb: D.shapes.map((sh) => snapShape(sh)),
      cars: { m: P.mesh.instanceMatrix.array.slice(), c: P.mesh.instanceColor.array.slice() },
      train: G.train.cars.map((c) => ({ p: c.mesh.position.clone(), q: c.mesh.quaternion.clone() })),
    };
    // only chunks that broke (or cracked) during this match look any different in the past
    const t0 = R.base.t;
    this.dead = []; this.cracked = [];
    for (let id = 0; id < R.deathT.length; id++) {
      if (R.deathT[id] >= t0 && R.deathT[id] < Infinity) this.dead.push(id);
      if (R.dmgT[id] >= t0 && R.dmgT[id] < Infinity) this.cracked.push(id);
    }
    this.dead.sort((a, b) => R.deathT[a] - R.deathT[b]);
    this.cracked.sort((a, b) => R.dmgT[a] - R.dmgT[b]);
    // rubble mounds raised this match get rewound too (craters and street paint stay as they are)
    this.live.ground = G.ground.heights.slice();
    this.mounds = G.ground.patches.filter((p) => p.t >= t0);
    this.dState = D.shapes.map((sh) => new Uint8Array(sh.capacity)); // 0 gone, 1 resting, 2 moving
    this.dScale = D.shapes.map((sh) => new Float32Array(sh.capacity * 3));
    this.dirtyM = new Uint8Array(D.shapes.length);
    this.dirtyA = new Uint8Array(D.shapes.length);
    this.carState = new Uint8Array(P.cars.length);
  }

  standing(id, T) { return this.R.deathT[id] > T; }

  seek(T) {
    const R = this.R, D = G.debris, S = G.destruction, P = G.props;
    for (const id of this.dead) S.showChunk(id, R.deathT[id] > T, false);
    for (const id of this.cracked) S.setStyleW(id, R.dmgT[id] <= T ? S.defs[id].dmg : 0, false);
    S.uploadAll();
    this.di = 0; while (this.di < this.dead.length && R.deathT[this.dead[this.di]] <= T) this.di++;
    this.ci = 0; while (this.ci < this.cracked.length && R.dmgT[this.cracked[this.ci]] <= T) this.ci++;
    // the ground before this match's first mound, then each mound raised by T
    const gr = G.ground;
    for (let k = this.mounds.length - 1; k >= 0; k--) gr.applyPatch(this.mounds[k], this.mounds[k].before);
    this.mi = 0;
    while (this.mi < this.mounds.length && this.mounds[this.mi].t <= T) { gr.applyPatch(this.mounds[this.mi], this.mounds[this.mi].after); this.mi++; }
    // debris and cars as they were when the match began, then every change up to T
    const B = R.base;
    D.shapes.forEach((sh, k) => {
      const b = B.deb[k];
      restoreShape(sh, b);
      this.dState[k].fill(0); this.dState[k].set(b.state);
      this.dScale[k].fill(0); this.dScale[k].set(b.scale);
    });
    P.mesh.instanceMatrix.array.set(B.cars.m); P.mesh.instanceColor.array.set(B.cars.c);
    B.cars.dyn.forEach((d, i) => { this.carState[i] = d ? 2 : 1; });
    uploadAll(P.mesh.instanceMatrix, P.mesh.instanceColor);
    this.wi = 0;
    this._log(T);
    this._flush();
  }

  // everything that changed in (previous T, T]
  step(T) {
    const R = this.R, S = G.destruction;
    while (this.di < this.dead.length && R.deathT[this.dead[this.di]] <= T) S.showChunk(this.dead[this.di++], false);
    while (this.ci < this.cracked.length && R.dmgT[this.cracked[this.ci]] <= T) {
      const id = this.cracked[this.ci++];
      S.setStyleW(id, S.defs[id].dmg);
    }
    while (this.mi < this.mounds.length && this.mounds[this.mi].t <= T) {
      const p = this.mounds[this.mi++];
      G.ground.applyPatch(p, p.after);
    }
    this._log(T);
  }

  _log(T) {
    const L = this.R.world;
    while (this.wi < L.length && L[this.wi][0] <= T) this._apply(L[this.wi++]);
  }

  _apply(e) {
    const D = G.debris, P = G.props;
    const code = e[1];
    if (code <= W.KILL) {
      const k = Math.floor(e[2] / SLOT), i = e[2] - k * SLOT, sh = D.shapes[k];
      if (!sh || i >= sh.capacity) return;
      const M = sh.mesh.instanceMatrix.array;
      if (code === W.ATTR) {
        const a = sh.attrs;
        this.dScale[k].set(e.slice(3, 6), i * 3);
        a.style.array.set(e.slice(6, 10), i * 4); a.parent.array.set(e.slice(10, 14), i * 4);
        a.offset.array.set(e.slice(14, 17), i * 3); a.cell.array.set(e.slice(17, 20), i * 3);
        sh.mesh.instanceColor.array.set(e.slice(20, 23), i * 3);
        a.hit.array.set(e.slice(23, 27), i * 4);
        this.dirtyA[k] = 1;
      } else if (code === W.KILL) {
        this.dState[k][i] = 0;
        hide(M, i);
        this.dirtyM[k] = 1;
      } else {
        this.dState[k][i] = code === W.BODY ? 2 : 1;
        _p.set(e[3], e[4], e[5]); _q.set(e[6], e[7], e[8], e[9]); _s.fromArray(this.dScale[k], i * 3);
        _m.compose(_p, _q, _s).toArray(M, i * 16);
        this.dirtyM[k] = 1;
      }
    } else if (code === W.CAR_WAKE) this.carState[e[2]] = 2;
    else if (code === W.CAR_SETTLE) {
      this.carState[e[2]] = 1;
      P.mesh.instanceMatrix.array.set(e.slice(3, 19), e[2] * 16);
      uploadAll(P.mesh.instanceMatrix);
    } else if (code === W.CAR_WRECK) {
      P.mesh.instanceColor.array.set(e.slice(3, 6), e[2] * 3);
      uploadAll(P.mesh.instanceColor);
    }
  }

  // moving debris, tumbling cars and the train at T, between two samples
  pose(T, MS) {
    const [a, b, k] = bracket(MS, T);
    if (!a) return;
    const D = G.debris, P = G.props;
    const bo = offsets(b, 'deb');
    for (let o = 0; o < a.deb.length; o += 13) {
      const slot = a.deb[o], sk = Math.floor(slot / SLOT), i = slot - sk * SLOT;
      if (!this.dState[sk] || this.dState[sk][i] !== 2) continue;
      const ob = bo.get(slot), M = D.shapes[sk].mesh.instanceMatrix.array;
      for (let e = 0; e < 12; e++) M[i * 16 + AFFINE[e]] = ob === undefined ? a.deb[o + 1 + e] : lerp(a.deb[o + 1 + e], b.deb[ob + 1 + e], k);
      M[i * 16 + 3] = 0; M[i * 16 + 7] = 0; M[i * 16 + 11] = 0; M[i * 16 + 15] = 1;
      this.dirtyM[sk] = 1;
    }
    const co = offsets(b, 'cars'), CM = P.mesh.instanceMatrix.array;
    for (let o = 0; o < a.cars.length; o += 13) {
      const i = a.cars[o];
      if (this.carState[i] !== 2) continue;
      const ob = co.get(i);
      for (let e = 0; e < 12; e++) CM[i * 16 + AFFINE[e]] = ob === undefined ? a.cars[o + 1 + e] : lerp(a.cars[o + 1 + e], b.cars[ob + 1 + e], k);
      uploadAll(P.mesh.instanceMatrix);
    }
    G.train.cars.forEach((c, i) => {
      c.mesh.position.fromArray(a.train, i * 7).lerp(_v.fromArray(b.train, i * 7), k);
      c.mesh.quaternion.slerpQuaternions(_q1.fromArray(a.train, i * 7 + 3), _q2.fromArray(b.train, i * 7 + 3), k);
    });
    this._flush();
  }

  _flush() {
    G.debris.shapes.forEach((sh, k) => {
      if (this.dirtyM[k]) { uploadAll(sh.mesh.instanceMatrix); this.dirtyM[k] = 0; }
      if (this.dirtyA[k]) {
        const a = sh.attrs;
        uploadAll(a.style, a.parent, a.offset, a.cell, a.hit, sh.mesh.instanceColor);
        this.dirtyA[k] = 0;
      }
    });
  }

  clearFx() {
    const fx = G.fx;
    for (const s of [fx.pebbles, fx.glass, fx.bloodSys, fx.sparks]) s.n = 0;
    fx.smoke.solid.n = 0; fx.smoke.dust.n = 0; fx.smoke.cloud.n = 0;
    for (const pool of [fx.shock.rings, fx.shock.flashes, fx.shock.stars]) for (const it of pool) { it.t = it.life; it.m.visible = false; }
    for (const it of fx.comicText.items) { it.t = it.life; it.s.visible = false; }
    fx.update(0, 0, G.camera);
  }

  // back to the present
  end() {
    const D = G.debris, S = G.destruction, P = G.props, L = this.live;
    D.shapes.forEach((sh, k) => restoreShape(sh, L.deb[k]));
    P.mesh.instanceMatrix.array.set(L.cars.m); P.mesh.instanceColor.array.set(L.cars.c);
    uploadAll(P.mesh.instanceMatrix, P.mesh.instanceColor);
    G.train.cars.forEach((c, i) => { c.mesh.position.copy(L.train[i].p); c.mesh.quaternion.copy(L.train[i].q); });
    if (this.mounds.length) G.ground.restoreHeights(L.ground);
    for (const id of this.dead) S.showChunk(id, S.defs[id].alive, false);
    for (const id of this.cracked) S.setStyleW(id, S.defs[id].dmg, false);
    S.uploadAll();
    this.clearFx();
  }
}

// ------------------------------------------------------------------ the player
export class Recap {
  constructor() {
    this.active = false;
    this.world = new ReplayWorld();
    this.cam = { pos: new THREE.Vector3(), look: new THREE.Vector3(), fov: 50 };
    this.speed = 1;
    this._skip = () => this.skip();
  }

  // something worth showing was recorded this match
  available() { return pick(G.recorder.clips).length > 0; }

  play(onDone) {
    const R = G.recorder;
    const clips = pick(R.clips);
    if (!clips.length) { if (onDone) onDone(); return false; }
    this.clips = clips;
    this.segs = clips.flatMap((c) => c.segs);
    this.onDone = onDone;
    this.i = -1;
    this.T = 0;
    this.realT = 0;
    this.trauma = 0;
    this.active = true;
    R.paused = true;
    this.world.begin();
    this.hudShown = !G.hud.el.hud.classList.contains('hidden');
    G.hud.showHUD(false);
    G.hud.el.banner.className = ''; G.hud.bannerT = 0; // the winner's banner makes way
    G.hud.recap(true);
    G.hud.skipHint(true);
    G.post.letterboxTarget = 1; G.post.speedTarget = 0; G.post.desatTarget = 0;
    const cam = G.camera;
    if (cam.view) cam.clearViewOffset();
    cam.aspect = window.innerWidth / window.innerHeight;
    for (const f of G.fighters) { f.trailL.clear(); f.trailR.clear(); f.trailBody.clear(); }
    setTimeout(() => this.active && window.addEventListener('pointerdown', this._skip), 400);
    this.total = clips.reduce((s, c) => s + c.dur, 0);
    this._next();
    return true;
  }

  skip() { if (this.active && this.realT > 0.4) this.finish(); }

  finish() {
    if (!this.active) return;
    this.active = false;
    window.removeEventListener('pointerdown', this._skip);
    this.world.end();
    for (const f of G.fighters) {
      const m = f.model;
      m.looks(m.smearL, m.smearR, m.flash, m.damage);
      m.setVisible(true);
      m.showSword(!!(f.grab && f.grab.sword));
      f.trailL.clear(); f.trailR.clear(); f.trailBody.clear();
      f.trailL.emitting = f.trailR.emitting = false;
    }
    G.recorder.paused = false;
    G.hud.recap(false);
    G.hud.skipHint(false);
    G.hud.showHUD(this.hudShown);
    G.post.letterboxTarget = 0;
    const done = this.onDone;
    this.onDone = null;
    if (done) done();
  }

  // ---------------------------------------------------------------- segments
  _next() {
    this.i++;
    const g = this.segs[this.i];
    if (!g) { this.finish(); return; }
    const prev = this.segs[this.i - 1];
    const newClip = !prev || prev.clip !== g.clip;
    if (newClip) this._load(g.clip);
    if (newClip || Math.abs(g.ta - this.T) > 1e-4) this._seek(g.ta);
    this.seg = g;
    this.shot = this._shot(g, prev);
    if (newClip) {
      const [title, sub] = caption(g.clip);
      if (this.i === 0) { G.hud.recapCard('MATCH RECAP', `${G.fighters[0].name} VS ${G.fighters[1].name}`, true); this.cardAt = this.realT + 1.7; this.card = [title, sub]; }
      else { G.hud.recapCard(title, sub); this.card = null; G.post.flashScreen(0.35); }
    }
    G.hud.recapTag(g.again ? 'ANOTHER ANGLE' : 'REPLAY');
  }

  _load(c) {
    const R = G.recorder;
    this.S = R.samples.range(c.t0 - 0.5, c.t1 + 0.3);
    this.MS = this.S.filter((s) => s.deb);
    this.E = R.events.range(c.t0 - PREROLL, c.t1 + 0.3);
  }

  _seek(T) {
    this.world.seek(T);
    this.world.clearFx();
    // particles from the last few seconds, run forward, so the dust is already hanging there
    const E = this.E, fns = G.recorder.fns, fx = G.fx, h = 1 / 30;
    let k = 0;
    while (k < E.length && E[k].t < T - PREROLL) k++;
    for (let t = T - PREROLL; t < T; t += h) {
      while (k < E.length && E[k].t <= t) { const e = E[k++]; if (fns[e.f].kind === 'part') fns[e.f].play(e.a); }
      for (const s of [fx.pebbles, fx.glass, fx.bloodSys, fx.sparks, fx.smoke]) s.update(h);
    }
    while (k < E.length && E[k].t <= T) { const e = E[k++]; if (fns[e.f].kind === 'part') fns[e.f].play(e.a); }
    this.ek = k;
    this.T = T;
    this._pose(T, 0);
  }

  // ---------------------------------------------------------------- per frame
  update(realDt) {
    if (!this.active) return;
    this.realT += realDt;
    if (this.card && this.realT >= this.cardAt) { G.hud.recapCard(...this.card); this.card = null; }
    const g = this.seg;
    this.speed = g.speed || slowAt(g.clip, this.T);
    const T0 = this.T, T1 = Math.min(g.tb, T0 + realDt * this.speed);
    this.world.step(T1);
    const E = this.E, fns = G.recorder.fns;
    while (this.ek < E.length && E[this.ek].t <= T1) {
      const e = E[this.ek++], fn = fns[e.f];
      if (fn.kind === 'shake') this._shake(fn.name, e.a);
      else if (fn.kind === 'shock' && fn.name !== 'ring' && e.d !== undefined) {
        // a hit flash a few metres from this lens would white out the frame, and slow motion
        // would hold it there: size it for this camera, keep it as brief as it was live
        const a = e.a.slice(), near = (d) => clamp(d / 70, 0.35, 1);
        a[1] *= near(G.camera.position.distanceTo(a[0])) / near(e.d);
        if (a[3] !== undefined) a[3] *= Math.max(0.3, this.speed);
        fn.play(a);
      } else fn.play(e.a);
    }
    this.T = T1;
    this._pose(T1, T1 - T0);
    G.fx.update(T1 - T0, realDt, G.camera);
    this.shot.update(T1, T1 - T0);
    this._camera(realDt);
    const p = G.player.model.root.position, b = G.bot.model.root.position;
    chunkUniforms.uFocus.value.copy(p).setY(p.y + G.player.H * 0.2);
    chunkUniforms.uFocus2.value.copy(b).setY(b.y + G.bot.H * 0.2);
    G.fx.smoke.setFocus(chunkUniforms.uFocus.value, chunkUniforms.uFocus2.value);
    updateCutaway(G.camera, G.fighters, realDt); // cut through the city for this lens, as live
    followShadow(G.sun, this.cam.look);
    if (T1 >= g.tb - 1e-6) this._next();
  }

  _shake(name, a) {
    const amt = name === 'addTrauma' ? a[0] : a[1] * clamp(1 - G.camera.position.distanceTo(a[0]) / (a[2] || 200), 0, 1);
    this.trauma = clamp(this.trauma + amt * 0.6 * G.settings.shake, 0, 1);
  }

  _camera(realDt) {
    const c = G.camera, k = this.cam;
    this.trauma = Math.max(0, this.trauma - realDt * 1.5);
    const sh = this.trauma * this.trauma, t = this.realT * 22;
    c.position.copy(k.pos).add(_v.set(noise1(t), noise1(t + 37), noise1(t + 71)).multiplyScalar(sh * 3));
    c.lookAt(k.look);
    if (c.fov !== k.fov) { c.fov = k.fov; c.updateProjectionMatrix(); }
  }

  _pose(T, dt) {
    const [a, b, k] = bracket(this.S, T);
    if (a) G.fighters.forEach((f, i) => this._fighter(f, a.f[i], b.f[i], k, dt, T));
    this.world.pose(T, this.MS);
  }

  _fighter(f, A, B, k, dt, T) {
    const m = f.model, L = (x) => lerp(A[x], B[x], k);
    m.root.position.set(L(0), L(1), L(2));
    m.root.quaternion.slerpQuaternions(_q1.fromArray(A, 3), _q2.fromArray(B, 3), k);
    m.body.scale.set(L(7), L(8), L(9));
    JOINTS.forEach((j, n) => m.J[j].quaternion.slerpQuaternions(_q1.fromArray(A, 10 + n * 4), _q2.fromArray(B, 10 + n * 4), k));
    const o = 10 + JOINTS.length * 4;
    m.looks(L(o), L(o + 1), L(o + 2), L(o + 3), L(o + 9), L(o + 10));
    m.setVisible((A[o + 8] & 1) === 1);
    m.showSword((A[o + 8] & 2) === 2);
    m.root.updateMatrixWorld(true);
    if (m.cape) m.cape.update(dt, _w.set(L(o + 4), L(o + 5), L(o + 6)));
    const flags = A[o + 7];
    f.trailL.emitting = !!(flags & 1); f.trailR.emitting = !!(flags & 2); f.trailBody.emitting = !!(flags & 4);
    if (dt > 0) {
      if (f.trailL.emitting) f.trailL.push(m.handWorld('L', _v), T);
      if (f.trailR.emitting) f.trailR.push(m.handWorld('R', _v), T);
      if (f.trailBody.emitting) f.trailBody.push(m.chestWorld(_v), T);
    }
    f.trailL.update(T, G.camera); f.trailR.update(T, G.camera); f.trailBody.update(T, G.camera);
  }

  // ---------------------------------------------------------------- what the camera knows
  // fighter i's position (or velocity) at T, from the samples
  at(i, T, out, vel = false) {
    const [a, b, k] = bracket(this.S, T);
    if (!a) return out.set(0, 0, 0);
    const o = vel ? 10 + JOINTS.length * 4 + 4 : 0;
    return out.set(lerp(a.f[i][o], b.f[i][o], k), lerp(a.f[i][o + 1], b.f[i][o + 1], k), lerp(a.f[i][o + 2], b.f[i][o + 2], k));
  }

  solid(pos, r, T) {
    const gh = G.ground.heightAt(pos.x, pos.z);
    if (pos.y < gh + 2) return true;
    if (G.trees && pos.y < gh + 11) {
      for (const t of G.trees.spots) if (t.alive && Math.hypot(t.x - pos.x, t.z - pos.z) < 3.9 * t.s + r) return true;
    }
    let hit = false;
    G.destruction.forChunksInSphere(pos, r, () => { hit = true; }, (d) => this.world.standing(d.id, T));
    return hit;
  }

  // under a roof (inside a building): a dark, confusing place for a camera
  covered(pos, T) {
    const p = pos.clone();
    for (let h = 8; h <= 80; h += 10) if (this.solid(p.set(pos.x, pos.y + h, pos.z), 2.5, T)) return true;
    return false;
  }

  // nothing standing between a and b (stops `short` metres before b); `r` widens the sight line
  clear(a, b, T, short = 20, r = 3) {
    const d = new THREE.Vector3().subVectors(b, a), len = d.length();
    d.divideScalar(len || 1);
    const p = new THREE.Vector3(), step = Math.max(6, r * 1.5);
    for (let s = 2; s < len - short; s += step) if (this.solid(p.copy(a).addScaledVector(d, s), r, T)) return false;
    return true;
  }

  // Best of a few camera spots around `center` (angle offsets from `base`): not inside anything,
  // a clear view of `target`. place(angle) -> position.
  choose(place, target, T, offsets) {
    let best = null, bestScore = -Infinity;
    offsets.forEach((off, n) => {
      const pos = place(off);
      let score = -n * 0.5;
      if (this.solid(pos, 4, T)) score -= 100;
      if (!this.clear(pos, target, T)) score -= 30;
      if (this.covered(pos, T)) score -= 15;
      if (score > bestScore) { bestScore = score; best = pos; }
    });
    return best;
  }

  // ---------------------------------------------------------------- shots
  _shot(g, prev) {
    const b = g.beat, T0 = g.ta, cam = this.cam;
    const pk = clamp((0.95 - window.innerWidth / window.innerHeight) / 0.45, 0, 1);
    const fov = (f) => f * (1 + 0.42 * pk); // portrait phones: a wider lens keeps the action in frame
    const vi = b.on >= 0 ? b.on : b.by >= 0 ? 1 - b.by : 1;
    const ai = b.by >= 0 ? b.by : 1 - vi;
    const V = () => new THREE.Vector3();
    const ring = (center, dist, h, base) => (a) => center.clone().add(V().set(Math.cos(base + a), 0, Math.sin(base + a)).multiplyScalar(dist)).setY(center.y + h);
    // the two of them, or (far apart) the one about to do something, with the other side in view
    const mid = (T, out) => {
      const A = this.at(ai, T, out), B = this.at(vi, T, V());
      const d = A.distanceTo(B);
      return A.lerp(B, d < 120 ? 0.5 : 60 / d);
    };
    const keepClear = (pos, T) => {
      for (let n = 0; n < 12 && this.solid(pos, 3, T); n++) pos.y += 6;
      return pos;
    };
    const AROUND = [0, -0.6, 0.6, Math.PI, Math.PI - 0.6, Math.PI + 0.6, -1.3, 1.3];

    switch (g.type) {
      // side-on close-up of the hit: from just before it, slowed right down, until he's flying
      case 'impact': {
        const p = b.pos.clone();
        const dir = b.dir ? b.dir.clone() : this.at(vi, b.t + 0.25, V()).sub(p);
        dir.y = 0;
        if (dir.lengthSq() < 1e-4) dir.set(1, 0, 0);
        dir.normalize();
        const side = V().crossVectors(dir, UP);
        const base = Math.atan2(side.z, side.x) + (g.reverse ? Math.PI : 0);
        const dist = g.reverse ? 75 : 100, h = g.reverse ? 0 : 12;
        const pos0 = this.choose(ring(p, dist, h, base), p, b.t, AROUND);
        const look = V();
        return {
          update: (T) => {
            cam.pos.copy(pos0).addScaledVector(dir, (T - T0) * 6);
            // on the two of them as they close in, then after him as he flies
            const follow = clamp((T - b.t) / 0.6, 0, 0.65), closing = clamp((b.t - T) / 0.6, 0, 1) * 0.7;
            look.copy(p).lerp(follow > 0 ? this.at(vi, T, V()) : mid(T, V()), follow || closing);
            cam.look.copy(look);
            cam.fov = fov(g.reverse ? 34 : 40);
          },
        };
      }
      // tracking alongside whoever is flying
      case 'track': {
        const dS = this.at(vi, T0, V(), true).setY(0);
        if (dS.lengthSq() < 1) dS.set(1, 0, 0);
        dS.normalize();
        let sign = 1;
        if (prev) {
          // stay on the same side of the action as the last shot (no jarring flip)
          const P0 = this.at(vi, T0, V());
          sign = V().crossVectors(dS, UP).dot(V().subVectors(cam.pos, P0)) >= 0 ? 1 : -1;
        }
        const pos = V(), desired = V();
        let first = true, opt = 0, checkT = -1;
        // alongside him; if a wall or a roof is in the way, the other side; then chasing behind
        const spot = (o, P, side, fast, out) => {
          if (o === 2) return out.copy(P).addScaledVector(dS, -95).addScaledVector(UP, 30);
          return out.copy(P).addScaledVector(side, (o ? -1 : 1) * (80 + 30 * fast)).addScaledVector(UP, 20).addScaledVector(dS, -25 * fast);
        };
        const bad = (q, P, T) => this.solid(q, 3, T) || this.covered(q, T) || !this.clear(q, P, T, 20);
        return {
          update: (T, dT) => {
            const P = this.at(vi, T, V()), vel = this.at(vi, T, V(), true);
            const flat = V().set(vel.x, 0, vel.z);
            if (flat.lengthSq() > 25) dS.lerp(flat.normalize(), 1 - Math.exp(-4 * dT)).normalize();
            const side = V().crossVectors(dS, UP).multiplyScalar(sign);
            const fast = clamp(vel.length() / 40, 0, 1);
            spot(opt, P, side, fast, desired);
            if (T - checkT > 0.1 && bad(desired, P, T)) {
              checkT = T;
              for (const o of [0, 1, 2]) if (o !== opt && !bad(spot(o, P, side, fast, V()), P, T)) { opt = o; break; }
              spot(opt, P, side, fast, desired);
            }
            keepClear(desired, T);
            if (first) { pos.copy(desired); first = false; } else pos.lerp(desired, 1 - Math.exp(-9 * dT));
            cam.pos.copy(pos);
            cam.look.copy(P).addScaledVector(vel, 0.3);
            cam.fov = fov(50);
          },
        };
      }
      // wide, slowly circling the two of them with the city around
      case 'orbit': {
        const c = mid(T0, V());
        const r = clamp(this.at(0, T0, V()).distanceTo(this.at(1, T0, V())) * 0.8 + 100, 120, 280);
        const h = 10 + r * 0.25;
        const to = V().subVectors(G.layout.vista || V(), c);
        const base = Math.atan2(-to.z, -to.x); // the skyline (the Empire State) behind them
        let a0 = 0, best = -Infinity;
        for (const a of AROUND.map((x) => x * 0.6)) {
          const p = ring(c, r, h, base)(a);
          const s = (this.solid(p, 4, T0) ? -100 : 0) + (this.clear(p, c, T0) ? 0 : -30) + (this.covered(p, T0) ? -15 : 0) - Math.abs(a);
          if (s > best) { best = s; a0 = a; }
        }
        const look = c.clone(), sign = Math.random() < 0.5 ? 1 : -1;
        return {
          update: (T, dT) => {
            look.lerp(mid(T, V()), 1 - Math.exp(-5 * dT));
            const a = base + a0 + sign * 0.16 * (T - T0);
            cam.pos.copy(look).add(V().set(Math.cos(a), 0, Math.sin(a)).multiplyScalar(r)).setY(look.y + h);
            keepClear(cam.pos, T);
            cam.look.copy(look);
            cam.fov = fov(46);
          },
        };
      }
      // low angle from the street, looking up at them against the towers
      case 'hero': {
        const c = mid(T0, V());
        const to = this.at(vi, T0, V()).sub(this.at(ai, T0, V())).setY(0);
        const base = Math.atan2(to.z, to.x) + Math.PI / 2;
        // well below them and close: they loom over the lens with the towers behind. The camera
        // keeps that offset as they move (a crane following them), never dipping into the street.
        const pos0 = this.choose((a) => { const p = ring(c, 120, 0, base)(a); p.y = Math.max(G.ground.heightAt(p.x, p.z) + 6, c.y - 18); return p; }, c, T0, AROUND);
        const off = pos0.clone().sub(c);
        const look = c.clone(), pos = pos0.clone();
        return {
          update: (T, dT) => {
            look.lerp(mid(T, V()), 1 - Math.exp(-4 * dT));
            pos.lerp(V().addVectors(look, off), 1 - Math.exp(-3 * dT));
            pos.y = Math.max(pos.y, G.ground.heightAt(pos.x, pos.z) + 6);
            keepClear(pos, T);
            cam.pos.copy(pos);
            cam.look.copy(look);
            cam.fov = fov(44);
          },
        };
      }
      // the tower coming down, like news footage: from a helicopter above the roofs around it
      // (in Midtown, anything lower stares at the building next door)
      case 'tower': {
        const s = b.struct || { x: b.pos.x, z: b.pos.z, y0: G.ground.heightAt(b.pos.x, b.pos.z), h: Math.max(60, b.pos.y * 1.5), r: 20 };
        const c = V().set(s.x, s.y0 + s.h * 0.42, s.z);
        const act = mid(T0, V());
        const base = Math.atan2(act.z - s.z, act.x - s.x);
        // the spot that sees the most of it: wide sight lines to its foot, middle (both edges)
        // and top, from 16 directions, two distances and two heights
        let a0 = 0, D0 = 0, camY = 0, best = -Infinity;
        for (const dk of [1, 1.35]) for (const hk of [0, 1]) for (let n = 0; n < 16; n++) {
          const a = (n % 2 ? 1 : -1) * Math.ceil(n / 2) * (Math.PI / 8);
          const D = clamp(s.h * 1.05 + s.r + 60, 140, 360) * dk, y = s.y0 + Math.max(s.h * 0.6, 70) + hk * 50;
          const p = V().set(s.x + Math.cos(base + a) * D, y, s.z + Math.sin(base + a) * D);
          if (this.solid(p, 4, T0)) continue;
          const across = V().set(-Math.sin(base + a), 0, Math.cos(base + a)).multiplyScalar(s.r * 0.7);
          const marks = [[0, 0.2, 6], [0, 0.5, 12], [1, 0.5, 8], [-1, 0.5, 8], [0, 0.85, 12]];
          let sc = -Math.abs(a) * 0.4 - (dk - 1) * 8 - hk * 3;
          for (const [e, f, w] of marks) {
            const m = V().set(s.x, s.y0 + s.h * f, s.z).addScaledVector(across, e);
            if (!this.clear(p, m, T0, s.r + 3, 2.2)) sc -= w;
          }
          if (sc > best) { best = sc; a0 = a; D0 = D; camY = y; }
        }
        if (best === -Infinity) { D0 = 280; camY = s.y0 + s.h + 60; }
        const vfov = clamp((2 * Math.atan((s.h * 0.8) / D0) * 180) / Math.PI, 32, 70);
        return {
          update: (T) => {
            const k = clamp((T - T0) / 5, 0, 1);
            const D = D0 * (1 - 0.1 * k), a = base + a0 + 0.03 * (T - T0);
            cam.pos.set(s.x + Math.cos(a) * D, camY - 6 * k, s.z + Math.sin(a) * D);
            keepClear(cam.pos, T);
            cam.look.copy(c);
            cam.fov = vfov;
          },
        };
      }
      // bursting through a building: from outside, on the side he came in
      case 'smash': {
        const p = b.pos.clone();
        const dir = (b.dir ? b.dir.clone() : V().set(1, 0, 0)).setY(0).normalize();
        const side = V().crossVectors(dir, UP);
        const place = (sgn, back) => p.clone().addScaledVector(dir, -back).addScaledVector(side, 80 * sgn).addScaledVector(UP, 15);
        const opts = [[1, 110], [-1, 110], [1, 60], [-1, 60], [1, 170], [-1, 170]];
        let pos0 = null, best = -Infinity;
        for (const [sgn, back] of opts) {
          const q = place(sgn, back);
          const sc = (this.solid(q, 4, b.t) ? -100 : 0) + (this.clear(q, p, b.t, 20) ? 0 : -30);
          if (sc > best) { best = sc; pos0 = q; }
        }
        // follow him in, with the facade he's about to burst through behind
        return {
          update: (T) => {
            cam.pos.copy(pos0);
            cam.look.copy(this.at(vi, T, V())).lerp(p, T < b.t ? 0.35 : 0.2);
            cam.fov = fov(46);
          },
        };
      }
      // into the street: from the curb as he hits the asphalt
      case 'slam': {
        const p = b.pos.clone();
        p.y = G.ground.heightAt(p.x, p.z);
        const base = Math.random() * Math.PI * 2;
        const pos0 = this.choose(ring(p, 115, 18, base), p.clone().setY(p.y + 10), b.t, AROUND);
        return {
          update: (T) => {
            cam.pos.copy(pos0);
            cam.look.copy(p).setY(p.y + 12).lerp(this.at(vi, T, V()), 0.35);
            cam.fov = fov(46);
          },
        };
      }
      // the sky dive: from above and behind the diver, the city spread out below
      case 'sky': {
        const pos = V();
        let first = true;
        return {
          update: (T, dT) => {
            const D = this.at(ai, T, V()), tgt = this.at(vi, T, V());
            const to = V().subVectors(tgt, D);
            const len = to.length();
            to.divideScalar(len || 1);
            const side = V().crossVectors(to, UP).normalize();
            const desired = D.clone().addScaledVector(to, -85).addScaledVector(UP, 30).addScaledVector(side, 25);
            keepClear(desired, T);
            if (first) { pos.copy(desired); first = false; } else pos.lerp(desired, 1 - Math.exp(-7 * dT));
            cam.pos.copy(pos);
            cam.look.copy(D).lerp(tgt, 0.55);
            cam.fov = fov(56);
          },
        };
      }
      // the end: a slow circle around the fallen
      case 'finale':
      default: {
        // pulled up and back: the fallen, the winner and the wreckage around them
        const c0 = this.at(vi, T0, V());
        const base = Math.random() * Math.PI * 2;
        const start = this.choose(ring(c0, 120, 45, base), c0, T0, AROUND);
        const a0 = Math.atan2(start.z - c0.z, start.x - c0.x);
        const look = c0.clone();
        return {
          update: (T, dT) => {
            look.lerp(this.at(vi, T, V()), 1 - Math.exp(-3 * dT));
            const a = a0 + 0.15 * (T - T0), r = 120 + 30 * clamp((T - T0) / 4, 0, 1);
            cam.pos.copy(look).add(V().set(Math.cos(a), 0, Math.sin(a)).multiplyScalar(r)).setY(look.y + 40 + 15 * clamp((T - T0) / 4, 0, 1));
            keepClear(cam.pos, T);
            cam.look.copy(look).addScaledVector(UP, 5);
            cam.fov = fov(44);
          },
        };
      }
    }
  }
}
