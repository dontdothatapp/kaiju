// Street props: parked cars as sleeping Rapier bodies. Shockwaves flip them, big hits wreck
// them (darken + smoke) and some go up in a fireball.
import * as THREE from 'three';
import { G } from '../core/context.js';
import { gradientMap } from '../render/toon.js';
import { mergeGeoms } from '../render/renderer.js';
import { CG } from '../physics/physics.js';
import { stageInstances, trackUploads } from '../physics/debris.js';
import { CITY, CITY_HALF } from './city.js';
import { makeRng, rand, randomUnit } from '../core/math.js';

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3(1, 1, 1);
const PAINT = [0xd23a2e, 0x2e63c9, 0xf2c230, 0xeeeeee, 0x2b2b30, 0x3f9b5a, 0xe07a26, 0x8fa6b8];

function colored(geo, r, g, b) {
  const n = geo.attributes.position.count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { c[i * 3] = r; c[i * 3 + 1] = g; c[i * 3 + 2] = b; }
  geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return geo.index ? geo.toNonIndexed() : geo;
}

function carGeometry() {
  const parts = [];
  const body = new THREE.BoxGeometry(4.2, 0.95, 1.9); body.translate(0, 0.72, 0);
  parts.push(colored(body, 1, 1, 1));
  const cabin = new THREE.BoxGeometry(2.3, 0.72, 1.7); cabin.translate(-0.25, 1.55, 0);
  parts.push(colored(cabin, 0.18, 0.24, 0.32));
  const roof = new THREE.BoxGeometry(2.1, 0.08, 1.72); roof.translate(-0.25, 1.94, 0);
  parts.push(colored(roof, 1, 1, 1));
  for (const [x, z] of [[1.35, 0.9], [-1.35, 0.9], [1.35, -0.9], [-1.35, -0.9]]) {
    const w = new THREE.CylinderGeometry(0.4, 0.4, 0.3, 10); w.rotateX(Math.PI / 2); w.translate(x, 0.4, z);
    parts.push(colored(w, 0.07, 0.07, 0.08));
  }
  for (const z of [0.6, -0.6]) {
    const l = new THREE.BoxGeometry(0.06, 0.18, 0.35); l.translate(2.1, 0.85, z);
    parts.push(colored(l, 1.6, 1.5, 1.2));
  }
  return mergeGeoms(parts.map((g) => { if (!g.attributes.normal) g.computeVertexNormals(); return g; }));
}

// Procedural city: along every street, both curbs, skipping intersections
function gridSpots(rng) {
  const spots = [];
  for (let i = 0; i <= CITY.BLOCKS; i++) {
    const line = -CITY_HALF + i * CITY.PITCH;
    for (let j = 0; j < CITY.BLOCKS; j++) {
      const a = -CITY_HALF + j * CITY.PITCH + CITY.STREET / 2 + 3, b = a + CITY.PITCH - CITY.STREET - 6;
      for (const side of [-1, 1]) {
        let t = a + rng() * 8;
        while (t < b) {
          if (rng() < 0.55) {
            spots.push({ x: line + side * (CITY.STREET / 2 - 2.4), z: t, yaw: Math.PI / 2 + (side < 0 ? Math.PI : 0) });
            spots.push({ x: t, z: line + side * (CITY.STREET / 2 - 2.4), yaw: side < 0 ? Math.PI : 0 });
          }
          t += rng.range(6, 11);
        }
      }
    }
  }
  return spots;
}

// Real maps: along both curbs of every street centreline inside the arena, clear of the other
// streets' carriageways (so not in intersections or crossings).
function curbSpots(map, rng) {
  const segs = [];
  map.roads.forEach(([name, w, , , pts]) => {
    for (let i = 0; i + 3 < pts.length; i += 2) segs.push({ name, w, a: [pts[i], pts[i + 1]], b: [pts[i + 2], pts[i + 3]] });
  });
  const distTo = (g, x, z) => {
    const dx = g.b[0] - g.a[0], dz = g.b[1] - g.a[1];
    const t = Math.max(0, Math.min(1, ((x - g.a[0]) * dx + (z - g.a[1]) * dz) / (dx * dx + dz * dz || 1)));
    return Math.hypot(x - g.a[0] - dx * t, z - g.a[1] - dz * t);
  };
  const spots = [];
  for (const g of segs) {
    const dx = g.b[0] - g.a[0], dz = g.b[1] - g.a[1], len = Math.hypot(dx, dz);
    if (len < 10 || g.w < 7) continue;
    const ux = dx / len, uz = dz / len;
    for (const side of [-1, 1]) {
      const off = side * (g.w / 2 - 1.35);
      for (let t = rng.range(2, 8); t < len; t += rng.range(6, 11)) {
        const x = g.a[0] + ux * t - uz * off, z = g.a[1] + uz * t + ux * off;
        if (Math.abs(x) > CITY_HALF - 4 || Math.abs(z) > CITY_HALF - 4 || rng() > 0.55) continue;
        if (segs.some((o) => o.name !== g.name && distTo(o, x, z) < o.w / 2 + 5)) continue;
        spots.push({ x, z, yaw: Math.atan2(-uz, ux) + (side < 0 ? Math.PI : 0) });
      }
    }
  }
  return spots;
}

export class Props {
  constructor(scene, layout) {
    const rng = makeRng(7);
    const spots = layout.real ? curbSpots(layout.map, rng) : gridSpots(rng);
    const max = Math.min(spots.length, G.settings.quality === 'low' ? 70 : 150);
    rng.int(0, 1);
    spots.sort(() => rng() - 0.5);
    const geo = carGeometry();
    const mat = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: gradientMap(3) });
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
    trackUploads(this.mesh.instanceMatrix);
    this.cars = [];
    const R = G.physics.R;
    for (let i = 0; i < max; i++) {
      const s = spots[i];
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), s.yaw);
      // parked cars are Fixed until something disturbs them (cheap, and immune to island wake-ups)
      const body = G.physics.world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(s.x, 1.1, s.z)
        .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }).setLinearDamping(0.1).setAngularDamping(0.5));
      const col = G.physics.world.createCollider(R.ColliderDesc.cuboid(2.1, 0.75, 0.95).setTranslation(0, -0.35, 0)
        .setDensity(0.35).setFriction(0.7).setRestitution(0.15).setCollisionGroups(CG.prop), body);
      // New York: a good share of what's parked at the curb is yellow cabs
      const taxi = layout.real && rng() < 0.4;
      const color = new THREE.Color(taxi ? 0xf6b40e : PAINT[i % PAINT.length]).multiplyScalar(rng.range(0.85, 1.05));
      const car = { body, col, color, wrecked: false, smoke: 0, alive: true, i, dynamic: false, calm: 0 };
      this.mesh.setColorAt(i, color);
      this.cars.push(car);
      this._write(car);
    }
    this.mesh.instanceColor.needsUpdate = true;
  }

  _write(car) {
    const t = car.body.translation(), r = car.body.rotation();
    _p.set(t.x, t.y - 1.1, t.z); _q.set(r.x, r.y, r.z, r.w);
    // mesh origin is at the wheels; body origin sits 1.1 above
    _m.compose(_p.set(t.x, t.y, t.z).add(new THREE.Vector3(0, -1.1, 0).applyQuaternion(_q)), _q, _s);
    this.mesh.setMatrixAt(car.i, _m);
  }

  wake(car) {
    if (car.dynamic) return;
    car.dynamic = true;
    car.calm = 0;
    car.body.setBodyType(G.physics.R.RigidBodyType.Dynamic, true);
  }

  wreck(car, explode) {
    if (car.wrecked) return;
    car.wrecked = true;
    car.smoke = rand(4, 8);
    this.mesh.setColorAt(car.i, car.color.clone().multiplyScalar(0.3));
    this.mesh.instanceColor.needsUpdate = true;
    const t = car.body.translation();
    const p = new THREE.Vector3(t.x, t.y, t.z);
    if (explode) {
      G.fx.shock.flash(p, 6, 0xffb040, 0.3);
      G.fx.shock.ring(p, null, 14, 0xffc060, 0.5, 0.15);
      G.fx.dustPuff(p, 2.0, 5, 'hot', new THREE.Vector3(0, 6, 0), 1.0);
      G.fx.dustPuff(p, 2.5, 5, 'dark', new THREE.Vector3(0, 4, 0), 4);
      G.fx.sparkCone(p, new THREE.Vector3(0, 1, 0), 40, new THREE.Color(1, 0.7, 0.3), 30, 1.2, 0.1, 0.06);
      car.body.applyImpulse({ x: rand(-2, 2), y: 14, z: rand(-2, 2) }, true);
      car.body.applyTorqueImpulse({ x: rand(-6, 6), y: rand(-3, 3), z: rand(-6, 6) }, true);
      G.debris.explosion(p, 14, 10, 0.6);
      G.audio && G.audio.hit('huge', p);
      G.fightCam && G.fightCam.addTraumaAt(p, 0.3, 150);
      G.fx.comic('huge', p.clone().add(new THREE.Vector3(0, 4, 0)), 0.9);
    }
  }

  explosion(center, radius, strength) {
    for (const car of this.cars) {
      if (!car.alive) continue;
      const t = car.body.translation();
      const dx = t.x - center.x, dy = t.y - center.y, dz = t.z - center.z;
      const d = Math.hypot(dx, dy, dz);
      if (d > radius) continue;
      const k = (1 - d / radius) ** 1.5;
      this.wake(car);
      const m = car.body.mass();
      const f = strength * k * m;
      car.body.applyImpulse({ x: (dx / (d || 1)) * f, y: f * 0.9 + m * 3 * k, z: (dz / (d || 1)) * f }, true);
      car.body.applyTorqueImpulse({ x: rand(-1, 1) * f * 0.6, y: rand(-1, 1) * f * 0.3, z: rand(-1, 1) * f * 0.6 }, true);
      if (k > 0.35 && strength > 8) this.wreck(car, Math.random() < 0.35);
    }
  }

  // fighters plowing through traffic
  sweep(pos, vel, radius, minSpeed = 25) {
    const sp = vel.length();
    if (sp < minSpeed) return;
    for (const car of this.cars) {
      if (!car.alive) continue;
      const t = car.body.translation();
      const dx = t.x - pos.x, dy = t.y - pos.y, dz = t.z - pos.z;
      if (dx * dx + dy * dy + dz * dz > radius * radius) continue;
      this.wake(car);
      const m = car.body.mass();
      car.body.applyImpulse({ x: vel.x * m * 0.5 + dx * m, y: m * (8 + sp * 0.1), z: vel.z * m * 0.5 + dz * m }, true);
      car.body.applyTorqueImpulse({ x: rand(-1, 1) * m * 6, y: rand(-1, 1) * m * 3, z: rand(-1, 1) * m * 6 }, true);
      this.wreck(car, Math.random() < 0.5);
      G.audio && G.audio.metal(new THREE.Vector3(t.x, t.y, t.z));
      G.fx.sparkCone(new THREE.Vector3(t.x, t.y, t.z), vel.clone().normalize(), 20, new THREE.Color(1, 0.85, 0.5), 30);
    }
  }

  update(dt) {
    let lo = Infinity, hi = -1; // the moving cars' instances: only those go up to the GPU
    for (const car of this.cars) {
      if (!car.alive) continue;
      if (car.dynamic) {
        this._write(car);
        if (car.i < lo) lo = car.i;
        if (car.i > hi) hi = car.i;
        const v = car.body.linvel(), w = car.body.angvel();
        const e = v.x * v.x + v.y * v.y + v.z * v.z + w.x * w.x + w.y * w.y + w.z * w.z;
        car.calm = e < 0.3 ? car.calm + dt : 0;
        if (car.calm > 1.2) { car.dynamic = false; car.body.setBodyType(G.physics.R.RigidBodyType.Fixed, false); }
      }
      if (car.smoke > 0) {
        car.smoke -= dt;
        if (Math.random() < dt * 6) {
          const t = car.body.translation();
          G.fx.smoke.spawn(t.x + rand(-1, 1), t.y + 1, t.z + rand(-1, 1), rand(-0.5, 0.5), 2.5, rand(-0.5, 0.5), 0.9, 2.4, rand(2.5, 4), 'dark', 0.8, 1.2);
        }
      }
      if (car.body.translation().y < -30) car.alive = false;
    }
    if (hi >= 0) stageInstances(this.mesh.instanceMatrix, lo, hi);
  }
}
