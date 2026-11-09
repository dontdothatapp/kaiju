import * as THREE from 'three';
import { G, URLP, storedQuality, storedFps, storedPace } from './core/context.js';
import { TimeControl } from './core/time.js';
import { Input } from './core/input.js';
import { AudioEngine } from './core/audio.js';
import { createRenderer, createScene, followShadow } from './render/renderer.js';
import { Post } from './render/post.js';
import { Weather } from './render/weather.js';
import { Physics } from './physics/physics.js';
import { DebrisSystem } from './physics/debris.js';
import { buildFractureLibrary } from './physics/fracture.js';
import { Ground, GROUND_SIZE } from './world/ground.js';
import { Destruction } from './world/structures.js';
import { generateCity } from './world/city.js';
import { generateRealCity, loadMap } from './world/realCity.js';
import { Props } from './world/props.js';
import { buildTrack, setTrackLoop, Train } from './world/train.js';
import { Boundary } from './world/boundary.js';
import { Trees, parkTreeSpots } from './world/trees.js';
import { chunkUniforms } from './world/chunkMaterial.js';
import { FX } from './fx/fx.js';
import { FightCamera } from './game/camera.js';
import { HUD } from './game/hud.js';
import { setupTouch } from './game/touch.js';
import { Game } from './game/game.js';
import { Recorder } from './game/recorder.js';
import { Recap } from './game/recap.js';

const _v = new THREE.Vector3();
const NORENDER = new URLSearchParams(location.search).has('norender');

function pickQuality() {
  if (URLP.quality) return URLP.quality;
  const sq = storedQuality();
  if (sq) return sq;
  const mobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
  return mobile ? 'low' : 'high';
}

async function boot() {
  const quality = pickQuality();
  G.settings.quality = quality;
  if (URLP.diff) G.settings.difficulty = URLP.diff;
  G.settings.fps = URLP.fps || storedFps();
  G.three = THREE;
  const app = document.getElementById('app');
  G.renderer = createRenderer(app, quality);
  const { scene, camera, sun, hemi, sky, clouds } = createScene(quality);
  G.scene = scene; G.camera = camera; G.sun = sun;
  G.time = new TimeControl();
  G.time.pace = G.settings.pace = URLP.pace || storedPace() || 1;
  G.input = new Input(G.renderer.domElement);
  G.audio = new AudioEngine();
  G.audio.prepare(); // suspended until the first tap, but the music downloads and decodes now

  G.physics = await Physics.create();
  // real maps (surveyed Manhattan) load on demand; anything else is the procedural downtown
  const map = URLP.map === 'grid' ? null : await loadMap(URLP.map).catch((e) => { console.warn(e); return null; });
  if (map) {
    // see further: the real skyline (Empire State, Midtown) is the point of the map
    scene.fog.near = 260;
    scene.fog.far = 1750;
  }
  G.ground = new Ground(scene, map);
  G.physics.setGroundHeights(G.ground.heights, G.ground.n, GROUND_SIZE);
  G.destruction = new Destruction(scene);
  const layout = map ? generateRealCity(G.destruction, scene, map, URLP.seed, quality) : generateCity(G.destruction, scene, URLP.seed, quality);
  G.layout = layout;
  if (layout.track) setTrackLoop(layout.track);
  buildTrack(G.destruction);
  G.destruction.finalize();
  G.ground.paintCity(layout);
  const lib = buildFractureLibrary();
  G.physics.warmup(lib);
  G.debris = new DebrisSystem(scene, G.physics, G.destruction.material, lib, quality);
  G.fx = new FX(scene, lib, quality);
  G.props = new Props(scene, layout);
  G.trees = layout.real ? new Trees(scene, parkTreeSpots(layout.map, URLP.seed)) : null;
  G.train = new Train(scene);
  G.boundary = new Boundary(scene);
  G.post = new Post(G.renderer, scene, camera, quality);
  // after the map has set its fog: the weather scales the map's own distances
  G.weather = new Weather({ scene, sun, hemi, sky, clouds, renderer: G.renderer, post: G.post, quality });
  G.weather.set(G.weather.choose());
  G.fightCam = new FightCamera(camera);
  G.hud = new HUD();
  setupTouch();
  G.recorder = new Recorder();
  G.recorder.install();
  G.recap = new Recap();
  G.game = new Game();

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    G.post.onResize(); // sizes the renderer and every pass at the current resolution scale
  });
  if (URLP.scale) G.post.setScale(URLP.scale);
  // any of these may be the gesture that's allowed to start audio (iOS: only lifting the finger)
  const unlock = () => G.audio.init();
  for (const ev of ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown']) window.addEventListener(ev, unlock, { passive: true });

  // every shader variant compiles now, not as a hitch on the first frame that needs it
  if (!NORENDER) G.renderer.compile(scene, camera);

  document.getElementById('loading').style.opacity = 0;
  setTimeout(() => document.getElementById('loading')?.remove(), 600);

  if (URLP.tutorial) { G.audio.music('menu'); G.game.startTutorial(); }
  else if (URLP.skipTitle || URLP.auto) G.game.start(G.settings.difficulty);
  else { G.game.state = 'title'; G.hud.showTitle((d) => G.game.start(d), () => G.game.startTutorial()); G.audio.music('menu'); }

  installTestHooks();

  let last = performance.now();
  const stats = window.__stats = { fps: 0, frames: 0, acc: 0, frame: 1 / 60, sim: 0, phys: 0, render: 0, gpu: 0, skipped: 0, bodies: 0, scale: G.post.scale };
  // The GPU runs behind the JavaScript: when it can't keep up, the browser may keep calling
  // requestAnimationFrame at full rate while finished frames queue up and reach the screen late,
  // which reads as a smooth frame counter over a game in slow motion. A fence after each frame
  // tells how far behind the GPU is: with two frames still unfinished this frame isn't drawn
  // (the simulation still runs, so game time stays real), and the fence timings give a GPU
  // frame time the frame interval alone would never show.
  const gpu = new GpuGauge(NORENDER || URLP.nopace ? null : G.renderer.getContext());
  stats.pace = gpu.mode;
  // Dynamic resolution: step the render scale down while the GPU is behind (frames skipped, or
  // GPU frame time over budget) or frames simply run long with a cheap CPU side; step it back up
  // after a couple of seconds comfortably inside 16.7 ms. ?scale=0.75 pins it.
  const adapt = { ft: 1 / 60, t: 0, good: 0, scale: G.post.scale, fixed: !!URLP.scale || NORENDER, warm: 3, skips: 0 };
  const adaptResolution = (realDt) => {
    if (adapt.fixed) return;
    if (realDt >= 0.05 || document.hidden) return; // a stalled tab, not a slow frame
    adapt.ft += (realDt - adapt.ft) * 0.1;
    adapt.t += realDt;
    if (adapt.t < 0.5) return;
    adapt.t = 0;
    const skips = adapt.skips; adapt.skips = 0;
    if (adapt.warm > 0) { adapt.warm -= 0.5; return; } // shaders compiling, assets decoding
    const cpuBound = stats.sim > 11; // fewer pixels wouldn't help
    // an idle GPU on a 60 Hz display completes a frame every 16.7 ms, so these sit either side of it
    const gpuBehind = skips > 2 || gpu.ms > 20;
    let k = adapt.scale;
    if (gpuBehind || (adapt.ft > 1 / 50 && !cpuBound)) { k -= gpu.ms > 40 || adapt.ft > 1 / 25 ? 0.2 : 0.1; adapt.good = 0; }
    else if (adapt.ft < 1 / 58.5 && gpu.ms < 17.5 && skips === 0 && k < 1 && ++adapt.good >= 4) { k += 0.05; adapt.good = 0; }
    else return;
    k = Math.max(0.5, Math.min(1, k));
    if (k !== adapt.scale) { adapt.scale = k; G.post.setScale(k); stats.scale = G.post.scale; }
  };
  const loop = (now) => {
    const realDt = Math.max(0, Math.min(0.05, (now - last) / 1000));
    last = now;
    gpu.poll();
    adaptResolution(realDt);
    const t0 = performance.now();
    if (!window.__hold) simulate(realDt); // tests hold real time still and step it themselves
    G.weather.update(realDt, now / 1000);
    const t1 = performance.now();
    if (!NORENDER) {
      if (gpu.behind) { adapt.skips++; gpu.skips++; }
      else { G.post.render(realDt); gpu.mark(); }
    }
    const t2 = performance.now();
    stats.frames++; stats.acc += realDt;
    stats.frame = stats.frame * 0.9 + realDt * 0.1; // the real interval between frames
    stats.gpu = gpu.ms; stats.skipped = gpu.skips; stats.pace = gpu.mode;
    stats.sim = stats.sim * 0.9 + (t1 - t0) * 0.1;
    stats.render = stats.render * 0.9 + (t2 - t1) * 0.1;
    stats.phys = G.physics.stepMs;
    stats.bodies = G.debris.activeCount;
    if (stats.acc > 1) { stats.fps = stats.frames / stats.acc; stats.frames = 0; stats.acc = 0; }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

// Fences after each drawn frame: how many frames the GPU still has in hand, and how long a frame
// takes to come out the other end (the interval between consecutive fences completing, smoothed).
class GpuGauge {
  constructor(gl) {
    this.gl = gl && gl.fenceSync ? gl : null;
    this.pending = [];
    this.ms = 0;        // GPU frame time (0 until measured)
    this.lastDone = 0;
    this.drains = 0;
    this.skips = 0;     // frames not drawn because the GPU was behind (cumulative)
    this.mode = this.gl ? 'fence' : 'off';
  }
  // Chrome reports a fence a frame or two after it signals: three unfinished frames is the sign
  // the GPU is really behind (a healthy one shows one or two here), and bounds the queue to ~50 ms.
  // Fences that haven't reported for half a second are drained with a hard wait; a browser that
  // keeps needing that gets a hard wait after every frame instead (the frame interval then tells
  // the truth about the GPU, and dynamic resolution works from that).
  get behind() {
    if (this.mode !== 'fence' || this.pending.length < 3) return false;
    if (performance.now() - this.pending[0].t < 500) return true;
    this._drain();
    return false;
  }
  _drain() {
    const gl = this.gl;
    gl.finish();
    for (const f of this.pending) gl.deleteSync(f.sync);
    this.pending.length = 0;
    this.lastDone = 0;
    if (++this.drains >= 6) { this.mode = 'sync'; console.warn('[gpu] fences slow to report here: waiting for the GPU each frame instead'); }
  }
  mark() {
    const gl = this.gl;
    if (!gl) return;
    if (this.mode === 'sync') { gl.finish(); return; }
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    if (!sync) return;
    this.pending.push({ sync, t: performance.now() });
    gl.flush();
  }
  poll() {
    const gl = this.gl;
    if (!gl || this.mode !== 'fence') return;
    const now = performance.now();
    while (this.pending.length) {
      const f = this.pending[0];
      const r = gl.clientWaitSync(f.sync, 0, 0);
      if (r === gl.TIMEOUT_EXPIRED) break;
      gl.deleteSync(f.sync);
      this.pending.shift();
      if (this.lastDone) {
        const gap = Math.min(100, now - this.lastDone); // poll granularity: a frame at best
        this.ms = this.ms ? this.ms * 0.85 + gap * 0.15 : gap;
      }
      this.lastDone = now;
    }
    // a long idle gap (the tab was hidden, a menu) must not read as a slow GPU
    if (!this.pending.length && now - this.lastDone > 250) this.lastDone = 0;
  }
}

function simulate(realDt) {
  G.input.poll();
  if (G.recap.active) return simulateRecap(realDt);
  G.time.update(realDt);
  const dt = G.time.dt;
  G.game.update(dt, realDt);
  G.physics.step(dt);
  G.debris.update(dt);
  G.destruction.update(dt);
  G.props.update(dt);
  G.train.update(dt);
  G.ground.update(dt);
  G.fx.update(dt, realDt, G.camera);
  G.fightCam.update(realDt, dt);
  const p = G.player, b = G.bot;
  const fighting = G.game.state !== 'title' && G.game.state !== 'boot';
  if (fighting) {
    // the see-through tunnels aim at their chests
    chunkUniforms.uFocus.value.copy(p.pos).setY(p.pos.y + p.H * 0.2);
    chunkUniforms.uFocus2.value.copy(b.pos).setY(b.pos.y + b.H * 0.2);
    G.fx.smoke.setFocus(chunkUniforms.uFocus.value, chunkUniforms.uFocus2.value);
    G.boundary.update(G.time.realTime, p.pos, b.pos);
  } else {
    chunkUniforms.uFocus.value.set(0, -1e4, 0);
    chunkUniforms.uFocus2.value.set(0, -1e4, 0);
  }
  // only the buildings in those tunnels (or hugging the camera) draw with the discard shader
  G.destruction.updateMaterials(G.camera.position, fighting ? chunkUniforms.uFocus.value : null, fighting ? chunkUniforms.uFocus2.value : null);
  followShadow(G.sun, fighting ? _v.copy(p.pos).lerp(b.pos, 0.4) : G.fightCam.look);
  G.audio.update(G.camera, G.time.scale, p.vel.length(), G.game.paused);
  G.hud.update(realDt);
  G.post.update(realDt, G.time.realTime);
  G.recorder.update();
}

// The match recap plays: the world stands still, the recap poses it and moves the camera.
function simulateRecap(realDt) {
  G.time.realTime += realDt;
  G.game.update(0, realDt);
  G.recap.update(realDt);
  G.destruction.updateMaterials(G.camera.position, chunkUniforms.uFocus.value, chunkUniforms.uFocus2.value);
  G.audio.update(G.camera, G.recap.speed, 0, false);
  G.hud.update(realDt);
  G.post.update(realDt, G.time.realTime);
}

function installTestHooks() {
  window.__G = G;
  window.__test = {
    // advance the whole simulation deterministically (no rendering) - used by headless tests
    advance(seconds, step = 1 / 60) {
      const n = Math.round(seconds / step);
      for (let i = 0; i < n; i++) simulate(step);
      return n;
    },
    impact(x, y, z, r = 3, power = 1, vx = 0, vy = 0, vz = 0) {
      return G.destruction.impact({ pos: new THREE.Vector3(x, y, z), radius: r, power, vel: new THREE.Vector3(vx, vy, vz) });
    },
    ground(x, z, speed = 120) { G.fx.groundImpact(new THREE.Vector3(x, 0, z), speed); },
    cam(px, py, pz, tx, ty, tz) { G.fightCam.override = { pos: new THREE.Vector3(px, py, pz), look: new THREE.Vector3(tx, ty, tz) }; },
    freeCam() { G.fightCam.override = null; },
    // put both kaiju next to a tower (normal gameplay camera): the bot with his back to it
    fightAtTower(rank = 0) {
      const s = G.destruction.structs.slice().sort((a, b) => b.max.y - a.max.y)[rank];
      const c = s.min.clone().add(s.max).multiplyScalar(0.5);
      const gy = (x, z, f) => G.ground.heightAt(x, z) + f.hipH;
      G.bot.pos.set(s.min.x - 16, 0, c.z); G.bot.pos.y = gy(G.bot.pos.x, c.z, G.bot);
      G.player.pos.set(s.min.x - 48, 0, c.z - 6); G.player.pos.y = gy(G.player.pos.x, c.z - 6, G.player);
      G.player.vel.set(0, 0, 0); G.bot.vel.set(0, 0, 0);
      return s.id;
    },
    // make a fighter do something: 'light' 'heavy' 'grab' 'super' 'up' (jump) 'down' (stomp) 'rise' (beam)
    act(who, action, hold = 0) {
      const f = who === 'bot' ? G.bot : G.player;
      if (hold) { f.ctrl.press(action); setTimeout(() => f.ctrl.release(action), hold); } else f.ctrl.tap(action);
    },
    // knock out a whole storey of the tallest tower to trigger a collapse
    collapseTower(level = 4, rank = 0) {
      const s = G.destruction.structs.slice().sort((a, b) => b.max.y - a.max.y)[rank];
      const y = s.origin.y + (level + 0.5) * s.sy;
      const c = s.min.clone().add(s.max).multiplyScalar(0.5);
      let n = 0;
      for (let a = 0; a < Math.PI * 2; a += 0.35) {
        const p = new THREE.Vector3(c.x + Math.cos(a) * (s.max.x - s.min.x) * 0.5, y, c.z + Math.sin(a) * (s.max.z - s.min.z) * 0.5);
        n += G.destruction.impact({ pos: p, radius: 3.4, power: 1, vel: p.clone().sub(c).setY(0).normalize().multiplyScalar(30) }).count;
      }
      return { n, c: c.toArray(), top: s.max.y, id: s.id };
    },
    // the highlight recap: start it now (mid-fight works too), and what it's doing
    recap() { return G.game.playRecap(); },
    recapState() {
      const r = G.recap, g = r.seg;
      return { active: r.active, seg: r.i, of: r.segs ? r.segs.length : 0, type: g && g.type, T: +r.T.toFixed(2), speed: +r.speed.toFixed(2), total: +(r.total || 0).toFixed(1), clips: r.clips ? r.clips.map((c) => ({ t0: +c.t0.toFixed(1), t1: +c.t1.toFixed(1), score: +c.score.toFixed(1), beats: c.beats.map((b) => b.kind + (b.name ? ':' + b.name : '')) })) : [] };
    },
    recorder() { return G.recorder.stats(); },
    // one frame on demand (with ?norender the loop draws nothing, so long scenarios stay fast)
    render() { G.post.render(1 / 60); },
    // stop the real-time loop from stepping the game between a test's own steps
    hold(on = true) { window.__hold = on; },
    state() {
      const f = (x) => ({ state: x.state, hp: +x.hp.toFixed(1), meter: Math.round(x.meter), pos: x.pos.toArray().map((v) => +v.toFixed(1)), speed: +x.vel.length().toFixed(1) });
      return { game: G.game.state, round: G.game.round, wins: G.game.wins, player: f(G.player), bot: f(G.bot), bodies: G.debris.activeCount, chunks: G.stats.chunksDestroyed, collapsed: G.stats.buildingsCollapsed };
    },
  };
}

boot().catch((e) => {
  console.error(e);
  const l = document.getElementById('loading');
  if (!l) return;
  const wasm = /wasm|WebAssembly|CompileError/i.test(String(e && (e.message || e)));
  l.querySelector('.ld-sub').innerHTML = wasm
    ? 'This browser or page blocked WebAssembly (needed for the physics engine).<br>Run it locally: <code>npm install &amp;&amp; npm run dev</code>'
    : 'Failed to start: ' + (e && e.message ? e.message : e) + '<br>WebGL2 and a recent Chrome, Edge or Firefox are required.';
});
