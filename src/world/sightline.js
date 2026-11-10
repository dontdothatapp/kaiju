// Sightlines: what the camera has to look through to see a kaiju.
// Each frame both of them are projected through the real camera (the portrait view offset
// included) and a rectangle on screen is fitted round each one's joints, padded by his bulk. The
// corridor from the lens through that rectangle, as deep as he stands, is his sightline: a
// building that reaches into one is in the way, and is hidden whole (world/structures.js
// updateView). The rectangle is kept in metres at his depth, so a cut or a zoom doesn't change
// what counts as in the way; a limb flung out widens it at once and it settles back calmly, so a
// building at its edge doesn't come and go with every punch.
import * as THREE from 'three';

// the first three set how deep the corridor reaches: an arm swung back mustn't hide the tower behind him
const JOINTS = ['chest', 'pelvis', 'head', 'handL', 'handR', 'ftL', 'ftR', 'tail5'];
const PAD = 1.0;       // clear space round each joint, in body radii
const PAD_DOWN = 0.3;  // ... and under it: what only covers the soles of his feet can stay
const SHY = 0.35;      // the corridor stops this many body radii short of his spine: a wall he has
                       // his back to, or stands half inside, isn't between him and the lens
const NEAR = 0.1;
const EDGE = 1.02;     // the screen's edge (-1..1), and a little
const OVAL = 1.0;      // the smoke's oval round him, as a share of his rectangle (its corners are mostly air)
const SMOKE_SHY = 0.85; // ... and how far toward him the smoke clears: a hit's puffs and the dust at his feet stay

const lanes = [0, 1].map(() => ({
  on: false, live: false, o: [0, 0, 0, 0], back: 0, z: 0, cx: 0, cy: 0, dc: 0,
  fr: new THREE.Frustum(), pts: Array.from({ length: 8 }, () => new THREE.Vector3()),
}));
// For the smoke (fx/smoke.js), which clears out of the same view of them a whole billow at a
// time: the oval round each kaiju on screen (centre and half size, -1..1), and how deep it clears
// (view depth; 0: not at all).
export const sightUniforms = {
  uSightA: { value: new THREE.Vector4() },
  uSightB: { value: new THREE.Vector4() },
  uSightZ: { value: new THREE.Vector2() },
};

const _vp = new THREE.Matrix4(), _inv = new THREE.Matrix4(), _c4 = new THREE.Vector4();
const _jw = new THREE.Vector3(), _jc = new THREE.Vector3(), _jq = new THREE.Vector3();
const _raw = [0, 0, 0, 0];

// fighters: [player, opponent] (or null: no sightlines). reach: none to a fighter further out than
// this (free roam, where the beaten one lies somewhere across the city).
export function updateSight(camera, fighters, dt, reach = Infinity) {
  camera.updateMatrixWorld();
  const m = _vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).elements;
  const P = camera.projectionMatrix.elements;
  _inv.copy(_vp).invert();
  for (let i = 0; i < 2; i++) {
    const l = lanes[i], f = fighters && fighters[i];
    const far = !f || !f.model.root.visible || !measure(l, f, m, P, dt);
    sightUniforms.uSightZ.value.setComponent(i, far || l.dc >= reach ? 0 : l.dc * SMOKE_SHY);
    if (far) { l.on = l.live = false; continue; }
    const sx = P[0] / l.dc, sy = P[5] / l.dc, o = l.o;
    (i ? sightUniforms.uSightB : sightUniforms.uSightA).value.set(
      l.cx + (o[1] - o[0]) * sx / 2, l.cy + (o[3] - o[2]) * sy / 2, (o[0] + o[1]) * sx / 2 * OVAL, (o[2] + o[3]) * sy / 2 * OVAL);
    // only as much of him as is in the picture: what stands in front of the half of him that is
    // off screen (a close-up) hides nothing
    const x0 = Math.max(-EDGE, l.cx - o[0] * sx), x1 = Math.min(EDGE, l.cx + o[1] * sx);
    const y0 = Math.max(-EDGE, l.cy - o[2] * sy), y1 = Math.min(EDGE, l.cy + o[3] * sy);
    l.on = l.dc < reach && l.z > NEAR * 2 && x1 > x0 && y1 > y0;
    if (l.on) corridor(l, m, P, x0, x1, y0, y1, l.z);
  }
}

// Is this box (a building) between the lens and either of them?
export function inSight(box) {
  return (lanes[0].on && reaches(lanes[0], box)) || (lanes[1].on && reaches(lanes[1], box));
}

// Fighter f on screen: his chest, the rectangle round his joints as offsets from it in metres at
// the chest's depth, and how deep the corridor to him goes. False: behind the lens.
function measure(l, f, m, P, dt) {
  const J = f.model.J, c = toScreen(m, J.chest.getWorldPosition(_jw), _jc);
  if (c.z < 2) return false;
  const pad = f.R * PAD;
  let x0 = c.x, x1 = c.x, y0 = c.y, y1 = c.y, deep = c.z;
  for (let n = 0; n < JOINTS.length; n++) {
    const q = toScreen(m, J[JOINTS[n]].getWorldPosition(_jw), _jq);
    if (q.z < 1) continue;
    const rx = pad * P[0] / q.z, ry = pad * P[5] / q.z;
    x0 = Math.min(x0, q.x - rx); x1 = Math.max(x1, q.x + rx);
    y0 = Math.min(y0, q.y - ry * PAD_DOWN); y1 = Math.max(y1, q.y + ry);
    if (n < 3) deep = Math.max(deep, q.z);
  }
  // (it grows at once and settles calmly; the first frame takes what it measures)
  const k = l.live ? 1 - Math.exp(-4 * dt) : 1;
  _raw[0] = (c.x - x0) * c.z / P[0]; _raw[1] = (x1 - c.x) * c.z / P[0];
  _raw[2] = (c.y - y0) * c.z / P[5]; _raw[3] = (y1 - c.y) * c.z / P[5];
  for (let n = 0; n < 4; n++) l.o[n] = Math.max(_raw[n], l.o[n] + (_raw[n] - l.o[n]) * k);
  const back = deep - c.z - f.R * SHY;
  l.back = Math.max(back, l.back + (back - l.back) * k);
  l.z = c.z + l.back;
  l.cx = c.x; l.cy = c.y; l.dc = c.z; l.live = true;
  return true;
}

// a world point through view-projection m: x, y on screen (-1..1), z its view depth
function toScreen(m, p, out) {
  const w = m[3] * p.x + m[7] * p.y + m[11] * p.z + m[15];
  return out.set((m[0] * p.x + m[4] * p.y + m[8] * p.z + m[12]) / w, (m[1] * p.x + m[5] * p.y + m[9] * p.z + m[13]) / w, w);
}

// The part of the view through the screen rectangle x0..x1, y0..y1 nearer than view depth z: its
// six planes and its eight corners, in the world.
function corridor(l, m, P, x0, x1, y0, y1, z) {
  const pl = l.fr.planes;
  clipPlane(pl[0], m, 1, 0, -x0, 0);
  clipPlane(pl[1], m, -1, 0, x1, 0);
  clipPlane(pl[2], m, 0, 1, -y0, 0);
  clipPlane(pl[3], m, 0, -1, y1, 0);
  clipPlane(pl[4], m, 0, 0, 1, -NEAR);
  clipPlane(pl[5], m, 0, 0, -1, z);
  for (let n = 0; n < 8; n++) {
    const w = n & 4 ? z : NEAR, x = n & 1 ? x1 : x0, y = n & 2 ? y1 : y0;
    _c4.set(x * w, y * w, P[14] - P[10] * w, w).applyMatrix4(_inv); // clip space at view depth w, back to the world
    l.pts[n].set(_c4.x, _c4.y, _c4.z);
  }
}
// the clip-space half-space a*x + b*y + c*w + d >= 0 as a world plane (w is the view depth)
function clipPlane(pl, m, a, b, c, d) {
  pl.setComponents(a * m[0] + b * m[1] + c * m[3], a * m[4] + b * m[5] + c * m[7], a * m[8] + b * m[9] + c * m[11], a * m[12] + b * m[13] + c * m[15] + d);
}

// Does the box reach into corridor l? The planes alone also pass a big box that sits off one of
// the corridor's edges (a long thin wedge next to a tower), so the corridor is tested against the
// box's faces as well: all eight of its corners beyond one face, and the box is clear of it.
function reaches(l, box) {
  if (!l.fr.intersectsBox(box)) return false;
  const a = box.min, b = box.max, p = l.pts;
  let x0 = 0, x1 = 0, y0 = 0, y1 = 0, z0 = 0, z1 = 0;
  for (let n = 0; n < 8; n++) {
    const q = p[n];
    if (q.x < a.x) x0++; else if (q.x > b.x) x1++;
    if (q.y < a.y) y0++; else if (q.y > b.y) y1++;
    if (q.z < a.z) z0++; else if (q.z > b.z) z1++;
  }
  return x0 < 8 && x1 < 8 && y0 < 8 && y1 < 8 && z0 < 8 && z1 < 8;
}
