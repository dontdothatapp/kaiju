// One material for every building chunk and every piece of debris.
// The facade (windows, mullions, brick, ink edges) is computed in the chunk's *parent* space,
// so when a chunk fractures into Voronoi pieces each piece still shows its slice of the window,
// and freshly cut faces show raw concrete. No pop when a static chunk turns into debris.
import * as THREE from 'three';
import { gradientMap } from '../render/toon.js';

export const STYLE = { GLASS: 0, OFFICE: 1, BRICK: 2, STRIP: 3, SLAB: 4, CONCRETE: 5 };
const CUT_RIM = 0.005; // the cutaway's ink rim, in half screen heights (~2.5 px at 1080p)

export const chunkUniforms = {
  uFocus: { value: new THREE.Vector3() },     // player's chest (the smoke's tunnel, fx/smoke.js)
  uFocus2: { value: new THREE.Vector3() },    // opponent's chest
  uFadeDist: { value: 22.0 },                 // nothing of the city is drawn this close to the lens
  // the cutaways (updateCutaway below): a pill on screen round each fighter, centre and half size
  // (x scaled by the aspect), and how deep it cuts (view depth, m)
  uCutA: { value: new THREE.Vector4(1e4, 1e4, 0, 0) },
  uCutB: { value: new THREE.Vector4(1e4, 1e4, 0, 0) },
  uCutZ: { value: new THREE.Vector2() },
  uCutAspect: { value: 1 },
  uTime: { value: 0 },
  // render/weather.js: share of windows lit from inside (dusk, night), their colour, and how
  // much the blown-out windows around an impact burn
  uLights: { value: 0 },
  uLightColor: { value: new THREE.Color(1, 0.82, 0.54) },
  uFire: { value: 0.35 },
};

// Three variants of one shader, picked per mesh every frame (world/structures.js updateMaterials):
//   seeThrough: the cut round the lens and the cutaways toward the fighters. They need `discard`,
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
        #ifdef SEE_THROUGH
        varying vec4 vCutClip;
        #endif
      `)
      .replace('#include <project_vertex>', /* glsl */`
        #include <project_vertex>
        #ifdef SEE_THROUGH
        vCutClip = gl_Position;
        #endif
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
        uniform float uFadeDist;
        uniform vec4 uCutA;
        uniform vec4 uCutB;
        uniform vec2 uCutZ;
        uniform float uCutAspect;
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
        #ifdef SEE_THROUGH
        varying vec4 vCutClip;
        // signed distance to a cutaway pill (c: centre, half size), < 0 inside
        float cutSd(vec2 s, vec4 c) {
          float r = min(c.z, c.w);
          vec2 q = abs(s - c.xy) - c.zw + r;
          return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
        }
        // how far a fragment the cutaway (c, cut to depth zc) leaves standing is from its edge, on
        // screen: outside the pill in front of him, or inside it just behind the depth it cuts to
        // (px, pz: a pixel's worth of screen and of depth here). < 0: cut.
        float cutEdge(vec2 s, float z, vec4 c, float zc, float px, float pz) {
          float sd = cutSd(s, c);
          return z < zc ? sd : sd < 0.0 ? (z - zc) / pz * px : 1.0;
        }
        #endif
        vec3 gGlassEmit = vec3(0.0);
        float gCutRim = 0.0;
      `)
      .replace('void main() {', /* glsl */`
        void main() {
          // --- the camera's cuts: nothing in the lens's face, and a clean hole in whatever stands
          // in front of a fighter, rimmed in ink ---
          #ifdef SEE_THROUGH
          {
            // screen position (x scaled by the aspect, so the pill's ends are round), view depth,
            // and a pixel's worth of each
            vec2 s = vCutClip.xy / vCutClip.w * vec2(uCutAspect, 1.0);
            float z = vCutClip.w;
            float px = max(fwidth(s.y), 1e-6), pz = max(fwidth(z), 1e-6);
            if (distance(vWPos, cameraPosition) < uFadeDist) discard;
            // only what is nearer the lens than the fighter (his chest's depth, his bulk behind it)
            float e = min(cutEdge(s, z, uCutA, uCutZ.x, px, pz), cutEdge(s, z, uCutB, uCutZ.y, px, pz));
            if (e < 0.0) discard;
            gCutRim = 1.0 - smoothstep(${CUT_RIM}, ${CUT_RIM} + px, e);
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
          // grounding: the foot of every building (and the rubble in the street) sits in the
          // street's shade, cooler and darker, fading out a few storeys up
          diffuseColor.rgb *= mix(vec3(0.72, 0.75, 0.86), vec3(1.0), smoothstep(-2.0, 17.0, vWPos.y));
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.06, 0.05, 0.08), ink * 0.85);
          // the cutaway's edge, inked like the facade's own lines so it reads as drawn
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.06, 0.05, 0.08), gCutRim * 0.9);
        }
      `)
      .replace('#include <emissivemap_fragment>', /* glsl */`
        #include <emissivemap_fragment>
        totalEmissiveRadiance += gGlassEmit * (1.0 - gCutRim);
      `);
  };
  mat.customProgramCacheKey = () => 'chunk-v6' + (seeThrough ? '-see' : '') + (far ? '-far' : '');
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

// ---------- the cutaways ----------
// Where a building stands between the camera and a kaiju, the part of it nearer the lens than he
// is isn't drawn: a pill on screen round his outline (his joints, padded by his bulk), rimmed in
// ink so it reads as a cutaway, not a glitch. It's measured every frame through the camera's own
// matrices (the portrait view offset included), and kept in metres at his depth, so a cut or a
// zoom doesn't read as him changing size. It opens over a fifth of a second when a building first
// gets in the way (world/structures.js updateMaterials says so) and closes once none does.
// The first three joints set how deep it cuts: an arm swung back mustn't bite the tower behind him.
const CUT_JOINTS = ['chest', 'pelvis', 'head', 'handL', 'handR', 'ftL', 'ftR', 'tail5'];
const CUT_PAD = 1.3;    // padding round each joint, in body radii
const CUT_OPEN = 0.2;   // seconds to open or close
// for updateMaterials: the volume each cutaway can reach (null: none), and whether a building is in it
export const cutaway = { frusta: [null, null], blocked: [false, false] };
const _holes = [0, 1].map(() => ({ k: 0, o: [0, 0, 0, 0], back: 0, cx: 0, cy: 0, dc: 0, fr: new THREE.Frustum() }));
const _vp = new THREE.Matrix4(), _jw = new THREE.Vector3(), _jc = new THREE.Vector3(), _jq = new THREE.Vector3();
const _raw = [0, 0, 0, 0];

// fighters: [player, opponent] (or null: no cutaways). reach: no cutaway for a fighter further out
// than this (free roam, where the beaten one lies somewhere across the city).
export function updateCutaway(camera, fighters, dt, reach = Infinity) {
  camera.updateMatrixWorld();
  const m = _vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).elements;
  const P = camera.projectionMatrix.elements, aspect = P[5] / P[0], U = chunkUniforms;
  U.uCutAspect.value = aspect;
  for (let i = 0; i < 2; i++) {
    const h = _holes[i], f = fighters && fighters[i], u = (i ? U.uCutB : U.uCutA).value;
    if (!f || !f.model.root.visible || !measureCut(h, f, m, aspect, P[5], dt)) {
      h.k = 0; h.o.fill(0); h.back = 0;
      u.set(1e4, 1e4, 0, 0);
      cutaway.frusta[i] = null; cutaway.blocked[i] = false;
      continue;
    }
    const near = h.dc < reach;
    h.k = Math.min(1, Math.max(0, h.k + (near && cutaway.blocked[i] ? dt : -dt) / CUT_OPEN));
    const s = P[5] / h.dc, o = h.o, e = h.k * h.k * (3 - 2 * h.k);
    const hx = (o[0] + o[1]) * 0.5 * s, hy = (o[2] + o[3]) * 0.5 * s;
    const cx = h.cx + (o[1] - o[0]) * 0.5 * s, cy = h.cy + (o[3] - o[2]) * 0.5 * s;
    if (e > 0) u.set(cx, cy, hx * e, hy * e); else u.set(1e4, 1e4, 0, 0);
    const z = h.dc + h.back;
    U.uCutZ.value.setComponent(i, z);
    // what it would cut fully open, rim included
    const rx = hx + CUT_RIM + 0.01, ry = hy + CUT_RIM + 0.01;
    cutaway.frusta[i] = near || e > 0 ? subFrustum(h.fr, m, (cx - rx) / aspect, (cx + rx) / aspect, cy - ry, cy + ry, z) : null;
  }
}

// Fighter f on screen: his chest, and the pill round his joints as offsets from it in metres at the
// chest's depth. A limb flung out widens it at once; it settles back in calmly. False: behind the lens.
function measureCut(h, f, m, aspect, p5, dt) {
  const J = f.model.J, c = toScreen(m, J.chest.getWorldPosition(_jw), aspect, _jc);
  if (c.z < 2) return false;
  const pad = f.R * CUT_PAD;
  let x0 = c.x, x1 = c.x, y0 = c.y, y1 = c.y, back = 0;
  for (let n = 0; n < CUT_JOINTS.length; n++) {
    const q = toScreen(m, J[CUT_JOINTS[n]].getWorldPosition(_jw), aspect, _jq);
    if (q.z < 1) continue;
    const r = pad * p5 / q.z;
    x0 = Math.min(x0, q.x - r); x1 = Math.max(x1, q.x + r);
    y0 = Math.min(y0, q.y - r); y1 = Math.max(y1, q.y + r);
    if (n < 3) back = Math.max(back, q.z - c.z);
  }
  const mm = c.z / p5, k = 1 - Math.exp(-4 * dt);
  _raw[0] = (c.x - x0) * mm; _raw[1] = (x1 - c.x) * mm; _raw[2] = (c.y - y0) * mm; _raw[3] = (y1 - c.y) * mm;
  for (let n = 0; n < 4; n++) h.o[n] = Math.max(_raw[n], h.o[n] + (_raw[n] - h.o[n]) * k);
  back += f.R * 0.25;
  h.back = Math.max(back, h.back + (back - h.back) * k);
  h.cx = c.x; h.cy = c.y; h.dc = c.z;
  return true;
}

// a world point through view-projection m: x, y on screen (x scaled by the aspect), z its view depth
function toScreen(m, p, aspect, out) {
  const w = m[3] * p.x + m[7] * p.y + m[11] * p.z + m[15];
  return out.set((m[0] * p.x + m[4] * p.y + m[8] * p.z + m[12]) / w * aspect, (m[1] * p.x + m[5] * p.y + m[9] * p.z + m[13]) / w, w);
}

// The part of the view through the screen rectangle x0..x1, y0..y1 (NDC) nearer than depth z.
function subFrustum(fr, m, x0, x1, y0, y1, z) {
  const P = fr.planes;
  clipPlane(P[0], m, 1, 0, -x0, 0);
  clipPlane(P[1], m, -1, 0, x1, 0);
  clipPlane(P[2], m, 0, 1, -y0, 0);
  clipPlane(P[3], m, 0, -1, y1, 0);
  clipPlane(P[4], m, 0, 0, 1, -0.1);
  clipPlane(P[5], m, 0, 0, -1, z);
  return fr;
}
// the clip-space half-space a*x + b*y + c*w + d >= 0 as a world plane (w is the view depth)
function clipPlane(pl, m, a, b, c, d) {
  pl.setComponents(a * m[0] + b * m[1] + c * m[3], a * m[4] + b * m[5] + c * m[7], a * m[8] + b * m[9] + c * m[11], a * m[12] + b * m[13] + c * m[15] + d);
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
