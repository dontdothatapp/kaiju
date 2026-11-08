// Tutorial: the moves one at a time against the training dummy. Each step names a move, unlocks
// it (on a touch screen its button pops in then, so the controls fill up as you learn them) and
// waits until you've done it. The dummy plays along where a move needs him to: he swings at you
// for BLOCK and backs off for the BEAM (ai.js drills). There's no clock and nobody gets knocked out
// (Fighter.takeDamage); the end panel goes on to a real fight, free practice or the menu.
import { G, reloadWith } from '../core/context.js';

// the instruction for whatever is being played: keyboard and mouse, the touch buttons, or a pad
const key = (desk, touch, pad) => (G.input.usingPad ? pad : G.touch ? touch : desk);
const pb = (i) => `<b>${G.input.btn(i)}</b>`;
const PUNCHES = new Set(['jab', 'cross', 'hook', 'smash']);
const HEAVIES = new Set(['heavy', 'heavyCharged', 'uppercut']);
const PRAISE = ['NICE!', 'GREAT!', 'BOOM!', 'YES!', 'SMASHING!'];
const PAUSE_DONE = 1.3; // seconds the stamp shows before the next step

const punch = () => key('<b>LMB</b> or <b>J</b>', '<b>PUNCH</b>', pb(2));
const dashKey = () => key('<b>SHIFT</b>', '<b>DASH</b>', pb(7));
const heavyKey = () => key('<b>RMB</b> or <b>K</b>', '<b>HEAVY</b>', pb(3));
const jumpKey = () => key('<b>SPACE</b>', '<b>JUMP</b>', pb(0));
const flat = (p) => Math.hypot(p.vel.x, p.vel.z);

// title; buttons it unlocks; the control that glows; the dummy's drill; how much of the goal
// it takes, counted from what you do: frame (every frame), enter (a state you go into),
// hit (your attack lands: its move and 'hit' | 'block' | 'parry' | 'guardBreak'), guard (his lands on you)
const STEPS = [
  {
    title: 'WALK', want: 'stick', need: 80, bar: true,
    text: () => key('<b>W A S D</b> walk you toward and around him. Anything in the way gets flattened. Walk around a bit',
      'Drag on the left half of the screen to walk toward and around him. Anything in the way gets flattened',
      '<b>L-STICK</b> walks you toward and around him. Anything in the way gets flattened'),
    frame: (p, dt) => (p.ctrl.move.lengthSq() > 0.04 ? flat(p) * dt : 0),
  },
  {
    title: 'PUNCH', unlock: ['light'], want: 'light', need: 3,
    text: () => `Walk up to him and ${key('click or press', 'tap', 'press')} ${punch()}. Land three`,
    hit: (mv) => (PUNCHES.has(mv.name) ? 1 : 0),
  },
  {
    title: 'COMBO', want: 'light', need: 1,
    text: (p) => `${punch()} four times in a row: the fourth (${p.def.rig === 'mech' ? 'the hammer' : 'the tail whip'}) knocks him flat`,
    hit: (mv, out) => (mv.name === 'smash' && out === 'hit' ? 1 : 0),
  },
  {
    title: 'SIDESTEP', unlock: ['dash'], want: 'dash', need: 2,
    text: () => `Tap ${dashKey()} to hop out of the way. Do it twice`,
    enter: (s) => (s === 'dash' ? 1 : 0),
  },
  {
    title: 'RUN', want: 'dash', need: 120, bar: true,
    text: () => `Hold ${dashKey()} while you walk to RUN, straight through a block or two`,
    frame: (p, dt) => (p.running ? flat(p) * dt : 0),
  },
  {
    title: 'HEAVY', unlock: ['heavy'], want: 'heavy', need: 1,
    text: () => `Tap ${heavyKey()} for a heavy hit`,
    hit: (mv) => (HEAVIES.has(mv.name) ? 1 : 0),
  },
  {
    title: 'CHARGE', want: 'heavy', need: 1,
    text: () => `Hold ${heavyKey()} until it flashes, then let go: he goes through whatever's behind him`,
    hit: (mv) => (mv.name === 'heavyCharged' && (mv.charge || 0) >= 0.5 ? 1 : 0),
  },
  {
    title: 'LEAP', unlock: ['up'], want: 'up', need: 1,
    text: () => `${jumpKey()} to leap`,
    enter: (s) => (s === 'jump' ? 1 : 0),
  },
  {
    title: 'SLAM', want: 'light', need: 1,
    text: (p) => {
      const attack = key('<b>LMB</b> or <b>RMB</b>', '<b>PUNCH</b> or <b>HEAVY</b>', `${pb(2)} or ${pb(3)}`);
      return p.state === 'jump' ? `Now ${attack}: ${p.def.diveName}!` : `${jumpKey()} again, then ${attack} in the air to slam down on him`;
    },
    // a frame check, not an entry: the slam may already be under way when the step comes up
    frame: (p) => (p.state === 'dive' || (p.move && p.move.name === 'diveSlam') ? 1 : 0),
  },
  {
    title: 'STOMP', unlock: ['down'], want: 'down', need: 1,
    text: () => `${key('Press <b>C</b>', 'Tap <b>STOMP</b>', `Press ${pb(6)}`)}: the quake knocks anyone near you off their feet`,
    frame: (p) => (p.move && p.move.name === 'stomp' && p.move.started ? 1 : 0),
  },
  {
    title: 'BLOCK', unlock: ['block'], want: 'block', need: 2, drill: 'swing',
    text: () => `He swings at you now. Hold ${key('<b>Q</b> or <b>F</b>', '<b>BLOCK</b>', pb(4))} to block two hits. Tap it just before one lands to PARRY`,
    guard: (out) => (out === 'parry' ? 2 : out === 'block' ? 1 : 0),
  },
  {
    title: 'GRAB', unlock: ['grab'], want: 'grab', need: 1,
    text: () => `Get close and tap ${key('<b>E</b>', '<b>GRAB</b>', pb(1))}: you shove him through the buildings. Tap it again to throw`,
    frame: (p) => (p.grab && p.grab.phase === 'throw' ? 1 : 0),
  },
  {
    title: 'BEAM', unlock: ['rise'], want: 'rise', need: 1, drill: 'keepAway', beam: true,
    text: (p) => `He's backing off. ${key('Press <b>G</b>', 'Tap <b>BEAM</b>', `Press ${pb(12)}`)}: ${p.def.beamName}! ${key('<b>A</b> / <b>D</b>', 'The stick', 'The stick')} sweeps it across the skyline`,
    frame: (p) => (p.state === 'beam' && p.beamPh === 'fire' ? 1 : 0),
  },
  {
    title: 'SUPER', unlock: ['super'], want: 'super', need: 1, meter: true,
    text: (p) => `Your meter is full. Get close and ${key('press <b>R</b>', 'tap <b>SUPER</b>', `press ${pb(5)}`)}: ${p.def.superName}!`,
    enter: (s) => (s === 'super' ? 1 : 0),
  },
];

export class Tutorial {
  constructor(game) {
    this.game = game;
    this.el = document.getElementById('tut');
    this.endEl = document.getElementById('tutEnd');
    this.el.querySelector('.tt-skip').addEventListener('click', () => { G.audio && G.audio.sting('ui'); this.skip(); });
    this.endEl.querySelector('#teFight').addEventListener('click', () => this.fight());
    this.endEl.querySelector('#tePractice').addEventListener('click', () => this.practice());
    this.endEl.querySelector('#teMenu').addEventListener('click', () => reloadWith({}));
    this.allowed = null;
    this.active = false;
  }

  start() {
    this.steps = STEPS.filter((s) => !(s.desk && G.touch));
    this.i = -1;
    this.allowed = new Set(); // walking is free from the start; every button is taught
    this.active = true;
    this.free = false;    // free practice after the last step
    this.panel = false;   // the end panel is up
    this.wait = 1.2;      // the TUTORIAL banner first
    this.prevState = G.player.state;
    G.touch && (G.touch.lock(this.allowed), G.touch.want(null));
  }

  get step() { return this.steps[this.i]; }

  _next() {
    this.i++;
    if (this.i >= this.steps.length) return this._finish();
    const s = this.step;
    this.count = 0;
    this.done = false;
    for (const a of s.unlock || []) { this.allowed.add(a); G.touch && G.touch.reveal(a); }
    if (G.touch) { G.touch.lock(this.allowed); G.touch.want(s.want); }
    this.game.brain.drill = s.drill || null;
    if (s.meter) G.player.meter = 100;
    this.el.querySelector('.tt-step').textContent = `STEP ${this.i + 1} / ${this.steps.length}`;
    this.el.querySelector('.tt-title').textContent = s.title;
    this.text = null;
    this._render();
    this.el.classList.remove('hidden', 'done', 'in'); void this.el.offsetWidth; this.el.classList.add('in');
    G.audio && G.audio.sting('ui');
  }

  _add(n) {
    const s = this.step;
    if (!n || this.done) return;
    this.count = Math.min(s.need, this.count + n);
    this._renderProgress();
    if (this.count >= s.need) this._complete(PRAISE[Math.floor(Math.random() * PRAISE.length)]);
  }

  _complete(word) {
    this.done = true;
    this.wait = PAUSE_DONE;
    this.el.querySelector('.tt-stamp').textContent = word;
    this.el.classList.remove('done'); void this.el.offsetWidth; this.el.classList.add('done');
    G.touch && G.touch.want(null);
    if (word !== 'SKIPPED') G.audio && G.audio.sting('streak');
  }

  skip() {
    if (!this.active || this.free || this.panel) return;
    if (this.done || this.i < 0) { this.wait = 0.01; return; } // already on the way to the next one
    this._complete('SKIPPED');
    this.wait = 0.5;
  }

  _render() {
    const s = this.step;
    const t = s.text(G.player);
    if (t !== this.text) { this.text = t; this.el.querySelector('.tt-text').innerHTML = t; }
    this._renderProgress();
  }

  _renderProgress() {
    const s = this.step, el = this.el.querySelector('.tt-prog');
    const html = s.bar ? `<div class="tt-bar"><i style="width:${Math.round((this.count / s.need) * 100)}%"></i></div>`
      : s.need > 1 ? `<div class="tt-pips">${Array.from({ length: s.need }, (_, k) => `<i class="${k < this.count ? 'on' : ''}"></i>`).join('')}</div>` : '';
    if (html !== this.progHtml) { this.progHtml = html; el.innerHTML = html; }
  }

  update(dt, realDt) {
    const p = G.player;
    if (p.hp < p.maxHp) p.hp = Math.min(p.maxHp, p.hp + dt * 5); // the dummy heals himself (ai.js)
    const entered = p.state !== this.prevState ? p.state : null;
    this.prevState = p.state;
    if (!this.active || this.free || this.panel) return;
    if (this.wait > 0) {
      this.wait -= realDt;
      if (this.wait <= 0) { if (p.state === 'super') this.wait = 0.1; else this._next(); } // the super's cinematic plays out first
      return;
    }
    const s = this.step;
    if (s.meter && p.meter < 100 && p.state !== 'super') p.meter = 100; // a missed super keeps it full anyway
    if (s.beam && p.beamE < 1 && p.state !== 'beam') p.beamE = 1;
    if (entered && s.enter) this._add(s.enter(entered));
    if (s.frame) this._add(s.frame(p, dt));
    if (!this.done) this._render(); // the text follows the device in use and, for DIVE, where he is
  }

  // from Fighter._tryHit, through Game.onHit
  onHit(att, vic, mv, outcome) {
    if (!this.active || this.free || this.panel || this.wait > 0 || !this.step) return;
    const s = this.step;
    if (att === G.player && s.hit) this._add(s.hit(mv, outcome));
    if (vic === G.player && s.guard) this._add(s.guard(outcome));
  }

  _finish() {
    this.panel = true;
    this.allowed = null;
    this.game.brain.drill = null;
    this.el.classList.add('hidden');
    if (G.touch) { G.touch.lock(null); G.touch.want(null); }
    this.endEl.classList.remove('hidden');
    G.audio && G.audio.sting('win');
  }

  // end panel: a real fight in the same city, the dummy with every move unlocked, or the menu
  fight() {
    G.audio && G.audio.sting('ui');
    this.stop();
    this.game.start('sparring');
  }

  practice() {
    G.audio && G.audio.sting('ui');
    this.endEl.classList.add('hidden');
    this.panel = false;
    this.free = true;
    G.hud.hint(key('Free practice: every move is unlocked. <b>ESC</b> for the menu',
      'Free practice: every move is unlocked. <b>II</b> for the menu',
      `Free practice: every move is unlocked. ${pb(9)} for the menu`));
    setTimeout(() => this.active && this.free && G.hud.hint(''), 6000);
  }

  stop() {
    this.active = false;
    this.allowed = null;
    this.panel = false;
    this.game.brain.drill = null;
    this.el.classList.add('hidden');
    this.endEl.classList.add('hidden');
    if (G.touch) { G.touch.lock(null); G.touch.want(null); }
    G.hud.setTutorial(false);
    G.hud.hint('');
  }
}
