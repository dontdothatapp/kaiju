// Destructible structures. Each building is a grid of chunks (thin facade panels on the
// perimeter, corner columns, floor/ceiling slabs inside, rooftop props). All intact chunks of
// the whole city live in one InstancedMesh. Breaking a chunk hides its instance and hands an
// identical-looking body to the debris system, so the transition is seamless.
//
// Damage model (layered, after THE FINALS / Red Faction / Control talks):
//   impact sphere  -> core: pulverize (particles+dust), mid: Voronoi fracture, outer: detach,
//                     shatter ring: blow out windows, crack ring: soot/cracks only
//   integrity      -> per-level wall ratio + flood-fill connectivity to the ground
//   collapse       -> creak/dust wind-up, failure travelling outward, coherent lean,
//                     merged slabs that shatter on landing and crush what is below (pancaking)
import * as THREE from 'three';
import { chunkMaterials, chunkUniforms, cutaway, addChunkAttributes, STYLE } from './chunkMaterial.js';
import { G } from '../core/context.js';
import { clamp, rand, randomUnit, smoothstep } from '../core/math.js';

const ZERO_M = new THREE.Matrix4().makeScale(0, 0, 0);
const _m = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q0 = new THREE.Quaternion();
const KIND = { WALL: 0, SLAB: 1, CORNER: 2, SOLID: 3 };
const FAR_DIST = 350;        // beyond this a building gets the detail-less shader
const INTEGRITY_EVERY = 0.2; // seconds between integrity checks of one structure
const INTEGRITY_PER_FRAME = 1;
const _box = new THREE.Box3();
const _sph = new THREE.Sphere();

// Every city mesh shares the 1x1x1 box; each one gets its own geometry object so it can carry its
// own per-instance attributes, but the vertex buffers are the same three.js attributes.
let _boxGeo = null;
export function chunkBoxGeometry() {
  if (!_boxGeo) { _boxGeo = new THREE.BoxGeometry(1, 1, 1); _boxGeo.computeBoundingSphere(); }
  const g = new THREE.BufferGeometry();
  g.setIndex(_boxGeo.index);
  for (const k of ['position', 'normal', 'uv']) g.setAttribute(k, _boxGeo.attributes[k]);
  g.boundingSphere = _boxGeo.boundingSphere.clone();
  return g;
}

export class Structure {
  constructor(id, o) {
    this.id = id;
    this.kind = o.kind || 'building';
    this.origin = o.origin.clone();     // min corner
    this.xs = o.xs; this.zs = o.zs;     // cell boundary coordinates (local), length n+1
    this.nx = o.xs.length - 1;
    this.nz = o.zs.length - 1;
    this.ny = o.ny;
    this.sy = o.sy;
    this.cells = new Int32Array(this.nx * this.ny * this.nz).fill(-1);
    this.levelTotal = new Int32Array(this.ny);
    this.levelAlive = new Int32Array(this.ny);
    this.chunkIds = [];
    this.refined = false;
    this.intactCollider = null;
    this.dirty = false;
    this.collapsing = false;
    this.ratioThreshold = 0.42 * (1 + rand(-0.12, 0.12));
    this.min = new THREE.Vector3();
    this.max = new THREE.Vector3();
    this.anchorLevel = o.anchorLevel ?? 0;
    this.aliveCount = 0;
    this.groundAnchors = o.groundAnchors || null; // optional predicate (x,z)->bool for tracks
    this.mesh = null;          // this building's InstancedMesh (finalize)
    this.attrs = null;
    this.levelBoxes = null;    // refined: fixed box colliders per storey, until a storey goes fine
    this.fine = null;          // refined: Uint8Array, 1 = storey has one collider per chunk
    this.dirtyLevels = null;   // storeys that lost chunks since the last _flushLevels
    this.integrityT = -1;
  }
  ci(x, y, z) { return x + this.nx * (z + this.nz * y); }
}

export class Destruction {
  constructor(scene) {
    this.scene = scene;
    this.structs = [];
    // chunk store (filled during generation, then frozen into typed arrays)
    this.defs = [];
    this.colliderChunk = new Map();  // collider handle -> chunk id
    this.colliders = [];
    this.collapses = [];
    this.falls = [];       // dust, rubble and shaking for buildings on their way down
    this.crushBudget = 0;
    this.materials = chunkMaterials();
    this.material = this.materials.seeThrough; // what the debris draws with
    this.cityMeshes = [];      // every static city mesh (buildings, skyline cells) + bounds, for updateMaterials
    this.dirtyStructs = new Set();
    this.pendingIntegrity = new Set();
    this.eventsThisFrame = 0;
    this.time = 0;
  }

  // A static mesh drawn with the chunk shader; its material is picked per frame by distance and
  // by whether it stands between the camera and a fighter.
  registerCityMesh(mesh, min, max) {
    const c = new THREE.Vector3().addVectors(min, max).multiplyScalar(0.5);
    mesh.boundingSphere = new THREE.Sphere(c, c.distanceTo(max));
    mesh.frustumCulled = true;
    this.cityMeshes.push({ mesh, min: min.clone(), max: max.clone() });
  }

  // ---------- generation ----------
  addStructure(o) {
    const s = new Structure(this.structs.length, o);
    this.structs.push(s);
    return s;
  }

  addChunk(s, def) {
    // def: {x0,y0,z0,x1,y1,z1 (local), kind, level, color, style:[w,h,id], cells:[ci...] }
    const id = this.defs.length;
    const cx = s.origin.x + (def.x0 + def.x1) / 2, cy = s.origin.y + (def.y0 + def.y1) / 2, cz = s.origin.z + (def.z0 + def.z1) / 2;
    const d = {
      id, s: s.id, kind: def.kind, level: def.level,
      c: new THREE.Vector3(cx, cy, cz),
      size: new THREE.Vector3(def.x1 - def.x0, def.y1 - def.y0, def.z1 - def.z0),
      color: def.color, style: def.style, seed: Math.random() * 100,
      cell: def.cell || null, // facade window cell when it differs from the chunk (double-storey chunks)
      cells: def.cells, alive: true, dmg: 0, hasWindow: def.kind === KIND.WALL && def.style[2] < 3.5 && def.style[0] > 0,
    };
    this.defs.push(d);
    s.chunkIds.push(id);
    for (const c of def.cells) s.cells[c] = id;
    if (def.kind === KIND.WALL || def.kind === KIND.CORNER) { s.levelTotal[def.level]++; s.levelAlive[def.level]++; }
    s.aliveCount++;
    return id;
  }

  finalize() {
    const n = this.defs.length;
    for (const s of this.structs) {
      s.min.set(Infinity, Infinity, Infinity); s.max.set(-Infinity, -Infinity, -Infinity);
      for (const id of s.chunkIds) {
        const d = this.defs[id];
        _v.copy(d.size).multiplyScalar(0.5);
        s.min.min(_v2.copy(d.c).sub(_v));
        s.max.max(_v2.copy(d.c).add(_v));
      }
    }
    // One InstancedMesh per structure: three.js then culls each building against the camera and
    // the shadow camera on its own (one mesh for the whole city was drawn in full every frame).
    for (const s of this.structs) {
      const cnt = s.chunkIds.length;
      if (!cnt) continue;
      const geo = chunkBoxGeometry();
      const attrs = addChunkAttributes(geo, cnt);
      const mesh = new THREE.InstancedMesh(geo, this.materials.plain, cnt);
      s.chunkIds.forEach((id, li) => {
        const d = this.defs[id];
        d.li = li;
        // interior floor slabs stay out of the draw until the building is first touched: they
        // can't be seen through an intact facade (over a third of all chunks). A slab with open
        // air over any of its cells is a roof or a setback terrace and stays.
        const hidden = d.kind === KIND.SLAB && s.kind === 'building' && this._slabCovered(s, d);
        if (hidden) mesh.setMatrixAt(li, ZERO_M); else mesh.setMatrixAt(li, _m.compose(d.c, _q0, d.size));
        mesh.setColorAt(li, d.color);
        attrs.style.array.set([d.style[0], d.style[1], d.style[2], 0], li * 4);
        attrs.parent.array.set([d.size.x, d.size.y, d.size.z, d.seed], li * 4);
        attrs.offset.array.set([0, 0, 0], li * 3);
        const cell = d.cell || d.size;
        attrs.cell.array.set([cell.x, cell.y, cell.z], li * 3);
      });
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = 'city-' + s.id;
      // a full upload asked for (the recap) must not be cut short by a range added before it went up
      for (const a of [mesh.instanceMatrix, attrs.style, attrs.hit]) { a.fullPending = false; a.onUpload(() => { a.fullPending = false; }); }
      this.registerCityMesh(mesh, s.min, s.max);
      this.scene.add(mesh);
      s.mesh = mesh;
      s.attrs = attrs;
      if (s.intactBoxes) {
        // irregular footprints (real maps): a few boxes hug the shape instead of one bounding box
        s.intactCollider = s.intactBoxes.map(([x0, y0, z0, x1, y1, z1]) =>
          G.physics.fixedBox((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, (x1 - x0) / 2, (y1 - y0) / 2, (z1 - z0) / 2));
        continue;
      }
      const c = _v.copy(s.min).add(s.max).multiplyScalar(0.5), h = _v2.copy(s.max).sub(s.min).multiplyScalar(0.5);
      s.intactCollider = G.physics.fixedBox(c.x, c.y, c.z, h.x, h.y, h.z);
    }
    console.log(`[city] ${this.structs.length} structures, ${n} chunks, ${this.cityMeshes.length} meshes`);
  }

  // every cell of this slab has a chunk on the storey above it (the slab tile or wall up there)
  _slabCovered(s, d) {
    const plane = s.nx * s.nz;
    for (const c of d.cells) {
      const up = c + plane;
      if (up >= s.cells.length || s.cells[up] < 0) return false;
    }
    return true;
  }

  // ---------- per-chunk instance writes ----------
  // queue lo..lo+count of an instance attribute for upload (a whole-buffer upload someone asked for
  // and that hasn't gone up yet stays whole)
  _markRange(attr, lo, count) {
    if (!attr.fullPending) attr.addUpdateRange(lo, count);
    attr.needsUpdate = true;
  }

  // the chunk's instance: in place, or scaled to nothing
  showChunk(id, on, upload = true) {
    const d = this.defs[id], s = this.structs[d.s], m = s.mesh;
    if (on) _m.compose(d.c, _q0, d.size); else _m.copy(ZERO_M);
    m.setMatrixAt(d.li, _m);
    if (upload) this._markRange(m.instanceMatrix, d.li * 16, 16);
  }

  // the damage value the shader sees (style.w)
  setStyleW(id, v, upload = true) {
    const d = this.defs[id], a = this.structs[d.s].attrs.style;
    a.array[d.li * 4 + 3] = v;
    if (upload) this._markRange(a, d.li * 4, 4);
  }

  // after a batch of showChunk / setStyleW writes without uploads: send every building's whole
  // matrix and style buffers up (the recap rewinds the city this way)
  uploadAll() {
    for (const s of this.structs) {
      if (!s.mesh) continue;
      for (const a of [s.mesh.instanceMatrix, s.attrs.style]) { a.clearUpdateRanges(); a.fullPending = true; a.needsUpdate = true; }
    }
  }

  // Pick each city mesh's shader for this frame: the see-through (discard) variant only where a
  // building hugs the camera or reaches into a fighter's cutaway (chunkMaterial.js updateCutaway,
  // which runs first), the detail-less variant far away, the plain one otherwise. A building in a
  // cutaway is also what opens it.
  updateMaterials(camPos) {
    const M = this.materials, fade = chunkUniforms.uFadeDist.value;
    const fa = cutaway.frusta[0], fb = cutaway.frusta[1];
    let ba = false, bb = false;
    for (const cm of this.cityMeshes) {
      const mesh = cm.mesh;
      if (!mesh.visible) continue;
      _box.min.copy(cm.min); _box.max.copy(cm.max);
      const dCam = _box.distanceToPoint(camPos);
      const a = !!fa && fa.intersectsBox(_box), b = !!fb && fb.intersectsBox(_box);
      if (a) ba = true;
      if (b) bb = true;
      const mat = dCam < fade + 1 || a || b ? M.seeThrough : dCam > FAR_DIST ? M.far : M.plain;
      if (mesh.material !== mat) mesh.material = mat;
    }
    cutaway.blocked[0] = ba; cutaway.blocked[1] = bb;
  }

  // ---------- queries ----------
  structsNear(pos, r, all = false) {
    const out = [];
    for (const s of this.structs) {
      if (s.aliveCount === 0 && !all) continue;
      if (pos.x + r < s.min.x || pos.x - r > s.max.x || pos.y + r < s.min.y || pos.y - r > s.max.y || pos.z + r < s.min.z || pos.z - r > s.max.z) continue;
      out.push(s);
    }
    return out;
  }

  _range(arr, lo, hi) {
    let a = 0, b = arr.length - 2;
    while (a < arr.length - 1 && arr[a + 1] < lo) a++;
    while (b > 0 && arr[b] > hi) b--;
    return [a, b];
  }

  // Calls cb(chunkId, distanceToChunkSurface) for alive chunks within r of pos. `alive(def)`
  // overrides what counts as standing (the match recap asks about the city as it was).
  forChunksInSphere(pos, r, cb, alive = null) {
    const seen = this._seen || (this._seen = new Set());
    seen.clear();
    for (const s of this.structsNear(pos, r, !!alive)) {
      const lx = pos.x - s.origin.x, ly = pos.y - s.origin.y, lz = pos.z - s.origin.z;
      const [x0, x1] = this._range(s.xs, lx - r, lx + r);
      const [z0, z1] = this._range(s.zs, lz - r, lz + r);
      const y0 = clamp(Math.floor((ly - r) / s.sy), 0, s.ny - 1), y1 = clamp(Math.floor((ly + r) / s.sy), 0, s.ny - 1);
      for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
        const id = s.cells[s.ci(x, y, z)];
        if (id < 0 || seen.has(id)) continue;
        seen.add(id);
        const d = this.defs[id];
        if (alive ? !alive(d) : !d.alive) continue;
        const dist = boxDist(pos, d.c, d.size);
        if (dist <= r) cb(id, dist);
      }
    }
  }

  // Sphere vs intact chunks: returns push-out vector (for characters flying normally).
  resolveSphere(pos, r, out) {
    out.set(0, 0, 0);
    let hit = false;
    this.forChunksInSphere(pos, r, (id) => {
      const d = this.defs[id];
      const hx = d.size.x / 2, hy = d.size.y / 2, hz = d.size.z / 2;
      const px = clamp(pos.x, d.c.x - hx, d.c.x + hx), py = clamp(pos.y, d.c.y - hy, d.c.y + hy), pz = clamp(pos.z, d.c.z - hz, d.c.z + hz);
      _v.set(pos.x - px, pos.y - py, pos.z - pz);
      const l = _v.length();
      if (l < r) {
        if (l < 1e-4) { _v.set(pos.x - d.c.x, 0, pos.z - d.c.z).normalize(); out.addScaledVector(_v, r); }
        else out.addScaledVector(_v, (r - l) / l);
        hit = true;
      }
    });
    return hit;
  }

  // ---------- colliders ----------
  // An untouched building is a few fixed boxes. The first hit turns it into one box per storey,
  // and only the storeys that lose chunks get a collider per chunk (_fineLevel): debris never
  // reaches the inside of an intact storey, so a 40-storey tower keeps ~40 colliders instead of
  // 2,000, and the physics broadphase stays small over a long match.
  ensureColliders(s) {
    if (s.refined) return;
    s.refined = true;
    if (s.intactCollider) {
      for (const c of [].concat(s.intactCollider)) G.physics.removeCollider(c);
      s.intactCollider = null;
    }
    this._revealSlabs(s);
    s.fine = new Uint8Array(s.ny);
    s.levelBoxes = new Array(s.ny).fill(null);
    s.dirtyLevels = new Set();
    if (s.kind !== 'building') { for (let y = 0; y < s.ny; y++) this._fineLevel(s, y); return; }
    // each storey's shape: the setback rectangles clipped to the storey, else the storey's own bounds
    const lo = new Float32Array(s.ny * 3).fill(Infinity), hi = new Float32Array(s.ny * 3).fill(-Infinity);
    for (const id of s.chunkIds) {
      const d = this.defs[id];
      if (!d.alive) continue;
      const y = d.level;
      for (let k = 0; k < 3; k++) {
        const c = k === 0 ? d.c.x : k === 1 ? d.c.y : d.c.z, h = (k === 0 ? d.size.x : k === 1 ? d.size.y : d.size.z) / 2;
        lo[y * 3 + k] = Math.min(lo[y * 3 + k], c - h); hi[y * 3 + k] = Math.max(hi[y * 3 + k], c + h);
      }
    }
    for (let y = 0; y < s.ny; y++) {
      if (lo[y * 3] === Infinity) continue;
      const y0 = lo[y * 3 + 1], y1 = hi[y * 3 + 1];
      const boxes = [];
      if (s.intactBoxes) {
        for (const [x0, b0, z0, x1, b1, z1] of s.intactBoxes) {
          const a = Math.max(y0, b0), b = Math.min(y1, b1);
          if (b - a > 0.05) boxes.push([x0, a, z0, x1, b, z1]);
        }
      }
      if (!boxes.length) boxes.push([lo[y * 3], y0, lo[y * 3 + 2], hi[y * 3], y1, hi[y * 3 + 2]]);
      s.levelBoxes[y] = boxes.map(([x0, b0, z0, x1, b1, z1]) => G.physics.fixedBox((x0 + x1) / 2, (b0 + b1) / 2, (z0 + z1) / 2, (x1 - x0) / 2, (b1 - b0) / 2, (z1 - z0) / 2));
    }
  }

  // one collider per alive chunk of this storey, replacing its box
  _fineLevel(s, y) {
    if (y < 0 || y >= s.ny || s.fine[y]) return;
    s.fine[y] = 1;
    if (s.levelBoxes[y]) { for (const c of s.levelBoxes[y]) G.physics.removeCollider(c); s.levelBoxes[y] = null; }
    for (const id of s.chunkIds) {
      const d = this.defs[id];
      if (!d.alive || d.level !== y) continue;
      const c = G.physics.fixedBox(d.c.x, d.c.y, d.c.z, d.size.x / 2, d.size.y / 2, d.size.z / 2);
      this.colliders[id] = c;
      this.colliderChunk.set(c.handle, id);
    }
  }

  // storeys that lost chunks this batch get their per-chunk colliders (after the batch, so the
  // chunks that just broke never get one)
  _flushLevels() {
    for (const s of this.dirtyStructs) {
      for (const y of s.dirtyLevels) this._fineLevel(s, y);
      s.dirtyLevels.clear();
    }
    this.dirtyStructs.clear();
  }

  // the interior floor slabs were left out of the draw while the facade was intact
  _revealSlabs(s) {
    if (s.kind !== 'building') return;
    for (const id of s.chunkIds) {
      const d = this.defs[id];
      if (d.kind === KIND.SLAB && d.alive) this.showChunk(id, true);
    }
  }

  // ---------- breaking ----------
  _hide(id) {
    const d = this.defs[id];
    d.alive = false;
    const s = this.structs[d.s];
    s.aliveCount--;
    if (d.kind === KIND.WALL || d.kind === KIND.CORNER) s.levelAlive[d.level]--;
    this.showChunk(id, false);
    const c = this.colliders[id];
    if (c) { this.colliderChunk.delete(c.handle); G.physics.removeCollider(c); this.colliders[id] = null; }
    if (s.dirtyLevels) { s.dirtyLevels.add(d.level); this.dirtyStructs.add(s); }
    s.dirty = true;
    this.pendingIntegrity.add(s);
    G.stats.chunksDestroyed++;
  }

  // v: damage 0..1. With an impact (world point + radius), the chunk keeps whichever impact
  // reaches it hardest, `f` being that impact's falloff at the chunk (1 at the centre).
  _setDamage(id, v, hitPos = null, R = 0, f = 0) {
    const d = this.defs[id];
    const a = this.structs[d.s].attrs;
    if (hitPos && (!d.hit || f >= d.hitF)) {
      d.hit = [hitPos.x - d.c.x, hitPos.y - d.c.y, hitPos.z - d.c.z, R];
      d.hitF = f;
      a.hit.array.set(d.hit, d.li * 4);
      this._markRange(a.hit, d.li * 4, 4);
    }
    if (v <= d.dmg) return;
    d.dmg = v;
    this.setStyleW(id, v);
  }

  _protoOf(d) {
    return {
      pos: d.c.clone(), quat: _q0.clone(), size: d.size.clone(), cell: (d.cell || d.size).clone(), parent: d.size.clone(),
      offset: new THREE.Vector3(), color: d.color, style: [d.style[0], d.style[1], d.style[2], d.dmg], seed: d.seed,
      hit: d.hit ? d.hit.slice() : null,
    };
  }

  // mode: 'pulverize' | 'fracture' | 'detach'
  breakChunk(id, mode, velFn, opts = {}) {
    const d = this.defs[id];
    if (!d.alive) return;
    const s = this.structs[d.s];
    this.ensureColliders(s);
    this._hide(id);
    const deb = G.debris;
    const proto = this._protoOf(d);
    // whatever broke it smashed its glass too; debris keeps the impact so the soot carries over
    proto.style[3] = Math.max(d.dmg, rand(0.55, 0.85));
    if (opts.hit) proto.hit = [opts.hit.pos.x - d.c.x, opts.hit.pos.y - d.c.y, opts.hit.pos.z - d.c.z, opts.hit.R];
    const vol = d.size.x * d.size.y * d.size.z;
    if (mode === 'fracture' && d.kind === KIND.SLAB) mode = 'detach'; // thin plates make slivers that tunnel
    if (mode === 'fracture' && deb.freeBudget < 10) mode = vol > 6 && deb.freeBudget > 2 ? 'detach' : 'pulverize';
    if (mode === 'detach' && deb.freeBudget < 2) mode = 'pulverize';
    if (mode === 'detach') {
      velFn(d.c, _v);
      deb.spawnBox({ ...proto, vel: _v.clone(), angvel: randomUnit(new THREE.Vector3()).multiplyScalar(rand(0.5, 3)), breakable: true, crusher: opts.crusher });
    } else if (mode === 'fracture') {
      deb.spawnPieces(proto, velFn);
    }
    if (mode === 'pulverize' || mode === 'fracture') {
      velFn(d.c, _v);
      G.fx.pebbleBurst(d.c, Math.min(16, 3 + vol * 0.9), _v, d.color, d.size.length() * 0.4);
    }
    if (opts.dust !== false) G.fx.dustPuff(d.c, Math.min(1.6, d.size.length() * 0.3), 1, 'dust', _v.clone().multiplyScalar(0.15), rand(1.4, 2.8));
    if (d.hasWindow && !d.blown) G.fx.glassBurst(d.c, d.size, 8, _v);
  }

  // Main entry point for anything hitting buildings.
  // o: { pos, radius, power (0..2), vel: impactor velocity, dir, shatter (radius), maxChunks }
  impact(o) {
    const res = { count: 0, pulverized: 0, volume: 0 };
    const pos = o.pos;
    const radius = o.radius;
    const shatterR = o.shatter ?? radius * 2.2;
    const vel = o.vel || _v2.set(0, 0, 0);
    const power = o.power ?? 1;
    const list = [];
    this.forChunksInSphere(pos, shatterR, (id, dist) => list.push([id, dist]));
    if (!list.length) return res;
    list.sort((a, b) => a[1] - b[1]);
    const maxChunks = o.maxChunks ?? 60;
    const dirN = o.dir ? o.dir.clone().normalize() : new THREE.Vector3();
    let fractures = 0;
    const maxFractures = o.maxFractures ?? 3;
    const hit = { pos: pos.clone(), R: shatterR };
    // how hard the shock is at the facade; the shader fades it with distance from `pos`
    const intensity = clamp(0.5 + 0.25 * power, 0.5, 0.9);
    for (const [id, dist] of list) {
      const d = this.defs[id];
      if (dist < radius && res.count < maxChunks) {
        const t = dist / radius;
        let mode = t < 0.3 * power ? 'pulverize' : t < 0.7 ? 'fracture' : 'detach';
        if (mode === 'fracture' && fractures++ >= maxFractures) mode = Math.random() < 0.5 ? 'detach' : 'pulverize';
        const k = 1 - t;
        const velFn = (wp, out) => {
          out.copy(wp).sub(pos);
          const l = out.length() || 1;
          out.divideScalar(l).multiplyScalar((8 + 26 * power) * k * rand(0.5, 1.1));
          out.addScaledVector(vel, rand(0.35, 0.75) * Math.min(1, power + 0.3));
          out.addScaledVector(dirN, 20 * power * k);
          out.y += rand(1, 6) * power;
          return out;
        };
        this.breakChunk(id, mode, velFn, { dust: res.count < 6 || Math.random() < 0.15, hit });
        res.count++;
        res.volume += d.size.x * d.size.y * d.size.z;
        if (mode === 'pulverize') res.pulverized++;
      } else if (d.alive) {
        // falloff at the chunk's nearest point, the same curve the shader uses (localDmg)
        const f = 1 - smoothstep(0.3, 1, dist / shatterR);
        this._setDamage(id, Math.min(1, Math.max(d.dmg, intensity) + 0.06), pos, shatterR, f);
        if (d.hasWindow && !d.blown && intensity * f > 0.45) {
          d.blown = true;
          G.fx.glassBurst(d.c, d.size, 5, vel, pos);
          res.glass = (res.glass || 0) + 1;
        }
      }
    }
    if (res.count > 0) {
      G.audio && G.audio.crumble(clamp(res.volume / 120, 0.2, 1), pos);
    }
    if (res.glass) G.audio && G.audio.glass(clamp(res.glass / 10, 0.2, 1), pos);
    this._flushLevels();
    return res;
  }

  // Called by debris contact events: heavy falling slabs crush what they land on.
  crushChunk(id, rec) {
    if (this.crushBudget <= 0) return;
    const d = this.defs[id];
    if (!d || !d.alive) return;
    this.crushBudget--;
    const lv = rec.body.linvel();
    const base = new THREE.Vector3(lv.x * 0.6, lv.y * 0.3, lv.z * 0.6);
    const mode = G.debris.freeBudget > 60 && Math.random() < 0.5 ? 'detach' : 'pulverize';
    this.breakChunk(id, mode, (wp, out) => out.copy(base).add(randomUnit(_v2).multiplyScalar(rand(2, 7))), { crusher: true });
    this._flushLevels();
    if (Math.random() < 0.35) G.fx.dustRing(d.c, d.size.x * 1.5, 6);
  }

  // One storey gives way under the falling mass: mostly dust and rubble, some chunks kicked out.
  _crushLevel(s, level, origin) {
    const deb = G.debris;
    const y = s.origin.y + (level + 0.5) * s.sy;
    const c = new THREE.Vector3((s.min.x + s.max.x) / 2, y, (s.min.z + s.max.z) / 2);
    let n = 0;
    const wins = [];
    for (const id of s.chunkIds) {
      const d = this.defs[id];
      if (!d.alive || d.level !== level) continue;
      if (d.hasWindow) wins.push(d);
      const out = _v2.copy(d.c).sub(c).setY(0).normalize();
      const k = rand(4, 12);
      const vel = new THREE.Vector3(out.x * k, rand(-6, -1), out.z * k);
      const mode = d.kind === KIND.SLAB ? 'pulverize' : (n % 4 === 0 && deb.freeBudget > 30 ? 'detach' : 'pulverize');
      this.breakChunk(id, mode, (wp, o) => o.copy(vel).add(randomUnit(_v).multiplyScalar(2)), { dust: n % 3 === 0 });
      n++;
    }
    this._flushLevels();
    if (!n) return;
    const w = Math.max(s.max.x - s.min.x, s.max.z - s.min.z);
    G.fx.dustRing(c, w * 0.7, 8, 'dust', 0.7);
    G.fx.dustPuff(c, Math.min(4, w * 0.1), 3, 'dust', new THREE.Vector3(0, -2, 0));
    // squibs: the floor gives way and the air in it blasts out of the windows
    for (let k = Math.round(10 * G.fx.q); k > 0 && wins.length; k--) {
      const d = wins.splice(Math.floor(Math.random() * wins.length), 1)[0];
      G.fx.squib(d.c, _v2.copy(d.c).sub(c).setY(0).normalize(), Math.min(3, d.size.y * 0.5));
    }
    G.audio && G.audio.crumble(1, c);
    G.fightCam && G.fightCam.addTraumaAt(c, 0.12, 300);
  }

  // ---------- integrity ----------
  _checkIntegrity(s) {
    if (s.collapsing || s.aliveCount === 0) return;
    // 1) level ratio: a storey that lost most of its walls cannot hold what's above it
    let fail = -1;
    for (let y = s.anchorLevel; y < (s.noRatio ? 0 : s.ny); y++) {
      if (s.levelTotal[y] > 3 && s.levelAlive[y] / s.levelTotal[y] < s.ratioThreshold) { fail = y; break; }
    }
    const falling = [];
    if (fail >= 0 && fail < s.ny - 1) {
      for (const id of s.chunkIds) {
        const d = this.defs[id];
        if (d.alive && d.level >= fail) falling.push(id);
      }
      if (falling.length) {
        this._scheduleCollapse(s, falling, fail);
        return;
      }
    }
    // 2) connectivity to the ground (catches hanging pieces, severed corners, cut track spans)
    const reach = new Uint8Array(s.cells.length);
    const stack = [];
    for (let z = 0; z < s.nz; z++) for (let x = 0; x < s.nx; x++) {
      const c = s.ci(x, s.anchorLevel, z);
      const id = s.cells[c];
      if (id >= 0 && this.defs[id].alive && (!s.groundAnchors || s.groundAnchors(x, z))) { reach[c] = 1; stack.push(c); }
    }
    const nx = s.nx, nz = s.nz, plane = nx * nz, cells = s.cells, defs = this.defs;
    const visit = (n) => {
      if (reach[n]) return;
      const id = cells[n];
      if (id < 0 || !defs[id].alive) return;
      reach[n] = 1;
      stack.push(n);
    };
    while (stack.length) {
      const c = stack.pop();
      const x = c % nx, z = ((c / nx) | 0) % nz, y = (c / plane) | 0;
      if (x > 0) visit(c - 1);
      if (x < nx - 1) visit(c + 1);
      if (z > 0) visit(c - nx);
      if (z < nz - 1) visit(c + nx);
      if (y > 0) visit(c - plane);
      if (y < s.ny - 1) visit(c + plane);
    }
    for (const id of s.chunkIds) {
      const d = this.defs[id];
      if (!d.alive) continue;
      let ok = false;
      for (const c of d.cells) if (reach[c]) { ok = true; break; }
      if (!ok) falling.push(id);
    }
    if (falling.length) this._scheduleCollapse(s, falling, -1);
  }

  _scheduleCollapse(s, ids, failLevel) {
    const big = ids.length > 40;
    if (big) s.collapsing = true;
    // failure origin: centroid of the missing walls at the failing level, else lowest falling chunk
    const origin = new THREE.Vector3();
    let n = 0;
    if (failLevel >= 0) {
      for (const id of s.chunkIds) {
        const d = this.defs[id];
        if (!d.alive && d.level === failLevel && (d.kind === KIND.WALL || d.kind === KIND.CORNER)) { origin.add(d.c); n++; }
      }
    }
    if (!n) { for (const id of ids) origin.add(this.defs[id].c); n = ids.length; }
    origin.divideScalar(n);
    const center = _v.copy(s.min).add(s.max).multiplyScalar(0.5);
    const lean = new THREE.Vector3(origin.x - center.x, 0, origin.z - center.z);
    if (lean.lengthSq() < 1) lean.set(rand(-1, 1), 0, rand(-1, 1));
    lean.normalize();
    const pivotY = failLevel >= 0 ? s.origin.y + failLevel * s.sy : origin.y;
    const pivot = new THREE.Vector3(center.x + lean.x * (s.max.x - s.min.x) * 0.5, pivotY, center.z + lean.z * (s.max.z - s.min.z) * 0.5);
    const axis = new THREE.Vector3(lean.z, 0, -lean.x); // rotating about this tips the top toward `lean`
    const rate = big ? rand(0.18, 0.32) : rand(0.05, 0.2);

    const groups = this._mergeGroups(s, ids);
    const items = groups.map((g) => {
      const c = g.center;
      return { g, t: Math.min(0.7, c.distanceTo(origin) / rand(18, 30)) };
    });
    items.sort((a, b) => a.t - b.t);
    // Pancaking: if the falling mass is big compared with what's left underneath, the storeys
    // below get crushed one after another at roughly free-fall pace.
    let pancake = null;
    if (failLevel > s.anchorLevel - 1 && big) {
      let below = 0;
      for (const id of s.chunkIds) if (this.defs[id].alive && this.defs[id].level < failLevel) below++;
      const ratio = ids.length / Math.max(1, below);
      const levels = ratio > 0.6 ? failLevel : Math.max(1, Math.round(ratio * 4));
      // always leave a stump of a storey or few: a ruin reads better than an empty lot
      const keep = Math.min(failLevel, clamp(Math.round(failLevel * rand(0.2, 0.45)), 1, 4));
      pancake = { level: failLevel - 1, stop: Math.max(s.anchorLevel - 1, failLevel - 1 - levels, keep - 1), next: 0.28, step: 0.3 };
    }
    const col = {
      s, items, i: 0, time: 0, windup: big ? rand(0.45, 0.75) : 0.05, axis, rate, pivot, origin, lean,
      big, released: false, dustT: 0, pancake, glass: big ? 300 : 40,
      stumpTop: pancake ? pancake.stop : failLevel - 1, jagged: !big || s.kind !== 'building',
    };
    this.collapses.push(col);
    if (big) {
      G.audio && G.audio.creak(origin);
      G.stats.buildingsCollapsed++;
      G.game && G.game.onCollapse && G.game.onCollapse(s, origin);
    }
  }

  // Merge falling chunks into a few big exact boxes: whole floor plates, facade strips of up
  // to 6 panels x 2 storeys, corner columns 4 storeys tall. Heavy slabs read as *heavy*,
  // and they crumble progressively (binary splits) when they land.
  _mergeGroups(s, ids) {
    const set = new Set(ids);
    const used = new Set();
    const groups = [];
    const D = this.defs;
    const cellOf = (id) => {
      const c = D[id].cells[0];
      return [c % s.nx, Math.floor(c / s.nx) % s.nz, Math.floor(c / (s.nx * s.nz))];
    };
    const at = (x, y, z) => (x < 0 || z < 0 || y < 0 || x >= s.nx || z >= s.nz || y >= s.ny) ? -1 : s.cells[s.ci(x, y, z)];
    // first cell past a chunk's far end along x or z (walls on real maps can span several cells)
    const after = (m, alongX) => {
      const md = D[m], [x, z, y] = cellOf(m);
      const arr = alongX ? s.xs : s.zs;
      const v = alongX ? md.c.x + md.size.x / 2 - s.origin.x + 0.01 : md.c.z + md.size.z / 2 - s.origin.z + 0.01;
      if (v >= arr[arr.length - 1]) return -1;
      return alongX ? at(cellIndex(arr, v), y, z) : at(x, y, cellIndex(arr, v));
    };
    const free = (a, b) => b >= 0 && b !== a && set.has(b) && !used.has(b) && D[b].kind === D[a].kind && D[b].alive;
    const push = (members, cells, proto) => {
      const min = new THREE.Vector3(Infinity, Infinity, Infinity), max = min.clone().negate();
      let vol = 0;
      for (const m of members) {
        const md = D[m];
        min.min(_v.copy(md.size).multiplyScalar(-0.5).add(md.c));
        max.max(_v.copy(md.size).multiplyScalar(0.5).add(md.c));
        vol += md.size.x * md.size.y * md.size.z;
      }
      const size = max.clone().sub(min);
      if (members.length > 1 && Math.abs(size.x * size.y * size.z - vol) > vol * 0.02) {
        // not an exact box -> release individually
        for (const m of members) push([m], [1, 1, 1], D[m]);
        return;
      }
      groups.push({ members, center: min.add(max).multiplyScalar(0.5), size, cells, proto });
    };
    // slabs: one plate per storey when the floor is intact, otherwise per tile
    const slabsByLevel = new Map();
    for (const id of ids) if (D[id].kind === KIND.SLAB) {
      if (!slabsByLevel.has(D[id].level)) slabsByLevel.set(D[id].level, []);
      slabsByLevel.get(D[id].level).push(id);
    }
    for (const list of slabsByLevel.values()) {
      for (const id of list) used.add(id);
      const xs = new Set(list.map((id) => D[id].c.x.toFixed(2))), zs = new Set(list.map((id) => D[id].c.z.toFixed(2)));
      const before = groups.length;
      push(list, [xs.size, 1, zs.size], D[list[0]]);
      if (groups.length > before + 1) { /* fell back to singles */ }
    }
    const sorted = ids.filter((id) => !used.has(id)).sort((a, b) => D[a].level - D[b].level);
    for (const id of sorted) {
      if (used.has(id)) continue;
      const d = D[id];
      used.add(id);
      const [x, z, y] = cellOf(id);
      if (d.kind === KIND.WALL) {
        const alongX = d.size.x >= d.size.z;
        const row = [id];
        for (let k = 1; k < 6; k++) {
          const n = after(row[row.length - 1], alongX);
          if (!free(id, n) || !sameAlong(d, D[n])) break;
          row.push(n);
        }
        row.forEach((m) => used.add(m));
        const members = row.slice();
        let vert = 1;
        // add the storey above if every panel above is falling too
        const above = row.map((m) => { const [mx, mz, my] = cellOf(m); return at(mx, my + 1, mz); });
        if (above.every((m, i) => free(id, m) && sameFoot(D[row[i]], D[m]))) {
          above.forEach((m) => { used.add(m); members.push(m); });
          vert = 2;
        }
        push(members, alongX ? [row.length, vert, 1] : [1, vert, row.length], d);
      } else if (d.kind === KIND.CORNER) {
        const members = [id];
        for (let k = 1; k < 4; k++) {
          const n = at(x, y + k, z);
          if (!free(id, n) || !sameFoot(d, D[n])) break;
          members.push(n); used.add(n);
        }
        push(members, [1, members.length, 1], d);
      } else {
        push([id], [1, 1, 1], d);
      }
    }
    return groups;
  }

  // debris bodies _releaseGroup will spawn for g: one for an intact group, one per survivor otherwise
  _groupBodies(g) {
    let live = 0;
    for (const m of g.members) if (this.defs[m].alive) live++;
    return live === g.members.length ? 1 : live;
  }

  _releaseGroup(col, g) {
    const deb = G.debris;
    const live = g.members.filter((m) => this.defs[m].alive);
    if (!live.length) return;
    this.ensureColliders(col.s);
    for (const m of live) this._hide(m);
    const d = g.proto;
    // rigid-rotation velocity field: v = w x (p - pivot) -> the section tips over as a whole
    const w = col.axis.clone().multiplyScalar(col.rate);
    const r = g.center.clone().sub(col.pivot);
    const vel = new THREE.Vector3().crossVectors(w, r);
    vel.y -= rand(0.5, 2.5);
    vel.x += rand(-0.4, 0.4); vel.z += rand(-0.4, 0.4);
    // the frame twists as it goes: most of the glass pops (a falling facade shows a mix of
    // blown and cracked panes), and the panes rain off it
    const wreck = (dmg) => Math.max(dmg, rand(0.35, 0.75));
    if (d.style[0] > 0 && d.style[2] < 3.5 && col.glass > 0) {
      const n = Math.min(col.glass, Math.ceil(Math.max(g.size.x, g.size.z) * g.size.y / 10));
      col.glass -= n;
      G.fx.glassBurst(g.center, g.size, n, vel);
    }
    if (live.length !== g.members.length) {
      // group partially destroyed already: release survivors individually
      for (const m of live) {
        const md = this.defs[m];
        const p = this._protoOf(md);
        p.style[3] = wreck(md.dmg);
        p.hit = null; // wrecked all over, not around one impact
        if (!deb.spawnBox({ ...p, vel, angvel: w.clone(), breakable: true, crusher: true, priority: true })) G.fx.pebbleBurst(md.c, 8, vel, md.color);
      }
      return;
    }
    const proto = {
      pos: g.center.clone(), quat: _q0.clone(), size: g.size.clone(), cell: (d.cell || d.size).clone(), parent: g.size.clone(),
      offset: new THREE.Vector3(), color: d.color, style: [d.style[0], d.style[1], d.style[2], wreck(d.dmg)], seed: d.seed,
    };
    const rec = deb.spawnBox({ ...proto, vel, angvel: w.clone(), breakable: true, crusher: true, cells: g.cells, priority: true });
    if (!rec) G.fx.pebbleBurst(g.center, 10, vel, d.color);
  }

  update(dt) {
    this.time += dt;
    this.crushBudget = 10;
    this._flushLevels();
    // integrity is a flood fill over the whole building (6 ms on a tower): a structure gets one
    // at most every INTEGRITY_EVERY seconds, a few structures per frame
    let checked = 0;
    for (const s of this.pendingIntegrity) {
      if (checked >= INTEGRITY_PER_FRAME) break;
      if (this.time - s.integrityT < INTEGRITY_EVERY) continue;
      s.integrityT = this.time;
      this.pendingIntegrity.delete(s);
      this._checkIntegrity(s);
      checked++;
    }

    for (let k = this.collapses.length - 1; k >= 0; k--) {
      const col = this.collapses[k];
      col.time += dt;
      if (col.time < col.windup) {
        // wind-up: creaking, dust trickling out of the failing storey, a few bits shedding
        col.dustT -= dt;
        if (col.dustT <= 0 && col.big) {
          col.dustT = 0.06;
          _v.copy(col.origin).add(randomUnit(_v2).multiplyScalar(rand(2, 8)));
          G.fx.dustPuff(_v, rand(1.5, 3), 1, 'dust', new THREE.Vector3(0, -2, 0));
          if (Math.random() < 0.3) G.fx.pebbleBurst(_v, 4, new THREE.Vector3(0, -3, 0), col.items[0].g.proto.color);
          G.fightCam && G.fightCam.addTraumaAt(col.origin, 0.04, 260);
        }
        continue;
      }
      if (!col.released) {
        col.released = true;
        if (col.big) {
          G.audio && G.audio.collapse(col.origin);
          G.fightCam && G.fightCam.addTraumaAt(col.origin, 0.35, 350);
          const w = Math.max(col.s.max.x - col.s.min.x, col.s.max.z - col.s.min.z);
          G.fx.dustRing(new THREE.Vector3(col.origin.x, col.s.origin.y + 1, col.origin.z), Math.max(16, w * 0.6), 12, 'cloud');
          if (col.s.kind === 'building') this._startFall(col);
        }
      }
      const tt = col.time - col.windup;
      const pk = col.pancake;
      if (pk && pk.level > pk.stop && tt > pk.next) {
        this._crushLevel(col.s, pk.level, col.origin);
        pk.level--;
        pk.step = Math.max(0.16, pk.step * 0.86);
        pk.next += pk.step;
      }
      if (!col.jagged && (!pk || pk.level <= pk.stop)) {
        col.jagged = true;
        this._jagStump(col.s, col.stumpTop);
      }
      // make room for this frame's releases in one go (not once per spawn); a group whose
      // spawn still finds no room turns into pebbles as before
      let bodies = 0;
      for (let k = col.i; k < col.items.length && k < col.i + 70 && col.items[k].t <= tt; k++) bodies += this._groupBodies(col.items[k].g);
      if (bodies) G.debris.reserve(bodies, true);
      let released = 0;
      while (col.i < col.items.length && col.items[col.i].t <= tt && released < 70) {
        this._releaseGroup(col, col.items[col.i].g);
        col.i++; released++;
      }
      this._flushLevels();
      if (col.i >= col.items.length && (!pk || pk.level <= pk.stop)) {
        this.collapses.splice(k, 1);
        col.s.collapsing = false;
        if (col.s.aliveCount > 0) this.pendingIntegrity.add(col.s);
      }
    }

    for (let k = this.falls.length - 1; k >= 0; k--) {
      const f = this.falls[k];
      f.t += dt;
      // dust boils off the whole height the mass still spans (its top is in free fall)
      if (f.t < f.topAt + 0.3 && (f.plumeT -= dt) <= 0) {
        f.plumeT = 0.12;
        G.fx.collapsePlume(f.c, f.hw, f.hd, Math.max(f.c.y + 6, f.top - 4.9 * f.t * f.t), 2);
      }
      // while it pours down, the base keeps pushing dust out into the streets
      if (f.t >= f.hitAt && f.t < f.topAt && (f.pulseT -= dt) <= 0) {
        f.pulseT = 0.7;
        G.fx.collapseSurge(f.c, f.hw, f.hd, f.k, 0.3);
        G.fightCam && G.fightCam.addTraumaAt(f.c, 0.08, 400);
      }
      // the rubble piles up in three goes as the mass comes down; the last one is the big surge
      while (f.step < 3 && f.t >= [f.hitAt, (f.hitAt + f.topAt) / 2, f.topAt][f.step]) {
        const m = f.mound;
        G.ground.mound(m.x, m.z, m.rx, m.rz, m.h * [0.4, 0.3, 0.3][f.step]);
        if (++f.step === 3) {
          G.fx.collapseSurge(f.c, f.hw, f.hd, f.k, 1);
          G.fightCam && G.fightCam.addTraumaAt(f.c, 0.2 + f.k * 0.1, 450);
          G.audio && G.audio.crumble(1, f.c);
        }
      }
      if (f.step === 3 && f.t > f.topAt + 0.3) this.falls.splice(k, 1);
    }
  }

  // A big collapse has let go: time its dust and rubble to the fall. The falling section's
  // bottom meets the stump at `hitAt`, its top lands at `topAt` (free fall, real gravity).
  _startFall(col) {
    const s = col.s;
    const w = s.max.x - s.min.x, d = s.max.z - s.min.z;
    const stumpTop = s.origin.y + (col.stumpTop + 1) * s.sy;
    const fallH = Math.max(4, s.max.y - col.pivot.y);
    const shift = Math.min(w, d) * 0.15; // the pile leans the way the building went
    this.falls.push({
      c: new THREE.Vector3((s.min.x + s.max.x) / 2, s.origin.y, (s.min.z + s.max.z) / 2),
      hw: w / 2, hd: d / 2, top: s.max.y, t: 0, plumeT: 0, pulseT: 0, step: 0,
      hitAt: Math.sqrt(2 * Math.max(2, col.pivot.y - stumpTop) / 9.81),
      topAt: Math.sqrt(2 * Math.max(4, s.max.y - stumpTop) / 9.81),
      k: clamp(fallH / 70, 0.3, 3),
      mound: {
        x: (s.min.x + s.max.x) / 2 + col.lean.x * shift, z: (s.min.z + s.max.z) / 2 + col.lean.z * shift,
        rx: w / 2 + 3 + fallH * 0.05, rz: d / 2 + 3 + fallH * 0.05, h: clamp(1.2 + fallH * 0.045, 1.2, 8),
      },
    });
  }

  // The stump left standing: knock a ragged edge into its top storeys and scorch it from above.
  _jagStump(s, top) {
    if (top < 0) return;
    for (const id of s.chunkIds) {
      const d = this.defs[id];
      if (!d.alive || d.level < top - 1 || d.level > top) continue;
      const slab = d.kind === KIND.SLAB;
      const p = d.level === top ? (slab ? 0.5 : 0.36) : (slab ? 0 : 0.12);
      if (Math.random() < p) {
        this.breakChunk(id, 'pulverize', (wp, out) => out.set(rand(-2, 2), rand(0, 3), rand(-2, 2)), { dust: Math.random() < 0.3 });
      } else {
        _v.set(d.c.x, s.origin.y + (top + 1.2) * s.sy, d.c.z);
        this._setDamage(id, rand(0.7, 0.95), _v, s.sy * 2.5, 1);
      }
    }
    this._flushLevels();
  }
}

function sameAlong(a, b) {
  return Math.abs(a.size.y - b.size.y) < 0.01 && Math.abs(a.size.x - b.size.x) < 0.01 && Math.abs(a.size.z - b.size.z) < 0.01 && Math.abs(a.c.y - b.c.y) < 0.01;
}
function sameFoot(a, b) {
  return Math.abs(a.size.x - b.size.x) < 0.01 && Math.abs(a.size.z - b.size.z) < 0.01 && Math.abs(a.c.x - b.c.x) < 0.01 && Math.abs(a.c.z - b.c.z) < 0.01;
}
// index i of the cell [arr[i], arr[i+1]) containing v (clamped to the grid)
function cellIndex(arr, v) {
  let a = 0, b = arr.length - 2;
  while (a < b) {
    const m = (a + b + 1) >> 1;
    if (arr[m] <= v) a = m; else b = m - 1;
  }
  return a;
}
function boxDist(p, c, size) {
  const dx = Math.max(Math.abs(p.x - c.x) - size.x / 2, 0);
  const dy = Math.max(Math.abs(p.y - c.y) - size.y / 2, 0);
  const dz = Math.max(Math.abs(p.z - c.z) - size.z / 2, 0);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export { KIND, STYLE };
