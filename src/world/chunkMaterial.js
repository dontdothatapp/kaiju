// One material for every building chunk and every piece of debris.
// The facade (windows, mullions, brick, ink edges) is computed in the chunk's *parent* space,
// so when a chunk fractures into Voronoi pieces each piece still shows its slice of the window,
// and freshly cut faces show raw concrete. No pop when a static chunk turns into debris.
import * as THREE from 'three';
import { gradientMap } from '../render/toon.js';

export const STYLE = { GLASS: 0, OFFICE: 1, BRICK: 2, STRIP: 3, SLAB: 4, CONCRETE: 5 };

export const chunkUniforms = {
  uFocus: { value: new THREE.Vector3() },     // player position (see-through tunnel)
  uFocus2: { value: new THREE.Vector3() },    // opponent position
  uFadeDist: { value: 22.0 },
  uTime: { value: 0 },
  // render/weather.js: share of windows lit from inside (dusk, night), their colour, and how
  // much the blown-out windows around an impact burn
  uLights: { value: 0 },
  uLightColor: { value: new THREE.Color(1, 0.82, 0.54) },
  uFire: { value: 0.35 },
};

// Three variants of one shader, picked per mesh every frame (world/structures.js updateMaterials):
//   seeThrough: the camera dither and the two tunnels toward the fighters. They need `discard`,
//               which switches off early depth rejection for the whole draw, so only the few
//               buildings actually between the camera and a kaiju (and the debris) pay for it.
//   plain:      everything else nearby: the full facade, no discard.
//   far:        buildings a few hundred metres out: the facade without the crack, fire and
//               spiderweb detail that would be sub-pixel there anyway.
export function createChunkMaterial({ seeThrough = true, far = false } = {}) {
  const mat = new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap: gradientMap(3) });
  mat.defines = {};
  if (seeThrough) mat.defines.SEE_THROUGH = 1;
  if (far) mat.defines.FAR = 1;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, chunkUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', /* glsl */`
        #include <common>
        attribute vec4 aStyle;
        attribute vec4 aParent;
        attribute vec3 aOffset;
        attribute vec3 aCell;
        attribute vec4 aHit;
        varying vec3 vCell;
        varying vec4 vStyle;
        varying vec4 vParent;
        varying vec4 vHit;
        varying vec3 vPP;
        varying vec3 vPN;
        varying vec3 vWPos;
        varying float vUp;
      `)
      .replace('#include <begin_vertex>', /* glsl */`
        #include <begin_vertex>
        vec3 sc = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
        vPP = position * sc + aOffset;
        vPN = normalize(normal / max(sc, vec3(1e-4)));
        vStyle = aStyle;
        vParent = aParent;
        vCell = aCell;
        vHit = aHit;
        vWPos = (modelMatrix * instanceMatrix * vec4(position, 1.0)).xyz;
        // how much this face points at the sky (debris tumbles, so it's per instance)
        vUp = normalize(mat3(modelMatrix * instanceMatrix) * (normal / max(sc * sc, vec3(1e-6)))).y;
      `);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', /* glsl */`
        #include <common>
        uniform vec3 uFocus;
        uniform vec3 uFocus2;
        uniform float uFadeDist;
        uniform float uTime;
        uniform float uLights;
        uniform vec3 uLightColor;
        uniform float uFire;
        varying vec4 vStyle;
        varying vec4 vParent;
        varying vec3 vCell;
        varying vec4 vHit;
        varying vec3 vPP;
        varying vec3 vPN;
        varying vec3 vWPos;
        varying float vUp;
        float h31(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
        float vnoise(vec3 p) {
          vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(mix(h31(i), h31(i + vec3(1,0,0)), f.x), mix(h31(i + vec3(0,1,0)), h31(i + vec3(1,1,0)), f.x), f.y),
                     mix(mix(h31(i + vec3(0,0,1)), h31(i + vec3(1,0,1)), f.x), mix(h31(i + vec3(0,1,1)), h31(i + vec3(1,1,1)), f.x), f.y), f.z);
        }
        // Damage at q (parent space). A chunk remembers the impact that hurt it most (aHit: point in
        // parent space + radius), so soot, cracks and blown windows fall off around the hole instead
        // of filling whole chunks. Without one (collapse debris), the damage is uniform.
        float localDmg(vec3 q, float dmg, vec4 hit) {
          if (hit.w <= 0.0) return dmg;
          return dmg * (1.0 - smoothstep(0.3, 1.0, distance(q, hit.xyz) / hit.w));
        }
        float bayer4(vec2 p) {
          vec2 a = mod(floor(p), 4.0);
          float m[16] = float[16](0.,8.,2.,10.,12.,4.,14.,6.,3.,11.,1.,9.,15.,7.,13.,5.);
          return (m[int(a.y * 4.0 + a.x)] + 0.5) / 16.0;
        }
        float segDist(vec3 p, vec3 a, vec3 b, out float t) {
          vec3 ab = b - a; t = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-4), 0.0, 1.0);
          return length(p - (a + ab * t));
        }
        vec3 gGlassEmit = vec3(0.0);
      `)
      .replace('void main() {', /* glsl */`
        void main() {
          // --- camera see-through: dither out geometry hugging the camera or blocking the fighters ---
          #ifdef SEE_THROUGH
          {
            float th = bayer4(gl_FragCoord.xy);
            float cd = distance(vWPos, cameraPosition);
            if (cd < uFadeDist && cd / uFadeDist < th) discard;
            float t;
            float d = segDist(vWPos, cameraPosition, uFocus, t);
            // kaiju scale: a tunnel the width of a body from the camera to each fighter's chest
            if (t < 0.9 && d < 26.0 && (d / 26.0) < th * 0.9 + 0.05) discard;
            float d2 = segDist(vWPos, cameraPosition, uFocus2, t);
            if (t < 0.86 && d2 < 20.0 && (d2 / 20.0) < th * 0.9 + 0.05) discard;
          }
          #endif
      `)
      .replace('#include <color_fragment>', /* glsl */`
        #include <color_fragment>
        {
          vec3 P = vPP;
          vec3 S = vParent.xyz;
          vec3 hs = S * 0.5;
          vec3 an = abs(vPN);
          float style = vStyle.z;
          float dmg = vStyle.w;
          float seed = vParent.w;
          vec3 base = diffuseColor.rgb;
          bool onX = an.x > 0.8 && abs(abs(P.x) - hs.x) < 0.07;
          bool onY = an.y > 0.8 && abs(abs(P.y) - hs.y) < 0.07;
          bool onZ = an.z > 0.8 && abs(abs(P.z) - hs.z) < 0.07;
          float ink = 0.0;
          float mpp = max(length(fwidth(P)), 1e-4); // metres per pixel: thin cracks fade out, not shimmer
          float ld = dmg > 0.01 ? localDmg(P, dmg, vHit) : 0.0;
          #ifdef FAR
          float sn = 0.5;
          #else
          float sn = dmg > 0.01 ? vnoise(P * 0.9 + seed) * 0.6 + vnoise(P * 2.7 + seed) * 0.4 : 0.5;
          #endif
          if (!(onX || onY || onZ)) {
            // fresh fracture surface: raw concrete + rebar-ish speckle
            float n = h31(floor(P * 5.0) + seed);
            diffuseColor.rgb = mix(vec3(0.36, 0.34, 0.33), vec3(0.62, 0.59, 0.55), n);
            if (h31(floor(P * 11.0)) > 0.93) diffuseColor.rgb = vec3(0.22, 0.16, 0.13);
          } else if (onY || style > 3.5) {
            // slab tops/bottoms and plain concrete
            float n = h31(floor(P * 2.0) + seed);
            diffuseColor.rgb = base * (onY ? 0.8 : 0.95) * (0.93 + 0.07 * n);
            vec2 e2 = onY ? hs.xz - abs(P.xz) : (onX ? vec2(hs.z - abs(P.z), hs.y - abs(P.y)) : vec2(hs.x - abs(P.x), hs.y - abs(P.y)));
            ink = 1.0 - smoothstep(0.05, 0.09, min(e2.x, e2.y));
          } else {
            // window pattern repeats per original cell, so merged slabs look like their parts
            float cu = onX ? vCell.z : vCell.x;
            float cv = vCell.y;
            float pu = (onX ? P.z + hs.z : P.x + hs.x);
            float pv = P.y + hs.y;
            float cellIdU = floor(pu / cu + 1e-3);
            float cellIdV = floor(pv / cv + 1e-3);
            float u = pu - (cellIdU + 0.5) * cu;
            float v = pv - (cellIdV + 0.5) * cv;
            float hu = cu * 0.5;
            float hv = cv * 0.5;
            seed += cellIdU * 3.1 + cellIdV * 7.3;
            vec2 q = vec2(u / hu, v / hv);
            float ww = vStyle.x, wh = vStyle.y;
            // brick courses
            if (style > 1.5 && style < 2.5) {
              float row = floor((v + hv) * 4.0);
              float br = fract((u + hu) * 2.0 + row * 0.5);
              float mortar = step(0.92, fract((v + hv) * 4.0)) + step(0.94, br);
              diffuseColor.rgb = mix(base, base * 0.7, clamp(mortar, 0.0, 1.0) * 0.6);
            }
            float inWin = step(abs(q.x), ww) * step(abs(q.y - 0.1), wh) * step(1.6, cu);
            // pattern LOD: when a window cell covers only a few pixels, fade to its average
            float lod = clamp(max(fwidth(pu) / cu, fwidth(pv) / cv) * 7.0 - 0.6, 0.0, 1.0);
            if (inWin > 0.5) {
              // each window judges the damage at its own centre, with some jitter, so blown-out
              // panes thin out raggedly away from the hole and cracked glass rings them
              vec3 cc = onX ? vec3(P.x, (cellIdV + 0.5) * cv - hs.y, (cellIdU + 0.5) * cu - hs.z)
                            : vec3((cellIdU + 0.5) * cu - hs.x, (cellIdV + 0.5) * cv - hs.y, P.z);
              float wd = dmg > 0.01 ? localDmg(cc, dmg, vHit) + (h31(vec3(seed, 1.7, 3.3)) - 0.5) * 0.3 : 0.0;
              if (wd > 0.45) {
                // blown-out window: dark interior with jagged shards left at the frame
                float edge = min(ww - abs(q.x), wh - abs(q.y - 0.1));
                float shard = step(edge * 6.0, h31(floor(vec3(q * 9.0, seed))) * 0.6);
                diffuseColor.rgb = mix(vec3(0.05, 0.05, 0.07), vec3(0.55, 0.75, 0.85), shard);
                // the floors an impact tore open are burning: flames licking up from the sill
                #ifndef FAR
                float fire = uFire * step(0.001, vHit.w) * smoothstep(0.55, 0.85, wd) * step(h31(vec3(seed, 6.6, 1.2)), 0.6);
                if (fire > 0.0) {
                  // cel flames: a yellow core inside orange tongues, a red glow on the ceiling
                  float fl = 0.75 + 0.25 * sin(uTime * (6.0 + 5.0 * h31(vec3(seed, 1.0, 0.0))) + seed * 13.0);
                  float wob = sin(q.x * 9.0 + uTime * 7.0 + seed * 3.0) * 0.2 + sin(q.x * 17.0 - uTime * 11.0) * 0.1;
                  float tip = -0.6 + (1.0 + wob) * fl;
                  float outer = step(q.y, tip), inner = step(q.y, tip - 0.4);
                  vec3 fc = mix(vec3(1.0, 0.34, 0.05), vec3(1.0, 0.86, 0.38), inner);
                  float glow = (1.0 - outer) * smoothstep(tip + 0.7, tip, q.y) * 0.6;
                  float k = fire * (1.0 - shard);
                  diffuseColor.rgb = mix(diffuseColor.rgb, fc, clamp(k * outer, 0.0, 1.0)) + vec3(0.55, 0.1, 0.02) * glow * k;
                  gGlassEmit += (fc * outer * 1.4 + vec3(0.8, 0.18, 0.03) * glow) * k;
                }
                #endif
              } else {
                // comic glass: two-tone sky reflection + diagonal glint streaks
                vec3 deep = vec3(0.16, 0.32, 0.45);
                vec3 sky = vec3(0.55, 0.78, 0.92);
                float refl = smoothstep(-0.2, 0.6, q.y + (h31(vec3(seed)) - 0.5) * 0.6);
                vec3 g = mix(deep, sky, refl * 0.75);
                float streak = fract((vWPos.x + vWPos.z) * 0.02 + vWPos.y * 0.02);
                float glint = step(0.955, streak) * step(streak, 0.985) * step(style, 0.5);
                g = mix(g, vec3(0.95, 0.98, 1.0), glint * 0.85);
                if (style < 0.5) g = mix(g, base * 0.6 + deep * 0.4, 0.15);
                #ifndef FAR
                if (wd > 0.15) {
                  // cracked pane: milky glass and a spiderweb from a random point
                  vec2 c0 = vec2(h31(vec3(seed, 5.1, 0.0)), h31(vec3(seed, 0.0, 8.7))) - 0.5;
                  vec2 d2 = (q - c0 * 0.8) * vec2(hu, hv);
                  float rr = length(d2);
                  float ang = atan(d2.y, d2.x) / 6.2832 * 7.0 + h31(vec3(seed));
                  float da = abs(fract(ang) - 0.5) / 7.0 * 6.2832 * rr;
                  float web = max(step(da, 0.035) * step(rr, 1.4), step(abs(rr - 0.45), 0.03)) * clamp(0.05 / mpp - 0.5, 0.0, 1.0);
                  g = mix(g, vec3(0.78, 0.86, 0.9), 0.3);
                  glint *= 0.3;
                  ink = max(ink, web * 0.75);
                }
                #endif
                gGlassEmit = vec3(0.25, 0.32, 0.38) * glint + deep * 0.12;
                // after dark some rooms are lit (cracked panes have lost their power)
                if (h31(vec3(seed, 9.1, 4.4)) < uLights && wd < 0.15) {
                  vec3 lc = uLightColor * (0.7 + 0.6 * h31(vec3(seed, 2.2, 7.7)));
                  float blind = step(0.72, h31(vec3(seed, 3.3, 1.1))) * step(0.25, q.y);
                  g = mix(lc, lc * 0.4, blind);
                  gGlassEmit = lc * (0.75 - 0.45 * blind);
                }
                diffuseColor.rgb = g;
              }
              float fe = min(ww - abs(q.x), wh - abs(q.y - 0.1)) * min(hu, hv);
              ink = max(ink, 1.0 - smoothstep(0.03, 0.06, fe));
            }
            vec2 e2 = vec2(hu - abs(u), hv - abs(v));
            float edgeW = style < 0.5 ? 0.06 : 0.045;
            ink = max(ink, (1.0 - smoothstep(edgeW, edgeW + 0.04, min(e2.x, e2.y))) * (style > 1.5 && style < 2.5 ? 0.5 : 0.85));
            if (lod > 0.0) {
              float cover = clamp(ww * wh * step(1.6, cu), 0.0, 1.0);
              float blownFrac = smoothstep(0.3, 0.6, ld);
              vec3 avg = mix(base, mix(mix(vec3(0.3, 0.48, 0.6), uLightColor * 0.8, uLights), vec3(0.06), blownFrac), cover * 0.8) * 0.92;
              diffuseColor.rgb = mix(diffuseColor.rgb, avg, lod);
              // far away the lit rooms and the fires still glow, as an average over the facade
              vec3 farGlow = uLightColor * uLights * (1.0 - blownFrac) * 0.6 + vec3(1.0, 0.45, 0.1) * uFire * blownFrac * step(0.001, vHit.w) * 0.5;
              gGlassEmit = mix(gGlassEmit, farGlow * cover, lod);
              ink *= 1.0 - lod * 0.75;
            }
          }
          if (dmg > 0.01) {
            // soot in two comic bands, on smooth noise so it doesn't pixelate
            float sv = ld * (0.55 + 0.9 * sn);
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(dot(diffuseColor.rgb, vec3(0.3, 0.59, 0.11))), ld * 0.35);
            diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.58, 0.55, 0.52), smoothstep(0.38, 0.42, sv) * 0.8);
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.14, 0.12, 0.11), smoothstep(0.85, 0.89, sv) * 0.7);
            #ifndef FAR
            if (vHit.w > 0.0 && (onX || onY || onZ)) {
              // cracks radiating from the impact across the face, plus a ring around the crater
              vec3 rel = P - vHit.xyz;
              vec2 f2 = onX ? rel.zy : onZ ? rel.xy : rel.xz;
              float r = length(f2);
              float hk = h31(vHit.xyz * 1.31);
              float a = atan(f2.y, f2.x) / 6.2832 * 13.0 + hk * 7.0 + (vnoise(vec3(r * 0.7, hk * 9.0, 0.0)) - 0.5) * 0.9;
              float ray = mod(floor(a), 13.0);
              float len = vHit.w * (0.3 + 0.55 * h31(vec3(ray, hk, 2.0))) * dmg;
              float da = abs(fract(a) - 0.5) / 13.0 * 6.2832 * r;
              float w = mix(0.17, 0.05, clamp(r / max(len, 0.01), 0.0, 1.0));
              float crack = (1.0 - smoothstep(w, w + max(0.03, mpp), da)) * step(r, len) * step(0.6, r);
              float ringR = vHit.w * (0.2 + 0.06 * hk);
              float ring = 1.0 - smoothstep(0.05, 0.05 + max(0.04, mpp), abs(r - ringR + (vnoise(vec3(f2 * 0.5, hk)) - 0.5) * 0.8));
              ink = max(ink, max(crack, ring * step(0.5, dmg)) * 0.9 * clamp(0.1 / mpp - 0.3, 0.0, 1.0));
            } else if (vHit.w <= 0.0) {
              float crack = step(0.985 - dmg * 0.05, h31(floor(P * vec3(14.0, 3.0, 14.0)) + seed));
              ink = max(ink, crack * dmg);
            }
            #endif
            // dust settles on whatever faces up once things have been wrecked
            float dc = clamp((dmg - 0.2) * 1.3, 0.0, 0.7) * smoothstep(0.5, 0.85, vUp);
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.64, 0.6, 0.54) * (0.88 + 0.24 * sn), dc);
            ink *= 1.0 - dc * 0.6;
            gGlassEmit *= 1.0 - dc;
          }
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.06, 0.05, 0.08), ink * 0.85);
        }
      `)
      .replace('#include <emissivemap_fragment>', /* glsl */`
        #include <emissivemap_fragment>
        totalEmissiveRadiance += gGlassEmit;
      `);
  };
  mat.customProgramCacheKey = () => 'chunk-v4' + (seeThrough ? '-see' : '') + (far ? '-far' : '');
  return mat;
}

// The three variants, made once and shared by every city mesh and all the debris.
let _variants = null;
export function chunkMaterials() {
  if (!_variants) {
    _variants = {
      seeThrough: createChunkMaterial({ seeThrough: true }),
      plain: createChunkMaterial({ seeThrough: false }),
      far: createChunkMaterial({ seeThrough: false, far: true }),
    };
  }
  return _variants;
}

// Per-instance attribute bundle used by the static chunk mesh and every debris mesh.
export function addChunkAttributes(geometry, capacity) {
  const style = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
  const parent = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
  const offset = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
  style.setUsage(THREE.DynamicDrawUsage);
  parent.setUsage(THREE.DynamicDrawUsage);
  offset.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('aStyle', style);
  geometry.setAttribute('aParent', parent);
  geometry.setAttribute('aOffset', offset);
  const cell = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
  cell.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('aCell', cell);
  // impact that damaged the chunk: point in parent space + radius (0 = none)
  const hit = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
  hit.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('aHit', hit);
  return { style, parent, offset, cell, hit };
}
