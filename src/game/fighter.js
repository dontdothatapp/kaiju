// Fighter: one kaiju. Walking with gravity (every footfall a small quake), running through
// buildings, leaps and slams, stomps, beams, grapples and supers; hit reactions, knockdowns
// through the skyline and getting back up out of the rubble.
import * as THREE from 'three';
import { G } from '../core/context.js';
import { CharacterModel } from './character.js';
import { movesFor, SPEED, BEAM } from './moves.js';
import { juiceHit, juiceSmash } from './juice.js';
import { Trail } from '../fx/trail.js';
import { clamp, damp, rand, chance, UP, randomUnit } from '../core/math.js';
import { ARENA } from '../world/boundary.js';
import { AudioEngine } from '../core/audio.js';

// voice line and the odds of saying it as each move starts (see Fighter.startMove)
const SHOUTS = {
  jab: ['attack_light', 0.35], cross: ['attack_light', 0.35], hook: ['attack_mid', 0.6],
  smash: ['attack_heavy', 1], heavy: ['attack_heavy', 1], tackle: ['attack_heavy', 0.8],
  stomp: ['attack_heavy', 0.7], uppercut: ['attack_heavy', 0.8], superRush: ['super_start', 1],
};
// states in which he stands on his own feet (the walk cycle runs, footfalls quake)
const STANDING = new Set(['free', 'block', 'charge', 'attack', 'dash', 'beam', 'grabbing', 'super', 'hitstun', 'stagger', 'intro', 'landed', 'taunt']);

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _u = new THREE.Vector3();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _e = new THREE.Euler();

export class Controller {
  constructor() {
    this.move = new THREE.Vector3();
    this.vert = 0;
    this._p = new Set(); this._h = new Set(); this._r = new Set();
  }
  pressed(a) { return this._p.has(a); }
  held(a) { return this._h.has(a); }
  released(a) { return this._r.has(a); }
  clearEdges() { this._p.clear(); this._r.clear(); }
  press(a) { if (!this._h.has(a)) this._p.add(a); this._h.add(a); }
  release(a) { if (this._h.has(a)) this._r.add(a); this._h.delete(a); }
  tap(a) { this._p.add(a); }
}

export class Fighter {
  constructor(id, def, opts = {}) {
    this.id = id;
    this.def = def;
    this.name = def.display;
    this.moves = movesFor(def);
    this.model = new CharacterModel(G.scene, def);
    this.model.onStep = (side, a) => this._footstep(side, a);
    this.S = def.scale;
    this.R = def.radius;           // body radius (m)
    this.H = def.height;           // standing height (m)
    this.hipH = def.hip * def.scale; // pelvis above the street
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.quat = new THREE.Quaternion();
    this.yaw = 0;
    this.ctrl = new Controller();
    this.maxHp = opts.hp ?? 100;
    this.hp = this.maxHp;
    this.meter = 0;
    this.beamE = 1;                // beam gauge, 0..1 (refills over BEAM.recharge)
    this.power = opts.power ?? 1;  // damage multiplier
    this.state = 'free';
    this.stateT = 0;
    this.move = null;
    this.moveT = 0;
    this.moveHit = false;
    this.charge = 0;
    this.buffer = null;
    this.invuln = 0;
    this.blockPressT = 99;
    this.comboTaken = 0;
    this.comboTimer = 0;
    this.launchSmashCount = 0;
    this.launchDamage = 0;
    this.grounded = true;
    this.running = false;
    this.spinYaw = 0;              // the tail whip's extra turn
    this.tilt = 0;                 // falling over backwards when launched
    this.grab = null;
    this.ko = false;
    this.lastSmashStruct = -1;
    this.booms = [];               // delayed explosions (the finisher's "and then he blows up")
    this.trailL = new Trail(G.scene, { width: 4.5, color: 0xfff6d8, life: 0.16 });
    this.trailR = new Trail(G.scene, { width: 4.5, color: 0xfff6d8, life: 0.16 });
    this.trailBody = new Trail(G.scene, { width: 14, color: def.trail || 0xbfe3ff, life: 0.4, points: 40 });
    this.kin = G.physics.kinematicCapsule(this.H * 0.32, this.R * 0.85);
    this.taunting = 0;
    this.lastHitBy = null;
    this.stats = { dealt: 0, hits: 0, maxCombo: 0 };
  }

  get opp() { return this.opponent; }
  get center() { return _u.copy(this.pos).add(_w.set(0, this.H * 0.18, 0)); }
  hurtCenter(out) { return out.copy(this.pos).add(_w.set(0, this.H * 0.18, 0)); }
  get alive() { return this.hp > 0; }
  get canAct() { return this.state === 'free' || this.state === 'block'; }
  get airborneLaunch() { return this.state === 'launched'; }
  get floorY() { return G.ground.heightAt(this.pos.x, this.pos.z) + this.hipH; }

  reset(pos, faceTo) {
    // a beam or a charge still going from last round stops here
    if (this.state === 'beam') this._beamEnd();
    G.audio && G.audio.chargeStop(this);
    this.pos.copy(pos);
    this.vel.set(0, 0, 0);
    this.hp = this.maxHp;
    this.beamE = 1;
    this.state = 'free'; this.stateT = 0; this.move = null;
    this.ko = false; this.grab = null; this.invuln = 0.5; this.charge = 0;
    this.comboTaken = 0; this.spinYaw = 0; this.tilt = 0; this.booms.length = 0;
    this.boomed = false;
    this.model.setAction(null, 30);
    this.model.setDamage(0);
    this.model.glow = 0; this.model.thrust = 0;
    this.model.showSword(false);
    this.model.root.position.copy(pos);
    _v.subVectors(faceTo, pos); _v.y = 0;
    this.yaw = Math.atan2(_v.x, _v.z);
    this.quat.setFromAxisAngle(UP, this.yaw);
    this.model.root.quaternion.copy(this.quat);
    this.trailBody.clear(); this.trailL.clear(); this.trailR.clear();
  }

  setState(s) {
    this.state = s;
    this.stateT = 0;
  }

  // gone from the scene and the physics world (the title's kaiju picker swaps fighters)
  dispose() {
    G.scene.remove(this.model.root);
    for (const t of [this.trailL, this.trailR, this.trailBody]) G.scene.remove(t.mesh);
    G.physics.world.removeRigidBody(this.kin);
    G.fx.beam.off(this.id);
  }

  // a voice line from public/sfx/voices/<voice>/ (AudioEngine.VOICE lists them); GORRAX uses the
  // deep voice pitched way down, so his lines come out as growls and roars
  shout(line, { odds = 1, ...opts } = {}) {
    if (odds < 1 && Math.random() > odds) return;
    const who = this.def.voice;
    G.audio && G.audio.voice(`vo_${who}_${line}`, this.pos, { who: this.def.name, prio: AudioEngine.VOICE[line], rate: this.def.voiceRate, ...opts });
  }

  // ---------------------------------------------------------------- update
  update(dt, realDt) {
    const frozen = dt <= 0;
    if (!frozen) {
      this.stateT += dt;
      this.invuln = Math.max(0, this.invuln - dt);
      this.blockPressT += dt;
      this.comboTimer -= dt;
      if (this.comboTimer <= 0) this.comboTaken = 0;
      if (this.state !== 'beam') this.beamE = Math.min(1, this.beamE + dt / BEAM.recharge);
      if (this.ctrl.pressed('block')) this.blockPressT = 0;
      this._buffer();
      this._think(dt);
      this._integrate(dt);
      this._booms(dt);
    }
    this._orient(dt, realDt);
    this.model.root.position.copy(this.pos);
    const standing = this.grounded && STANDING.has(this.state);
    this.model.update(dt, realDt, this.vel, frozen, standing);
    this.kin.setNextKinematicTranslation({ x: this.pos.x, y: this.pos.y + this.H * 0.12, z: this.pos.z });
    this._trails();
    // inputs pressed during hitstop stay queued until the world unfreezes
    if (!frozen) this.ctrl.clearEdges();
  }

  _buffer() {
    for (const a of ['light', 'heavy', 'grab', 'super', 'dash', 'up', 'down', 'rise']) {
      if (this.ctrl.pressed(a)) this.buffer = { a, t: 0.24 };
    }
    if (this.buffer) { this.buffer.t -= 1 / 60; if (this.buffer.t <= 0) this.buffer = null; }
  }

  _consume(a) {
    if (this.buffer && this.buffer.a === a) { this.buffer = null; return true; }
    return false;
  }

  // 3D direction to the opponent's chest
  dirToOpp(out) {
    out.subVectors(this.opp.pos, this.pos);
    const l = out.length();
    if (l < 1e-3) out.set(0, 0, 1); else out.divideScalar(l);
    return out;
  }

  // where his attacks go: at the opponent, or (rampaging after the match) straight ahead
  aimDir(out) {
    if (this.exploring || !this.opp) return out.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    out.subVectors(this.opp.pos, this.pos).setY(0);
    const l = out.length();
    if (l < 1e-3) out.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)); else out.divideScalar(l);
    return out;
  }

  flatDist(o) { return Math.hypot(o.pos.x - this.pos.x, o.pos.z - this.pos.z); }

  _think(dt) {
    switch (this.state) {
      case 'free': this._free(dt); break;
      case 'dash': this._dash(dt); break;
      case 'jump': this._jump(dt); break;
      case 'dive': this._dive(dt); break;
      case 'attack': this._attack(dt); break;
      case 'charge': this._charge(dt); break;
      case 'block': this._block(dt); break;
      case 'beam': this._beam(dt); break;
      case 'hitstun': this._hitstun(dt); break;
      case 'stagger': if (this.stateT > this.staggerT) this.setState('free'); this._friction(dt, 5); break;
      case 'launched': this._launched(dt); break;
      case 'down': this._down(dt); break;
      case 'getup': this._getup(dt); break;
      case 'grabbing': this._grabbing(dt); break;
      case 'grabbed': break; // driven by the grabber
      case 'super': this._super(dt); break;
      case 'superVictim': break;
      case 'ko': this._ko(dt); break;
      case 'taunt': this._friction(dt, 6); if (this.stateT > this.tauntT) { this.setState('free'); this.model.setAction(null, 8); } break;
      case 'intro': this._friction(dt, 4); break;
      case 'land': this._land(dt); break;
      case 'landed': this.vel.x = 0; this.vel.z = 0; break;
    }
  }

  _friction(dt, k) { const f = Math.exp(-k * dt); this.vel.x *= f; this.vel.z *= f; }

  // Round-intro arrival (game/intro.js): dropped out of the sky, feet first, into a crater.
  _land(dt) {
    this.vel.y = Math.max(this.vel.y - 60 * dt, -110);
    this._friction(dt, 3);
    if (this.def.rig === 'mech') this.model.thrust = this.vel.y > -60 ? 1 : 0.4;
  }

  // ---------------------------------------------------------------- free movement
  _free(dt) {
    const c = this.ctrl;
    const moving = c.move.lengthSq() > 0.04;
    const running = c.held('dash') && moving && this.stateT > 0.05 && this.grounded;
    const speed = running ? SPEED.run : this.def.walk;
    _v.copy(c.move).setY(0);
    if (_v.lengthSq() > 1) _v.normalize();
    _v.multiplyScalar(speed);
    // mass: they get going slowly and stop slowly
    const k = running ? 1.8 : _v.lengthSq() > 1 ? 4 : 5;
    this.vel.x = damp(this.vel.x, _v.x, k, dt);
    this.vel.z = damp(this.vel.z, _v.z, k, dt);
    if (this.running && !running) G.audio && G.audio.skid(Math.hypot(this.vel.x, this.vel.z), this.pos);
    this.running = running;
    if (!this.grounded) return;

    if (this.taunting > 0) this.taunting -= dt;
    // actions (buffered)
    if (this._consume('super') && this.meter >= 100) return this.startMove('superRush');
    if (this._consume('grab')) return this.startMove('grab');
    if (this._consume('light')) return this.startMove(running && Math.hypot(this.vel.x, this.vel.z) > 20 ? 'tackle' : 'jab');
    if (this._consume('down')) return this.startMove('stomp');
    if (this._consume('rise')) return this.beamStart();
    if (this.ctrl.pressed('heavy') || (this.buffer && this.buffer.a === 'heavy' && c.held('heavy'))) {
      this.buffer = null;
      if (running && Math.hypot(this.vel.x, this.vel.z) > 20) return this.startMove('tackle');
      this.setState('charge');
      this.charge = 0;
      G.audio && G.audio.chargeStart(this);
      this.shout('charge');
      return;
    }
    if (this._consume('up')) return this.jump();
    if (this._consume('dash')) return this.sidestep();
    if (c.held('block')) { this.setState('block'); return; }
  }

  // tap DASH: a heavy hop to the side (or back), a moment of invulnerability
  sidestep() {
    const c = this.ctrl;
    const d = c.move.lengthSq() > 0.04 ? _w.copy(c.move).setY(0).normalize() : this.aimDir(_w).negate();
    this.vel.set(d.x * SPEED.dash, 7, d.z * SPEED.dash);
    this.invuln = Math.max(this.invuln, 0.24);
    this.setState('dash');
    this.grounded = false;
    G.audio && G.audio.whoosh(0.8, this.pos);
    this.shout('dash', { odds: 0.35 });
    G.fx.dustRing(_v.copy(this.pos).setY(this.floorY - this.hipH), 14, 8);
    if (this.def.rig === 'mech') this.model.thrust = 0.7;
  }

  _dash(dt) {
    this._friction(dt, 2.4);
    if (this.stateT > 0.34 && this.grounded) { this.setState('free'); this.model.thrust = 0; }
  }

  // ---------------------------------------------------------------- leaping
  jump() {
    if (!this.grounded) return;
    this.setState('jump');
    const c = this.ctrl;
    this.vel.x = this.vel.x * 0.7 + c.move.x * 10;
    this.vel.z = this.vel.z * 0.7 + c.move.z * 10;
    this.vel.y = SPEED.jump * (this.def.rig === 'mech' ? 1.05 : 0.95);
    this.grounded = false;
    const gp = _p.copy(this.pos).setY(this.floorY - this.hipH);
    G.fx.dustRing(gp, 22, 14);
    G.fx.shock.ring(gp.clone().setY(gp.y + 1), null, 40, 0xfff0d0, 0.5, 0.1, 0.7);
    if (this.def.rig === 'mech') { this.model.thrust = 1.2; G.fx.sparkCone(gp, UP, 40, new THREE.Color(1, 0.7, 0.3), 30, 1.2, 0.5, 0.06); }
    G.ground.paintScorch(gp.x, gp.z, 9, 0.5);
    G.audio && G.audio.whoosh(1, this.pos);
    G.audio && G.audio.groundSlam(0.35, gp);
    this.shout('skyward', { odds: 0.7 });
    if (this === G.player) { G.fightCam.fovKick(4); G.fightCam.addTrauma(0.25); }
  }

  _jump(dt) {
    const c = this.ctrl;
    // a little air control (the robot steers with its thrusters)
    const ac = this.def.rig === 'mech' ? 18 : 11;
    this.vel.x = damp(this.vel.x, c.move.x * ac, 1.2, dt);
    this.vel.z = damp(this.vel.z, c.move.z * ac, 1.2, dt);
    if (this.def.rig === 'mech') this.model.thrust = this.vel.y > 0 ? 1 : 0.35;
    if (this.stateT > 0.18 && (this._consume('light') || this._consume('heavy'))) return this.dive();
  }

  // the slam: straight at him from above, committed on the way in
  dive() {
    this.setState('dive');
    const to = this.opp && !this.exploring ? this.opp.hurtCenter(_w).sub(this.pos).normalize() : this.aimDir(_w).setY(-0.8).normalize();
    this.vel.copy(to).multiplyScalar(SPEED.dive * 0.55);
    this.vel.y = Math.min(this.vel.y, -12);
    G.audio && G.audio.whoosh(1, this.pos);
    G.fx.shock.ring(this.pos.clone(), to.clone(), 30, 0xfff0c0, 0.4, 0.15);
    this.shout('skydive', { duck: 0.2 });
    G.fx.comic('dive', this.pos.clone().add(_w.set(0, this.H * 0.5, 0)), 1, this.def.diveName);
  }

  _dive(dt) {
    const o = this.opp;
    if (o && !this.exploring) {
      const to = o.hurtCenter(_v).sub(this.pos);
      const dist = to.length();
      to.divideScalar(dist || 1);
      // steers hard from far away, barely over the last 40 m: a late sidestep makes it miss
      this.vel.lerp(to.multiplyScalar(SPEED.dive), 1 - Math.exp(-(dist > 40 ? 4 : 1) * dt));
      this.vel.y = Math.min(this.vel.y, -10);
      if (dist < this.moves.diveSlam.range && o.alive) return this.startMove('diveSlam', { charge: 1 });
    } else {
      this.vel.y = Math.min(this.vel.y, -SPEED.dive * 0.7);
    }
    if (this.def.rig === 'mech') this.model.thrust = 1;
    if (this === G.player) G.post.speedTarget = 0.8;
    if (this.stateT > 3) this.setState('jump');
  }

  _block(dt) {
    this._friction(dt, 6);
    _v.copy(this.ctrl.move).setY(0).multiplyScalar(5);
    this.vel.x += _v.x * dt * 3; this.vel.z += _v.z * dt * 3;
    if (!this.ctrl.held('block')) this.setState('free');
    if (this._consume('grab')) this.startMove('grab');
  }

  // ---------------------------------------------------------------- attacks
  startMove(name, extra = {}) {
    const m = this.moves[name];
    // a grunt on some jabs and most hooks, every heavy; the super's scream is a warning even when
    // the lunge misses (charged moves shout on release, grabs when they connect)
    const line = SHOUTS[name];
    if (line) this.shout(line[0], { odds: line[1], ...(name === 'superRush' ? { duck: 0.45, hold: 1.1 } : {}) });
    this.move = { name, def: m, ...extra };
    this.moveT = 0;
    this.moveHit = false;
    this.moveWhiffed = false;
    this.setState('attack');
    this.model.setAction(m.pose[0], name === 'tackle' || name === 'diveSlam' ? 40 : 16);
    if (m.side === 'L') this.trailL.emitting = true; else this.trailR.emitting = true;
    G.audio && G.audio.swing(m.fx, this.pos);
    if (name === 'tackle') this.yaw = Math.atan2(this.vel.x, this.vel.z);
  }

  _moveVal(key) {
    const m = this.move.def;
    const ch = this.move.charge || 0;
    return (m[key] || 0) + (m[key + 'Charge'] || 0) * ch;
  }

  _attack(dt) {
    const mv = this.move;
    const m = mv.def;
    this.moveT += dt;
    const t = this.moveT;
    const o = this.opp;
    const toOpp = this.aimDir(_w);
    const dist = o && !this.exploring ? this.flatDist(o) : 999;
    const tackle = mv.name === 'tackle';
    if (t < m.startup) {
      // lunge-homing: close the gap during the wind-up (a tackle keeps its run instead)
      if (tackle) {
        _v.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)).multiplyScalar(SPEED.run);
      } else {
        const lunge = this._moveVal('lunge');
        const want = clamp(dist - (this.R + (o ? o.R : 8) + 4), 0, lunge);
        const remaining = Math.max(0.016, m.startup - t);
        _v.copy(toOpp).multiplyScalar(this.exploring ? lunge * 0.4 / m.startup : want / remaining);
      }
      this.vel.x = damp(this.vel.x, _v.x, 14, dt);
      this.vel.z = damp(this.vel.z, _v.z, 14, dt);
      if (mv.name === 'stomp') this.model.glow = Math.max(this.model.glow, 0);
    } else if (t < m.startup + m.active) {
      if (!mv.started) {
        mv.started = true;
        this.model.setAction(m.pose[1], 60);
        if (m.side) this.model.smear(m.side, 1);
        if (m.quake) this._quake(m);
      }
      if (m.spin) this.spinYaw = Math.PI * 2 * clamp((t - m.startup) / m.active, 0, 1);
      if (tackle) {
        _v.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)).multiplyScalar(SPEED.run * 1.15);
        this.vel.x = _v.x; this.vel.z = _v.z;
      } else this._friction(dt, 6);
      this._limbSweep(m, mv);
      if (!this.moveHit && !this.exploring && !m.quake) this._tryHit(dist, toOpp);
    } else {
      this._friction(dt, 5);
      if (m.spin) this.spinYaw = 0;
      if (!mv.recover) {
        mv.recover = true;
        this.trailL.emitting = false; this.trailR.emitting = false;
        if (!this.moveHit && !this.moveWhiffed) { this.moveWhiffed = true; this._whiff(); }
      }
      const rel = t - m.startup - m.active;
      // combo chaining
      if (m.next && rel < m.chain && (this.moveHit || rel > 0.02)) {
        if (this._consume('light')) return this.startMove(m.next);
        if (this.moveHit && this.buffer && this.buffer.a === 'heavy') { this.buffer = null; return this.startMove('uppercut'); }
      }
      if (rel > m.recovery * 0.4) this.model.setAction(null, 7);
      if (rel > m.recovery) {
        this.move = null;
        this.setState('free');
      }
    }
  }

  // Fists, feet and tails smash whatever building they pass through during the active frames.
  _limbSweep(m, mv) {
    if (!m.limb) return;
    const M = this.model, pts = [];
    if (m.limb === 'L' || m.limb === 'both') pts.push(M.handWorld('L', new THREE.Vector3()));
    if (m.limb === 'R' || m.limb === 'both') pts.push(M.handWorld('R', new THREE.Vector3()));
    if (m.limb === 'head') pts.push(M.mouthWorld(new THREE.Vector3()));
    if (m.limb === 'foot') pts.push(M.footWorld('R', new THREE.Vector3()));
    if (m.limb === 'tail') { pts.push(M.tailTipWorld(new THREE.Vector3())); pts.push(M.J.tail3.getWorldPosition(new THREE.Vector3())); }
    if (m.limb === 'body') { pts.push(M.chestWorld(new THREE.Vector3())); pts.push(this.pos.clone()); }
    const ch = mv.charge || 0;
    const r = (m.limb === 'body' ? 11 : m.limb === 'tail' ? 8 : 6) + (m.fx + (m.fxCharge || 0) * ch) * 2.5;
    const dir = this.aimDir(_u);
    for (const p of pts) {
      if (!G.destruction.structsNear(p, r).length) continue;
      const res = G.destruction.impact({ pos: p, radius: r, power: 0.7 + m.fx * 0.5, vel: _v.copy(dir).multiplyScalar(30 + m.fx * 20), dir, shatter: r * 2.4, maxChunks: 16 });
      if (res.count > 0) {
        if (!mv.smashed) { mv.smashed = true; juiceSmash(p, _v.copy(dir).multiplyScalar(40 + m.fx * 40), res.count, true); G.audio && G.audio.smashThrough(clamp(m.fx, 0.3, 1), p); }
        if (this.exploring || !this.moveHit) G.fx.pebbleBurst(p, 6, _v.copy(dir).multiplyScalar(12), new THREE.Color(0.6, 0.58, 0.55), 3);
      }
    }
  }

  _whiff() {
    // a big swing that misses still shoves the air: shockwave forward, windows blow out
    const m = this.move.def;
    if (m.fx > 0.9 && !m.quake) {
      const d = this.aimDir(_u);
      _v.copy(this.pos).addScaledVector(d, this.R + 14).setY(this.pos.y + this.H * 0.15);
      G.fx.shock.ring(_v.clone(), d.clone(), 26 + m.fx * 20, 0xffffff, 0.35, 0.12, 0.6);
      G.destruction.impact({ pos: _v, radius: 3, power: 0.4, vel: d.clone().multiplyScalar(30), shatter: 28 });
    }
  }

  _tryHit(dist, toOpp) {
    const m = this.move.def;
    const o = this.opp;
    const dy = Math.abs(o.pos.y - this.pos.y);
    if (dist > m.range + 1 || dy > (this.move.name === 'diveSlam' ? 45 : 30)) return;
    // the tail whip only connects as the tail sweeps across the front of him
    if (m.spin) { const k = (this.moveT - m.startup) / m.active; if (k < 0.3 || k > 0.8) return; }
    if (o.invuln > 0 || o.state === 'down' || o.state === 'getup' || o.state === 'grabbed' || o.state === 'superVictim' || (o.ko && o.state !== 'launched')) return;
    this.moveHit = true;
    if (m.grab || m.superGrab) return this._startGrab(m.superGrab);
    const outcome = resolveHit(this, o, this.move, toOpp); // 'hit' | 'block' | 'parry' | 'guardBreak'
    G.game && G.game.onHit && G.game.onHit(this, o, this.move, outcome);
  }

  // STOMP: the foot comes down, the street cracks open and everything standing near goes over
  _quake(m) {
    const foot = this.model.footWorld('R', _p);
    foot.y = G.ground.heightAt(foot.x, foot.z);
    G.fx.groundImpact(foot.clone(), 130, { quake: true });
    G.fx.shock.ring(foot.clone().setY(foot.y + 1.5), null, m.quake * 1.6, 0xffe2a0, 0.7, 0.06, 0.8);
    G.fightCam && G.fightCam.addTraumaAt(foot, 0.6, 500);
    G.props && G.props.explosion(foot, m.quake * 1.3, 18);
    G.debris.explosion(foot, m.quake * 1.2, 16, 0.8);
    if (G.trees) G.trees.knock(foot.x, foot.z, m.quake * 0.7);
    const o = this.opp;
    if (!o || this.exploring) return;
    const d = this.flatDist(o);
    if (d > m.quake || !o.grounded || o.invuln > 0 || !STANDING.has(o.state) || o.state === 'grabbed') return;
    this.moveHit = true;
    const dir = _v.subVectors(o.pos, this.pos).setY(0).normalize();
    if (o.state === 'block') {
      o.setState('stagger'); o.staggerT = 0.45;
      o.vel.copy(dir).multiplyScalar(10);
      o.takeDamage(1, this, false);
      G.hud && G.hud.flashText(o, 'BRACED!');
      return;
    }
    o.cancelActions();
    o.takeDamage(this.moves.stomp.dmg * this.power * (1 - d / m.quake * 0.4), this, false);
    o.knockdown(dir, 10, this);
    this.meter = Math.min(100, this.meter + 4);
    G.hud && G.hud.flashText(o, 'KNOCKED DOWN!');
    G.game && G.game.onHit && G.game.onHit(this, o, this.move, 'hit');
  }

  _charge(dt) {
    const c = this.ctrl;
    this.charge = Math.min(1, this.charge + dt / 1.0);
    _v.copy(c.move).setY(0).multiplyScalar(4);
    this.vel.x = damp(this.vel.x, _v.x, 4, dt);
    this.vel.z = damp(this.vel.z, _v.z, 4, dt);
    this.model.setAction('chargeW', 10);
    this.model.glow = this.charge * 0.8;
    // gathering energy: sparks sucked into the fist, trembling, rising hum
    if (Math.random() < 0.7) {
      const h = this.model.handWorld('R', _p);
      randomUnit(_v).multiplyScalar(rand(10, 20));
      const p = h.clone().add(_v);
      G.fx.sparks.spawn(p.x, p.y, p.z, -_v.x * 3, -_v.y * 3, -_v.z * 3, 0.5, 0.06, 0.25, new THREE.Color(1, 0.85, 0.5), 0, 0);
    }
    if (this.charge >= 1 && !this.chargeFull) {
      this.chargeFull = true;
      const h = this.model.handWorld('R', _p).clone();
      G.fx.shock.flash(h, 14, 0xfff0a0, 0.2);
      G.fx.shock.ring(h, null, 30, 0xfff0a0, 0.3, 0.2);
    }
    G.fightCam && this === G.player && G.fightCam.addTrauma(0.012 * this.charge);
    G.audio && G.audio.chargeUpdate(this, this.charge);
    const release = !c.held('heavy') || this.stateT > 2.6;
    if (release) {
      G.audio && G.audio.chargeStop(this);
      const ch = this.charge;
      this.chargeFull = false;
      this.model.glow = 0;
      const name = ch < 0.2 ? 'heavy' : 'heavyCharged';
      if (name !== 'heavy') this.shout('charge_release', { duck: 0.25 });
      this.startMove(name, { charge: name === 'heavy' ? 0 : ch });
    }
  }

  // ---------------------------------------------------------------- the beam
  // KAISER BEAM out of the chest emblem / ATOMIC BREATH out of the jaws. The plates (or the
  // emblem) light up, then a beam pours out for ~2 s: it tracks him slowly (left / right sweep
  // it), cuts through every building on the way and scorches the street where it lands.
  beamStart() {
    if (this.beamE < 1) {
      if (this === G.player) G.hud.flashText(this, 'BEAM CHARGING');
      return;
    }
    this.beamE = 0;
    this.setState('beam');
    this.beamPh = 'windup';
    this.beamHits = 0;
    this.beamTick = 0;
    this.model.setAction('beamW', 8);
    G.audio && G.audio.chargeStart(this);
    this.shout('charge', { duck: 0.2 });
    G.fx.comic('beam', this.pos.clone().add(_w.set(0, this.H * 0.55, 0)), 1.1, this.def.beamName + '!');
  }

  _beam(dt) {
    const c = this.ctrl;
    this._friction(dt, 6);
    const M = this.model;
    if (this.beamPh === 'windup') {
      const k = this.stateT / BEAM.windup;
      M.glow = k * 1.4;
      G.audio && G.audio.chargeUpdate(this, k);
      // energy crawling up the plates / into the emblem
      const mz = M.mouthWorld(_p);
      for (let i = 0; i < 2; i++) {
        randomUnit(_v).multiplyScalar(rand(8, 18));
        const p = mz.clone().add(_v);
        G.fx.sparks.spawn(p.x, p.y, p.z, -_v.x * 3, -_v.y * 3, -_v.z * 3, 0.6, 0.06, 0.3, new THREE.Color(this.def.beamColor), 0, 0);
      }
      if (this === G.player) G.fightCam.addTrauma(0.01);
      if (k >= 1) {
        this.beamPh = 'fire';
        this.beamT = 0;
        this.beamAim = this._beamTarget(new THREE.Vector3());
        M.setAction('beamS', 20);
        G.audio && G.audio.chargeStop(this);
        G.audio && G.audio.beamStart(this);
        this.shout('charge_release', { duck: 0.25 });
        G.fx.shock.flash(mz.clone(), 18, this.def.beamCore, 0.25);
        G.fx.shock.ring(mz.clone(), this.beamAim.clone(), 40, this.def.beamColor, 0.4, 0.15);
        if (this === G.player) { G.fightCam.fovKick(6); G.fightCam.addTrauma(0.35); }
      }
      return;
    }
    if (this.beamPh === 'fire') {
      this.beamT += dt;
      M.glow = 1.4;
      // track him, slowly; left / right sweep it across the skyline
      const want = this._beamTarget(_w);
      const aim = this.beamAim;
      const ang = Math.acos(clamp(aim.dot(want), -1, 1));
      if (ang > 1e-4) aim.lerp(want, Math.min(1, (BEAM.turn * dt) / ang)).normalize();
      const right = _u.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw)).negate(); // character's right
      const sweep = c.move.dot(right);
      if (Math.abs(sweep) > 0.1) aim.applyAxisAngle(UP, -sweep * 0.9 * dt);
      // the face follows the beam
      this.yaw = Math.atan2(aim.x, aim.z);
      this._fireBeam(dt);
      if (this.beamT > BEAM.fire) this._beamEnd();
      return;
    }
    // recover
    M.glow = damp(M.glow, 0, 6, dt);
    if (this.stateT - this.beamEndT > BEAM.recover) { this.setState('free'); M.setAction(null, 8); }
  }

  // where the beam wants to point: his chest, or straight ahead (rampage: where the camera looks)
  _beamTarget(out) {
    const from = this.model.mouthWorld(_p);
    if (this.exploring || !this.opp) {
      if (this.exploring && G.fightCam) { G.fightCam.exploreDir(out); out.y = Math.min(out.y, -0.12); return out.normalize(); }
      return out.set(Math.sin(this.yaw), -0.25, Math.cos(this.yaw)).normalize();
    }
    return this.opp.hurtCenter(out).sub(from).normalize();
  }

  _fireBeam(dt) {
    const from = this.model.mouthWorld(new THREE.Vector3());
    const aim = this.beamAim;
    // where it stops: the street, if it gets that far down
    let len = BEAM.reach, hitGround = false;
    for (let s = 10; s <= BEAM.reach; s += 8) {
      _v.copy(from).addScaledVector(aim, s);
      if (_v.y < G.ground.heightAt(_v.x, _v.z) + 0.5) { len = s; hitGround = true; break; }
    }
    const end = from.clone().addScaledVector(aim, len);
    G.fx.beam.set(this.id, from, end, this.def.beamColor, this.def.beamCore, 5.5 + Math.sin(this.beamT * 40) * 0.6);
    if (this === G.player || G.camera.position.distanceTo(from) < 300) G.fightCam.addTrauma(0.012);
    this.beamTick -= dt;
    if (this.beamTick > 0) return;
    this.beamTick = BEAM.tick;
    // cut through the city along the line
    let cut = 0;
    for (let s = this.R + 6; s < len && cut < 6; s += 15) {
      _v.copy(from).addScaledVector(aim, s);
      if (!G.destruction.structsNear(_v, 9).length) continue;
      const res = G.destruction.impact({ pos: _v, radius: 7, power: 1.3, vel: _u.copy(aim).multiplyScalar(45), dir: aim, shatter: 18, maxChunks: 12 });
      if (res.count > 0) {
        cut++;
        if (Math.random() < 0.5) G.fx.fireball(_v, 0.5, this.def.beamColor);
      }
    }
    if (hitGround) {
      G.fx.beamImpact(end, this.def.beamColor);
      if (Math.random() < 0.35) G.ground.crater(end.x, end.z, 6, 1.2, { cracks: 0.6 });
      G.props && G.props.explosion(end, 22, 12);
      G.debris.explosion(end, 26, 10, 0.6);
    }
    // him: within the beam's radius of the line
    const o = this.opp;
    if (!o || this.exploring || !o.alive) return;
    const hc = o.hurtCenter(_p);
    const t = clamp(_v.subVectors(hc, from).dot(aim), 0, len);
    const closest = _w.copy(from).addScaledVector(aim, t);
    if (closest.distanceTo(hc) > BEAM.radius + o.R * 0.8 || o.invuln > 0) return;
    if (o.state === 'grabbed' || o.state === 'superVictim' || o.state === 'getup' || (o.ko && o.state !== 'launched')) return;
    const facing = _u.subVectors(this.pos, o.pos).setY(0).normalize().dot(_v.set(Math.sin(o.yaw), 0, Math.cos(o.yaw))) > -0.2;
    const pushDir = _u.copy(aim).setY(0).normalize();
    if (o.state === 'block' && facing) {
      o.takeDamage(BEAM.dmg * 0.15 * this.power, this, false);
      o.vel.x = pushDir.x * 9; o.vel.z = pushDir.z * 9;
      G.fx.sparkCone(closest, pushDir.clone().negate().setY(0.4).normalize(), 20, new THREE.Color(this.def.beamColor), 50, 1.1, 0.6, 0.05);
      G.audio && G.audio.hit('block', closest, true);
      return;
    }
    this.beamHits++;
    o.takeDamage(BEAM.dmg * this.power, this, false);
    o.model.hitFlash(0.8);
    if (STANDING.has(o.state) && o.state !== 'hitstun') o.cancelActions();
    if (STANDING.has(o.state) || o.state === 'hitstun') {
      o.setState('hitstun'); o.stunT = 0.3;
      o.model.setAction(chance(0.5) ? 'hitHigh' : 'hitBody', 40);
    }
    o.vel.x = pushDir.x * 12; o.vel.z = pushDir.z * 12;
    G.fx.pyro(closest, 0.6);
    juiceHit(closest, pushDir, 0.45, { hitstop: 0.02, sound: 'mid', victimIsPlayer: o === G.player });
    this.meter = Math.min(100, this.meter + 1.2);
    // he can't stay on his feet for the whole of it
    if (this.beamHits === 9 && o.state === 'hitstun') {
      o.shout('hurt_heavy');
      o.launch(pushDir.clone().setY(0.35).normalize(), 36, this);
      G.hud && G.hud.flashText(o, 'BLASTED!');
    }
  }

  _beamEnd() {
    if (this.beamPh !== 'fire' && this.beamPh !== 'windup') return;
    this.beamPh = 'recover';
    this.beamEndT = this.stateT;
    G.fx.beam.off(this.id);
    G.audio && G.audio.beamStop(this);
    G.audio && G.audio.chargeStop(this);
    this.model.setAction('beamW', 6);
  }

  // ---------------------------------------------------------------- grab & super
  _startGrab(isSuper) {
    const o = this.opp;
    this.move = null;
    this.trailL.emitting = false; this.trailR.emitting = false;
    o.cancelActions();
    o.setState(isSuper ? 'superVictim' : 'grabbed');
    o.vel.set(0, 0, 0);
    this.setState(isSuper ? 'super' : 'grabbing');
    this.grab = { phase: 'hold', t: 0, punches: 0, dir: null, isSuper, hits: 0 };
    this.model.setAction('hold', 30);
    o.model.setAction('dangle', 20);
    G.time.freeze(0.08);
    G.fightCam && G.fightCam.addTrauma(0.3);
    G.audio && G.audio.grab(this.pos);
    if (!isSuper) this.shout('grab', { duck: 0.25, hold: 0.8 });
    if (isSuper) {
      this.meter = 0;
      G.post.letterboxTarget = 1;
      G.fightCam && G.fightCam.cinematic(this, o, 4.2);
      G.fx.comic('super', o.pos.clone().add(new THREE.Vector3(0, this.H * 0.6, 0)), 1.3, this.def.superName + '!');
    }
  }

  // the victim, held out in front at arm's length (lifted a little: his feet leave the street)
  _holdVictim(lift = 5) {
    const o = this.opp;
    const f = _v.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    o.pos.copy(this.pos).addScaledVector(f, (this.R + o.R) * 0.92);
    o.pos.y = this.pos.y + lift;
    o.vel.copy(this.vel);
    o.grounded = false;
  }

  _grabbing(dt) {
    const g = this.grab;
    const o = this.opp;
    g.t += dt;
    if (g.phase === 'hold') {
      this._friction(dt, 10);
      this._holdVictim(3 + g.t * 10);
      if (g.t > 0.35) {
        g.phase = 'drag'; g.t = 0;
        g.dir = this._pickDragDir();
        this.model.setAction(this.def.rig === 'mech' ? 'lift' : 'hold', 12);
        G.audio && G.audio.whoosh(1, this.pos);
      }
    } else if (g.phase === 'drag') {
      // shove him through the buildings: steer with the stick (the bot keeps heading)
      if (this.ctrl.move.lengthSq() > 0.05) {
        _v.copy(this.ctrl.move).setY(0).normalize();
        g.dir.lerp(_v, 1 - Math.exp(-2.5 * dt)).normalize();
      }
      this.yaw = Math.atan2(g.dir.x, g.dir.z);
      this.vel.x = g.dir.x * SPEED.shove; this.vel.z = g.dir.z * SPEED.shove;
      // the robot hoists him overhead, the monster drags him in its jaws
      this._holdVictim(this.def.rig === 'mech' ? 8 + Math.min(1, g.t * 2) * 10 : 6);
      const n = o._plow(dt, [[0, o.R * 1.3]], 1.1);
      if (n > 0) { g.hits += n; o.takeDamage(Math.min(0.25 * n, 1.5), this, true); }
      if (g.t > 1.2 || this.ctrl.pressed('grab') || this.ctrl.pressed('heavy') || this.ctrl.pressed('light')) {
        g.phase = 'throw'; g.t = 0;
        this.model.setAction('throw', 50);
        const dir = g.dir.clone(); dir.y += 0.45; dir.normalize();
        aimAtBuilding(o.pos, dir, 0.4);
        o.takeDamage(7 * this.power, this, false);
        o.launch(dir, SPEED.throw, this);
        o.shout('hurt_heavy');
        juiceHit(o.hurtCenter(new THREE.Vector3()), dir, 1.2, { hitstop: 0.16, sound: 'huge', comic: 'throw', victimIsPlayer: o === G.player });
        this._friction(dt, 30);
        this.meter = Math.min(100, this.meter + 10);
      }
    } else {
      this._friction(dt, 6);
      if (g.t > 0.45) { this.grab = null; this.setState('free'); this.model.setAction(null, 10); }
    }
  }

  _pickDragDir() {
    // aim at the meatiest building in front (bot) or along the camera (player)
    const base = this === G.player && G.camera ? G.camera.getWorldDirection(new THREE.Vector3()) : this.aimDir(new THREE.Vector3());
    base.y = 0;
    base.normalize();
    let best = null, bestScore = -1;
    for (const s of G.destruction.structs) {
      if (s.aliveCount < 30) continue;
      const c = _v.copy(s.min).add(s.max).multiplyScalar(0.5);
      c.y = this.pos.y;
      const to = c.sub(this.pos);
      const d = to.length();
      if (d < 15 || d > 110) continue;
      to.divideScalar(d);
      const align = to.dot(base);
      if (align < 0.5) continue;
      const score = align * 2 - d / 110 + Math.min(1, (s.max.y - s.min.y) / 60) * 0.5;
      if (score > bestScore) { bestScore = score; best = to.clone(); }
    }
    return best || base;
  }

  _super(dt) {
    if (this.def.rig === 'mech') this._superSaber(dt); else this._superNova(dt);
  }

  // KAISER-OH: the sword comes down out of the sky into its hand, two slashes, then the final
  // strike. Sparks pour out of him, he topples, and a moment later he blows up.
  _superSaber(dt) {
    const g = this.grab, o = this.opp, M = this.model;
    g.t += dt;
    this._friction(dt, 8);
    const f = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    if (g.phase !== 'done' && g.phase !== 'cleave') {
      // he stands there stunned, an arm's length away
      o.pos.copy(this.pos).addScaledVector(f, this.R + o.R + 6);
      o.pos.y = o.floorY;
      o.vel.set(0, 0, 0);
    }
    const hc = () => o.hurtCenter(new THREE.Vector3());
    const slash = (dmg, s) => {
      const dir = f.clone();
      o.takeDamage(dmg * this.power, this, false);
      o.model.hitFlash(1); o.model.hitSquash(dir, 0.8);
      o.model.setAction(g.punches % 2 ? 'hitHigh' : 'hitBody', 60);
      G.fx.pyro(hc(), 1.1);
      G.fx.slash(hc(), dir, g.punches % 2 ? 1 : -1);
      juiceHit(hc(), dir, s, { hitstop: 0.1, sound: 'heavy', comic: 'slash', victimIsPlayer: o === G.player });
    };
    if (g.phase === 'hold') {
      M.setAction('swordUp', 10);
      o.model.setAction('hitBody', 20);
      if (g.t > 0.3 && !g.sword) {
        g.sword = true;
        M.showSword(true);
        const tip = M.swordTipWorld(new THREE.Vector3());
        G.fx.lightning(tip.clone().add(new THREE.Vector3(0, 160, 0)), tip);
        G.fx.shock.flash(tip, 30, 0xbff4ff, 0.3);
        G.fx.shock.ring(tip, null, 60, 0x9fe8ff, 0.5, 0.1);
        G.post.flashScreen(0.4);
        G.audio && G.audio.thunder(40);
        this.shout('super_start', { duck: 0.3 });
      }
      if (g.t > 0.95) { g.phase = 'slash'; g.t = 0; g.punches = 0; M.setAction('slashW', 30); }
    } else if (g.phase === 'slash') {
      if (g.t > 0.16 && !g.hit) {
        g.hit = true; g.punches++;
        M.setAction(g.punches % 2 ? 'slashS' : 'slashW', 90);
        slash(4, 0.9);
      }
      if (g.t > 0.4) {
        g.t = 0; g.hit = false;
        if (g.punches >= 2) {
          g.phase = 'windup'; M.setAction('cleaveW', 14);
          G.time.slowmo(0.3, 0.5, 4);
          G.audio && G.audio.chargeStart(this);
          this.shout('super_finish', { duck: 0.3 });
        }
      }
    } else if (g.phase === 'windup') {
      M.glow = 1.3;
      G.fightCam && G.fightCam.addTrauma(0.02);
      const tip = M.swordTipWorld(new THREE.Vector3());
      for (let i = 0; i < 3; i++) { randomUnit(_u).multiplyScalar(rand(8, 22)); G.fx.sparks.spawn(tip.x + _u.x, tip.y + _u.y, tip.z + _u.z, -_u.x * 3, -_u.y * 3, -_u.z * 3, 0.7, 0.06, 0.3, new THREE.Color(0.7, 0.95, 1), 0, 0); }
      if (g.t > 0.55) {
        G.audio && G.audio.chargeStop(this);
        M.setAction('cleaveS', 90);
        M.smear('R', 1);
        const dir = f.clone().setY(0.28).normalize();
        G.fx.slash(hc(), f.clone(), 0, true);
        o.takeDamage(16 * this.power, this, false);
        o.launch(dir, 34, this);
        o.boomAt(0.7, 1.8);
        if (!o.ko) o.shout('hurt_heavy');
        G.fx.pyro(hc(), 2);
        juiceHit(hc(), dir, 2.1, { hitstop: 0.26, impactFrame: true, sound: 'huge', comic: 'finish', slowmo: [0.22, 0.6], flash: 0.6, victimIsPlayer: o === G.player });
        G.post.letterboxTarget = 0;
        g.phase = 'done'; g.t = 0;
      }
    } else if (g.phase === 'done') {
      M.glow = damp(M.glow, 0, 4, dt);
      if (g.t > 0.9) { M.showSword(false); this.grab = null; this.setState('free'); M.setAction(null, 8); M.glow = 0; G.game && G.game.onSuperEnd(this); }
    }
  }

  // GORRAX: jaws clamp on, a flurry of claws, the plates blaze, and he lets it all out point
  // blank: a nuclear pulse that throws him through the skyline.
  _superNova(dt) {
    const g = this.grab, o = this.opp, M = this.model;
    g.t += dt;
    this._friction(dt, 8);
    if (g.phase !== 'done') this._holdVictim(4);
    if (g.phase === 'hold') {
      if (g.t > 0.35) { g.phase = 'barrage'; g.t = 0; }
    } else if (g.phase === 'barrage') {
      if (g.t > 0.15) {
        g.t = 0;
        g.punches++;
        const side = g.punches % 2 ? 'R' : 'L';
        M.setAction(side === 'R' ? 'crossS' : 'jabS', 90);
        M.smear(side, 1);
        const hp = o.hurtCenter(new THREE.Vector3()).add(_u.set(0, 6, 0));
        const dir = this.aimDir(new THREE.Vector3());
        o.takeDamage(1.8 * this.power, this, false);
        o.model.hitFlash(1); o.model.hitSquash(dir, 0.8);
        o.model.setAction(g.punches % 2 ? 'hitHigh' : 'hitBody', 60);
        G.fx.pyro(hp, 0.6);
        juiceHit(hp, dir, 0.6, { hitstop: 0.045, sound: 'barrage', comic: g.punches % 3 === 0 ? 'light' : null, victimIsPlayer: o === G.player });
        if (g.punches >= 6) {
          g.phase = 'windup'; g.t = 0; M.setAction('beamW', 14);
          G.time.slowmo(0.3, 0.6, 4);
          G.audio && G.audio.chargeStart(this);
          this.shout('super_finish', { duck: 0.3 });
        }
      }
    } else if (g.phase === 'windup') {
      M.glow = Math.min(2, g.t * 3);
      G.fightCam && G.fightCam.addTrauma(0.025);
      G.audio && G.audio.chargeUpdate(this, g.t / 0.7);
      if (g.t > 0.7) {
        G.audio && G.audio.chargeStop(this);
        M.setAction('beamS', 90);
        const dir = this.aimDir(new THREE.Vector3()).setY(0.3).normalize();
        const at = o.hurtCenter(new THREE.Vector3());
        o.takeDamage(16 * this.power, this, false);
        o.launch(dir, SPEED.superLaunch, this);
        if (!o.ko) o.shout('hurt_heavy');
        G.fx.explosion(at, 2.2, this.def.beamColor);
        G.fx.beam.flash(this.id, M.mouthWorld(new THREE.Vector3()), at.clone().addScaledVector(dir, 60), this.def.beamColor, this.def.beamCore, 0.45);
        juiceHit(at, dir, 2.1, { hitstop: 0.26, impactFrame: true, sound: 'huge', comic: 'finish', slowmo: [0.22, 0.6], flash: 0.7, victimIsPlayer: o === G.player });
        G.post.letterboxTarget = 0;
        g.phase = 'done'; g.t = 0;
      }
    } else if (g.phase === 'done') {
      M.glow = damp(M.glow, 0, 3, dt);
      if (g.t > 0.6) { this.grab = null; this.setState('free'); M.setAction(null, 8); G.game && G.game.onSuperEnd(this); }
    }
  }

  cancelActions() {
    if (this.state === 'charge') G.audio && G.audio.chargeStop(this);
    if (this.state === 'beam') { this._beamEnd(); }
    this.move = null;
    this.charge = 0;
    this.chargeFull = false;
    this.spinYaw = 0;
    this.model.glow = 0;
    this.model.thrust = 0;
    this.trailL.emitting = false; this.trailR.emitting = false;
    if (this.grab) {
      if (this.grab.isSuper) G.post.letterboxTarget = 0;
      this.model.showSword(false);
      this.grab = null;
      if (this.opp.state === 'grabbed' || this.opp.state === 'superVictim') this.opp.setState('free');
    }
  }

  // ---------------------------------------------------------------- receiving
  takeDamage(d, from, env) {
    if (this.ko) return;
    const st = G.game && G.game.state;
    if (st && st !== 'fight' && st !== 'tutorial') return; // no damage during intros / after the bell
    this.hp = Math.max(st === 'tutorial' ? 1 : 0, this.hp - d);
    this.meter = Math.min(100, this.meter + d * 0.45);
    if (from && from !== this) { from.meter = Math.min(100, from.meter + d * 0.7); from.stats.dealt += d; }
    this.model.setDamage(1 - this.hp / this.maxHp);
    G.hud && G.hud.onDamage(this, d);
    if (this.hp <= 0) {
      this.ko = true;
      G.game && G.game.onKO(this, from);
    }
  }

  // knocked flying: he goes over backwards, crashes through whatever's behind him and lands on
  // his back in the street
  launch(dir, speed, from) {
    this.cancelActions();
    this.vel.copy(dir).multiplyScalar(speed);
    this.setState('launched');
    this.grounded = false;
    this.launchSmashCount = 0;
    this.launchDamage = 0;
    this.lastSmashStruct = -1;
    this.tilt = 0;
    this.model.setAction('tumble', 30);
    this.lastHitBy = from;
    // face whoever did it while going over
    if (Math.hypot(dir.x, dir.z) > 0.2) this.yaw = Math.atan2(-dir.x, -dir.z);
    // the match recap's highlight reel (game/recorder.js)
    if (from && speed >= 34 && G.recorder) {
      const kind = from.state === 'super' ? 'super' : from.move && from.move.name === 'diveSlam' ? 'skydive' : from.state === 'grabbing' ? 'throw' : 'launch';
      G.recorder.mark(kind, { pos: this.pos, dir, by: from, on: this, bonus: (speed - 34) / 10 + (from.move && from.move.charge || 0) * 2 });
    }
  }

  // swept off his feet (stomp quake): a short stumble backwards onto his back
  knockdown(dir, speed, from) {
    this.launch(_u.copy(dir).setY(0.6).normalize(), speed + 6, from);
    this.shout('hurt_heavy', { odds: 0.7 });
  }

  boomAt(t, size) { this.booms.push({ t, size }); }
  _booms(dt) {
    for (let i = this.booms.length - 1; i >= 0; i--) {
      const b = this.booms[i];
      b.t -= dt;
      if (b.t <= 0) {
        this.booms.splice(i, 1);
        G.fx.explosion(this.hurtCenter(new THREE.Vector3()), b.size);
        this.model.hitFlash(1);
      }
    }
  }

  _hitstun(dt) {
    this._friction(dt, 4);
    if (this.stateT > this.stunT) { this.setState('free'); this.model.setAction(null, 10); }
  }

  _launched(dt) {
    const sp = this.vel.length();
    this.tilt = Math.min(1.45, this.tilt + dt * 2.2);
    G.post && this === G.player && (G.post.speedTarget = clamp((sp - 30) / 50, 0, 0.8));
    // dust off him while flying fast
    const chaseCam = this === G.player && G.fightCam && G.fightCam.chase > 0.2;
    if (sp > 30 && !chaseCam && Math.random() < 0.4 && this.stateT > 0.08) G.fx.dustPuff(this.pos, 4 + sp * 0.04, 1, 'white', _v.copy(this.vel).multiplyScalar(-0.05), 0.6 + Math.random() * 0.4);
  }

  _down(dt) {
    // still sliding: plow a trench in the street
    const h = Math.hypot(this.vel.x, this.vel.z);
    this._friction(dt, h > 6 ? 2.2 : 6);
    if (h > 8) {
      if (Math.random() < 0.35) G.ground.crater(this.pos.x, this.pos.z, 6 + h * 0.08, 0.6 + h * 0.02, { cracks: 0.3 });
      if (Math.random() < 0.5) G.fx.dustPuff(_v.copy(this.pos).setY(this.pos.y - 4), 5, 1, 'dust', _w.set(this.vel.x * 0.15, 3, this.vel.z * 0.15));
      G.audio && G.audio.skid(h * 2, this.pos);
      G.props && G.props.sweep(this.pos, this.vel, this.R * 1.6, 4);
    }
    if (this.ko) return;
    if (this.stateT > 1.25 || (this.stateT > 0.5 && (this.ctrl.pressed('up') || this.ctrl.pressed('dash')))) {
      this.setState('getup');
      this.invuln = 0.9;
      this.model.setAction('recover', 12);
      G.fx.dustRing(_v.copy(this.pos).setY(this.floorY - this.hipH), 26, 14);
      G.audio && G.audio.groundSlam(0.3, this.pos);
      this.shout('getup');
    }
  }

  // heaving himself back up out of the rubble
  _getup(dt) {
    this._friction(dt, 8);
    if (this.stateT > 0.6) {
      this.setState('free');
      this.invuln = Math.max(this.invuln, 0.3);
      this.model.setAction(null, 8);
    }
  }

  _ko(dt) {
    this._friction(dt, 3);
    // the end of a kaiju: down it goes, and then it explodes
    if (!this.boomed && this.grounded && this.stateT > 1.0) {
      this.boomed = true;
      G.fx.explosion(this.hurtCenter(new THREE.Vector3()), 2.4);
      this.model.hitFlash(1);
    }
  }

  // ---------------------------------------------------------------- integration
  // Plow through buildings along the motion this frame: each sphere is [height above the pelvis,
  // radius]. Returns chunks destroyed.
  _plow(dt, spheres, powerK = 1) {
    const sp = this.vel.length();
    if (sp < 2) return 0;
    let total = 0;
    const steps = Math.max(1, Math.ceil((sp * dt) / 4));
    for (const [oy, r] of spheres) {
      for (let i = 1; i <= steps; i++) {
        _v.copy(this.pos).addScaledVector(this.vel, (dt * i) / steps);
        _v.y += oy;
        const near = G.destruction.structsNear(_v, r);
        if (!near.length) continue;
        const res = G.destruction.impact({ pos: _v, radius: r, power: clamp(sp / 45, 0.25, 1.6) * powerK, vel: this.vel, shatter: r * 1.8 + sp * 0.15, maxChunks: 24 });
        if (res.count > 0) {
          const sid = near[0].id;
          const first = sid !== this.lastSmashStruct;
          this.lastSmashStruct = sid;
          if (first || sp > 25) juiceSmash(_v, this.vel, res.count, first);
          total += res.count;
          if (first) G.audio && G.audio.smashThrough(clamp(sp / 60, 0.3, 1), _v);
          if (first && this.state === 'launched' && sp > 25 && G.recorder) {
            G.recorder.mark('smash', { pos: _v, dir: this.vel, by: this.lastHitBy, on: this, name: near[0].name, bonus: Math.min(3, sp / 20) + (near[0].name ? 3 : 0) });
          }
        }
      }
    }
    if (total > 0) {
      // buildings push back: a kaiju wading through a block slows right down
      const keep = this.state === 'launched' ? Math.max(0.8, Math.pow(0.99, total)) : Math.max(0.6, Math.pow(0.975, total));
      this.vel.x *= keep; this.vel.z *= keep;
      if (this.state === 'launched') this.vel.y *= keep;
    }
    return total;
  }

  _integrate(dt) {
    const st = this.state;
    const held = st === 'grabbed' || st === 'superVictim';
    if (!held) {
      const g = st === 'launched' || st === 'ko' ? SPEED.launchGravity : st === 'land' ? 0 : SPEED.gravity;
      if (!this.grounded || this.vel.y > 0) this.vel.y -= g * dt;
    }
    // what's in the way: legs and body wade through it (gently at a walk, hard when running,
    // launched or slamming)
    const sp = Math.hypot(this.vel.x, this.vel.z);
    if (!held && st !== 'landed' && st !== 'intro' && st !== 'land') {
      let k = 0;
      if (st === 'launched' || st === 'ko') k = 1.1;
      else if (st === 'dive' || (st === 'attack' && this.move && (this.move.name === 'tackle' || this.move.name === 'diveSlam'))) k = 1.1;
      else if (this.running || st === 'dash') k = 0.85;
      else if (sp > 2 || this.vel.y < -5) k = 0.45;
      if (k > 0) {
        const lying = (st === 'launched' && this.tilt > 0.8) || st === 'down' || st === 'ko';
        const n = this._plow(dt, lying ? [[0, this.R * 1.15]] : [[-this.hipH * 0.45, this.R * 0.8], [this.H * 0.18, this.R]], k);
        if (n > 0 && st === 'launched') {
          this.launchSmashCount += n;
          if (this.launchDamage < 8) { const d = Math.min(8 - this.launchDamage, n * 0.08); this.launchDamage += d; this.takeDamage(d, this.lastHitBy, true); }
        }
      }
    }
    this.pos.addScaledVector(this.vel, dt);

    // the street
    const gh = G.ground.heightAt(this.pos.x, this.pos.z);
    const lying = st === 'down' || ((st === 'ko') && this.stateT > 0.2);
    // getting up: the pelvis rises from the street with the body
    const up = st === 'getup' ? 1 - (1 - clamp(this.stateT / 0.6, 0, 1)) ** 2 : 1;
    const floor = gh + (lying ? this.S * 0.26 : this.S * 0.26 + (this.hipH - this.S * 0.26) * up);
    if (this.pos.y <= floor) {
      const vy = this.vel.y;
      const gp = _p.set(this.pos.x, gh, this.pos.z);
      if (st === 'land') {
        G.fx.groundImpact(gp.clone(), 125);
        G.fightCam && G.fightCam.addTraumaAt(this.pos, 0.8, 600);
        this.vel.set(0, 0, 0);
        this.model.thrust = 0;
        this.setState('landed');
      } else if (st === 'jump' && vy < 0) {
        G.fx.groundImpact(gp.clone(), clamp(-vy * 1.6, 40, 80), { quiet: true });
        this.model.thrust = 0;
        this.setState('stagger'); this.staggerT = 0.18;
      } else if (st === 'dive' || (st === 'attack' && this.move && this.move.name === 'diveSlam')) {
        // a slam that missed ends in the street: a crater, and a moment to get up
        G.fx.groundImpact(gp.clone(), clamp(-vy * 1.8 + 40, 70, 130));
        G.fightCam && G.fightCam.addTraumaAt(this.pos, 0.6, 500);
        this.vel.set(0, 0, 0);
        this.model.thrust = 0;
        if (st === 'dive') { this.setState('stagger'); this.staggerT = 0.6; this.model.setAction('heroLand', 20); }
      } else if (st === 'launched' || (st === 'ko' && vy < -3)) {
        // landing flat on his back: the street caves in under him
        const impactSp = this.vel.length();
        G.fx.groundImpact(gp.clone(), clamp(30 + impactSp * 1.6, 50, 135));
        if (impactSp > 25 && G.recorder) G.recorder.mark('slam', { pos: this.pos, dir: this.vel, by: this.lastHitBy, on: this, bonus: (impactSp - 25) / 15 });
        this.takeDamage(clamp(impactSp * 0.06, 1, 5), this.lastHitBy, true);
        G.props && G.props.explosion(gp, 40, 14);
        G.debris.explosion(gp, 40, 12, 0.6);
        this.vel.y = 0;
        this.vel.x *= 0.55; this.vel.z *= 0.55;
        this.setState(this.ko ? 'ko' : 'down');
        if (this.ko) this.stateT = 0.21; // lie down (see `lying`) from now on
        this.model.setAction('down', 14);
      }
      if (vy < -8 && STANDING.has(this.state) && st !== 'land') G.fightCam && G.fightCam.addTraumaAt(this.pos, 0.12, 250);
      this.pos.y = this.state === 'down' || this.state === 'ko' ? gh + this.S * 0.26 : floor;
      if (this.vel.y < 0) this.vel.y = 0;
      this.grounded = true;
    } else {
      this.grounded = this.pos.y - floor < 0.8 && this.vel.y <= 0.5;
      // stepping off a rubble pile or a crater lip: settle down onto the street
      if (this.grounded && this.pos.y > floor) this.pos.y = damp(this.pos.y, floor, 12, dt);
    }
    // arena bounds: the square edge of the destructible city (shown as a force field)
    for (const ax of ['x', 'z']) {
      if (Math.abs(this.pos[ax]) > ARENA) {
        this.pos[ax] = Math.sign(this.pos[ax]) * ARENA;
        if (this.vel[ax] * this.pos[ax] > 0) {
          if (st === 'launched' && Math.abs(this.vel[ax]) > 15) {
            G.fx.shock.ring(this.pos.clone(), new THREE.Vector3(ax === 'x' ? 1 : 0, 0, ax === 'z' ? 1 : 0), 50, 0xffe08a, 0.4, 0.15);
            G.audio && G.audio.field(this.pos);
          }
          this.vel[ax] *= st === 'launched' ? -0.35 : 0;
        }
      }
    }
  }

  // A footfall: the street cracks under the foot, dust rolls out, parked cars hop (or get flattened),
  // trees go over, the base of whatever building he's stepping into gives way, and the camera
  // feels it.
  _footstep(side, amount) {
    if (!this.grounded) return;
    const p = this.model.footWorld(side, new THREE.Vector3());
    const gh = G.ground.heightAt(p.x, p.z);
    p.y = gh;
    const run = this.running;
    const k = clamp(amount, 0.3, 1.2) * (run ? 1.4 : 1);
    G.fx.footstep(p, k, this);
    if (G.fightCam) G.fightCam.addTraumaAt(p, (this === G.player ? 0.07 : 0.1) * k, 320);
    G.audio && G.audio.footstep(p, k, this.def.rig);
    if (G.input && this === G.player) G.input.rumble(0.25 * k, 0.1 * k, 70);
    if (G.train) G.train.sweep(_v.copy(p).setY(gh + 5), _w.set(this.vel.x, -10, this.vel.z), 9, 0);
  }

  // ---------------------------------------------------------------- presentation
  _orient(dt, realDt) {
    const o = this.opp;
    const k = dt > 0 ? dt : 0;
    const st = this.state;
    // which way he faces: at the opponent (lock-on), along his run, or where he's going (rampage)
    let want = this.yaw;
    const hs = Math.hypot(this.vel.x, this.vel.z);
    const locked = !this.exploring && o && !this.running && st !== 'launched' && st !== 'down' && st !== 'ko' && st !== 'getup' && st !== 'grabbing' && st !== 'beam' && !(st === 'attack' && this.move && this.move.name === 'tackle');
    if (locked && st !== 'super') want = Math.atan2(o.pos.x - this.pos.x, o.pos.z - this.pos.z);
    else if ((this.running || this.exploring) && hs > 3 && STANDING.has(st) && st !== 'beam') want = Math.atan2(this.vel.x, this.vel.z);
    else if (this.exploring && STANDING.has(st) && st !== 'beam' && st !== 'attack') { G.fightCam.exploreDir(_v); want = Math.atan2(_v.x, _v.z); }
    // kaiju turn ponderously (snappier while swinging, so attacks track)
    const rate = st === 'attack' && this.moveT < (this.move ? this.move.def.startup : 0) ? 7 : st === 'free' ? 4.5 : 3;
    let d = want - this.yaw;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this.yaw += d * (1 - Math.exp(-rate * k));
    _q.setFromAxisAngle(UP, this.yaw + this.spinYaw);
    // lean into the motion
    _w.set(this.vel.x, 0, this.vel.z).applyQuaternion(_q2.setFromAxisAngle(UP, -this.yaw));
    const leanF = clamp(_w.z / 120, -0.12, 0.2), leanR = clamp(-_w.x / 120, -0.12, 0.12);
    _q.multiply(_q2.setFromEuler(_e.set(leanF, 0, leanR)));
    if (st === 'launched' || (st === 'ko' && this.stateT <= 0.2)) {
      // going over backwards
      _q.multiply(_q2.setFromAxisAngle(_w.set(1, 0, 0), -this.tilt));
    }
    if (st === 'down' || st === 'ko' && this.stateT > 0.2) {
      // flat on his back
      _q.setFromAxisAngle(UP, this.yaw).multiply(_q2.setFromAxisAngle(_w.set(1, 0, 0), -Math.PI / 2 * 0.92));
    }
    if (st === 'getup') {
      const t = clamp(this.stateT / 0.6, 0, 1);
      _q.setFromAxisAngle(UP, this.yaw).multiply(_q2.setFromAxisAngle(_w.set(1, 0, 0), -Math.PI / 2 * 0.92 * (1 - t) * (1 - t)));
    }
    if (st === 'dive' || (st === 'attack' && this.move && this.move.name === 'diveSlam')) {
      // pitched along the dive
      const v = this.vel;
      const pitch = clamp(Math.atan2(-v.y, Math.hypot(v.x, v.z)), 0, 1.2) * (this.def.rig === 'beast' ? 0.9 : 0.4);
      _q.multiply(_q2.setFromAxisAngle(_w.set(1, 0, 0), pitch));
    }
    const snap = st === 'launched' || st === 'down' || st === 'ko' || st === 'getup' || st === 'grabbed' || st === 'superVictim' || this.spinYaw !== 0;
    this.quat.slerp(_q, snap ? 1 : 1 - Math.exp(-16 * k));
    this.model.root.quaternion.copy(this.quat);

    // base pose selection
    let base = 'guard';
    const dist = o ? this.flatDist(o) : 999;
    if (st === 'free' && this.running) base = 'run';
    else if (st === 'free' && (this.exploring || dist > 110) && hs < 16) base = 'idle';
    else if (st === 'free' && this.taunting > 0) base = 'taunt';
    if (st === 'jump' || st === 'dash' && !this.grounded) base = 'air';
    if (st === 'dive') base = 'dive';
    if (st === 'launched') base = 'tumble';
    if (st === 'down' || st === 'ko') base = 'down';
    if (st === 'getup') base = 'recover';
    if (st === 'grabbed' || st === 'superVictim') base = 'dangle';
    if (st === 'block') base = 'block';
    if (st === 'land') base = 'air';
    if (st === 'landed') base = 'heroLand';
    if (st === 'taunt') base = 'taunt';
    this.model.setBase(base);
    if (st === 'block') this.model.setAction(null, 20);
  }

  // ROAR (GORRAX) / the sentai pose (KAISER-OH): a breather the bot takes; windows blow out
  roar() {
    this.setState('taunt');
    this.tauntT = 1.6;
    this.model.setAction('taunt', 8);
    const head = this.model.headWorld(new THREE.Vector3());
    G.fx.shock.ring(head.clone(), null, 70, 0xffffff, 0.8, 0.05, 0.5);
    G.destruction.impact({ pos: head, radius: 0.5, power: 0.2, shatter: 46 });
    if (this.def.rig === 'beast') { G.audio && G.audio.roar(head); this.model.glow = 0.4; }
    else this.shout('taunt', { odds: 1 });
    G.fightCam && G.fightCam.addTraumaAt(head, 0.35, 400);
  }

  _trails() {
    const t = G.time.gameTime;
    const cam = G.camera;
    if (this.trailL.emitting) this.trailL.push(this.model.handWorld('L', _v), t);
    if (this.trailR.emitting) this.trailR.push(this.model.handWorld('R', _v), t);
    const sp = this.vel.length();
    this.trailBody.emitting = (this.state === 'dive' || (this.state === 'jump' && this.def.rig === 'mech' && this.vel.y > 10)) && sp > 20;
    if (this.trailBody.emitting) this.trailBody.push(this.model.chestWorld(_v), t);
    this.trailL.update(t, cam); this.trailR.update(t, cam); this.trailBody.update(t, cam);
  }
}

// Destruction aim-assist: bend big launches toward the nearest building in the cone, so a
// good hit almost always ends with a kaiju crashing through a tower.
export function aimAtBuilding(from, dir, maxAngle = 0.5, range = 170) {
  let best = null, bestScore = Infinity;
  const flat = _u.set(dir.x, 0, dir.z);
  if (flat.lengthSq() < 0.01) return dir;
  flat.normalize();
  for (const s of G.destruction.structs) {
    if (s.aliveCount < 40 || s.max.y - s.min.y < 25) continue;
    const t = new THREE.Vector3((s.min.x + s.max.x) / 2, 0, (s.min.z + s.max.z) / 2);
    const to = t.sub(from).setY(0);
    const d = to.length();
    if (d < 20 || d > range) continue;
    to.divideScalar(d);
    const ang = Math.acos(clamp(to.dot(flat), -1, 1));
    if (ang > maxAngle) continue;
    const score = ang * 60 + d * 0.2;
    if (score < bestScore) { bestScore = score; best = to.clone(); }
  }
  if (best) {
    const y = dir.y;
    flat.lerp(best, 0.85).normalize();
    dir.set(flat.x, 0, flat.z).multiplyScalar(Math.sqrt(Math.max(0, 1 - y * y))).setY(y);
  }
  return dir;
}

// ---------------------------------------------------------------- hit resolution
export function resolveHit(att, vic, mv, dirIn) {
  const dir = dirIn.clone().setY(0).normalize();
  const m = mv.def;
  const ch = mv.charge || 0;
  const point = vic.hurtCenter(new THREE.Vector3()).addScaledVector(dir, -vic.R * 0.7);
  if (m.limb === 'head' || m.limb === 'tail' || mv.name === 'diveSlam') point.y += 6;
  const val = (k) => (m[k] || 0) + (m[k + 'Charge'] || 0) * ch;
  const facing = _v.subVectors(att.pos, vic.pos).setY(0).normalize().dot(_w.set(Math.sin(vic.yaw), 0, Math.cos(vic.yaw))) > -0.2;
  const strength = val('fx');
  const playerVictim = vic === G.player;

  // ---- block / parry / guard break
  if (vic.state === 'block' && facing) {
    if (vic.blockPressT < 0.15) {
      // parry: attacker staggers, time dilates, defender gets meter
      att.cancelActions();
      att.setState('stagger'); att.staggerT = 0.7;
      att.vel.copy(dir).multiplyScalar(-14);
      vic.meter = Math.min(100, vic.meter + 15);
      juiceHit(point, dir, 0.9, { hitstop: 0.14, blocked: true, sound: 'parry', comic: 'parry', slowmo: [0.3, 0.3], flash: 0.25 });
      att.shout('hurt_light', { odds: 0.6 });
      G.hud && G.hud.flashText(vic, 'PARRY!');
      return 'parry';
    }
    if (m.guardBreak && ch >= m.guardBreak) {
      vic.setState('stagger'); vic.staggerT = 0.9;
      vic.vel.copy(dir).multiplyScalar(18);
      juiceHit(point, dir, 1.2, { hitstop: 0.16, sound: 'huge', comic: 'heavy', victimIsPlayer: playerVictim });
      G.hud && G.hud.flashText(vic, 'GUARD BREAK!');
      vic.shout('hurt_light');
      return 'guardBreak';
    }
    const chip = val('dmg') * 0.12 * att.power;
    vic.takeDamage(chip, att, false);
    vic.vel.copy(dir).multiplyScalar(6 + val('launch') * 0.15);
    juiceHit(point, dir, strength * 0.5, { hitstop: m.hitstop * 0.6, blocked: true, sound: 'block', victimIsPlayer: playerVictim });
    G.fx.comic('block', point, 0.6);
    vic.shout('block', { odds: 0.6 });
    return 'block';
  }

  // ---- clean hit
  vic.cancelActions();
  const scale = Math.max(0.45, 1 - vic.comboTaken * 0.07);
  const dmg = val('dmg') * att.power * scale;
  vic.comboTaken++;
  vic.comboTimer = 1.4;
  att.stats.hits++;
  att.stats.maxCombo = Math.max(att.stats.maxCombo, vic.comboTaken);
  vic.takeDamage(dmg, att, false);
  vic.model.hitFlash(1);
  vic.model.hitSquash(dir, 0.6 + strength * 0.4);
  G.hud && G.hud.onCombo(att, vic.comboTaken);
  // tokusatsu pyrotechnics: sparks burst off him on every solid hit
  if (strength > 0.45) G.fx.pyro(point, strength);

  const launch = val('launch');
  if (launch > 0 || vic.ko) {
    const ld = dir.clone();
    if (m.dir === 'up') ld.set(dir.x * 0.45, 1, dir.z * 0.45).normalize();
    else if (m.dir === 'down') ld.set(dir.x * 0.5, -1, dir.z * 0.5).normalize();
    else {
      ld.y = m.up || 0.35;
      ld.normalize();
      if (launch >= 40) aimAtBuilding(vic.pos, ld, 0.42 + ch * 0.2);
    }
    vic.launch(ld, Math.max(launch, vic.ko ? 46 : 0), att);
    if (!vic.ko) vic.shout('hurt_heavy');
    const huge = (m.impactFrame && ch >= m.impactFrame) || vic.ko;
    const slow = huge ? [0.2, 0.6] : m.slowmo;
    juiceHit(point, ld, strength + (vic.ko ? 0.6 : 0), {
      hitstop: val('hitstop') + (vic.ko ? 0.12 : 0), impactFrame: huge, sound: m.sound, comic: m.comic,
      slowmo: slow, victimIsPlayer: playerVictim, flash: huge ? 0.35 : 0,
    });
    // pressure wave carries on past him into the buildings behind
    G.destruction.impact({ pos: point.clone().addScaledVector(ld, vic.R * 2), radius: 4 + strength * 3, power: 0.6, vel: ld.clone().multiplyScalar(40), shatter: 20 + strength * 20 });
    G.debris.explosion(point, 40 + strength * 30, 10 * strength, 0.3);
  } else {
    vic.setState('hitstun');
    vic.stunT = m.hitstun;
    vic.vel.copy(dir).multiplyScalar(m.kb);
    vic.model.setAction(chance(0.5) ? 'hitHigh' : 'hitBody', 60);
    vic.shout('hurt_light', { odds: 0.6 });
    juiceHit(point, dir, strength, { hitstop: m.hitstop, sound: m.sound, comic: strength > 0.5 && chance(0.4) ? 'light' : null, victimIsPlayer: playerVictim });
  }
  att.meter = Math.min(100, att.meter + (m.meter || 3) * 0.5);
  return 'hit';
}
