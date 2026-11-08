// Gamepad menus: the title, pause and results screens get a focus highlight that the d-pad or
// left stick moves (spatially, between whatever is on screen); the bottom face button presses,
// the right one backs out of the pause menu, and start fights from the title. A select edits in
// place: left / right picks, confirm applies (the quality and city options reload the page),
// back keeps the old value. The highlight only shows while the pad is the device in use.
import { G } from '../core/context.js';

// screen, what can take focus there, where focus starts
const SCREENS = [
  ['#titleCtrl', '#ctrlBack', '#ctrlBack'],
  ['#pause', '.p-box button', '#resumeBtn'],
  ['#tutEnd', '.p-box button', '#teFight'],
  ['#results', '.r-btns button', '#rRematch'],
  ['#title', '.t-vs .pick, .t-diff button, .t-opts label, #fightBtn, .t-more button', '#fightBtn'],
];
const DIRS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
const shown = (el) => el.getClientRects().length > 0;
const sting = (s) => G.audio && G.audio.sting(s);

export class PadMenu {
  constructor(root) {
    this.root = root;
    this.scr = null;
    this.focus = null;
    this.edit = null; // { label, sel, was } while a select is being changed
    this.lit = false;
  }

  _items() { return [...this.root.querySelectorAll(`${this.scr[0]} :is(${this.scr[1]})`)].filter(shown); }

  update() {
    const inp = G.input;
    if (inp.usingPad !== this.lit) document.body.classList.toggle('padnav', this.lit = inp.usingPad);
    // (the results docked in a corner during the tour are not a menu: the stick flies him)
    const s = SCREENS.find(([sel]) => { const c = this.root.querySelector(sel).classList; return !c.contains('hidden') && !c.contains('docked'); }) || null;
    if (s !== this.scr) {
      this._cancel();
      this.scr = s;
      this._focus(s && this.root.querySelector(s[2]), false);
    }
    if (!s || !inp.pad) return;
    if (!this.focus || !shown(this.focus)) this._focus(this._items()[0], false);
    const hit = (i) => inp.padHit.has(i);
    if (this.edit) {
      const { sel, was } = this.edit, n = sel.options.length;
      if (inp.nav) { sel.selectedIndex = (sel.selectedIndex + (inp.nav === 'left' || inp.nav === 'up' ? n - 1 : 1)) % n; sting('hover'); }
      if (hit(0)) { this._cancel(false); if (sel.value !== was) sel.dispatchEvent(new Event('change')); } else if (hit(1)) this._cancel();
      return;
    }
    if (inp.nav && this.focus) this._move(inp.nav);
    if (hit(0)) this._press(this.focus);
    else if (hit(1) && s[0] === '#pause') this.root.querySelector('#resumeBtn').click();
    else if (hit(1) && s[0] === '#titleCtrl') this.root.querySelector('#ctrlBack').click();
    else if (hit(9) && s[0] === '#title') this.root.querySelector('#fightBtn').click();
  }

  _focus(el, sound = true) {
    if (this.focus) this.focus.classList.remove('pf');
    this.focus = el || null;
    if (!el) return;
    el.classList.add('pf');
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (sound) sting('hover');
  }

  // nearest item wholly in that direction (left / right: in the same row), favouring ones in
  // line; nothing past the edge, except that a lone row of buttons also steps (and wraps) up / down
  _move(dir) {
    const items = this._items(), [ax, ay] = DIRS[dir];
    const f = this.focus.getBoundingClientRect(), fx = f.left + f.width / 2, fy = f.top + f.height / 2;
    const inRow = (r) => r.top < f.bottom - 2 && r.bottom > f.top + 2;
    let best = null, bestD = Infinity;
    for (const el of items) {
      const r = el.getBoundingClientRect();
      const past = dir === 'up' ? r.bottom <= f.top + 2 : dir === 'down' ? r.top >= f.bottom - 2
        : inRow(r) && (dir === 'left' ? r.right <= f.left + 2 : r.left >= f.right - 2);
      if (el === this.focus || !past) continue;
      const dx = r.left + r.width / 2 - fx, dy = r.top + r.height / 2 - fy;
      const d = dx * ax + dy * ay + Math.abs(dx * ay + dy * ax) * 2;
      if (d < bestD) { bestD = d; best = el; }
    }
    if (!best && ay && items.every((el) => inRow(el.getBoundingClientRect()))) {
      const i = items.indexOf(this.focus), n = items.length;
      best = items[(i + (ay < 0 ? n - 1 : 1)) % n];
    }
    if (best && best !== this.focus) this._focus(best);
  }

  _press(el) {
    if (!el) return;
    const sel = el.querySelector('select');
    if (sel) { this.edit = { label: el, sel, was: sel.value }; el.classList.add('editing'); sting('ui'); return; }
    (el.querySelector('input') || el).click();
  }

  _cancel(restore = true) {
    if (!this.edit) return;
    if (restore) this.edit.sel.value = this.edit.was;
    this.edit.label.classList.remove('editing');
    this.edit = null;
  }
}
