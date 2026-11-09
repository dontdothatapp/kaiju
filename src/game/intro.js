// Round openers, shot like a film. Any key or tap skips. Shots drive FightCamera.override and
// hand back to the lock-on camera.
// Round 1: a letterboxed aerial establishing shot of the city with a location card, then the bot's
// kaiju makes his entrance, then yours, each in his own way:
//   KAISER-OH flies in: a powered descent on an angle from high over the city behind his mark,
//   thrusters braking all the way, a hero landing on one knee in a crater, then he stands up
//   into his guard (Fighter.descend / standUp);
//   GORRAX comes on foot: charging down the street behind his mark (through whatever is in the
//   way), every footfall a quake, then he plants himself on it and roars into the lens.
// Rounds 2 and 3: nobody drops out of the sky. The loser picks himself up where he went down, both
// walk back to their corners facing each other (about 70 m apart, on open ground), then the
// monster roars and the robot strikes its pose, in a wide, low two-shot.
import * as THREE from 'three';
import { G } from '../core/context.js';
import { clamp, lerp, UP } from '../core/math.js';
import { ARENA } from '../world/boundary.js';

const SKY = 700;   // fighters wait up here, hidden, until their entrance
const EST = 3.3;   // the establishing shot
const ease = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
const _p = new THREE.Vector3();

const street = (p) => G.ground.heightAt(p.x, p.z);
const inArena = (p, margin) => Math.abs(p.x) < ARENA - margin && Math.abs(p.z) < ARENA - margin;
// standing building chunks within r of p
function chunks(p, r) {
  let n = 0;
  G.destruction.forChunksInSphere(p, r, () => { n++; });
  return n;
}

// The city remembers, so by round 2 a mark is usually last round's crater (or a rubble pile), and
// standing in it sinks a fighter below the street. Stand on the flattest open ground near it
// instead: rings out to `reach` m, skipping anything under or inside a structure.
function openSpot(mark, reach = 48) {
  const p = new THREE.Vector3(), best = mark.clone().setY(street(mark));
  let bestScore = Infinity;
  for (let r = 0; r <= reach; r += 8) {
    const n = r ? Math.round(r * 0.9) : 1;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      p.set(mark.x + Math.cos(a) * r, 0, mark.z + Math.sin(a) * r);
      if (r && !inArena(p, 20)) continue;
      let rough = 0;
      for (const [dx, dz] of [[0, 0], [9, 0], [-9, 0], [0, 9], [0, -9], [6, 6], [-6, -6]]) rough = Math.max(rough, Math.abs(G.ground.heightAt(p.x + dx, p.z + dz)));
      if (rough > bestScore) continue;
      let blocked = false;
      for (let y = 3; y <= 15 && !blocked; y += 6) G.destruction.forChunksInSphere(p.setY(y), 7, () => { blocked = true; });
      if (blocked) continue;
      const score = rough + r * 0.01; // the mark itself wins a tie
      if (score < bestScore) { bestScore = score; best.set(p.x, street(p), p.z); }
    }
    if (bestScore < 0.3) break; // flat enough: don't wander further from the mark
  }
  return best;
}

// a camera position round the mark, swinging from `from` to `to` at a radius and height eased
// between theirs (a crane that keeps its distance from the kaiju in the middle)
function crane(c, from, to, k) {
  const a0 = Math.atan2(from.x - c.x, from.z - c.z);
  let da = Math.atan2(to.x - c.x, to.z - c.z) - a0;
  da = Math.atan2(Math.sin(da), Math.cos(da));
  const a = a0 + da * k, r = lerp(Math.hypot(from.x - c.x, from.z - c.z), Math.hypot(to.x - c.x, to.z - c.z), k);
  return new THREE.Vector3(c.x + Math.sin(a) * r, lerp(from.y, to.y, k), c.z + Math.cos(a) * r);
}

export class Intro {
  constructor(game) {
    this.game = game;
    this.active = false;
    this.camPos = new THREE.Vector3();
    this.camLook = new THREE.Vector3();
    this.override = { pos: this.camPos, look: this.camLook };
    this.lift = 0;
    this._skip = () => this.skip();
  }

  start(full) {
    const g = this.game;
    this.full = full;
    this.t = 0;
    this.active = true;
    this.lift = 0;
    // nothing pressed last round carries over into the opener
    for (const f of [g.player, g.bot]) {
      f.ctrl.move.set(0, 0, 0); f.ctrl.vert = 0; f.ctrl._h.clear(); f.ctrl.clearEdges(); f.buffer = null;
    }
    if (full) this._startFull(); else this._startShort();
    G.post.letterboxTarget = 1;
    G.hud.location(null);
    G.hud.showHUD(false);
    G.hud.skipHint(true);
    G.fightCam.override = this.override;
    // touch screens: the on-screen controls are hidden now, so listen for any tap ourselves
    setTimeout(() => this.active && window.addEventListener('pointerdown', this._skip), 250);
  }

  // ---------------------------------------------------------------- round 1
  _startFull() {
    const L = G.layout.landing, g = this.game;
    const heir = openSpot(L.heir), pat = openSpot(L.patriarch);
    this.mid = heir.clone().lerp(pat, 0.5);
    this.spots = [[g.player, heir, pat], [g.bot, pat, heir]];
    for (const [f, at] of this.spots) f.park(_p.set(at.x, SKY, at.z));
    // the bot's kaiju first, then yours (whose shot hands over to the fight camera)
    this.acts = [this._plan(g.bot, pat, heir, false), this._plan(g.player, heir, pat, true)];
    this.act = -1;
    this.carded = false;
  }

  _plan(f, mark, other, last) {
    const toward = other.clone().sub(mark).setY(0).normalize(); // at the other one
    const right = new THREE.Vector3().crossVectors(toward, UP);
    const a = { f, mark, other, last, toward, fly: f.def.rig === 'mech' };
    // where the last shot ends: about where the lock-on camera picks up, behind him and to his right
    a.handPos = mark.clone().addScaledVector(toward, -100).addScaledVector(right, 95).setY(mark.y + 42);
    a.handLook = mark.clone().lerp(other, 0.55).setY(mark.y + 34);
    a.chest = f.hipH + f.H * 0.12; // over the street
    if (a.fly) this._planFly(a); else this._planStomp(a);
    return a;
  }

  // KAISER-OH comes in from high over the city behind his mark, along a curve that steepens into
  // the drop: from straight behind, or the nearest way round that doesn't take him through a
  // tower on the way down. The bot is shot from the street ahead of him, looking up as he comes
  // down at the lens; yours from high behind his mark (he plummets into the frame and craters it),
  // then the camera cranes down behind him.
  _planFly(a) {
    const { mark, toward, f } = a;
    a.to = mark.clone().setY(mark.y + f.hipH);
    const q = new THREE.Vector3();
    for (const deg of [0, 15, -15, 30, -30, 45, -45, 60, -60, 75, -75, 90, -90, 120, -120, 150, -150, 180]) {
      const out = toward.clone().negate().applyAxisAngle(UP, (deg * Math.PI) / 180);
      const from = mark.clone().addScaledVector(out, 200).setY(a.to.y + 220);
      const via = mark.clone().addScaledVector(out, 45).setY(a.to.y + 80);
      let n = 0;
      for (let s = 0.05; s < 0.96; s += 0.05) {
        const r = 1 - s;
        q.copy(from).multiplyScalar(r * r).addScaledVector(via, 2 * r * s).addScaledVector(a.to, s * s);
        n += chunks(q, 12) + chunks(_p.copy(q).setY(q.y + 14), 12) + chunks(_p.copy(q).setY(q.y - 16), 10);
      }
      if (!a.from || n < a.n) { a.from = from; a.via = via; a.n = n; a.dir = out.negate(); } // a.dir: the way he flies
      if (!n) break;
    }
    a.cam = a.last ? this._camSpot(mark, a.dir, [[-95, 35, 58], [-95, -35, 58], [-75, 0, 70], [-110, 50, 80], [-110, -50, 80]], a.other)
      : this._camSpot(mark, a.dir, [[62, 48, 7], [62, -48, 7], [80, 30, 9], [80, -30, 9], [45, 70, 7], [45, -70, 7], [75, 0, 7], [72, 18, 7], [72, -18, 7]], a.other);
    a.look = mark.clone().addScaledVector(a.dir, 25).setY(mark.y + 30);
  }

  // GORRAX comes on foot: the clearest run at his mark from 60-130 m out behind it (down a street,
  // if there is one), starting outside any building and inside the arena. Wading through what's
  // in the way is fine; the camera waits on the street ahead of his mark, off to one side.
  _planStomp(a) {
    const { mark, toward } = a;
    let best = null;
    for (let deg = -90; deg <= 90; deg += 5) {
      const out = toward.clone().negate().applyAxisAngle(UP, (deg * Math.PI) / 180);
      let n = 0, from = 0, cost = 0;
      for (let r = 8; r <= 130; r += 8) {
        const p = mark.clone().addScaledVector(out, r);
        if (!inArena(p, 18)) break;
        const gh = street(p);
        n += chunks(p.setY(gh + 10), 8) + chunks(p.setY(gh + 30), 8);
        if (r >= 60 && !chunks(p.setY(gh + 14), 9)) { from = r; cost = n; }
      }
      if (!from) continue;
      cost += Math.abs(deg) * 0.05 + (130 - from) * 0.1;
      if (!best || cost < best.cost) best = { cost, out, from };
    }
    if (!best) best = { out: toward.clone().negate(), from: 60 }; // boxed in: straight through it
    a.dir = best.out.clone().negate(); // the way he runs
    a.from = mark.clone().addScaledVector(best.out, best.from);
    a.from.y = street(a.from) + a.f.hipH;
    a.cam = this._camSpot(mark, a.dir, [[54, 45, 8], [54, -45, 8], [68, 32, 8], [68, -32, 8], [38, 56, 8], [38, -56, 8],
      [76, 0, 8], [76, 14, 8], [76, -14, 8], [24, 62, 8], [24, -62, 8]], a.other);
  }

  // the first of these spots (along, across, up from the mark) clear of buildings and of the
  // other kaiju's mark, or the least bad
  _camSpot(mark, along, list, avoid) {
    const across = new THREE.Vector3().crossVectors(along, UP);
    let best = null, bestN = Infinity;
    for (const [x, z, y] of list) {
      const c = mark.clone().addScaledVector(along, x).addScaledVector(across, z);
      c.y = mark.y + y;
      let n = chunks(c, 8) + chunks(_p.copy(c).setY(c.y + 12), 8);
      if (Math.hypot(c.x - avoid.x, c.z - avoid.z) < 36) n += 1000;
      if (n < bestN) { bestN = n; best = c; }
      if (n === 0) break;
    }
    return best;
  }

  _begin(i) {
    const a = this.acts[(this.act = i)], f = a.f;
    a.t0 = this.t;
    this.lift = 0;
    if (a.fly) {
      f.descend(a.from, a.via, a.to, 1.4 * G.time.pace);
      f.faceTo = a.mark.clone().addScaledVector(a.dir, 200); // the way he's flying
    } else {
      // already at full tilt when the shot opens
      f.pos.copy(a.from);
      f.grounded = true;
      f.face(a.mark);
      f.walkTo(a.mark, true, 42);
    }
  }

  _updateFull() {
    const [title, sub] = G.layout.caption || [];
    if (!this.carded && this.t > 0.5) { this.carded = true; G.hud.location(title, sub); }
    if (this.act < 0) {
      if (this.t >= EST) { G.hud.location(null); this._begin(0); }
      return;
    }
    const a = this.acts[this.act];
    if (a.fly) this._fly(a); else this._stomp(a);
    if (a.done && this.t >= a.done) {
      if (this.act === 0) this._begin(1);
      else this.finish();
    }
  }

  _fly(a) {
    const f = a.f, t = this.t;
    // the touchdown, the dust and the shockwave in slow motion (from a beat before he hits)
    if (!a.slowed && (f.state === 'landed' || (f.flight && f.flight.k > 0.95))) { a.slowed = true; G.time.slowmo(0.3, 0.35, 2); }
    if (f.state === 'landed' && !a.downAt) {
      a.downAt = t;
      if (!a.last) a.sayAt = t + 0.45;
    }
    if (a.sayAt && t >= a.sayAt) { a.sayAt = 0; this.game.brain.say('start'); }
    // a beat on one knee, then up into his guard, turning to the other one as he rises
    if (f.state === 'landed' && t > a.downAt + 0.45) { f.standUp(); f.faceTo = null; }
    if (f.state === 'intro' && a.downAt && !a.done) a.done = t + (a.last ? 0.55 : 0.3);
    if (!a.done && t - a.t0 > 6) a.done = t; // never wait forever
  }

  _stomp(a) {
    const f = a.f, t = this.t;
    // on his mark: feet planted (a jolt through the street), he turns on the lens...
    if (!a.plantAt && f.state === 'intro') {
      a.plantAt = t;
      const gp = _p.copy(f.pos).setY(street(f.pos));
      G.fx.dustRing(gp, 30, 16, 'dust', 1.1);
      G.audio.groundSlam(0.45, gp);
      G.fightCam.addTraumaAt(gp, 0.3, 400);
      f.faceTo = a.cam;
    }
    // ...and roars into it
    if (a.plantAt && !a.roarAt && t > a.plantAt + 0.3) {
      a.roarAt = t;
      f.roar();
      if (!a.last) this.game.brain.say('start');
      a.done = t + (a.last ? 1.7 : 1.15);
    }
    // done roaring: back to the business of the other one
    if (a.roarAt && f.state === 'free') { f.faceTo = null; f.setState('intro'); }
    if (!a.done && t - a.t0 > 6) a.done = t;
  }

  _fullShot() {
    const t = this.t;
    if (this.act < 0) {
      // establishing: high over the arena, pushing in toward the skyline (the Empire State)
      const mid = this.mid, vista = G.layout.vista, k = t / EST;
      const toVista = vista.clone().sub(mid).setY(0).normalize();
      const vSide = new THREE.Vector3().crossVectors(toVista, UP).normalize();
      const v = (o, x, y, z) => o.clone().addScaledVector(vSide, x).addScaledVector(UP, y).addScaledVector(toVista, z);
      return [v(mid, 70, 230, -300).lerp(v(mid, 35, 135, -170), ease(k)), vista.clone().lerp(v(mid, 0, 40, 160), ease(k) * 0.55)];
    }
    const a = this.acts[this.act], f = a.f, mark = a.mark;
    // his chest (the kneel lowers the body below his position)
    const chest = new THREE.Vector3(f.pos.x, f.pos.y - f.hipH + a.chest - f.crouch, f.pos.z);
    if (a.fly) {
      if (!a.last) {
        // from the street ahead of his mark, looking up at him coming in, the mark kept low in
        // the frame; pushing in a little as he gets up
        const look = mark.clone().setY(mark.y + a.chest).lerp(chest, 0.7);
        const k = a.downAt ? ease((t - a.downAt - 0.3) / 2) : 0;
        return [a.cam.clone().lerp(mark.clone().setY(a.cam.y + 4), 0.12 * k), look];
      }
      // yours: he plummets into the frame, then the camera cranes down to where the fight picks up
      const k = a.downAt ? ease((t - a.downAt - 0.25) / 1.6) : 0;
      return [crane(mark, a.cam, a.handPos, k), a.look.clone().lerp(a.handLook, k)];
    }
    // GORRAX charging at the lens; yours then swings round behind him
    const k = a.last && a.roarAt ? ease((t - a.roarAt - 0.4) / 1.3) : 0;
    return [crane(mark, a.cam, a.handPos, k), chest.lerp(a.handLook, k)];
  }

  // ---------------------------------------------------------------- rounds 2 and 3
  _startShort() {
    const g = this.game, p = g.player, b = g.bot;
    for (const f of [p, b]) this._pickUp(f);
    // their corners: about 70 m apart along the line between them, each one at most ~35 m from
    // where he is (already about right and on clear ground: they stay put)
    const u = new THREE.Vector3(b.pos.x - p.pos.x, 0, b.pos.z - p.pos.z);
    const d = u.length();
    if (d > 1) u.divideScalar(d);
    else u.subVectors(G.layout.landing.patriarch, G.layout.landing.heir).setY(0).normalize();
    const shift = clamp((d - clamp(d, 62, 78)) / 2, -35, 35); // toward the other one (or away)
    const sp = this._corner(p.pos.clone().addScaledVector(u, shift));
    const sb = this._corner(b.pos.clone().addScaledVector(u, -shift));
    this.spots = [[p, sp, sb], [b, sb, sp]];
    this.beatAt = 0;
    // a wide, low two-shot from the side of the line between them: the side the camera is
    // already on, unless that spot is inside a building
    this.mid = sp.clone().lerp(sb, 0.5);
    this.across = new THREE.Vector3().crossVectors(_p.subVectors(sb, sp).setY(0).normalize(), UP);
    this.wideD = Math.max(150, sp.distanceTo(sb) * 1.1 + 80);
    let s = Math.sign(_p.subVectors(G.camera.position, this.mid).dot(this.across)) || 1;
    const spot = (s) => this.mid.clone().addScaledVector(this.across, s * this.wideD).setY(this.mid.y + 22);
    if (chunks(spot(s), 10) > chunks(spot(-s), 10)) s = -s;
    this.across.multiplyScalar(s);
  }

  _corner(at) {
    const m = ARENA - 24;
    at.x = clamp(at.x, -m, m); at.z = clamp(at.z, -m, m);
    return openSpot(at, 32);
  }

  // whatever he was doing when the bell went stops; the loser picks himself up (the usual get-up)
  _pickUp(f) {
    const st = f.state;
    f.faceTo = null;
    if (st === 'ko') { f.setState('down'); f.stateT = 0.5; } // lies there a moment longer
    else if (st === 'down' || st === 'getup' || st === 'launched' || st === 'jump' || st === 'dive' || st === 'dash') { /* lands, gets up by itself */ }
    else {
      f.cancelActions();
      f.setState('intro');
      f.model.setAction(null, 6);
    }
  }

  _updateShort() {
    const g = this.game, t = this.t;
    for (const s of this.spots) {
      const [f, spot] = s;
      // back on his feet: off to his corner
      if (!s.there && (f.state === 'intro' || f.state === 'free') && f.grounded) {
        if (s.going || Math.hypot(spot.x - f.pos.x, spot.z - f.pos.z) < 3) { s.there = true; f.setState('intro'); f.model.setAction(null, 6); }
        else { s.going = true; f.walkTo(spot); }
      }
    }
    // both there (or near enough the time): a breather before the bell, the monster roars and the
    // robot strikes its pose, the bot first
    if (!this.beatAt && ((this.spots[0].there && this.spots[1].there) || t > 3.6)) this.beatAt = t;
    if (this.beatAt) {
      for (const [i, s] of [this.spots[1], this.spots[0]].entries()) {
        if (!s.roared && s.there && s[0].state === 'intro' && t > this.beatAt + i * 0.35 && t < this.beatAt + 0.9) { s.roared = true; s[0].roar(); }
      }
    }
    const up = (f) => f.grounded && (f.state === 'intro' || f.state === 'free' || f.state === 'taunt' || f.state === 'stride');
    if (this.beatAt && t > this.beatAt + 1.35 && up(g.player) && up(g.bot)) this.finish();
    else if (t > 7) this.finish(true); // still flying or down: cut to them standing
  }

  _shortShot() {
    const k = ease(this.t / 3.6);
    const pos = this.mid.clone().addScaledVector(this.across, this.wideD - 16 * k).setY(this.mid.y + 24 - 6 * k);
    return [pos, this.mid.clone().setY(this.mid.y + 24)];
  }

  // ---------------------------------------------------------------- run
  // Returns true once the opener is over (played out or skipped).
  update(realDt) {
    if (!this.active) return true;
    this.t += realDt;
    if (this.full) this._updateFull(); else this._updateShort();
    if (!this.active) return true;
    const [pos, look] = this.full ? this._fullShot() : this._shortShot();
    this.camPos.copy(pos);
    this.camLook.copy(look);
    // a scripted spot can end up inside a building (or under the train) on some map: rise clear
    let inside = 0;
    G.destruction.forChunksInSphere(this.camPos, 4, (id) => { inside = Math.max(inside, G.destruction.defs[id].c.y + 6 - this.camPos.y); });
    this.lift = inside > this.lift ? lerp(this.lift, inside, 1 - Math.exp(-12 * realDt)) : Math.max(inside, this.lift - 8 * realDt, 0);
    this.camPos.y += this.lift;
    return false;
  }

  skip() {
    if (this.active && this.t > 0.25) this.finish(true);
  }

  // Played out, or `cut` (skipped): anyone not on his spot is put there, standing in his guard and
  // facing the other one, and the fight camera cuts in behind you.
  finish(cut = false) {
    if (!this.active) return;
    this.active = false;
    window.removeEventListener('pointerdown', this._skip);
    for (const [f, at, other] of this.spots) {
      f.faceTo = null; f.goal = null; f.flight = null; f.running = false;
      f.model.setVisible(true);
      const settled = f.grounded && (f.state === 'intro' || f.state === 'free' || f.state === 'taunt' || f.state === 'stride');
      const off = Math.hypot(at.x - f.pos.x, at.z - f.pos.z) > (this.full ? 6 : 30);
      if (cut || !settled || off) {
        f.cancelActions();
        f.pos.set(at.x, street(at) + f.hipH, at.z);
        f.vel.set(0, 0, 0);
        f.grounded = true; f.tilt = 0; f.crouch = 0;
        f.setState('intro');
        f.face(other);
        f.model.snap('guard');
        f.model.root.position.copy(f.pos);
      } else {
        // a roar still going blends out into the guard
        f.setState('intro');
        f.model.setAction(null, 6);
      }
    }
    if (cut) { G.fightCam.cut(); G.time.slowTimer = 0; G.time.scale = 1; } // no slow motion left over
    G.fightCam.override = null;
    G.post.letterboxTarget = 0;
    G.hud.location(null);
    G.hud.skipHint(false);
  }
}
