// Cel-shaded smoke: instanced low-poly spheres with 3-band lighting and a noise dissolve.
// Two layers share one shader:
// - solid: hit puffs, fire, black smoke. Opaque + discard, so thousands of puffs need no sorting
//   (the anime/BotW smoke look, with inked rims).
// - dust: the big clouds from breaks and collapses. Same cel bands, but see-through, so a
//   collapse never turns the screen into a wall.
// Both keep the fight visible the way the buildings do (world/sightline.js): a billow that stands
// between the lens and a kaiju leaves the picture whole, and the ones at the edge of the view of
// him thin out. No hole is cut through the cloud: what clears has the cloud's own lumpy outline.
import * as THREE from 'three';
import { SUN_DIR } from '../render/renderer.js';
import { sightUniforms } from '../world/sightline.js';
import { uploadLive } from './particles.js';

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

export const SMOKE_KINDS = {
  dust: { lit: [0.8, 0.74, 0.64], shade: [0.43, 0.38, 0.39] },
  cloud: { lit: [0.78, 0.74, 0.67], shade: [0.41, 0.38, 0.4] }, // pulverized concrete, a touch greyer

  white: { lit: [1.0, 1.0, 1.0], shade: [0.72, 0.76, 0.86] },
  dark: { lit: [0.35, 0.33, 0.34], shade: [0.16, 0.15, 0.18] },
  hot: { lit: [1.0, 0.86, 0.5], shade: [0.95, 0.45, 0.2] },
  blue: { lit: [0.75, 0.9, 1.0], shade: [0.35, 0.55, 0.95] },
};

// the light the dust is seen in (render/weather.js): the billows carry their own colours, so at
// night or under a storm they'd glow without it
export const smokeLight = { uTint: { value: new THREE.Color(1, 1, 1) } };

// msaa: the scene is drawn multisampled (every quality but low). An opaque puff on its way out
// then goes as alpha to coverage, like a fading building: evenly, and without the speckled depth
// a dither leaves for the ink outlines to trace. Without MSAA (and without ink) it dithers.
function smokeMaterial(translucent, msaa) {
  return new THREE.ShaderMaterial({
    fog: true,
    transparent: translucent,
    depthWrite: !translucent,
    alphaToCoverage: !translucent && msaa,
    // The see-through layers leave how much still shows through them in the frame's alpha channel
    // (dst.a *= 1 - a): the ink outlines drawn afterwards (render/post.js) fade by it, so a
    // building's outline isn't drawn sharp on top of the cloud in front of it.
    ...(translucent ? {
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
      blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    } : {}),
    defines: translucent ? { TRANSLUCENT: 1 } : msaa ? { COVERAGE: 1 } : {},
    uniforms: {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      uSun: { value: SUN_DIR },
      ...sightUniforms,
      ...smokeLight,
    },
    vertexShader: /* glsl */`
      attribute vec4 iData; attribute vec3 iLit; attribute vec3 iShade;
      uniform vec4 uSightA; uniform vec4 uSightB; uniform vec2 uSightZ;
      varying vec3 vN; varying vec3 vLP; varying vec4 vData; varying vec3 vLit; varying vec3 vShade; varying float vCamD; varying vec3 vWP; varying float vVis;
      #include <common>
      #include <fog_pars_vertex>
      // How much of a billow may show, judged as a whole ball so all of it goes together: all of
      // one that doesn't reach into the oval round a kaiju on screen (s), or whose near side is as
      // deep as he is (zEnd: the puffs of a hit on him, the dust at his feet); none of one that
      // reaches well into the oval in front of him; and in between it thins.
      float sightVis(vec4 s, float zEnd, vec2 ndc, float depth, float rad) {
        if (zEnd <= 0.0) return 1.0;
        vec2 h = max(s.zw, vec2(1e-4));
        // metres its centre is outside the oval, at its own depth
        float off = (length((ndc - s.xy) / h) - 1.0) * depth * min(h.x / projectionMatrix[0][0], h.y / projectionMatrix[1][1]);
        float side = smoothstep(0.2 * rad, 1.05 * rad, off);
        float deep = smoothstep(zEnd - 4.0, zEnd, depth - rad);
        return 1.0 - (1.0 - side) * (1.0 - deep);
      }
      void main() {
        vData = iData; vLit = iLit; vShade = iShade;
        vLP = position + iData.y;
        vN = normalize(mat3(modelMatrix * instanceMatrix) * normal);
        // wobble the silhouette a bit so balls read as billows
        vec3 p = position * (1.0 + 0.12 * sin(position.x * 5.0 + iData.y * 3.0 + iData.x * 4.0));
        vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(p, 1.0);
        vCamD = -mvPosition.z;
        vWP = (modelMatrix * instanceMatrix * vec4(p, 1.0)).xyz;
        gl_Position = projectionMatrix * mvPosition;
        vec3 ctr = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        float rad = length(instanceMatrix[0].xyz);
        vec4 cc = projectionMatrix * viewMatrix * vec4(ctr, 1.0);
        vVis = 1.0;
        if (cc.w > 0.5) {
          vec2 ndc = cc.xy / cc.w;
          vVis = sightVis(uSightA, uSightZ.x, ndc, cc.w, rad) * sightVis(uSightB, uSightZ.y, ndc, cc.w, rad);
        }
        // a billow that swallows the camera is culled outright (no full-screen haze), and so is
        // one that is wholly out of the way of a kaiju
        if (distance(cameraPosition, ctr) < rad * 1.2 + 0.8 || vVis < 0.02) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uSun; uniform vec3 uTint;
      varying vec3 vN; varying vec3 vLP; varying vec4 vData; varying vec3 vLit; varying vec3 vShade; varying float vCamD; varying vec3 vWP; varying float vVis;
      #include <common>
      #include <fog_pars_fragment>
      float hash(vec3 p) { return fract(sin(dot(p, vec3(17.1, 113.3, 41.7))) * 43758.5453); }
      float vnoise(vec3 p) {
        vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
                   mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
      }
      float bayer4(vec2 p) {
        vec2 a = mod(floor(p), 4.0);
        float m[16] = float[16](0.,8.,2.,10.,12.,4.,14.,6.,3.,11.,1.,9.,15.,7.,13.,5.);
        return (m[int(a.y * 4.0 + a.x)] + 0.5) / 16.0;
      }
      void main() {
        float age = vData.x;
        float n = vnoise(vLP * 2.3) * 0.65 + vnoise(vLP * 5.1) * 0.35;
        float thr = age * age * 1.15 - 0.05;
        if (n < thr) discard;
        vec3 N = normalize(vN);
        float rim = 1.0 - abs(dot(N, normalize(cameraPosition - vWP)));
        // how much of this puff is allowed to cover the view: nothing in the lens's face, and
        // the whole billow's share of the view of a kaiju (vVis)
        #ifdef TRANSLUCENT
          float vis = smoothstep(3.0, 15.0, vCamD);
        #else
          float vis = smoothstep(1.5, 4.5, vCamD);
        #endif
        vis *= vVis;
        #ifdef TRANSLUCENT
          // thick at the heart, thinning to nothing at the outline: billows that melt into each
          // other (a hard-edged ball of even density reads as a bubble)
          float alpha = 0.58 * vis * min(1.0, age * 12.0) * (1.0 - smoothstep(0.38, 0.97, rim));
          if (alpha < 0.01) discard;
        #elif defined(COVERAGE)
          if (vis < 0.01) discard; // (the rest goes out through the pixel's samples: alpha to coverage)
        #else
          // no MSAA: opaque puffs clear out with a halftone dither
          if (vis < bayer4(gl_FragCoord.xy)) discard;
        #endif
        float l = dot(N, uSun) * 0.5 + 0.5;
        float band = l > 0.62 ? 1.0 : l > 0.38 ? 0.55 : 0.15;
        vec3 col = mix(vShade, vLit, band);
        // volume cues: darker undersides and an inked silhouette rim per billow
        col *= mix(0.72, 1.05, N.y * 0.5 + 0.5);
        // dust clouds: heavier, darker material hugs the ground
        if (vData.z > 0.5) col *= mix(0.62, 1.0, clamp(vWP.y / 35.0, 0.0, 1.0));
        #ifndef TRANSLUCENT
          col *= rim > 0.82 ? 0.62 : 1.0;
        #endif
        // dissolving edge gets a darker ink rim
        float edge = smoothstep(0.0, 0.07, n - thr);
        col *= mix(0.7, 1.0, edge);
        // dust takes the scene's light fully; hit puffs and fire, which glow, only half
        col *= vData.z > 0.5 ? uTint : mix(vec3(1.0), uTint, 0.5);
        #ifdef TRANSLUCENT
          gl_FragColor = vec4(col, alpha);
        #elif defined(COVERAGE)
          gl_FragColor = vec4(col, vis);
        #else
          gl_FragColor = vec4(col, 1.0);
        #endif
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
}

class SmokeLayer {
  constructor(scene, capacity, translucent, detail = 1, msaa = true) {
    this.cap = capacity;
    this.n = 0;
    const F = (k) => new Float32Array(capacity * k);
    this.pos = F(3); this.vel = F(3); this.s0 = F(1); this.s1 = F(1);
    this.age = F(1); this.life = F(1); this.drag = F(1); this.rise = F(1); this.seed = F(1); this.kind = new Uint8Array(capacity);

    // detail 2 (320 faces): a round outline. At 80 faces the straight edges of each ball showed
    // through the see-through layers as a lattice over a big cloud.
    const geo = new THREE.IcosahedronGeometry(1, detail);
    this.aData = new THREE.InstancedBufferAttribute(F(4), 4).setUsage(THREE.DynamicDrawUsage);
    this.aLit = new THREE.InstancedBufferAttribute(F(3), 3).setUsage(THREE.DynamicDrawUsage);
    this.aShade = new THREE.InstancedBufferAttribute(F(3), 3).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iData', this.aData);
    geo.setAttribute('iLit', this.aLit);
    geo.setAttribute('iShade', this.aShade);
    this.colDirty = false; // aLit / aShade only change on a spawn or a kill

    this.mesh = new THREE.InstancedMesh(geo, smokeMaterial(translucent, msaa), capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    if (translucent) this.mesh.renderOrder = 3;
    scene.add(this.mesh);
  }

  spawn(x, y, z, vx, vy, vz, size, grow, life, kind, drag, rise) {
    const i = this.n < this.cap ? this.n++ : this._oldest();
    this.pos.set([x, y, z], i * 3); this.vel.set([vx, vy, vz], i * 3);
    this.s0[i] = size * 0.35; this.s1[i] = size * grow;
    this.age[i] = 0; this.life[i] = life; this.drag[i] = drag; this.rise[i] = rise;
    this.seed[i] = Math.random() * 50;
    this.kind[i] = kind === 'dust' || kind === 'cloud' ? 1 : 0;
    const k = SMOKE_KINDS[kind] || SMOKE_KINDS.dust;
    const j = (Math.random() - 0.5) * 0.12;
    const dk = Math.random() < 0.18 ? 0.78 : 1;
    this.aLit.array.set([(k.lit[0] + j) * dk, (k.lit[1] + j) * dk, (k.lit[2] + j) * dk], i * 3);
    this.aShade.array.set([k.shade[0] * dk, k.shade[1] * dk, k.shade[2] * dk], i * 3);
    this.colDirty = true;
  }

  _oldest() {
    let best = 0, ba = -1;
    for (let i = 0; i < this.n; i += 7) { const a = this.age[i] / this.life[i]; if (a > ba) { ba = a; best = i; } }
    return best;
  }

  _kill(i) {
    const j = --this.n;
    if (i === j) return;
    this.colDirty = true;
    for (const arr of [this.pos, this.vel]) { arr[i * 3] = arr[j * 3]; arr[i * 3 + 1] = arr[j * 3 + 1]; arr[i * 3 + 2] = arr[j * 3 + 2]; }
    for (const arr of [this.aLit.array, this.aShade.array]) { arr[i * 3] = arr[j * 3]; arr[i * 3 + 1] = arr[j * 3 + 1]; arr[i * 3 + 2] = arr[j * 3 + 2]; }
    this.s0[i] = this.s0[j]; this.s1[i] = this.s1[j]; this.age[i] = this.age[j]; this.life[i] = this.life[j];
    this.drag[i] = this.drag[j]; this.rise[i] = this.rise[j]; this.seed[i] = this.seed[j]; this.kind[i] = this.kind[j];
  }

  update(dt) {
    for (let i = this.n - 1; i >= 0; i--) {
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) { this._kill(i); continue; }
    }
    const D = this.aData.array;
    for (let i = 0; i < this.n; i++) {
      const k = i * 3;
      const dr = Math.exp(-this.drag[i] * dt);
      this.vel[k] *= dr; this.vel[k + 1] = this.vel[k + 1] * dr + this.rise[i] * dt; this.vel[k + 2] *= dr;
      this.pos[k] += this.vel[k] * dt; this.pos[k + 1] += this.vel[k + 1] * dt; this.pos[k + 2] += this.vel[k + 2] * dt;
      const t = this.age[i] / this.life[i];
      const g = 1 - Math.pow(1 - Math.min(1, t * 1.6), 3);
      const s = this.s0[i] + (this.s1[i] - this.s0[i]) * g;
      _p.set(this.pos[k], this.pos[k + 1], this.pos[k + 2]);
      _s.set(s, s * 0.92, s);
      _m.compose(_p, _q, _s);
      this.mesh.setMatrixAt(i, _m);
      D[i * 4] = t; D[i * 4 + 1] = this.seed[i]; D[i * 4 + 2] = this.kind[i];
    }
    this.mesh.count = this.n;
    uploadLive(this.n, this.mesh.instanceMatrix, this.aData);
    if (this.colDirty) { uploadLive(this.n, this.aLit, this.aShade); this.colDirty = false; }
  }
}

export class SmokeSystem {
  constructor(scene, capacity, detail = 1, msaa = true) {
    this.solid = new SmokeLayer(scene, Math.floor(capacity * 0.35), false, detail, msaa);
    this.dust = new SmokeLayer(scene, Math.floor(capacity * 0.65), true, detail, msaa);
    // collapse clouds: a budget of their own, so a falling tower's cloud isn't thinned out by
    // the very dust it makes
    this.cloud = new SmokeLayer(scene, Math.floor(capacity * 0.2), true, detail, msaa);
  }

  get n() { return this.solid.n + this.dust.n + this.cloud.n; }
  get cap() { return this.solid.cap + this.dust.cap + this.cloud.cap; }
  // how full the dust budget is (spawners thin out as it fills)
  get load() { return this.dust.n / this.dust.cap; }

  // kind: key of SMOKE_KINDS; size: start radius; grow: end radius multiplier
  spawn(x, y, z, vx, vy, vz, size, grow, life, kind = 'dust', drag = 1.5, rise = 0.5) {
    const layer = kind === 'cloud' ? this.cloud : kind === 'dust' ? this.dust : this.solid;
    layer.spawn(x, y, z, vx, vy, vz, size, grow, life, kind, drag, rise);
  }

  update(dt) { this.solid.update(dt); this.dust.update(dt); this.cloud.update(dt); }
}
