// The elevated train: a destructible steel viaduct looping around downtown (built from the
// same chunk system as the buildings) and a train of kinematic cars that derail into
// tumbling physics bodies when something superhuman hits them or the track under them goes.
import * as THREE from 'three';
import { G } from '../core/context.js';
import { gradientMap, outlineMaterial, addOutline } from '../render/toon.js';
import { mergeGeoms } from '../render/renderer.js';
import { CG } from '../physics/physics.js';
import { KIND } from './structures.js';
import { STYLE } from './chunkMaterial.js';
import { rand, randomUnit, clamp } from '../core/math.js';

// x0..x1 / z0..z1: the loop's beam centrelines (the procedural city's streets at +-76 m; real
// maps set their own with setTrackLoop before the city is built)
export const TRACK = { x0: -76, x1: 76, z0: -76, z1: 76, top: 8.4, sy: 2.4, cell: 4, width: 4, pillarEvery: 3 };
export function setTrackLoop({ x0, x1, z0, z1 }) { Object.assign(TRACK, { x0, x1, z0, z1 }); }
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();

// Called during city generation (before the chunk mesh is finalized).
export function buildTrack(D) {
  const { x0: X0, x1: X1, z0: Z0, z1: Z1, width: Wd } = TRACK;
  const steel = new THREE.Color(0x4d5c55);
  const sides = [
    { axis: 'x', x0: X0 - Wd / 2, z0: Z0 - Wd / 2, len: X1 - X0 + Wd },
    { axis: 'x', x0: X0 - Wd / 2, z0: Z1 - Wd / 2, len: X1 - X0 + Wd },
    { axis: 'z', x0: X0 - Wd / 2, z0: Z0 + Wd / 2, len: Z1 - Z0 - Wd },
    { axis: 'z', x0: X1 - Wd / 2, z0: Z0 + Wd / 2, len: Z1 - Z0 - Wd },
  ];
  for (const sd of sides) {
    const cells = Math.max(2, Math.round(sd.len / TRACK.cell));
    const cl = sd.len / cells;
    const along = [];
    for (let i = 0; i <= cells; i++) along.push(i * cl);
    const across = [0, TRACK.width];
    const xs = sd.axis === 'x' ? along : across;
    const zs = sd.axis === 'x' ? across : along;
    const s = D.addStructure({ origin: new THREE.Vector3(sd.x0, 0, sd.z0), xs, zs, ny: 4, sy: TRACK.sy, kind: 'track' });
    s.noRatio = true;
    for (let i = 0; i < cells; i++) {
      const a0 = along[i], a1 = along[i + 1];
      const ci = sd.axis === 'x' ? s.ci(i, 3, 0) : s.ci(0, 3, i);
      // beam span with a darker deck
      D.addChunk(s, {
        x0: sd.axis === 'x' ? a0 : 0.2, x1: sd.axis === 'x' ? a1 : TRACK.width - 0.2,
        z0: sd.axis === 'x' ? 0.2 : a0, z1: sd.axis === 'x' ? TRACK.width - 0.2 : a1,
        y0: TRACK.top - 1.2, y1: TRACK.top, kind: KIND.SOLID, level: 3,
        color: steel.clone().multiplyScalar(0.95 + Math.random() * 0.1), style: [0, 0, STYLE.CONCRETE], cells: [ci],
      });
      if (i % TRACK.pillarEvery === 1) {
        const mid = (a0 + a1) / 2;
        for (let y = 0; y < 3; y++) {
          const c2 = sd.axis === 'x' ? s.ci(i, y, 0) : s.ci(0, y, i);
          D.addChunk(s, {
            x0: sd.axis === 'x' ? mid - 0.8 : TRACK.width / 2 - 0.8, x1: sd.axis === 'x' ? mid + 0.8 : TRACK.width / 2 + 0.8,
            z0: sd.axis === 'x' ? TRACK.width / 2 - 0.8 : mid - 0.8, z1: sd.axis === 'x' ? TRACK.width / 2 + 0.8 : mid + 0.8,
            y0: y * TRACK.sy, y1: (y + 1) * TRACK.sy, kind: KIND.CORNER, level: y,
            color: steel.clone().multiplyScalar(0.85), style: [0, 0, STYLE.CONCRETE], cells: [c2],
          });
        }
      }
    }
  }
}

function colored(geo, r, g, b) {
  const nn = geo.attributes.position.count;
  const c = new Float32Array(nn * 3);
  for (let i = 0; i < nn; i++) { c[i * 3] = r; c[i * 3 + 1] = g; c[i * 3 + 2] = b; }
  geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return geo.toNonIndexed();
}

function carGeometry(front) {
  const parts = [];
  const box = (sx, sy, sz, x, y, z, col) => { const g = new THREE.BoxGeometry(sx, sy, sz); g.translate(x, y, z); parts.push(colored(g, ...col)); };
  box(13.6, 3.0, 3.0, 0, 1.95, 0, [0.74, 0.76, 0.79]);          // body
  box(12.6, 1.0, 3.06, 0, 2.45, 0, [0.12, 0.18, 0.27]);          // window band
  for (let i = -5; i <= 5; i += 1.25) box(0.18, 1.02, 3.08, i, 2.45, 0, [0.74, 0.76, 0.79]); // mullions
  box(13.62, 0.28, 3.04, 0, 1.25, 0, [0.78, 0.12, 0.12]);        // red stripe
  box(13.2, 0.32, 2.7, 0, 3.6, 0, [0.42, 0.44, 0.47]);           // roof
  box(2.6, 0.7, 2.5, 4.8, 0.35, 0, [0.12, 0.12, 0.13]);          // bogies
  box(2.6, 0.7, 2.5, -4.8, 0.35, 0, [0.12, 0.12, 0.13]);
  if (front) {
    box(0.2, 0.35, 0.5, 6.85, 1.6, 0.9, [1.6, 1.5, 1.1]);
    box(0.2, 0.35, 0.5, 6.85, 1.6, -0.9, [1.6, 1.5, 1.1]);
  }
  return mergeGeoms(parts);
}

export class Train {
  constructor(scene) {
    this.cars = [];
    this.speed = 19;
    this.s = 40;
    this.derailed = false;
    // rounded-rectangle loop on the beam centerline
    const r = 4;
    this.r = r;
    this.L = 2 * (TRACK.x1 - TRACK.x0 - 2 * r) + 2 * (TRACK.z1 - TRACK.z0 - 2 * r) + 2 * Math.PI * r;
    const mat = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: gradientMap(3) });
    const outline = outlineMaterial(0.02);
    const R = G.physics.R;
    for (let i = 0; i < 5; i++) {
      const mesh = new THREE.Mesh(carGeometry(i === 0), mat);
      mesh.castShadow = true; mesh.receiveShadow = true;
      addOutline(mesh, outline);
      scene.add(mesh);
      const body = G.physics.world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(0, -50, 0));
      const col = G.physics.world.createCollider(R.ColliderDesc.cuboid(6.8, 1.75, 1.55).setTranslation(0, 1.85, 0)
        .setDensity(0.35).setFriction(0.6).setCollisionGroups(CG.prop), body);
      this.cars.push({ mesh, body, col, offset: i * 14.6, onRails: true, calm: 0, dynamic: false });
    }
    this.place(0);
  }

  // position + heading at arc length s along the loop
  at(s, outPos) {
    const { x0: X0, x1: X1, z0: Z0, z1: Z1 } = TRACK, r = this.r, q = Math.PI * r / 2;
    s = ((s % this.L) + this.L) % this.L;
    const segs = [
      { x: X0 + r, z: Z0, dx: 1, dz: 0 }, { cx: X1 - r, cz: Z0 + r, a0: -Math.PI / 2 },
      { x: X1, z: Z0 + r, dx: 0, dz: 1 }, { cx: X1 - r, cz: Z1 - r, a0: 0 },
      { x: X1 - r, z: Z1, dx: -1, dz: 0 }, { cx: X0 + r, cz: Z1 - r, a0: Math.PI / 2 },
      { x: X0, z: Z1 - r, dx: 0, dz: -1 }, { cx: X0 + r, cz: Z0 + r, a0: Math.PI },
    ];
    for (let i = 0; i < 8; i++) {
      const len = i % 2 === 1 ? q : (i % 4 === 0 ? X1 - X0 : Z1 - Z0) - 2 * r;
      if (s <= len || i === 7) {
        const g = segs[i];
        if (i % 2 === 0) {
          outPos.set(g.x + g.dx * s, TRACK.top, g.z + g.dz * s);
          return Math.atan2(g.dx, g.dz);
        }
        const a = g.a0 + s / r;
        outPos.set(g.cx + Math.cos(a) * r, TRACK.top, g.cz + Math.sin(a) * r);
        return Math.atan2(-Math.sin(a), Math.cos(a));
      }
      s -= len;
    }
    return 0;
  }

  place(dt) {
    for (const car of this.cars) {
      if (!car.onRails) continue;
      const heading = this.at(this.s - car.offset, _v);
      // car mesh is built along +X; heading is the angle of travel measured from +Z
      _q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), heading - Math.PI / 2);
      car.body.setNextKinematicTranslation({ x: _v.x, y: _v.y, z: _v.z });
      car.body.setNextKinematicRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w });
      car.mesh.position.copy(_v);
      car.mesh.quaternion.copy(_q);
      car.heading = heading;
    }
  }

  derail(hitCar, impulseVel) {
    if (this.derailed) return;
    this.derailed = true;
    const R = G.physics.R;
    const tangent = (car) => new THREE.Vector3(Math.sin(car.heading), 0, Math.cos(car.heading)).multiplyScalar(this.speed);
    for (const car of this.cars) {
      if (!car.onRails) continue;
      car.onRails = false;
      car.dynamic = true;
      car.body.setBodyType(R.RigidBodyType.Dynamic, true);
      const v = tangent(car);
      if (car === hitCar && impulseVel) v.addScaledVector(impulseVel, 0.3).add(new THREE.Vector3(0, 5, 0));
      else v.add(new THREE.Vector3(rand(-3, 3), rand(0, 2), rand(-3, 3)));
      car.body.setLinvel({ x: v.x, y: v.y, z: v.z }, true);
      const w = randomUnit(new THREE.Vector3()).multiplyScalar(car === hitCar ? 2.5 : 0.8);
      car.body.setAngvel({ x: w.x, y: w.y, z: w.z }, true);
    }
    const p = hitCar ? hitCar.mesh.position.clone() : this.cars[0].mesh.position.clone();
    G.fx.sparkCone(p, new THREE.Vector3(0, 1, 0), 60, new THREE.Color(1, 0.8, 0.4), 35, 1.3, 0.1, 0.06);
    G.fx.shock.flash(p, 5, 0xfff0c0, 0.25);
    G.fx.comic('huge', p.clone().add(new THREE.Vector3(0, 5, 0)), 1.2);
    G.audio && G.audio.hit('huge', p);
    G.audio && G.audio.metal(p, 1.4);
    G.audio && G.audio.crumble(1, p);
    G.fightCam && G.fightCam.addTraumaAt(p, 0.5, 200);
    G.hud && G.hud.toast('THE TRAIN!!');
    G.recorder && G.recorder.mark('train', { pos: p });
  }

  // Fighters moving fast through a car knock the whole train off its rails.
  // r widens the hit box (a kaiju's foot or body); minSp: how fast it has to be going
  sweep(pos, vel, r = 0, minSp = 30) {
    const sp = vel.length();
    if (sp < minSp) return;
    for (const car of this.cars) {
      const c = car.mesh.position;
      _v.copy(pos).sub(c);
      // into car-local space (car length along local X)
      _v.applyQuaternion(_q.copy(car.mesh.quaternion).invert());
      if (Math.abs(_v.x) < 8 + r && _v.y > -1.5 - r && _v.y < 5 + r && Math.abs(_v.z) < 3.2 + r) {
        if (car.onRails) this.derail(car, vel);
        else if (!car.hitCd || car.hitCd <= 0) {
          car.hitCd = 0.4;
          if (!car.dynamic) { car.dynamic = true; car.body.setBodyType(G.physics.R.RigidBodyType.Dynamic, true); }
          const m = car.body.mass();
          car.body.applyImpulse({ x: vel.x * m * 0.4, y: m * 6, z: vel.z * m * 0.4 }, true);
          G.audio && G.audio.metal(c);
          G.fx.sparkCone(c.clone().add(new THREE.Vector3(0, 2, 0)), vel.clone().normalize(), 30, new THREE.Color(1, 0.8, 0.4), 30);
        }
      }
    }
  }

  update(dt) {
    if (!this.derailed) {
      this.s += this.speed * dt;
      this.place(dt);
      // track gone under a car? -> derail
      for (const car of this.cars) {
        let support = false;
        G.destruction.forChunksInSphere(_v.copy(car.mesh.position).add(new THREE.Vector3(0, -0.6, 0)), 2.2, () => { support = true; });
        if (!support) { this.derail(car, null); break; }
      }
      return;
    }
    for (const car of this.cars) {
      car.hitCd = (car.hitCd || 0) - dt;
      if (!car.dynamic) continue;
      const t = car.body.translation(), r = car.body.rotation();
      car.mesh.position.set(t.x, t.y, t.z);
      car.mesh.quaternion.set(r.x, r.y, r.z, r.w);
      const v = car.body.linvel();
      const sp = Math.hypot(v.x, v.y, v.z);
      if (sp > 12 && Math.random() < 0.3) G.fx.sparkCone(car.mesh.position.clone(), new THREE.Vector3(0, 1, 0), 3, new THREE.Color(1, 0.75, 0.35), 15, 1.2);
      car.calm = sp < 0.4 ? car.calm + dt : 0;
      if (car.calm > 1.5) { car.dynamic = false; car.body.setBodyType(G.physics.R.RigidBodyType.Fixed, false); }
      if (t.y < -30) car.dynamic = false;
    }
  }
}
