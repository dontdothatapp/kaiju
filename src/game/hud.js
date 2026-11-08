// DOM HUD: comic-panel health bars with lagging chip damage, super meters, combo counter,
// banners, speech bubbles, destruction stats, title/pause/end screens.
import * as THREE from 'three';
import { G, URLP, WEATHER_KEY } from '../core/context.js';
import { clamp, damp } from '../core/math.js';
import { TOUCH_CONTROLS } from './touch.js';
import { PadMenu } from './padmenu.js';
import { WEATHERS } from '../render/weather.js';

const _v = new THREE.Vector3();

const CONTROLS = [
  ['W A S D', 'Walk (toward / around him) · straight through buildings'],
  ['SHIFT', 'Tap: sidestep · Hold: RUN (LMB while running: tackle)'],
  ['SPACE', 'Leap · then LMB / RMB to slam down on him · tap when knocked down to get up'],
  ['LMB / J', 'Combo x4 (robot: jab, cross, hook, hammer · monster: claw, claw, bite, tail whip)'],
  ['RMB / K', 'Heavy · hold to CHARGE · after a combo hit: uppercut'],
  ['C', 'STOMP: a quake that knocks him off his feet (jump it!)'],
  ['G / B', 'BEAM: KAISER BEAM / ATOMIC BREATH · A / D sweep it (gauge refills)'],
  ['E / L / MMB', 'Grab → shove him through buildings → throw'],
  ['Q / F', 'Block (tap right before a hit to PARRY)'],
  ['R / U', 'SUPER (full meter): SABER FINAL STRIKE / NUCLEAR NOVA'],
  ['ESC', 'Pause · M mute · H controls'],
];
// the same, on a pad: b(i) is what the connected pad prints on standard button i
const padControls = (b) => [
  ['L-STICK', 'Walk (toward / around him) · straight through buildings'],
  [b(7), `Tap: sidestep · Hold: RUN (${b(2)} while running: tackle)`],
  [b(0), `Leap · then ${b(2)} / ${b(3)} to slam down on him · get up faster`],
  [b(2), 'Combo x4'],
  [b(3), 'Heavy · hold to CHARGE · after a combo hit: uppercut'],
  [b(6), 'STOMP: a quake that knocks him off his feet'],
  [`${b(12)} / ${b(11)}`, 'BEAM · the stick sweeps it'],
  [b(1), 'Grab → shove him through buildings → throw'],
  [b(4), 'Block (tap right before a hit to PARRY)'],
  [b(5), 'SUPER (full meter)'],
  [b(9), `Pause · ${b(8)} controls · menus: D-pad + ${b(0)}`],
];

export class HUD {
  constructor() {
    const root = this.root = document.getElementById('ui');
    root.innerHTML = `
      <div id="hud" class="hidden">
        <div class="bar p1"><div class="name"></div><div class="hp"><div class="chip"></div><div class="fill"></div></div><div class="meter"><div class="mfill"></div><span>SUPER</span></div><div class="pips"></div><div class="beam"><div class="bfill"></div><span>BEAM</span></div><div class="ftext"></div></div>
        <div id="timer">99</div>
        <div class="bar p2"><div class="name"></div><div class="hp"><div class="chip"></div><div class="fill"></div></div><div class="meter"><div class="mfill"></div><span>SUPER</span></div><div class="pips"></div><div class="beam"><div class="bfill"></div><span>BEAM</span></div><div class="ftext"></div></div>
        <div id="combo"><div class="n"></div><div class="l">HITS</div><div class="tag"></div></div>
        <div id="cityStats"></div>
        <div id="hint"></div>
        <div id="toast"></div>
      </div>
      <div id="banner"></div>
      <div id="speech"></div>
      <div id="locCard" class="hidden"><div class="lc-title"></div><div class="lc-sub"></div></div>
      <div id="skipHint" class="hidden"></div>
      <div id="recap" class="hidden"><div class="rc-tag"><i></i><span>REPLAY</span></div><div class="rc-card"><div class="rc-title"></div><div class="rc-sub"></div></div></div>
      <div id="controls" class="hidden"></div>
      <div id="title" class="hidden">
        <div class="t-wrap">
          <div class="t-logo">MEGATON</div>
          <div class="t-sub">A KAIJU DESTRUCTION FIGHTER · TECH DEMO</div>
          <div class="t-vs"><button class="pick kaiser" data-k="kaiser">KAISER-OH<small>giant robot</small></button><b>VS</b><button class="pick gorrax" data-k="gorrax">GORRAX<small>atomic lizard</small></button></div>
          <div class="t-pickhint">click a kaiju to play as it</div>
          <div class="t-diff">
            <button data-d="training">TRAINING<small>dummy · free destruction</small></button>
            <button data-d="sparring">SPARRING<small>recommended</small></button>
            <button data-d="brutal">BRUTAL<small>hard</small></button>
            <button data-d="king">KAIJU KING<small>good luck</small></button>
          </div>
          <div class="t-opts">
            <label><input type="checkbox" id="optGore" checked> Blood</label>
            <label><input type="checkbox" id="optShake" checked> Screen shake</label>
            <label>Quality <select id="optQuality"><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select></label>
            <label>City <select id="optMap"><option value="flatiron">Real NYC: Madison Sq</option><option value="grid">Procedural downtown</option></select></label>
            <label>Weather <select id="optWeather"><option value="random">Random</option>${Object.entries(WEATHERS).filter(([, w]) => !w.hidden).map(([k, w]) => `<option value="${k}">${w.label}</option>`).join('')}</select></label>
          </div>
          <button id="fightBtn" class="t-go">FIGHT!</button>
          <div class="t-more">
            <button id="tutBtn">TUTORIAL<small>every move, one at a time</small></button>
            <button id="ctrlBtn">CONTROLS<small>keys · pad · touch</small></button>
          </div>
          <div class="t-credit">Music: Woffels, Metal OST (CC BY) · Sound: Independent.nu, uisfx, ElevenLabs</div>
        </div>
      </div>
      <div id="titleCtrl" class="hidden"><div class="p-box">
        <div class="p-title">CONTROLS</div>
        <div class="t-ctrl"></div>
        <button id="ctrlBack">BACK</button>
      </div></div>
      <div id="tut" class="hidden">
        <div class="tt-head"><span class="tt-step"></span><button class="tt-skip">SKIP ›</button></div>
        <div class="tt-title"></div>
        <div class="tt-text"></div>
        <div class="tt-prog"></div>
        <div class="tt-stamp"></div>
      </div>
      <div id="tutEnd" class="hidden"><div class="p-box">
        <div class="p-title">YOU'RE READY</div>
        <div class="te-sub">Every move is unlocked. Time to try them on someone who hits back.</div>
        <div class="r-btns"><button id="teFight">FIGHT FOR REAL<small>sparring · ENTER</small></button><button id="tePractice">KEEP PRACTISING<small>the dummy stays</small></button><button id="teMenu">MAIN MENU</button></div>
      </div></div>
      <div id="results" class="hidden"><div class="p-box r-box">
        <div class="r-title"></div>
        <div class="r-score"></div>
        <div class="r-stats"></div>
        <div class="r-btns"><button id="rRecap" class="hidden">WATCH RECAP<small>the best moments · R</small></button><button id="rRematch">REMATCH<small>same wrecked city · ENTER</small></button><button id="rNewCity">NEW CITY<small>fresh skyline · N</small></button><button id="rExplore">RAMPAGE<small>stomp the wreckage · X</small></button><button id="rMenu">MAIN MENU<small>pick a difficulty</small></button></div>
      </div></div>
      <div id="pause" class="hidden"><div class="p-box"><div class="p-title">PAUSED</div><button id="resumeBtn">RESUME</button><button id="skipBtn" class="hidden">SKIP STEP</button><button id="restartBtn">REMATCH</button><button id="newCityBtn">NEW CITY</button><button id="musicBtn">MUSIC: ON</button><button id="menuBtn">MAIN MENU</button><div class="p-ctrl"></div></div></div>
      <div id="soundHint" class="hidden">SOUND IS OFF · <b>CLICK</b> OR PRESS A <b>KEY</b> ONCE<small>browsers won't let a controller turn it on</small></div>
    `;
    this._legend();
    this.padMenu = new PadMenu(root);
    // pads come and go mid-session: the legends follow, and a fight says so
    G.input.onPadChange = (p) => { this._legend(); this.toast(p ? 'CONTROLLER CONNECTED' : 'CONTROLLER DISCONNECTED'); };
    this.el = {
      hud: root.querySelector('#hud'),
      p1: root.querySelector('.bar.p1'), p2: root.querySelector('.bar.p2'),
      timer: root.querySelector('#timer'), combo: root.querySelector('#combo'),
      banner: root.querySelector('#banner'), speech: root.querySelector('#speech'),
      stats: root.querySelector('#cityStats'), hint: root.querySelector('#hint'), toast: root.querySelector('#toast'),
      results: root.querySelector('#results'),
      title: root.querySelector('#title'), pause: root.querySelector('#pause'), controls: root.querySelector('#controls'),
      titleCtrl: root.querySelector('#titleCtrl'),
    };
    this.chip = [100, 100];
    this.shakeT = [0, 0];
    this.comboT = 0;
    this.speechT = 0;
    this.speaker = null;
    this.bannerT = 0;
    this.toastT = 0;
    this.difficulty = G.settings.difficulty;
    root.querySelector(`.t-diff button[data-d="${this.difficulty}"]`)?.classList.add('sel');
    root.querySelectorAll('.t-diff button, .t-go, .t-more button, .p-box button, .t-vs .pick').forEach((b) => b.addEventListener('pointerenter', () => G.audio && G.audio.sting('hover')));
    // who you play: the bot takes the other one (the game swaps them on the spot)
    const picks = root.querySelectorAll('.t-vs .pick');
    const markPick = () => picks.forEach((x) => x.classList.toggle('sel', x.dataset.k === G.settings.playAs));
    picks.forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.k === G.settings.playAs) return;
      try { localStorage.setItem('megaton-kaiju', b.dataset.k); } catch (e) { /* storage blocked */ }
      G.audio && G.audio.sting('ui');
      G.game && G.game.setPlayAs(b.dataset.k);
      markPick();
    }));
    this.markPick = markPick;
    root.querySelector('#ctrlBtn').addEventListener('click', () => this.titleControls(true));
    root.querySelector('#ctrlBack').addEventListener('click', () => this.titleControls(false));
    root.querySelectorAll('.t-diff button').forEach((b) => b.addEventListener('click', () => {
      root.querySelectorAll('.t-diff button').forEach((x) => x.classList.remove('sel'));
      b.classList.add('sel');
      this.difficulty = b.dataset.d;
      G.audio && G.audio.sting('ui');
    }));
    const q = root.querySelector('#optQuality');
    q.value = G.settings.quality;
    q.addEventListener('change', () => {
      try { localStorage.setItem('megaton-quality', q.value); } catch (e) { /* storage blocked */ }
      const u = new URL(location.href);
      if (u.searchParams.has('quality')) { u.searchParams.set('quality', q.value); location.href = u.toString(); } else location.reload();
    });
    const mp = root.querySelector('#optMap');
    mp.value = URLP.map;
    mp.addEventListener('change', () => {
      try { localStorage.setItem('megaton-map', mp.value); } catch (e) { /* storage blocked */ }
      const u = new URL(location.href);
      if (u.searchParams.has('map')) { u.searchParams.set('map', mp.value); location.href = u.toString(); } else location.reload();
    });
    // the weather changes on the spot (it eases over), no reload
    const wt = root.querySelector('#optWeather');
    wt.value = WEATHERS[URLP.weather] ? URLP.weather : 'random';
    wt.addEventListener('change', () => {
      try { localStorage.setItem(WEATHER_KEY, wt.value); } catch (e) { /* storage blocked */ }
      G.weather.pref = wt.value;
      G.weather.set(G.weather.choose(), 1.5);
    });
    root.querySelector('#optGore').addEventListener('change', (e) => { G.settings.gore = e.target.checked; });
    root.querySelector('#optShake').addEventListener('change', (e) => { G.settings.shake = e.target.checked ? 1 : 0.15; });
  }

  setFighters(p, b) {
    this.f = [p, b];
    this.el.p1.querySelector('.name').textContent = p.name;
    this.el.p2.querySelector('.name').textContent = b.name;
    this.el.hud.classList.remove('hidden');
  }

  setRounds(w1, w2) {
    const pip = (n) => [0, 1].map((i) => `<i class="${i < n ? 'on' : ''}"></i>`).join('');
    this.el.p1.querySelector('.pips').innerHTML = pip(w1);
    this.el.p2.querySelector('.pips').innerHTML = pip(w2);
  }

  showHUD(v) { this.el.hud.classList.toggle('hidden', !v); }

  // Round intro (game/intro.js): a film-style location card, and how to skip the shot.
  location(title, sub) {
    const c = this.root.querySelector('#locCard');
    c.classList.toggle('hidden', !title);
    if (!title) return;
    c.querySelector('.lc-title').textContent = title;
    c.querySelector('.lc-sub').textContent = sub || '';
    c.classList.remove('show'); void c.offsetWidth; c.classList.add('show');
  }
  skipHint(on) {
    const h = this.root.querySelector('#skipHint');
    h.textContent = G.input.usingPad ? 'PRESS ANY BUTTON TO SKIP' : G.touch ? 'TAP TO SKIP' : 'PRESS ANY KEY TO SKIP';
    h.classList.toggle('hidden', !on);
  }

  // Match recap (game/recap.js): broadcast-style REPLAY tag and a caption for each moment.
  recap(on) {
    this.root.querySelector('#recap').classList.toggle('hidden', !on);
    if (!on) this.root.querySelector('#recap .rc-card').classList.remove('show');
  }
  recapCard(title, sub, big = false) {
    const c = this.root.querySelector('#recap .rc-card');
    c.querySelector('.rc-title').textContent = title;
    c.querySelector('.rc-sub').textContent = sub || '';
    c.classList.toggle('big', big);
    c.classList.remove('show'); void c.offsetWidth; c.classList.add('show');
  }
  recapTag(text) { this.root.querySelector('#recap .rc-tag span').textContent = text; }

  onDamage(f, d) {
    const i = this.f ? this.f.indexOf(f) : -1;
    if (i < 0) return;
    this.shakeT[i] = Math.min(0.5, this.shakeT[i] + 0.05 + d * 0.03);
  }

  onCombo(att, n) {
    if (att !== G.player || n < 2) return;
    const c = this.el.combo;
    c.querySelector('.n').textContent = n;
    const tags = ['', '', 'NICE', 'GOOD', 'GREAT!', 'BRUTAL!', 'SAVAGE!!', 'UNSTOPPABLE!!!'];
    c.querySelector('.tag').textContent = tags[Math.min(n, tags.length - 1)];
    c.classList.remove('pop'); void c.offsetWidth; c.classList.add('pop', 'show');
    this.comboT = 1.6;
    if (n === 5 || n === 8 || n === 12) G.audio && G.audio.sting('streak');
  }

  flashText(f, text) {
    const i = this.f ? this.f.indexOf(f) : -1;
    if (i < 0) return;
    const el = (i === 0 ? this.el.p1 : this.el.p2).querySelector('.ftext');
    el.textContent = text;
    el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');
  }

  banner(text, cls = '', dur = 1.4) {
    const b = this.el.banner;
    b.className = '';
    b.innerHTML = `<span>${text}</span>`;
    void b.offsetWidth;
    b.className = 'show ' + cls;
    this.bannerT = dur;
  }

  toast(text) {
    const t = this.el.toast;
    t.textContent = text;
    t.classList.remove('show'); void t.offsetWidth; t.classList.add('show');
    this.toastT = 2.2;
  }

  speech(f, text) {
    this.speaker = f;
    this.el.speech.textContent = text;
    this.el.speech.classList.add('show');
    this.speechT = 2.6;
  }

  hint(text) { this.el.hint.innerHTML = text || ''; }

  // Touch devices: CSS moves HUD bits off the thumbs.
  setTouch(on) {
    document.body.classList.toggle('touch', on);
    this._legend();
  }

  // The controls panels name a connected pad's buttons, else the on-screen touch ones, else keys.
  _legend() {
    const rows = G.input.pad ? padControls((i) => G.input.btn(i)) : G.touch ? TOUCH_CONTROLS : CONTROLS;
    const html = rows.map(([k, d]) => `<div class="row"><kbd>${k}</kbd><span>${d}</span></div>`).join('');
    for (const s of ['.t-ctrl', '.p-ctrl', '#controls']) this.root.querySelector(s).innerHTML = html;
  }

  // H: on the title it opens the controls panel, in a fight the overlay in the corner
  toggleControls() {
    if (!this.el.title.classList.contains('hidden')) return this.titleControls(this.el.titleCtrl.classList.contains('hidden'));
    this.el.controls.classList.toggle('hidden');
  }

  // the title's controls list, folded away behind its CONTROLS button
  titleControls(on) {
    this.el.titleCtrl.classList.toggle('hidden', !on);
    G.audio && G.audio.sting('ui');
  }

  showTitle(onFight, onTutorial) {
    this.el.title.classList.remove('hidden');
    this.markPick();
    this.showHUD(false);
    const leave = () => { this.el.title.classList.add('hidden'); this.el.titleCtrl.classList.add('hidden'); };
    const go = () => { leave(); onFight(this.difficulty); };
    this.el.title.querySelector('#fightBtn').onclick = go;
    this.el.title.querySelector('#tutBtn').onclick = () => { G.audio && G.audio.sting('ui'); leave(); onTutorial(); };
    this._titleKey = (e) => {
      if (this.el.title.classList.contains('hidden')) return;
      const open = !this.el.titleCtrl.classList.contains('hidden');
      if (open && (e.code === 'Escape' || e.code === 'Enter')) this.titleControls(false); // Enter closes it rather than fights
      else if (e.code === 'Enter') go();
    };
    window.addEventListener('keydown', this._titleKey);
  }

  // end-of-match panel: winner, score, the damage bill, and what to do next
  showResults({ winner, score }, handlers) {
    const r = this.el.results;
    const rb = r.querySelector('#rRecap');
    rb.classList.toggle('hidden', !handlers.recap);
    rb.onclick = handlers.recap ? () => { G.audio && G.audio.sting('ui'); handlers.recap(); } : null;
    r.querySelector('.r-title').textContent = winner;
    r.querySelector('.r-score').textContent = score;
    r.querySelector('.r-stats').innerHTML = this.el.stats.innerHTML;
    const click = (fn) => () => { G.audio && G.audio.sting('ui'); fn(); };
    r.querySelector('#rRematch').onclick = click(handlers.rematch);
    r.querySelector('#rNewCity').onclick = click(handlers.newCity);
    r.querySelector('#rExplore').onclick = click(handlers.explore);
    r.querySelector('#rMenu').onclick = click(handlers.menu);
    // on a phone the docked card has no buttons: a tap on it brings the big panel back
    r.querySelector('.r-box').onclick = () => { if (r.classList.contains('docked') && document.body.classList.contains('touch')) click(handlers.back)(); };
    // the panel carries the winner, so the big banner makes way for it
    this.el.banner.className = ''; this.bannerT = 0;
    r.classList.remove('docked');
    r.classList.remove('hidden');
  }

  hideResults() { this.el.results.classList.add('hidden'); }

  // the results shrunk into a corner while he tours the wreckage (and shown, if they were hidden)
  dockResults(on) {
    this.el.results.classList.toggle('docked', on);
    if (on) this.el.results.classList.remove('hidden');
  }

  // the tutorial (game/tutorial.js): no clock or round pips, and its card in place of the damage bill on touch
  setTutorial(on) { this.el.hud.classList.toggle('tutorial', on); }

  // free roam: the HUD without the fight (no bars, timer or combo), keeping the damage bill
  setExplore(on) {
    this.el.hud.classList.toggle('explore', on);
    this.showHUD(on);
  }

  showPause(v, handlers) {
    this.el.pause.classList.toggle('hidden', !v);
    if (handlers) {
      const sk = this.el.pause.querySelector('#skipBtn');
      sk.classList.toggle('hidden', !handlers.skip);
      sk.onclick = handlers.skip;
      this.el.pause.querySelector('#restartBtn').classList.toggle('hidden', !!handlers.tutorial);
      this.el.pause.querySelector('#newCityBtn').classList.toggle('hidden', !!handlers.tutorial);
      this.el.pause.querySelector('#resumeBtn').onclick = handlers.resume;
      this.el.pause.querySelector('#restartBtn').onclick = handlers.restart;
      this.el.pause.querySelector('#newCityBtn').onclick = handlers.newCity;
      this.el.pause.querySelector('#menuBtn').onclick = handlers.menu;
      const mb = this.el.pause.querySelector('#musicBtn');
      const label = () => { mb.textContent = G.audio.musicOn ? 'MUSIC: ON' : 'MUSIC: OFF'; };
      label();
      mb.onclick = () => { G.audio.setMusicOn(!G.audio.musicOn); label(); };
    }
  }

  update(realDt) {
    this.padMenu.update();
    // browsers start sound on a click, tap or key press but never on a pad button: say so
    const off = G.input.usingPad && !!G.audio && !!G.audio.ctx && !G.audio.live;
    if (off !== this.soundOff) this.root.querySelector('#soundHint').classList.toggle('hidden', !(this.soundOff = off));
    if (!this.f) return;
    const [p, b] = this.f;
    [p, b].forEach((f, i) => {
      const bar = i === 0 ? this.el.p1 : this.el.p2;
      const hp = clamp(f.hp / f.maxHp, 0, 1) * 100;
      if (this.chip[i] < hp) this.chip[i] = hp;
      this.chip[i] = this.shakeT[i] > 0.2 ? this.chip[i] : damp(this.chip[i], hp, 3, realDt);
      bar.querySelector('.fill').style.width = hp + '%';
      bar.querySelector('.chip').style.width = this.chip[i] + '%';
      bar.querySelector('.mfill').style.width = clamp(f.meter, 0, 100) + '%';
      bar.querySelector('.bfill').style.width = clamp(f.beamE * 100, 0, 100) + '%';
      bar.classList.toggle('beamReady', f.beamE >= 1);
      const full = f.meter >= 100;
      if (full && !bar.classList.contains('full') && i === 0) G.audio && G.audio.sting('super');
      bar.classList.toggle('full', full);
      bar.classList.toggle('low', hp < 25);
      this.shakeT[i] = Math.max(0, this.shakeT[i] - realDt);
      const s = this.shakeT[i] * 22;
      bar.style.transform = s > 0.1 ? `translate(${(Math.random() - 0.5) * s}px, ${(Math.random() - 0.5) * s}px)` : '';
    });
    if (this.comboT > 0) { this.comboT -= realDt; if (this.comboT <= 0) this.el.combo.classList.remove('show'); }
    if (this.bannerT > 0) { this.bannerT -= realDt; if (this.bannerT <= 0) this.el.banner.className = ''; }
    if (this.toastT > 0) { this.toastT -= realDt; if (this.toastT <= 0) this.el.toast.classList.remove('show'); }
    if (this.speechT > 0) {
      this.speechT -= realDt;
      const f = this.speaker;
      f.model.headWorld(_v);
      _v.y += 10;
      _v.project(G.camera);
      const sp = this.el.speech;
      if (_v.z < 1 && Math.abs(_v.x) < 1.2 && Math.abs(_v.y) < 1.2) {
        const x = clamp((_v.x * 0.5 + 0.5) * window.innerWidth, 120, window.innerWidth - 120);
        const y = clamp((-_v.y * 0.5 + 0.5) * window.innerHeight, 140, window.innerHeight - 60);
        sp.style.left = x + 'px'; sp.style.top = y + 'px';
        sp.style.opacity = 1;
      } else sp.style.opacity = 0.0;
      if (this.speechT <= 0) sp.classList.remove('show');
    }
    // property damage: ~$120k per chunk, $40M per collapse, plus every wrecked car
    const cars = G.props ? G.props.cars.filter((c) => c.wrecked).length : 0;
    const dollars = G.stats.chunksDestroyed * 0.12 + G.stats.buildingsCollapsed * 40 + cars * 0.045;
    this.dmgShown = damp(this.dmgShown || 0, dollars, 6, realDt);
    const txt = this.dmgShown >= 1000 ? `$${(this.dmgShown / 1000).toFixed(2)}B` : `$${this.dmgShown.toFixed(1)}M`;
    this.el.stats.innerHTML = `PROPERTY DAMAGE <b>${txt}</b> · BUILDINGS DOWN <b>${G.stats.buildingsCollapsed}</b>`;
  }

  setTimer(t) { this.el.timer.textContent = Math.max(0, Math.ceil(t)); }
}
