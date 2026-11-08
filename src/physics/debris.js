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
    if (this.freeBudget <= 0 && !this._makeRoom(1, o.priority)) return null;
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
    this._makeBody(rec, o.pos, o.quat, o.vel, o.angvel);
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
    rec.fpos = new THREE.Vector3(t.x, t.y, t.z);
    rec.fquat = new THREE.Quaternion(r.x, r.y, r.z, r.w);
    this._setMatrix(rec, rec.fpos, rec.fquat);
    this._removeBody(rec);
    rec.frozen = true;
    this.shapes[rec.shape].frozenQ.push(rec);
    const key = hashKey(rec.fpos.x, rec.fpos.z);
    rec.hashKey = key;
    let set = this.rubbleHash.get(key);
    if (!set) this.rubbleHash.set(key, (set = new Set()));
    set.add(rec);
  }

  _unfreeze(rec, vel, angvel) {
    if (!rec.frozen) return;
    const set = this.rubbleHash.get(rec.hashKey);
    if (set) set.delete(rec);
    rec.frozen = false;
    rec.sleepT = 0;
    rec.age = 0;
    this._makeBody(rec, rec.fpos, rec.fquat, vel, angvel);
  }

  _kill(rec) {
    if (rec.dead) return;
    this._removeBody(rec);
    if (rec.frozen) {
      const set = this.rubbleHash.get(rec.hashKey);
      if (set) set.delete(rec);
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
