// Post stack: Scene (4x MSAA; the light shafts ride on its resolve) -> Bloom -> FX pass, which
// tone-maps, converts to sRGB and then grades in display space (one full-screen pass fewer than a
// separate OutputPass). Only the scene pass multisamples: the later passes draw full-screen
// quads, where MSAA changes no pixel but costs a resolve per pass.
// Dynamic resolution: setScale() shrinks every buffer in the chain while the frame runs late
// (main.js drives it from the measured frame interval); the canvas keeps its CSS size.
// The FX pass is where most screen-space juice lives: chromatic aberration kicks, radial
// zoom blur toward the impact point, anime speed lines, 2-frame impact frames, flashes, and the
// weather's colour grade (render/weather.js).
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { clamp, damp } from '../core/math.js';
import { SUN_DIR, basePixelRatio } from './renderer.js';

const _sp = new THREE.Vector3();
const _cd = new THREE.Vector3();

// Crepuscular rays (GPU Gems 3, ch. 13): march from each pixel toward the sun on screen and gather
// open sky. The sky dome sits on the far plane, so the depth buffer says what's open: buildings,
// the skyline and the clouds cut the light into shafts.
const raysShader = (steps) => ({
  uniforms: {
    tDiffuse: { value: null },
    tDepth: { value: null },
    uSun: { value: new THREE.Vector2(0.5, 0.5) },
    uStrength: { value: 0 },
    uColor: { value: new THREE.Color(1, 0.85, 0.6) },
    uAspect: { value: 1 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    #define STEPS ${steps}
    uniform sampler2D tDiffuse, tDepth;
    uniform vec2 uSun;
    uniform float uStrength, uAspect;
    uniform vec3 uColor;
    varying vec2 vUv;
    void main() {
      vec4 base = texture2D(tDiffuse, vUv);
      if (uStrength < 0.001) { gl_FragColor = base; return; }
      vec2 delta = (vUv - uSun) * (0.9 / float(STEPS));
      // start each pixel's march a little off-grid so the steps don't band
      vec2 uv = vUv - delta * fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
      float decay = 1.0, acc = 0.0;
      for (int i = 0; i < STEPS; i++) {
        uv -= delta;
        float sky = step(0.999995, texture2D(tDepth, clamp(uv, 0.001, 0.999)).x);
        vec2 dd = (uv - uSun) * vec2(uAspect, 1.0);
        acc += sky * decay * exp(-dot(dd, dd) * 12.0);
        decay *= 0.96;
      }
      acc *= 1.1 / float(STEPS);
      gl_FragColor = vec4(base.rgb + uColor * acc * uStrength, base.a);
    }`,
});

// The resolved scene, texel for texel (texelFetch: no filtering, so the copy is exact).
const copyShader = () => ({
  uniforms: { tDiffuse: { value: null } },
  vertexShader: /* glsl */`
    void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    void main() { gl_FragColor = texelFetch(tDiffuse, ivec2(gl_FragCoord.xy), 0); }`,
});

// Draws the scene into its own 4x multisampled target (with a depth texture for the light shafts),
// then resolves it into the composer's single-sample buffer with one full-screen draw: a plain copy,
// or the light-shafts march when they're on (Post._aimRays picks). On low quality there is no MSAA
// and no shafts, so the scene goes straight into the composer's buffer.
class ScenePass extends Pass {
  constructor(scene, camera, w, h, raySteps) {
    super();
    this.scene = scene;
    this.camera = camera;
    this.raysOn = false;
    this.msaaRT = null;
    if (!raySteps) return;
    this.msaaRT = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: 4 });
    this.msaaRT.depthTexture = new THREE.DepthTexture(w, h);
    this.copyMat = new THREE.ShaderMaterial(copyShader());
    this.copyMat.uniforms.tDiffuse.value = this.msaaRT.texture;
    this.raysMat = new THREE.ShaderMaterial(raysShader(raySteps));
    this.raysMat.uniforms.tDiffuse.value = this.msaaRT.texture;
    this.raysMat.uniforms.tDepth.value = this.msaaRT.depthTexture;
    for (const m of [this.copyMat, this.raysMat]) { m.depthTest = false; m.depthWrite = false; }
    this.quad = new FullScreenQuad(this.copyMat);
  }

  setSize(w, h) { if (this.msaaRT) this.msaaRT.setSize(w, h); }

  render(renderer, writeBuffer) {
    const out = this.renderToScreen ? null : writeBuffer;
    // as RenderPass does it
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(this.msaaRT || out);
    renderer.clear(renderer.autoClearColor, renderer.autoClearDepth, renderer.autoClearStencil);
    renderer.render(this.scene, this.camera); // resolves msaaRT (colour and depth) at the end
    renderer.autoClear = autoClear;
    if (!this.msaaRT) return;
    this.quad.material = this.raysOn ? this.raysMat : this.copyMat;
    renderer.setRenderTarget(out);
    this.quad.render(renderer);
  }

  dispose() {
    if (!this.msaaRT) return;
    this.msaaRT.depthTexture.dispose();
    this.msaaRT.dispose();
    this.copyMat.dispose();
    this.raysMat.dispose();
    this.quad.dispose();
  }
}

const FXShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uAspect: { value: 1 },
    uCA: { value: 0 },
    uZoom: { value: 0 },
    uCenter: { value: new THREE.Vector2(0.5, 0.5) },
    uSpeed: { value: 0 },
    uImpact: { value: 0 },
    uImpactMode: { value: 0 },
    uFlash: { value: 0 },
    uFlashColor: { value: new THREE.Color(1, 1, 1) },
    uRed: { value: 0 },
    uVignette: { value: 0.32 },
    uLetterbox: { value: 0 },
    uSat: { value: 1.12 },
    uContrast: { value: 1.06 },
    uGrain: { value: 0.025 },
    uDesat: { value: 0 },
    // the weather's grade: shadows and highlights each pulled toward a tint, blacks lifted
    uShadowTint: { value: new THREE.Color(1, 1, 1) },
    uHighTint: { value: new THREE.Color(1, 1, 1) },
    uLift: { value: 0 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uTime, uAspect, uCA, uZoom, uSpeed, uImpact, uImpactMode, uFlash, uRed, uVignette, uLetterbox, uSat, uContrast, uGrain, uDesat, uLift;
    uniform vec2 uCenter;
    uniform vec3 uFlashColor, uShadowTint, uHighTint;
    varying vec2 vUv;
    float hash(float n) { return fract(sin(n) * 43758.5453); }
    float hash2(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    vec3 sampleCA(vec2 uv) {
      vec2 off = (uv - 0.5) * uCA * 0.025;
      return vec3(texture2D(tDiffuse, uv + off).r, texture2D(tDiffuse, uv).g, texture2D(tDiffuse, uv - off).b);
    }
    void main() {
      vec2 uv = vUv;
      vec3 col;
      vec2 dc = uv - uCenter;
      if (uZoom > 0.002) {
        col = vec3(0.0);
        float tot = 0.0;
        for (int i = 0; i < 10; i++) {
          float k = float(i) / 9.0;
          float w = 1.0 - k * 0.6;
          col += sampleCA(uCenter + dc * (1.0 - k * uZoom * 0.12)) * w;
          tot += w;
        }
        col /= tot;
      } else {
        col = sampleCA(uv);
      }
      // the scene is linear HDR up to here: tone map and go to display space (what OutputPass did)
      #ifdef TONE_MAPPING
      col = toneMapping(col);
      #endif
      col = linearToOutputTexel(vec4(col, 1.0)).rgb;
      float l = dot(col, vec3(0.299, 0.587, 0.114));
      col = mix(vec3(l), col, uSat * (1.0 - uDesat));
      col = (col - 0.5) * uContrast + 0.5;
      float gl = clamp(l, 0.0, 1.0);
      col *= mix(uShadowTint, uHighTint, smoothstep(0.12, 0.8, gl));
      col += uShadowTint * uLift * (1.0 - gl);

      // anime speed lines around the frame edge
      vec2 pc = (uv - 0.5) * vec2(uAspect, 1.0);
      float r = length(pc);
      float ang = atan(pc.y, pc.x);
      if (uSpeed > 0.01) {
        float bins = 150.0;
        float bin = floor((ang / 6.28318 + 0.5) * bins);
        float h = hash(bin * 1.7 + floor(uTime * 22.0) * 13.1);
        float inner = 0.32 + hash(bin + 3.0) * 0.25;
        float along = smoothstep(inner, inner + 0.25, r);
        float th = 1.0 - uSpeed * 0.35;
        float frac = fract((ang / 6.28318 + 0.5) * bins);
        float thin = smoothstep(0.0, 0.25, frac) * smoothstep(1.0, 0.75, frac);
        float line = step(th, h) * along * thin;
        col = mix(col, vec3(1.0), line * 0.75 * clamp(uSpeed * 1.5, 0.0, 1.0));
      }

      // impact frame: high-contrast silhouette (black/white/red) + burst lines
      if (uImpact > 0.5) {
        float t = step(0.5, l);
        vec3 a = uImpactMode < 0.5 ? mix(vec3(0.02, 0.0, 0.02), vec3(1.0, 0.97, 0.92), t)
                                     : mix(vec3(1.0, 0.98, 0.94), vec3(0.75, 0.02, 0.04), t);
        float bin = floor((atan(dc.y * uAspect, dc.x) / 6.28318 + 0.5) * 90.0);
        float burst = step(0.6, hash(bin * 3.3)) * smoothstep(0.08, 0.5, length(dc * vec2(uAspect, 1.0)));
        a = mix(a, uImpactMode < 0.5 ? vec3(1.0) : vec3(0.05), burst * 0.85);
        col = a;
      }

      col = mix(col, uFlashColor, clamp(uFlash, 0.0, 1.0));
      float v = smoothstep(0.45, 1.05, r);
      col = mix(col, vec3(0.55, 0.0, 0.02), v * uRed);
      col *= 1.0 - v * uVignette;
      float lb = uLetterbox * 0.12;
      if (uv.y < lb || uv.y > 1.0 - lb) col = vec3(0.0);
      col += (hash2(uv * 917.0 + fract(uTime) * 41.0) - 0.5) * uGrain;
      gl_FragColor = vec4(col, 1.0);
    }`,
};

export class Post {
  constructor(renderer, scene, camera, quality) {
    this.renderer = renderer;
    this.quality = quality;
    this.scale = 1; // dynamic resolution: fraction of the quality's base pixel ratio
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const low = quality === 'low';
    // single-sample: the scene pass keeps its own multisampled target. Only on low does the scene
    // draw straight into these, so only there do they need a depth buffer.
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, depthBuffer: low });
    this.camera = camera;
    this.composer = new EffectComposer(renderer, rt);
    this.scenePass = new ScenePass(scene, camera, size.x, size.y, low ? 0 : quality === 'high' ? 36 : 22);
    this.composer.addPass(this.scenePass);
    this.shafts = 0; // strength, set by the weather
    this.shaftColor = new THREE.Color(1, 0.85, 0.6);
    if (!low) {
      this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.32, 0.45, 0.92);
      this.composer.addPass(this.bloom);
    }
    this.fx = new ShaderPass(FXShader);
    this.fx.material.toneMapped = true; // the FX shader tone-maps the HDR scene itself (see above)
    this.composer.addPass(this.fx);
    this.u = this.fx.uniforms;

    // decaying channels
    this.ca = 0; this.zoom = 0; this.flash = 0; this.red = 0;
    this.impactFrames = 0; this.speed = 0; this.speedTarget = 0;
    this.letterbox = 0; this.letterboxTarget = 0;
    this.desat = 0; this.desatTarget = 0;
    this.onResize();
  }

  onResize() {
    const w = window.innerWidth, h = window.innerHeight;
    const pr = basePixelRatio(this.quality) * this.scale;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h);
    this.composer.setPixelRatio(pr); // also resizes every pass
    this.u.uAspect.value = w / h;
    if (this.scenePass.raysMat) this.scenePass.raysMat.uniforms.uAspect.value = w / h;
  }

  // Render at this fraction of the base resolution (0.5..1). The canvas keeps its CSS size, so
  // the browser upscales; the HUD is DOM and stays sharp.
  setScale(k) {
    k = clamp(Math.round(k * 20) / 20, 0.5, 1);
    if (k === this.scale) return;
    this.scale = k;
    this.onResize();
  }

  // Where the sun is on screen, and how strong its shafts are from this camera: off while it's
  // behind you, fading as it leaves the frame.
  _aimRays() {
    const pass = this.scenePass, m = pass.raysMat;
    if (!m) return;
    const cam = this.camera;
    const facing = cam.getWorldDirection(_cd).dot(SUN_DIR);
    _sp.copy(SUN_DIR).multiplyScalar(2000).add(cam.position).project(cam);
    const off = Math.max(Math.abs(_sp.x), Math.abs(_sp.y));
    const k = this.shafts * clamp(facing / 0.3, 0, 1) * clamp((1.8 - off) / 0.8, 0, 1);
    pass.raysOn = k > 0.002; // off: the scene pass resolves with a plain copy
    if (!pass.raysOn) return;
    const u = m.uniforms;
    u.uStrength.value = k;
    u.uSun.value.set(_sp.x * 0.5 + 0.5, _sp.y * 0.5 + 0.5);
    u.uColor.value.copy(this.shaftColor);
  }

  kickCA(v) { this.ca = Math.max(this.ca, v); }
  zoomBlur(screenUV, v) { this.zoom = Math.max(this.zoom, v); if (screenUV) this.u.uCenter.value.copy(screenUV); }
  flashScreen(v, color = 0xffffff) { this.flash = Math.max(this.flash, v); this.u.uFlashColor.value.set(color); }
  hurt(v) { this.red = Math.max(this.red, v); }
  impactFrame(frames = 2, mode = 0) { this.impactFrames = Math.max(this.impactFrames, frames); this.u.uImpactMode.value = mode; }

  // decay of all screen-space channels; runs in the simulation step (real time)
  update(realDt, time) {
    const u = this.u;
    u.uTime.value = time;
    this.ca = damp(this.ca, 0, 6, realDt);
    this.zoom = damp(this.zoom, 0, 7, realDt);
    this.flash = damp(this.flash, 0, 14, realDt);
    this.red = damp(this.red, 0, 3, realDt);
    this.speed = damp(this.speed, this.speedTarget, 8, realDt);
    this.letterbox = damp(this.letterbox, this.letterboxTarget, 5, realDt);
    this.desat = damp(this.desat, this.desatTarget, 4, realDt);
    u.uCA.value = 0.08 + this.ca;
    u.uZoom.value = this.zoom;
    u.uFlash.value = this.flash;
    u.uRed.value = this.red;
    u.uSpeed.value = clamp(this.speed, 0, 1);
    u.uLetterbox.value = this.letterbox;
    u.uDesat.value = this.desat;
    u.uImpact.value = this.impactFrames > 0 ? 1 : 0;
    if (this.impactFrames > 0) this.impactFrames--;
  }

  render(realDt) {
    this._aimRays();
    this.composer.render(realDt);
  }
}
