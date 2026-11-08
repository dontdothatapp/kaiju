// Real Manhattan downtown: surveyed footprints and roof heights (src/world/maps/*.json, cut by
// tools/extract-nyc-map.mjs) dropped onto the destruction engine's cells.
//
// Footprints are rasterised on one shared 3 m grid, tallest first, so neighbours tile without
// overlapping. Each building gets 1 m wall strips only on the cell sides where it has a face, so
// wedges (the Flatiron) and L-shapes keep the procedural city's wall / corner / slab anatomy.
// Party walls stay out while a neighbour hides them and turn into blank brick above its roof.
// Big pre-war towers step back as they rise (1916 zoning). Everything past the arena edge is a
// static instanced skyline built from the same footprints, plus a hand-built Empire State.
import * as THREE from 'three';
import { makeRng } from '../core/math.js';
import { KIND } from './structures.js';
import { STYLE } from './chunkMaterial.js';
import { CITY, PALETTES, WIN, addSkylineMesh } from './city.js';
import { ARENA } from './boundary.js';

const C = CITY.CELL, WT = CITY.WT, F = CITY.FLOOR;
// Chunk budget per quality: above `tall` storeys a building uses double-storey chunks; facade
// panels pair up to `run` cells wide; floor tiles reach `slab` metres. Windows stay per 3 m x 3.6 m.
const BUDGET = {
  high: { tall: 12, run: 2, slab: 12.1 },
  medium: { tall: 12, run: 2, slab: 12.1 },
  low: { tall: 4, run: 3, slab: 18.1 },
};
const key = (i, k) => (i + 32768) * 65536 + (k + 32768);

export async function loadMap(id) {
  const maps = { flatiron: () => import('./maps/flatiron.json') };
  if (!maps[id]) throw new Error(`Unknown map "${id}"`);
  return (await maps[id]()).default;
}

// ---------------------------------------------------------------- geometry helpers
export function inRing(r, x, z) {
  let inside = false;
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
    const xi = r[i], zi = r[i + 1], xj = r[j], zj = r[j + 1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
const inPolygons = (polys, x, z) => polys.some((rings) => inRing(rings[0], x, z) && !rings.slice(1).some((h) => inRing(h, x, z)));

// greedy cover of a cell mask with rectangles [i0, k0, i1, k1] (inclusive cell ranges)
function rectsOf(mask, w, h) {
  const left = mask.slice();
  const out = [];
  for (let k = 0; k < h; k++) for (let i = 0; i < w; i++) {
    if (!left[k * w + i]) continue;
    let i1 = i;
    while (i1 + 1 < w && left[k * w + i1 + 1]) i1++;
    let k1 = k;
    grow: while (k1 + 1 < h) {
      for (let t = i; t <= i1; t++) if (!left[(k1 + 1) * w + t]) break grow;
      k1++;
    }
    for (let kk = k; kk <= k1; kk++) for (let t = i; t <= i1; t++) left[kk * w + t] = 0;
    out.push([i, k, i1, k1]);
  }
  return out;
}

// square erosion: a cell survives if every cell within r of it is set
function erode(mask, w, h, r) {
  const out = new Uint8Array(w * h);
  for (let k = r; k < h - r; k++) for (let i = r; i < w - r; i++) {
    let ok = true;
    for (let dk = -r; dk <= r && ok; dk++) for (let di = -r; di <= r; di++) if (!mask[(k + dk) * w + i + di]) { ok = false; break; }
    out[k * w + i] = ok ? 1 : 0;
  }
  return out;
}
const count = (mask) => mask.reduce((a, v) => a + v, 0);

// ---------------------------------------------------------------- footprints -> cells
function prepare(map) {
  const list = map.buildings.map(([height, year, polys], index) => {
    const pts = polys.flat(2);
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < pts.length; i += 2) {
      minX = Math.min(minX, pts[i]); maxX = Math.max(maxX, pts[i]);
      minZ = Math.min(minZ, pts[i + 1]); maxZ = Math.max(maxZ, pts[i + 1]);
    }
    return { index, height, year, polys, minX, maxX, minZ, maxZ };
  });
  const owner = new Map();
  const order = list.slice().sort((a, b) => b.height - a.height);
  for (const b of order) {
    const i0 = Math.floor(b.minX / C), k0 = Math.floor(b.minZ / C);
    const w = Math.ceil(b.maxX / C) - i0, h = Math.ceil(b.maxZ / C) - k0;
    const mask = new Uint8Array(w * h);
    for (let k = 0; k < h; k++) for (let i = 0; i < w; i++) {
      const kk = key(i0 + i, k0 + k);
      if (owner.has(kk) || !inPolygons(b.polys, (i0 + i + 0.5) * C, (k0 + k + 0.5) * C)) continue;
      owner.set(kk, b.index);
      mask[k * w + i] = 1;
    }
    b.grid = { i0, k0, w, h, mask, n: count(mask) };
  }
  return { list, owner };
}

function pickStyle(b, floors, rng) {
  const y = b.year || rng.pick([1900, 1920, 1960, 2000]);
  if (y >= 1990 && floors >= 12) return rng() < 0.75 ? STYLE.GLASS : STYLE.STRIP;
  if (y >= 1950) return rng() < 0.45 ? STYLE.STRIP : rng() < 0.6 ? STYLE.OFFICE : STYLE.GLASS;
  if (floors >= 10) return rng() < 0.65 ? STYLE.OFFICE : STYLE.BRICK;
  return rng() < 0.7 ? STYLE.BRICK : STYLE.OFFICE;
}

// 1916 zoning "wedding cakes": big pre-war towers step back as they rise
function makeTiers(b, floors, rng) {
  const { w, h, mask, n } = b.grid;
  const tiers = [{ mask, top: floors }];
  if (!(b.year && b.year <= 1950 && floors >= 18 && n >= 120)) return tiers;
  const minDim = Math.min(w, h);
  const r1 = Math.max(2, Math.round(minDim * 0.18)), r2 = r1 + Math.max(2, Math.round(minDim * 0.15));
  const m1 = erode(mask, w, h, r1);
  if (count(m1) < 24) return tiers;
  tiers[0].top = Math.round(floors * rng.range(0.4, 0.55));
  tiers.push({ mask: m1, top: floors });
  const m2 = erode(mask, w, h, r2);
  if (floors >= 30 && count(m2) >= 12) {
    tiers[1].top = Math.round(floors * rng.range(0.72, 0.84));
    tiers.push({ mask: m2, top: floors });
  }
  return tiers;
}

// ---------------------------------------------------------------- one destructible building
function buildFootprint(D, rng, b, ctx) {
  const { i0, k0, w, h, mask: base } = b.grid;
  // Real Manhattan is dense: past ctx.tall storeys a building gets 7.2 m chunks (windows still
  // every 3.6 m) to keep the chunk count near the procedural city's. `floors` counts chunk levels.
  const sy = b.floors > ctx.tall ? 2 * F : F;
  const floors = Math.max(1, Math.round(b.floors * F / sy));
  const tiers = makeTiers(b, floors, rng);
  const tierAt = (y) => tiers.find((t) => y < t.top) || tiers[tiers.length - 1];
  const inside = (ci, ck) => ci >= 0 && ck >= 0 && ci < w && ck < h;

  // What the face of cell (ci, ck) toward (dx, dz) shows at a storey whose top is at `top` m:
  // 0 nothing (own cell, or a neighbour hiding it), 1 facade (street, plaza, own terrace), 2 party
  // wall: blank brick on walk-ups and lofts; towers have windows once they clear the neighbour
  const lowRise = b.floors <= 12;
  const face = (mask, ci, ck, dx, dz, top) => {
    const x = ci + dx, z = ck + dz;
    if (inside(x, z) && mask[z * w + x]) return 0;
    if (inside(x, z) && base[z * w + x]) return 1;
    const o = ctx.owner.get(key(i0 + x, k0 + z));
    const nb = o === undefined ? null : ctx.list[o];
    if (!nb || !nb.built) return 1;
    return nb.height >= top - 0.5 ? 0 : lowRise ? 2 : 1;
  };

  // 1 m wall strips on the column / row sides that have a face on some storey
  const hasL = new Uint8Array(w), hasR = new Uint8Array(w), hasT = new Uint8Array(h), hasB = new Uint8Array(h);
  for (const t of tiers) {
    const top = t.top * sy;
    for (let ck = 0; ck < h; ck++) for (let ci = 0; ci < w; ci++) {
      if (!t.mask[ck * w + ci]) continue;
      if (face(t.mask, ci, ck, -1, 0, top)) hasL[ci] = 1;
      if (face(t.mask, ci, ck, 1, 0, top)) hasR[ci] = 1;
      if (face(t.mask, ci, ck, 0, -1, top)) hasT[ck] = 1;
      if (face(t.mask, ci, ck, 0, 1, top)) hasB[ck] = 1;
    }
  }
  const strips = (n, lo, hi) => {
    const bounds = [0], fine = [];
    for (let c = 0; c < n; c++) {
      const e = { lo: -1, hi: -1, mid: -1, all: [] };
      if (lo[c]) { e.lo = bounds.length - 1; bounds.push(c * C + WT); }
      e.mid = bounds.length - 1;
      if (hi[c]) { bounds.push((c + 1) * C - WT); e.hi = bounds.length - 1; }
      bounds.push((c + 1) * C);
      e.all = [e.lo, e.mid, e.hi].filter((v) => v >= 0);
      fine.push(e);
    }
    return { bounds, fine };
  };
  const { bounds: xs, fine: fx } = strips(w, hasL, hasR);
  const { bounds: zs, fine: fz } = strips(h, hasT, hasB);
  const nfx = xs.length - 1, nfz = zs.length - 1;

  const roof = tiers[tiers.length - 1];
  const crown = b.crown && b.floors > 20 ? { ...b.crown, levels: Math.round(b.crown.levels * F / sy) } : null;
  const s = D.addStructure({ origin: new THREE.Vector3(i0 * C, 0, k0 * C), xs, zs, ny: floors + 1 + (crown ? crown.levels : 0), sy });
  s.name = b.name || null; // landmarks get called out when they come down

  // looks
  const style = b.style ?? pickStyle(b, b.floors, rng);
  const pal = PALETTES[style];
  const baseCol = b.color ? new THREE.Color(b.color) : new THREE.Color(rng.pick(pal));
  const accent = baseCol.clone().multiplyScalar(0.72);
  const party = new THREE.Color(rng.pick(PALETTES[STYLE.BRICK])).multiplyScalar(0.85);
  const [ww, wh] = WIN[style];
  const col = (k = 1) => baseCol.clone().multiplyScalar(k * (0.96 + rng() * 0.08));
  const cellsOf = (y, x0, x1, z0, z1) => {
    const cells = [];
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) cells.push(s.ci(x, y, z));
    return cells;
  };

  for (let y = 0; y < floors; y++) {
    const tier = tierAt(y), mask = tier.mask;
    const y0 = y * sy, y1 = y0 + sy, topY = y1;
    const ground = y === 0;
    const st = ground ? [Math.min(0.9, ww + 0.15), 0.7, style === STYLE.BRICK ? STYLE.OFFICE : style] : [ww, wh, style];
    const slab = new Uint8Array(nfx * nfz);
    // walls are collected per facade line, then neighbouring panels pair up below
    const runs = new Map();
    const wall = (alongX, fixed, a0, a1, kind) => {
      const k = `${alongX ? 'x' : 'z'}${fixed}:${kind}`;
      if (!runs.has(k)) runs.set(k, []);
      runs.get(k).push([a0, a1]);
    };
    const corner = (x, z) => D.addChunk(s, {
      x0: xs[x], x1: xs[x + 1], y0, y1, z0: zs[z], z1: zs[z + 1], kind: KIND.CORNER, level: y,
      color: col(0.92), style: [0, 0, STYLE.CONCRETE], cells: [s.ci(x, y, z)],
    });
    for (let ck = 0; ck < h; ck++) for (let ci = 0; ci < w; ci++) {
      if (!mask[ck * w + ci]) continue;
      const ex = fx[ci], ez = fz[ck];
      const L = ex.lo >= 0 ? face(mask, ci, ck, -1, 0, topY) : 0;
      const R = ex.hi >= 0 ? face(mask, ci, ck, 1, 0, topY) : 0;
      const T = ez.lo >= 0 ? face(mask, ci, ck, 0, -1, topY) : 0;
      const B = ez.hi >= 0 ? face(mask, ci, ck, 0, 1, topY) : 0;
      const cx0 = L ? ex.mid : ex.all[0], cx1 = R ? ex.mid : ex.all[ex.all.length - 1];
      const cz0 = T ? ez.mid : ez.all[0], cz1 = B ? ez.mid : ez.all[ez.all.length - 1];
      if (L && T) corner(ex.lo, ez.lo);
      if (R && T) corner(ex.hi, ez.lo);
      if (L && B) corner(ex.lo, ez.hi);
      if (R && B) corner(ex.hi, ez.hi);
      if (L) wall(false, ex.lo, cz0, cz1, L);
      if (R) wall(false, ex.hi, cz0, cz1, R);
      if (T) wall(true, ez.lo, cx0, cx1, T);
      if (B) wall(true, ez.hi, cx0, cx1, B);
      for (let z = cz0; z <= cz1; z++) for (let x = cx0; x <= cx1; x++) slab[z * nfx + x] = 1;
    }
    // Neighbouring panels on a straight facade merge into one wider panel (2-3 cells) that still
    // draws a window every cell: the biggest chunk saving on real blocks, which are all facade.
    for (const [k, segs] of runs) {
      const alongX = k[0] === 'x';
      const [fixed, kind] = k.slice(1).split(':').map(Number);
      const arr = alongX ? xs : zs;
      segs.sort((p, q) => p[0] - q[0]);
      for (let i = 0; i < segs.length; i++) {
        let [a0, a1] = segs[i];
        let n = 1;
        while (n < ctx.run && segs[i + 1] && segs[i + 1][0] === a1 + 1 && arr[segs[i + 1][1] + 1] - arr[a0] <= ctx.run * C + 0.01) {
          a1 = segs[++i][1];
          n++;
        }
        const [x0, x1, z0, z1] = alongX ? [a0, a1, fixed, fixed] : [fixed, fixed, a0, a1];
        const len = arr[a1 + 1] - arr[a0];
        D.addChunk(s, {
          x0: xs[x0], x1: xs[x1 + 1], y0, y1, z0: zs[z0], z1: zs[z1 + 1], kind: KIND.WALL, level: y,
          color: kind === 2 ? party.clone() : ground ? accent.clone() : col(),
          style: kind === 2 ? [0, 0, STYLE.BRICK] : st, cells: cellsOf(y, x0, x1, z0, z1),
          cell: n > 1 || sy > F ? new THREE.Vector3(alongX ? len / n : xs[x1 + 1] - xs[x0], F, alongX ? zs[z1 + 1] - zs[z0] : len / n) : null,
        });
      }
    }
    // ceiling slabs: the rest of each storey, merged into tiles of up to ctx.slab metres
    const SL = 0.42;
    for (let z = 0; z < nfz; z++) for (let x = 0; x < nfx; x++) {
      if (!slab[z * nfx + x]) continue;
      let x1 = x;
      while (x1 + 1 < nfx && slab[z * nfx + x1 + 1] && xs[x1 + 2] - xs[x] <= ctx.slab) x1++;
      let z1 = z;
      grow: while (z1 + 1 < nfz && zs[z1 + 2] - zs[z] <= ctx.slab) {
        for (let t = x; t <= x1; t++) if (!slab[(z1 + 1) * nfx + t]) break grow;
        z1++;
      }
      for (let zz = z; zz <= z1; zz++) for (let t = x; t <= x1; t++) slab[zz * nfx + t] = 0;
      D.addChunk(s, {
        x0: xs[x] + 0.02, x1: xs[x1 + 1] - 0.02, y0: y1 - SL, y1: y1 - 0.01, z0: zs[z] + 0.02, z1: zs[z1 + 1] - 0.02,
        kind: KIND.SLAB, level: y, color: new THREE.Color(0xb9b2a6), style: [0, 0, STYLE.SLAB], cells: cellsOf(y, x, x1, z, z1),
      });
    }
  }

  // roof: a pyramid crown on the landmark towers, otherwise AC units and NYC water tanks
  const yTop = floors * sy;
  const roofCells = [];
  for (let ck = 1; ck < h - 1; ck++) for (let ci = 1; ci < w - 1; ci++) {
    const m = roof.mask;
    if (m[ck * w + ci] && m[ck * w + ci - 1] && m[ck * w + ci + 1] && m[(ck - 1) * w + ci] && m[(ck + 1) * w + ci]) roofCells.push([ci, ck]);
  }
  const span = (ci0, ci1, ck0, ck1) => [fx[ci0].all[0], fx[ci1].all[fx[ci1].all.length - 1], fz[ck0].all[0], fz[ck1].all[fz[ck1].all.length - 1]];
  if (crown) {
    let [ri0, rk0, ri1, rk1] = rectsOf(roof.mask, w, h).sort((a, b) => (b[2] - b[0] + 1) * (b[3] - b[1] + 1) - (a[2] - a[0] + 1) * (a[3] - a[1] + 1))[0];
    // a pyramid wants a square base: centre one on the roof's biggest rectangle
    const side = Math.min(ri1 - ri0, rk1 - rk0);
    ri0 += Math.floor((ri1 - ri0 - side) / 2); ri1 = ri0 + side;
    rk0 += Math.floor((rk1 - rk0 - side) / 2); rk1 = rk0 + side;
    const gold = new THREE.Color(crown.color);
    for (let j = 0; j < crown.levels; j++) {
      const shrink = Math.min(j, Math.floor((Math.min(ri1 - ri0, rk1 - rk0)) / 2));
      const spire = j >= crown.levels - 2;
      const [x0, x1, z0, z1] = span(ri0 + shrink, ri1 - shrink, rk0 + shrink, rk1 - shrink);
      const inset = spire ? (xs[x1 + 1] - xs[x0]) / 2 - 0.6 : 0.1;
      const insetZ = spire ? (zs[z1 + 1] - zs[z0]) / 2 - 0.6 : 0.1;
      D.addChunk(s, {
        x0: xs[x0] + inset, x1: xs[x1 + 1] - inset, y0: yTop + j * sy, y1: yTop + (j + 1) * sy, z0: zs[z0] + insetZ, z1: zs[z1 + 1] - insetZ,
        kind: KIND.SOLID, level: floors + j, color: gold.clone().multiplyScalar(1 - j * 0.03),
        style: [0, 0, STYLE.CONCRETE], cells: cellsOf(floors + j, x0, x1, z0, z1),
      });
    }
  } else {
    const oldWalkup = b.year && b.year < 1960 && b.floors >= 5 && b.floors <= 25;
    const nProps = Math.min(roofCells.length, rng.int(roofCells.length > 6 ? 1 : 0, 3));
    for (let p = 0; p < nProps; p++) {
      const [ci, ck] = rng.pick(roofCells);
      const [x0, x1, z0, z1] = span(ci, ci, ck, ck);
      if (s.cells[s.ci(x0, floors, z0)] >= 0) continue;
      const tank = oldWalkup && p === 0;
      const hgt = tank ? 4.2 : rng.range(1.2, 2.2);
      D.addChunk(s, {
        x0: xs[x0] + 0.4, x1: xs[x1 + 1] - 0.4, y0: yTop, y1: yTop + hgt, z0: zs[z0] + 0.4, z1: zs[z1 + 1] - 0.4,
        kind: KIND.SOLID, level: floors, color: new THREE.Color(tank ? 0x8b6b4a : 0x9da3a6),
        style: [0, 0, STYLE.CONCRETE], cells: cellsOf(floors, x0, x1, z0, z1),
      });
    }
  }

  // intact colliders: one box per rectangle of each setback tier
  s.intactBoxes = [];
  let floor = 0;
  for (const t of tiers) {
    for (const [a, c, e, g] of rectsOf(t.mask, w, h)) {
      s.intactBoxes.push([(i0 + a) * C, floor * sy, (k0 + c) * C, (i0 + e + 1) * C, t.top * sy, (k0 + g + 1) * C]);
    }
    floor = t.top;
  }
  return s;
}

// ---------------------------------------------------------------- landmarks
// Real heights from the survey; these just get their famous colours and crowns.
function tagLandmarks(map, list) {
  const flat = map.landmarks['Flatiron Building'];
  for (const b of list) {
    const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
    if (flat && inRing(flat.ring, cx, cz)) Object.assign(b, { name: 'The Flatiron Building', style: STYLE.OFFICE, color: 0xd9c9ab });
    // Metropolitan Life Insurance Company Tower (1909): white marble shaft, gilded pyramid and lantern
    if (b.year === 1910 && b.height > 150) Object.assign(b, { name: 'The Met Life Tower', style: STYLE.OFFICE, color: 0xe9e4d8, crown: { levels: 8, color: 0xc9a43c } });
    // New York Life Building (1928): limestone setbacks under a gold pyramid
    if (b.year === 1930 && b.height > 140 && cz < 0) Object.assign(b, { name: 'The New York Life Building', style: STYLE.OFFICE, color: 0xd8d0bf, crown: { levels: 9, color: 0xd4af37 } });
  }
}

// The Empire State Building isn't in the survey (Slop New York models it by hand too): stacked
// setbacks on its real lot, lot-centred, to the 102nd-floor observatory, mast and antenna.
function empireState(map) {
  const l = map.landmarks['Empire State Building'];
  if (!l) return [];
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < l.ring.length; i += 2) {
    x0 = Math.min(x0, l.ring[i]); x1 = Math.max(x1, l.ring[i]);
    z0 = Math.min(z0, l.ring[i + 1]); z1 = Math.max(z1, l.ring[i + 1]);
  }
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, W = x1 - x0, Dd = z1 - z0;
  const lime = new THREE.Color(0xd9d3c4), steel = new THREE.Color(0xb9bcc0);
  // podium, 1930s setbacks, the long shaft, then the 72nd / 81st / 86th-floor steps and crown
  const tiers = [
    [W, Dd, 0, 25], [W * 0.7, Dd * 0.8, 25, 90], [W * 0.56, Dd * 0.7, 90, 110], [W * 0.44, Dd * 0.62, 110, 265],
    [W * 0.36, Dd * 0.52, 265, 300], [W * 0.26, Dd * 0.4, 300, 320], [W * 0.17, Dd * 0.28, 320, 350], [W * 0.1, Dd * 0.17, 350, 373],
  ];
  const items = tiers.map(([w, d, y0, y1], i) => ({
    x: cx, z: cz, w, d, h: y1 - y0, y: y0, style: STYLE.OFFICE, color: lime.clone().multiplyScalar(1 - i * 0.015), beacon: false,
  }));
  items.push({ x: cx, z: cz, w: 6, d: 6, h: 30, y: 373, style: STYLE.SLAB, color: steel, beacon: false });
  items.push({ x: cx, z: cz, w: 1.6, d: 1.6, h: 40, y: 403, style: STYLE.SLAB, color: steel, beacon: true });
  return items;
}

// ---------------------------------------------------------------- the map
export function generateRealCity(D, scene, map, seed, quality) {
  const rng = makeRng(seed);
  const { list, owner } = prepare(map);
  tagLandmarks(map, list);
  // destructible: anything reachable inside the arena; the rest joins the skyline
  const reach = ARENA + 2;
  const arena = list.filter((b) => b.grid.n > 0 && b.maxX > -reach && b.minX < reach && b.maxZ > -reach && b.minZ < reach);
  const floorsOf = (b) => Math.max(1, Math.round(b.height / F));
  for (const b of list) b.built = b.grid.n > 0;
  for (const b of arena) { b.floors = floorsOf(b); b.destructible = true; }
  // low quality: cap destructible towers (their real height stays in the skyline beyond the arena)
  if (quality === 'low') for (const b of arena) if (b.floors > 30) { b.floors = 30; b.height = 30 * F; }
  const budget = BUDGET[quality] || BUDGET.high;
  for (const b of arena) buildFootprint(D, rng, b, { owner, list, ...budget });

  const items = [];
  const styleOf = (b) => pickStyle(b, Math.round(b.h / F), rng);
  for (const b of list) {
    if (b.destructible || !b.grid.n) continue;
    const { i0, k0, w, h, mask } = b.grid;
    const rects = rectsOf(mask, w, h);
    const style = b.style ?? styleOf({ year: b.year, h: b.height });
    const color = new THREE.Color(b.color ?? rng.pick(PALETTES[style]));
    rects.forEach(([a, c, e, g], n) => items.push({
      x: (i0 + (a + e + 1) / 2) * C, z: (k0 + (c + g + 1) / 2) * C, w: (e - a + 1) * C, d: (g - c + 1) * C, h: b.height,
      style, color, beacon: n === 0 && b.height > 85,
    }));
  }
  for (const [h, year, rects] of map.skyline) {
    const style = styleOf({ year, h });
    const color = new THREE.Color(rng.pick(PALETTES[style]));
    for (let i = 0; i < rects.length; i += 4) {
      const [x0, z0, x1, z1] = rects.slice(i, i + 4);
      items.push({ x: (x0 + x1) / 2, z: (z0 + z1) / 2, w: x1 - x0, d: z1 - z0, h, style, color, beacon: i === 0 && h > 85 });
    }
  }
  items.push(...empireState(map));
  addSkylineMesh(scene, D, items, rng);

  // where the fighters land at the start of a round (the title camera orbits the player's spot),
  // what the establishing shot looks at, and its location card
  const at = ([x, z], y = 0) => new THREE.Vector3(x, y, z);
  const landing = { heir: at(map.landing.heir), patriarch: at(map.landing.patriarch) };
  return {
    real: true, map, track: map.track, parkCenter: landing.heir.clone(), landing,
    vista: at(map.vista, 160), caption: map.caption,
  };
}
