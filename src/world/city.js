// Procedural downtown: a grid of blocks with destructible buildings, a central park and a
// non-destructible skyline ring for scale.
import * as THREE from 'three';
import { makeRng } from '../core/math.js';
import { KIND } from './structures.js';
import { STYLE, addChunkAttributes } from './chunkMaterial.js';

export const CITY = { BLOCKS: 6, PITCH: 76, STREET: 22, SIDEWALK: 3.5, WT: 1.0, CELL: 3, FLOOR: 3.6 };
export const CITY_HALF = (CITY.BLOCKS * CITY.PITCH) / 2;
export const PARK = { i: 2, j: 2 };

export const PALETTES = {
  [STYLE.GLASS]: [0x55657a, 0x2f3d52, 0xb9c4cc, 0x6f7f74, 0x8a8f99],
  [STYLE.OFFICE]: [0xdccfbc, 0xc7b393, 0xe6e0d4, 0xb6a690, 0xd8c3a5],
  [STYLE.BRICK]: [0xa5523d, 0x8e4a3a, 0xb7684a, 0x9c5f45, 0x7d4436],
  [STYLE.STRIP]: [0xeeeeea, 0xbfc3c4, 0xd7d0c4, 0x9fa6ab],
};
export const WIN = {
  [STYLE.GLASS]: [0.9, 0.82],
  [STYLE.OFFICE]: [0.62, 0.5],
  [STYLE.BRICK]: [0.36, 0.45],
  [STYLE.STRIP]: [1.0, 0.32],
};

export function blockRect(i, j) {
  const x0 = -CITY_HALF + i * CITY.PITCH + CITY.STREET / 2;
  const z0 = -CITY_HALF + j * CITY.PITCH + CITY.STREET / 2;
  return { x0, z0, x1: x0 + CITY.PITCH - CITY.STREET, z1: z0 + CITY.PITCH - CITY.STREET };
}

export function generateCity(destruction, scene, seed, quality) {
  const rng = makeRng(seed);
  const layout = { blocks: [], streets: [], lots: [], parkCenter: null };
  for (let i = 0; i <= CITY.BLOCKS; i++) {
    const c = -CITY_HALF + i * CITY.PITCH;
    layout.streets.push({ x0: c, z0: -CITY_HALF - 40, x1: c, z1: CITY_HALF + 40 });
    layout.streets.push({ x0: -CITY_HALF - 40, z0: c, x1: CITY_HALF + 40, z1: c });
  }
  const floorScale = quality === 'low' ? 0.6 : 1;

  for (let i = 0; i < CITY.BLOCKS; i++) {
    for (let j = 0; j < CITY.BLOCKS; j++) {
      const r = blockRect(i, j);
      const park = i === PARK.i && j === PARK.j;
      layout.blocks.push({ ...r, park });
      if (park) {
        layout.parkCenter = new THREE.Vector3((r.x0 + r.x1) / 2, 0, (r.z0 + r.z1) / 2);
        continue;
      }
      const cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2;
      const dist = Math.hypot(cx, cz);
      const downtown = Math.max(0, 1 - dist / 230);
      const ux0 = r.x0 + CITY.SIDEWALK, uz0 = r.z0 + CITY.SIDEWALK;
      const usable = r.x1 - r.x0 - CITY.SIDEWALK * 2; // ~47m
      const plan = downtown > 0.55 ? (rng() < 0.75 ? 'tower' : 'pair') : downtown > 0.25 ? (rng() < 0.6 ? 'pair' : 'quad') : (rng() < 0.3 ? 'pair' : 'quad');
      const lots = [];
      if (plan === 'tower') {
        const k = rng.int(8, 11);
        lots.push({ x: ux0 + (usable - fw(k)) / 2, z: uz0 + (usable - fw(k)) / 2, kx: k, kz: rng.int(8, 11), floors: Math.round(rng.int(22, 34) * floorScale), tiers: true });
      } else if (plan === 'pair') {
        const kz = rng.int(9, 13);
        const kx = rng.int(4, 6);
        const horizontal = rng() < 0.5;
        for (let p = 0; p < 2; p++) {
          const off = p * (usable / 2) + (usable / 2 - fw(kx)) / 2;
          const lot = { kx, kz, floors: Math.round(rng.int(8, 14 + Math.floor(downtown * 14)) * floorScale), tiers: rng() < 0.3 };
          if (horizontal) { lot.x = ux0 + off; lot.z = uz0 + (usable - fw(kz)) / 2; }
          else { [lot.kx, lot.kz] = [kz, kx]; lot.z = uz0 + off; lot.x = ux0 + (usable - fw(kz)) / 2; }
          lots.push(lot);
        }
      } else {
        for (let p = 0; p < 4; p++) {
          const kx = rng.int(3, 5), kz = rng.int(3, 5);
          const qx = p % 2, qz = Math.floor(p / 2);
          lots.push({
            x: ux0 + qx * (usable / 2) + (usable / 2 - fw(kx)) / 2,
            z: uz0 + qz * (usable / 2) + (usable / 2 - fw(kz)) / 2,
            kx, kz, floors: Math.round(rng.int(4, 9 + Math.floor(downtown * 8)) * floorScale), tiers: false,
          });
        }
      }
      for (const lot of lots) {
        const style = plan === 'tower' ? (rng() < 0.6 ? STYLE.GLASS : rng() < 0.5 ? STYLE.OFFICE : STYLE.STRIP)
          : plan === 'pair' ? rng.pick([STYLE.OFFICE, STYLE.STRIP, STYLE.GLASS, STYLE.BRICK])
          : rng.pick([STYLE.BRICK, STYLE.BRICK, STYLE.OFFICE, STYLE.STRIP]);
        buildBuilding(destruction, rng, { ...lot, floors: Math.max(3, lot.floors), style });
        layout.lots.push(lot);
      }
    }
  }
  // the ring of blocks just outside the core is visible on the deformable floor, paint it too
  for (let i = -1; i <= CITY.BLOCKS; i++) for (let j = -1; j <= CITY.BLOCKS; j++) {
    if (i >= 0 && i < CITY.BLOCKS && j >= 0 && j < CITY.BLOCKS) continue;
    layout.blocks.push({ ...blockRect(i, j), park: false, outer: true });
  }
  createSkyline(scene, destruction.material, rng);
  // round intro (game/intro.js): your kaiju lands in the park, the other one on the intersection
  // at its corner, and the establishing shot looks across downtown
  const h = CITY.PITCH / 2;
  layout.landing = { heir: layout.parkCenter.clone(), patriarch: layout.parkCenter.clone().add(new THREE.Vector3(h, 0, h)) };
  layout.vista = new THREE.Vector3(0, 60, 0);
  layout.caption = ['DOWNTOWN', 'Somewhere it was quiet this morning'];
  return layout;
}

const fw = (k) => k * CITY.CELL + 2 * CITY.WT;

function buildBuilding(D, rng, lot) {
  const { kx, kz, floors, style } = lot;
  const nx = kx + 2, nz = kz + 2;
  const xs = [0, CITY.WT];
  for (let i = 0; i < kx; i++) xs.push(xs[xs.length - 1] + CITY.CELL);
  xs.push(xs[xs.length - 1] + CITY.WT);
  const zs = [0, CITY.WT];
  for (let i = 0; i < kz; i++) zs.push(zs[zs.length - 1] + CITY.CELL);
  zs.push(zs[zs.length - 1] + CITY.WT);
  const ny = floors + 1; // + rooftop level
  const s = D.addStructure({ origin: new THREE.Vector3(lot.x, 0, lot.z), xs, zs, ny, sy: CITY.FLOOR });

  // setback tiers: footprint shrinks by whole cells as we go up
  const tiers = [{ x0: 0, z0: 0, x1: nx - 1, z1: nz - 1, top: floors }];
  if (lot.tiers && kx >= 6 && kz >= 6) {
    const t1 = Math.floor(floors * rng.range(0.55, 0.7));
    tiers[0].top = t1;
    tiers.push({ x0: 2, z0: 2, x1: nx - 3, z1: nz - 3, top: floors });
    if (kx >= 9 && kz >= 9 && rng() < 0.6) {
      const t2 = Math.floor(floors * rng.range(0.8, 0.9));
      tiers[1].top = t2;
      tiers.push({ x0: 3, z0: 3, x1: nx - 4, z1: nz - 4, top: floors });
    }
  }
  const pal = PALETTES[style];
  const base = new THREE.Color(rng.pick(pal));
  const accent = base.clone().multiplyScalar(0.72);
  const [ww, wh] = WIN[style];
  const col = (k = 1) => base.clone().multiplyScalar(k * (0.96 + rng() * 0.08));

  let floorTop = 0;
  for (const tier of tiers) {
    const ylo = floorTop, yhi = tier.top;
    for (let y = ylo; y < yhi; y++) {
      const y0 = y * CITY.FLOOR, y1 = y0 + CITY.FLOOR;
      const ground = y === 0;
      const st = ground ? [Math.min(0.9, ww + 0.15), 0.7, style === STYLE.BRICK ? STYLE.OFFICE : style] : [ww, wh, style];
      const c = ground ? accent : null;
      for (let z = tier.z0; z <= tier.z1; z++) for (let x = tier.x0; x <= tier.x1; x++) {
        const edgeX = x === tier.x0 || x === tier.x1, edgeZ = z === tier.z0 || z === tier.z1;
        if (!edgeX && !edgeZ) continue;
        const cell = s.ci(x, y, z);
        let bx0 = xs[x], bx1 = xs[x + 1], bz0 = zs[z], bz1 = zs[z + 1];
        // upper tiers sit on 3m interior cells: make their walls thinner panels at the outer side
        if (tier.x0 > 0) {
          if (edgeX && !edgeZ) { if (x === tier.x0) bx1 = bx0 + CITY.WT * 1.4; else bx0 = bx1 - CITY.WT * 1.4; }
          if (edgeZ && !edgeX) { if (z === tier.z0) bz1 = bz0 + CITY.WT * 1.4; else bz0 = bz1 - CITY.WT * 1.4; }
        }
        const corner = edgeX && edgeZ;
        D.addChunk(s, {
          x0: bx0, x1: bx1, y0, y1, z0: bz0, z1: bz1,
          kind: corner ? KIND.CORNER : KIND.WALL, level: y,
          color: c ? c.clone() : col(corner ? 0.92 : 1),
          style: corner ? [0, 0, STYLE.CONCRETE] : st,
          cells: [cell],
        });
      }
      // ceiling slabs (3x3-cell tiles) over the tier interior
      const SL = 0.42;
      for (let z = tier.z0 + 1; z < tier.z1; z += 3) for (let x = tier.x0 + 1; x < tier.x1; x += 3) {
        const xe = Math.min(x + 2, tier.x1 - 1), ze = Math.min(z + 2, tier.z1 - 1);
        const cells = [];
        for (let zz = z; zz <= ze; zz++) for (let xx = x; xx <= xe; xx++) cells.push(s.ci(xx, y, zz));
        let sx0 = xs[x], sx1 = xs[xe + 1], sz0 = zs[z], sz1 = zs[ze + 1];
        if (tier.x0 > 0) { // reach the thinner upper-tier panels
          if (x === tier.x0 + 1) sx0 -= CITY.CELL - CITY.WT * 1.4;
          if (xe === tier.x1 - 1) sx1 += CITY.CELL - CITY.WT * 1.4;
          if (z === tier.z0 + 1) sz0 -= CITY.CELL - CITY.WT * 1.4;
          if (ze === tier.z1 - 1) sz1 += CITY.CELL - CITY.WT * 1.4;
        }
        D.addChunk(s, {
          x0: sx0 + 0.02, x1: sx1 - 0.02, y0: y1 - SL, y1: y1 - 0.01, z0: sz0 + 0.02, z1: sz1 - 0.02,
          kind: KIND.SLAB, level: y, color: new THREE.Color(0xb9b2a6), style: [0, 0, STYLE.SLAB], cells,
        });
      }
    }
    floorTop = tier.top;
  }
  // rooftop clutter: AC units, a water tank, a spire on tall towers
  const top = tiers[tiers.length - 1];
  const yTop = floors * CITY.FLOOR;
  const nProps = rng.int(1, 3);
  for (let p = 0; p < nProps; p++) {
    const x = rng.int(top.x0 + 1, top.x1 - 1), z = rng.int(top.z0 + 1, top.z1 - 1);
    const cell = s.ci(x, floors, z);
    if (s.cells[cell] >= 0) continue;
    const tall = rng() < 0.3;
    const h = tall ? 3.4 : rng.range(1.2, 2.2);
    D.addChunk(s, {
      x0: xs[x] + 0.4, x1: xs[x + 1] - 0.4, y0: yTop, y1: yTop + h, z0: zs[z] + 0.4, z1: zs[z + 1] - 0.4,
      kind: KIND.SOLID, level: floors, color: new THREE.Color(tall ? 0x8b6b4a : 0x9da3a6), style: [0, 0, STYLE.CONCRETE], cells: [cell],
    });
  }
  return s;
}

// The city keeps going past the arena: non-destructible blocks continue the street grid out to
// the haze, then a sparse far skyline. Single boxes reuse the chunk shader with per-floor window
// cells, so they read like the destructible core. The tallest towers get aircraft warning lights.
function createSkyline(scene, material, rng) {
  const items = [];
  const R = 9; // rings of filler blocks around the 6x6 core
  for (let i = -R; i < CITY.BLOCKS + R; i++) {
    for (let j = -R; j < CITY.BLOCKS + R; j++) {
      if (i >= 0 && i < CITY.BLOCKS && j >= 0 && j < CITY.BLOCKS) continue;
      const r = blockRect(i, j);
      if (r.x0 > CITY_HALF + 230) continue; // the lake
      const ring = Math.max(i < 0 ? -i : i - CITY.BLOCKS + 1, j < 0 ? -j : j - CITY.BLOCKS + 1);
      if (rng() < 0.08 * ring) continue; // thins out toward the horizon
      const usable = r.x1 - r.x0 - CITY.SIDEWALK * 2;
      const split = rng() < 0.5 ? 1 : 2;
      for (let a = 0; a < split; a++) for (let b = 0; b < split; b++) {
        if (split === 2 && rng() < 0.2) continue;
        const cw = usable / split;
        const w = cw * rng.range(0.6, 0.92), d = cw * rng.range(0.6, 0.92);
        const x = r.x0 + CITY.SIDEWALK + cw * (a + 0.5);
        const z = r.z0 + CITY.SIDEWALK + cw * (b + 0.5);
        const near = Math.max(0, 1 - ring / R);
        let h = rng.range(14, 40) + near * rng.range(0, 50);
        if (rng() < 0.12) h += rng.range(40, 120);
        h = Math.round(h / CITY.FLOOR) * CITY.FLOOR;
        items.push({ x, z, w, d, h, style: rng.pick([STYLE.GLASS, STYLE.OFFICE, STYLE.STRIP, STYLE.BRICK]) });
      }
    }
  }
  // far silhouettes beyond the grid
  for (let n = 0; n < 140; n++) {
    const ang = rng() * Math.PI * 2;
    const dist = 900 + rng() * 600;
    const x = Math.cos(ang) * dist, z = Math.sin(ang) * dist;
    if (x > CITY_HALF + 300) continue;
    items.push({ x, z, w: rng.range(25, 60), d: rng.range(25, 60), h: rng.range(30, 90) + (rng() < 0.3 ? rng.range(60, 180) : 0), style: rng.pick([STYLE.GLASS, STYLE.OFFICE]) });
  }
  addSkylineMesh(scene, material, items, rng);
}

// Non-destructible boxes { x, z, w, d, h, style, y?, color?, beacon? } as one instanced mesh that
// reuses the chunk shader (per-floor window cells), plus blinking aircraft warning lights.
export function addSkylineMesh(scene, material, items, rng) {
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const attrs = addChunkAttributes(geo, items.length);
  const mesh = new THREE.InstancedMesh(geo, material, items.length);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion();
  const beacons = [];
  items.forEach((it, i) => {
    const y = it.y || 0;
    m.compose(new THREE.Vector3(it.x, y + it.h / 2, it.z), q, new THREE.Vector3(it.w, it.h, it.d));
    mesh.setMatrixAt(i, m);
    mesh.setColorAt(i, it.color || new THREE.Color(rng.pick(PALETTES[it.style])));
    const [ww, wh] = WIN[it.style] || [0, 0]; // slab / concrete styles have no windows
    attrs.style.array.set([ww, wh, it.style, 0], i * 4);
    attrs.parent.array.set([it.w, it.h, it.d, rng() * 100], i * 4);
    attrs.cell.array.set([it.w / Math.max(1, Math.round(it.w / 3)), CITY.FLOOR, it.d / Math.max(1, Math.round(it.d / 3))], i * 3);
    if (it.beacon ?? it.h > 85) beacons.push(new THREE.Vector3(it.x, y + it.h + 1.2, it.z));
  });
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.computeBoundingSphere();
  scene.add(mesh);
  if (beacons.length) {
    const bm = new THREE.MeshBasicMaterial({ color: new THREE.Color(2, 0.2, 0.2), toneMapped: false });
    const bmesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.9, 8, 6), bm, beacons.length);
    beacons.forEach((p, i) => bmesh.setMatrixAt(i, new THREE.Matrix4().makeTranslation(p.x, p.y, p.z)));
    bmesh.computeBoundingSphere();
    scene.add(bmesh);
    // slow blink, like real aircraft warning lights
    bmesh.onBeforeRender = () => { bm.color.setRGB(Math.sin(performance.now() * 0.003) > 0.2 ? 2 : 0.2, 0.2, 0.2); };
  }
}
