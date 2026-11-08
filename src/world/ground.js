// Deformable ground: a heightfield mesh that gets cratered, plus a painted canvas texture
// (streets + accumulated scorch/cracks). Shares its heights with a Rapier heightfield collider.
import * as THREE from 'three';
import { gradientMap } from '../render/toon.js';
import { G } from '../core/context.js';
import { clamp, rand, smoothstep } from '../core/math.js';
import { CITY, CITY_HALF } from './city.js';

export const GROUND_SIZE = 560;
// The static floor beyond the deformable zone: the same streets, sidewalks and lane markings as
// the painted canvas, computed in world space so the city's grid runs on to the horizon.
function streetMaterial() {
  const mat = new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap: gradientMap(3) });
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, {
      uAsphalt: { value: new THREE.Color(0x4b4e56) }, uWalk: { value: new THREE.Color(0xbdb6aa) },
      uLot: { value: new THREE.Color(0xa39d92) }, uInk: { value: new THREE.Color(0x2a2a30) }, uLane: { value: new THREE.Color(0xe8c547) },
    });
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGW;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvGW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uAsphalt, uWalk, uLot, uInk, uLane; varying vec3 vGW;')
      .replace('#include <map_fragment>', `#include <map_fragment>
        {
          // distance to the nearest street centre line (76 m pitch, 22 m streets, 3.5 m sidewalks)
          vec2 m = abs(mod(vGW.xz + ${(CITY_HALF + CITY.PITCH / 2).toFixed(1)}, ${CITY.PITCH.toFixed(1)}) - ${(CITY.PITCH / 2).toFixed(1)});
          float hs = ${(CITY.STREET / 2).toFixed(1)}, sw = ${CITY.SIDEWALK.toFixed(1)};
          float e = min(m.x, m.y);
          float aa = max(fwidth(e), 1e-3);
          vec3 col = mix(uAsphalt, uWalk, smoothstep(hs - aa, hs + aa, e));
          col = mix(col, uLot, smoothstep(hs + sw - aa, hs + sw + aa, e));
          col = mix(col, uInk, 1.0 - smoothstep(0.12, 0.12 + 1.5 * aa, abs(e - hs)));
          // dashed yellow centre lines, not across intersections, faded before they can shimmer
          float dist = distance(vGW, cameraPosition);
          float lane = 0.0;
          if (m.y < 0.2 && m.x > hs) lane = step(0.5, fract(vGW.x / 6.0));
          if (m.x < 0.2 && m.y > hs) lane = step(0.5, fract(vGW.z / 6.0));
          col = mix(col, uLane, lane * (1.0 - smoothstep(120.0, 260.0, dist)));
          // far away the pattern melts into its average colour (no moire)
          col = mix(col, mix(uAsphalt, uLot, 0.55), smoothstep(380.0, 900.0, dist));
          diffuseColor.rgb *= col;
        }`);
  };
  mat.customProgramCacheKey = () => 'outer-streets';
  return mat;
}

// The static outer ground as a flat ring: a rectangle (x0..x1, z0..z1) with the deformable zone
// cut out of its middle. A plane running on under the heightfield would lid every crater deeper
// than its offset with its own coarse texture, and z-fight with the ground from the air.
function ringGround(x0, x1, z0, z1, hole) {
  const O = [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
  const I = [[-hole, -hole], [hole, -hole], [hole, hole], [-hole, hole]];
  const pos = [], nor = [], uv = [];
  for (const [x, z] of [...O, ...I]) {
    pos.push(x, 0, z); nor.push(0, 1, 0);
    uv.push((x - x0) / (x1 - x0), 1 - (z - z0) / (z1 - z0)); // as a PlaneGeometry laid flat: v = 1 along -z
  }
  const idx = [];
  for (let k = 0; k < 4; k++) {
    const a = k, b = (k + 1) % 4, c = 4 + (k + 1) % 4, d = 4 + k;
    idx.push(a, c, b, a, d, c); // wound to face up
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  return geo;
}

const _box = new THREE.Box2();
const _at = new THREE.Vector2();
const N = 280; // segments -> 2 m cells
const CELL = GROUND_SIZE / N;
const TEX = 2048;

export class Ground {
  constructor(scene, map = null) {
    this.size = GROUND_SIZE;
    this.n = N;
    // Rapier layout: h[zi + xi*(N+1)]
    this.heights = new Float32Array((N + 1) * (N + 1));
    this.dirtyPhysics = false;
    this.physTimer = 0;
    this.texDirty = false;
    this.texTimer = 0;
    this.patches = []; // rubble mounds as before/after height patches, so the recap can undo them

    // --- mesh ---
    const geo = new THREE.BufferGeometry();
    const vc = (N + 1) * (N + 1);
    const pos = new Float32Array(vc * 3);
    const nor = new Float32Array(vc * 3);
    const uv = new Float32Array(vc * 2);
    for (let zi = 0; zi <= N; zi++) {
      for (let xi = 0; xi <= N; xi++) {
        const v = zi * (N + 1) + xi;
        pos[v * 3] = -GROUND_SIZE / 2 + xi * CELL;
        pos[v * 3 + 1] = 0;
        pos[v * 3 + 2] = -GROUND_SIZE / 2 + zi * CELL;
        nor[v * 3 + 1] = 1;
        uv[v * 2] = xi / N;
        uv[v * 2 + 1] = zi / N; // the canvas texture isn't flipped: row 0 is the -z edge
      }
    }
    const idx = new Uint32Array(N * N * 6);
    let k = 0;
    for (let zi = 0; zi < N; zi++) {
      for (let xi = 0; xi < N; xi++) {
        const a = zi * (N + 1) + xi, b = a + 1, c = a + (N + 1), d = c + 1;
        idx[k++] = a; idx[k++] = c; idx[k++] = b;
        idx[k++] = b; idx[k++] = c; idx[k++] = d;
      }
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeBoundingSphere();
    this.geo = geo;

    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvas.height = TEX;
    this.ctx = this.canvas.getContext('2d');
    this.ctx.fillStyle = '#4b4e56';
    this.ctx.fillRect(0, 0, TEX, TEX);
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 8;
    this.texture.flipY = false; // so a partial upload's rows land where they were painted
    // Decals (footprints, scorch, rubble, skid marks) are painted all through a fight. Re-uploading
    // the whole 2048x2048 canvas each time cost several ms; instead the painters grow a dirty
    // rectangle and update() copies just that (texSubImage2D) through this second handle on the
    // same canvas, which is never uploaded on its own.
    this.src = new THREE.CanvasTexture(this.canvas);
    this.src.flipY = false;
    this.dirty = null; // [x0, y0, x1, y1] in texels

    this.mat = new THREE.MeshToonMaterial({ map: this.texture, gradientMap: gradientMap(3) });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.receiveShadow = true;
    this.mesh.name = 'ground';
    scene.add(this.mesh);

    if (map) {
      // real map: the surrounding blocks, parks and rivers painted once onto a 4 km plane
      scene.add(realOuterGround(map));
      return;
    }
    // Outer ground (static, beyond the destructible zone), stopping at the lake shore
    const shore = GROUND_SIZE / 2 + 260;
    const outer = new THREE.Mesh(ringGround(-3000, shore, -3000, 3000, GROUND_SIZE / 2), streetMaterial());
    outer.position.y = -0.05;
    outer.receiveShadow = true;
    outer.name = 'outer-ground';
    scene.add(outer);
    // the lake to the east (Chicago vibes)
    const lakeGeo = new THREE.PlaneGeometry(2400, 6000);
    lakeGeo.rotateX(-Math.PI / 2);
    const lake = new THREE.Mesh(lakeGeo, new THREE.MeshToonMaterial({ color: 0x3f86b5, gradientMap: gradientMap(2) }));
    lake.position.set(shore + 1200, 0.02, 0);
    lake.name = 'lake';
    scene.add(lake);
  }

  // grow the dirty rectangle by a disc (texels) around a point; painters call this
  _touch(px, pz, r) {
    const x0 = clamp(Math.floor(px - r), 0, TEX), y0 = clamp(Math.floor(pz - r), 0, TEX);
    const x1 = clamp(Math.ceil(px + r), 0, TEX), y1 = clamp(Math.ceil(pz + r), 0, TEX);
    if (x1 <= x0 || y1 <= y0) return;
    const d = this.dirty;
    if (!d) this.dirty = [x0, y0, x1, y1];
    else { d[0] = Math.min(d[0], x0); d[1] = Math.min(d[1], y0); d[2] = Math.max(d[2], x1); d[3] = Math.max(d[3], y1); }
    this.texDirty = true;
  }

  // upload what the painters touched since the last time
  _upload() {
    const d = this.dirty;
    this.dirty = null;
    if (!d || !G.renderer) return;
    if (this.texture.version === 0) { this.texture.needsUpdate = true; return; } // nothing up yet: the first full upload covers it
    const w = d[2] - d[0], h = d[3] - d[1];
    if (w * h > TEX * TEX * 0.35) { this.texture.needsUpdate = true; return; } // a big enough area: a full upload is as cheap
    _box.min.set(d[0], d[1]); _box.max.set(d[2], d[3]);
    _at.set(d[0], d[1]);
    G.renderer.copyTextureToTexture(this.src, this.texture, _box, _at);
  }

  // world (x,z) -> texture px
  toTex(x, z) {
    return [((x + GROUND_SIZE / 2) / GROUND_SIZE) * TEX, ((z + GROUND_SIZE / 2) / GROUND_SIZE) * TEX];
  }
  texScale() { return TEX / GROUND_SIZE; }

  paintCity(layout) {
    const c = this.ctx, s = this.texScale();
    c.fillStyle = '#4b4e56';
    c.fillRect(0, 0, TEX, TEX);
    // asphalt grain
    for (let i = 0; i < 9000; i++) {
      c.fillStyle = Math.random() < 0.5 ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.04)';
      c.fillRect(Math.random() * TEX, Math.random() * TEX, 2 + Math.random() * 3, 2 + Math.random() * 3);
    }
    if (layout.real) {
      paintRealMap(c, layout.map, (x, z) => this.toTex(x, z), s, true);
      this.texture.needsUpdate = true;
      return;
    }
    // lane markings along every street
    for (const st of layout.streets) {
      const [x0, z0] = this.toTex(st.x0, st.z0);
      const [x1, z1] = this.toTex(st.x1, st.z1);
      c.save();
      c.strokeStyle = '#e8c547';
      c.lineWidth = 0.35 * s;
      c.setLineDash([3 * s, 3 * s]);
      c.beginPath(); c.moveTo(x0, z0); c.lineTo(x1, z1); c.stroke();
      c.restore();
    }
    for (const b of layout.blocks) {
      const [x0, z0] = this.toTex(b.x0, b.z0);
      const w = (b.x1 - b.x0) * s, h = (b.z1 - b.z0) * s;
      // sidewalk with curb ink line
      c.fillStyle = '#bdb6aa';
      c.fillRect(x0, z0, w, h);
      c.strokeStyle = '#2a2a30';
      c.lineWidth = 0.25 * s;
      c.strokeRect(x0, z0, w, h);
      const inset = 3.5 * s;
      if (b.park) {
        c.fillStyle = '#74b35c';
        c.fillRect(x0 + inset, z0 + inset, w - inset * 2, h - inset * 2);
        c.fillStyle = '#d8cfb6';
        c.fillRect(x0 + w / 2 - 2 * s, z0 + inset, 4 * s, h - inset * 2);
        c.fillRect(x0 + inset, z0 + h / 2 - 2 * s, w - inset * 2, 4 * s);
        c.beginPath();
        c.arc(x0 + w / 2, z0 + h / 2, 9 * s, 0, Math.PI * 2);
        c.fill();
        c.fillStyle = '#5ea0d0';
        c.beginPath();
        c.arc(x0 + w / 2, z0 + h / 2, 6 * s, 0, Math.PI * 2);
        c.fill();
      } else {
        c.fillStyle = '#a39d92';
        c.fillRect(x0 + inset, z0 + inset, w - inset * 2, h - inset * 2);
      }
      // crosswalks on the four sides of each block corner
      c.fillStyle = 'rgba(240,240,235,0.9)';
      const cw = 3 * s;
      for (const [cx, cz, horiz] of [
        [x0, z0 - 6 * s, true], [x0 + w - 6 * s, z0 - 6 * s, true],
        [x0 - 6 * s, z0, false], [x0 - 6 * s, z0 + h - 6 * s, false],
      ]) {
        for (let i = 0; i < 6; i++) {
          if (horiz) c.fillRect(cx + i * 1.0 * s, cz + s, 0.5 * s, cw);
          else c.fillRect(cx + s, cz + i * 1.0 * s, cw, 0.5 * s);
        }
      }
    }
    this.texture.needsUpdate = true;
  }

  heightAt(x, z) {
    const fx = (x + GROUND_SIZE / 2) / CELL, fz = (z + GROUND_SIZE / 2) / CELL;
    if (fx < 0 || fz < 0 || fx >= N || fz >= N) return 0;
    const xi = Math.floor(fx), zi = Math.floor(fz);
    const tx = fx - xi, tz = fz - zi;
    const h = this.heights, R = N + 1;
    const h00 = h[zi + xi * R], h10 = h[zi + (xi + 1) * R];
    const h01 = h[zi + 1 + xi * R], h11 = h[zi + 1 + (xi + 1) * R];
    return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
  }

  // Bowl + raised lip. `scorch` controls how much the texture gets burnt/cracked.
  crater(x, z, radius, depth, opts = {}) {
    const R = N + 1;
    const outer = radius * 1.7;
    const x0 = clamp(Math.floor((x - outer + GROUND_SIZE / 2) / CELL), 0, N);
    const x1 = clamp(Math.ceil((x + outer + GROUND_SIZE / 2) / CELL), 0, N);
    const z0 = clamp(Math.floor((z - outer + GROUND_SIZE / 2) / CELL), 0, N);
    const z1 = clamp(Math.ceil((z + outer + GROUND_SIZE / 2) / CELL), 0, N);
    if (x0 >= x1 || z0 >= z1) return;
    const pos = this.geo.attributes.position.array;
    for (let xi = x0; xi <= x1; xi++) {
      for (let zi = z0; zi <= z1; zi++) {
        const wx = -GROUND_SIZE / 2 + xi * CELL, wz = -GROUND_SIZE / 2 + zi * CELL;
        const d = Math.hypot(wx - x, wz - z) / radius;
        if (d > 1.7) continue;
        const hi = zi + xi * R;
        let h = this.heights[hi];
        if (d < 1) {
          const target = -depth * (1 - d * d) * (0.85 + Math.random() * 0.3);
          h = Math.min(h, h * 0.4 + target);
        } else {
          h += depth * 0.32 * Math.sin(((d - 1) / 0.7) * Math.PI) * (0.7 + Math.random() * 0.6);
        }
        h = clamp(h, -9, Math.max(4, this.heights[hi])); // a crater in a rubble mound mustn't plane it flat
        this.heights[hi] = h;
        pos[(zi * R + xi) * 3 + 1] = h;
      }
    }
    this._recomputeNormals(x0, x1, z0, z1);
    this.dirtyPhysics = true;
    if (G.trees) G.trees.knock(x, z, radius * 1.6);
    if (opts.paint !== false) this.paintScorch(x, z, radius, opts.cracks ?? 1);
  }

  _recomputeNormals(x0, x1, z0, z1) {
    const R = N + 1;
    const nor = this.geo.attributes.normal.array;
    const h = this.heights;
    for (let xi = Math.max(0, x0 - 1); xi <= Math.min(N, x1 + 1); xi++) {
      for (let zi = Math.max(0, z0 - 1); zi <= Math.min(N, z1 + 1); zi++) {
        const hl = h[zi + Math.max(0, xi - 1) * R], hr = h[zi + Math.min(N, xi + 1) * R];
        const hd = h[Math.max(0, zi - 1) + xi * R], hu = h[Math.min(N, zi + 1) + xi * R];
        let nx = hl - hr, ny = 2 * CELL, nz = hd - hu;
        const l = Math.hypot(nx, ny, nz);
        const v = (zi * R + xi) * 3;
        nor[v] = nx / l; nor[v + 1] = ny / l; nor[v + 2] = nz / l;
      }
    }
    // ranges add up until the next upload (two edits in one frame both reach the GPU)
    const a = this.geo.attributes;
    const start = Math.max(0, (z0 - 1) * R) * 3;
    const count = Math.min((z1 - z0 + 3) * R * 3, a.position.array.length - start);
    a.position.addUpdateRange(start, count); a.position.needsUpdate = true;
    a.normal.addUpdateRange(start, count); a.normal.needsUpdate = true;
  }

  // Rubble heaped over a fallen building's footprint: a rounded-rectangle pile (half sizes
  // rx, rz) with a rough top. Additive, so a pile can grow in several goes.
  mound(x, z, rx, rz, height) {
    const R = N + 1;
    const x0 = clamp(Math.floor((x - rx * 1.25 + GROUND_SIZE / 2) / CELL), 0, N);
    const x1 = clamp(Math.ceil((x + rx * 1.25 + GROUND_SIZE / 2) / CELL), 0, N);
    const z0 = clamp(Math.floor((z - rz * 1.25 + GROUND_SIZE / 2) / CELL), 0, N);
    const z1 = clamp(Math.ceil((z + rz * 1.25 + GROUND_SIZE / 2) / CELL), 0, N);
    if (x0 >= x1 || z0 >= z1) return;
    const before = this._region(x0, x1, z0, z1);
    const pos = this.geo.attributes.position.array;
    for (let xi = x0; xi <= x1; xi++) {
      for (let zi = z0; zi <= z1; zi++) {
        const u = Math.abs(-GROUND_SIZE / 2 + xi * CELL - x) / rx, v = Math.abs(-GROUND_SIZE / 2 + zi * CELL - z) / rz;
        const d = Math.pow(u ** 4 + v ** 4, 0.25);
        if (d >= 1.25) continue;
        const hi = zi + xi * R;
        const h = Math.min(14, this.heights[hi] + height * (1 - smoothstep(0.55, 1.25, d)) * (0.7 + Math.random() * 0.6));
        this.heights[hi] = h;
        pos[(zi * R + xi) * 3 + 1] = h;
      }
    }
    this._recomputeNormals(x0, x1, z0, z1);
    this.dirtyPhysics = true;
    this.patches.push({ t: G.time.gameTime, x0, x1, z0, z1, before, after: this._region(x0, x1, z0, z1) });
    if (this.patches.length > 60) this.patches.shift();
    if (G.trees) G.trees.knock(x, z, Math.max(rx, rz));
    this.paintRubble(x, z, rx, rz);
  }

  _region(x0, x1, z0, z1) {
    const R = N + 1, out = new Float32Array((x1 - x0 + 1) * (z1 - z0 + 1));
    let k = 0;
    for (let xi = x0; xi <= x1; xi++) for (let zi = z0; zi <= z1; zi++) out[k++] = this.heights[zi + xi * R];
    return out;
  }

  // The recap rewinds mounds: write one patch's heights back (mesh only; the simulation is
  // standing still meanwhile, and restoreHeights puts the live ground back afterwards).
  applyPatch(p, data) {
    const R = N + 1, pos = this.geo.attributes.position.array;
    let k = 0;
    for (let xi = p.x0; xi <= p.x1; xi++) {
      for (let zi = p.z0; zi <= p.z1; zi++) {
        this.heights[zi + xi * R] = data[k];
        pos[(zi * R + xi) * 3 + 1] = data[k++];
      }
    }
    this._recomputeNormals(p.x0, p.x1, p.z0, p.z1);
  }

  restoreHeights(h) {
    const R = N + 1, pos = this.geo.attributes.position.array;
    this.heights.set(h);
    for (let xi = 0; xi <= N; xi++) for (let zi = 0; zi <= N; zi++) pos[(zi * R + xi) * 3 + 1] = h[zi + xi * R];
    this._recomputeNormals(0, N, 0, N);
  }

  // Dusty rubble over the pile's footprint, and a pale film of dust on the streets around it.
  paintRubble(x, z, rx, rz) {
    const c = this.ctx, s = this.texScale();
    const [px, pz] = this.toTex(x, z);
    c.save();
    c.translate(px, pz);
    c.scale(rx * s, rz * s);
    const film = c.createRadialGradient(0, 0, 0.8, 0, 0, 2.2);
    film.addColorStop(0, 'rgba(176,168,154,0.4)');
    film.addColorStop(1, 'rgba(176,168,154,0)');
    c.fillStyle = film;
    c.beginPath(); c.arc(0, 0, 2.2, 0, Math.PI * 2); c.fill();
    const pile = c.createRadialGradient(0, 0, 0, 0, 0, 1.25);
    pile.addColorStop(0, 'rgba(146,138,126,0.95)');
    pile.addColorStop(0.75, 'rgba(140,132,120,0.85)');
    pile.addColorStop(1, 'rgba(140,132,120,0)');
    c.fillStyle = pile;
    c.beginPath(); c.arc(0, 0, 1.25, 0, Math.PI * 2); c.fill();
    c.restore();
    // broken concrete, rebar and shadows between the chunks
    for (let i = 0; i < (rx + rz) * 14; i++) {
      const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * 1.15;
      const r = Math.random();
      c.fillStyle = r < 0.4 ? 'rgba(52,46,44,0.75)' : r < 0.85 ? 'rgba(186,178,164,0.85)' : 'rgba(96,70,58,0.8)';
      const sz = (0.3 + Math.random() * 1.2) * s;
      c.fillRect(px + Math.cos(a) * d * rx * s, pz + Math.sin(a) * d * rz * s, sz, sz * (0.5 + Math.random()));
    }
    this._touch(px, pz, Math.max(rx, rz) * s * 2.3 + 4);
  }

  paintScorch(x, z, radius, cracks = 1) {
    const c = this.ctx, s = this.texScale();
    const [px, pz] = this.toTex(x, z);
    const r = radius * s;
    const g = c.createRadialGradient(px, pz, 0, px, pz, r * 1.5);
    g.addColorStop(0, 'rgba(40,32,28,0.85)');
    g.addColorStop(0.55, 'rgba(70,58,48,0.55)');
    g.addColorStop(1, 'rgba(70,58,48,0)');
    c.fillStyle = g;
    c.beginPath(); c.arc(px, pz, r * 1.5, 0, Math.PI * 2); c.fill();
    // radial jagged cracks (inked)
    const nCracks = Math.floor((6 + radius * 0.8) * cracks);
    c.strokeStyle = 'rgba(18,14,14,0.9)';
    c.lineCap = 'round';
    for (let i = 0; i < nCracks; i++) {
      let ang = Math.random() * Math.PI * 2;
      let cx = px + Math.cos(ang) * r * 0.6, cz = pz + Math.sin(ang) * r * 0.6;
      const len = r * (1.2 + Math.random() * 2.2);
      let w = Math.max(1.5, r * 0.06);
      c.beginPath(); c.moveTo(cx, cz);
      let travelled = 0;
      while (travelled < len) {
        const step = r * (0.12 + Math.random() * 0.2);
        ang += (Math.random() - 0.5) * 0.9;
        cx += Math.cos(ang) * step; cz += Math.sin(ang) * step;
        travelled += step;
        c.lineTo(cx, cz);
        // branch
        if (Math.random() < 0.15) {
          const ba = ang + (Math.random() - 0.5) * 2;
          c.moveTo(cx, cz);
          c.lineTo(cx + Math.cos(ba) * step * 2, cz + Math.sin(ba) * step * 2);
          c.moveTo(cx, cz);
        }
      }
      c.lineWidth = w;
      c.stroke();
    }
    // rubble speckles
    for (let i = 0; i < radius * 6; i++) {
      const a = Math.random() * Math.PI * 2, d = r * (0.4 + Math.random() * 1.6);
      c.fillStyle = Math.random() < 0.5 ? 'rgba(30,26,24,0.8)' : 'rgba(150,140,128,0.8)';
      const sz = 1 + Math.random() * 3;
      c.fillRect(px + Math.cos(a) * d, pz + Math.sin(a) * d, sz, sz);
    }
    this._touch(px, pz, r * 4.6 + 4); // the cracks wander out to ~4 radii
  }

  // Drag mark when someone skids across the street.
  paintSkid(x0, z0, x1, z1, width) {
    const c = this.ctx, s = this.texScale();
    const [a, b] = this.toTex(x0, z0), [cx, cz] = this.toTex(x1, z1);
    c.strokeStyle = 'rgba(35,28,25,0.75)';
    c.lineWidth = width * s;
    c.lineCap = 'round';
    c.beginPath(); c.moveTo(a, b); c.lineTo(cx, cz); c.stroke();
    this._touch((a + cx) / 2, (b + cz) / 2, Math.hypot(cx - a, cz - b) / 2 + width * s + 2);
  }

  paintBlood(x, z, size) {
    const c = this.ctx, s = this.texScale();
    const [px, pz] = this.toTex(x, z);
    c.fillStyle = 'rgba(120,8,12,0.85)';
    for (let i = 0; i < 6; i++) {
      c.beginPath();
      c.arc(px + rand(-1, 1) * size * s, pz + rand(-1, 1) * size * s, rand(0.2, 0.6) * size * s, 0, Math.PI * 2);
      c.fill();
    }
    this._touch(px, pz, size * s * 1.7 + 2);
  }

  update(dt) {
    this.physTimer -= dt;
    this.texTimer -= dt;
    if (this.dirtyPhysics && this.physTimer <= 0 && G.physics) {
      G.physics.setGroundHeights(this.heights, N, GROUND_SIZE);
      this.dirtyPhysics = false;
      this.physTimer = 0.2;
    }
    if (this.texDirty && this.texTimer <= 0) {
      this._upload();
      this.texDirty = false;
      this.texTimer = 0.12;
    }
  }
}

// ---------------------------------------------------------------- real maps
const INK = '#2a2a30', WALK = '#bdb6aa', LOT = '#a39d92', GRASS = '#74b35c', WATER = '#3f86b5', PATH = '#d8cfb6';
const SIDEWALK = 4.6; // property line in from the curb (15 ft)

function ringPath(c, flat, toPx) {
  c.beginPath();
  for (let i = 0; i < flat.length; i += 2) {
    const [x, y] = toPx(flat[i], flat[i + 1]);
    if (i) c.lineTo(x, y); else c.moveTo(x, y);
  }
  c.closePath();
}

// Real blocks are curb-line polygons: fill the lot, then stroke the curb line twice the sidewalk
// width while clipped to the block, which leaves an exact 4.6 m sidewalk ring for any shape.
function paintBlocks(c, map, toPx, s) {
  for (const [ring, park] of map.blocks) {
    ringPath(c, ring, toPx);
    c.fillStyle = park ? GRASS : LOT;
    c.fill();
    c.save();
    c.clip();
    c.strokeStyle = WALK;
    c.lineWidth = 2 * SIDEWALK * s;
    c.stroke();
    c.restore();
    c.strokeStyle = INK;
    c.lineWidth = Math.max(0.8, 0.25 * s);
    c.stroke();
  }
  // smaller parks and playgrounds inside blocks
  c.fillStyle = GRASS;
  for (const [, rings] of map.parks) {
    ringPath(c, rings[0], toPx);
    c.fill();
  }
}

function blockBounds(flat) {
  const b = { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity };
  for (let i = 0; i < flat.length; i += 2) {
    b.x0 = Math.min(b.x0, flat[i]); b.x1 = Math.max(b.x1, flat[i]);
    b.z0 = Math.min(b.z0, flat[i + 1]); b.z1 = Math.max(b.z1, flat[i + 1]);
  }
  return b;
}

// The spawn park, stylised on its surveyed block: an oval walk round the central lawn (kept open
// for the fight), walks in from the corners and the street midpoints, a fountain to the north.
// Shared by the ground painter and the tree planter so paths and trees agree.
export function spawnParkLayout(map) {
  const blk = map.blocks.find((b) => b[1] === map.park);
  if (!blk) return null;
  const b = blockBounds(blk[0]);
  const x0 = b.x0 + SIDEWALK, x1 = b.x1 - SIDEWALK, z0 = b.z0 + SIDEWALK, z1 = b.z1 - SIDEWALK;
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2 + (z1 - z0) * 0.04;
  return {
    ring: blk[0], x0, x1, z0, z1, cx, cz, rx: (x1 - x0) * 0.27, rz: (z1 - z0) * 0.2,
    walks: [[x0, z0], [x1, z0], [x0, z1], [x1, z1], [cx, z0], [cx, z1]].map((p) => [p, [cx, cz]]),
    fountain: [cx, z0 + (z1 - z0) * 0.2],
  };
}

function paintSpawnPark(c, map, toPx, s) {
  const P = spawnParkLayout(map);
  if (!P) return;
  c.save();
  ringPath(c, P.ring, toPx);
  c.clip();
  c.strokeStyle = PATH;
  c.lineCap = 'round';
  c.lineWidth = 4 * s;
  for (const [a, b] of P.walks) {
    c.beginPath(); c.moveTo(...toPx(...a)); c.lineTo(...toPx(...b)); c.stroke();
  }
  const [px, pz] = toPx(P.cx, P.cz);
  c.fillStyle = GRASS;
  c.beginPath(); c.ellipse(px, pz, P.rx * s, P.rz * s, 0, 0, Math.PI * 2); c.fill(); c.stroke();
  const [fx, fz] = toPx(...P.fountain);
  c.fillStyle = PATH;
  c.beginPath(); c.arc(fx, fz, 9 * s, 0, Math.PI * 2); c.fill();
  c.fillStyle = '#5ea0d0';
  c.beginPath(); c.arc(fx, fz, 6 * s, 0, Math.PI * 2); c.fill();
  c.restore();
}

function segHit(a, b, p, q) {
  const rx = b[0] - a[0], rz = b[1] - a[1], sx = q[0] - p[0], sz = q[1] - p[1];
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-6) return null;
  const t = ((p[0] - a[0]) * sz - (p[1] - a[1]) * sx) / den, u = ((p[0] - a[0]) * rz - (p[1] - a[1]) * rx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? [a[0] + rx * t, a[1] + rz * t] : null;
}
const segsOf = (flat) => { const o = []; for (let i = 0; i + 3 < flat.length; i += 2) o.push([[flat[i], flat[i + 1]], [flat[i + 2], flat[i + 3]]]); return o; };

// NYC paint: white dashed lane lines, double yellow on two-way streets, zebra crossings on both
// sides of every intersection.
function paintRoads(c, map, toPx, s) {
  const strip = (a, b, off, color, dash, width) => {
    const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1, nx = -dz / l, nz = dx / l;
    c.strokeStyle = color;
    c.lineWidth = width * s;
    c.setLineDash(dash ? [3 * s, 4.5 * s] : []);
    c.beginPath();
    c.moveTo(...toPx(a[0] + nx * off, a[1] + nz * off));
    c.lineTo(...toPx(b[0] + nx * off, b[1] + nz * off));
    c.stroke();
  };
  c.save();
  for (const [, w, dir, lanes, pts] of map.roads) {
    const n = Math.max(1, lanes);
    for (const [a, b] of segsOf(pts)) {
      for (let k = 1; k < n; k++) {
        const off = -w / 2 + (w * k) / n;
        if (dir === 2 && Math.abs(off) < 0.5) continue;
        strip(a, b, off, 'rgba(240,240,235,0.85)', true, 0.15);
      }
      if (dir === 2) { strip(a, b, 0.18, '#e8c547', false, 0.14); strip(a, b, -0.18, '#e8c547', false, 0.14); }
    }
  }
  c.setLineDash([]);
  // crossings: find where centrelines of different streets cross, zebra across each road there
  c.fillStyle = 'rgba(240,240,235,0.9)';
  const roads = map.roads.map(([name, w, , , pts]) => ({ name, w, segs: segsOf(pts) }));
  for (let i = 0; i < roads.length; i++) for (let j = i + 1; j < roads.length; j++) {
    const A = roads[i], B = roads[j];
    if (A.name === B.name) continue;
    for (const sa of A.segs) for (const sb of B.segs) {
      const p = segHit(sa[0], sa[1], sb[0], sb[1]);
      if (!p) continue;
      for (const [road, seg, other] of [[A, sa, B], [B, sb, A]]) {
        const dx = seg[1][0] - seg[0][0], dz = seg[1][1] - seg[0][1], l = Math.hypot(dx, dz) || 1;
        const ux = dx / l, uz = dz / l;
        for (const side of [-1, 1]) {
          const d = other.w / 2 + 3.5;
          const [px, pz] = toPx(p[0] + ux * d * side, p[1] + uz * d * side);
          c.save();
          c.translate(px, pz);
          c.rotate(Math.atan2(uz, ux));
          for (let o = -road.w / 2 + 0.4; o < road.w / 2 - 0.4; o += 1.2) c.fillRect(-1.5 * s, o * s, 3 * s, 0.6 * s);
          c.restore();
        }
      }
    }
  }
  c.restore();
}

export function paintRealMap(c, map, toPx, s, detail) {
  if (detail) {
    paintRoads(c, map, toPx, s);
    paintBlocks(c, map, toPx, s);
    paintSpawnPark(c, map, toPx, s);
    return;
  }
  c.fillStyle = WATER;
  c.fillRect(0, 0, c.canvas.width, c.canvas.height);
  for (const [name, ring] of map.land) {
    ringPath(c, ring, toPx);
    c.fillStyle = name === 'manhattan' || name === 'roosevelt' ? '#4b4e56' : '#8d877d';
    c.fill();
  }
  paintBlocks(c, map, toPx, s);
}

// Static ring round the deformable ground: 2 m per pixel over 4 km.
function realOuterGround(map) {
  const SIZE = 4096, PX = 2048;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = PX;
  const k = PX / SIZE;
  paintRealMap(canvas.getContext('2d'), map, (x, z) => [(x + SIZE / 2) * k, (z + SIZE / 2) * k], k, false);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const geo = ringGround(-SIZE / 2, SIZE / 2, -SIZE / 2, SIZE / 2, GROUND_SIZE / 2);
  const mesh = new THREE.Mesh(geo, new THREE.MeshToonMaterial({ map: tex, gradientMap: gradientMap(3) }));
  mesh.position.y = -0.05;
  mesh.receiveShadow = true;
  mesh.name = 'outer-ground';
  return mesh;
}
