// Rigid-body debris: instanced rendering, budgeted Rapier bodies, freezing settled pieces into
// static rubble (which stays and can be re-woken by later shockwaves), and secondary breakage
// (big slabs shatter into chunks, chunks into Voronoi shards) driven by contact-force events.
import * as THREE from 'three';
import { CG } from './physics.js';
import { addChunkAttributes } from '../world/chunkMaterial.js';
import { G } from '../core/context.js';
import { rand, randomUnit } from '../core/math.js';

const BOX = 0;
const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const ZERO_M = new THREE.Matrix4().makeScale(0, 0, 0);
const HASH = 10;
const GRAVITY = 13;       // as the physics world's
const MAX_GHOSTS = 600;   // pieces falling without a body at once
const SWEEP = 24;         // parked pieces checked for support each frame

// Upload only instances lo..hi of an instanced attribute at the next render instead of the whole
// array (three.js uploads everything when needsUpdate is set without update ranges, and drops the
// ranges once it has uploaded them). A range still waiting from an update that wasn't rendered
// is folded in; a full upload someone else asked for (the recap, recorder.restoreShape) and that
// hasn't happened yet stays full.
const _staged = new WeakMap();
function uploadState(attr) {
  let s = _staged.get(attr);
  if (!s) {
    s = { ver: -1, full: false, done: -1 };
    _staged.set(attr, s);
    attr.onUpload(() => { s.done = attr.version; }); // what the GPU holds
  }
  return s;
}
// start watching before the first render, so even the first change goes up as a range
export function trackUploads(...attrs) { for (const a of attrs) if (a) uploadState(a); }
export function stageInstances(attr, lo, hi) {
  const s = uploadState(attr);
  const pending = attr.version !== s.done;
  const full = pending && (attr.version !== s.ver || s.full);
  if (full) attr.clearUpdateRanges();
  else {
    let start = lo * attr.itemSize, end = (hi + 1) * attr.itemSize;
    if (pending) for (const r of attr.updateRanges) { start = Math.min(start, r.start); end = Math.max(end, r.start + r.count); }
    attr.clearUpdateRanges();
    attr.addUpdateRange(start, end - start);
  }
  attr.needsUpdate = true;
  s.ver = attr.version;
  s.full = full;
}

export class DebrisSystem {
  constructor(scene, physics, material, fractureLib, quality) {
    this.physics = physics;
    this.R = physics.R;
    this.world = physics.world;
    this.lib = fractureLib;
    this.budget = { high: 420, medium: 300, low: 170 }[quality] || 300;
    this.active = [];          // recs with bodies
    this.colliderMap = new Map();
    this.breakQueue = [];
    this.landQueue = [];
    this.rubbleHash = new Map();
    this.hullCache = new Map();
    this.shapes = [];          // { mesh, attrs, free:[], high, frozenQ:[] }
    // making room (reserve): one pass per frame; a pass that ran out of candidates is the answer
    // for the rest of that frame
    this.frame = 0;
    this.roomFrame = -1;
    this.dryCalm = false;
    this.drySmall = false;
    this._pickR = [];
    this._pickK = [];
    // Pieces falling without a physics body ("ghosts"): free fall and a tumble, down to whatever
    // stands under them. A collapse that outruns the body budget drops its slabs this way (they
    // used to be parked where they were let go, and hung in the sky), and so does parked rubble
    // whose support has gone.
    this.ghosts = [];
    this.frozenList = [];      // every parked piece (rec.fi is its index), for the support sweep
    this.sweepI = 0;
    this.landFx = 0;           // ghost landings that still get dust and a thud this frame

    const boxGeo = new THREE.BoxGeometry(1, 1, 1);
    this._addShape(scene, boxGeo, quality === 'low' ? 3000 : 6000, material, null);
    this.variantShapes = [];
    for (const variant of fractureLib) {
      const ids = [];
      for (const piece of variant) {
        ids.push(this._addShape(scene, piece.geometry.clone(), quality === 'low' ? 350 : 700, material, piece));
      }
      this.variantShapes.push(ids);
    }

    physics.onContactForce = (h1, h2, f) => this._onForce(h1, h2, f);
  }

  _addShape(scene, geo, capacity, material, piece) {
    const attrs = addChunkAttributes(geo, capacity);
    const mesh = new THREE.InstancedMesh(geo, material, capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < capacity; i++) mesh.setMatrixAt(i, ZERO_M);
    mesh.setColorAt(0, new THREE.Color(1, 1, 1));
    mesh.count = 0;
    mesh.castShadow = !piece; // whole chunks and slabs shadow the street; Voronoi shards are too small to tell
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    scene.add(mesh);
    trackUploads(mesh.instanceMatrix, mesh.instanceColor, attrs.style, attrs.parent, attrs.offset, attrs.cell, attrs.hit);
    const free = [];
    for (let i = capacity - 1; i >= 0; i--) free.push(i);
    // instances touched since the last update(): matrices (mLo..mHi) and attributes (aLo..aHi)
    this.shapes.push({ mesh, attrs, free, capacity, frozenQ: [], piece, mLo: Infinity, mHi: -1, aLo: Infinity, aHi: -1 });
    return this.shapes.length - 1;
  }

  get activeCount() { return this.active.length; }
  get freeBudget() { return this.budget - this.active.length; }

  _alloc(shapeId) {
    const sh = this.shapes[shapeId];
    if (sh.free.length === 0) {
      // recycle the oldest frozen rubble of this shape
      while (sh.frozenQ.length) {
        const old = sh.frozenQ.shift();
        if (old.frozen && !old.dead) { this._kill(old); break; }
      }
      if (sh.free.length === 0) return -1;
    }
    const idx = sh.free.pop();
    if (idx + 1 > sh.mesh.count) sh.mesh.count = idx + 1;
    return idx;
  }

  _writeAttrs(rec, o) {
    const sh = this.shapes[rec.shape];
    const i = rec.idx;
    const a = sh.attrs;
    a.style.array.set(o.style, i * 4);
    a.parent.array.set([o.parent.x, o.parent.y, o.parent.z, o.seed ?? Math.random() * 100], i * 4);
    a.offset.array.set([o.offset.x, o.offset.y, o.offset.z], i * 3);
    a.cell.array.set([o.cell.x, o.cell.y, o.cell.z], i * 3);
    a.hit.array.set(o.hit, i * 4);
    sh.mesh.setColorAt(i, o.color);
    if (i < sh.aLo) sh.aLo = i;
    if (i > sh.aHi) sh.aHi = i;
  }

  // Bump a piece's damage (cracks, blown glass, dust coat); recorded like any attribute write.
  _bruise(rec, amount) {
    if (rec.dead || rec.style[3] >= 1) return;
    rec.style[3] = Math.min(1, rec.style[3] + amount);
    this._writeAttrs(rec, rec);
  }

  _setMatrix(rec, pos, quat) {
    _m.compose(pos, quat, rec.scale);
    const sh = this.shapes[rec.shape];
    sh.mesh.setMatrixAt(rec.idx, _m);
    if (rec.idx < sh.mLo) sh.mLo = rec.idx;
    if (rec.idx > sh.mHi) sh.mHi = rec.idx;
  }

  _hullFor(shape, scale) {
    const key = `${shape}|${scale.x.toFixed(2)}|${scale.y.toFixed(2)}|${scale.z.toFixed(2)}`;
    let pts = this.hullCache.get(key);
    if (!pts) {
      const src = this.shapes[shape].piece.hull;
      pts = new Float32Array(src.length);
      // shrink about the centroid so freshly spawned shards never start interpenetrating
      // (penetration resolution is the expensive path for convex hulls)
      const k = 0.86;
      for (let i = 0; i < src.length; i += 3) {
        pts[i] = src[i] * scale.x * k; pts[i + 1] = src[i + 1] * scale.y * k; pts[i + 2] = src[i + 2] * scale.z * k;
      }
      this.hullCache.set(key, pts);
    }
    return pts;
  }

  _makeBody(rec, pos, quat, vel, angvel) {
    const R = this.R;
    const bd = R.RigidBodyDesc.dynamic()
      .setTranslation(pos.x, pos.y, pos.z)
      .setRotation({ x: quat.x, y: quat.y, z: quat.z, w: quat.w })
      .setLinvel(vel.x, vel.y, vel.z)
      .setAngvel({ x: angvel.x, y: angvel.y, z: angvel.z })
      .setLinearDamping(0.05)
      .setAngularDamping(0.4);
    const body = this.world.createRigidBody(bd);
    let cd;
    if (rec.shape === BOX) {
      cd = R.ColliderDesc.cuboid(rec.scale.x / 2 * 0.93, rec.scale.y / 2 * 0.93, rec.scale.z / 2 * 0.93);
    } else {
      cd = R.ColliderDesc.convexHull(this._hullFor(rec.shape, rec.scale)) ||
        R.ColliderDesc.cuboid(rec.scale.x * 0.2, rec.scale.y * 0.2, rec.scale.z * 0.2);
    }
    cd.setDensity(1).setFriction(0.85).setRestitution(0.08)
      .setCollisionGroups(rec.small ? CG.small : CG.debris);
    if (rec.breakable || rec.crusher) {
      // threshold relative to mass: resting piles stay silent, only real impacts report
      const vol = rec.shape === BOX ? rec.scale.x * rec.scale.y * rec.scale.z * 0.8 : this.shapes[rec.shape].piece.volume * rec.scale.x * rec.scale.y * rec.scale.z * 0.64;
      cd.setActiveEvents(R.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(Math.max(50, vol * 330));
    }
    const col = this.world.createCollider(cd, body);
    rec.body = body;
    rec.collider = col;
    // speeds are cached by update(); a body that hasn't been through it yet can't be frozen to make room
    rec.lsp = -1; rec.sp = -1; rec.asleep = false;
    rec.mass = Math.max(0.01, col.mass());
    this.colliderMap.set(col.handle, rec);
    this.active.push(rec);
  }

  // o: { pos, quat, size, cell, color, style[4], parent, offset, vel, angvel, breakable, cells, small, crusher }
  spawnBox(o) {
    let ghost = false;
    if (this.freeBudget <= 0 && !this._makeRoom(1, o.priority)) {
      // no room for a body: a collapse piece falls without one, anything else isn't spawned
      if (!o.priority || this.ghosts.length >= MAX_GHOSTS) return null;
      ghost = true;
    }
    const idx = this._alloc(BOX);
    if (idx < 0) return null;
    const rec = {
      shape: BOX, idx, body: null, collider: null, frozen: false, dead: false, age: 0, sleepT: 0,
      scale: o.size.clone(), cell: o.cell.clone(), breakable: !!o.breakable, cells: o.cells || null,
      small: !!o.small, crusher: !!o.crusher, color: o.color.clone(), style: o.style.slice(),
      parent: o.parent ? o.parent.clone() : o.size.clone(), offset: o.offset ? o.offset.clone() : new THREE.Vector3(),
      seed: o.seed ?? Math.random() * 100, hashKey: null, mass: 1, hit: o.hit ? o.hit.slice() : [0, 0, 0, 0],
      // big collapse pieces trail dust on the way down
      trail: !!o.crusher && Math.max(o.size.x, o.size.y, o.size.z) > 4, trailT: Math.random() * 0.15,
    };
    this._writeAttrs(rec, rec);
    if (ghost) this._ghost(rec, o.pos, o.quat, o.vel, o.angvel);
    else this._makeBody(rec, o.pos, o.quat, o.vel, o.angvel);
    this._setMatrix(rec, o.pos, o.quat);
    return rec;
  }

  // Shatter a box volume into a pre-fractured Voronoi variant.
  // velFn(worldPos, out) supplies each shard's velocity (so shards fly away from the impact).
  spawnPieces(o, velFn) {
    const variant = Math.floor(Math.random() * this.variantShapes.length);
    const ids = this.variantShapes[variant];
    if (this.freeBudget < ids.length && !this._makeRoom(ids.length)) return 0;
    let n = 0;
    for (const shapeId of ids) {
      const piece = this.shapes[shapeId].piece;
      const idx = this._alloc(shapeId);
      if (idx < 0) continue;
      const off = piece.centroid.clone().multiply(o.size);
      const wp = off.clone().applyQuaternion(o.quat).add(o.pos);
      const vol = piece.volume * o.size.x * o.size.y * o.size.z;
      const rec = {
        shape: shapeId, idx, body: null, collider: null, frozen: false, dead: false, age: 0, sleepT: 0,
        scale: o.size.clone(), cell: o.cell.clone(), breakable: false, small: vol < 2.5,
        color: o.color.clone(), style: o.style.slice(), parent: (o.parent || o.size).clone(),
        offset: off.clone().add(o.offset || _w.set(0, 0, 0)), seed: o.seed ?? Math.random() * 100,
        hashKey: null, mass: 1, hit: o.hit ? o.hit.slice() : [0, 0, 0, 0],
      };
      this._writeAttrs(rec, rec);
      velFn(wp, _v);
      randomUnit(_w).multiplyScalar(rand(2, 7));
      this._makeBody(rec, wp, o.quat, _v, _w);
      this._setMatrix(rec, wp, o.quat);
      n++;
    }
    return n;
  }

  // Free budget by freezing the calmest bodies. Returns true if any room was made.
  // `aggressive` (collapses) may also retire small in-flight shards, swapping them for pebbles.
  _makeRoom(need = 1, aggressive = false) {
    return this.reserve(need, aggressive);
  }

  // Make sure `need` bodies fit, freezing (and, if `aggressive`, retiring) in one pass what a
  // whole frame's worth of spawns needs, plus a few spare. Reads only the speeds update()
  // cached, so no WASM calls. Once a pass has run out of candidates, later calls in the same
  // frame answer false at once.
  reserve(need = 1, aggressive = false) {
    const deficit = need - this.freeBudget;
    if (deficit <= 0) return true;
    if (this.roomFrame !== this.frame) { this.roomFrame = this.frame; this.dryCalm = this.drySmall = false; }
    if (this.dryCalm && (!aggressive || this.drySmall)) return false;
    const R = this._pickR;
    let made = 0;
    if (aggressive && !this.drySmall) {
      // the oldest small in-flight shards go first: each one turns into a few pebbles
      const want = deficit + 12;
      const n = this._pick(want, true);
      for (let k = 0; k < n; k++) {
        const rec = R[k];
        const t = rec.body.translation();
        G.fx && G.fx.pebbleBurst(_p.set(t.x, t.y, t.z), 2, null, rec.color, 0.5);
        this._kill(rec);
        made++;
      }
      if (n < want) this.drySmall = true;
    }
    if (made < deficit && !this.dryCalm) {
      // then park the calmest bodies where they are: sleeping first, then slowest
      const want = deficit + 8 - made;
      const n = this._pick(want, false);
      for (let k = 0; k < n; k++) { this._freeze(R[k]); made++; }
      if (n < want) this.dryCalm = true;
    }
    R.length = 0;
    return made > 0;
  }

  // The `want` best candidates into this._pickR, best first, in one pass with a bounded insertion
  // (ties keep `active` order). smalls: small shards, oldest first. Otherwise: bodies slower than
  // 3 m/s (speed² <= 9) as of the last update(), sleeping ones first, then by speed.
  _pick(want, smalls) {
    const R = this._pickR, K = this._pickK;
    let n = 0;
    for (const rec of this.active) {
      let k;
      if (smalls) {
        if (!rec.small) continue;
        k = -rec.age;
      } else {
        if (!(rec.lsp >= 0 && rec.lsp <= 9)) continue;
        // slow for a moment isn't at rest: a slab just let go, or at the top of its arc, would be
        // parked in mid-air (free fall passes 3 m/s within a third of a second)
        if (!rec.asleep && !(rec.calmT > 0.7)) continue;
        k = rec.asleep ? -1 : rec.lsp;
      }
      if (n === want && k >= K[n - 1]) continue;
      let j = n < want ? n++ : n - 1;
      while (j > 0 && K[j - 1] > k) { R[j] = R[j - 1]; K[j] = K[j - 1]; j--; }
      R[j] = rec; K[j] = k;
    }
    return n;
  }

  _removeBody(rec) {
    if (!rec.body) return;
    this.colliderMap.delete(rec.collider.handle);
    this.world.removeRigidBody(rec.body);
    rec.body = null; rec.collider = null;
    const i = this.active.indexOf(rec);
    if (i >= 0) { this.active[i] = this.active[this.active.length - 1]; this.active.pop(); }
  }

  _freeze(rec) {
    if (!rec.body) return;
    const t = rec.body.translation(), r = rec.body.rotation();
    const pos = new THREE.Vector3(t.x, t.y, t.z), quat = new THREE.Quaternion(r.x, r.y, r.z, r.w);
    this._removeBody(rec);
    this._park(rec, pos, quat);
  }

  // The piece stays here (pos / quat are kept), as static rubble: no body, in the rubble hash.
  _park(rec, pos, quat) {
    rec.fpos = pos;
    rec.fquat = quat;
    this._setMatrix(rec, pos, quat);
    rec.frozen = true;
    // its box in the world (half sizes), for the support check; a Voronoi shard is a part of its scale
    const e = _m.makeRotationFromQuaternion(quat).elements, s = rec.scale, k = rec.shape === BOX ? 0.5 : 0.3;
    rec.fhx = k * (Math.abs(e[0]) * s.x + Math.abs(e[4]) * s.y + Math.abs(e[8]) * s.z);
    rec.fhy = k * (Math.abs(e[1]) * s.x + Math.abs(e[5]) * s.y + Math.abs(e[9]) * s.z);
    rec.fhz = k * (Math.abs(e[2]) * s.x + Math.abs(e[6]) * s.y + Math.abs(e[10]) * s.z);
    this.shapes[rec.shape].frozenQ.push(rec);
    rec.fi = this.frozenList.length;
    this.frozenList.push(rec);
    const key = hashKey(pos.x, pos.z);
    rec.hashKey = key;
    let set = this.rubbleHash.get(key);
    if (!set) this.rubbleHash.set(key, (set = new Set()));
    set.add(rec);
  }

  // no longer parked (about to move again, or gone)
  _unpark(rec) {
    if (!rec.frozen) return;
    rec.frozen = false;
    const set = this.rubbleHash.get(rec.hashKey);
    if (set) set.delete(rec);
    const L = this.frozenList, last = L.pop();
    if (last !== rec) { L[rec.fi] = last; last.fi = rec.fi; }
    rec.fi = -1;
  }

  _unfreeze(rec, vel, angvel) {
    if (!rec.frozen) return;
    this._unpark(rec);
    rec.sleepT = 0;
    rec.age = 0;
    this._makeBody(rec, rec.fpos, rec.fquat, vel, angvel);
  }

  // ---------- ghosts: falling without a body ----------
  _ghost(rec, pos, quat, vel, angvel) {
    rec.ghost = true;
    rec.gpos = pos.clone(); rec.gquat = quat.clone(); rec.gvel = vel.clone(); rec.gang = angvel.clone();
    rec.gfloor = -Infinity; rec.gfloorT = 0; rec.gpile = false;
    rec.age = 0;
    this.ghosts.push(rec);
  }

  // what a falling piece comes down on at (x, z), from height y: the street (craters, rubble mounds)
  // or the top of whatever still stands under it
  _floorUnder(x, y, z) {
    const g = G.ground.heightAt(x, z);
    return G.destruction ? Math.max(g, G.destruction.floorUnder(x, y, z)) : g;
  }

  _updateGhosts(dt) {
    const L = this.ghosts;
    let trails = 0;
    for (let i = L.length - 1; i >= 0; i--) {
      const rec = L[i], p = rec.gpos, q = rec.gquat, w = rec.gang;
      rec.age += dt;
      rec.gvel.y -= GRAVITY * dt;
      p.addScaledVector(rec.gvel, dt);
      // q += 0.5 * w * q * dt
      _q.set(w.x, w.y, w.z, 0).multiply(q);
      q.set(q.x + _q.x * 0.5 * dt, q.y + _q.y * 0.5 * dt, q.z + _q.z * 0.5 * dt, q.w + _q.w * 0.5 * dt).normalize();
      if (!rec.gpile && (rec.gfloorT -= dt) <= 0) { rec.gfloorT = 0.2; rec.gfloor = this._floorUnder(p.x, p.y, p.z); }
      const e = _m.makeRotationFromQuaternion(q).elements, s = rec.scale;
      const hy = 0.5 * (Math.abs(e[1]) * s.x + Math.abs(e[5]) * s.y + Math.abs(e[9]) * s.z);
      let crumble = p.y < -40 || rec.age > 30;
      if (!rec.gpile && p.y - hy <= rec.gfloor + 3.2) {
        // nearly down: it comes to rest on the rubble already lying here, and where that's piled
        // high it breaks up on it instead (the mound in the street is the pile; a neat stack of
        // a hundred floor plates isn't)
        rec.gpile = true;
        const hx = 0.5 * (Math.abs(e[0]) * s.x + Math.abs(e[4]) * s.y + Math.abs(e[8]) * s.z);
        const hz = 0.5 * (Math.abs(e[2]) * s.x + Math.abs(e[6]) * s.y + Math.abs(e[10]) * s.z);
        const top = this._pileTop(p, hx * 0.6, hz * 0.6, p.y - hy + 0.5);
        if (top > rec.gfloor + 2.6) crumble = true;
        else if (top > rec.gfloor) rec.gfloor = top;
      }
      if (crumble || p.y - hy <= rec.gfloor) {
        L[i] = L[L.length - 1]; L.pop();
        rec.ghost = false;
        if (crumble) {
          if (p.y > -40) {
            G.fx.pebbleBurst(p, Math.min(10, 2 + s.length() * 0.6), _v.set(rec.gvel.x * 0.3, 3, rec.gvel.z * 0.3), rec.color, Math.min(3, s.length() * 0.3));
            if (this.landFx > 0) { this.landFx--; G.fx.dustPuff(p, Math.min(2.6, s.length() * 0.4), 2, 'dust'); }
          }
          this._kill(rec);
          continue;
        }
        p.y = rec.gfloor + this._flop(rec, hy);
        this._ghostLand(rec);
        continue;
      }
      if (rec.trail && (rec.trailT -= dt) <= 0 && trails < 3 && rec.gvel.y < -10 && G.fx.smoke.load < 0.8) {
        const sz = Math.min(3.5, s.length() * 0.2);
        G.fx.smoke.spawn(p.x, p.y, p.z, rec.gvel.x * 0.15, rec.gvel.y * 0.08, rec.gvel.z * 0.15, sz, 2.2, rand(2.2, 3.6), 'dust', 1.8, 0.5);
        rec.trailT = 0.14;
        trails++;
      }
      this._setMatrix(rec, p, q);
    }
  }

  // A thin piece (a floor plate, a strip of facade) comes down flat, give or take: with no body
  // to tip it over it would stay as it fell, standing on an edge. Returns its half height as it lies.
  _flop(rec, hy) {
    const s = rec.scale, mn = Math.min(s.x, s.y, s.z);
    if (mn > Math.max(s.x, s.y, s.z) * 0.45) return hy;
    const q = rec.gquat;
    const thin = (mn === s.x ? _w.set(1, 0, 0) : mn === s.y ? _w.set(0, 1, 0) : _w.set(0, 0, 1)).applyQuaternion(q);
    _v.set(rand(-0.14, 0.14), thin.y < 0 ? -1 : 1, rand(-0.14, 0.14)).normalize();
    q.premultiply(_q.setFromUnitVectors(thin, _v)).normalize();
    const e = _m.makeRotationFromQuaternion(q).elements;
    return 0.5 * (Math.abs(e[1]) * s.x + Math.abs(e[5]) * s.y + Math.abs(e[9]) * s.z);
  }

  // the top of the parked rubble under the box (half sizes hx, hz) round p, no higher than `hi`
  _pileTop(p, hx, hz, hi) {
    let best = -Infinity;
    const i0 = Math.floor((p.x - hx - HASH) / HASH), i1 = Math.floor((p.x + hx + HASH) / HASH);
    const j0 = Math.floor((p.z - hz - HASH) / HASH), j1 = Math.floor((p.z + hz + HASH) / HASH);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const set = this.rubbleHash.get(i * 73856093 ^ j * 19349663);
      if (!set) continue;
      for (const o of set) {
        const top = o.fpos.y + o.fhy;
        if (top > best && top <= hi && Math.abs(o.fpos.x - p.x) <= hx + o.fhx && Math.abs(o.fpos.z - p.z) <= hz + o.fhz) best = top;
      }
    }
    return best;
  }

  // a ghost reaches what's under it: it stays there, with dust and a thud for the first few a frame
  _ghostLand(rec) {
    const sp = -rec.gvel.y;
    this._park(rec, rec.gpos, rec.gquat);
    rec.landed = true;
    if (this.landFx > 0 && sp > 8) {
      this.landFx--;
      const k = Math.cbrt(Math.max(1, rec.scale.x * rec.scale.y * rec.scale.z * 0.8));
      const p = _p.set(rec.fpos.x, rec.fpos.y - rec.fhy + 0.5, rec.fpos.z);
      G.fx.dustRing(p, Math.min(14, 1.5 + k * 1.4), 4 + Math.round(k), 'dust', 0.55);
      G.fx.pebbleBurst(p, Math.min(12, 3 + k * 2), _v.set(0, sp * 0.25, 0), rec.color, 1.5);
      G.fightCam && G.fightCam.addTraumaAt(p, Math.min(0.2, 0.03 + k * 0.02), 300);
      if (k > 2.2) G.audio && G.audio.crumble(Math.min(1, k / 6), p);
    }
    this._bruise(rec, 0.25);
  }

  // ---------- support ----------
  // Parked rubble stays where it came to rest. If what it rested on has since gone (the storey
  // under a floor plate, the wall a slab leaned on), it falls again: a few checks each frame.
  _sweep() {
    const L = this.frozenList;
    for (let k = Math.min(SWEEP, L.length); k > 0 && L.length; k--) {
      if (this.sweepI >= L.length) this.sweepI = 0;
      const rec = L[this.sweepI];
      if (this._supported(rec)) { this.sweepI++; continue; }
      if (this.ghosts.length >= MAX_GHOSTS) return;
      this._unpark(rec); // (the list's last piece now sits at this index: it's looked at next)
      this._ghost(rec, rec.fpos, rec.fquat, _v.set(rand(-0.4, 0.4), -1, rand(-0.4, 0.4)), randomUnit(_w).multiplyScalar(rand(0.2, 0.9)));
    }
  }

  _supported(rec) {
    const p = rec.fpos, hx = rec.fhx, hy = rec.fhy, hz = rec.fhz, bottom = p.y - hy;
    if (bottom - G.ground.heightAt(p.x, p.z) < 1.2) return true;
    // a standing chunk it touches, level with it or under it
    const S = G.destruction, pad = 0.7;
    let ok = false;
    S.forChunksInSphere(p, Math.hypot(hx, hy, hz) + pad, (id) => {
      if (ok) return;
      const d = S.defs[id];
      if (d.c.y > p.y + 0.3) return;
      if (Math.abs(d.c.x - p.x) <= d.size.x / 2 + hx + pad && Math.abs(d.c.y - p.y) <= d.size.y / 2 + hy + pad && Math.abs(d.c.z - p.z) <= d.size.z / 2 + hz + pad) ok = true;
    });
    if (ok) return true;
    // other rubble right under it
    const i0 = Math.floor((p.x - hx - HASH) / HASH), i1 = Math.floor((p.x + hx + HASH) / HASH);
    const j0 = Math.floor((p.z - hz - HASH) / HASH), j1 = Math.floor((p.z + hz + HASH) / HASH);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const set = this.rubbleHash.get(i * 73856093 ^ j * 19349663);
      if (!set) continue;
      for (const o of set) {
        if (o === rec || o.fpos.y >= p.y) continue;
        if (bottom - (o.fpos.y + o.fhy) < 0.9 && Math.abs(o.fpos.x - p.x) <= hx + o.fhx + 0.4 && Math.abs(o.fpos.z - p.z) <= hz + o.fhz + 0.4) return true;
      }
    }
    return false;
  }

  _kill(rec) {
    if (rec.dead) return;
    this._removeBody(rec);
    this._unpark(rec);
    if (rec.ghost) {
      rec.ghost = false;
      const i = this.ghosts.indexOf(rec);
      if (i >= 0) { this.ghosts[i] = this.ghosts[this.ghosts.length - 1]; this.ghosts.pop(); }
    }
    rec.dead = true;
    const sh = this.shapes[rec.shape];
    sh.mesh.setMatrixAt(rec.idx, ZERO_M);
    if (rec.idx < sh.mLo) sh.mLo = rec.idx;
    if (rec.idx > sh.mHi) sh.mHi = rec.idx;
    sh.free.push(rec.idx);
  }

  _onForce(h1, h2, f) {
    const a = this.colliderMap.get(h1), b = this.colliderMap.get(h2);
    const chunkA = G.destruction && G.destruction.colliderChunk.get(h1);
    const chunkB = G.destruction && G.destruction.colliderChunk.get(h2);
    for (const [rec, other, otherRec] of [[a, chunkB, b], [b, chunkA, a]]) {
      if (!rec || !rec.body || rec.queued) continue;
      const accel = f / rec.mass;
      if (other !== undefined && rec.crusher && accel > 380) {
        const v = rec.body.linvel();
        if (v.y < -5) G.destruction.crushChunk(other, rec);
      }
      // every hard knock cracks it up a bit more
      if (accel > 220 && rec.age > 0.15 && rec.age - (rec.bruiseAge ?? -1) > 0.25) {
        rec.bruiseAge = rec.age;
        this._bruise(rec, 0.12 + Math.min(0.25, accel / 4000));
      }
      // a heavy collapse piece hitting the street for the first time
      if (rec.crusher && !rec.landed && !otherRec && other === undefined && rec.mass > 8) {
        const t = rec.body.translation();
        if (t.y - G.ground.heightAt(t.x, t.z) < Math.max(rec.scale.x, rec.scale.y, rec.scale.z) * 0.6 + 1) {
          rec.landed = true;
          this.landQueue.push(rec);
        }
      }
      if (rec.breakable && rec.age > 0.12 && accel > 650) {
        rec.queued = true;
        this.breakQueue.push(rec);
      }
    }
  }

  _breakRec(rec) {
    if (!rec.body || rec.dead) return;
    const t = rec.body.translation(), r = rec.body.rotation();
    const lv = rec.body.linvel(), av = rec.body.angvel();
    const pos = new THREE.Vector3(t.x, t.y, t.z);
    const quat = new THREE.Quaternion(r.x, r.y, r.z, r.w);
    const base = new THREE.Vector3(lv.x * 0.5, Math.abs(lv.y) * 0.15, lv.z * 0.5);
    this._kill(rec);
    const proto = { color: rec.color, style: rec.style, cell: rec.cell, seed: rec.seed, hit: rec.hit };

    if (rec.cells && (rec.cells[0] * rec.cells[1] * rec.cells[2] > 1)) {
      // merged slab -> split in halves along its longest cell axes (progressive crumble)
      let parts = [{ cells: rec.cells.slice(), lo: new THREE.Vector3(-rec.scale.x / 2, -rec.scale.y / 2, -rec.scale.z / 2), size: rec.scale.clone() }];
      const splits = this.freeBudget > 40 ? 2 : 1;
      for (let s = 0; s < splits; s++) {
        const next = [];
        for (const p of parts) {
          const ax = p.cells.indexOf(Math.max(...p.cells));
          if (p.cells[ax] < 2) { next.push(p); continue; }
          const n1 = Math.floor(p.cells[ax] / 2), n2 = p.cells[ax] - n1;
          const key = ['x', 'y', 'z'][ax];
          const s1 = p.size[key] * (n1 / p.cells[ax]);
          const a = { cells: p.cells.slice(), lo: p.lo.clone(), size: p.size.clone() };
          a.cells[ax] = n1; a.size[key] = s1;
          const b = { cells: p.cells.slice(), lo: p.lo.clone(), size: p.size.clone() };
          b.cells[ax] = n2; b.size[key] = p.size[key] - s1; b.lo[key] += s1;
          next.push(a, b);
        }
        parts = next;
      }
      for (const p of parts) {
        const lc = p.lo.clone().addScaledVector(p.size, 0.5);
        // each half is its own parent space: move the impact point with it
        const hit = rec.hit[3] > 0 ? [rec.hit[0] - lc.x, rec.hit[1] - lc.y, rec.hit[2] - lc.z, rec.hit[3]] : rec.hit;
        const wp = lc.applyQuaternion(quat).add(pos);
        const out = wp.clone().sub(pos).normalize().multiplyScalar(rand(1.5, 5));
        this.spawnBox({
          ...proto, hit, pos: wp, quat, size: p.size, parent: p.size.clone(), offset: new THREE.Vector3(),
          vel: base.clone().add(out).add(new THREE.Vector3(0, rand(1, 3), 0)),
          angvel: new THREE.Vector3(av.x, av.y, av.z).add(randomUnit(_w).multiplyScalar(1.5)),
          breakable: true, cells: p.cells, crusher: rec.crusher, priority: true,
        });
      }
    } else if (this.freeBudget > 10) {
      this.spawnPieces({ ...proto, pos, quat, size: rec.scale, parent: rec.parent, offset: rec.offset }, (wp, out) => {
        out.copy(wp).sub(pos).normalize().multiplyScalar(rand(3, 8)).add(base);
        out.y += rand(1, 5);
      });
    } else {
      G.fx && G.fx.pebbleBurst(pos, rec.scale.length() * 2, base, rec.color);
    }
    if (G.fx) {
      const s = rec.scale.length();
      // capped: a big slab breaking must not throw a screen-sized cloud
      G.fx.dustPuff(pos, Math.min(2.6, s * 0.45), Math.min(4, 1 + Math.round(s * 0.3)), 'dust');
      G.fx.pebbleBurst(pos, Math.min(14, s * 3), base, rec.color);
    }
    G.audio && G.audio.crumble(Math.min(1, rec.scale.length() / 6), pos);
  }

  // Radial impulse: shoves live debris, re-wakes frozen rubble within the radius.
  explosion(center, radius, strength, up = 0.4, maxWake = 50) {
    const r2 = radius * radius;
    for (const rec of this.active) {
      const t = rec.body.translation();
      _v.set(t.x - center.x, t.y - center.y, t.z - center.z);
      const d2 = _v.lengthSq();
      if (d2 > r2) continue;
      const d = Math.sqrt(d2);
      const fall = (1 - d / radius) ** 2;
      _v.divideScalar(d || 1);
      _v.y += up;
      _v.multiplyScalar(strength * fall * rec.mass);
      rec.body.applyImpulse({ x: _v.x, y: _v.y, z: _v.z }, true);
      rec.body.applyTorqueImpulse({ x: rand(-1, 1) * rec.mass * strength * 0.2, y: rand(-1, 1) * rec.mass * strength * 0.2, z: rand(-1, 1) * rec.mass * strength * 0.2 }, true);
    }
    let woke = 0;
    const c0 = Math.floor((center.x - radius) / HASH), c1 = Math.floor((center.x + radius) / HASH);
    const z0 = Math.floor((center.z - radius) / HASH), z1 = Math.floor((center.z + radius) / HASH);
    for (let i = c0; i <= c1; i++) for (let j = z0; j <= z1; j++) {
      const set = this.rubbleHash.get(i * 73856093 ^ j * 19349663);
      if (!set) continue;
      for (const rec of [...set]) {
        if (woke >= maxWake || this.freeBudget <= 0) return;
        const d = rec.fpos.distanceTo(center);
        if (d > radius) continue;
        const fall = (1 - d / radius) ** 2;
        _v.copy(rec.fpos).sub(center).divideScalar(d || 1);
        _v.y += up;
        _v.multiplyScalar(strength * fall);
        this._unfreeze(rec, _v, randomUnit(_w).multiplyScalar(strength * fall * 0.3));
        woke++;
      }
    }
  }

  // A heavy collapse piece hits the street: dust skirts out from under it and the ground shakes.
  _land(rec) {
    if (!rec.body || rec.dead) return;
    const t = rec.body.translation();
    const p = _p.set(t.x, G.ground.heightAt(t.x, t.z) + 0.5, t.z);
    const k = Math.cbrt(rec.mass);
    G.fx.dustRing(p, Math.min(14, 1.5 + k * 1.4), 4 + Math.round(k), 'dust', 0.55);
    G.fightCam && G.fightCam.addTraumaAt(p, Math.min(0.22, 0.03 + rec.mass / 900), 300);
    this._bruise(rec, 0.25);
  }

  update(dt) {
    this.frame++;
    for (let k = 0; k < this.breakQueue.length; k++) this._breakRec(this.breakQueue[k]);
    this.breakQueue.length = 0;
    // the biggest landings first, a few per frame
    if (this.landQueue.length) {
      this.landQueue.sort((a, b) => b.mass - a.mass);
      for (let k = 0; k < Math.min(3, this.landQueue.length); k++) this._land(this.landQueue[k]);
      this.landQueue.length = 0;
    }
    let trails = 0;

    for (let i = this.active.length - 1; i >= 0; i--) {
      const rec = this.active[i];
      const b = rec.body;
      rec.age += dt;
      const t = b.translation();
      if (t.y < -40) { this._kill(rec); continue; }
      // safety net: thin pieces can tunnel through the heightfield - pop them back and park them
      const gh = G.ground.heightAt(t.x, t.z);
      if (t.y < gh - 0.6) {
        b.setTranslation({ x: t.x, y: gh + Math.min(rec.scale.y, 1) * 0.5, z: t.z }, true);
        b.setLinvel({ x: 0, y: 0, z: 0 }, true);
        this._freeze(rec);
        continue;
      }
      // Rapier 0.21 sleeps whole islands, so judge rest per piece by its own velocity.
      // (kept on the record too: reserve() picks the calmest bodies from these)
      const asleep = b.isSleeping();
      const lsp = asleep ? 0 : speed2(b);
      const sp = asleep ? 0 : lsp + angSpeed2(b) * 0.5;
      rec.asleep = asleep; rec.lsp = lsp; rec.sp = sp;
      rec.calmT = lsp <= 9 ? (rec.calmT || 0) + dt : 0;
      if (sp < 0.8) {
        rec.sleepT += dt;
        if (rec.sleepT > 0.45 && rec.age > 0.5) { this._freeze(rec); continue; }
      } else {
        rec.sleepT = 0;
        // jittering piles: park anything slow that has been around a while
        if ((rec.age > 6 && sp < 4) || (rec.age > 12 && sp < 30)) { this._freeze(rec); continue; }
      }
      if (rec.trail && !rec.landed && (rec.trailT -= dt) <= 0 && sp > 120 && trails < 4 && G.fx.smoke.load < 0.8) {
        const v = b.linvel(), s = Math.min(3.5, rec.scale.length() * 0.2);
        G.fx.smoke.spawn(t.x, t.y, t.z, v.x * 0.15, v.y * 0.08, v.z * 0.15, s, 2.2, rand(2.2, 3.6), 'dust', 1.8, 0.5);
        rec.trailT = 0.14;
        trails++;
      }
      if (!asleep) {
        const r = b.rotation();
        _p.set(t.x, t.y, t.z); _q.set(r.x, r.y, r.z, r.w);
        this._setMatrix(rec, _p, _q);
      }
    }
    this.landFx = 3;
    if (dt > 0) {
      this._updateGhosts(dt);
      this._sweep();
    }
    // upload just the instances that changed (frozen rubble doesn't move, so the span is short)
    for (const sh of this.shapes) {
      if (sh.mHi >= 0) {
        stageInstances(sh.mesh.instanceMatrix, sh.mLo, sh.mHi);
        sh.mLo = Infinity; sh.mHi = -1;
      }
      if (sh.aHi >= 0) {
        const a = sh.attrs, lo = sh.aLo, hi = sh.aHi;
        stageInstances(a.style, lo, hi); stageInstances(a.parent, lo, hi); stageInstances(a.offset, lo, hi);
        stageInstances(a.cell, lo, hi); stageInstances(a.hit, lo, hi);
        if (sh.mesh.instanceColor) stageInstances(sh.mesh.instanceColor, lo, hi);
        sh.aLo = Infinity; sh.aHi = -1;
      }
    }
  }
}

function speed2(b) {
  const v = b.linvel();
  return v.x * v.x + v.y * v.y + v.z * v.z;
}
function angSpeed2(b) {
  const w = b.angvel();
  return w.x * w.x + w.y * w.y + w.z * w.z;
}
function hashKey(x, z) {
  return Math.floor(x / HASH) * 73856093 ^ Math.floor(z / HASH) * 19349663;
}
