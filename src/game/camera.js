// Lock-on fight camera at kaiju scale, with trauma shake (Eiserloh: shake = trauma^2 * noise),
// directional kick springs, FOV punches, a wider shot while you're knocked flying and a low-angle
// cinematic for the supers. The camera sits 90-150 m back at chest height; whatever stands between
// it and a fighter is cut away round him, an ink-rimmed hole (world/chunkMaterial.js), so it never
// has to dodge buildings. It does pick the better shoulder, though: every quarter second it
// measures how much standing building lies between each side's camera and the two of them, and
// swings round to the clearer side (and cranes up when both are walled in), so the cutaway is the
// fallback, not the usual view.
// Motion: the heading the shot is built on turns at a capped rate (the camera orbits when they
// swap sides, it doesn't cut through them), and position and aim follow on critically damped
// springs, which ease into a move where a plain exponential lerp jerks.
import * as THREE from 'three';
import { G } from '../core/context.js';
import { clamp, damp, noise1, lerp, UP } from '../core/math.js';

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _u = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _t = new THREE.Vector3();
const _f = new THREE.Vector3();
const _r = new THREE.Vector3();
const _bh = new THREE.Vector3();
const _lp = new THREE.Vector3();
const _ll = new THREE.Vector3();
const _cand = new THREE.Vector3();
// The trauma shake and the directional hit kicks play at 15% of the amplitudes they were tuned at:
// at full strength a brawl was a blur and the fight was hard to follow. The recap uses it too.
export const SHAKE_SCALE = 0.15;

const finite3 = (v) => Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// Critically damped spring toward `target` (Game Programming Gems 4, 1.10): no overshoot, and the
// velocity is continuous, so a target that jumps is eased into. smoothTime ~ time to get there.
function springTo(cur, target, vel, smoothTime, dt) {
  const omega = 2 / Math.max(1e-3, smoothTime), x = omega * dt;
  const e = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  _c.subVectors(cur, target);
  _t.copy(vel).addScaledVector(_c, omega).multiplyScalar(dt);
  vel.addScaledVector(_t, -omega).multiplyScalar(e);
  cur.copy(target).add(_c.add(_t).multiplyScalar(e));
}

// The top of what still stands of a building (a tower knocked down to a stump no longer blocks
// the view above it). Cached until it loses another chunk.
function liveTop(s) {
  if (s._topAt === s.aliveCount) return s._top;
  let y = s.ny - 1;
  while (y > 0 && s.levelAlive[y] <= 0) y--;
  s._topAt = s.aliveCount;
  return (s._top = Math.min(s.max.y, s.origin.y + (y + 1) * s.sy));
}

// Metres of standing building along the segment a -> b (each building as its box).
function blockedLength(a, b) {
  const structs = G.destruction ? G.destruction.structs : null;
  if (!structs) return 0;
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1) return 0;
  const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), z0 = Math.min(a.z, b.z), z1 = Math.max(a.z, b.z), y0 = Math.min(a.y, b.y);
  let sum = 0;
  for (let i = 0; i < structs.length; i++) {
    const s = structs[i];
    if (s.aliveCount === 0 || s.kind !== 'building') continue;
    if (x1 < s.min.x || x0 > s.max.x || z1 < s.min.z || z0 > s.max.z) continue;
    const top = liveTop(s);
    if (y0 > top) continue;
    let t0 = 0, t1 = 1;
    // slab clip against the box, axis by axis
    if (Math.abs(dx) > 1e-6) { const p = (s.min.x - a.x) / dx, q = (s.max.x - a.x) / dx; t0 = Math.max(t0, Math.min(p, q)); t1 = Math.min(t1, Math.max(p, q)); }
    if (Math.abs(dz) > 1e-6) { const p = (s.min.z - a.z) / dz, q = (s.max.z - a.z) / dz; t0 = Math.max(t0, Math.min(p, q)); t1 = Math.min(t1, Math.max(p, q)); }
    if (Math.abs(dy) > 1e-6) { const p = (s.min.y - a.y) / dy, q = (top - a.y) / dy; t0 = Math.max(t0, Math.min(p, q)); t1 = Math.min(t1, Math.max(p, q)); }
    else if (a.y > top || a.y < s.min.y) continue;
    if (t1 > t0) sum += (t1 - t0) * len;
  }
  return sum;
}

export class FightCamera {
  constructor(camera) {
    this.cam = camera;
    this.baseFov = 55;
    this.pos = new THREE.Vector3(0, 80, 200);
    this.look = new THREE.Vector3();
    this.trauma = 0;
    this.kickV = new THREE.Vector3();
    this.kickP = new THREE.Vector3();
    this.fovOff = 0;
    this.fovVel = 0;
    this.mode = 'lock';
    this.cine = null;
    this.chase = 0;
    this.air = 0;
    this.t = 0;
    this.orbit = 0;
    this.wide = 0;          // 0 over the shoulder (melee) .. 1 pulled back over the city
    this.attention = null;  // { pos, t }: glance at a collapsing building
    this.yaw = 0;           // free roam (mode 'explore'): where the camera looks
    this.pitch = -0.12;
    this.lookT = 0;         // seconds until it swings back behind his heading after a look
    this.steerT = 0;        // same, after the keys steered him round a turn
    this.lastYaw = 0;       // the heading from the player to the other one
    this.yawS = 0;          // ... as the shot uses it: turning at a capped rate
    this.yawV = 0;
    this.posV = new THREE.Vector3(); // the springs' velocities
    this.lookV = new THREE.Vector3();
    this.side = 1;          // which shoulder the camera is over (1 right, -1 left)
    this.sideS = 1;         // ... eased
    this.sideT = 0;         // seconds until the next look at which side is clearer
    this.sideWant = 0;      // seconds the other side has been the clearly better one
    this.sideHold = 0;      // seconds before it may swap again
    this.lift = 0;          // 0..1 craned up over buildings that wall in both sides
    this.liftWant = 0;
    this.koK = 0;           // 0..1 pushed in on the one going down (a KO)
    this.snap = true;       // the next lock-on frame starts from its own shot (first frame, after a shot or a menu)
  }

  // Free roam steering: left / right turn the heading (and the view) rather than sidestep.
  steer(dYaw) {
    if (Math.abs(dYaw) < 1e-5) return;
    this.yaw += dYaw;
    this.steerT = 0.2;
  }

  // Free roam: start looking the way the camera already does.
  explore() {
    const d = this.cam.getWorldDirection(_v);
    this.yaw = Math.atan2(d.x, d.z);
    this.pitch = clamp(Math.asin(d.y), -0.6, 0.3);
    this.lookT = 0;
    this.mode = 'explore';
  }

  // The direction free-roam movement (and the beam) is relative to.
  exploreDir(out) {
    return out.set(Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), Math.cos(this.yaw) * Math.cos(this.pitch));
  }

  // A building is coming down: widen and turn toward it for a moment, if it's roughly in view.
  attend(pos, seconds = 2.6) {
    _v.subVectors(pos, this.cam.position);
    if (_v.length() > 520 || _v.normalize().dot(this.cam.getWorldDirection(_w)) < -0.1) return;
    this.attention = { pos: pos.clone(), t: seconds };
  }

  // (a bad number from anywhere must not get in: trauma that is NaN stays NaN, and the picture goes black)
  addTrauma(a) { if (a > 0) this.trauma = clamp((this.trauma || 0) + a * G.settings.shake, 0, 1); }
  addTraumaAt(pos, a, falloff = 300) {
    const d = this.cam.position.distanceTo(pos);
    if (Number.isFinite(d)) this.addTrauma(a * clamp(1 - d / falloff, 0, 1));
  }
  kick(dir, amount) { if (finite3(dir) && Number.isFinite(amount)) this.kickV.addScaledVector(dir, amount * 30 * SHAKE_SCALE); }
  fovKick(deg) { if (Number.isFinite(deg)) this.fovVel += deg * 14; }

  // metres of standing building between the lens and the two of them right now (tests, tuning)
  viewBlocked() {
    const p = G.player, o = G.bot;
    if (!p || !o) return 0;
    return blockedLength(this.cam.position, _a.copy(p.pos).setY(p.pos.y + p.H * 0.2)) + blockedLength(this.cam.position, _b.copy(o.pos).setY(o.pos.y + o.H * 0.2));
  }

  // Which shoulder shows more of the fight: how much standing building lies between each side's
  // camera and the two of them. Swaps only for a clearly better view that has lasted, and not
  // again for a few seconds; walled in on both sides, it cranes up instead.
  _pickSide(pc, oc, fwd, right, back, turn, W, pk, realDt, now) {
    this.sideHold -= realDt;
    if (!now && (this.sideT -= realDt) > 0) return;
    this.sideT = 0.25;
    const score = [0, 0];
    for (let i = 0; i < 2; i++) {
      const sd = i ? -1 : 1;
      _cand.copy(pc).addScaledVector(fwd, -Math.cos(turn) * back).addScaledVector(right, (Math.sin(turn) * back + lerp(14, 40, W) * (1 - 0.75 * pk)) * sd);
      _cand.y += lerp(5, 42, W) + 16 * pk;
      score[i] = blockedLength(_cand, pc) + 0.8 * blockedLength(_cand, oc);
    }
    const cur = score[this.side > 0 ? 0 : 1], other = score[this.side > 0 ? 1 : 0];
    this.liftWant = clamp((Math.min(cur, other) - 18) / 70, 0, 1);
    const better = cur - other > 24 + other * 0.4;
    if (now) { if (cur - other > 6) { this.side = -this.side; } this.sideWant = 0; this.sideHold = 3; return; }
    this.sideWant = better ? this.sideWant + 0.25 : 0;
    if (this.sideWant >= 0.75 && this.sideHold <= 0) { this.side = -this.side; this.sideWant = 0; this.sideHold = 5; }
  }
  cinematic(a, b, dur) { this.cine = { a, b, t: 0, dur, angle: Math.random() < 0.5 ? 1 : -1 }; }
  // the next lock-on frame jumps straight to its shot instead of craning over (a skipped opener)
  cut() { this.cutNext = true; }

  update(realDt, dt) {
    const p = G.player, o = G.bot;
    this.t += realDt;
    const cam = this.cam;
    // (a window with no size for a moment: minimised, a hidden pane, mid-rotation. 0 / 0 here
    // once put a NaN into the camera for good)
    const vw = Math.max(1, window.innerWidth), vh = Math.max(1, window.innerHeight);
    // 0 on landscape / square screens, 1 on a portrait phone (aspect ~0.46)
    const pk = this.portrait = clamp((0.95 - vw / vh) / 0.45, 0, 1);
    let desiredPos = _v, desiredLook = _w;
    const lock = !this.override && this.mode === 'lock' && !!p && !this.cine;
    if (!lock) this.snap = true; // back from a shot, a menu or the super: the springs start from rest

    if (this.override) {
      this.pos.copy(this.override.pos);
      this.look.copy(this.override.look);
    } else if (this.mode === 'orbit' || !p) {
      // title / attract mode: a slow helicopter orbit over the arena
      this.orbit += realDt * 0.05;
      const c = this.orbitCenter || _u.set(0, 40, 0);
      desiredPos.set(c.x + Math.cos(this.orbit) * 260, c.y + 120 + Math.sin(this.orbit * 0.7) * 25, c.z + Math.sin(this.orbit) * 260);
      desiredLook.copy(c);
      this.pos.lerp(desiredPos, 1 - Math.exp(-2 * realDt));
      this.look.lerp(desiredLook, 1 - Math.exp(-2 * realDt));
    } else if (this.mode === 'explore') {
      // rampage after the match: a chase camera behind him. Drag (or the right stick) looks
      // around; let go and it swings back in behind wherever he's walking.
      const inp = G.input;
      if (inp.look.x || inp.look.y || inp.lookRate) {
        this.yaw -= inp.look.x * 0.0045 + inp.lookRate * 2.4 * realDt;
        this.pitch = clamp(this.pitch - inp.look.y * 0.0035, -0.75, 0.35);
        this.lookT = 1.2;
      }
      this.lookT -= realDt; this.steerT -= realDt;
      const hv = Math.hypot(p.vel.x, p.vel.z);
      if (this.lookT <= 0 && this.steerT <= 0 && hv > 4 && p.state !== 'beam') {
        let d = Math.atan2(p.vel.x, p.vel.z) - this.yaw;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        this.yaw += d * (1 - Math.exp(-2 * realDt * clamp(hv / 15, 0.25, 1)));
      }
      const fwd = this.exploreDir(_u);
      const flat = _a.set(fwd.x, 0, fwd.z).normalize();
      const chest = _b.copy(p.pos).setY(p.pos.y + p.H * 0.25);
      desiredPos.copy(chest).addScaledVector(flat, -78).addScaledVector(UP, 26 - fwd.y * 60);
      desiredLook.copy(chest).addScaledVector(fwd, 70);
      this.pos.lerp(desiredPos, 1 - Math.exp(-5 * realDt));
      this.look.lerp(desiredLook, 1 - Math.exp(-8 * realDt));
    } else if (this.cine) {
      // the super: a low angle from the street, side-on to both of them, slowly pushing round
      const c = this.cine;
      c.t += realDt;
      const mid = _u.copy(c.a.pos).lerp(c.b.pos, 0.5);
      const ab = _w.subVectors(c.b.pos, c.a.pos).setY(0).normalize();
      const side = _a.crossVectors(ab, UP).normalize().multiplyScalar(c.angle);
      const swing = c.t * 0.22;
      desiredPos = new THREE.Vector3().copy(mid).addScaledVector(side, 100 - swing * 25).addScaledVector(ab, -30 + swing * 45);
      desiredPos.y = G.ground.heightAt(desiredPos.x, desiredPos.z) + 14 + swing * 10;
      desiredLook = mid.clone().add(new THREE.Vector3(0, 14, 0));
      this.pos.lerp(desiredPos, 1 - Math.exp(-6 * realDt));
      this.look.lerp(desiredLook, 1 - Math.exp(-10 * realDt));
      if (c.t > c.dur || (c.a.state !== 'super')) this.cine = null;
    } else {
      // knocked flying: the camera pulls up and back to take in where he lands (it doesn't swing
      // round behind him: at this scale the swing would pass through his body)
      const launched = p.state === 'launched' && p.vel.length() > 25;
      this.chase = damp(this.chase, launched ? 1 : 0, launched ? 5 : 2.5, realDt);
      const air = p.state === 'jump' || p.state === 'dive' || o.state === 'jump' || o.state === 'dive';
      this.air = damp(this.air, air ? 1 : 0, 2.2, realDt);
      const pc = _a.copy(p.pos).setY(p.pos.y + p.H * 0.2);
      const oc = _b.copy(o.pos).setY(o.pos.y + o.H * 0.2);
      const to = _u.subVectors(oc, pc);
      const flat = Math.hypot(to.x, to.z);
      if (flat > 2) this.lastYaw = Math.atan2(to.x, to.z);
      const cut = this.cutNext, fresh = cut || this.snap;
      // The heading the shot is built on follows theirs at a capped rate: when they swap sides (a
      // leap over him, a throw) the camera orbits round, it doesn't fly straight through them.
      if (fresh) { this.yawS = this.lastYaw; this.yawV = 0; }
      else {
        // a spring on the angle; quicker when they're far apart (a step sideways turns it less),
        // and never faster than 2.6 rad/s (the error it chases is capped)
        const st = lerp(0.42, 0.24, clamp(flat / 160, 0, 1)), om = 2 / st, x = om * realDt;
        const e = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
        const err = clamp(wrapPi(this.lastYaw - this.yawS), -2.6 * st, 2.6 * st);
        const goal = this.yawS + err;
        const tmp = (this.yawV - om * err) * realDt;
        this.yawV = (this.yawV - om * tmp) * e;
        this.yawS = wrapPi(goal - (err - tmp) * e);
        if (!Number.isFinite(this.yawS) || !Number.isFinite(this.yawV)) { this.yawS = this.lastYaw; this.yawV = 0; }
      }
      const yaw = this.yawS;
      const fwd = _f.set(Math.sin(yaw), 0, Math.cos(yaw));
      const right = _r.crossVectors(fwd, UP).normalize();
      // Scale: when the fight spreads out the camera pulls back and up so the city is in shot;
      // in close, it's over the shoulder at chest height, looking up a little at the other one.
      const at = this.attention;
      const glance = at ? clamp(at.t / 0.6, 0, 1) : 0;
      if (at && (at.t -= realDt) <= 0) this.attention = null;
      // (a beam clash gets the room too: both of them and the ball of light between)
      const spread = Math.max(clamp((flat - 45) / 140, 0, 1), 0.85 * glance, this.air * 0.45, this.chase * 0.6, p.clash ? 0.6 : 0);
      this.wide = fresh ? spread : damp(this.wide, spread, spread < this.wide ? 1.6 : 1.1, realDt);
      const W = this.wide;
      // a KO: push in on the one going down while the world runs slow
      const ko = G.game && G.game.state === 'ko';
      this.koK = fresh ? 0 : damp(this.koK, ko ? 1 : 0, ko ? 2.2 : 3, realDt);
      const K = this.koK * (1 - 0.6 * this.chase);
      // portrait: further back and higher, and centred (a narrow screen has no room beside him)
      // in close the camera swings round to a three-quarter view (straight behind, a 47 m body
      // hides the other one completely); pulled back, it settles in behind the shoulder
      const back = lerp(94 + flat * 0.32, 150 + flat * 0.22, W) * (1 + 0.3 * pk * (1 - W)) * (1 - 0.14 * K);
      const turn = lerp(0.75, 0.22, W) * (1 - 0.6 * pk);
      // the clearer shoulder, and a crane up when neither is
      this._pickSide(pc, oc, fwd, right, back, turn, W, pk, realDt, fresh);
      this.sideS = fresh ? this.side : damp(this.sideS, this.side, 2.6, realDt);
      this.lift = fresh ? this.liftWant : damp(this.lift, this.liftWant, this.liftWant > this.lift ? 1.4 : 0.8, realDt);
      const S = this.sideS;
      // (crossing over behind him, it rises to look over his shoulder instead of into his back)
      const height = lerp(5, 42, W) + 16 * pk + this.air * 18 + this.lift * 30 * (1 - 0.5 * W) + (1 - S * S) * 20 * (1 - W);
      const behind = _bh.copy(fwd).multiplyScalar(-Math.cos(turn)).addScaledVector(right, Math.sin(turn) * S);
      const lockPos = _lp.copy(pc).addScaledVector(behind, back).addScaledVector(UP, height).addScaledVector(right, lerp(14, 40, W) * (1 - 0.75 * pk) * S);
      const w = flat > 160 ? 0.7 : 0.55;
      const lockLook = _ll.copy(pc).addScaledVector(UP, 3 + 8 * W).lerp(oc, w);
      if (glance > 0) lockLook.lerp(at.pos, 0.35 * glance);
      if (this.chase > 0.01) lockLook.lerp(pc, 0.3 * this.chase);
      if (K > 0.01) {
        const down = p.ko || p.hp <= 0 ? p : o;
        lockLook.lerp(_c.copy(down.pos).setY(down.pos.y + down.H * 0.1), 0.45 * K);
      }
      desiredPos = lockPos; desiredLook = lockLook;
      // a heavy camera: it lags the fighters a touch, like a crane (less so while he's flying)
      if (fresh && (cut || !finite3(this.pos) || !finite3(this.look))) { this.pos.copy(desiredPos); this.look.copy(desiredLook); }
      if (fresh) { this.posV.set(0, 0, 0); this.lookV.set(0, 0, 0); }
      const fast = Math.hypot(p.vel.x, p.vel.z) > 25;
      springTo(this.pos, desiredPos, this.posV, fast ? 0.2 : 0.34, realDt);
      springTo(this.look, desiredLook, this.lookV, 0.2, realDt);
      this.cutNext = false; this.snap = false;
      // and never lets him fill the lens: knocked back toward the camera, it backs off with him
      const dx = this.pos.x - pc.x, dz = this.pos.z - pc.z, dh = Math.hypot(dx, dz), minD = 70 * (1 + 0.3 * pk);
      if (dh < minD) {
        if (dh > 1) { this.pos.x = pc.x + (dx / dh) * minD; this.pos.z = pc.z + (dz / dh) * minD; } else this.pos.addScaledVector(behind, minD);
      }
    }
    // whatever went wrong upstream, the camera recovers: a NaN here would be a black screen for good
    if (!finite3(this.pos) || !finite3(this.look)) {
      if (finite3(desiredPos) && finite3(desiredLook)) { this.pos.copy(desiredPos); this.look.copy(desiredLook); }
      else { this.pos.set(0, 80, 200); this.look.set(0, 20, 0); }
      this.posV.set(0, 0, 0); this.lookV.set(0, 0, 0);
    }
    if (!finite3(this.kickP) || !finite3(this.kickV)) { this.kickP.set(0, 0, 0); this.kickV.set(0, 0, 0); }
    if (!Number.isFinite(this.fovOff) || !Number.isFinite(this.fovVel)) { this.fovOff = 0; this.fovVel = 0; }
    if (!Number.isFinite(this.trauma)) this.trauma = 0;
    // keep above the street (and out of the rubble mounds)
    const gh = G.ground.heightAt(this.pos.x, this.pos.z) + 4;
    if (this.pos.y < gh) this.pos.y = gh;

    // kick spring
    this.kickV.addScaledVector(this.kickP, -120 * realDt);
    this.kickV.multiplyScalar(Math.exp(-12 * realDt));
    this.kickP.addScaledVector(this.kickV, realDt);
    // fov spring
    this.fovVel += -this.fovOff * 160 * realDt;
    this.fovVel *= Math.exp(-14 * realDt);
    this.fovOff += this.fovVel * realDt;
    const speedFov = p ? clamp((p.vel.length() - 30) / 60, 0, 1) * 8 : 0;
    const fov = this.baseFov + 20 * pk + 8 * this.wide + this.fovOff + speedFov - (lock ? 5 * this.koK : 0);
    // the lift above the thumbs only matters while fighting (no controls in shots and menus)
    const lift = lock ? pk : 0;
    if (pk > 0) {
      // Portrait: a wider vertical FOV keeps some sideways view, and the picture is the lower
      // part of a taller frustum, so its centre (the fight) sits d px above the screen centre,
      // clear of the thumbs. fov / aspect describe that full, taller frustum.
      const w = vw, h = vh, d = 0.12 * lift * h, H = h + 2 * d;
      cam.aspect = w / H;
      cam.fov = 2 * Math.atan(Math.tan(fov * Math.PI / 360) * H / h) * 180 / Math.PI;
      cam.setViewOffset(w, H, 0, 2 * d, w, h);
    } else {
      if (cam.view) cam.clearViewOffset();
      cam.aspect = vw / vh; // (also heals an aspect a zero-size resize left as NaN)
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }

    cam.position.copy(this.pos).add(this.kickP);
    cam.lookAt(this.look);
    // trauma shake: rotational + a little positional, continues during hitstop (real time)
    this.trauma = Math.max(0, this.trauma - realDt * 1.3);
    const s = this.trauma * this.trauma;
    if (s > 0) {
      const t = this.t * 24;
      const maxA = 0.07 * SHAKE_SCALE, maxP = 2.5 * SHAKE_SCALE;
      cam.rotateX(maxA * s * noise1(t));
      cam.rotateY(maxA * s * noise1(t + 37));
      cam.rotateZ(maxA * 1.4 * s * noise1(t + 71));
      cam.position.x += maxP * s * noise1(t + 13);
      cam.position.y += maxP * s * noise1(t + 23);
    }
  }
}
