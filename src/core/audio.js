// Audio: recorded samples (listed in sfx/index.json, see public/sfx/README.md), the punches layered
// with a little procedural sub-bass for weight, and procedural fallbacks for the hits and stingers
// should their samples be missing. Stereo + distance, a gentle glue compressor and a final limiter, rate limiting,
// slow-mo muffling/pitch-down, and a looped soundtrack (public/music) that ducks under big hits.
import * as THREE from 'three';
import { clamp, rand } from './math.js';

const _v = new THREE.Vector3();
// iPhone / iPad (an iPad's Safari says it's a Mac, but one with a touch screen)
const IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// Safari before 18.4 (iPhones before iOS 18.4) can't decode Ogg Vorbis: every .ogg has an AAC
// twin (.mp4, tools/ogg-twins.mjs), fetched instead where Ogg won't play, and tried should an
// Ogg decode fail anyway.
const OGG = !!document.createElement('audio').canPlayType('audio/ogg; codecs="vorbis"');
const pick = (f) => (OGG ? f : f.replace(/\.ogg$/, '.mp4'));
const twin = (f) => (f.endsWith('.ogg') ? f.replace(/\.ogg$/, '.mp4') : f.endsWith('.mp4') ? f.replace(/\.mp4$/, '.ogg') : null);

// A second of silence as a WAV (8-bit mono) at the context's own rate, so playing it doesn't
// make iOS switch the hardware rate under the Web Audio mix. (A much shorter loop stalls.)
function silentWav(rate) {
  const n = Math.round(rate), b = new DataView(new ArrayBuffer(44 + n));
  const tag = (o, s) => { for (let i = 0; i < 4; i++) b.setUint8(o + i, s.charCodeAt(i)); };
  tag(0, 'RIFF'); b.setUint32(4, 36 + n, true); tag(8, 'WAVE'); tag(12, 'fmt ');
  b.setUint32(16, 16, true); b.setUint16(20, 1, true); b.setUint16(22, 1, true);
  b.setUint32(24, rate, true); b.setUint32(28, rate, true); b.setUint16(32, 1, true); b.setUint16(34, 8, true);
  tag(36, 'data'); b.setUint32(40, n, true);
  for (let i = 0; i < n; i++) b.setUint8(44 + i, 128);
  return URL.createObjectURL(new Blob([b], { type: 'audio/wav' }));
}

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.muted = new URLSearchParams(location.search).has('mute'); // ?mute: silent from the first frame (tests)
    this.last = {};
    this.voices = 0;
    this.pitch = 1;
    this.camera = null;
    this.charges = new Map();
    this.beams = new Map();
    this.talking = {};   // fighter -> { src, prio, until }: the voice line they're saying
    this.bank = {};      // group -> [AudioBuffer]
    this.files = [];
    this.tracks = {};    // music name -> Promise<AudioBuffer|null>
    this.raw = {};       // file -> Promise<ArrayBuffer> (downloads start at boot, see prepare)
    this.cur = null;     // playing music { name, src, g }
    this.wantMusic = null;
    this.musicToken = 0;
    this.musicOn = true;
    try { this.musicOn = localStorage.getItem('megaton-music') !== 'off'; } catch (e) { /* storage blocked */ }
  }

  // Mix levels by family, so the balance is tuned in one place.
  static MIX = {
    building: 0.8,   // crumble, glass, creak and collapse from the destructible city
    music: 1.2,      // the whole soundtrack bus
    ambience: 1.0,   // the dark city bed under everything
    voice: 1.0,      // character shouts (their own bus, above the effects)
  };

  // looped soundscape behind the music (ElevenLabs, see public/music/README.md)
  static AMBIENCE = { file: 'music/ambience.mp3', vol: 0.2 };

  // Soundtrack (Woffels' Metal OST, see public/music/README.md). vol levels the tracks against
  // each other and keeps them under the hits.
  static MUSIC = {
    menu: { file: 'music/1-NV1a-intro.ogg', vol: 0.85 },
    fight: { file: 'music/1-NV2b-riff-action-doom.ogg', vol: 0.42 },
    end: { file: 'music/1-NV5c-brutal2-short.ogg', vol: 0.5 },
  };

  // The fighters' voice lines (ElevenLabs, public/sfx/voices/<fighter>/) and how much each
  // matters: a line cuts off what that fighter is saying unless that matters more, so a jab
  // grunt never talks over a K.O. scream; and it plays louder the more it matters (VOICE_VOL).
  static VOICE_VOL = { 1: 0.6, 2: 0.8, 3: 1, 4: 1.1 };
  static VOICE = {
    attack_light: 1, attack_mid: 1, dash: 1, block: 1, skyward: 1,
    attack_heavy: 2, charge: 2, hurt_light: 2, getup: 2,
    charge_release: 3, skydive: 3, grab: 3, super_finish: 3, hurt_heavy: 3, taunt: 3,
    super_start: 4, ko: 4, win: 4,
  };

  // logical groups -> files: a folder ('punches/light/') or a file without its extension
  // ('ui/fight'), whose numbered takes ('ui/fight-2') count too (see public/sfx/README.md for sources)
  static GROUPS = {
    punchLight: ['punches/light/'],   // "37 hits/punches" (CC0), trimmed and levelled
    punchHeavy: ['punches/heavy/'],
    ui_fight: ['ui/fight'], ui_super: ['ui/super_ready'], ui_streak: ['ui/combo_streak'],
    ui_parry: ['ui/parry'], ui_win: ['ui/victory'], ui_round: ['ui/round_drop'], ui_ko: ['ui/ko_downer'],
    ui_select: ['ui/select'], ui_hover: ['ui/hover'],
    charge: ['ui/charge'], police: ['ui/police_radio'],
    // ElevenLabs sound effects (prompts and costs in public/sfx/elevenlabs.json)
    blocked: ['impacts/blocked'], groundSlam: ['impacts/ground_slam'], smashThrough: ['impacts/smash_through'],
    metal: ['impacts/metal'], field: ['impacts/field'],
    creak: ['destruction/creak'], collapse: ['destruction/collapse'],
    crumbleSmall: ['destruction/crumble_small'], crumbleBig: ['destruction/crumble_big'],
    glassSmall: ['destruction/glass_small'], glassBig: ['destruction/glass_big'],
    whoosh: ['movement/whoosh'], swing: ['movement/swing'], grab: ['movement/grab'], skid: ['movement/skid'],
    wind: ['movement/wind'],
    // each fighter's voice lines, vo_<fighter>_<line> (see VOICE)
    ...Object.fromEntries(['heir', 'patriarch'].flatMap((who) => Object.keys(AudioEngine.VOICE).map((line) => [`vo_${who}_${line}`, [`voices/${who}/${line}`]]))),
  };

  // Levels of the ElevenLabs samples, matched by ear-weighted loudness to the synth sounds they
  // replaced; the swing, skid, force field and big glass a little louder than those were. The
  // collapse and metal sit a bit under theirs: more gain there only works the limiter harder.
  static LEVEL = {
    blocked: 1.8, groundSlam: 1.7, smashThrough: 0.95, metal: 2.0, field: 0.7,
    creak: 0.65, collapse: 2.5, crumbleSmall: 4.3, crumbleBig: 1.5, glassSmall: 0.35, glassBig: 0.95,
    whoosh: 0.55, swing: 0.13, grab: 1.2, skid: 0.38, wind: 0.48,
    voice: 1.5,   // every voice line (the files sit around -16 to -22 LUFS), on the voice bus
  };

  async loadSamples() {
    if (!this.ctx || this._loading) return;
    this._loading = true;
    let list = [];
    try { list = await (await fetch('sfx/index.json')).json(); } catch (e) { return; }
    this.files = list;
    const groups = AudioEngine.GROUPS;
    const jobs = [];
    for (const [g, prefixes] of Object.entries(groups)) {
      for (const f of list) {
        const base = f.replace(/^.*?sfx\//, ''), name = base.replace(/(-\d+)?\.\w+$/, '');
        if (!prefixes.some((p) => (p.endsWith('/') ? base.startsWith(p) : name === p))) continue;
        jobs.push(this._decode('sfx/' + base.split('/').map(encodeURIComponent).join('/')).then((buf) => {
          (this.bank[g] = this.bank[g] || []).push(buf);
        }).catch(() => {}));
      }
    }
    await Promise.all(jobs);
    this._startWind();
    console.log('[audio] sample groups:', Object.keys(this.bank).map((k) => `${k}:${this.bank[k].length}`).join(' '));
  }

  has(g) { return !!(this.bank[g] && this.bank[g].length); }

  // Effects only play once the context runs: queued on a suspended one, they'd all fire at
  // once on the first tap. Music may queue (it should start right on that tap).
  get live() { return !!this.ctx && this.ctx.state === 'running'; }

  // Play a random variation of a sample group. Returns the source (its gain node is .out), or
  // false if the group isn't loaded.
  // dur: play only a slice of a long sample (quick fade in, fade out), from `offset` or a random spot.
  // offset: start this many seconds into the sample. pitchless: ignore the slow-mo pitch-down
  // (stingers and voices keep their pitch).
  sample(g, out, { vol = 1, rate = 1, t = 0, jitter = 0.08, dur = 0, offset = null, pitchless = false } = {}) {
    const list = this.bank[g];
    if (!list || !list.length || !this.live) return false;
    const src = this.ctx.createBufferSource();
    src.buffer = list[Math.floor(Math.random() * list.length)];
    src.playbackRate.value = rate * (pitchless ? 1 : this.pitch) * (1 + (Math.random() * 2 - 1) * jitter);
    const gn = this.ctx.createGain();
    const t0 = this.ctx.currentTime + t;
    src.connect(gn); gn.connect(out);
    if (dur > 0) {
      const span = dur * src.playbackRate.value;
      const off = offset ?? Math.random() * Math.max(0, src.buffer.duration - span);
      gn.gain.setValueAtTime(0, t0);
      gn.gain.linearRampToValueAtTime(vol, t0 + Math.min(0.04, dur * 0.2));
      gn.gain.setValueAtTime(vol, t0 + dur * 0.35);
      gn.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
      src.start(t0, off);
      src.stop(t0 + dur + 0.02);
    } else {
      gn.gain.value = vol;
      src.start(t0, offset || 0);
    }
    src.out = gn;
    this._track(src);
    return src;
  }

  // Called from every tap / key: browsers only let audio start inside a user gesture, and iOS
  // only counts the finger lifting (touchend / click), not touching down.
  init() {
    if (!this.ctx) this.prepare();
    if (!this.ctx) return;
    if (IOS) this._ignoreSilentMode();
    if (this.ctx.state === 'running') return;
    this.ctx.resume();
    // older iOS also wants a sound started inside the gesture: one silent sample
    const b = this.ctx.createBuffer(1, 1, this.ctx.sampleRate), src = this.ctx.createBufferSource();
    src.buffer = b; src.connect(this.ctx.destination); src.start(0);
  }

  // iOS plays Web Audio as ambient sound, which Silent mode (the side switch or Action button)
  // mutes: the whole game is silent. A page playing an <audio> element gets the playback
  // category instead, which Silent mode leaves alone, so a looped moment of silence plays under
  // the game while it's on screen. navigator.audioSession.type does the same since iOS 17, but
  // WebKit ignores it in a cross-origin iframe, which is where the artifact runs.
  _ignoreSilentMode() {
    const el = this.hush;
    if (el) { if (el.paused && !document.hidden) el.play().catch(() => {}); return; }
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) { /* not ours to set here */ }
    const hush = this.hush = document.createElement('audio');
    hush.setAttribute('x-webkit-airplay', 'deny');
    hush.loop = true;
    hush.src = silentWav(this.ctx.sampleRate);
    hush.play().catch(() => {}); // refused on a touch down: the lift that follows tries again
    // let go of the playback session in the background, take it back on return (once started
    // by a tap, iOS lets this element play again without one)
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) hush.pause();
      else hush.play().catch(() => {});
    });
  }

  // Build the (still suspended) context at boot and download / decode everything right away,
  // so the menu theme can start on the first tap and the fight riff (~65 MB decoded) has the
  // whole title screen to get ready instead of starting seconds after FIGHT!.
  // ctx: build on a given context instead (sounds.html renders the recipes offline).
  prepare(ctx = null) {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!ctx && !AC) return;
    ctx = this.ctx = ctx || new AC();
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.85;
    // glue compressor: slow enough attack that punch transients get through
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -12; this.comp.knee.value = 8; this.comp.ratio.value = 3;
    this.comp.attack.value = 0.006; this.comp.release.value = 0.18;
    // brickwall-ish limiter on the final mix (sfx + music) so stacked hits never clip
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -2; this.limiter.knee.value = 0; this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.001; this.limiter.release.value = 0.12;
    this.muffle = ctx.createBiquadFilter();
    this.muffle.type = 'lowpass'; this.muffle.frequency.value = 20000; this.muffle.Q.value = 0.5;
    this.bus = ctx.createGain();
    this.sfxDuck = ctx.createGain(); // dips the effects while a voice line plays
    this.bus.connect(this.sfxDuck); this.sfxDuck.connect(this.muffle); this.muffle.connect(this.comp); this.comp.connect(this.master);
    // voices skip the effects compressor and the slow-mo muffle, so a shout is never buried in a barrage
    this.voiceBus = ctx.createGain(); this.voiceBus.gain.value = AudioEngine.MIX.voice;
    this.voiceBus.connect(this.master);
    this.master.connect(this.limiter); this.limiter.connect(ctx.destination);
    // music bus: its own filter (slow-mo / pause), a ducker for big hits, an on/off gain
    this.musicF = ctx.createBiquadFilter();
    this.musicF.type = 'lowpass'; this.musicF.frequency.value = 20000; this.musicF.Q.value = 0.6;
    this.musicDuck = ctx.createGain();
    this.musicOut = ctx.createGain(); this.musicOut.gain.value = this.musicOn ? AudioEngine.MIX.music : 0;
    this.musicF.connect(this.musicDuck); this.musicDuck.connect(this.musicOut); this.musicOut.connect(this.master);
    // noise buffers
    const sr = ctx.sampleRate;
    const mk = (secs, fill) => { const b = ctx.createBuffer(1, sr * secs, sr); fill(b.getChannelData(0)); return b; };
    this.white = mk(2, (d) => { for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; });
    this.brown = mk(3, (d) => { let l = 0; for (let i = 0; i < d.length; i++) { l = (l + 0.02 * (Math.random() * 2 - 1)) / 1.02; d[i] = l * 3.5; } });
    this.curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) { const x = (i / 1023) * 2 - 1; this.curve[i] = Math.tanh(x * 3.2); }
    // wind bed: the looped recording starts once the samples are in (_startWind); update() rides its level
    this.windG = ctx.createGain(); this.windG.gain.value = 0;
    this.windG.connect(this.bus);
    // soundscape: a looped dark city bed (its own filter, so it muffles with the pause menu)
    this.ambF = ctx.createBiquadFilter(); this.ambF.type = 'lowpass'; this.ambF.frequency.value = 20000;
    this.ambG = ctx.createGain(); this.ambG.gain.value = 0;
    this.ambF.connect(this.ambG); this.ambG.connect(this.master);
    this.loadSamples();
    // downloads in parallel, decodes one at a time in the order they're needed; the ambience
    // bed (also ~65 MB decoded) waits until the soundtrack is ready
    const order = ['menu', 'fight', 'end'];
    for (const k of order) this._fetch(pick(AudioEngine.MUSIC[k].file));
    order.reduce((p, k) => p.then(() => this._loadTrack(k)), Promise.resolve()).then(() => this._startAmbience());
    if (this.wantMusic) this.music(this.wantMusic);
  }

  _fetch(file) {
    if (!this.raw[file]) this.raw[file] = fetch(file).then((r) => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); });
    return this.raw[file];
  }

  // Download and decode a file, from its AAC twin where Ogg won't decode (see OGG).
  _decode(file) {
    const f = pick(file), alt = twin(f);
    const dec = (p) => this._fetch(p).then((b) => this.ctx.decodeAudioData(b));
    return alt ? dec(f).catch(() => dec(alt)) : dec(f);
  }

  _startWind() {
    if (this.windSrc || !this.has('wind')) return;
    const src = this.windSrc = this.ctx.createBufferSource();
    src.buffer = this.bank.wind[0]; src.loop = true;
    src.connect(this.windG); src.start();
  }

  _startAmbience() {
    const ctx = this.ctx, def = AudioEngine.AMBIENCE;
    this._decode(def.file)
      .then((buf) => {
        const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
        src.connect(this.ambF); src.start();
        const t = ctx.currentTime;
        this.ambG.gain.setValueAtTime(0, t);
        this.ambG.gain.linearRampToValueAtTime(def.vol * AudioEngine.MIX.ambience, t + 4);
      })
      .catch(() => {
        // no recording: fall back to a faint procedural traffic hum
        const amb = ctx.createBufferSource(); amb.buffer = this.brown; amb.loop = true;
        const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 300;
        const g = ctx.createGain(); g.gain.value = 0.05;
        amb.connect(f); f.connect(g); g.connect(this.bus); amb.start();
      });
  }

  // A voice line (Fighter.shout): one at a time per fighter (`who`). It cuts off what that fighter
  // is saying unless that has a higher `prio` (VOICE), or the same one and only just started (so a
  // quick combo doesn't chop every grunt). duck dips the other effects by that fraction for `hold`
  // seconds so the line reads.
  voice(group, pos, { who = group, prio = 2, vol = 1, offset = 0, duck = 0, hold = 0.6, rate = 1 } = {}) {
    if (!this._ok(group, 0.3)) return false;
    const t = this.ctx.currentTime, cur = this.talking[who];
    const busy = cur && cur.until > t;
    if (busy && (cur.prio > prio || (cur.prio === prio && t - cur.t0 < 0.3))) return false;
    const level = vol * AudioEngine.LEVEL.voice * (AudioEngine.VOICE_VOL[prio] ?? 1);
    const src = this.sample(group, this._dest(pos, level, this.voiceBus), { vol: 1, jitter: 0.03, offset, pitchless: true, rate });
    if (!src) return false;
    if (busy) { cur.src.out.gain.setTargetAtTime(0, t, 0.02); try { cur.src.stop(t + 0.1); } catch (e) { /* already stopping */ } }
    this.talking[who] = { src, prio, t0: t, until: t + (src.buffer.duration - offset) / src.playbackRate.value };
    if (duck > 0) {
      const g = this.sfxDuck.gain;
      g.cancelScheduledValues(t);
      g.setValueAtTime(g.value, t);
      g.linearRampToValueAtTime(1 - duck, t + 0.04);
      g.setTargetAtTime(1, t + hold, 0.15);
    }
    return true;
  }

  // distant police radio chatter somewhere in the city
  police() {
    if (!this.live || this.muted || !this.has('police')) return;
    const ctx = this.ctx;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 350;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3200;
    const g = ctx.createGain(); g.gain.value = 0.8;
    g.connect(hp); hp.connect(lp);
    if (ctx.createStereoPanner) { const p = ctx.createStereoPanner(); p.pan.value = Math.random() < 0.5 ? -0.6 : 0.6; lp.connect(p); p.connect(this.bus); }
    else lp.connect(this.bus);
    this.sample('police', g, { vol: 1, jitter: 0, pitchless: true });
  }

  // ---------------------------------------------------------------- weather (render/weather.js)
  // Rain: a looped hiss over a low roar, level 0..1. Built the first time it's needed.
  rain(level) {
    if (!this.ctx || (!this.rainG && level <= 0)) return;
    if (!this.rainG) {
      const ctx = this.ctx;
      this.rainG = ctx.createGain(); this.rainG.gain.value = 0;
      const hiss = ctx.createBufferSource(); hiss.buffer = this.white; hiss.loop = true;
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2600; bp.Q.value = 0.4;
      const roar = ctx.createBufferSource(); roar.buffer = this.brown; roar.loop = true;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 500;
      const rg = ctx.createGain(); rg.gain.value = 1.6;
      hiss.connect(bp); bp.connect(this.rainG);
      roar.connect(lp); lp.connect(rg); rg.connect(this.rainG);
      this.rainG.connect(this.bus);
      hiss.start(); roar.start();
      this.rainLevel = -1;
    }
    if (Math.abs(level - this.rainLevel) < 0.01) return;
    this.rainLevel = level;
    this.rainG.gain.setTargetAtTime(level * 0.16, this.ctx.currentTime, 0.8);
  }

  // Thunder for a strike `dist` metres away: arrives at the speed of sound, a crack up close,
  // then a long low roll.
  thunder(dist) {
    if (!this.live || this.muted) return;
    const o = this.bus, near = clamp(1 - dist / 1200, 0.15, 1), t = Math.min(3, dist / 343);
    this.noise(o, { t, type: 'lowpass', f: 250 + 700 * near, f1: 60, dur: 3.5 + (1 - near) * 2, vol: 0.25 + 0.8 * near, buf: 'brown', attack: 0.03 + (1 - near) * 0.25 });
    if (near > 0.5) this.noise(o, { t, type: 'highpass', f: 1500, dur: 0.2, vol: 0.5 * near });
    this.noise(o, { t: t + 0.5, type: 'lowpass', f: 300, f1: 40, dur: 4, vol: 0.2 + 0.5 * near, buf: 'brown', attack: 0.4 });
  }

  // ---------------------------------------------------------------- music
  _loadTrack(name) {
    const def = AudioEngine.MUSIC[name];
    if (!def || !this.ctx) return Promise.resolve(null);
    if (!this.tracks[name]) this.tracks[name] = this._decode(def.file).catch(() => null);
    return this.tracks[name];
  }

  // Switch the soundtrack (null = silence). Safe to call before the context exists: the request
  // is remembered and starts on the first user gesture.
  music(name, { fadeOut = 1.2, fadeIn = 0.4 } = {}) {
    this.wantMusic = name;
    if (!this.ctx || !this.musicF) return;
    if (this.cur && this.cur.name === name) return;
    const t = this.ctx.currentTime;
    if (this.cur) {
      const c = this.cur;
      c.g.gain.cancelScheduledValues(t);
      c.g.gain.setValueAtTime(c.g.gain.value, t);
      c.g.gain.linearRampToValueAtTime(0, t + fadeOut);
      c.src.stop(t + fadeOut + 0.05);
      this.cur = null;
    }
    const token = ++this.musicToken;
    if (!name) return;
    this._loadTrack(name).then((buf) => {
      if (!buf || token !== this.musicToken) return;
      const now = this.ctx.currentTime;
      const src = this.ctx.createBufferSource();
      src.buffer = buf; src.loop = true;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(AudioEngine.MUSIC[name].vol, now + Math.max(0.01, fadeIn));
      src.connect(g); g.connect(this.musicF);
      src.start(now);
      this.cur = { name, src, g };
    });
  }

  // fade the current track out without picking a new one (e.g. the last KO before the results)
  musicFade(seconds = 2) { this.music(null, { fadeOut: seconds }); }

  setMusicOn(on) {
    this.musicOn = on;
    try { localStorage.setItem('megaton-music', on ? 'on' : 'off'); } catch (e) { /* storage blocked */ }
    if (this.musicOut) this.musicOut.gain.setTargetAtTime(on ? AudioEngine.MIX.music : 0, this.ctx.currentTime, 0.08);
  }

  // dip the music under a big impact so the hit reads, then let it swell back
  duck(depth = 0.5, release = 0.6) {
    if (!this.musicDuck) return;
    const g = this.musicDuck.gain, t = this.ctx.currentTime;
    g.cancelScheduledValues(t);
    g.setValueAtTime(Math.min(g.value, 1 - depth), t);
    g.setTargetAtTime(1, t + 0.08, release / 3);
  }

  toggleMute() { this.muted = !this.muted; if (this.master) this.master.gain.value = this.muted ? 0 : 0.85; return this.muted; }

  _ok(key, gap) {
    if (!this.live || this.muted) return false;
    const t = this.ctx.currentTime;
    if (this.last[key] && t - this.last[key] < gap) return false;
    if (this.voices > 60) return false;
    this.last[key] = t;
    return true;
  }

  _spatial(pos) {
    let pan = 0, gain = 1;
    if (pos && this.camera) {
      _v.copy(pos).sub(this.camera.position);
      const d = _v.length();
      gain = 1 / (1 + d / 170); // kaiju scale: the camera sits ~100 m back
      _v.normalize();
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
      pan = clamp(_v.dot(right) * 0.8, -0.9, 0.9);
    }
    return { pan, gain };
  }

  _dest(pos, vol, target = this.bus) {
    const ctx = this.ctx;
    const { pan, gain } = this._spatial(pos);
    const g = ctx.createGain(); g.gain.value = vol * gain;
    let node = g;
    if (ctx.createStereoPanner) { const p = ctx.createStereoPanner(); p.pan.value = pan; g.connect(p); p.connect(target); }
    else g.connect(target);
    return node;
  }

  _track(src, dur) {
    this.voices++;
    src.onended = () => { this.voices--; };
  }

  noise(out, { t = 0, dur = 0.1, type = 'bandpass', f = 1000, f1 = null, q = 1, vol = 1, attack = 0.002, buf = 'white', dist = false }) {
    const ctx = this.ctx;
    const t0 = ctx.currentTime + t;
    const src = ctx.createBufferSource();
    src.buffer = buf === 'brown' ? this.brown : this.white;
    src.playbackRate.value = rand(0.9, 1.1);
    const flt = ctx.createBiquadFilter();
    flt.type = type; flt.Q.value = q;
    flt.frequency.setValueAtTime(f * this.pitch, t0);
    if (f1) flt.frequency.exponentialRampToValueAtTime(Math.max(20, f1 * this.pitch), t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(flt);
    let last = flt;
    if (dist) { const ws = ctx.createWaveShaper(); ws.curve = this.curve; flt.connect(ws); last = ws; }
    last.connect(g); g.connect(out);
    const long = dur > 0.4;
    src.loop = long;
    src.start(t0, long ? Math.random() * 0.5 : Math.random() * (src.buffer.duration - dur - 0.06));
    src.stop(t0 + dur + 0.05);
    this._track(src);
  }

  tone(out, { t = 0, dur = 0.2, type = 'sine', f = 100, f1 = null, vol = 1, attack = 0.002, dist = false }) {
    const ctx = this.ctx;
    const t0 = ctx.currentTime + t;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f * this.pitch, t0);
    if (f1) o.frequency.exponentialRampToValueAtTime(Math.max(10, f1 * this.pitch), t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    let last = o;
    if (dist) { const ws = ctx.createWaveShaper(); ws.curve = this.curve; o.connect(ws); last = ws; }
    last.connect(g); g.connect(out);
    o.start(t0); o.stop(t0 + dur + 0.05);
    this._track(o);
  }

  // ---------------------------------------------------------------- recipes
  hit(kind, pos, blocked) {
    if (!this._ok('hit', 0.025)) return;
    // super barrage: ten punches a second, played softer so they don't turn into a wall of sound
    const barrage = kind === 'barrage';
    if (barrage) kind = 'mid';
    const o = this._dest(pos, barrage ? 0.55 : 1);
    if (this.has('punchHeavy') && !blocked && kind !== 'block' && kind !== 'parry') {
      // recorded punches at (almost) natural pitch; a clean sub layer adds superhuman weight
      if (kind === 'light') this.sample('punchLight', o, { vol: 0.85, rate: rand(0.98, 1.08) });
      else if (kind === 'mid') {
        this.sample('punchHeavy', o, { vol: 0.9, rate: rand(1.0, 1.08) });
        this.tone(o, { f: 120, f1: 45, dur: 0.14, vol: 0.3 });
      } else if (kind === 'heavy') {
        this.sample('punchHeavy', o, { vol: 1.0, rate: rand(0.93, 1.0) });
        this.sample('punchLight', o, { vol: 0.35, rate: 1.12 });             // extra snap on top
        this.tone(o, { f: 95, f1: 34, dur: 0.3, vol: 0.55 });
        this.duck(0.35, 0.5);
      } else {
        this.sample('punchHeavy', o, { vol: 1.1, rate: rand(0.86, 0.92) });
        this.sample('punchLight', o, { vol: 0.4, rate: 1.05 });
        this.sample('explosion', o, { vol: 0.5, rate: 0.95, t: 0.02 }) || this.noise(o, { type: 'lowpass', f: 400, f1: 80, dur: 1.4, vol: 0.7, buf: 'brown', attack: 0.01 });
        this.sample('boom', o, { vol: 0.55, t: 0.02 });
        this.tone(o, { f: 80, f1: 26, dur: 0.6, vol: 0.75 });
        this.duck(0.6, 1.0);
      }
      return;
    }
    // a parry arrives as a blocked hit, so it's checked first
    if (kind === 'parry') {
      if (this.sample('ui_parry', o, { vol: 1, jitter: 0, pitchless: true })) return;
      this.tone(o, { f: 1800, f1: 1750, dur: 0.6, vol: 0.3 });
      this.tone(o, { f: 2710, f1: 2650, dur: 0.45, vol: 0.15 });
      this.noise(o, { f: 600, f1: 3000, dur: 0.25, vol: 0.4 });
      this.tone(o, { f: 120, f1: 40, dur: 0.3, vol: 0.7, dist: true });
      return;
    }
    if (blocked || kind === 'block') {
      this.sample('blocked', o, { vol: AudioEngine.LEVEL.blocked });
      return;
    }
    if (kind === 'light') {
      this.tone(o, { f: 190, f1: 60, dur: 0.1, vol: 0.9 });
      this.noise(o, { f: 1900, q: 1.2, dur: 0.06, vol: 0.8 });
      this.noise(o, { type: 'highpass', f: 5000, dur: 0.02, vol: 0.4 });
    } else if (kind === 'mid') {
      this.tone(o, { f: 160, f1: 45, dur: 0.16, vol: 1, dist: true });
      this.noise(o, { f: 1300, q: 1, dur: 0.09, vol: 0.9 });
      this.noise(o, { type: 'highpass', f: 4000, dur: 0.03, vol: 0.4 });
    } else if (kind === 'heavy') {
      this.tone(o, { f: 130, f1: 32, dur: 0.38, vol: 1.2, dist: true });
      this.tone(o, { f: 55, f1: 30, dur: 0.5, vol: 0.8 });
      this.noise(o, { f: 850, q: 0.7, dur: 0.22, vol: 1, dist: true });
      this.noise(o, { type: 'highpass', f: 2500, dur: 0.05, vol: 0.6 });
    } else {
      // huge: layered boom + crack + air
      this.tone(o, { f: 110, f1: 24, dur: 0.75, vol: 1.4, dist: true });
      this.tone(o, { f: 48, f1: 22, dur: 1.1, vol: 1 });
      this.noise(o, { f: 700, q: 0.6, dur: 0.35, vol: 1.2, dist: true });
      this.noise(o, { type: 'highpass', f: 2000, dur: 0.08, vol: 0.9 });
      this.noise(o, { type: 'lowpass', f: 400, f1: 80, dur: 1.6, vol: 0.9, buf: 'brown', attack: 0.01 });
      this.noise(o, { f: 300, f1: 2500, dur: 0.3, vol: 0.3, t: 0.02 });
    }
  }

  swing(strength, pos) {
    if (!this._ok('swing', 0.05)) return;
    const o = this._dest(pos, 0.5 + strength * 0.4);
    this.sample('swing', o, { vol: AudioEngine.LEVEL.swing, rate: rand(0.95, 1.1) });
  }

  whoosh(amount, pos) {
    if (!this._ok('whoosh', 0.08)) return;
    const o = this._dest(pos, 0.8);
    this.sample('whoosh', o, { vol: AudioEngine.LEVEL.whoosh * (0.5 + amount * 0.5) });
  }

  grab(pos) {
    if (!this._ok('grab', 0.1)) return;
    this.sample('grab', this._dest(pos, 1), { vol: AudioEngine.LEVEL.grab });
  }

  // amount 0..1: up to 0.6 the small crumble (louder as it grows), above that the big one
  crumble(amount, pos) {
    if (!this._ok('crumble', 0.06)) return;
    const o = this._dest(pos, 0.9 * AudioEngine.MIX.building), L = AudioEngine.LEVEL;
    if (amount > 0.6) this.sample('crumbleBig', o, { vol: L.crumbleBig * (0.4 + amount * 0.6), rate: rand(0.9, 1.05) });
    else this.sample('crumbleSmall', o, { vol: L.crumbleSmall * (0.7 + amount), rate: rand(0.9, 1.1) });
  }

  glass(amount, pos) {
    if (!this._ok('glass', 0.07)) return;
    const o = this._dest(pos, 0.7 * AudioEngine.MIX.building), L = AudioEngine.LEVEL;
    if (amount > 0.6) this.sample('glassBig', o, { vol: L.glassBig * (0.4 + amount * 0.6), rate: rand(0.95, 1.05) });
    else this.sample('glassSmall', o, { vol: L.glassSmall * (0.7 + amount), rate: rand(0.95, 1.15) });
  }

  smashThrough(s, pos) {
    if (!this._ok('smash', 0.1)) return;
    this.sample('smashThrough', this._dest(pos, 1), { vol: AudioEngine.LEVEL.smashThrough * (0.6 + s * 0.5) });
  }

  // s: impact strength, 0.1 (a hop) to 1.6 (a full-speed launch into the street)
  groundSlam(s, pos) {
    if (!this._ok('slam', 0.12)) return;
    const o = this._dest(pos, 1.2);
    this.duck(0.45, 0.8);
    this.sample('groundSlam', o, { vol: AudioEngine.LEVEL.groundSlam * Math.min(1.3, 0.5 + s * 0.5), rate: rand(0.95, 1.05) });
  }

  // a launched fighter bouncing off the arena's force field
  field(pos) {
    if (!this._ok('field', 0.15)) return;
    this.sample('field', this._dest(pos, 0.9), { vol: AudioEngine.LEVEL.field, rate: rand(0.95, 1.05) });
  }

  metal(pos, vol = 1) {
    if (!this._ok('metal', 0.08)) return;
    this.sample('metal', this._dest(pos, vol), { vol: AudioEngine.LEVEL.metal });
  }

  // called every frame or so while a launched fighter ploughs along the ground: the 1.5 s
  // recording restarts at most every 1.2 s
  skid(speed, pos) {
    if (!this._ok('skid', 1.2)) return;
    this.sample('skid', this._dest(pos, 0.6), { vol: AudioEngine.LEVEL.skid * clamp(speed / 130, 0.3, 1.2) });
  }

  creak(pos) {
    if (!this._ok('creak', 0.3)) return;
    this.sample('creak', this._dest(pos, 1.3 * AudioEngine.MIX.building), { vol: AudioEngine.LEVEL.creak });
  }

  collapse(pos) {
    if (!this._ok('collapse', 0.4)) return;
    const o = this._dest(pos, 1.6 * AudioEngine.MIX.building);
    this.duck(0.55, 2.5);
    this.sample('collapse', o, { vol: AudioEngine.LEVEL.collapse, jitter: 0.04 });
  }

  // ---------------------------------------------------------------- kaiju
  // A footfall: a sub-bass thud with a rumble tail and a crunch of asphalt; the robot's joints
  // clank (the metal hit, pitched way down).
  footstep(pos, k, rig) {
    if (!this.live || this.muted || !this._ok('step', 0.07)) return;
    const o = this._dest(pos, 1);
    this.tone(o, { f: 72, f1: 26, dur: 0.38, vol: 0.85 * k, dist: true });
    this.noise(o, { type: 'lowpass', f: 300, f1: 50, dur: 0.6, vol: 0.6 * k, buf: 'brown', attack: 0.004 });
    this.sample('groundSlam', o, { vol: AudioEngine.LEVEL.groundSlam * 0.2 * k, rate: rand(1.2, 1.4) });
    if (rig === 'mech') this.sample('metal', o, { vol: AudioEngine.LEVEL.metal * 0.1 * k, rate: rand(0.5, 0.6), t: 0.03 });
  }

  // a beam pouring out: roaring band-passed noise, a buzzing saw underneath and a wobble on top
  beamStart(f) {
    if (!this.live || this.muted || this.beams.has(f)) return;
    const ctx = this.ctx, t = ctx.currentTime, beast = f.def.rig === 'beast';
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(1, t + 0.06);
    g.connect(this._dest(f.pos, 1.2));
    const n = ctx.createBufferSource(); n.buffer = this.white; n.loop = true;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = beast ? 800 : 1500; bp.Q.value = 0.7;
    const ng = ctx.createGain(); ng.gain.value = 0.9;
    n.connect(bp); bp.connect(ng); ng.connect(g);
    const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = beast ? 52 : 86;
    const o2 = ctx.createOscillator(); o2.type = 'square'; o2.frequency.value = beast ? 78 : 172;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1100;
    const og = ctx.createGain(); og.gain.value = 0.3;
    o.connect(lp); o2.connect(lp); lp.connect(og); og.connect(g);
    const lfo = ctx.createOscillator(); lfo.frequency.value = beast ? 7 : 13;
    const lg = ctx.createGain(); lg.gain.value = beast ? 350 : 500;
    lfo.connect(lg); lg.connect(bp.frequency);
    for (const x of [n, o, o2, lfo]) { x.start(t); this._track(x); }
    this.tone(this._dest(f.pos, 1), { f: 110, f1: 30, dur: 0.8, vol: 1.2, dist: true });
    this.beams.set(f, { g, srcs: [n, o, o2, lfo] });
    this.duck(0.4, 1.6);
  }

  beamStop(f) {
    const b = this.beams.get(f);
    if (!b) return;
    const t = this.ctx.currentTime;
    b.g.gain.setTargetAtTime(0.0001, t, 0.09);
    for (const x of b.srcs) x.stop(t + 0.6);
    this.beams.delete(f);
  }

  // GORRAX's roar: his deepest line slowed right down, over a growling saw and a hiss of breath
  roar(pos) {
    if (!this.live || this.muted || !this._ok('roar', 1)) return;
    const o = this._dest(pos, 1.4);
    if (!this.sample('vo_patriarch_taunt', o, { vol: 2, rate: 0.48, pitchless: true, jitter: 0.02 })) this.sample('vo_patriarch_hurt_heavy', o, { vol: 2, rate: 0.45, pitchless: true });
    this.tone(o, { f: 140, f1: 60, dur: 1.6, vol: 0.5, type: 'sawtooth', dist: true, attack: 0.15 });
    this.noise(o, { f: 1400, f1: 500, q: 0.6, dur: 1.5, vol: 0.5, attack: 0.1 });
    this.duck(0.5, 1.4);
  }

  explosion(pos, s = 1) {
    if (!this.live || this.muted || !this._ok('boom', 0.2)) return;
    const o = this._dest(pos, 1.3);
    this.tone(o, { f: 90, f1: 22, dur: 1.4, vol: 1.4 * s, dist: true });
    this.noise(o, { type: 'lowpass', f: 900, f1: 60, dur: 2.6, vol: 1.2, buf: 'brown', attack: 0.005 });
    this.noise(o, { type: 'highpass', f: 1800, dur: 0.15, vol: 0.8 });
    this.sample('crumbleBig', o, { vol: AudioEngine.LEVEL.crumbleBig * 0.6, rate: 0.8, t: 0.05 });
    this.duck(0.6, 1.4);
  }

  chargeStart(f) {
    if (!this.live || this.muted || this.charges.has(f)) return;
    const ctx = this.ctx;
    if (this.has('charge')) {
      // recorded energy texture, looped; it climbs in pitch and level as the charge fills
      const src = ctx.createBufferSource();
      src.buffer = this.bank.charge[0]; src.loop = true; src.playbackRate.value = 0.85;
      const g = ctx.createGain(), t = ctx.currentTime;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.55, t + 0.12);
      src.connect(g); g.connect(this._dest(f.pos, 1));
      src.start(t);
      this._track(src);
      this.charges.set(f, { src, g });
      return;
    }
    const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = 70;
    const o2 = ctx.createOscillator(); o2.type = 'square'; o2.frequency.value = 70 * 1.5;
    const flt = ctx.createBiquadFilter(); flt.type = 'lowpass'; flt.frequency.value = 300; flt.Q.value = 6;
    const g = ctx.createGain(); g.gain.value = 0.0001;
    g.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.2);
    o.connect(flt); o2.connect(flt); flt.connect(g); g.connect(this._dest(f.pos, 1));
    o.start(); o2.start();
    this.charges.set(f, { o, o2, flt, g });
  }

  chargeUpdate(f, c) {
    const n = this.charges.get(f);
    if (!n) return;
    const t = this.ctx.currentTime;
    if (n.src) {
      n.src.playbackRate.setTargetAtTime(0.85 + 0.35 * c, t, 0.08);
      n.g.gain.setTargetAtTime(0.55 + 0.35 * c, t, 0.08);
      return;
    }
    n.o.frequency.setTargetAtTime((70 + c * 160) * this.pitch, t, 0.05);
    n.o2.frequency.setTargetAtTime((105 + c * 260) * this.pitch, t, 0.05);
    n.flt.frequency.setTargetAtTime(300 + c * 2600, t, 0.05);
    n.g.gain.setTargetAtTime(0.12 + c * 0.2, t, 0.05);
  }

  chargeStop(f) {
    const n = this.charges.get(f);
    if (!n) return;
    const t = this.ctx.currentTime;
    n.g.gain.setTargetAtTime(0.0001, t, 0.03);
    if (n.src) n.src.stop(t + 0.2); else { n.o.stop(t + 0.2); n.o2.stop(t + 0.2); }
    this.charges.delete(f);
  }

  sting(kind) {
    if (!this.live || this.muted) return;
    const o = this._dest(null, 1);
    // recorded stingers: [group, volume, slice length (0 = whole sample)]
    const rec = {
      ui: ['ui_select', 0.9, 0], hover: ['ui_hover', 0.9, 0], round: ['ui_round', 0.7, 0], fight: ['ui_fight', 0.85, 0],
      super: ['ui_super', 0.75, 0], streak: ['ui_streak', 0.6, 1.8], win: ['ui_win', 0.8, 0], ko: ['ui_ko', 0.9, 0],
    }[kind];
    if (rec && this.sample(rec[0], o, { vol: rec[1], jitter: 0, pitchless: true, dur: rec[2], offset: 0 })) {
      if (kind === 'fight') this.duck(0.55, 2.2);  // the braam lands first, then the riff swells in
      return;
    }
    if (kind === 'round') {
      this.tone(o, { f: 98, dur: 1.8, vol: 0.5, type: 'triangle', attack: 0.005 });
      this.tone(o, { f: 196, dur: 1.4, vol: 0.25, type: 'triangle' });
      this.tone(o, { f: 293, dur: 1.0, vol: 0.15, type: 'sine' });
      this.noise(o, { f: 1200, q: 0.5, dur: 0.6, vol: 0.4 });
    } else if (kind === 'fight') {
      this.tone(o, { f: 130, f1: 40, dur: 0.7, vol: 1.2, dist: true });
      this.noise(o, { type: 'lowpass', f: 600, f1: 80, dur: 1.2, vol: 1, buf: 'brown' });
      this.noise(o, { type: 'highpass', f: 2000, dur: 0.1, vol: 0.8 });
    } else if (kind === 'ko') {
      this.tone(o, { f: 400, f1: 35, dur: 1.6, vol: 0.5, type: 'sawtooth', dist: true });
      this.tone(o, { f: 55, f1: 20, dur: 2.2, vol: 1.2, dist: true });
      this.noise(o, { type: 'lowpass', f: 900, f1: 50, dur: 2.5, vol: 1.2, buf: 'brown' });
    } else if (kind === 'ui') {
      this.tone(o, { f: 880, f1: 660, dur: 0.06, vol: 0.2, type: 'square' });
    }
  }

  update(camera, timeScale, playerSpeed, paused = false) {
    if (!this.ctx) return;
    this.camera = camera;
    const t = this.ctx.currentTime;
    this.pitch = 0.6 + 0.4 * clamp(timeScale, 0, 1);
    this.muffle.frequency.setTargetAtTime(timeScale < 0.9 ? 900 + 4000 * timeScale : 20000, t, 0.05);
    // the soundtrack slows down like tape in slow-mo and goes muffled under the pause menu
    if (this.cur) this.cur.src.playbackRate.setTargetAtTime(0.72 + 0.28 * clamp(timeScale, 0, 1), t, 0.08);
    this.musicF.frequency.setTargetAtTime(paused ? 700 : timeScale < 0.9 ? 1200 + 6000 * timeScale : 20000, t, 0.08);
    this.ambF.frequency.setTargetAtTime(paused ? 900 : 20000, t, 0.1);
    const w = clamp((playerSpeed - 15) / 130, 0, 1);
    this.windG.gain.setTargetAtTime(w * AudioEngine.LEVEL.wind, t, 0.1);
    if (this.windSrc) this.windSrc.playbackRate.setTargetAtTime(0.85 + 0.3 * w, t, 0.1);
  }
}
