// Shared game context. Subsystems register themselves here so the "juice director"
// can reach every feedback channel (camera, fx, audio, physics, destruction) from one place.
export const G = {
  three: null,       // THREE namespace convenience
  renderer: null,
  scene: null,
  camera: null,
  post: null,
  time: null,
  input: null,
  audio: null,
  physics: null,
  destruction: null,
  ground: null,
  city: null,
  fx: null,
  fighters: [],
  fightCam: null,
  hud: null,
  game: null,
  touch: null,       // on-screen controls (phones / tablets), see game/touch.js
  settings: {
    quality: 'high',
    gore: true,
    difficulty: 'sparring',
    playAs: 'kaiser',
    shake: 1.0,
    fps: false,        // the frame-rate readout (title options, or ?fps); remembered in localStorage
    pace: 1,           // game speed: 1 normal, 1.25 brisk, 1.5 fast (title options, or ?pace=); remembered
  },
  stats: { chunksDestroyed: 0, buildingsCollapsed: 0 },
};

const params = new URLSearchParams(location.search);
// One-shot settings handed over a reload (works inside sandboxed frames where the URL can't change).
function takeStored() {
  try {
    const v = JSON.parse(localStorage.getItem('megaton-next') || 'null');
    localStorage.removeItem('megaton-next');
    return v || {};
  } catch (e) { return {}; }
}
export function storedQuality() {
  try { return localStorage.getItem('megaton-quality'); } catch (e) { return null; }
}
export function storedKaiju() {
  try { return localStorage.getItem('megaton-kaiju'); } catch (e) { return null; }
}
export function storedPace() {
  try { const v = parseFloat(localStorage.getItem('megaton-pace')); return v >= 0.5 && v <= 2 ? v : 0; } catch (e) { return 0; }
}
export function storedFps() {
  try { return localStorage.getItem('megaton-fps') === '1'; } catch (e) { return false; }
}
export function storedMap() {
  try { return localStorage.getItem('megaton-map'); } catch (e) { return null; }
}
// v2 since golden hour became the default (2026-10-31): a pick saved under the old key, often the
// old 'random' default, no longer overrides it
export const WEATHER_KEY = 'megaton-weather-v2';
function storedWeather() {
  try { return localStorage.getItem(WEATHER_KEY); } catch (e) { return null; }
}
const next = takeStored();
export function reloadWith(opts) {
  try { localStorage.setItem('megaton-next', JSON.stringify(opts)); } catch (e) { /* storage blocked */ }
  location.reload();
}
export const URLP = {
  auto: params.has('auto'),           // bot vs bot (for testing / attract mode)
  norecap: params.has('norecap'),     // no highlight recap after the match
  fps: params.has('fps'),             // the frame-rate readout on from the start
  pace: (() => { const v = parseFloat(params.get('pace')); return v >= 0.5 && v <= 2 ? v : 0; })(), // game speed multiplier
  nopace: params.has('nopace'),       // no GPU fences / frame pacing (main.js GpuGauge), for comparison
  debug: params.has('debug'),
  quality: params.get('quality'),
  scale: params.get('scale') ? Math.min(1, Math.max(0.5, parseFloat(params.get('scale')) || 1)) : 0, // pin the render scale (0.5..1); default: dynamic
  seed: next.seed ?? (params.get('seed') ? parseInt(params.get('seed'), 10) : 1337),
  skipTitle: params.has('fight') || !!next.fight,
  diff: next.diff || params.get('diff'),
  shot: params.get('shot'),          // test hook: scripted scenarios
  map: params.get('map') || storedMap() || 'flatiron', // a real map id ('flatiron', the default) or 'grid' (procedural downtown)
  weather: params.get('weather') || storedWeather() || 'golden', // a preset in render/weather.js, or 'random'
  // round openers (game/intro.js); the dev / test flags skip them unless ?intro asks
  intro: params.has('intro') || !(params.has('fight') || params.has('auto') || params.has('nointro')),
  tutorial: params.has('tutorial') || !!next.tutorial, // straight into the tutorial (game/tutorial.js)
  kaiju: next.kaiju || params.get('kaiju'),           // who you play: 'kaiser' (the robot) or 'gorrax' (the monster)
};
