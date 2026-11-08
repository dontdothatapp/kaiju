// On-screen controls for phones and tablets: a floating stick on the left half (walk toward /
// around the opponent) with BEAM and STOMP above it, and a thumb cluster on the right. Every control owns its finger (pointer capture), so any number can be held at
// once. The layer only shows during a fight and swallows stray taps, so the title, pause and
// results screens keep normal taps.
import { G } from '../core/context.js';

// action, label, small print, CSS class
const BUTTONS = [
  ['light', 'PUNCH', '', 'tb-light'],
  ['heavy', 'HEAVY', 'hold', 'tb-heavy'],
  ['block', 'BLOCK', '', 'tb-block'],
  ['dash', 'DASH', 'hold: run', 'tb-dash'],
  ['grab', 'GRAB', '', 'tb-grab'],
  ['super', 'SUPER', '', 'tb-super'],
  ['up', 'JUMP', '', 'tb-jump'],
  ['rise', 'BEAM', '', 'tb-rise'],
  ['down', 'STOMP', '', 'tb-stomp'],
  ['pause', 'II', '', 'tb-pause'],
];
const DEAD = 0.12;

export const TOUCH_CONTROLS = [
  ['STICK', 'Left half of the screen: walk toward / around him (through buildings)'],
  ['PUNCH', 'Combo (tap x4)'],
  ['HEAVY', 'Hold to CHARGE · after a combo hit: uppercut'],
  ['JUMP', 'Leap · then PUNCH or HEAVY: slam down on him'],
  ['STOMP', 'A quake that knocks him off his feet'],
  ['BEAM', 'KAISER BEAM / ATOMIC BREATH when the gauge is full · the stick sweeps it'],
  ['GRAB', 'Shove him through buildings · tap again: throw'],
  ['BLOCK', 'Hold · tap right before a hit to PARRY'],
  ['DASH', 'Tap: sidestep · hold: run (PUNCH while running: tackle)'],
  ['SUPER', 'Lights up at full meter: the finisher'],
];

// Phones and tablets get the controls from the start; touch laptops on their first touch.
export function setupTouch() {
  const enable = () => {
    if (G.touch) return;
    G.touch = new TouchControls(G.input);
    G.hud.setTouch(true);
  };
  const coarse = window.matchMedia && matchMedia('(pointer: coarse)').matches;
  if (coarse || new URLSearchParams(location.search).has('touch')) enable();
  else window.addEventListener('touchstart', enable, { once: true, passive: true });
  // iOS Safari: no pinch-zoom of the game
  document.addEventListener('gesturestart', (e) => e.preventDefault());
}

export class TouchControls {
  constructor(input) {
    this.input = input;
    input.touch = true;
    this.active = false;
    this.mine = new Set(); // actions currently held by a finger
    const root = this.root = document.createElement('div');
    root.id = 'touch';
    root.className = 'hidden';
    root.innerHTML = `<div class="tz-stick"><div class="tz-base"><div class="tz-knob"></div></div></div>`
      + BUTTONS.map(([a, label, small, cls]) => `<div class="tb ${cls}" data-a="${a}">${label}${small ? `<small>${small}</small>` : ''}</div>`).join('');
    document.getElementById('ui').appendChild(root);
    // empty parts of the layer eat taps (otherwise the canvas would read them as punches)
    root.addEventListener('pointerdown', (e) => e.preventDefault());
    root.addEventListener('contextmenu', (e) => e.preventDefault());
    for (const el of root.querySelectorAll('.tb')) this._button(el);
    this._stick(root.querySelector('.tz-stick'));
    this.superBtn = root.querySelector('.tb-super');
    this.beamBtn = root.querySelector('.tb-rise');
    // When the layer hides (pause, results), a finger lifted afterwards would "click" whatever
    // menu button now sits under it: swallow clicks for a moment.
    this.blockClicksUntil = 0;
    window.addEventListener('click', (e) => {
      if (performance.now() < this.blockClicksUntil) { e.stopPropagation(); e.preventDefault(); }
    }, true);
  }

  _button(el) {
    const a = el.dataset.a;
    let id = null;
    const end = (e) => {
      if (id === null) return;
      id = null;
      el.classList.remove('on');
      // pause fires on lift, so the menu doesn't open under a finger that's still down
      if (a === 'pause' && e.type === 'pointerup') { this.input.press(a); this.input.release(a); }
      this._release(a);
    };
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (id !== null) return;
      id = e.pointerId;
      el.setPointerCapture(id);
      el.classList.add('on');
      if (a === 'pause') return;
      this.mine.add(a);
      this.input.press(a);
    });
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('lostpointercapture', end);
  }

  // Floating stick: it appears under the thumb, the knob travels one radius, and the output
  // follows the left pad stick's convention (x right, z toward the opponent).
  _stick(zone) {
    const base = zone.querySelector('.tz-base'), knob = zone.querySelector('.tz-knob');
    let id = null, cx = 0, cy = 0;
    const set = (dx, dy) => {
      const r = base.offsetWidth * 0.45;
      const len = Math.hypot(dx, dy), k = len > r ? r / len : 1;
      knob.style.transform = `translate(-50%, -50%) translate(${dx * k}px, ${dy * k}px)`;
      const m = Math.min(1, len / r), out = m < DEAD ? 0 : (m - DEAD) / (1 - DEAD);
      this.input.stick.x = len ? (dx / len) * out : 0;
      this.input.stick.z = len ? (-dy / len) * out : 0;
    };
    const rest = () => {
      id = null;
      zone.classList.remove('on');
      base.style.left = base.style.top = '';
      set(0, 0);
    };
    zone.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (id !== null) return;
      id = e.pointerId;
      zone.setPointerCapture(id);
      const z = zone.getBoundingClientRect(), half = base.offsetWidth / 2;
      cx = Math.min(Math.max(e.clientX - z.left, half), z.width - half);
      cy = Math.min(Math.max(e.clientY - z.top, half), z.height - half);
      base.style.left = `${cx}px`;
      base.style.top = `${cy}px`;
      zone.classList.add('on');
      set(e.clientX - z.left - cx, e.clientY - z.top - cy);
    });
    zone.addEventListener('pointermove', (e) => {
      if (e.pointerId !== id) return;
      const z = zone.getBoundingClientRect();
      set(e.clientX - z.left - cx, e.clientY - z.top - cy);
    });
    zone.addEventListener('pointerup', (e) => { if (e.pointerId === id) rest(); });
    zone.addEventListener('pointercancel', (e) => { if (e.pointerId === id) rest(); });
    zone.addEventListener('lostpointercapture', (e) => { if (e.pointerId === id) rest(); });
    this._rest = rest;
  }

  _release(a) {
    if (!this.mine.delete(a)) return;
    this.input.release(a);
  }

  // Shown only while fighting; hiding lets go of everything so nothing stays held.
  setActive(on) {
    if (on === this.active) return;
    this.active = on;
    this.root.classList.toggle('hidden', !on);
    if (!on) {
      this.blockClicksUntil = performance.now() + 450;
      for (const a of [...this.mine]) this._release(a);
      for (const el of this.root.querySelectorAll('.on')) el.classList.remove('on');
      this._rest();
    }
  }

  update() {
    if (this.active) {
      this.superBtn.classList.toggle('ready', !!G.player && G.player.meter >= 100);
      this.beamBtn.classList.toggle('ready', !!G.player && G.player.beamE >= 1);
    }
  }

  // The tutorial (game/tutorial.js) shows only the buttons it has taught so far (null: all of
  // them); a newly taught one pops in, and the one it's waiting for glows ('stick' for the stick).
  lock(allowed) {
    for (const el of this.root.querySelectorAll('.tb')) {
      const a = el.dataset.a;
      if (a === 'pause') continue;
      const off = !!allowed && !allowed.has(a);
      if (off) { el.classList.remove('on'); this._release(a); }
      el.classList.toggle('locked', off);
    }
  }
  reveal(a) {
    const el = this.root.querySelector(`.tb[data-a="${a}"]`);
    if (!el) return;
    el.classList.remove('reveal'); void el.offsetWidth; el.classList.add('reveal');
    setTimeout(() => el.classList.remove('reveal'), 700);
  }
  want(a) {
    for (const el of this.root.querySelectorAll('.want')) el.classList.remove('want');
    const el = a === 'stick' ? this.root.querySelector('.tz-stick') : a && this.root.querySelector(`.tb[data-a="${a}"]`);
    if (el) el.classList.add('want');
  }
}
