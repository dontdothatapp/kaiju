// The juice director. Every hit funnels through here and a single strength value drives
// all channels at once, so a jab and a building-ending haymaker feel proportionate.
import * as THREE from 'three';
import { G } from '../core/context.js';
import { clamp } from '../core/math.js';

const _v = new THREE.Vector3();

export function screenUV(pos) {
  _v.copy(pos).project(G.camera);
  return new THREE.Vector2(_v.x * 0.5 + 0.5, _v.y * 0.5 + 0.5);
}

// strength: 0.2 (jab) .. 1 (heavy) .. 2 (charged / super finisher)
export function juiceHit(point, dir, strength, o = {}) {
  const s = clamp(strength, 0, 2.2);
  const playerInvolved = o.playerInvolved !== false;
  // 1. hitstop
  if (o.hitstop) G.time.freeze(o.hitstop);
  // 2. camera: trauma shake + directional kick + FOV punch
  if (G.fightCam) {
    G.fightCam.addTrauma(0.12 + s * 0.38);
    G.fightCam.kick(dir, 0.15 + s * 0.5);
    if (s > 0.7) G.fightCam.fovKick(4 + s * 7);
  }
  // 3. screen space
  if (G.post) {
    G.post.kickCA(0.2 + s * 0.8);
    if (s > 0.6) G.post.zoomBlur(screenUV(point), 0.25 + s * 0.45);
    if (o.impactFrame) G.post.impactFrame(s > 1.6 ? 3 : 2, Math.random() < 0.5 ? 0 : 1);
    if (o.flash) G.post.flashScreen(o.flash);
    if (o.victimIsPlayer) G.post.hurt(0.25 + s * 0.4);
  }
  // 4. world fx
  G.fx.hit(point, dir, s, { blocked: o.blocked });
  if (o.comic) G.fx.comic(o.comic, point.clone().addScaledVector(dir, -8).add(new THREE.Vector3(0, 10, 0)), 0.8 + s * 0.4);
  // 5. time
  if (o.slowmo) G.time.slowmo(o.slowmo[0], o.slowmo[1]);
  // 6. sound + rumble
  if (G.audio) G.audio.hit(o.sound || (s > 1.2 ? 'huge' : s > 0.7 ? 'heavy' : 'light'), point, o.blocked);
  if (playerInvolved && G.input) G.input.rumble(clamp(s * 0.8, 0, 1), clamp(0.3 + s * 0.5, 0, 1), 80 + s * 220);
}

// Feedback when a kaiju crashes into (or wades through) a building.
export function juiceSmash(pos, vel, chunks, first) {
  const sp = vel.length();
  const s = clamp(sp / 50, 0.2, 1.4);
  if (G.fightCam) G.fightCam.addTraumaAt(pos, (first ? 0.25 : 0.04) + s * 0.2, 400);
  if (first) {
    if (sp > 35) G.time.freeze(0.035 + s * 0.04);
    G.fx.comic('break', pos.clone().add(new THREE.Vector3(0, 12, 0)), 0.7 + s * 0.5);
    G.fx.shock.ring(pos, vel.clone().normalize(), 20 + s * 30, 0xfff3d0, 0.4, 0.15, 0.8);
    G.fx.shock.flash(pos, 6 + s * 8, 0xfff1c0, 0.14);
    if (G.post) G.post.kickCA(0.25 + s * 0.5);
    if (G.input) G.input.rumble(0.5 * s, 0.8 * s, 160);
  }
}
