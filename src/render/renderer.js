// Renderer, scene, lights and sky. Visual style: bright cel-shaded comic city at golden hour.
import * as THREE from 'three';
import { toonMat } from './toon.js';
import { makeRng } from '../core/math.js';

export const PALETTE = {
  skyTop: new THREE.Color(0x3d7fd6),
  skyHorizon: new THREE.Color(0xf6d7b0),
  fog: new THREE.Color(0xdfd2c2),
  sun: new THREE.Color(0xfff1d6),
  hemiSky: new THREE.Color(0xa9cbff),
  hemiGround: new THREE.Color(0x8a6f5a),
};

export const SUN_DIR = new THREE.Vector3(-0.55, 0.62, -0.42).normalize();

export function createRenderer(canvasParent, quality) {
  const renderer = new THREE.WebGLRenderer({
    antialias: false, // MSAA happens on the composer target
    powerPreference: 'high-performance',
    stencil: false,
  });
  const pr = quality === 'low' ? 1 : Math.min(window.devicePixelRatio, quality === 'high' ? 2 : 1.5);
  renderer.setPixelRatio(pr);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = quality !== 'low';
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.0;
  canvasParent.appendChild(renderer.domElement);
  return renderer;
}

export function createScene(quality) {
  const scene = new THREE.Scene();
  scene.background = PALETTE.fog.clone();
  scene.fog = new THREE.Fog(PALETTE.fog, 220, 1100);

  const hemi = new THREE.HemisphereLight(PALETTE.hemiSky, PALETTE.hemiGround, 1.35);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(PALETTE.sun, 2.6);
  sun.position.copy(SUN_DIR).multiplyScalar(300);
  sun.castShadow = quality !== 'low';
  const size = quality === 'high' ? 4096 : 2048;
  sun.shadow.mapSize.set(size, size);
  const s = 230; // kaiju scale: both fighters and the blocks around them
  Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: 900 });
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.6;
  scene.add(sun);
  scene.add(sun.target);

  const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.3, 3000);
  camera.position.set(0, 40, 80);

  const sky = createSky();
  const clouds = createClouds();
  scene.add(sky);
  scene.add(clouds);
  return { scene, camera, sun, hemi, sky, clouds };
}

// Keeps the shadow frustum centered on the action so 4k texels cover the fight, not the whole map.
export function followShadow(sun, focus) {
  const snap = 4;
  const fx = Math.round(focus.x / snap) * snap;
  const fz = Math.round(focus.z / snap) * snap;
  sun.target.position.set(fx, 0, fz);
  sun.position.set(fx + SUN_DIR.x * 400, SUN_DIR.y * 400, fz + SUN_DIR.z * 400);
}

function createSky() {
  const geo = new THREE.SphereGeometry(2500, 32, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    // render/weather.js drives these (time of day, cloud cover, lightning)
    uniforms: {
      uTop: { value: PALETTE.skyTop.clone() },
      uHorizon: { value: PALETTE.skyHorizon.clone() },
      uFog: { value: PALETTE.fog.clone() },
      uSun: { value: SUN_DIR },
      uSunColor: { value: new THREE.Color(1.0, 0.98, 0.9) },
      uSunSize: { value: 0.9993 },   // cos of the disc's radius
      uGlow: { value: new THREE.Color(1.0, 0.85, 0.6).multiplyScalar(0.55) },
      uCover: { value: 0.2 },
      uCloudLit: { value: new THREE.Color(1, 0.97, 0.93) },
      uCloudShade: { value: new THREE.Color(0.78, 0.72, 0.78) },
      uStars: { value: 0 },
      uFlash: { value: 0 },
      uTime: { value: 0 },
    },
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uTop, uHorizon, uFog, uSun, uSunColor, uGlow, uCloudLit, uCloudShade;
      uniform float uSunSize, uCover, uStars, uFlash, uTime;
      varying vec3 vDir;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float vnoise(vec2 p) {
        vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
      }
      float fbm(vec2 p) {
        float s = 0.0, a = 0.5;
        for (int i = 0; i < 4; i++) { s += vnoise(p) * a; p = p * 2.03 + 17.1; a *= 0.5; }
        return s / 0.9375;
      }
      void main() {
        vec3 d = normalize(vDir);
        float h = d.y;
        // banded gradient - quantized a little for the comic look
        float t = clamp(h * 1.6, 0.0, 1.0);
        t = floor(t * 10.0) / 10.0 * 0.35 + t * 0.65;
        vec3 col = mix(uHorizon, uTop, pow(t, 0.75));
        col = mix(uFog, col, smoothstep(-0.05, 0.12, h));
        float sd = max(dot(d, uSun), 0.0);
        // a cloud deck, drifting: flat on a plane overhead, cel-lit from the sun's side
        float cov = 0.0;
        vec3 cloud = uCloudLit;
        if (uCover > 0.01 && h > -0.02) {
          vec2 cp = d.xz / (h + 0.14) * 1.4 + vec2(uTime * 0.012, uTime * 0.004);
          float n = fbm(cp);
          cov = smoothstep(1.0 - uCover - 0.06, 1.0 - uCover + 0.1, n) * smoothstep(-0.02, 0.16, h);
          float toward = fbm(cp + normalize(uSun.xz + vec2(1e-4)) * 0.22);
          float shade = step(0.5, clamp((toward - n) * 7.0 + 0.45, 0.0, 1.0));
          cloud = mix(uCloudLit, uCloudShade, shade * 0.85 + (1.0 - smoothstep(0.0, 0.5, cov)) * 0.15);
          cloud += uGlow * pow(sd, 6.0) * 1.2; // silver lining around the sun
          cloud = mix(cloud, uCloudShade * 0.7, (1.0 - smoothstep(0.08, 0.22, cov)) * step(0.02, cov) * 0.6); // inked edge
        }
        // stars, twinkling, behind the clouds
        vec3 sq = floor(d * 420.0);
        float sh = fract(sin(dot(sq, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
        col += vec3(0.9, 0.95, 1.0) * step(0.9978, sh) * uStars * smoothstep(0.04, 0.35, h) * (0.6 + 0.4 * sin(uTime * 3.0 + sh * 80.0));
        col += uGlow * pow(sd, 18.0);
        col = mix(col, uSunColor, step(uSunSize, sd));
        // halo ring around the sun, cel style
        col += uGlow * step(uSunSize - 0.0033, sd) * 0.45;
        col = mix(col, cloud, cov * 0.96);
        col += vec3(0.75, 0.82, 1.0) * uFlash * (0.35 + 0.9 * cov);
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const m = new THREE.Mesh(geo, mat);
  m.renderOrder = -10;
  m.frustumCulled = false;
  m.name = 'sky';
  return m;
}

// Puffy cel clouds: clusters of flattened spheres merged into one mesh.
function createClouds() {
  const rng = makeRng(99);
  const group = new THREE.Group();
  const mat = toonMat(0xffffff, { steps: 2, params: { fog: false } });
  mat.color.setRGB(1.0, 0.97, 0.95);
  const sphere = new THREE.IcosahedronGeometry(1, 2);
  const parts = [];
  for (let c = 0; c < 26; c++) {
    const ang = rng() * Math.PI * 2;
    const dist = 1200 + rng() * 700;
    const cx = Math.cos(ang) * dist, cz = Math.sin(ang) * dist;
    const cy = 220 + rng() * 380;
    const n = 5 + Math.floor(rng() * 6);
    const w = 60 + rng() * 90;
    for (let i = 0; i < n; i++) {
      const g = sphere.clone();
      const r = w * (0.35 + rng() * 0.4);
      g.scale(r, r * 0.55, r);
      g.translate(cx + (rng() - 0.5) * w * 2.2, cy + (rng() - 0.3) * r * 0.5, cz + (rng() - 0.5) * w * 0.9);
      parts.push(g);
    }
  }
  const merged = mergeGeoms(parts);
  const mesh = new THREE.Mesh(merged, mat);
  mesh.frustumCulled = false;
  group.add(mesh);
  return group;
}

export function mergeGeoms(geoms) {
  let vCount = 0, iCount = 0;
  for (const g of geoms) { vCount += g.attributes.position.count; iCount += g.index ? g.index.count : g.attributes.position.count; }
  const pos = new Float32Array(vCount * 3), nor = new Float32Array(vCount * 3);
  const hasColor = geoms.every((g) => g.attributes.color);
  const col = hasColor ? new Float32Array(vCount * 3) : null;
  const idx = new Uint32Array(iCount);
  let vo = 0, io = 0;
  for (const g of geoms) {
    const n = g.attributes.position.count;
    pos.set(g.attributes.position.array, vo * 3);
    if (g.attributes.normal) nor.set(g.attributes.normal.array, vo * 3);
    if (col) col.set(g.attributes.color.array, vo * 3);
    if (g.index) { for (let i = 0; i < g.index.count; i++) idx[io++] = g.index.array[i] + vo; }
    else { for (let i = 0; i < n; i++) idx[io++] = vo + i; }
    vo += n;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  if (col) out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  return out;
}
