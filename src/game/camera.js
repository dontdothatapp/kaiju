// Lock-on fight camera at kaiju scale, with trauma shake (Eiserloh: shake = trauma^2 * noise),
// directional kick springs, FOV punches, a wider shot while you're knocked flying and a low-angle
// cinematic for the supers. The camera sits 90-150 m back at chest height; whatever stands between
// it and a fighter is cut away round him, an ink-rimmed hole (world/chunkMaterial.js), so it never
// needs to dodge buildings.
import * as THREE from 'three';
import { G } from '../core/context.js';
import { clamp, damp, noise1, lerp, UP } from '../core/math.js';

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _u = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

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
    this.lastYaw = 0;
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

  addTrauma(a) { this.trauma = clamp(this.trauma + a * G.settings.shake, 0, 1); }
  addTraumaAt(pos, a, falloff = 300) {
    const d = this.cam.position.distanceTo(pos);
    this.addTrauma(a * clamp(1 - d / falloff, 0, 1));
  }
  kick(dir, amount) { this.kickV.addScaledVector(dir, amount * 30); }
  fovKick(deg) { this.fovVel += deg * 14; }
  cinematic(a, b, dur) { this.cine = { a, b, t: 0, dur, angle: Math.random() < 0.5 ? 1 : -1 }; }

  update(realDt, dt) {
    const p = G.player, o = G.bot;
    this.t += realDt;
    const cam = this.cam;
    // 0 on landscape / square screens, 1 on a portrait phone (aspect ~0.46)
    const pk = this.portrait = clamp((0.95 - window.innerWidth / window.innerHeight) / 0.45, 0, 1);
    let desiredPos = _v, desiredLook = _w;

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
      const yaw = this.lastYaw;
      const fwd = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
      const right = new THREE.Vector3().crossVectors(fwd, UP).normalize();
      // Scale: when the fight spreads out the camera pulls back and up so the city is in shot;
      // in close, it's over the shoulder at chest height, looking up a little at the other one.
      const at = this.attention;
      const glance = at ? clamp(at.t / 0.6, 0, 1) : 0;
      if (at && (at.t -= realDt) <= 0) this.attention = null;
      const spread = Math.max(clamp((flat - 45) / 140, 0, 1), 0.85 * glance, this.air * 0.45, this.chase * 0.6);
      this.wide = damp(this.wide, spread, spread < this.wide ? 1.6 : 1.1, realDt);
      const W = this.wide;
      // portrait: further back and higher, and centred (a narrow screen has no room beside him)
      // in close the camera swings round to a three-quarter view (straight behind, a 47 m body
      // hides the other one completely); pulled back, it settles in behind the shoulder
      const back = lerp(104 + flat * 0.3, 150 + flat * 0.22, W) * (1 + 0.3 * pk * (1 - W));
      const height = lerp(5, 42, W) + 16 * pk + this.air * 18;
      const turn = lerp(0.75, 0.22, W) * (1 - 0.6 * pk);
      const behind = fwd.clone().multiplyScalar(-Math.cos(turn)).addScaledVector(right, Math.sin(turn));
      const lockPos = pc.clone().addScaledVector(behind, back).addScaledVector(UP, height).addScaledVector(right, lerp(14, 40, W) * (1 - 0.75 * pk));
      const w = flat > 160 ? 0.7 : 0.55;
      const lockLook = pc.clone().addScaledVector(UP, 3 + 8 * W).lerp(oc, w);
      if (glance > 0) lockLook.lerp(at.pos, 0.35 * glance);
      if (this.chase > 0.01) lockLook.lerp(pc, 0.3 * this.chase);
      desiredPos = lockPos; desiredLook = lockLook;
      // a heavy camera: it lags the fighters a touch, like a crane (less so while he's flying)
      const fast = Math.hypot(p.vel.x, p.vel.z) > 25 ? 9 : 5;
      this.pos.lerp(desiredPos, 1 - Math.exp(-fast * realDt));
      this.look.lerp(desiredLook, 1 - Math.exp(-8 * realDt));
      // and never lets him fill the lens: knocked back toward the camera, it backs off with him
      const dx = this.pos.x - pc.x, dz = this.pos.z - pc.z, dh = Math.hypot(dx, dz), minD = 70 * (1 + 0.3 * pk);
      if (dh < minD) {
        if (dh > 1) { this.pos.x = pc.x + (dx / dh) * minD; this.pos.z = pc.z + (dz / dh) * minD; } else this.pos.addScaledVector(behind, minD);
      }
    }
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
    const fov = this.baseFov + 20 * pk + 8 * this.wide + this.fovOff + speedFov;
    // the lift above the thumbs only matters while fighting (no controls in shots and menus)
    const lift = this.override || this.mode !== 'lock' || this.cine ? 0 : pk;
    if (pk > 0) {
      // Portrait: a wider vertical FOV keeps some sideways view, and the picture is the lower
      // part of a taller frustum, so its centre (the fight) sits d px above the screen centre,
      // clear of the thumbs. fov / aspect describe that full, taller frustum.
      const w = window.innerWidth, h = window.innerHeight, d = 0.12 * lift * h, H = h + 2 * d;
      cam.aspect = w / H;
      cam.fov = 2 * Math.atan(Math.tan(fov * Math.PI / 360) * H / h) * 180 / Math.PI;
      cam.setViewOffset(w, H, 0, 2 * d, w, h);
    } else {
      if (cam.view) { cam.clearViewOffset(); cam.aspect = window.innerWidth / window.innerHeight; }
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
      const maxA = 0.07;
      cam.rotateX(maxA * s * noise1(t));
      cam.rotateY(maxA * s * noise1(t + 37));
      cam.rotateZ(maxA * 1.4 * s * noise1(t + 71));
      cam.position.x += 2.5 * s * noise1(t + 13);
      cam.position.y += 2.5 * s * noise1(t + 23);
    }
  }
}
