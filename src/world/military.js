// The military shows up: attack helicopters circling the monster and tanks in the streets, firing
// at it for all the good it does. They are there to be swatted: a fist, a tail, a beam, a quake,
// a body flying past or a foot coming down takes them out, a downed helicopter spins into
// whatever is below it, and a little later the next one flies in.
//
// Nothing here is a physics body. Units are instances moved by hand; the fighters and the effects
// report what they sweep through (hitSphere / hitRay / blast).
import * as THREE from 'three';
import { G } from '../core/context.js';
import { gradientMap } from '../render/toon.js';
import { mergeGeoms } from '../render/renderer.js';
import { ARENA } from './city.js';
import { clamp, damp, rand, chance, pick, UP } from '../core/math.js';

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3(1, 1, 1);
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _u = new THREE.Vector3();
const _c = new THREE.Color();
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
const TRACER = new THREE.Color(1, 0.86, 0.45);
const DARK = new THREE.Color(0.2, 0.2, 0.2);
const WHITE = new THREE.Color(1, 1, 1);

// what a unit's fire does to a kaiju: next to nothing (it never finishes one off)
const DMG = { tracer: 0.012, rocket: 0.06, shell: 0.05 }; // ~7 health over a whole round
const COUNT = { high: [4, 6], medium: [4, 5], low: [3, 4] }; // helicopters, tanks
const SEARCHLIGHT = new Set(['night', 'storm', 'dusk']);

function box(w, h, d, x, y, z, r, g, b, rot = null) {
  let geo = new THREE.BoxGeometry(w, h, d);
  if (rot) geo.rotateX(rot[0]).rotateY(rot[1]).rotateZ(rot[2]);
  geo.translate(x, y, z);
  geo = geo.toNonIndexed();
  const n = geo.attributes.position.count, c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { c[i * 3] = r; c[i * 3 + 1] = g; c[i * 3 + 2] = b; }
  geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return geo;
}

// An attack helicopter, nose along +Z, about 17 m long (rotor separate: it spins).
function heliGeometry() {
  const O = [0.33, 0.39, 0.24], D = [0.2, 0.24, 0.16], K = [0.1, 0.11, 0.13], GL = [0.2, 0.42, 0.55];
  return mergeGeoms([
    box(3.0, 3.0, 8.5, 0, 0, 0.5, ...O),               // fuselage
    box(2.4, 2.2, 3.2, 0, -0.5, 5.6, ...O),            // nose
    box(2.2, 1.5, 3.4, 0, 1.3, 3.2, ...GL),            // canopy
    box(0.9, 1.1, 8.5, 0, 0.6, -7.6, ...D),            // tail boom
    box(0.4, 3.4, 1.6, 0, 2.0, -11.2, ...D),           // fin
    box(3.6, 0.3, 1.2, 0, 1.0, -10.6, ...D),           // tailplane
    box(7.4, 0.4, 1.8, 0, -0.5, 0.6, ...D),            // stub wings
    box(0.8, 0.8, 3.2, 3.3, -1.0, 0.8, ...K),          // rocket pods
    box(0.8, 0.8, 3.2, -3.3, -1.0, 0.8, ...K),
    box(1.6, 1.3, 2.6, 0, 2.0, -0.2, ...D),            // engine housing
    box(0.5, 1.2, 0.5, 0, 3.0, 0, ...K),               // mast
    box(0.3, 0.3, 6.5, 1.4, -2.3, 0.6, ...K),          // skids
    box(0.3, 0.3, 6.5, -1.4, -2.3, 0.6, ...K),
    box(0.6, 0.6, 1.8, 0, -1.7, 7.4, ...K),            // chin gun
  ]);
}

function rotorGeometry() {
  const K = [0.12, 0.12, 0.14];
  return mergeGeoms([box(17, 0.16, 0.9, 0, 0, 0, ...K), box(0.9, 0.16, 17, 0, 0, 0, ...K)]);
}

// A tank, gun along +Z: hull and turret are separate instances (the turret tracks its target).
function hullGeometry() {
  const O = [0.36, 0.41, 0.27], K = [0.11, 0.12, 0.12], D = [0.24, 0.28, 0.19];
  return mergeGeoms([
    box(4.2, 1.5, 9.0, 0, 1.75, 0, ...O),
    box(4.0, 0.7, 2.4, 0, 1.2, 4.3, ...D, [0.5, 0, 0]),  // glacis
    box(1.3, 1.6, 9.4, 2.1, 0.8, 0, ...K),               // tracks
    box(1.3, 1.6, 9.4, -2.1, 0.8, 0, ...K),
    box(3.6, 0.5, 2.6, 0, 2.6, -3.0, ...D),              // engine deck
  ]);
}

function turretGeometry() {
  const O = [0.4, 0.45, 0.3], K = [0.13, 0.14, 0.14];
  const barrel = new THREE.CylinderGeometry(0.32, 0.32, 6.4, 8).rotateX(Math.PI / 2).translate(0, 0.9, 4.6).toNonIndexed();
  const n = barrel.attributes.position.count, c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) c.set(K, i * 3);
  barrel.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return mergeGeoms([box(3.3, 1.5, 4.2, 0, 0.75, -0.2, ...O), box(1.0, 0.5, 1.0, 0.8, 1.75, -0.8, ...K), barrel]);
}

function instanced(scene, geo, mat, n, shadow = true) {
  const m = new THREE.InstancedMesh(geo, mat, n);
  m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  m.frustumCulled = false;
  m.castShadow = shadow;
  m.receiveShadow = shadow;
  for (let i = 0; i < n; i++) { m.setMatrixAt(i, ZERO); m.setColorAt(i, WHITE); }
  scene.add(m);
  return m;
}

// street centrelines a tank can patrol: [ax, az, bx, bz] inside the arena, clear of the park
function tankRoads(layout) {
  const out = [], lim = ARENA - 22;
  const add = (ax, az, bx, bz) => {
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 40) return;
    out.push({ ax, az, bx, bz, len });
  };
  const clip = (v) => clamp(v, -lim, lim);
  if (layout.real) {
    for (const [, w, , , pts] of layout.map.roads) {
      if (w < 12) continue;
      for (let i = 0; i + 3 < pts.length; i += 2) {
        const ax = pts[i], az = pts[i + 1], bx = pts[i + 2], bz = pts[i + 3];
        if (Math.max(Math.abs(ax), Math.abs(az)) > lim || Math.max(Math.abs(bx), Math.abs(bz)) > lim) continue;
        add(ax, az, bx, bz);
      }
    }
  }
  if (!out.length) for (const s of layout.streets || []) add(clip(s.x0), clip(s.z0), clip(s.x1), clip(s.z1));
  return out;
}

export class Military {
  constructor(scene, layout, quality) {
    const [nh, nt] = COUNT[quality] || COUNT.medium;
    this.roads = tankRoads(layout);
    this.center = layout.parkCenter.clone();
    const mat = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: gradientMap(3) });
    this.heliMesh = instanced(scene, heliGeometry(), mat, nh);
    this.rotorMesh = instanced(scene, rotorGeometry(), mat, nh, false);
    this.hullMesh = instanced(scene, hullGeometry(), mat, this.roads.length ? nt : 0);
    this.turretMesh = instanced(scene, turretGeometry(), mat, this.roads.length ? nt : 0);
    // rockets and shells in flight: bright slugs (their smoke is the trail)
    this.shotMesh = instanced(scene, new THREE.BoxGeometry(0.7, 0.7, 3.4), new THREE.MeshBasicMaterial({ color: 0xffe2a0 }), 16, false);
    this.meshes = [this.heliMesh, this.rotorMesh, this.hullMesh, this.turretMesh, this.shotMesh];
    this.recorded = this.meshes.slice(0, 4); // what the match recap replays (not the slugs in flight)
    // searchlights after dark: a cone of light from each helicopter onto whatever it is hunting
    const cone = new THREE.ConeGeometry(1, 1, 20, 1, true).translate(0, -0.5, 0).rotateX(-Math.PI / 2); // apex at the origin, opening along +Z
    this.lightMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      uniforms: { uAlpha: { value: 0 } },
      vertexShader: /* glsl */`varying float vK; void main() { vK = position.z; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */`uniform float uAlpha; varying float vK; void main() { gl_FragColor = vec4(vec3(0.85, 0.93, 1.0) * uAlpha * (1.0 - vK * 0.75), 1.0); }`,
    });
    this.lightK = 0;
    this.helis = [];
    for (let i = 0; i < nh; i++) {
      const light = new THREE.Mesh(cone, this.lightMat);
      light.frustumCulled = false; light.renderOrder = 8; light.visible = false;
      scene.add(light);
      const h = { i, pos: new THREE.Vector3(), vel: new THREE.Vector3(), yaw: 0, roll: 0, pitch: 0, rotor: Math.random() * 6, state: 'gone', wait: 1.5 + i * 2.5, light };
      this.helis.push(h);
    }
    this.tanks = [];
    for (let i = 0; i < this.hullMesh.count; i++) {
      const t = { i, pos: new THREE.Vector3(), yaw: 0, tyaw: 0, state: 'gone', wait: 0, road: null, s: 0, dir: 1, fire: rand(2, 6), smoke: 0, flat: 1 };
      this.tanks.push(t);
      this._placeTank(t, true);
    }
    this.shots = [];
    this.hits = [];     // tracer rounds on their way: { t, f, x, y, z } (offsets from his chest)
    this.active = false;
    this.shown = true;
    this.target = null;
    this.t = 0;
    G.stats.military = 0;
  }

  // ------------------------------------------------------------------ the match recap
  // every instance matrix, in one array (the recorder samples it, the recap puts it back)
  snapshot() {
    const out = new Float32Array(this.recorded.reduce((n, m) => n + m.count * 16, 0));
    let o = 0;
    for (const m of this.recorded) { out.set(m.instanceMatrix.array.subarray(0, m.count * 16), o); o += m.count * 16; }
    return out;
  }

  // the units as they were between two snapshots (a alone: exactly as they were)
  pose(a, b = a, k = 0) {
    let o = 0;
    for (const m of this.recorded) {
      const M = m.instanceMatrix.array, n = m.count * 16;
      // (a rotor turns too far between samples to blend: it takes the earlier one)
      if (b === a || k <= 0 || m === this.rotorMesh || b.length !== a.length) M.set(a.subarray(o, o + n));
      else for (let i = 0; i < n; i++) M[i] = a[o + i] + (b[o + i] - a[o + i]) * k;
      m.instanceMatrix.needsUpdate = true;
      o += n;
    }
  }

  // ------------------------------------------------------------------ placing
  _roof(x, z, pad = 9) {
    let top = G.ground.heightAt(x, z);
    for (const s of G.destruction.structs) {
      if (s.aliveCount === 0 || x < s.min.x - pad || x > s.max.x + pad || z < s.min.z - pad || z > s.max.z + pad) continue;
      if (s.max.y > top) top = s.max.y;
    }
    return top;
  }

  _spawnHeli(h) {
    const a = rand(0, Math.PI * 2);
    h.pos.set(this.center.x + Math.cos(a) * 520, rand(150, 200), this.center.z + Math.sin(a) * 520);
    h.vel.set(-Math.cos(a) * 50, 0, -Math.sin(a) * 50);
    h.yaw = Math.atan2(h.vel.x, h.vel.z);
    h.roll = 0; h.pitch = 0;
    h.station = null; h.stay = 0;
    h.alt = rand(30, 54); // chest to just over the head of a 47 m kaiju
    h.fire = rand(2.5, 5); h.burst = 0; h.volley = 0;
    h.state = 'fly';
    this.heliMesh.setColorAt(h.i, WHITE); this.rotorMesh.setColorAt(h.i, WHITE);
    this.heliMesh.instanceColor.needsUpdate = true; this.rotorMesh.instanceColor.needsUpdate = true;
  }

  // Where to hover next: of a handful of spots 50-110 m from `c`, the one with the lowest roof
  // under it that isn't on top of another helicopter.
  _station(h, c) {
    let best = null, score = Infinity;
    for (let n = 0; n < 10; n++) {
      const a = rand(0, Math.PI * 2), r = rand(50, 110);
      const x = clamp(c.x + Math.cos(a) * r, -ARENA + 10, ARENA - 10), z = clamp(c.z + Math.sin(a) * r, -ARENA + 10, ARENA - 10);
      let k = Math.max(0, this._roof(x, z, 16) - G.ground.heightAt(x, z) - 30) + rand(0, 12);
      for (const o of this.helis) if (o !== h && o.station && Math.hypot(o.station.x - x, o.station.z - z) < 45) k += 60;
      if (k < score) { score = k; best = [x, z]; }
    }
    h.station = (h.station || new THREE.Vector3()).set(best[0], 0, best[1]);
    h.stay = rand(5, 9);
  }

  // a street well away from both kaiju (anywhere at boot)
  _placeTank(t, anywhere = false) {
    if (!this.roads.length) return false;
    for (let n = 0; n < 12; n++) {
      const r = pick(this.roads), s = rand(0.1, 0.9);
      const x = r.ax + (r.bx - r.ax) * s, z = r.az + (r.bz - r.az) * s;
      if (!anywhere && G.fighters.some((f) => Math.hypot(f.pos.x - x, f.pos.z - z) < 130)) continue;
      if (Math.hypot(x - this.center.x, z - this.center.z) < 70) continue;
      if (this.tanks.some((o) => o !== t && o.state !== 'gone' && Math.hypot(o.pos.x - x, o.pos.z - z) < 24)) continue;
      t.road = r; t.s = s; t.dir = chance(0.5) ? 1 : -1;
      t.pos.set(x, G.ground.heightAt(x, z), z);
      t.yaw = Math.atan2(r.bx - r.ax, r.bz - r.az) + (t.dir < 0 ? Math.PI : 0);
      t.tyaw = t.yaw;
      t.state = 'ok'; t.flat = 1; t.smoke = 0; t.fire = rand(2, 6);
      this.hullMesh.setColorAt(t.i, WHITE); this.turretMesh.setColorAt(t.i, WHITE);
      this.hullMesh.instanceColor.needsUpdate = true; this.turretMesh.instanceColor.needsUpdate = true;
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------------ what the fighters report
  // a fist, a tail, a body: anything inside the sphere is gone
  hitSphere(pos, r, by = null, vel = null) {
    if (!this.shown) return 0;
    let n = 0;
    for (const h of this.helis) {
      if (h.state === 'fly' && h.pos.distanceToSquared(pos) < (r + 7) * (r + 7)) { this._downHeli(h, by, vel); n++; }
    }
    for (const t of this.tanks) {
      if (t.state === 'ok' && _v.copy(t.pos).setY(t.pos.y + 2).distanceToSquared(pos) < (r + 4) * (r + 4)) { this._wreckTank(t, by, false); n++; }
    }
    return n;
  }

  // a beam: anything within r of the segment
  hitRay(from, dir, len, r, by = null) {
    if (!this.shown) return 0;
    let n = 0;
    const near = (p, pad) => {
      const k = clamp(_v.subVectors(p, from).dot(dir), 0, len);
      return _w.copy(from).addScaledVector(dir, k).distanceToSquared(p) < (r + pad) * (r + pad);
    };
    for (const h of this.helis) if (h.state === 'fly' && near(h.pos, 6)) { this._downHeli(h, by, _u.copy(dir).multiplyScalar(40)); n++; }
    for (const t of this.tanks) if (t.state === 'ok' && near(_u.copy(t.pos).setY(t.pos.y + 2), 4)) { this._wreckTank(t, by, false); n++; }
    return n;
  }

  // a blast or a quake (ground: only what stands on the street; flat: stepped on)
  blast(pos, r, by = null, ground = false, flat = false) {
    if (!this.shown) return 0;
    let n = 0;
    if (!ground) for (const h of this.helis) {
      if (h.state === 'fly' && h.pos.distanceToSquared(pos) < r * r) { this._downHeli(h, by, _v.subVectors(h.pos, pos).setLength(30)); n++; }
    }
    for (const t of this.tanks) {
      if (t.state !== 'ok') continue;
      const d = Math.hypot(t.pos.x - pos.x, t.pos.z - pos.z);
      if (d < r && Math.abs(t.pos.y - pos.y) < r + 6) { this._wreckTank(t, by, flat); n++; }
    }
    return n;
  }

  _credit(by, text) {
    G.stats.military++;
    if (!by) return;
    by.meter = Math.min(100, by.meter + 3);
    by.stats.swatted = (by.stats.swatted || 0) + 1;
    if (by === G.player && G.hud) G.hud.flashText(by, text);
  }

  _downHeli(h, by, vel) {
    h.state = 'fall';
    h.spin = rand(5, 9) * (chance(0.5) ? 1 : -1);
    h.vel.multiplyScalar(0.5);
    if (vel) h.vel.addScaledVector(vel, 0.6);
    h.vel.y += rand(2, 8);
    h.light.visible = false;
    G.fx.fireball(h.pos, 0.8);
    G.fx.sparkCone(h.pos, UP, 40, TRACER, 45, 1.5, 0.5, 0.06);
    G.fx.shock.ring(h.pos.clone(), null, 22, 0xffd08a, 0.4, 0.14);
    G.audio && G.audio.explosion(h.pos, 0.45);
    G.fightCam && G.fightCam.addTraumaAt(h.pos, 0.3, 300);
    this.heliMesh.setColorAt(h.i, _c.setRGB(0.35, 0.33, 0.3)); this.heliMesh.instanceColor.needsUpdate = true;
    this._credit(by, 'CHOPPER SWATTED!');
  }

  _crashHeli(h, onBuilding) {
    const p = h.pos.clone();
    G.fx.fireball(p, 1.3);
    G.fx.sparkCone(p, UP, 50, TRACER, 55, 1.4, 0.6, 0.06);
    G.fx.comic('boom', p.clone().add(_v.set(0, 10, 0)), 0.9);
    G.audio && G.audio.explosion(p, 0.6);
    G.fightCam && G.fightCam.addTraumaAt(p, 0.45, 350);
    G.destruction.impact({ pos: p, radius: 6, power: 0.9, vel: h.vel, shatter: 22, maxChunks: 18 });
    if (!onBuilding) {
      G.ground.crater(p.x, p.z, 7, 1.4, { cracks: 0.5 });
      G.ground.paintScorch(p.x, p.z, 10, 0.8);
      G.fx.dustRing(p, 16, 8);
    }
    G.props && G.props.explosion(p, 26, 12);
    G.debris.explosion(p, 30, 10, 0.6);
    h.state = 'gone';
    h.wait = rand(9, 16);
    this.heliMesh.setMatrixAt(h.i, ZERO); this.rotorMesh.setMatrixAt(h.i, ZERO);
  }

  _wreckTank(t, by, flat) {
    t.state = 'wreck';
    t.wait = rand(22, 34);
    t.smoke = rand(6, 10);
    t.flat = flat ? 0.4 : 1;
    t.pop = flat ? 0 : rand(0.6, 1.2); // the turret comes off
    const p = _u.copy(t.pos).setY(t.pos.y + 2.5).clone();
    G.fx.fireball(p, flat ? 0.6 : 1);
    G.fx.sparkCone(p, UP, 36, TRACER, 40, 1.3, 0.5, 0.06);
    G.fx.shock.ring(p, null, 18, 0xffc060, 0.4, 0.14);
    G.audio && G.audio.explosion(p, 0.4);
    G.audio && G.audio.metal(p);
    G.fightCam && G.fightCam.addTraumaAt(p, 0.25, 250);
    G.ground.paintScorch(t.pos.x, t.pos.z, 8, 0.7);
    _c.setRGB(0.3, 0.29, 0.27);
    this.hullMesh.setColorAt(t.i, _c); this.turretMesh.setColorAt(t.i, _c);
    this.hullMesh.instanceColor.needsUpdate = true; this.turretMesh.instanceColor.needsUpdate = true;
    this._credit(by, flat ? 'TANK FLATTENED!' : 'TANK DESTROYED!');
  }

  // ------------------------------------------------------------------ firing
  // where on him a round lands: somewhere on the side facing the shooter
  _aim(f, from, out, spread = 7) {
    f.hurtCenter(out);
    _v.subVectors(from, out).setY(0).normalize();
    return out.addScaledVector(_v, f.R * 0.8).add(_w.set(rand(-1, 1), rand(-0.5, 1.6), rand(-1, 1)).multiplyScalar(spread));
  }

  _chip(f, d, at, size) {
    if (G.game.state === 'fight' && f.alive && !f.ko && f.invuln <= 0 && f.hp > d + 1) f.hp -= d; // straight off the bar: no flinch, no shake, never the last of it
    f.model.hitFlash(0.12 + size * 0.2);
    G.fx.shock.flash(at, 2.5 + size * 5, 0xffd890, 0.09);
    if (size > 0.3) { G.fx.pyro(at, 0.35 + size * 0.5); G.fightCam && G.fightCam.addTraumaAt(at, 0.12 * size, 300); G.audio && G.audio.hit('heavy', at, true); } // sparks off the suit, as on a tokusatsu set
    else if (chance(0.5)) G.fx.sparkCone(at, UP, 4, TRACER, 22, 1.2, 0.3, 0.05);
  }

  _shot(from, to, kind, f, T) {
    if (this.shots.length >= this.shotMesh.count) return;
    this.shots.push({ a: from.clone(), b: to.clone(), off: to.clone().sub(f.hurtCenter(_v)), k: 0, T, kind, f, puff: 0, pos: from.clone(), arc: kind === 'shell' ? from.distanceTo(to) * 0.1 : 0 });
  }

  // ------------------------------------------------------------------ per frame
  update(dt, realDt) {
    const st = G.game ? G.game.state : 'boot';
    // off stage in the tutorial; while the recap plays it poses them itself (snapshot / pose)
    const shown = st !== 'tutorial';
    if (shown !== this.shown) { this.shown = shown; for (const m of this.meshes) m.visible = shown; }
    const recap = !!(G.recap && G.recap.active);
    this.shotMesh.visible = shown && !recap;
    if (!shown || recap) { for (const h of this.helis) h.light.visible = false; return; }
    if (dt <= 0) return;
    this.t += dt;
    // who they are after: the monster during a fight, whoever is rampaging after it
    const firing = st === 'fight' || st === 'explore';
    const tgt = this.target = st === 'explore' ? G.player : (st === 'fight' || st === 'intro' || st === 'ko') ? G.fighters.find((f) => f.def.rig === 'beast') || null : null;
    const dark = G.weather && SEARCHLIGHT.has(G.weather.name);
    this.lightK = damp(this.lightK, dark && tgt ? 1 : 0, 2, dt);
    this.lightMat.uniforms.uAlpha.value = 0.1 * this.lightK;

    for (const h of this.helis) this._heli(h, dt, tgt, firing);
    for (const t of this.tanks) this._tank(t, dt, tgt, firing);
    this._shots(dt);
    // a kaiju's own bulk: whatever flies into him, whatever he lies or slides on
    for (const f of G.fighters) {
      if (f.state === 'wait') continue;
      f.hurtCenter(_u);
      const fast = f.vel.lengthSq() > 18 * 18;
      for (const h of this.helis) if (h.state === 'fly' && h.pos.distanceToSquared(_u) < (f.R + 6) * (f.R + 6)) this._downHeli(h, f.state === 'launched' ? f.lastHitBy : f, f.vel);
      const low = f.pos.y - f.floorY < 4;
      const lying = f.state === 'down' || f.state === 'ko' || (f.state === 'launched' && f.pos.y - f.floorY < 10);
      if (!low && !lying) continue;
      for (const t of this.tanks) {
        if (t.state !== 'ok') continue;
        const d = Math.hypot(t.pos.x - f.pos.x, t.pos.z - f.pos.z);
        if (d < (lying ? f.R * 1.5 : fast ? f.R * 1.1 : f.R * 0.55)) this._wreckTank(t, lying ? f.lastHitBy : f, !lying);
      }
    }
    for (const m of [this.heliMesh, this.rotorMesh, this.hullMesh, this.turretMesh, this.shotMesh]) m.instanceMatrix.needsUpdate = true;
  }

  _heli(h, dt, tgt, firing) {
    if (h.state === 'gone') {
      if ((h.wait -= dt) <= 0) this._spawnHeli(h);
      return;
    }
    if (h.state === 'fall') {
      h.vel.y -= 26 * dt;
      h.vel.x *= Math.exp(-0.4 * dt); h.vel.z *= Math.exp(-0.4 * dt);
      h.pos.addScaledVector(h.vel, dt);
      h.yaw += h.spin * dt; h.roll += 1.4 * dt; h.pitch -= 0.6 * dt; h.rotor += 9 * dt;
      if (chance(dt * 22)) G.fx.smoke.spawn(h.pos.x, h.pos.y + 1, h.pos.z, rand(-1, 1), 3, rand(-1, 1), 2.6, 2.2, rand(1.2, 2.2), 'dark', 1.2, 1.4);
      const gh = G.ground.heightAt(h.pos.x, h.pos.z);
      let hit = h.pos.y <= gh + 2.5, roof = false;
      if (!hit && G.destruction.structsNear(h.pos, 5).length) {
        let near = false;
        G.destruction.forChunksInSphere(h.pos, 5, () => { near = true; });
        hit = roof = near;
      }
      if (hit) { if (!roof) h.pos.y = gh + 2; this._crashHeli(h, roof); return; }
      this._writeHeli(h);
      return;
    }
    // Hunting: it takes up a station near the monster (near the park when there is nothing to
    // hunt), low over a street or a low roof where there is one, holds it for a few seconds
    // firing, then moves to another. Towers on the way are climbed over.
    const c = tgt ? tgt.pos : this.center;
    const sp = 34;
    const off = h.station ? Math.hypot(h.station.x - c.x, h.station.z - c.z) : 0;
    if (!h.station || (h.stay -= dt) <= 0 || off > 170 || off < 40) this._station(h, c);
    _v.set(h.station.x, 0, h.station.z);
    // over the roofs, looking a couple of seconds ahead; a tower in the way and it slows right
    // down to climb over it (they hunt at head height, where a fist can reach them)
    let roof = this._roof(h.pos.x, h.pos.z, 14);
    for (const T of [1.2, 2.5]) roof = Math.max(roof, this._roof(h.pos.x + h.vel.x * T, h.pos.z + h.vel.z * T, 14));
    const base = (tgt ? tgt.floorY - tgt.hipH : G.ground.heightAt(c.x, c.z)) + h.alt + Math.sin(this.t * 0.7 + h.i * 2) * 4;
    _v.y = Math.max(base, roof + 16);
    _w.subVectors(_v, h.pos);
    const far = Math.hypot(_w.x, _w.z);
    _w.multiplyScalar((Math.min(sp, far * 0.8) * clamp(1 - (_v.y - h.pos.y - 15) / 50, 0.2, 1)) / (far || 1));
    // on station it drifts a little rather than hanging dead still
    _w.x += Math.sin(this.t * 0.9 + h.i * 1.7) * 3; _w.z += Math.cos(this.t * 0.7 + h.i * 2.3) * 3;
    const ax = (_w.x - h.vel.x) * 1.6, az = (_w.z - h.vel.z) * 1.6;
    h.vel.x += ax * dt; h.vel.z += az * dt;
    h.vel.y = damp(h.vel.y, clamp((_v.y - h.pos.y) * 1.5, -22, 42), 4, dt);
    h.pos.addScaledVector(h.vel, dt);
    // nose on the target when in range, along the flight path otherwise; banking into the turn
    const inRange = tgt && Math.hypot(tgt.pos.x - h.pos.x, tgt.pos.z - h.pos.z) < 210;
    const want = inRange ? Math.atan2(tgt.pos.x - h.pos.x, tgt.pos.z - h.pos.z) : Math.atan2(h.vel.x, h.vel.z);
    let d = want - h.yaw; d = Math.atan2(Math.sin(d), Math.cos(d));
    h.yaw += d * (1 - Math.exp(-3 * dt));
    const fx = Math.sin(h.yaw), fz = Math.cos(h.yaw);
    h.pitch = damp(h.pitch, clamp((h.vel.x * fx + h.vel.z * fz) * 0.006, -0.2, 0.3), 3, dt);
    h.roll = damp(h.roll, clamp((h.vel.x * fz - h.vel.z * fx) * -0.012, -0.5, 0.5), 3, dt);
    h.rotor += 34 * dt;
    this._writeHeli(h);

    // the searchlight
    const L = h.light;
    L.visible = this.lightK > 0.02 && !!tgt && inRange;
    if (L.visible) {
      tgt.hurtCenter(_u);
      const len = h.pos.distanceTo(_u) + 12;
      L.position.copy(h.pos);
      L.lookAt(_u);
      L.scale.set(len * 0.11, len * 0.11, len);
    }

    if (!firing || !inRange || !tgt.alive || tgt.ko) return;
    // a burst from the chin gun, and every third pass a rocket
    if (h.burst > 0) {
      if ((h.burstT -= dt) <= 0) {
        h.burst--; h.burstT = 0.09;
        const from = _u.set(h.pos.x + fx * 8, h.pos.y - 2, h.pos.z + fz * 8).clone();
        const to = this._aim(tgt, from, new THREE.Vector3());
        const dist = from.distanceTo(to), v = 330, life = dist / v;
        _w.subVectors(to, from).multiplyScalar(v / dist);
        G.fx.sparks.spawn(from.x, from.y, from.z, _w.x, _w.y, _w.z, 0.55, 0.028, life, TRACER, 0, 0);
        G.fx.shock.flash(from, 2.2, 0xffe0a0, 0.05);
        this.hits.push({ t: life, f: tgt, off: to.sub(tgt.hurtCenter(_v)) });
        if (h.burst % 3 === 0) G.audio && G.audio.gunfire(from);
      }
      return;
    }
    if ((h.fire -= dt) > 0) return;
    h.fire = rand(2.6, 4.6);
    if (++h.volley % 3 === 0) {
      const from = _u.set(h.pos.x + fz * 3.3, h.pos.y - 1, h.pos.z - fx * 3.3).clone();
      const to = this._aim(tgt, from, new THREE.Vector3(), 4);
      this._shot(from, to, 'rocket', tgt, clamp(from.distanceTo(to) / 120, 0.4, 2));
      G.fx.shock.flash(from, 4, 0xffd080, 0.1);
      G.audio && G.audio.rocket(from);
    } else { h.burst = 6; h.burstT = 0; }
  }

  _writeHeli(h) {
    _q.setFromEuler(_e.set(h.pitch, h.yaw, h.roll, 'YXZ'));
    this.heliMesh.setMatrixAt(h.i, _m.compose(h.pos, _q, _s.set(1, 1, 1)));
    _q2.setFromAxisAngle(UP, h.rotor);
    _v.set(0, 3.7, 0).applyQuaternion(_q).add(h.pos);
    this.rotorMesh.setMatrixAt(h.i, _m.compose(_v, _q2.premultiply(_q), _s));
  }

  _tank(t, dt, tgt, firing) {
    if (t.state === 'gone') { if ((t.wait -= dt) <= 0 && !this._placeTank(t)) t.wait = 3; return; }
    if (t.state === 'wreck') {
      t.wait -= dt;
      if (t.smoke > 0) {
        t.smoke -= dt;
        if (chance(dt * 7)) G.fx.smoke.spawn(t.pos.x + rand(-1.5, 1.5), t.pos.y + 2.5, t.pos.z + rand(-1.5, 1.5), rand(-0.5, 0.5), 3, rand(-0.5, 0.5), 1.6, 2.4, rand(2.5, 4), 'dark', 0.8, 1.3);
      }
      // cleared away (and its replacement sent in) once nobody is near enough to see it go
      if (t.wait <= 0 && !G.fighters.some((f) => Math.hypot(f.pos.x - t.pos.x, f.pos.z - t.pos.z) < 150)) {
        this.hullMesh.setMatrixAt(t.i, ZERO); this.turretMesh.setMatrixAt(t.i, ZERO);
        t.state = 'gone'; t.wait = rand(2, 6);
        return;
      }
      t.pos.y = G.ground.heightAt(t.pos.x, t.pos.z);
      this._writeTank(t);
      return;
    }
    // rolling up and down its street, turning round at the ends (or short of a kaiju)
    const r = t.road;
    const dist = tgt ? Math.hypot(tgt.pos.x - t.pos.x, tgt.pos.z - t.pos.z) : 999;
    const moving = !tgt || dist > 110;
    if (moving) {
      t.s += (t.dir * 5 * dt) / r.len;
      if (t.s > 0.95 || t.s < 0.05) { t.dir *= -1; t.s = clamp(t.s, 0.05, 0.95); }
    }
    t.pos.x = r.ax + (r.bx - r.ax) * t.s; t.pos.z = r.az + (r.bz - r.az) * t.s;
    t.pos.y = damp(t.pos.y, G.ground.heightAt(t.pos.x, t.pos.z), 6, dt);
    let d = Math.atan2(r.bx - r.ax, r.bz - r.az) + (t.dir < 0 ? Math.PI : 0) - t.yaw;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    t.yaw += clamp(d, -1.2 * dt, 1.2 * dt);
    const inRange = tgt && dist < 300;
    d = (inRange ? Math.atan2(tgt.pos.x - t.pos.x, tgt.pos.z - t.pos.z) : t.yaw) - t.tyaw;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    t.tyaw += clamp(d, -1.6 * dt, 1.6 * dt);
    this._writeTank(t);
    if (!firing || !inRange || !tgt.alive || tgt.ko || Math.abs(d) > 0.2) return;
    if ((t.fire -= dt) > 0) return;
    t.fire = rand(3.5, 6.5);
    const from = _u.set(t.pos.x + Math.sin(t.tyaw) * 8, t.pos.y + 3.4, t.pos.z + Math.cos(t.tyaw) * 8).clone();
    const to = this._aim(tgt, from, new THREE.Vector3(), 5);
    this._shot(from, to, 'shell', tgt, clamp(from.distanceTo(to) / 150, 0.5, 1.8));
    G.fx.shock.flash(from, 5, 0xffd080, 0.1);
    G.fx.dustPuff(from, 2.5, 2, 'white', _v.set(Math.sin(t.tyaw) * 8, 2, Math.cos(t.tyaw) * 8), 0.8);
    G.audio && G.audio.cannon(from);
  }

  _writeTank(t) {
    _q.setFromAxisAngle(UP, t.yaw);
    this.hullMesh.setMatrixAt(t.i, _m.compose(t.pos, _q, _s.set(1, t.flat, 1)));
    if (t.state === 'wreck' && t.pop) {
      // blown off: lying beside the hull
      _q.setFromEuler(_e.set(0.35, t.tyaw + 0.8, 1.2));
      _v.set(t.pos.x + Math.sin(t.yaw + 1.3) * 5 * t.pop, t.pos.y + 1.4, t.pos.z + Math.cos(t.yaw + 1.3) * 5 * t.pop);
    } else {
      _q.setFromAxisAngle(UP, t.tyaw);
      _v.set(t.pos.x, t.pos.y + 2.5 * t.flat, t.pos.z);
    }
    this.turretMesh.setMatrixAt(t.i, _m.compose(_v, _q, _s.set(1, t.flat, 1)));
  }

  _shots(dt) {
    // tracer rounds arriving
    for (let i = this.hits.length - 1; i >= 0; i--) {
      const h = this.hits[i];
      if ((h.t -= dt) > 0) continue;
      this.hits.splice(i, 1);
      this._chip(h.f, DMG.tracer, h.f.hurtCenter(new THREE.Vector3()).add(h.off), 0);
    }
    for (let i = this.shots.length - 1; i >= 0; i--) {
      const s = this.shots[i];
      s.k += dt / s.T;
      // homes on where he is now (a kaiju is not hard to hit)
      s.b.copy(s.f.hurtCenter(_v)).add(s.off);
      const k = Math.min(1, s.k);
      _w.copy(s.pos);
      s.pos.lerpVectors(s.a, s.b, k);
      s.pos.y += 4 * s.arc * k * (1 - k);
      if (s.kind === 'rocket' && (s.puff -= dt) <= 0) {
        s.puff = 0.035;
        G.fx.smoke.spawn(s.pos.x, s.pos.y, s.pos.z, 0, 1, 0, 1.3, 2, rand(0.5, 0.9), 'white', 1.2, 0.6);
      }
      if (s.k >= 1) {
        this.shots.splice(i, 1);
        this._chip(s.f, DMG[s.kind], s.pos, s.kind === 'rocket' ? 0.7 : 0.55);
        continue;
      }
      _u.subVectors(s.pos, _w);
      if (_u.lengthSq() > 1e-6) _q.setFromUnitVectors(_v.set(0, 0, 1), _u.normalize());
      s.q = (s.q || new THREE.Quaternion()).copy(_q);
    }
    for (let i = 0; i < this.shotMesh.count; i++) {
      const s = this.shots[i];
      if (s) this.shotMesh.setMatrixAt(i, _m.compose(s.pos, s.q || _q.identity(), _s.set(1, 1, 1))); else this.shotMesh.setMatrixAt(i, ZERO);
    }
  }
}
