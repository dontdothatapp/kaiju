// FX facade: one place for every visual feedback channel, plus composite "recipes".
import * as THREE from 'three';
import { makePebbleSystem, makeGlassSystem, makeBloodSystem, SparkSystem } from './particles.js';
import { SmokeSystem } from './smoke.js';
import { ShockSystem } from './shock.js';
import { ComicText } from './comic.js';
import { BeamSystem } from './beam.js';
import { G } from '../core/context.js';
import { rand, randomUnit, randomInCone, clamp } from '../core/math.js';

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _c = new THREE.Color();
const WHITE = new THREE.Color(1, 1, 1);
const UPV = new THREE.Vector3(0, 1, 0);

export class FX {
  constructor(scene, fractureLib, quality) {
    const q = { high: 1, medium: 0.7, low: 0.4 }[quality] || 0.7;
    this.q = q;
    this.pebbles = makePebbleSystem(scene, fractureLib[0][0].geometry, Math.floor(5000 * q));
    this.glass = makeGlassSystem(scene, Math.floor(3500 * q));
    this.bloodSys = makeBloodSystem(scene, Math.floor(900 * q));
    this.sparks = new SparkSystem(scene, Math.floor(2500 * q));
    this.smoke = new SmokeSystem(scene, Math.floor(2200 * q));
    this.shock = new ShockSystem(scene);
    this.comicText = new ComicText(scene);
    this.beam = new BeamSystem(scene);
  }

  update(dt, realDt, camera) {
    this.pebbles.update(dt);
    this.glass.update(dt);
    this.bloodSys.update(dt);
    this.sparks.update(dt);
    this.smoke.update(dt);
    this.shock.update(dt, camera);
    this.comicText.update(dt, realDt);
    this.beam.update(dt);
  }

  // ---- primitives ----
  pebbleBurst(pos, count, baseVel, color, spread = 1) {
    count = Math.floor(count * this.q + Math.random());
    for (let i = 0; i < count; i++) {
      randomUnit(_v);
      const sp = rand(3, 12) * spread;
      _c.copy(color || WHITE).multiplyScalar(rand(0.75, 1.1));
      if (Math.random() < 0.25) _c.setRGB(0.55, 0.53, 0.5);
      const bv = baseVel || _w.set(0, 0, 0);
      this.pebbles.spawn(
        pos.x + _v.x * spread, pos.y + _v.y * spread, pos.z + _v.z * spread,
        bv.x * rand(0.3, 1) + _v.x * sp, bv.y * rand(0.3, 1) + Math.abs(_v.y) * sp + rand(0, 5), bv.z * rand(0.3, 1) + _v.z * sp,
        rand(0.18, 0.75), rand(3, 7), _c,
      );
    }
  }

  glassBurst(center, size, count, baseVel, from) {
    count = Math.floor(count * this.q + Math.random());
    for (let i = 0; i < count; i++) {
      _v.set(center.x + rand(-0.5, 0.5) * size.x, center.y + rand(-0.4, 0.4) * size.y, center.z + rand(-0.5, 0.5) * size.z);
      _w.copy(_v).sub(from || center);
      _w.y = 0;
      if (_w.lengthSq() < 0.01) randomUnit(_w);
      _w.normalize().multiplyScalar(rand(3, 14));
      if (baseVel) _w.addScaledVector(baseVel, 0.3);
      _c.setRGB(0.7 + rand(0, 0.2), 0.88, 0.98);
      this.glass.spawn(_v.x, _v.y, _v.z, _w.x, _w.y + rand(0, 4), _w.z, rand(0.18, 0.55), rand(2.5, 4.5), _c);
    }
  }

  dustPuff(pos, size, n = 1, kind = 'dust', vel = null, life = null) {
    n = Math.max(1, Math.round(n * (0.5 + this.q * 0.5)));
    // the fuller the smoke budget, the fewer new puffs (keeps the screen readable in big fights)
    const load = this.smoke.load;
    if (load > 0.35 && Math.random() < (load - 0.35) * 1.4) return;
    for (let i = 0; i < n; i++) {
      randomUnit(_v).multiplyScalar(size * 0.5);
      const vx = (vel ? vel.x : 0) + _v.x * 1.5, vy = (vel ? vel.y : 0) + Math.abs(_v.y), vz = (vel ? vel.z : 0) + _v.z * 1.5;
      this.smoke.spawn(pos.x + _v.x, pos.y + _v.y, pos.z + _v.z, vx, vy, vz, size * rand(0.7, 1.2), rand(1.6, 2.4), life ?? rand(2.2, 4.8), kind, 1.3, 0.5);
    }
  }

  dustRing(pos, radius, n = 12, kind = 'dust', speedK = 1) {
    // many medium billows read better than a few huge ones; collapse clouds have their own budget
    const thin = kind === 'cloud' ? 0 : Math.min(0.7, this.smoke.load);
    n = Math.max(4, Math.round((n + radius * 0.5) * (0.5 + this.q * 0.5) * (1 - thin)));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rand(-0.2, 0.2);
      const dx = Math.cos(a), dz = Math.sin(a);
      const gy = G.ground ? G.ground.heightAt(pos.x + dx * radius * 0.3, pos.z + dz * radius * 0.3) : pos.y;
      this.smoke.spawn(
        pos.x + dx * radius * 0.3, Math.max(gy, pos.y) + rand(0.3, 1.5), pos.z + dz * radius * 0.3,
        dx * radius * 1.7 * speedK * rand(0.7, 1.2), rand(0.5, 2.5), dz * radius * 1.7 * speedK * rand(0.7, 1.2),
        Math.min(9, radius * 0.12) * rand(0.6, 1.3), rand(1.8, 2.6), rand(2.5, 5.5), kind, 1.6, 0.35,
      );
    }
  }

  // ---- building collapses (the 'cloud' layer: never thinned out by the dust budget) ----
  // Dust boiling off a falling building, anywhere from the street (c.y) up to `top`.
  collapsePlume(c, hw, hd, top, n) {
    n = Math.max(1, Math.round(n * (0.5 + this.q * 0.5)));
    const s = clamp(Math.min(hw, hd) * 0.4, 3, 9);
    for (let i = 0; i < n; i++) {
      const x = c.x + rand(-1.15, 1.15) * hw, z = c.z + rand(-1.15, 1.15) * hd;
      _v.set(x - c.x, 0, z - c.z).normalize().multiplyScalar(rand(2, 6));
      this.smoke.spawn(x, rand(c.y, top), z, _v.x, rand(0.5, 4), _v.z, s * rand(0.7, 1.2), 2.0, rand(5, 9), 'cloud', 0.8, 0.6);
    }
  }

  // The falling mass meets the street: a ring rolls out from the footprint (half sizes hw, hd)
  // and the street canyons channel fast, low billows down every side. k ~ how big the fall
  // was, share scales the count (the base keeps pulsing while the mass pours down).
  collapseSurge(c, hw, hd, k, share = 1) {
    const q = (0.5 + this.q * 0.5) * share;
    const ring = Math.max(3, Math.round((8 + k * 8) * q));
    for (let i = 0; i < ring; i++) {
      const a = (i / ring) * Math.PI * 2 + rand(-0.2, 0.2);
      const dx = Math.cos(a), dz = Math.sin(a);
      const e = 1 / Math.max(Math.abs(dx) / hw, Math.abs(dz) / hd); // out to the footprint's edge
      const sp = rand(9, 16) * (0.8 + k * 0.4);
      this.smoke.spawn(c.x + dx * e, c.y + rand(1, 4 + k * 2), c.z + dz * e, dx * sp, rand(0.5, 2.5), dz * sp,
        rand(4, 7) * (0.8 + k * 0.3), 2.2, rand(7, 12), 'cloud', 0.7, 0.25);
    }
    const lanes = Math.max(1, Math.round((2 + k * 2) * q));
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      for (let i = 0; i < lanes; i++) {
        const along = rand(-0.8, 0.8);
        const sp = rand(20, 32) * (0.8 + k * 0.25);
        this.smoke.spawn(c.x + dx * hw + dz * along * hw, c.y + rand(1, 3 + k), c.z + dz * hd + dx * along * hd,
          dx * sp + rand(-2, 2), rand(0, 1.5), dz * sp + rand(-2, 2), rand(3.5, 6) * (0.8 + k * 0.25), 2.3, rand(8, 12), 'cloud', 0.45, 0.2);
      }
    }
  }

  // Air and dust blasting out of a window as the floor above comes down on it.
  squib(pos, dir, size) {
    const sp = rand(14, 24);
    this.smoke.spawn(pos.x + dir.x, pos.y, pos.z + dir.z, dir.x * sp, rand(-1, 1.5), dir.z * sp, size, 2.4, rand(1.4, 2.4), 'cloud', 2.6, 0.5);
  }

  sparkCone(pos, dir, n, color, speed = 40, angle = 0.7, width = 0.08, len = 0.05) {
    n = Math.floor(n * (0.5 + this.q * 0.5));
    for (let i = 0; i < n; i++) {
      randomInCone(dir, angle, _v).multiplyScalar(speed * rand(0.4, 1.2));
      this.sparks.spawn(pos.x, pos.y, pos.z, _v.x, _v.y, _v.z, width * rand(0.6, 1.4), len * rand(0.7, 1.6), rand(0.15, 0.45), color, 4, 8);
    }
  }

  blood(pos, dir, n) {
    if (!G.settings.gore) return;
    n = Math.floor(n * (0.5 + this.q * 0.5));
    for (let i = 0; i < n; i++) {
      randomInCone(dir, 0.6, _v).multiplyScalar(rand(4, 16));
      _c.setRGB(rand(0.5, 0.75), 0.02, 0.04);
      this.bloodSys.spawn(pos.x, pos.y, pos.z, _v.x, _v.y + rand(0, 4), _v.z, rand(0.06, 0.2), rand(1.5, 3), _c);
    }
  }

  comic(kind, pos, size = 1, text = null) {
    this.comicText.pop(kind, pos, size, G.camera, text);
  }

  // ---- recipes ----
  // Fist/body hit on a fighter. strength 0..1+
  hit(pos, dir, strength, opts = {}) {
    const s = clamp(strength, 0.1, 2);
    const K = 5; // kaiju scale: a fist is the size of a bus
    const col = opts.color || new THREE.Color(1, 0.9, 0.55);
    // keep the flash readable instead of a white-out when the camera is close
    const camD = G.camera ? G.camera.position.distanceTo(pos) : 100;
    const near = clamp(camD / 70, 0.35, 1);
    this.shock.star(pos, (1.0 + s * 1.6) * K * near, opts.blocked ? 0x8fd1ff : 0xffffff, 0.08 + s * 0.06);
    this.shock.flash(pos, (0.6 + s * 1.4) * K * near, opts.blocked ? 0x6ab8ff : 0xfff2c0, 0.12 + s * 0.1);
    this.shock.ring(pos, dir, (2 + s * 7) * K * near, opts.blocked ? 0x9fd8ff : 0xffffff, 0.3 + s * 0.25, 0.18);
    if (s > 0.6) this.shock.ring(pos, dir, (4 + s * 12) * K * near, 0xffe6a0, 0.45 + s * 0.25, 0.08, 0.7);
    this.sparkCone(pos, dir, 14 + s * 44, col, 40 + s * 70, 0.9, 0.35 + s * 0.3, 0.05);
    // puffs only on big hits; small hits must not hide the poses
    if (s > 0.7) this.dustPuff(pos.clone().addScaledVector(dir, 8), 1.5 + s * 1.2, 1 + Math.floor(s), 'white', _v.copy(dir).multiplyScalar(20 * s), 0.25 + s * 0.15);
    if (!opts.blocked && s > 0.35) this.blood(pos, dir, 4 + s * 18);
  }

  // ---- kaiju recipes ----
  // A footfall: dust rolling out from under the foot, a cracked footprint in the asphalt, parked
  // cars bouncing (or flattened), park trees knocked flat and the base of a building giving way.
  footstep(p, k, f) {
    this.dustRing(p, 7 + k * 6, Math.round(4 + k * 4), 'dust', 0.6);
    if (k > 1.1) this.pebbleBurst(p, 8, _v.set(f.vel.x * 0.3, 8, f.vel.z * 0.3), new THREE.Color(0.42, 0.42, 0.45), 3);
    G.ground.paintScorch(p.x, p.z, 4.5, 0.55);
    G.props && G.props.explosion(p, 12 + k * 6, 6 + k * 6);
    G.props && G.props.sweep(p, _v.set(f.vel.x, -20, f.vel.z), 7, 0);
    if (G.trees) G.trees.knock(p.x, p.z, 7);
    G.debris.explosion(p, 16, 3 + k * 3, 0.5, 20);
    G.military && G.military.blast(p, 8, f, true, true); // a tank under the foot
    // stepping into a building: its ground floor caves in round the foot
    _w.set(p.x, p.y + 5, p.z);
    if (G.destruction.structsNear(_w, 7).length) G.destruction.impact({ pos: _w, radius: 7, power: 0.5, vel: _v.set(f.vel.x, -6, f.vel.z), shatter: 14, maxChunks: 14 });
  }

  // Tokusatsu pyrotechnics: spark fountains and little flashes bursting off a body on a hit.
  pyro(pos, strength = 1) {
    const s = clamp(strength, 0.3, 2.2);
    const n = 2 + Math.round(s * 2);
    for (let i = 0; i < n; i++) {
      const at = pos.clone().add(randomUnit(_w).multiplyScalar(rand(2, 7) * s));
      const d = randomUnit(_v); d.y = Math.abs(d.y) + 0.4; d.normalize();
      _c.setRGB(1, rand(0.72, 0.92), rand(0.3, 0.55));
      this.sparkCone(at, d, 16 + s * 14, _c, 35 + s * 30, 0.75, 0.4 + s * 0.2, 0.05);
      this.shock.flash(at, 2.5 + s * 3, 0xffe7a0, 0.12 + s * 0.05);
      if (s > 0.9 && Math.random() < 0.6) this.smoke.spawn(at.x, at.y, at.z, d.x * 4, 3, d.z * 4, 2 + s, 2.2, rand(1, 1.8), 'dark', 1.5, 1.4);
    }
  }

  // A ball of fire: hot core, orange billows, black smoke rising after.
  fireball(pos, size = 1, tint = null) {
    const s = clamp(size, 0.3, 3);
    this.shock.flash(pos, 6 * s, tint || 0xffd27a, 0.2 + s * 0.05);
    const n = Math.round(3 + s * 4);
    for (let i = 0; i < n; i++) {
      randomUnit(_v).multiplyScalar(rand(0.5, 1) * 4 * s);
      this.smoke.spawn(pos.x + _v.x, pos.y + _v.y, pos.z + _v.z, _v.x * 2.5, Math.abs(_v.y) * 2 + 4, _v.z * 2.5, 2.5 * s * rand(0.7, 1.2), 2.2, rand(0.6, 1.1), 'hot', 2.2, 1.5);
    }
    for (let i = 0; i < Math.round(1 + s * 2); i++) {
      randomUnit(_v).multiplyScalar(3 * s);
      this.smoke.spawn(pos.x + _v.x, pos.y + Math.abs(_v.y) + 3 * s, pos.z + _v.z, _v.x, 6 + s * 2, _v.z, 3 * s, 2.6, rand(2.5, 4.5), 'dark', 1.2, 2.5);
    }
  }

  // The big one (a kaiju going up, the finisher landing): flash, shockwaves, fire, black smoke,
  // sparks raining down, and everything around it blown outward.
  explosion(pos, size = 1, tint = null) {
    const s = clamp(size, 0.5, 3);
    const color = tint ? new THREE.Color(tint) : new THREE.Color(1, 0.75, 0.35);
    this.shock.flash(pos, 26 * s, tint || 0xfff0b0, 0.35);
    this.shock.star(pos, 30 * s, 0xffffff, 0.18);
    this.shock.ring(pos, null, 90 * s, tint || 0xffd08a, 0.7, 0.08);
    this.shock.ring(pos, G.camera ? _v.subVectors(G.camera.position, pos).normalize().clone() : null, 70 * s, 0xffffff, 0.5, 0.12);
    for (let i = 0; i < 5; i++) {
      randomUnit(_w).multiplyScalar(rand(4, 14) * s);
      this.fireball(_v.copy(pos).add(_w), s * rand(0.7, 1.1), tint);
    }
    this.sparkCone(pos, UPV, 120 * s, color, 70 + s * 30, 1.4, 0.8, 0.06);
    this.dustPuff(pos, 8 * s, 3, 'dark', _v.set(0, 12, 0), 3.5);
    G.post && G.post.flashScreen(0.35);
    G.post && G.post.kickCA(1);
    G.fightCam && G.fightCam.addTraumaAt(pos, 0.9, 700);
    G.debris.explosion(pos, 70 * s, 22 * s, 0.6);
    G.props && G.props.explosion(pos, 80 * s, 20);
    G.military && G.military.blast(pos, 34 * s);
    G.destruction.impact({ pos, radius: 6 * s, power: 1, vel: _v.set(0, 10, 0), shatter: 50 * s, maxChunks: 30 });
    this.comic('boom', pos.clone().add(_w.set(0, 20 * s, 0)), 1.4 + s * 0.3);
    G.audio && G.audio.explosion(pos, s);
  }

  // where a beam meets the street: a fountain of sparks and fire, scorch, glowing dust
  beamImpact(pos, color) {
    _c.set(color);
    this.sparkCone(pos, UPV, 26, _c, 60, 1.1, 0.7, 0.05);
    if (Math.random() < 0.6) this.fireball(pos.clone().setY(pos.y + 3), 0.9, color);
    if (Math.random() < 0.5) this.dustPuff(pos, 5, 1, 'dust', _v.set(0, 10, 0), 2);
    this.shock.flash(pos, 14, color, 0.12);
    G.ground.paintScorch(pos.x, pos.z, 7, 0.8);
  }

  // a sword cut: a bright crescent ribbon of sparks across him (side -1 / 1, or 0 for the
  // vertical finisher)
  slash(pos, dir, side, big = false) {
    const right = _w.crossVectors(dir, UPV).normalize();
    const n = big ? 40 : 22, R = big ? 26 : 18;
    _c.setRGB(0.75, 0.95, 1);
    for (let i = 0; i < n; i++) {
      const k = i / (n - 1) - 0.5;
      const at = pos.clone();
      if (side === 0) at.addScaledVector(UPV, -k * R * 2).addScaledVector(dir, -Math.abs(k) * 4);
      else at.addScaledVector(right, k * R * 2 * side).addScaledVector(UPV, -k * R * 0.8).addScaledVector(dir, -Math.abs(k) * 4);
      this.sparks.spawn(at.x, at.y, at.z, dir.x * 30 + rand(-6, 6), rand(-4, 8), dir.z * 30 + rand(-6, 6), big ? 1.6 : 1.1, 0.04, rand(0.25, 0.45), _c, 2, 4);
    }
    this.shock.ring(pos, dir, big ? 60 : 36, 0xbff4ff, 0.35, 0.1);
    this.shock.flash(pos, big ? 22 : 12, 0xe0faff, 0.16);
  }

  // a bolt of lightning out of the sky onto `to`
  lightning(from, to) {
    G.weather && G.weather.strikeAt(to);
    this.sparkCone(to, UPV, 40, new THREE.Color(0.75, 0.92, 1), 50, 1.5, 0.6, 0.05);
  }

  // Body slamming into the ground at speed. Craters, rings, dust, debris impulse.
  groundImpact(pos, speed, opts = {}) {
    const s = clamp(speed / 120, 0.1, 1.6);
    const radius = 4 + s * 15;
    const gy = G.ground.heightAt(pos.x, pos.z);
    const p = new THREE.Vector3(pos.x, gy + 0.3, pos.z);
    G.ground.crater(pos.x, pos.z, radius, 1 + s * 4.5);
    this.shock.ring(p.clone().setY(gy + 0.6), null, radius * 3.5, 0xfff0d0, 0.55 + s * 0.3, 0.12);
    this.shock.ring(p.clone().setY(gy + 1.2), null, radius * 6, 0xffffff, 0.8 + s * 0.3, 0.05, 0.6);
    this.shock.flash(p, Math.min(6, radius * 0.5), 0xfff0c0, 0.2);
    this.dustRing(p, radius * 1.4, 10 + Math.floor(s * 12), 'dust', 1.2);
    this.dustPuff(p, Math.min(9, radius * 0.4), 2 + Math.floor(s * 3), 'dust', new THREE.Vector3(0, 12 * s, 0), 2.5 + s * 1.5);
    this.pebbleBurst(p, 20 + s * 60, new THREE.Vector3(0, 14 * s, 0), new THREE.Color(0.42, 0.42, 0.45), radius * 0.25);
    this.sparkCone(p, new THREE.Vector3(0, 1, 0), 20 + s * 40, new THREE.Color(1, 0.8, 0.45), 30 + s * 40, 1.2, 0.1, 0.05);
    // asphalt slabs flipping up around the rim
    const slabs = Math.floor(3 + s * 9);
    for (let i = 0; i < slabs && G.debris.freeBudget > 20; i++) {
      const a = rand(0, Math.PI * 2), d = radius * rand(0.6, 1.1);
      const sp = new THREE.Vector3(pos.x + Math.cos(a) * d, gy + 0.5, pos.z + Math.sin(a) * d);
      const sz = new THREE.Vector3(rand(2, 4.5), rand(0.4, 0.8), rand(2, 4.5));
      G.debris.spawnBox({
        pos: sp, quat: new THREE.Quaternion().setFromEuler(new THREE.Euler(rand(-0.4, 0.4), a, rand(-0.4, 0.4))),
        size: sz, cell: sz.clone(), parent: sz.clone(), offset: new THREE.Vector3(),
        color: new THREE.Color(0.3, 0.31, 0.34), style: [0, 0, 5, 0.6],
        vel: new THREE.Vector3(Math.cos(a) * 8 * s, rand(8, 20) * s, Math.sin(a) * 8 * s),
        angvel: randomUnit(new THREE.Vector3()).multiplyScalar(rand(2, 8)),
        breakable: false,
      });
    }
    G.debris.explosion(p, radius * 3.5, 14 * s, 0.7);
    G.props && G.props.explosion(p, radius * 4.5, 16 * s);
    G.military && G.military.blast(p, radius * 1.5, null, true);
    G.destruction.impact({ pos: p, radius: radius * 0.45, power: 0.6 * s, vel: new THREE.Vector3(0, 10, 0), shatter: radius * 2.2 });
    if (!opts.quiet) this.comic('ground', p.clone().setY(gy + 3 + radius * 0.3), 0.9 + s * 0.6);
    G.audio && G.audio.groundSlam(s, p);
    G.fightCam && G.fightCam.addTraumaAt(p, 0.35 + s * 0.6, 400);
  }
}
