// Weather and time of day. One set of numbers drives the sun (or the moon), the sky, fog, clouds,
// exposure, bloom, light shafts, the colour grade, lit windows, fires, the fighters' rim light,
// ink outlines, rain and lightning. Each match picks one (Random, or what the title menu says), and the final
// round pushes it further: golden hour sinks toward dusk, dusk into the blue hour, the storm
// gets worse, the night burns. Changes ease in over a few seconds, never cut.
import * as THREE from 'three';
import { G, URLP } from '../core/context.js';
import { SUN_DIR } from './renderer.js';
import { rimLight } from './toon.js';
import { chunkUniforms } from '../world/chunkMaterial.js';
import { smokeLight } from '../fx/smoke.js';
import { lerp, rand } from '../core/math.js';

const c = (hex, k = 1) => new THREE.Color(hex).multiplyScalar(k);
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const WHITE = new THREE.Color(1, 1, 1);

// Every preset sets every key. Sun: elevation / azimuth in degrees (the moon at night). fogNear /
// fogFar scale the map's own fog distances. shadowTint / highTint multiply the shadows and the
// highlights in the grade. final: what the final round blends toward, and how far.
const golden = {
  label: 'Golden hour', weight: 0.3,
  sunEl: 34, sunAz: -127, sunColor: c(0xffe6c4), sun: 2.7,
  hemiSky: c(0xa9cbff), hemiGround: c(0x8a6f5a), hemi: 1.35,
  skyTop: c(0x3d7fd6), skyHorizon: c(0xf6d7b0), fog: c(0xdfd2c2), fogNear: 1, fogFar: 1,
  disc: c(0xfffae6), discSize: 0.9993, glow: c(0xffd99a, 0.55),
  cover: 0.22, cloudLit: c(0xfff7ee), cloudShade: c(0xc4b6c6), cloudMesh: c(0xfff7f2), stars: 0,
  exposure: 1, bloom: 0.32, bloomThreshold: 0.92,
  sat: 1.12, contrast: 1.06, shadowTint: c(0xeef0ff), highTint: c(0xfffaf0), lift: 0,
  lights: 0, lightColor: c(0xffd08a), fire: 0.35,
  shafts: 0.5, shaftColor: c(0xffd9a0),
  smoke: c(0xffffff), rimColor: c(0xffe6c4), rim: 0.2,
  rain: 0, lightning: 0, ink: 0.8,
  final: { to: 'dusk', k: 0.6 },
};
const dusk = {
  label: 'Crimson dusk', weight: 0.25,
  sunEl: 8, sunAz: -105, sunColor: c(0xff8a4a), sun: 2.5,
  hemiSky: c(0x9a88c6), hemiGround: c(0x6a4840), hemi: 1.4,
  skyTop: c(0x2f3570), skyHorizon: c(0xff9458), fog: c(0xcf8f78), fogNear: 0.85, fogFar: 0.9,
  disc: c(0xffe0b0), discSize: 0.9988, glow: c(0xff7a3a, 0.9),
  cover: 0.38, cloudLit: c(0xffa978), cloudShade: c(0x5e4468), cloudMesh: c(0xffb59a), stars: 0.12,
  exposure: 1, bloom: 0.45, bloomThreshold: 0.84,
  sat: 1.16, contrast: 1.1, shadowTint: c(0xd8d2ff), highTint: c(0xfff0dc), lift: 0.02,
  lights: 0.25, lightColor: c(0xffc070), fire: 0.65,
  shafts: 0.95, shaftColor: c(0xff9a58),
  smoke: c(0xffd2b8, 0.92), rimColor: c(0xff9a5a), rim: 0.45,
  rain: 0, lightning: 0, ink: 0.8,
  final: { to: 'bluehour', k: 1 },
};
const storm = {
  label: 'Thunderstorm', weight: 0.22,
  sunEl: 32, sunAz: -60, sunColor: c(0xb8c4d8), sun: 0.9,
  hemiSky: c(0x8e9cb4), hemiGround: c(0x4a4a52), hemi: 1.65,
  skyTop: c(0x3a4252), skyHorizon: c(0x7a8392), fog: c(0x6e7684), fogNear: 0.45, fogFar: 0.55,
  disc: c(0xffffff), discSize: 1.01, glow: c(0x000000),
  cover: 0.97, cloudLit: c(0x8c94a3), cloudShade: c(0x3c4250), cloudMesh: c(0x6a707c), stars: 0,
  exposure: 0.95, bloom: 0.42, bloomThreshold: 0.86,
  sat: 0.8, contrast: 1.14, shadowTint: c(0xd6e2ff), highTint: c(0xf2f6ff), lift: 0.03,
  lights: 0.16, lightColor: c(0xffd08a), fire: 0.5,
  shafts: 0, shaftColor: c(0xffffff),
  smoke: c(0x9da4b0), rimColor: c(0xc8dcff), rim: 0.35,
  rain: 1, lightning: 1, ink: 0.7,
  final: { to: 'tempest', k: 1 },
};
const night = {
  label: 'Night', weight: 0.23,
  sunEl: 40, sunAz: -60, sunColor: c(0x9fb6ff), sun: 0.8,
  hemiSky: c(0x2c3c68), hemiGround: c(0x1c1a24), hemi: 1.0,
  skyTop: c(0x050a1c), skyHorizon: c(0x1e2c4c), fog: c(0x1c2644), fogNear: 0.7, fogFar: 0.85,
  disc: c(0xe8eeff), discSize: 0.99955, glow: c(0x6f86c8, 0.3),
  cover: 0.28, cloudLit: c(0x4c5a7a), cloudShade: c(0x141a2c), cloudMesh: c(0x3a4460), stars: 1,
  exposure: 1.05, bloom: 0.58, bloomThreshold: 0.66,
  sat: 1.05, contrast: 1.08, shadowTint: c(0xc6d4ff), highTint: c(0xfff0dc), lift: 0.035,
  lights: 0.4, lightColor: c(0xffc878), fire: 1,
  shafts: 0.18, shaftColor: c(0x8fa8ff),
  smoke: c(0x5c6a8c), rimColor: c(0x8fb0ff), rim: 0.6,
  rain: 0, lightning: 0, ink: 0.6, // (the night is dark already: lighter line work)
  final: { to: 'inferno', k: 1 },
};
export const WEATHERS = {
  golden, dusk, storm, night,
  // final-round variants (not picked on their own)
  bluehour: {
    ...dusk, hidden: true,
    sunEl: 3, sunColor: c(0xff9070), sun: 0.9, hemiSky: c(0x5c5c9c), hemi: 1.05,
    skyTop: c(0x161c46), skyHorizon: c(0xc4645a), fog: c(0x6a5274), discSize: 1.01, glow: c(0xff6a3a, 0.45),
    cloudLit: c(0xc87a6c), cloudShade: c(0x342c4e), cloudMesh: c(0xa47a8a), stars: 0.5,
    exposure: 1.05, bloom: 0.6, bloomThreshold: 0.7,
    lights: 0.45, fire: 0.9, shafts: 0, smoke: c(0x9a8aa4), rimColor: c(0xff9a70), rim: 0.5,
  },
  tempest: {
    ...storm, hidden: true,
    hemi: 1.45, skyTop: c(0x2a303c), fog: c(0x5a6270), fogNear: 0.35, fogFar: 0.42,
    cloudLit: c(0x6e7684), cloudShade: c(0x2a2e38), contrast: 1.18, sat: 0.72,
    rain: 1.5, lightning: 2.6,
  },
  inferno: { ...night, hidden: true, fire: 1.6, lights: 0.58, bloom: 0.8, smoke: c(0x7a6a78), fog: c(0x2c2238) },
};

// out = a..b at t (numbers lerp, colours lerp, the rest switches halfway)
function blend(out, a, b, t) {
  for (const k in a) {
    const x = a[k], y = k in b ? b[k] : x;
    if (x && x.isColor) (out[k] && out[k] !== x ? out[k] : (out[k] = new THREE.Color())).copy(x).lerp(y, t);
    else if (typeof x === 'number') out[k] = lerp(x, y, t);
    else out[k] = t < 0.5 ? x : y;
  }
  return out;
}

export class Weather {
  constructor({ scene, sun, hemi, sky, clouds, renderer, post, quality }) {
    Object.assign(this, { scene, sun, hemi, renderer, post });
    this.skyU = sky.material.uniforms;
    this.cloudMat = clouds.children[0].material;
    this.fogBase = { near: scene.fog.near, far: scene.fog.far }; // the map's (construct after it's loaded)
    this.pref = URLP.weather;  // 'random' or a preset; the title menu changes it
    this.name = null;
    this.finalOn = false;
    this.matches = 0;
    this.cur = {}; this.from = {}; this.to = null; this.k = 1; this.dur = 1;
    this.flash = 0; this.pulses = []; this.nextStrike = rand(3, 7);
    this.rain = new Rain(scene, quality);
    this.bolt = new Bolt(scene);
  }

  get label() { return WEATHERS[this.name].label; }

  // the preset to use: the menu's choice, or a weighted roll
  choose(pref = this.pref) {
    if (WEATHERS[pref] && !WEATHERS[pref].hidden) return pref;
    const all = Object.entries(WEATHERS).filter(([, w]) => !w.hidden);
    let r = Math.random() * all.reduce((s, [, w]) => s + w.weight, 0);
    for (const [k, w] of all) if ((r -= w.weight) <= 0) return k;
    return all[0][0];
  }

  set(name, fade = 0) {
    this.name = name;
    this.finalOn = false;
    this._target(fade);
  }

  // the final round: push this weather toward its final variant
  setFinal(on, fade = 6) {
    if (on === this.finalOn) return;
    this.finalOn = on;
    this._target(fade);
  }

  // A new match. On Random the sky changes (the city stays as wrecked as it was).
  newMatch() {
    if (this.matches++ > 0 && this.pref === 'random') this.set(this.choose(), 3);
    else this.setFinal(false, 2);
  }

  _target(fade) {
    const base = WEATHERS[this.name];
    const goal = this.finalOn && base.final ? blend({}, base, WEATHERS[base.final.to], base.final.k) : base;
    if (fade <= 0 || !this.cur.sunColor) {
      blend(this.cur, goal, goal, 0);
      this.to = null;
      this._apply();
      return;
    }
    blend(this.from, this.cur, this.cur, 0);
    this.to = goal; this.k = 0; this.dur = fade;
  }

  _apply() {
    const P = this.cur, el = P.sunEl * Math.PI / 180, az = P.sunAz * Math.PI / 180;
    SUN_DIR.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
    this.sun.color.copy(P.sunColor);
    this.hemi.color.copy(P.hemiSky);
    this.hemi.groundColor.copy(P.hemiGround);
    const f = this.scene.fog;
    f.color.copy(P.fog);
    f.near = this.fogBase.near * P.fogNear;
    f.far = this.fogBase.far * P.fogFar;
    this.scene.background.copy(P.fog);
    const s = this.skyU;
    s.uTop.value.copy(P.skyTop); s.uHorizon.value.copy(P.skyHorizon); s.uFog.value.copy(P.fog);
    s.uSunColor.value.copy(P.disc); s.uSunSize.value = P.discSize; s.uGlow.value.copy(P.glow);
    s.uCover.value = P.cover; s.uCloudLit.value.copy(P.cloudLit); s.uCloudShade.value.copy(P.cloudShade);
    s.uStars.value = P.stars;
    this.cloudMat.color.copy(P.cloudMesh);
    const post = this.post;
    if (post.bloom) { post.bloom.strength = P.bloom; post.bloom.threshold = P.bloomThreshold; }
    const u = post.u;
    u.uSat.value = P.sat; u.uContrast.value = P.contrast;
    u.uShadowTint.value.copy(P.shadowTint); u.uHighTint.value.copy(P.highTint); u.uLift.value = P.lift;
    post.shafts = P.shafts; post.shaftColor.copy(P.shaftColor);
    // ink outlines thin out where the fog takes over (render/post.js)
    post.scenePass.setInk(P.ink, f.far * 0.28, f.far * 0.72);
    chunkUniforms.uLights.value = P.lights; chunkUniforms.uLightColor.value.copy(P.lightColor); chunkUniforms.uFire.value = P.fire;
    smokeLight.uTint.value.copy(P.smoke);
    rimLight.uRimColor.value.copy(P.rimColor); rimLight.uRim.value = P.rim;
    this.rain.setColor(P.fog, P.hemi);
    this._light();
  }

  // the lights' strength, which lightning flashes
  _light() {
    const P = this.cur, f = this.flash;
    this.sun.intensity = P.sun;
    this.hemi.intensity = P.hemi + f * 1.1;
    this.renderer.toneMappingExposure = P.exposure + f * 0.12;
    this.skyU.uFlash.value = f * 0.3;
  }

  update(realDt, time) {
    if (this.to) {
      this.k = Math.min(1, this.k + realDt / this.dur);
      const e = this.k * this.k * (3 - 2 * this.k);
      blend(this.cur, this.from, this.to, e);
      if (this.k >= 1) this.to = null;
      this._apply();
    }
    chunkUniforms.uTime.value = time;
    this.skyU.uTime.value = time;
    const P = this.cur;
    // lightning: a strike every so often, flickering two or three times
    if (P.lightning > 0.01 && (this.nextStrike -= realDt) <= 0) {
      this.nextStrike = rand(5, 13) / P.lightning;
      this._strike();
    }
    const had = this.flash > 0.002;
    for (const p of this.pulses) if (!p.done && (p.t -= realDt) <= 0) { p.done = true; this.flash = Math.max(this.flash, p.k); this.bolt.show(p.k); }
    this.flash *= Math.exp(-realDt * 10);
    if (had || this.flash > 0.002) this._light();
    this.bolt.update(realDt);
    this.rain.update(time, G.camera.position, P.rain);
    G.audio && G.audio.rain(Math.min(1, P.rain));
  }

  // A bolt straight down onto this point (KAISER-OH's sword arriving), whatever the weather.
  strikeAt(p) {
    this.bolt.build(p.clone(), G.camera.position);
    this.pulses = [{ t: 0, k: 1 }, { t: 0.1, k: 0.7 }, { t: 0.22, k: 0.9 }];
  }

  // A bolt somewhere in front of the camera, 250-950 m out, into the skyline or the street.
  _strike() {
    const cam = G.camera;
    const fwd = cam.getWorldDirection(_v).setY(0).normalize();
    const a = rand(-1.1, 1.1), dist = rand(250, 950);
    const dx = fwd.x * Math.cos(a) - fwd.z * Math.sin(a), dz = fwd.x * Math.sin(a) + fwd.z * Math.cos(a);
    const ground = _w.set(cam.position.x + dx * dist, rand(0, 70), cam.position.z + dz * dist);
    this.bolt.build(ground, cam.position);
    this.pulses = [{ t: 0, k: 1 }, { t: rand(0.08, 0.14), k: 0.6 }];
    if (Math.random() < 0.6) this.pulses.push({ t: rand(0.2, 0.3), k: 0.8 });
    G.audio && G.audio.thunder(dist);
  }
}

// Rain: streaks in a box that follows the camera, animated entirely on the GPU.
class Rain {
  constructor(scene, quality) {
    const n = { high: 9000, medium: 5500, low: 2500 }[quality] || 5500;
    const base = new THREE.PlaneGeometry(1, 1);
    base.translate(0, 0.5, 0);
    const geo = new THREE.InstancedBufferGeometry();
    geo.setIndex(base.index);
    geo.setAttribute('position', base.attributes.position);
    geo.setAttribute('uv', base.attributes.uv);
    const seeds = new Float32Array(n * 4);
    for (let i = 0; i < seeds.length; i++) seeds[i] = Math.random();
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
    geo.instanceCount = n;
    this.u = {
      uTime: { value: 0 }, uCam: { value: new THREE.Vector3() }, uAmount: { value: 0 },
      uColor: { value: new THREE.Color(0.75, 0.8, 0.88) }, uWind: { value: new THREE.Vector2(5, 2) },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, this.u]),
      transparent: true, depthWrite: false, fog: true,
      vertexShader: /* glsl */`
        attribute vec4 aSeed;
        uniform float uTime, uAmount;
        uniform vec3 uCam;
        uniform vec2 uWind;
        varying float vA;
        varying vec2 vUv;
        #include <fog_pars_vertex>
        const vec3 BOX = vec3(90.0, 70.0, 90.0);
        void main() {
          vec3 vel = vec3(uWind.x, -(34.0 + aSeed.w * 16.0), uWind.y);
          vec3 o = uCam - BOX * 0.5;
          vec3 p = o + mod(aSeed.xyz * BOX + vel * uTime - o, BOX);
          vec3 dir = normalize(vel);
          vec3 side = normalize(cross(dir, uCam - p));
          vec3 wp = p + side * position.x * 0.05 + dir * position.y * (1.6 + aSeed.w * 1.4);
          float d = length(p - uCam);
          // heavier rain draws more of the drops
          vA = step(fract(aSeed.w * 7.31), uAmount * 0.66) * smoothstep(1.5, 5.0, d) * (1.0 - smoothstep(28.0, 44.0, d));
          vUv = uv;
          vec4 mvPosition = viewMatrix * vec4(wp, 1.0);
          gl_Position = vA > 0.0 ? projectionMatrix * mvPosition : vec4(2.0, 2.0, 2.0, 1.0);
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */`
        uniform vec3 uColor;
        varying float vA;
        varying vec2 vUv;
        #include <fog_pars_fragment>
        void main() {
          float a = vA * (1.0 - abs(vUv.x - 0.5) * 2.0) * smoothstep(0.0, 0.35, vUv.y) * 0.5;
          if (a < 0.01) discard;
          gl_FragColor = vec4(uColor, a);
          #include <fog_fragment>
        }`,
    });
    this.mat = mat;
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  // drops a little lighter than the air they fall through
  setColor(fog, light) {
    this.mat.uniforms.uColor.value.copy(fog).lerp(WHITE, 0.45).multiplyScalar(Math.min(1.2, 0.5 + light * 0.35));
  }

  update(time, cam, amount) {
    this.mesh.visible = amount > 0.01;
    if (!this.mesh.visible) return;
    const u = this.mat.uniforms;
    u.uTime.value = time % 1000;
    u.uCam.value.copy(cam);
    u.uAmount.value = amount;
  }
}

// A lightning bolt: a jagged ribbon from the cloud deck down to the city, with a few branches.
class Bolt {
  constructor(scene) {
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6 * 3 * 400), 3));
    this.mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.6, 2.8, 3.4), toneMapped: false, fog: false, transparent: true, depthWrite: false, side: THREE.DoubleSide });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.renderOrder = 5;
    scene.add(this.mesh);
    this.t = 0;
  }

  // midpoint displacement: each pass splits every segment and kicks its middle sideways
  static path(a, b, passes, rough) {
    let pts = [a, b];
    for (let i = 0; i < passes; i++) {
      const next = [pts[0]];
      for (let j = 0; j < pts.length - 1; j++) {
        const p = pts[j], q = pts[j + 1], len = p.distanceTo(q);
        const m = p.clone().lerp(q, 0.5);
        m.x += rand(-1, 1) * len * rough; m.z += rand(-1, 1) * len * rough; m.y += rand(-0.15, 0.15) * len;
        next.push(m, q);
      }
      pts = next;
    }
    return pts;
  }

  build(ground, eye) {
    const top = ground.clone().add(new THREE.Vector3(rand(-90, 90), rand(380, 470) - ground.y, rand(-90, 90)));
    const strands = [[Bolt.path(top, ground.clone(), 6, 0.2), 5]];
    for (let i = 0; i < 3; i++) {
      const from = strands[0][0][Math.floor(rand(8, 40))];
      const to = from.clone().add(new THREE.Vector3(rand(-120, 120), -rand(60, 160), rand(-120, 120)));
      strands.push([Bolt.path(from, to, 4, 0.25), 2.2]);
    }
    const pos = this.geo.attributes.position.array;
    let k = 0;
    const seg = new THREE.Vector3(), view = new THREE.Vector3(), side = new THREE.Vector3();
    for (const [pts, w] of strands) {
      for (let i = 0; i < pts.length - 1 && k < pos.length - 18; i++) {
        const p = pts[i], q = pts[i + 1];
        seg.subVectors(q, p);
        view.subVectors(eye, p);
        side.crossVectors(seg, view).normalize().multiplyScalar(w * (1 - i / pts.length * 0.6) * 0.5);
        for (const v of [[p, -1], [p, 1], [q, 1], [p, -1], [q, 1], [q, -1]]) {
          pos[k++] = v[0].x + side.x * v[1]; pos[k++] = v[0].y + side.y * v[1]; pos[k++] = v[0].z + side.z * v[1];
        }
      }
    }
    this.geo.setDrawRange(0, k / 3);
    this.geo.attributes.position.needsUpdate = true;
  }

  show(k) { this.t = 0.07; this.mesh.visible = true; this.mat.opacity = Math.min(1, 0.4 + k); }

  update(realDt) {
    if (!this.mesh.visible) return;
    if ((this.t -= realDt) <= 0) this.mesh.visible = false;
  }
}
