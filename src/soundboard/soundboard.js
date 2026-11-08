// Sound library (sounds.html, dev only): every sample the game plays, by category, with a player.
// Each sound has an A slot (the file in use) and room for alternatives B, C... found under
// public/alt/ at the same path (alt/sfx/ui/fight.mp3 is an alternative to sfx/ui/fight.mp3),
// listed in alt/index.json by tools/sfx-index.mjs. Alternatives live outside public/sfx so the
// game never loads them. Picks are kept in this browser and exported with "Copy picks".
// sfx/elevenlabs.json (written by tools/elevenlabs-sfx.mjs and elevenlabs-voices.mjs) says which
// files, in game or alternatives, ElevenLabs made, from what prompt and at what cost. A new voice
// line with no file in game yet gets its own card; if it would replace an old voice (its
// "replaces"), that old one sits in its A slot instead of a card of its own.
import { GENERATED, render } from './generated.js';

const CATS = [
  { id: 'cues', title: 'Stingers & cues', blurb: 'One-shots for round flow, combat moments and the city.' },
  { id: 'hits', title: 'Hits as played', blurb: 'The recorded punches with the generated layers the game adds on top. ↻ plays a new variation.' },
  { id: 'impacts', title: 'Impacts', blurb: 'ElevenLabs sound effects; each one\'s prompt and cost is under its card.' },
  { id: 'destruction', title: 'Destruction', blurb: 'ElevenLabs sound effects for the breakable city. Small or big is picked by how much breaks.' },
  { id: 'movement', title: 'Movement', blurb: 'ElevenLabs sound effects for attacks, dashes and flight.' },
  { id: 'voHeir', title: 'Voices · KAISER-OH\'s pilot', blurb: 'An ElevenLabs voice: a fiery young shonen hero, shouting from the cockpit. A line with several takes plays one at random.' },
  { id: 'voPatriarch', title: 'Voices · GORRAX', blurb: 'An ElevenLabs voice: a deep, cold villain. In the game it plays at ~0.6x speed, so it comes out as growls and roars. A line with several takes plays one at random.' },
  { id: 'music', title: 'Music & ambience', blurb: 'Looped in game. Woffels, Metal OST (CC BY); ambience by ElevenLabs.' },
  { id: 'menu', title: 'Menu', blurb: 'uisfx (CC0).' },
  { id: 'punchLight', title: 'Punches · light', blurb: 'One is picked at random for each light hit.', compact: true },
  { id: 'punchHeavy', title: 'Punches · heavy', blurb: 'One is picked at random for each heavy hit.', compact: true },
  { id: 'other', title: 'Other files', blurb: 'In the sound index but not described here yet.' },
];

// file -> [category, name, where it plays]; unused: in the folder but no game code plays it
const KNOWN = {
  'sfx/ui/fight.mp3': ['cues', 'Fight!', '"FIGHT!" banner; ducks the music as the riff comes in'],
  'sfx/ui/round_drop.mp3': ['cues', 'Round', 'The "ROUND" banner'],
  'sfx/ui/ko_downer.mp3': ['cues', 'K.O.', '"K.O.!"'],
  'sfx/ui/super_ready.mp3': ['cues', 'Super ready', "The player's super meter fills"],
  'sfx/ui/combo_streak.mp3': ['cues', 'Combo streak', '5, 8 and 12-hit combos (first 1.8 s)'],
  'sfx/ui/parry.mp3': ['cues', 'Parry', 'A parry'],
  'sfx/ui/charge.mp3': ['cues', 'Charge', 'Holding a charged heavy (looped, rising in pitch); the super wind-up'],
  'sfx/ui/victory.mp3': ['cues', 'Victory', 'Results screen, before the results theme'],
  'sfx/ui/police_radio.mp3': ['cues', 'Police radio', 'Once, in the distance, after the first super of a session'],
  'music/1-NV1a-intro.ogg': ['music', 'Title theme', 'Title menu'],
  'music/1-NV2b-riff-action-doom.ogg': ['music', 'Fight theme', 'From "FIGHT!" through all rounds'],
  'music/1-NV5c-brutal2-short.ogg': ['music', 'Results theme', 'Results screen, win or lose, after the victory stinger'],
  'music/ambience.mp3': ['music', 'City ambience', 'A dark city bed under everything, from the first click'],
  'sfx/ui/hover.mp3': ['menu', 'Hover', 'Menu hover'],
  'sfx/ui/select.mp3': ['menu', 'Select', 'Menu select'],
  'sfx/impacts/blocked.mp3': ['impacts', 'Blocked hit', 'Any hit that lands on a block'],
  'sfx/impacts/ground_slam.mp3': ['impacts', 'Ground slam', 'A fighter crashes into the street: landings, missed dives, launches; louder with speed'],
  'sfx/impacts/smash_through.mp3': ['impacts', 'Smash through a wall', 'A launched fighter breaks through a building'],
  'sfx/impacts/metal.mp3': ['impacts', 'Metal impact', 'Lamp posts, cars and the train being hit'],
  'sfx/impacts/field.mp3': ['impacts', 'Force field bounce', "A launched fighter bouncing off the arena's force field"],
  'sfx/destruction/creak.mp3': ['destruction', 'Building creak', 'A damaged building groans before it gives way'],
  'sfx/destruction/collapse.mp3': ['destruction', 'Building collapse', 'A building comes down'],
  'sfx/destruction/crumble_small.mp3': ['destruction', 'Crumble · small', 'Chunks breaking off a wall; debris landing'],
  'sfx/destruction/crumble_big.mp3': ['destruction', 'Crumble · big', 'A large part of a building breaking up'],
  'sfx/destruction/glass_small.mp3': ['destruction', 'Glass · small', 'A few windows breaking'],
  'sfx/destruction/glass_big.mp3': ['destruction', 'Glass · big', 'A whole facade of windows shattering'],
  'sfx/movement/swing.mp3': ['movement', 'Swing', 'An attack swinging through the air (lighter moves are quieter)'],
  'sfx/movement/whoosh.mp3': ['movement', 'Whoosh', 'Dashes, launches, throws and the intro drop'],
  'sfx/movement/grab.mp3': ['movement', 'Grab', 'A grab connecting (under the grab shout)'],
  'sfx/movement/skid.mp3': ['movement', 'Skid', 'A launched fighter ploughing along the ground'],
  'sfx/movement/wind.mp3': ['movement', 'Speed wind', 'Looped under everything, louder and higher the faster the player moves'],
};
// voice line id (tools/elevenlabs-voices.mjs, AudioEngine.VOICE) -> [name, when it plays (Fighter.shout)]
const VOICE_LINES = {
  attack_light: ['Light attack', 'Jabs and crosses, 4 times in 10'],
  attack_mid: ['Mid attack', 'The hook, 7 times in 10'],
  attack_heavy: ['Heavy attack', 'The combo finisher and quick heavies'],
  charge: ['Charging', 'Starting to charge a heavy'],
  charge_release: ['Charged release', 'Letting go of a charged heavy, uppercut or meteor'],
  dash: ['Dash', 'Half the dodge-dashes'],
  skyward: ['Skyward', 'Shooting straight up above the city'],
  skydive: ['Sky dive', 'Diving on the opponent from the top'],
  grab: ['Grab', 'A grab connecting, into the drag and throw'],
  super_start: ['Super', 'The super grab launching, hit or miss'],
  super_finish: ['Super finisher', "The super's wind-up, after the barrage"],
  block: ['Block', 'Taking a hit on the block, 6 times in 10'],
  hurt_light: ['Hurt', 'Taking a hit (6 times in 10), being parried or guard-broken'],
  hurt_heavy: ['Launched', 'Being sent flying'],
  getup: ['Getting up', 'Getting up from a knockdown; sometimes on catching yourself in the air'],
  ko: ['K.O.', 'Being knocked out'],
  win: ['Victory', 'Winning the match'],
  taunt: ['Taunt', 'GORRAX roaring (slowed way down in the game)'],
};
const VOICE_CATS = { heir: 'voHeir', patriarch: 'voPatriarch' };
const order = (s) => {
  const i = s.gen ? Object.keys(GENERATED).indexOf(s.gen) : s.line ? Object.keys(VOICE_LINES).indexOf(s.line) * 10 + (s.take || 1) : Object.keys(KNOWN).indexOf(s.file);
  return i < 0 ? 1e9 : i;
};
const MUSIC = Object.keys(KNOWN).filter((f) => f.startsWith('music/'));
const PICKS_KEY = 'megaton-sound-picks';

const describe = (file) => {
  const k = KNOWN[file];
  if (k) return { cat: k[0], name: k[1], use: k[2], unused: !!k[3] };
  const base = file.split('/').pop().replace(/\.\w+$/, '');
  const [, who, line, take] = file.match(/^sfx\/voices\/(\w+)\/(\w+?)(?:-(\d+))?\.\w+$/) || [];
  if (VOICE_LINES[line]) return { cat: VOICE_CATS[who] || 'other', name: `${VOICE_LINES[line][0]}${take ? ` · take ${take}` : ''}`, use: VOICE_LINES[line][1], line, take: +take || 1 };
  if (file.startsWith('sfx/punches/light/')) return { cat: 'punchLight', name: base };
  if (file.startsWith('sfx/punches/heavy/')) return { cat: 'punchHeavy', name: base };
  return { cat: 'other', name: base };
};

const getJSON = async (url) => { try { const r = await fetch(url); return r.ok ? await r.json() : []; } catch (e) { return []; } };
const fmt = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };

let picks = {};
try { picks = JSON.parse(localStorage.getItem(PICKS_KEY)) || {}; } catch (e) { /* storage blocked */ }
const savePicks = () => { try { localStorage.setItem(PICKS_KEY, JSON.stringify(picks)); } catch (e) { /* storage blocked */ } };

// --- playback: one sound at a time, decoded once (the decoded buffer also draws the waveform) ---
let ctx = null;
const audio = () => (ctx ||= new AudioContext());
const buffers = new Map();   // file url or generated id -> Promise<AudioBuffer|null>
const fromFile = (url) => fetch(url).then((r) => r.arrayBuffer()).then((b) => audio().decodeAudioData(b));
const load = (src) => {
  if (!buffers.has(src.key)) buffers.set(src.key, src.make().catch((e) => { console.warn(src.key, e); return null; }));
  return buffers.get(src.key);
};
let playing = null;          // { take, src, t0, dur, then }

const stop = () => {
  if (!playing) return;
  const p = playing; playing = null;
  p.src.onended = null;
  try { p.src.stop(); } catch (e) { /* already stopped */ }
  p.take.classList.remove('on');
  p.take.draw(0);
};

const play = async (take, then = null) => {
  stop();
  const buf = await load(take.src);
  if (!buf) return;
  await audio().resume();
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start();
  playing = { take, src, t0: ctx.currentTime, dur: buf.duration };
  take.classList.add('on');
  src.onended = () => { stop(); if (then) setTimeout(then, 250); };
};

const tick = () => {
  if (playing) playing.take.draw(Math.min(1, (ctx.currentTime - playing.t0) / playing.dur));
  requestAnimationFrame(tick);
};
requestAnimationFrame(tick);

// --- a take: one playable version of a sound (A = in use, B... = alternatives) ---
const seen = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) { seen.unobserve(e.target); e.target.prepare(); }
}, { rootMargin: '400px' });

// src: { key, make: () => Promise<AudioBuffer>, gen } (gen: rendered from code, can re-roll)
function makeTake(src, letter, sound) {
  const take = el('div', 'take');
  take.src = src;
  take.innerHTML = `<button class="play" title="Play / stop"><i></i></button>
    <span class="letter">${letter}</span>
    <canvas></canvas>
    <span class="dur">…</span>`;
  const cvs = take.querySelector('canvas');
  let peaks = null;
  take.draw = (t) => {
    const w = cvs.clientWidth, h = cvs.clientHeight, dpr = devicePixelRatio || 1;
    if (!w) return;
    if (cvs.width !== w * dpr) { cvs.width = w * dpr; cvs.height = h * dpr; }
    const g = cvs.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    if (!peaks) return;
    const n = peaks.length, bw = w / n;
    for (let i = 0; i < n; i++) {
      const a = Math.max(1, peaks[i] * (h - 2));
      g.fillStyle = i / n < t ? '#e2231a' : '#111';
      g.fillRect(i * bw, (h - a) / 2, Math.max(1, bw - 1), a);
    }
  };
  take.prepare = async () => {
    const buf = await load(src);
    if (!buf) { take.querySelector('.dur').textContent = 'missing'; take.classList.add('bad'); return; }
    take.querySelector('.dur').textContent = fmt(buf.duration);
    const d = buf.getChannelData(0), n = 90, step = Math.floor(d.length / n) || 1;
    peaks = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let m = 0;
      for (let j = i * step, e = Math.min(d.length, j + step); j < e; j++) m = Math.max(m, Math.abs(d[j]));
      peaks[i] = m;
    }
    const top = Math.max(...peaks) || 1;
    for (let i = 0; i < n; i++) peaks[i] /= top;
    take.draw(0);
  };
  take.querySelector('.play').onclick = () => (playing?.take === take ? stop() : play(take));
  if (src.gen) {
    const again = el('button', 'again', '↻');
    again.title = 'Render a new variation and play it';
    again.onclick = async () => {
      if (playing?.take === take) stop();
      buffers.delete(src.key);
      await take.prepare();
      play(take);
    };
    take.querySelector('.dur').before(again);
  }
  if (sound.takes.length) {   // only alternatives get a choice: with one take there is nothing to pick
    const keep = el('label', 'keep', `<input type="radio" name="${sound.file}"> Keep`);
    const input = keep.querySelector('input');
    input.checked = picks[sound.file] === src.key;
    input.onchange = () => { picks[sound.file] = src.key; savePicks(); sound.card.classList.add('decided'); updatePicks(); };
    take.append(keep);
  }
  seen.observe(take);
  return take;
}

function makeCard(sound) {
  const card = el('article', 'snd');
  sound.card = card;
  card.dataset.text = `${sound.name} ${sound.file} ${sound.call || ''} ${sound.use || ''}`.toLowerCase();
  card.innerHTML = `<div class="meta">
      <h3>${sound.name}${sound.unused ? ' <em>not used in game</em>' : ''}${sound.line && !sound.current ? ' <em>new</em>' : ''}</h3>
      ${sound.use ? `<p>${sound.use}</p>` : ''}
      <code>${sound.call ? `audio.${sound.call}` : sound.file}</code>
    </div>`;
  const ab = el('div', 'ab');
  const alts = sound.alts;
  sound.takes = [];
  // A: what the game plays now (rendered from code for the hits; nothing yet for a new voice line)
  const current = sound.gen ? { key: sound.file, make: () => render(sound.gen), gen: true }
    : sound.current ? { key: sound.current, make: () => fromFile(sound.current) } : null;
  const all = [current, ...alts.map((f) => ({ key: f, make: () => fromFile(f) }))];
  if (alts.length) sound.takes = all.filter(Boolean);
  all.forEach((s, i) => ab.append(s ? makeTake(s, String.fromCharCode(65 + i), sound)
    : el('div', 'take empty', '<span class="letter">A</span><span>Nothing in game now</span>')));
  [sound.current, ...alts].forEach((f, i) => {
    const m = f && fileMeta[f];
    if (!m) return;
    card.dataset.text += ` ${m.source} ${m.prompt}`.toLowerCase();
    const parts = [m.source, m.voice && `${m.voice.replace(/^Bloodline · /, '')} voice`, m.seconds && `${m.seconds} s${m.loop ? ' loop' : ''}`,
      `${m.credits ?? '?'} credits${m.tries > 1 ? ` · try ${m.tries}, ${m.spent} credits in all` : ''}`];
    ab.append(el('p', 'alt-info', `<b>${String.fromCharCode(65 + i)}</b> ${parts.filter(Boolean).join(' · ')} <q>${m.prompt}</q>`));
  });
  if (!alts.length) ab.append(el('div', 'take empty', '<span class="letter">B</span><span>Alternative coming</span>'));
  else {
    if (current) {
      const both = el('button', 'btn ab-play', 'Play A → B');
      both.onclick = () => {
        const t = ab.querySelectorAll('.take');
        play(t[0], () => play(t[1]));
      };
      ab.append(both);
    }
    card.classList.add('has-alt');
    if (picks[sound.file]) card.classList.add('decided');
  }
  card.append(ab);
  return card;
}

let sounds = [], fileMeta = {};
function updatePicks() {
  const open = sounds.filter((s) => s.alts.length);
  const out = document.getElementById('picks'), copy = document.getElementById('copy');
  out.classList.toggle('hidden', !open.length);
  copy.classList.toggle('hidden', !open.length);
  out.textContent = `${open.filter((s) => picks[s.file]).length} / ${open.length} compared sounds decided`;
}

async function main() {
  const [sfx, alt, meta] = await Promise.all([getJSON('sfx/index.json'), getJSON('alt/index.json'), getJSON('sfx/elevenlabs.json')]);
  fileMeta = meta;
  const files = [...MUSIC, ...sfx.map((f) => `sfx/${f}`)];
  const base = (f) => f.replace(/(-\d+)?\.\w+$/, '');
  const gen = Object.entries(GENERATED).map(([id, g]) => ({ file: `generated/${id}`, gen: id, cat: g[0], name: g[1], use: g[2], call: g[3] }));
  // alternatives with no file in game yet (new voice lines): one card per target path
  const inGame = new Set(files.map(base)), planned = new Map(), replaced = new Set();
  for (const a of alt) {
    const target = base(a);
    if (inGame.has(target) || planned.has(target)) continue;
    const [, char, line] = target.match(/^sfx\/voices\/(\w+)\/(\w+)$/) || [];
    const replaces = meta[`alt/${a}`]?.replaces || null;
    if (replaces) replaced.add(replaces);
    planned.set(target, { file: `${target}.mp3`, current: replaces, line, cat: VOICE_CATS[char] || 'other',
      name: VOICE_LINES[line]?.[0] || target.split('/').pop(), use: VOICE_LINES[line]?.[1] });
  }
  sounds = [...files.filter((f) => !replaced.has(f)).map((file) => ({ file, current: file, ...describe(file) })), ...gen, ...planned.values()].map((s) => ({
    ...s,
    alts: alt.filter((a) => base(a) === base(s.file)).map((a) => `alt/${a}`),
  }));
  const lib = document.getElementById('lib'), nav = document.getElementById('nav');
  for (const c of CATS) {
    const list = sounds.filter((s) => s.cat === c.id).sort((a, b) => order(a) - order(b) || a.file.localeCompare(b.file));
    if (!list.length) continue;
    const sec = el('section', `cat${c.compact ? ' compact' : ''}`);
    sec.id = c.id;
    sec.innerHTML = `<h2>${c.title} <span>${list.length}</span></h2><p class="blurb">${c.blurb}</p>`;
    const grid = el('div', 'grid');
    list.forEach((s) => grid.append(makeCard(s)));
    sec.append(grid);
    lib.append(sec);
    const a = el('a', null, `${c.title} <span>${list.length}</span>`);
    a.href = `#${c.id}`;
    nav.append(a);
  }
  if (!alt.length) lib.prepend(el('p', 'note', `No alternatives to compare right now. Put one at <code>public/alt/</code> under the same path as the sound it replaces
    (<code>public/alt/sfx/ui/fight.mp3</code> for <code>sfx/ui/fight.mp3</code>; add <code>-2</code>, <code>-3</code> for more), then run
    <code>node tools/sfx-index.mjs</code> or restart <code>npm run dev</code>. It shows up in the B slot next to the current one.
    <code>tools/elevenlabs-sfx.mjs</code> and <code>elevenlabs-voices.mjs</code> make ElevenLabs ones there and move the keepers into the game.`));
  const paid = Object.entries(meta).filter(([k, m]) => !k.startsWith('_') && m.credits != null).map(([, m]) => m);
  if (paid.length) {
    const sum = (list, f) => list.reduce((n, m) => n + (f(m) || 0), 0), n = (x) => x.toLocaleString();
    const fx = paid.filter((m) => !m.voice), vo = paid.filter((m) => m.voice), voices = Object.values(meta._voices || {});
    const fxSpent = sum(fx, (m) => m.spent ?? m.credits), fxKept = sum(fx, (m) => m.credits), fxSecs = sum(fx, (m) => m.seconds);
    const retries = sum(fx, (m) => (m.tries ?? 1) - 1), design = sum(voices, (v) => v.credits), voSpent = sum(vo, (m) => m.spent ?? m.credits);
    const total = fxSpent + design + voSpent, plan = meta._plan;
    lib.prepend(el('p', 'note cost', `<b>ElevenLabs so far: ${n(total)} credits</b>${plan ? `, ${(total / plan.limit * 100).toFixed(1)}% of the
      ${plan.tier} plan's ${n(plan.limit)} monthly credits` : ''}.
      Sound effects: ${fx.length} (${fxSecs.toFixed(1)} s), ${n(fxSpent)} credits at ${(fxKept / fxSecs).toFixed(0)} per second${retries ? `, ${n(fxSpent - fxKept)} of them on ${retries} earlier ${retries > 1 ? 'tries' : 'try'}` : ''}.
      ${vo.length ? `Voices: ${voices.length} designed (${n(design)} credits) and ${vo.length} lines (${n(voSpent)} credits).` : ''}
      Each one's prompt and cost is under its card.`));
  }
  updatePicks();

  document.getElementById('q').oninput = (e) => {
    const q = e.target.value.trim().toLowerCase();
    for (const s of sounds) s.card.classList.toggle('hidden', !!q && !s.card.dataset.text.includes(q));
    for (const sec of lib.querySelectorAll('.cat')) sec.classList.toggle('hidden', !sec.querySelector('.snd:not(.hidden)'));
  };
  document.getElementById('copy').onclick = async (e) => {
    const out = {};
    for (const s of sounds) if (s.alts.length) out[s.file] = picks[s.file] || null;
    await navigator.clipboard.writeText(JSON.stringify(out, null, 2));
    e.target.textContent = 'Copied';
    setTimeout(() => (e.target.textContent = 'Copy picks'), 1200);
  };
  addEventListener('keydown', (e) => { if (e.key === 'Escape') stop(); });
}

main();
