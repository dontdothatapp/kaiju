// Bot brain. Writes virtual inputs into fighter.ctrl, so the bot kaiju obeys exactly the same
// rules (frame data, buffers, recoveries, beam gauge) as the player.
import * as THREE from 'three';
import { G } from '../core/context.js';
import { rand, chance, pick, clamp, UP } from '../core/math.js';

export const DIFFICULTY = {
  // roar: how readily he breaks off after an exchange to roar / strike a pose
  training: { react: 9, block: 0, dodge: 0, aggression: 0, combo: [1, 1], recover: 0.2, charge: 0, grab: 0, stomp: 0, leap: 0, beam: 0, superUse: 0, roar: 0, passive: true },
  sparring: { react: 0.45, block: 0.22, dodge: 0.12, aggression: 0.38, combo: [1, 3], recover: 0.35, charge: 0.2, grab: 0.12, stomp: 0.12, leap: 0.12, beam: 0.35, superUse: 0.5, roar: 0.45 },
  brutal: { react: 0.28, block: 0.42, dodge: 0.25, aggression: 0.6, combo: [2, 4], recover: 0.65, charge: 0.3, grab: 0.2, stomp: 0.2, leap: 0.2, beam: 0.6, superUse: 0.9, roar: 0.25 },
  king: { react: 0.18, block: 0.58, dodge: 0.32, aggression: 0.8, combo: [3, 4], recover: 0.92, charge: 0.4, grab: 0.25, stomp: 0.25, leap: 0.25, beam: 0.8, superUse: 1, roar: 0.12 },
};
DIFFICULTY.viltrumite = DIFFICULTY.king; // old URL flag

// speech bubbles, by who's talking. GORRAX says nothing during a round (his roars do the talking);
// KAISER-OH's pilots get two calls, a battle cry at the start and one when the monster goes down.
// The bot's winning line after the match is the only other one.
const LINES = {
  gorrax: {
    win: ['The city is MINE!'],
  },
  kaiser: {
    start: ['Kaiser-Oh, ready for battle!'],
    playerDown: ['Stay down, monster!'],
    win: ['The city is safe!'],
  },
};

const _p = new THREE.Vector3();

export class Brain {
  constructor(fighter, diffName, opts = {}) {
    this.f = fighter;
    this.setDifficulty(diffName);
    this.think = 0;
    this.plan = 'approach';
    this.strafeDir = 1;
    this.comboLeft = 0;
    this.chargeHold = 0;
    this.blockHold = 0;
    this.reactT = 0;
    this.reactingTo = null;
    this.diveAt = 0;
    this.grabCd = 2;         // seconds before he'll go for another grab (a run at you from mid range is a big commitment)
    this.talkCd = 3;
    this.lines = opts.lines !== false;
    this.wasDown = false;
    this.sinceRoar = 0;
    this.drill = null;       // tutorial drill for the training dummy: null | 'swing' | 'keepAway'
  }

  setDifficulty(name) { this.d = DIFFICULTY[name] || DIFFICULTY.brutal; this.dname = name; }

  say(kind) {
    const L = (LINES[this.f.def.name] || LINES.gorrax)[kind];
    if (!L || !this.lines || this.talkCd > 0 || !G.hud) return;
    this.talkCd = rand(5, 9);
    G.hud.speech(this.f, pick(L));
  }

  update(dt) {
    const f = this.f, o = f.opp, c = f.ctrl, d = this.d;
    this.talkCd -= dt;
    this.grabCd -= dt;
    c.move.set(0, 0, 0);
    c.vert = 0;
    if (!f.alive || !o) { for (const a of ['block', 'heavy', 'dash']) c.release(a); return; }

    const to = new THREE.Vector3(o.pos.x - f.pos.x, 0, o.pos.z - f.pos.z);
    const dist = to.length();
    const dir = to.clone().divideScalar(dist || 1);
    const right = new THREE.Vector3().crossVectors(dir, UP).normalize();

    // ---- knocked down: scramble up (or lie there a moment)
    if (f.state === 'down') { if (chance(d.recover * dt * 3)) c.tap('up'); return; }
    if (f.state === 'launched' || f.state === 'getup' || f.state === 'grabbed' || f.state === 'superVictim' || f.state === 'hitstun' || f.state === 'stagger' || f.state === 'taunt') {
      c.release('block'); c.release('heavy'); c.release('dash');
      return;
    }
    this.sinceRoar += dt;

    if (o.state === 'down' && !this.wasDown) {
      this.say('playerDown');
      if (chance(0.5) && f.state === 'free' && dist > 45) { f.roar(); this.sinceRoar = 0; }
    }
    this.wasDown = o.state === 'down';

    // ---- these play out by themselves
    if (f.state === 'grabbing' || f.state === 'super' || f.state === 'beam' || f.state === 'dive') return;
    // in the air: come down on him with a slam
    if (f.state === 'jump') {
      c.move.copy(dir).multiplyScalar(dist > 30 ? 1 : 0);
      if (f.stateT > this.diveAt && dist < 120) { c.tap(chance(0.5) ? 'light' : 'heavy'); }
      return;
    }

    if (d.passive) {
      // training dummy: stands his ground and never attacks, except in the tutorial's drills
      // (game/tutorial.js): 'swing' closes in and throws a jab now and then for you to block,
      // 'keepAway' backs off so the beam has something to aim at
      if (this.drill === 'swing') {
        if (dist > 30) c.move.copy(dir);
        this.drillT = (this.drillT || 0) - dt;
        if (f.state === 'free' && dist < 34 && this.drillT <= 0) { c.tap('light'); this.drillT = 1.8; }
      } else if (this.drill === 'keepAway') {
        if (dist < 90) c.move.copy(dir).negate();
      } else c.move.copy(right).multiplyScalar(Math.sin(G.time.gameTime * 0.4) * 0.25);
      if (f.hp < f.maxHp) f.hp = Math.min(f.maxHp, f.hp + dt * 4);
      return;
    }

    // ---- defense: react to the opponent's wind-ups
    const om = o.move && o.move.def;
    if (o.state === 'attack' && om && dist < (om.range + om.lunge + 10)) {
      if (this.reactingTo !== o.move) {
        this.reactingTo = o.move;
        this.reactT = d.react * rand(0.7, 1.3);
        // a stomp's quake is best jumped; grabs go through a block
        if (om.quake) this.defense = chance(d.dodge + 0.25) ? 'jump' : chance(d.block) ? 'block' : 'none';
        else this.defense = chance(d.block) ? 'block' : chance(d.dodge) ? 'dodge' : 'none';
        if (om.grab && this.defense === 'block') this.defense = chance(0.5) ? 'dodge' : 'none';
        // a grab run at him: seen coming, so timed for when it gets there; step aside or (now and
        // then) leap it
        if (o.move.run) {
          if (this.defense === 'dodge' && chance(0.35)) { this.defense = 'jump'; this.diveAt = rand(0.3, 0.6); }
          this.reactT = this.reactT * 0.6 + Math.max(0, dist - om.runReach) / Math.max(20, -_p.subVectors(o.vel, f.vel).setY(0).dot(dir));
        }
      }
    } else if (o.state === 'charge' && dist < 50 && this.reactingTo !== 'charge') {
      this.reactingTo = 'charge';
      this.reactT = d.react;
      this.defense = chance(d.dodge + 0.15) ? 'dodge' : chance(0.4) ? 'punish' : 'none';
    } else if (o.state === 'beam' && this.reactingTo !== 'beam') {
      // a beam is telegraphed by its wind-up: get out of the line, or brace
      this.reactingTo = 'beam';
      this.reactT = d.react * rand(0.8, 1.4);
      this.defense = chance(d.dodge + 0.2) ? 'dodge' : chance(d.block + 0.1) ? 'block' : 'none';
    } else if (o.state === 'dive' && this.reactingTo !== 'dive') {
      this.reactingTo = 'dive';
      this.reactT = d.react * rand(1, 1.6);
      this.defense = chance(d.dodge + 0.15) ? 'dodge' : chance(d.block) ? 'block' : 'none';
    }
    if (this.reactingTo) {
      this.reactT -= dt;
      if (this.reactT <= 0 && f.canAct) {
        if (this.defense === 'block') { c.press('block'); this.blockHold = this.reactingTo === 'beam' ? 1.8 : 0.5; }
        else if (this.defense === 'dodge') { c.move.copy(right).multiplyScalar(chance(0.5) ? 1 : -1).addScaledVector(dir, -0.3); c.tap('dash'); }
        else if (this.defense === 'jump') c.tap('up');
        else if (this.defense === 'punish' && dist < 34) { c.tap('light'); this.comboLeft = 2; }
        this.reactingTo = null;
        this.defense = 'none';
      }
    }
    if (this.blockHold > 0) {
      this.blockHold -= dt;
      if (this.blockHold <= 0 || (o.state !== 'attack' && o.state !== 'charge' && o.state !== 'beam' && o.state !== 'dive')) { c.release('block'); this.blockHold = 0; }
      else { c.press('block'); return; }
    }

    // ---- combo continuation
    if (f.state === 'attack' && f.move) {
      const m = f.move.def;
      if (m.next && this.comboLeft > 0 && f.moveT > m.startup + m.active + 0.02) {
        this.comboLeft--;
        if (this.comboLeft === 0 && chance(0.45)) c.tap('heavy');
        else c.tap('light');
      }
      return;
    }

    // ---- charging: hold until in reach, then release
    if (f.state === 'charge') {
      this.chargeHold -= dt;
      c.move.copy(dir).multiplyScalar(0.8);
      const reach = 34 + f.charge * 20;
      if ((dist < reach && f.charge > 0.35) || this.chargeHold <= 0) c.release('heavy');
      else c.press('heavy');
      return;
    }

    // ---- planning
    this.think -= dt;
    if (this.think <= 0 && f.state === 'free') {
      this.think = rand(0.22, 0.5);
      if (chance(0.15)) this.strafeDir *= -1;
      const r = Math.random();
      if (f.meter >= 100 && dist < 50 && chance(d.superUse)) { c.tap('super'); return; }
      // a breather: back off, roar at him (or strike the sentai pose) across the street
      if (this.sinceRoar > 9 && dist > 55 && dist < 140 && chance(d.roar * 0.35)) {
        f.roar(); this.sinceRoar = 0; this.say('roar');
        return;
      }
      // the beam, from range (and now and then point blank)
      if (f.beamE >= 1 && dist > 50 && dist < 260 && chance(d.beam * 0.45)) { c.tap('rise'); return; }
      if (dist > 50 && dist < 120 && chance(d.leap * 0.4) && f.grounded) {
        c.tap('up'); this.diveAt = rand(0.35, 0.8);
        return;
      }
      if (dist > 70) this.plan = 'approach';
      else if (dist < 34) {
        if (r < d.aggression) {
          this.plan = 'strafe';
          if (o.state === 'block' && chance(0.5 + d.grab)) { c.tap('grab'); this.grabCd = rand(4, 7); }
          else if (o.grounded && chance(d.stomp * 0.5)) c.tap('down');
          else if (this.grabCd <= 0 && chance(d.grab * 0.2)) { c.tap('grab'); this.grabCd = rand(4, 7); }
          else { c.tap('light'); this.comboLeft = Math.floor(rand(d.combo[0], d.combo[1] + 0.99)) - 1; }
        } else this.plan = chance(0.5) ? 'strafe' : 'retreat';
      } else {
        // out of reach a grab is a run at him (Fighter.grabStart): now and then, more if he's turtling
        if (this.grabCd <= 0 && (o.state === 'free' || o.state === 'block' || o.state === 'charge') && o.grounded && chance(d.grab * (o.state === 'block' ? 1.2 : 0.16))) { c.tap('grab'); this.grabCd = rand(6, 10); }
        else if (r < d.charge * 0.6 && dist > 38) { c.press('heavy'); this.chargeHold = rand(0.6, 1.4); this.plan = 'approach'; }
        else this.plan = r < 0.3 + d.aggression * 0.6 ? 'approach' : 'strafe';
      }
      if (f.hp < f.maxHp * 0.3) this.say('low');
    }

    // ---- movement
    if (this.plan === 'approach') {
      c.move.copy(dir).addScaledVector(right, this.strafeDir * 0.2).normalize();
      // run in from far away; a running kaiju close in shoulder-charges
      if (dist > 85) c.press('dash'); else c.release('dash');
      if (f.running && dist < 40 && chance(d.aggression)) c.tap('light');
    } else if (this.plan === 'strafe') {
      c.release('dash');
      c.move.copy(right).multiplyScalar(this.strafeDir * 0.8).addScaledVector(dir, dist > 32 ? 0.5 : dist < 24 ? -0.4 : 0);
    } else if (this.plan === 'retreat') {
      c.release('dash');
      c.move.copy(dir).multiplyScalar(-0.7).addScaledVector(right, this.strafeDir * 0.5);
    }
    if (c.move.lengthSq() > 1) c.move.normalize();
  }
}
