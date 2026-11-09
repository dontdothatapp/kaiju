// Move data, at kaiju scale: the fighters are ~47 m tall, so ranges and lunges are in tens of
// metres and every swing takes a beat longer than a person's would. Times in seconds. Each move
// drives every feedback channel from a single `fx` strength so the juice scales with the hit.
//   hitstop tiers: light ~6f, heavy ~12f, launchers 14-20f (heavier than a human fighter)
//   limb: what sweeps through buildings during the active frames ('L', 'R', 'both', 'tail',
//   'head', 'foot', 'body'); launch: knockback speed in m/s (they fly, then gravity wins)
export const MOVES = {
  jab: {
    pose: ['jabW', 'jabS'], side: 'L', limb: 'L', startup: 0.13, active: 0.08, recovery: 0.24,
    dmg: 4, kb: 9, hitstun: 0.5, hitstop: 0.09, fx: 0.4, lunge: 8, range: 25,
    next: 'cross', chain: 0.34, meter: 4, sound: 'light',
  },
  cross: {
    pose: ['crossW', 'crossS'], side: 'R', limb: 'R', startup: 0.14, active: 0.08, recovery: 0.26,
    dmg: 4.5, kb: 10, hitstun: 0.52, hitstop: 0.1, fx: 0.48, lunge: 8, range: 25,
    next: 'hook', chain: 0.34, meter: 4, sound: 'light',
  },
  hook: {
    pose: ['hookW', 'hookS'], side: 'L', limb: 'L', startup: 0.19, active: 0.09, recovery: 0.3,
    dmg: 6, kb: 13, hitstun: 0.58, hitstop: 0.12, fx: 0.62, lunge: 8, range: 26,
    next: 'smash', chain: 0.36, meter: 5, sound: 'mid',
  },
  // the combo ender: KAISER HAMMER (both fists down) / GORRAX's tail whip (a full spin)
  smash: {
    pose: ['smashW', 'smashS'], side: 'R', limb: 'both', startup: 0.3, active: 0.14, recovery: 0.5,
    dmg: 10, launch: 44, up: 0.4, hitstop: 0.2, fx: 1.05, lunge: 9, range: 27,
    meter: 8, sound: 'heavy', comic: 'heavy', slowmo: [0.35, 0.22],
  },
  heavy: {
    pose: ['chargeW', 'chargeS'], side: 'R', limb: 'R', startup: 0.28, active: 0.1, recovery: 0.46,
    dmg: 10, launch: 42, up: 0.35, hitstop: 0.18, fx: 0.95, lunge: 12, range: 27,
    meter: 7, sound: 'heavy', comic: 'heavy',
  },
  // charged versions scale with `charge` (0..1) at runtime
  heavyCharged: {
    pose: ['chargeW', 'chargeS'], side: 'R', limb: 'R', startup: 0.12, active: 0.12, recovery: 0.55,
    dmg: 12, dmgCharge: 14, launch: 48, launchCharge: 34, up: 0.3, hitstop: 0.18, hitstopCharge: 0.14,
    fx: 1.1, fxCharge: 0.7, lunge: 12, lungeCharge: 22, range: 28, meter: 9, sound: 'huge', comic: 'huge',
    guardBreak: 0.7, impactFrame: 0.8, slowmo: [0.25, 0.35],
  },
  uppercut: {
    pose: ['upperW', 'upperS'], side: 'R', limb: 'R', startup: 0.22, active: 0.1, recovery: 0.46,
    dmg: 9, launch: 38, dir: 'up', hitstop: 0.16, fx: 0.95, lunge: 9, range: 26,
    meter: 7, sound: 'heavy', comic: 'heavy',
  },
  // STOMP: a quake. Knocks a grounded opponent off his feet anywhere near; jump it.
  stomp: {
    pose: ['stompW', 'stompS'], side: 'R', limb: 'foot', startup: 0.42, active: 0.1, recovery: 0.55,
    dmg: 7, quake: 52, hitstop: 0.16, fx: 0.9, lunge: 4, range: 52,
    meter: 6, sound: 'heavy', comic: 'ground',
  },
  // running shoulder tackle / headlong charge
  tackle: {
    pose: ['tackle', 'tackle'], side: 'L', limb: 'body', startup: 0.08, active: 0.26, recovery: 0.5,
    dmg: 9, launch: 44, up: 0.3, hitstop: 0.17, fx: 1.0, lunge: 22, range: 26,
    meter: 7, sound: 'heavy', comic: 'heavy',
  },
  // from a jump: KAISER KICK / GORRAX's belly slam; spikes him into the street
  diveSlam: {
    pose: ['dive', 'dive'], side: 'R', limb: 'body', startup: 0.02, active: 0.12, recovery: 0.5,
    dmg: 12, launch: 40, dir: 'down', hitstop: 0.2, fx: 1.25, lunge: 4, range: 30,
    meter: 9, sound: 'huge', comic: 'huge', guardBreak: 0.8, impactFrame: 0.9, slowmo: [0.28, 0.3],
  },
  // out of reach (range + lunge) it's a run at him first: runSpeed m/s (a normal run is 36),
  // re-aiming at runTurn rad/s, for up to runTime s, until he's within runReach and the grab goes
  // out; or a stumbling miss (runStumble s on top of the recovery) if it runs out or goes past him
  grab: {
    pose: ['grab', 'grab'], side: 'R', limb: null, startup: 0.18, active: 0.12, recovery: 0.55,
    dmg: 0, grab: true, hitstop: 0.06, fx: 0.3, lunge: 10, range: 27, meter: 0, sound: 'grab',
    runSpeed: 42, runTurn: 2.4, runTime: 1.8, runReach: 32, runStumble: 0.3,
  },
  superRush: {
    pose: ['grab', 'hold'], side: 'L', limb: null, startup: 0.28, active: 0.16, recovery: 0.6,
    dmg: 0, superGrab: true, hitstop: 0.1, fx: 0.6, lunge: 34, range: 29, meter: 0, sound: 'grab',
  },
};

// GORRAX's versions of the shared moves (same slots, different reach / feel)
const MOVE_MODS = {
  gorrax: {
    hook: { limb: 'head', range: 27, dmg: 6.5 },                     // the bite
    smash: { limb: 'tail', spin: true, range: 40, startup: 0.26, active: 0.3, recovery: 0.42, launch: 46, up: 0.3 }, // tail whip
    heavyCharged: { limb: 'both' },
  },
};

// the move table for one fighter
export function movesFor(def) {
  const mods = MOVE_MODS[def.name] || {};
  const out = {};
  for (const [k, m] of Object.entries(MOVES)) out[k] = mods[k] ? { ...m, ...mods[k] } : m;
  return out;
}

// Speeds in m/s. The first pass of these (walk 13, run 31, gravity 26, half-second ramps) was
// tuned in a headless container that never ran in real time, and played like slow motion at
// 60 fps: a 47 m kaiju crossing a 150 m-wide shot took eleven seconds. Brisker now; the Pace
// option (core/time.js) scales the whole game on top of these.
export const SPEED = {
  run: 36,       // hold DASH while walking: crashes through buildings (was 31)
  dash: 38,      // tap DASH: a heavy hop to the side (i-frames) (was 34)
  jump: 36,      // leap / rocket jump
  dive: 64,      // the slam back down on him
  shove: 15,     // grapple: walking him through buildings
  throw: 48,
  gravity: 30,   // a leap is in the air 2.4 s instead of 2.8 (was 26)
  launchGravity: 20,
  superLaunch: 62,
};

export const BEAM = {
  windup: 0.75,  // plates light up / the emblem charges
  fire: 1.7,
  recover: 0.45,
  reach: 430,
  radius: 8,     // hits him within this of the beam line (plus his body)
  tick: 0.1,
  dmg: 2.3,      // per tick
  recharge: 9,   // seconds for a full beam gauge
  turn: 0.75,    // rad/s the beam tracks him (and you sweep it with left / right)
};

// BEAM CLASH: two beams meet and lock. `k` is where they meet between the two mouths (0 at the
// one who fired first .. 1 at the other); each press shoves it `push` toward the other one, and it
// ends when it gets within `edge` of a mouth or after `time` seconds (real ones, whatever the pace)
// with whoever is ahead. `late` / `counter` are where it starts for a beam fired into one already
// pouring out (still winding up / fired from inside its hitstun).
export const CLASH = {
  minDist: 40,   // closer than this the beams just hit the bodies
  push: 0.045,
  edge: 0.08,
  time: 3.2,
  late: 0.58,
  counter: 0.66,
  dmg: 20,
  launch: 60,
  mash: { training: 0, sparring: 4.2, brutal: 6, king: 7.5 }, // the bot's presses per second
};

// RAGE: the first time a round takes him under `at` of his health he gets his second wind, for
// the rest of the round: hits `power` times harder, the beam gauge refills `beam` times faster,
// and `meter` goes onto his super on the spot.
export const RAGE = { at: 0.3, power: 1.2, beam: 1.6, meter: 25 };
