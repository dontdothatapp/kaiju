// Keyboard + mouse + gamepad + on-screen touch controls, mapped to abstract fighting-game actions.
const KEYMAP = {
  KeyW: 'fwd', ArrowUp: 'fwd',
  KeyS: 'back', ArrowDown: 'back',
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',
  Space: 'up',
  KeyC: 'down', ControlLeft: 'down',
  ShiftLeft: 'dash', ShiftRight: 'dash',
  KeyJ: 'light',
  KeyK: 'heavy',
  KeyE: 'grab', KeyL: 'grab',
  KeyQ: 'block', KeyF: 'block',
  KeyR: 'super', KeyU: 'super',
  KeyG: 'rise', KeyB: 'rise',
  Escape: 'pause', KeyP: 'pause',
  Enter: 'confirm',
  KeyH: 'help',
  KeyM: 'mute',
  KeyN: 'newcity',
  KeyX: 'explore',
};
// Standard-mapping pad (Gamepad API): 0-3 face buttons (bottom, right, left, top), 4 / 5 bumpers,
// 6 / 7 triggers, 8 back, 9 start, 10 / 11 stick clicks, 12-15 d-pad up, down, left, right.
// A leaps, LT stomps, RT runs (tap: sidestep), D-pad up or R3 fires the beam.
const PAD = { 0: 'up', 1: 'grab', 2: 'light', 3: 'heavy', 4: 'block', 5: 'super', 6: 'down', 7: 'dash', 8: 'help', 9: 'pause', 11: 'rise', 12: 'rise' };
// what each layout prints on those buttons (controls panels, hints)
const DPAD = ['L3', 'R3', 'D-PAD ↑', 'D-PAD ↓', 'D-PAD ←', 'D-PAD →'];
const PAD_LABELS = {
  xbox: ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'VIEW', 'MENU', ...DPAD],
  ps: ['✕', '○', '□', '△', 'L1', 'R1', 'L2', 'R2', 'SHARE', 'OPTIONS', ...DPAD],
  switch: ['B', 'A', 'Y', 'X', 'L', 'R', 'ZL', 'ZR', '−', '+', ...DPAD],
};
const layoutOf = (id) => (/054c|sony|playstation|dualshock|dualsense/i.test(id) ? 'ps' : /057e|nintendo|pro controller|joy-con/i.test(id) ? 'switch' : 'xbox');
// Sticks: radial dead zone, rescaled so output starts at 0 on its edge and saturates just short of
// the rim (worn sticks rarely reach 1 on the diagonals). Triggers: a little rest slack, full at ~60%.
const STICK_DZ = 0.2, STICK_MAX = 0.95, TRIG_DZ = 0.08, TRIG_FULL = 0.58;
const _ls = { x: 0, y: 0 }, _rs = { x: 0, y: 0 };
function deadzone(x, y, out) {
  const m = Math.hypot(x, y), k = m < STICK_DZ ? 0 : Math.min(1, (m - STICK_DZ) / (STICK_MAX - STICK_DZ)) / m;
  out.x = x * k; out.y = y * k;
  return out;
}
const trigger = (b) => (b ? Math.max(0, Math.min(1, (b.value - TRIG_DZ) / (TRIG_FULL - TRIG_DZ))) : 0);

export class Input {
  constructor(dom) {
    this.held = new Set();
    this.pressedNow = new Set();
    this.releasedNow = new Set();
    this._down = new Set();
    this._pressedQ = new Set();
    this._releasedQ = new Set();
    this.axes = { x: 0, z: 0, y: 0 };
    this.stick = { x: 0, z: 0 }; // touch joystick (src/game/touch.js), same convention as the left pad stick
    // free roam looks around: mouse drag in pixels this frame, right stick across as a rate
    this.look = { x: 0, y: 0 };
    this.lookRate = 0;
    this._lookQ = { x: 0, y: 0 };
    this.usingPad = false;
    this.pad = null;       // this frame's snapshot of the pad being played, or null
    this.padId = '';
    this.padLayout = 'xbox';
    this.padPrev = [];     // per standard button: down last frame
    this.padHit = new Set(); // standard buttons pressed this frame (menus, game/padmenu.js)
    this.nav = null;       // menu direction this frame: 'up' | 'down' | 'left' | 'right', auto-repeating
    this.navHeld = null; this.navAt = 0;
    this.padLost = false;  // the pad being played with was unplugged this frame
    this.onPadChange = null;

    const down = (a) => this.press(a);
    const up = (a) => this.release(a);
    window.addEventListener('keydown', (e) => {
      if (!e.repeat) this._anyKeyQ = true; // "press any key" means any key, bound or not
      const a = KEYMAP[e.code];
      if (a) {
        if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
        if (!e.repeat) down(a);
        this.usingPad = false;
      }
    });
    window.addEventListener('keyup', (e) => {
      const a = KEYMAP[e.code];
      if (a) up(a);
    });
    window.addEventListener('blur', () => {
      for (const a of this._down) this._releasedQ.add(a);
      this._down.clear();
    });
    dom.addEventListener('mousedown', (e) => {
      if (e.button === 0) down('light');
      if (e.button === 2) down('heavy');
      if (e.button === 1) { down('grab'); e.preventDefault(); }
      this.usingPad = false;
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) up('light');
      if (e.button === 2) up('heavy');
      if (e.button === 1) up('grab');
    });
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'mouse' && e.buttons) { this._lookQ.x += e.movementX; this._lookQ.y += e.movementY; }
    });
  }

  // Action edges from any source; the on-screen touch buttons call these directly.
  press(a) {
    if (!this._down.has(a)) this._pressedQ.add(a);
    this._down.add(a);
  }
  release(a) {
    if (this._down.has(a)) this._releasedQ.add(a);
    this._down.delete(a);
  }

  // Keep the pad we're on while it stays connected, else the first standard-mapping one. Pads
  // can come and go at any time (Chrome only reveals one after a button press on the page).
  _pickPad() {
    let pads = [];
    try { pads = navigator.getGamepads ? [...navigator.getGamepads()].filter((p) => p && p.connected) : []; } catch (e) { /* blocked by a frame's permissions policy */ }
    return pads.find((p) => `${p.index}:${p.id}` === this.padId) || pads.find((p) => p.mapping === 'standard') || pads[0] || null;
  }

  poll() {
    this.anyKeyNow = !!this._anyKeyQ; this._anyKeyQ = false;
    this.pressedNow = this._pressedQ; this._pressedQ = new Set();
    this.releasedNow = this._releasedQ; this._releasedQ = new Set();
    this.held = new Set(this._down);
    this.look.x = this._lookQ.x; this.look.y = this._lookQ.y;
    this._lookQ.x = this._lookQ.y = 0;
    this.lookRate = 0;

    let x = 0, z = 0, y = 0;
    if (this.held.has('left')) x -= 1;
    if (this.held.has('right')) x += 1;
    if (this.held.has('fwd')) z += 1;
    if (this.held.has('back')) z -= 1;
    if (this.held.has('up')) y += 1;
    if (this.held.has('down')) y -= 1;
    x += this.stick.x; z += this.stick.z;

    const p = this.pad = this._pickPad();
    const id = p ? `${p.index}:${p.id}` : '';
    this.padHit.clear(); this.nav = null; this.padLost = false;
    if (id !== this.padId) {
      // plugged in, unplugged or swapped: whatever the old pad held lets go
      this.padPrev.forEach((was, i) => { if (was && PAD[i]) this.releasedNow.add(PAD[i]); });
      this.padPrev = []; this.navHeld = null;
      this.padLost = !p && this.usingPad;
      if (!p) this.usingPad = false;
      this.padId = id;
      this.padLayout = p ? layoutOf(p.id) : 'xbox';
      this.onPadChange && this.onPadChange(p);
    }
    if (p) {
      const b = p.buttons;
      for (let i = 0; i < b.length; i++) {
        const was = !!this.padPrev[i];
        // triggers press past halfway and let go below 30% (no chatter); the rest are digital
        const on = i === 6 || i === 7 ? b[i].value > (was ? 0.3 : 0.5) : b[i].pressed || b[i].value > 0.5;
        this.padPrev[i] = on;
        if (on && !was) { this.padHit.add(i); this.anyKeyNow = true; }
        const act = PAD[i];
        if (!act) continue;
        if (on) this.held.add(act);
        if (on && !was) this.pressedNow.add(act);
        if (!on && was) this.releasedNow.add(act);
      }
      const ls = deadzone(p.axes[0] || 0, p.axes[1] || 0, _ls), rs = deadzone(p.axes[2] || 0, p.axes[3] || 0, _rs);
      const lt = trigger(b[6]), rt = trigger(b[7]);
      x += ls.x; z -= ls.y;
      y += rt - lt - rs.y;
      this.lookRate = rs.x;
      if (this.padHit.size || ls.x || ls.y || rs.y || lt || rt) this.usingPad = true;
      // menus: the d-pad or a firmly pushed left stick, repeating like a held key
      const sx = Math.abs(ls.x) > 0.6 && Math.abs(ls.x) > Math.abs(ls.y) ? Math.sign(ls.x) : 0;
      const sy = !sx && Math.abs(ls.y) > 0.6 ? Math.sign(ls.y) : 0;
      const on = (i) => !!(b[i] && b[i].pressed);
      const d = on(12) || sy < 0 ? 'up' : on(13) || sy > 0 ? 'down' : on(14) || sx < 0 ? 'left' : on(15) || sx > 0 ? 'right' : null;
      const now = performance.now();
      if (d !== this.navHeld) { this.navHeld = d; this.navAt = now + 380; this.nav = d; }
      else if (d && now >= this.navAt) { this.navAt = now + 130; this.nav = d; }
    }
    const len = Math.hypot(x, z);
    if (len > 1) { x /= len; z /= len; }
    this.axes.x = x; this.axes.z = z; this.axes.y = Math.max(-1, Math.min(1, y));
  }

  pressed(a) { return this.pressedNow.has(a); }
  isHeld(a) { return this.held.has(a); }
  released(a) { return this.releasedNow.has(a); }
  anyPressed() { return this.pressedNow.size > 0 || this.anyKeyNow; }
  // what the connected pad prints on standard button i
  btn(i) { return PAD_LABELS[this.padLayout][i]; }

  // Dual-rumble on the pad being played (Chrome, Edge, Safari; Firefox's pulse() if it has one);
  // phones buzz instead (Android; iOS has no vibrate).
  rumble(strong, weak, ms) {
    const p = this.pad;
    if (p && this.usingPad) {
      const a = p.vibrationActuator, h = p.hapticActuators && p.hapticActuators[0];
      try {
        if (a) Promise.resolve(a.playEffect('dual-rumble', { duration: ms, strongMagnitude: Math.min(1, strong), weakMagnitude: Math.min(1, weak) })).catch(() => {});
        else if (h && h.pulse) Promise.resolve(h.pulse(Math.min(1, Math.max(strong, weak)), ms)).catch(() => {});
      } catch (e) { /* unsupported */ }
      return;
    }
    if (this.touch && navigator.vibrate) navigator.vibrate(Math.round(ms * Math.min(1, strong + 0.3) * 0.5));
  }
}
