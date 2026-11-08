# Tech optimization backlog

_Measured on Bloodline, the superhero game MEGATON was forked from. The engine (city, destruction,
debris, weather, post FX) is unchanged; the fighters are bigger and wade through buildings, so
expect more chunks and debris bodies per second than these numbers assume._

Gameplay, feel and presentation items live in [BACKLOG.md](BACKLOG.md); this file is performance only.

Measured on 2026-10-30 on an Apple M1 (Chrome, ANGLE Metal), quality `high`, Flatiron map,
viewport 1280×720 at device pixel ratio 2 (2560×1440 drawing buffer), `?fight&diff=training`.
Items 1–3 are done (combined result: GPU frame ~40 → 19 ms at 2560×1440, worst collapse frame
~60 → 7 ms; "Done" notes under each). Every item below keeps the picture and the feel identical unless its "Visual risk" line says
otherwise. Items are sorted by priority: expected gain × how often it hurts, then effort.

How the numbers were taken is at the bottom ([Measuring](#measuring)); re-run those snippets
before and after each change.

## Baseline

| What | Number |
|---|---|
| City | 164 structures, 40,849 chunks in one `InstancedMesh` (490k tris), skyline 8,364 instances (100k tris), ground 157k tris |
| Frame, GPU (2560×1440) | **40–42 ms** idle fight and during a collapse (resolution-independent, see item 1) |
| Same frame with MSAA only on the scene pass | 20–25 ms |
| Same frame with no MSAA at all | 14 ms |
| Draw calls / triangles | 179 calls, 1.51M tris; 121 calls, 0.87M tris without the shadow pass |
| Sim CPU, idle fight | p50 0.3 ms, p90 0.6 ms |
| Sim CPU, after a charged punch (56 bodies) | p50 1.6 ms, p90 2.5 ms, max 18 ms |
| Sim CPU, 30-storey collapse (420 bodies, 1,400 smoke, 5,000 pebbles) | p50 3.9 ms, p90 5.1 ms, **worst frames 53–68 ms** (item 2) |
| First hit on a 1,985-chunk building | 13.3 ms collider creation + 12.6 ms in the next physics step (item 5) |
| GPU buffer uploads per frame | 1.6 MB idle (nothing on screen), 5.9 MB after a punch, 9.2 MB during a collapse (item 3) |
| Ground texture flush | 16 MB re-upload, +10 ms on that frame (item 8) |
| JS heap | 89 MB → 113 MB after a collapse; recorder 6.4 MB for one collapse (23.5k events) |
| Decoded audio in RAM | ~170 MB (music 79 MB, effects 45 MB, ambience ~45 MB) (item 12) |
| First rendered frame | ~270 ms (36 shader programs compile) (item 13) |

---

## 1. Multisample only the scene pass, not every post pass

**Gain:** GPU frame 40 → ~22 ms at 1440p on the M1 (the same 2× at 720p: the cost is a fixed
stall per multisampled pass, not fill rate). Also ~180 MB less GPU memory.
**Effort:** medium (one file). **Visual risk:** none. The post passes draw full-screen quads;
multisampling them has no effect on the pixels. The scene keeps its 4× MSAA.

**Evidence.** `src/render/post.js:162-186` builds the `EffectComposer` on a `WebGLRenderTarget`
with `samples: 4` and a `depthTexture`. The composer clones that target, so *every* pass
(light shafts, bloom composite, `OutputPass`, the FX pass) renders into a 4× multisampled
half-float target and three.js resolves it (`blitFramebuffer`, colour and depth) before the next
pass can sample it. Measured per-frame GPU throughput (see [Measuring](#measuring)):
MSAA on all passes 41.8 ms; MSAA on the scene pass only 24.7 ms; no MSAA 14.5 ms; at pixel ratio 1
the MSAA-everywhere frame is still 40 ms.

**Do this.**
1. Create the composer on a *non*-multisampled half-float target (`samples: 0`, no depth texture).
2. Replace `RenderPass` with a custom `ScenePass extends Pass` (import `Pass`, `FullScreenQuad`
   from `three/addons/postprocessing/Pass.js`) that owns `this.msaaRT = new WebGLRenderTarget(w, h,
   { type: HalfFloatType, samples: 4 })` with `msaaRT.depthTexture = new DepthTexture(w, h)`.
   Its `render(renderer, writeBuffer)`: `renderer.setRenderTarget(this.msaaRT); renderer.render(scene,
   camera)`, then draw a full-screen quad into `writeBuffer` that samples `this.msaaRT.texture`
   (this one sample is the only resolve left). `needsSwap = true`. `setSize(w, h)` resizes `msaaRT`
   (the composer passes device-pixel sizes to `pass.setSize`).
3. Fold the light-shafts shader into that quad: when shafts are on, the quad's material is the rays
   shader with `tDiffuse = msaaRT.texture`, `tDepth = msaaRT.depthTexture`; when they are off, a plain
   copy. That removes the separate rays `ShaderPass` and its resolve. `_aimRays`
   (`post.js:206-222`) then sets uniforms on the scene pass instead of `composer.readBuffer.depthTexture`.
4. On `quality === 'low'` (`samples` already 0) render the scene straight into `writeBuffer` and skip
   the copy.
5. Keep `UnrealBloomPass` as is (it renders into `readBuffer` with `needsSwap = false`), then
   `OutputPass`, then the FX pass (or the merged pass from item 4).

**Verify.** `composer.renderTarget1.samples === 0` and `composer.renderTarget1.depthTexture === null`;
the GPU throughput snippet drops from ~40 to ~22 ms; `tools/shot.mjs` screenshots before/after are
pixel-identical apart from noise/grain (compare with `?weather=golden&seed=1337`).

**Done** (`ScenePass` in `src/render/post.js`). Measured at 2560×1440, quality `high`, old and new
pipeline built side by side in one page (same scene state): shafts on 42.5 → 21.9 ms, shafts off
37.8 → 21.7 ms. Frames identical: shafts on bit-exact; shafts off differs by 1/255 in ≤0.02% of
values (the old bloom blended into the multisampled buffer before its resolve, so edge pixels
rounded differently in half float). Same on `medium`; `low` bit-exact. The composer targets have
no depth buffer now except on `low`, where the scene draws straight into them.

## 2. Collapse hitch: `DebrisSystem._makeRoom` is called 50+ times per frame and sorts every body each time

**Gain:** the two 53–68 ms frames at the start of every big collapse become ~8–10 ms (physics +
release work). This is the most visible stutter in the game and it lands on the climax moment.
**Effort:** small–medium. **Visual risk:** none (same bodies freeze, same order).

**Evidence.** Worst collapse frame, instrumented: `_releaseGroup` ×70 = 61 ms, of which
`spawnBox` ×70 = 58 ms, of which `_makeRoom` ×54 = 57 ms; 247 array sorts during one collapse.
`src/physics/debris.js:213-241`: when the body budget is full, every `spawnBox`
(`debris.js:162`) and `spawnPieces` (`debris.js:185`) calls `_makeRoom`, which does
`this.active.slice().sort(...)` over all 420 bodies with `body.isSleeping()` and `body.linvel()`
WASM calls inside the comparator (≈3,600 comparisons × 2–4 WASM calls, ×54 calls per frame).
The release loop at `src/world/structures.js:665-668` spawns up to 70 groups per frame, each
one hitting that path once the budget is exhausted.

**Do this.**
1. In `DebrisSystem.update` (`debris.js:428-475`) the loop already computes `sp` for every body;
   store it on the record (`rec.sp = sp; rec.asleep = b.isSleeping()`), so `_makeRoom` never calls
   into WASM.
2. Make `_makeRoom` run at most once per frame: keep `this.roomFrame` / `this.roomMade`; a second
   call in the same frame returns the cached verdict (and `spawnBox` returns `null` at once).
   Give it the real demand: in the release loop at `structures.js:665` call
   `G.debris.reserve(Math.min(70, col.items.length - col.i))` once before the loop, which freezes
   up to that many calm bodies in one pass.
3. Replace the full sort with one O(n) pass that collects candidates (`asleep || sp < 9`) and a
   bounded selection of the `need + 8` slowest (a small insertion into a fixed-size array), then
   freeze those. The `aggressive` branch (`smalls.filter().sort()`) likewise once per frame.
4. Keep the `released < 70` cap; the groups that found no room stay queued (`col.i` already
   persists), so the collapse timing is unchanged.

**Verify.** `node tools/shot.mjs "http://localhost:5173/?fight&norender&diff=training" /tmp/x.png 4000 tools/s_perfcol.mjs`
→ `p99` and `worst[].total` under ~12 ms, `worst[].destr` under ~5 ms (was 48 ms). The
in-page collapse profiler below shows `_makeRoom` ≤ 1 call per frame.

**Done** (`DebrisSystem.reserve` in `src/physics/debris.js`, one call per frame from the release
loop in `src/world/structures.js`). `update()` caches each body's speed, so picking the calmest
bodies is one pass with a bounded insertion: no sort, no WASM calls. A pass that runs dry answers
for the rest of the frame. The release loop reserves exactly the bodies this frame's groups spawn.
Worst collapse frame 41–107 ms → 5–8 ms (p99 10–48 → 5–7 ms); combined check 7.3 ms worst after
the first frame. Bodies frozen, slabs spawned and groups turned to pebbles per collapse stay in the
same ranges as before.

## 3. Stop re-uploading whole particle and debris buffers every frame

**Gain:** 1.6 MB/frame of GPU uploads when nothing is on screen → 0; 6–9 MB/frame in fights →
well under 1 MB. On the M1 this is bandwidth and GPU-process CPU; on phones and iGPUs
(shared memory, `bufferSubData` stalls) it is a real frame-time item and it runs every frame.
**Effort:** small–medium. **Visual risk:** none.

**Evidence.** Instrumenting `gl.bufferSubData`: 49 uploads, 1,618 KB per frame on an idle title
screen. three.js uploads the *entire* array whenever `needsUpdate = true` and no update range is set.
- `src/fx/particles.js:102-103` (`ShardSystem.update`): `instanceMatrix` (5,000 × 64 B for pebbles,
  3,500 for glass, 900 for blood) and `instanceColor` every frame, even with `n === 0`, and
  `setColorAt` runs per particle per frame although colours only change at spawn.
- `src/fx/particles.js:226` (`SparkSystem.update`): four instanced attributes, whole arrays.
- `src/fx/smoke.js:213-214` (`SmokeLayer.update`, three layers): matrices + `aData` + `aLit` +
  `aShade` whole arrays every frame.
- `src/physics/debris.js:476-480`: when any instance of a shape moved (`dirtyM`) the whole shape
  buffer goes up (the box shape alone is 6,000 × 64 B = 384 KB), and one `_bruise` marks all five
  attribute arrays of that shape dirty (6,000 × 72 B).

**Do this.**
1. Particles: `attr.clearUpdateRanges(); if (n > 0) { attr.addUpdateRange(0, n * itemSize);
   attr.needsUpdate = true; }` for every attribute in `ShardSystem`, `SparkSystem` and
   `SmokeLayer` (three clears the ranges itself after the upload). Write pebble/glass/blood colour
   into `instanceColor.array` at spawn and in the `_kill` swap only; drop the per-frame `setColorAt`.
   `aLit`/`aShade` of smoke only change at spawn/kill: upload them only on frames with spawns or
   kills (flag), still as `0..n` ranges.
2. Debris: track per shape the lowest and highest instance index touched this frame for matrices
   (`_setMatrix`, `_kill`, `_freeze`) and for attributes (`_writeAttrs`), and upload
   `addUpdateRange(lo * 16, (hi - lo + 1) * 16)` (and `* 4 / * 3` for the attribute arrays). Frozen
   rubble never moves, so the range is usually small.
3. `src/world/props.js:227` (cars): same `lo..hi` range on `instanceMatrix`.

**Verify.** Upload counter snippet (below): idle ≈ 0 KB/frame; during a collapse < 1 MB/frame.

**Done.** Particles, sparks and smoke upload only `0..n` (`uploadLive` in `src/fx/particles.js`),
nothing when empty; shard colours live in `instanceColor` and go up only on spawn/kill frames, as do
smoke `aLit`/`aShade`. Debris and cars upload the touched `lo..hi` span (`stageInstances` in
`src/physics/debris.js`, which keeps a pending full upload full). The recap and the recorder force
full uploads where they rewrite whole buffers (`uploadAll` in `src/game/recorder.js`). Uploads per
frame: idle 1,085 → 2 KB; 2 s after six impacts 2,597 → 38 KB; during a collapse 2,958 → 283–370 KB.
GPU copies of every buffer were read back and matched the CPU arrays, including through a full recap.

## 4. Fold `OutputPass` (tone map + sRGB) into the FX pass, one full-resolution pass fewer

**Gain:** one 2560×1440 half-float full-screen pass and one target swap per frame: ~5 ms on the
M1 at 1440p (measured: disabling the FX pass saved 6 ms, so each of these passes is ~5–6 ms
here). Do after item 1.
**Effort:** small–medium. **Visual risk:** none if done exactly: tone mapping is per texel, and
the FX shader only samples and averages texels (chromatic aberration, zoom blur), so tone-mapping
each sample inside the FX shader gives the same result as tone-mapping first.

**Do this.**
1. In `src/render/post.js` `FXShader`, make `sampleCA` tone-map and sRGB-encode each of its three
   texture reads: after `texture2D(...)` apply the same chunks `OutputPass` uses
   (`#include <tonemapping_fragment>` / `<colorspace_fragment>` operate on `gl_FragColor`, so write a
   small `vec3 display(vec3 linear)` helper that calls `toneMapping(linear)` and
   `linearToOutputTexel` equivalents, or inline `NeutralToneMapping` + `LinearTosRGB`).
2. Mirror `OutputPass.render`: set the material's define for the renderer's `toneMapping`
   (`NEUTRAL_TONE_MAPPING` here) and `SRGB_TRANSFER`, and update `uniforms.toneMappingExposure`
   from `renderer.toneMappingExposure` every frame (the weather's lightning flashes change it in
   `src/render/weather.js:_light`).
3. Remove the `OutputPass` from the composer (`post.js:184`). The FX pass is then the last pass
   and renders to screen.

**Verify.** Screenshot diff vs. before is zero apart from grain; GPU throughput −4…−6 ms at 1440p.

## 5. First hit on a big building: `ensureColliders` builds ~2,000 colliders in one frame

**Gain:** removes a 20–26 ms hitch on the first punch into any tall building (13.3 ms to create
1,983 fixed cuboids + 12.6 ms broad-phase insertion in the next `world.step`).
**Effort:** medium. **Visual risk:** none; debris only ever interacts with the damaged storeys.

**Evidence.** `src/world/structures.js:197-210` (`ensureColliders`) is called from `breakChunk`
(`structures.js:260`) and `_releaseGroup` (`structures.js:586`) and creates one Rapier collider
per alive chunk of the whole structure, replacing the intact box colliders. Refined structures also
keep all those colliders forever (4,074 live after five buildings; the physics step grew from 2.5
to 4 ms).

**Do this (proper fix).** Refine per storey instead of per building: at the first hit replace the
intact boxes with one fixed cuboid per storey (per tier rectangle, from `s.intactBoxes` /
`s.xs, s.zs, s.sy`), ~30–60 colliders; keep a `s.refinedLevels` bitset; whenever a chunk at level
`y` is hidden (`_hide`) or a group at level `y` is released, refine levels `y-1..y+1` only (remove
that storey's box, create its chunk colliders: ~60–100 per storey, < 1 ms). `colliderChunk` and
`colliders[id]` keep working unchanged.
**Quick fix (if the above is too much now).** Time-slice: push the chunk ids into a per-structure
queue sorted by distance to the impact point, create at most ~300 colliders per frame from
`Destruction.update`, and remove the intact boxes on the first batch. Debris spawns at the impact,
where colliders arrive first.

**Verify.** `tools/s_perf.mjs` prints `ensureMs` and `stepsAfterRefine`: target `ensureMs` < 2 ms
and the first step after refine within ~1 ms of the steady state.

## 6. Collapse scheduling spike: integrity flood fill + group merge in one frame

**Gain:** the frame that starts a big collapse drops from ~29 ms to ~12 ms (two
`_checkIntegrity` calls 12.9 ms, `_scheduleCollapse` 5.4 ms incl. `_mergeGroups` 4.1 ms, physics 9 ms).
**Effort:** small–medium. **Visual risk:** none if the check still runs within a frame or two.

**Do this.**
1. `src/world/structures.js:624-625`: process at most one structure from `pendingIntegrity` per
   frame (keep the rest pending), and run the cheap per-level ratio test every frame but the flood
   fill (`structures.js:407-430`) only for the structure whose turn it is.
2. Reuse scratch buffers: a per-structure `Uint8Array reach` and a preallocated `Int32Array` stack
   instead of `new Uint8Array` + `[]` per call.
3. `_mergeGroups` (`structures.js:494-580`): replace the string keys (`toFixed(2)` sets, template
   `runs` keys) with integer keys (cell indices), and avoid `ids.filter().sort()` by bucketing by level.

**Verify.** Collapse profiler: `des._checkIntegrity` and `des._scheduleCollapse` never together
above ~6 ms in one frame.

## 7. Ground texture: a 16 MB full re-upload for every scorch, skid or rubble paint

**Gain:** removes ~10 ms (M1; much more on phones) stalls up to 8 times a second in fights with
lots of ground slams, grazes and collapses.
**Effort:** medium. **Visual risk:** none.

**Evidence.** `src/world/ground.js:49` (`TEX = 2048`), paints at `:139-205, :333-409, :411-431`
set `texDirty`; `update()` at `:433-444` flips `texture.needsUpdate = true`, which makes three.js
re-upload the whole 2048² canvas (`texImage2D` from a 2D canvas: read-back + 16 MB upload).
Measured +10 ms on the frame after one `paintScorch`.

**Do this.**
1. Keep a dirty rectangle (union of every painted area since the last flush, in texels, clamped to
   the canvas).
2. On flush, upload only that rectangle with WebGL2 `texSubImage2D(TEXTURE_2D, 0, x, y, w, h, RGBA,
   UNSIGNED_BYTE, source)`. Two ways: (a) a scratch canvas: `drawImage(mainCanvas, x, y, w, h, 0, 0,
   w, h)` then `texSubImage2D` from the scratch canvas; (b) the main canvas with
   `pixelStorei(UNPACK_ROW_LENGTH / UNPACK_SKIP_PIXELS / UNPACK_SKIP_ROWS)`. Bind via
   `renderer.properties.get(texture).__webglTexture` and `renderer.state.bindTexture`. Set
   `texture.flipY = false` and flip the ground's `v` in the geometry (`ground.js:67`) and the outer
   plane so no row flipping is needed; `texture.needsUpdate` then only for the first full upload.
3. Keep the 120 ms throttle.

**Verify.** Upload counter snippet with `texImage2D` wrapped: paints cost a few hundred KB, not 16 MB;
the paint-flush frame no longer spikes.

## 8. Recorder: one event per particle instead of one per burst (GC pressure in collapses)

**Gain:** 23,500 recorder events (6.4 MB, each with cloned `Vector3`/`Color` args) for one
collapse become ~1,500; `pebbleBurst` drops from 1.4 ms to ~0.1 ms per heavy frame; fewer GC
pauses during the busiest seconds.
**Effort:** small. **Visual risk:** the recap re-rolls the random spread of a burst instead of
replaying every particle; not perceivable (same count, size, colour, direction distribution).

**Evidence.** `src/game/recorder.js:183` taps `spawn` on `pebbles`, `glass`, `bloodSys`, `sparks`,
`smoke`, so every single particle is recorded. `_tap` (`recorder.js:195-209`) already skips
recording while `depth > 0`.

**Do this.** Tap the FX facade recipes instead (`src/fx/fx.js`): `pebbleBurst`, `glassBurst`,
`dustPuff`, `dustRing`, `collapsePlume`, `collapseSurge`, `squib`, `sparkCone`, `blood`; keep the
raw `spawn` taps for the few direct callers (`debris.js` trails, `props.js` car smoke, `fighter.js`
charge sparks), which stay cheap because they are single spawns. Order the taps so the facade
wrappers are outermost (they increment `depth`, so inner spawns are not recorded). `blood` must
respect `G.settings.gore` at replay as it does live.

**Verify.** `__test.recorder()` after a collapse: `events` roughly 10× fewer, `mb` well under 2.

## 9. Spatially tile the city `InstancedMesh` so the camera and the shadow camera can cull it

**Gain:** main pass city triangles −40…−60 % depending on the view, shadow pass −60 %
(the 300×300 m shadow box sees a quarter of the city but draws all 490k tris + skyline). On the M1
the city costs ~5 ms and the shadow pass ~5 ms per frame; on iGPUs these are the biggest scene
items. The chunk shader itself is not the bottleneck here (hiding the whole city saved 5 ms at 1440p).
**Effort:** medium–high (touches `structures.js`, `recorder.js`, `recap.js`). **Visual risk:** none.

**Do this.**
1. In `Destruction.finalize` (`structures.js:95-130`) assign each chunk to a tile by `d.c.x, d.c.z`
   (e.g. 6×6 tiles over the arena) and build one `InstancedMesh` + attribute set per tile (same
   material, same `addChunkAttributes`). Keep `tileOf[id]` and `slot[id]` (`Int32Array`s).
2. Route every write through helpers: `_hide` (`:213`), `_setDamage` (`:231-245`), `finalize`,
   and the recorder/recap code that pokes `S.mesh.instanceMatrix.array` / `S.attrs.style.array`
   directly (`recap.js` `ReplayWorld.seek/step/end` at `:204, :237, :349`; the `_hide`/`_setDamage` taps in `recorder.js:168-178` only record times) → `S.writeMatrix(id, m)`,
   `S.writeDamage(id, v)`, `S.writeHit(id, hit)`.
3. `computeBoundingSphere()` per tile once (hidden instances are scaled to zero at their own position,
   so bounds stay valid). Leave `frustumCulled = true`.
4. Split the skyline mesh (`city.js:addSkylineMesh`) into rings/quadrants the same way (static, so
   this is trivial), so the shadow pass skips the far ring.

**Verify.** `renderer.info.render.triangles` per frame with `info.autoReset = false` in a street
view: city share drops; shadow-pass triangle count (difference with `shadowMap.enabled = false`)
drops by more than half.

## 10. Draw the sky last, not first

**Gain:** the sky's per-pixel `fbm` (two 4-octave noise evaluations) currently runs for every pixel
on screen and is then overdrawn by the city. Drawn last with the depth test it only runs where sky
is visible. ~0.5 ms on the M1; larger share on phones.
**Effort:** trivial. **Visual risk:** none.

**Do this.** `src/render/renderer.js:154`: `m.renderOrder = 1e6` (last of the opaque list; the sky
material is opaque so it still precedes transparent objects). Keep `depthWrite: false` and the
default `LessEqualDepth`; `gl_Position = p.xyww` puts it exactly on the far plane, so it passes only
where the depth buffer is still cleared. The light-shafts pass still detects sky by `depth == 1`.

**Verify.** Screenshot identical; GPU throughput −0.3…−0.6 ms.

## 11. Arena force-field planes are rasterized every frame

**Gain:** four 470×420 m additive quads with `frustumCulled = false` are drawn whenever in view
even though the shader discards almost everything (`src/world/boundary.js:42-43`). ~0.3 ms on the
M1 when an edge fills the view; more on phones.
**Effort:** trivial. **Visual risk:** none.

**Do this.** In `Boundary.update` set each plane's `visible` to whether either fighter is within
~40 m of that edge (the shader fades out at 34 m), and keep `frustumCulled = true` with a proper
bounding box.

## 12. Audio: stream the music and the ambience instead of decoding them into memory

**Gain:** ~125 MB less RAM (fight riff 57 MB, menu 13 MB, results 8.7 MB, ambience ~45 MB, all
decoded 44.1 kHz stereo floats) and no main-thread copies at boot. Matters on iPhones and iPads,
where Safari evicts tabs that grow this large.
**Effort:** medium. **Visual/audio risk:** none if `preservesPitch` is handled.

**Do this.** In `src/core/audio.js` replace `_loadTrack`/`music`/`_startAmbience`
(`audio.js:285-300, 375-410`) with one `HTMLAudioElement` per track (`preload = 'auto'`, `loop =
true`, same `pick()` for the AAC twin) wired through `ctx.createMediaElementSource(el)` into the
existing `musicF` / `ambF` chains, so the slow-mo filter, ducking, music on/off and fades keep working.
Slow-mo tape effect: `el.playbackRate = …` with `el.preservesPitch = false` (and
`webkitPreservesPitch`). iOS: call `el.play(); el.pause()` once inside the existing gesture unlock
(`src/main.js:98-100`) for all three elements. Keep `decodeAudioData` for the short effects.
Secondary: check the 113 effect samples for stereo files that could be mono (45 MB decoded).

**Verify.** The "decoded audio" snippet: tracks no longer appear as `AudioBuffer`s; heap and
`performance.memory` drop by >100 MB on the title screen.

## 13. Startup: pre-compile shaders behind the loader, stream the physics WASM

**Gain:** removes the ~270 ms freeze on the first rendered frame (36 programs compile on first
use) and shortens the "building the city…" wait, especially on phones.
**Effort:** small (a) / medium (b). **Visual risk:** none.

**Do this.**
- (a) `src/main.js:101`: before fading out `#loading`, `await renderer.compileAsync(scene, camera)`
  (the context has `KHR_parallel_shader_compile`) and run one `G.post.composer.render()` offscreen
  (`composer.renderToScreen = false` for that call) so the post-pass programs compile too.
- (b) `src/physics/physics.js:19-27`: the `-compat` Rapier packages inline the 3 MB `.wasm` as
  base64 inside a 4.3 MB JS chunk (see `dist/assets/rapier-*.js`), which is parsed, decoded and
  compiled on the main thread. Switch to `@dimforge/rapier3d-simd` (+ `@dimforge/rapier3d` fallback)
  with `vite-plugin-wasm` and `WebAssembly.instantiateStreaming`: smaller transfer (binary wasm
  gzips far better than base64) and compilation overlaps the download.
- (c) Instrument boot with `performance.mark`/`measure` around each phase in `main.js:40-84`
  (physics init, map load, `generateRealCity`, `finalize`, `paintCity`, `buildFractureLibrary`,
  `warmup`, `DebrisSystem`/`FX` allocation) and print them with `?debug`; this was not measured and
  decides whether city generation deserves a worker.

**Verify.** `performance.now()` at the first `loop()` call vs. loader removal; no long task > 50 ms
after the loader fades.

## 14. Per-frame DOM and AudioParam churn

**Gain:** small but free: style/layout work every frame on the main thread, and automation events
piling up on the audio thread.
**Effort:** trivial. **Visual risk:** none.

**Do this.**
- `src/game/hud.js:318-320` and `:352-356`: `#cityStats` gets `innerHTML` 60 times per second and
  the six bar widths are written every frame. Cache the last written strings/values and write
  `textContent` / `style.width` only when they change (the damage counter changes only while
  `dmgShown` is still moving).
- `src/core/audio.js:737-744`: six `setTargetAtTime` calls per frame; only schedule when the target
  differs from the last one by more than ~1 %.

## 15. Micro items (do when touching the file anyway)

- `src/world/props.js:225`: `car.body.translation()` is a WASM call for all 150 cars every frame;
  only dynamic cars can fall, so move the `< -30` check inside `if (car.dynamic)`.
- `src/physics/physics.js:102`: `steps = dt > 1/40 ? 2 : 1` doubles physics cost exactly on the
  frames that are already slow (death spiral). Consider one step with `h = min(dt, 1/30)` when the
  previous frame exceeded ~25 ms. (Behaviour change only on slow frames.)
- Empty instanced meshes (3 found) still issue draw calls; set `mesh.visible = count > 0` in the
  particle systems' `update`.
- `src/game/fighter.js:_orient`: `new THREE.Euler(...)` and `new THREE.Vector3()` per fighter per
  frame; `src/core/input.js:poll`: `new Set(this._down)` per frame. Hoist to module scratch objects.

## Checked and not worth doing now

- Draw-call count (179, 121 without shadows) is fine; batching further would not pay.
- The chunk facade shader, the smoke overdraw in a full collapse (1,342 billows) and the light-shafts
  march each cost under 1 ms on the M1 at 1440p. Revisit with a depth pre-pass only if a phone or
  iGPU profile shows the scene pass fill-bound.
- `numSolverIterations` is already 2; Rapier's step is 2.4 ms p50 at the 420-body cap.
- Pixel ratio is not the limiter on this machine (item 1 is); do not lower it.

---

## Measuring

Start the dev server (`npm run dev`) and open
`http://localhost:5173/?fight&quality=high&diff=training&weather=golden&norender` so the loop does not
draw on its own. In the console, `__test.hold(true)` stops the loop from stepping the game;
`__test.advance(1/60)` steps it and `__test.render()` draws one frame. Note: if the page runs in
a hidden tab or a hidden embedded pane, `requestAnimationFrame` and timers are throttled and
`EXT_disjoint_timer_query_webgl2` results never arrive; the snippets below do not depend on either.

**GPU throughput per frame** (12 frames back to back, one forced GPU sync at the end):

```js
const G = __G, R = G.renderer, THREE = G.three;
const rt = new THREE.WebGLRenderTarget(4, 4), buf = new Uint8Array(64), empty = new THREE.Scene(), cam = new THREE.PerspectiveCamera();
const sync = () => { R.setRenderTarget(rt); R.clear(); R.render(empty, cam); R.readRenderTargetPixels(rt, 0, 0, 4, 4, buf); R.setRenderTarget(null); };
const thru = (N = 12) => { const r = []; for (let k = 0; k < 3; k++) { sync(); const t = performance.now(); for (let i = 0; i < N; i++) __test.render(); sync(); r.push((performance.now() - t) / N); } return Math.min(...r).toFixed(1) + ' ms/frame'; };
G.post.composer.renderToScreen = false; __test.render(); thru();
// attribute: R.shadowMap.enabled = false; G.post.bloom.enabled = false; G.scene.getObjectByName('city-chunks').visible = false; ...
```

**Draw calls / triangles:** `R.info.autoReset = false; R.info.reset(); __test.render(); R.info.render`.

**Uploads per frame** (wrap before rendering):

```js
const gl = __G.renderer.getContext(); let bytes = 0, calls = 0;
const sub = gl.bufferSubData.bind(gl); gl.bufferSubData = (t, o, d, ...r) => { bytes += d.byteLength || 0; calls++; return sub(t, o, d, ...r); };
bytes = 0; calls = 0; __test.render(); ({ kb: bytes / 1024, calls });
```

**Collapse CPU profile** (per-function, worst frames), also available headless as `tools/s_perfcol.mjs`:

```js
const G = __G, acc = {}, cnt = {};
const wrap = (o, n, l) => { const f = o[n]; o[n] = function (...a) { const t = performance.now(); const r = f.apply(this, a); acc[l] = (acc[l] || 0) + performance.now() - t; cnt[l] = (cnt[l] || 0) + 1; return r; }; };
for (const n of ['_makeRoom', 'spawnBox', '_breakRec']) wrap(G.debris, n, 'deb.' + n);
for (const n of ['_checkIntegrity', '_scheduleCollapse', '_mergeGroups', '_releaseGroup', 'ensureColliders']) wrap(G.destruction, n, 'des.' + n);
wrap(G.physics, 'step', 'phys');
__test.collapseTower(4, 0);
const frames = []; for (let i = 0; i < 300; i++) { for (const k in acc) { acc[k] = 0; cnt[k] = 0; } const t = performance.now(); __test.advance(1 / 60); frames.push({ i, total: performance.now() - t, ...Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, +v.toFixed(1) + 'x' + cnt[k]])) }); }
frames.sort((a, b) => b.total - a.total).slice(0, 5);
```

**Decoded audio:** `Object.values(__G.audio.bank).flat().reduce((s, b) => s + b.length * b.numberOfChannels * 4, 0) / 1048576` MB for effects; `await __G.audio.tracks.fight` for a music buffer.
