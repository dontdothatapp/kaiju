// Procedural toon kaiju. Two primitive-built rigs on one skeleton: KAISER-OH, a sentai-style
// giant robot, and GORRAX, an atomic lizard with a tail and dorsal plates. One pose library with
// per-character overrides, layered pose blending, a procedural walk cycle (footfall events drive
// the quakes), tail sway, anime smear frames, hit flash + squash, glowing plates / chest emblem,
// rocket-thruster flames and a summoned energy sword.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { gradientMap, outlineMaterial, addOutline, rimLight, RIM_GLSL } from '../render/toon.js';
import { clamp, damp } from '../core/math.js';

const D = THREE.MathUtils.degToRad;

// joint -> [x, y, z] degrees. Character faces +Z, its left is +X.
//   spine / chest +x lean forward, head -x looks up, sh -x raises the arm forward, el -x bends the
//   elbow, hip -x swings the leg forward, kn +x bends the knee, tail +x lifts, jaw +x opens.
// Feet are flattened automatically on grounded poses (ft = -(hip + knee)).
export const POSES = {
  idle: {
    spine: [2, 0, 0], chest: [2, 0, 0], head: [-4, 0, 0], jaw: [0, 0, 0],
    shL: [6, 0, 14], elL: [-24, 0, 0], shR: [6, 0, -14], elR: [-24, 0, 0],
    hipL: [-10, 0, 6], knL: [16, 0, 0], hipR: [-4, 0, -6], knR: [12, 0, 0],
    tail1: [-14, 0, 0], tail2: [-10, 0, 0], tail3: [-10, 0, 0], tail4: [-10, 0, 0], tail5: [-10, 0, 0],
  },
  guard: {
    spine: [6, 0, 0], chest: [4, -16, 0], head: [-4, 14, 0],
    shL: [-70, 0, 16], elL: [-100, 0, 0], shR: [-50, 0, -24], elR: [-120, 0, 0],
    hipL: [-24, 0, 8], knL: [38, 0, 0], hipR: [8, 0, -8], knR: [24, 0, 0],
  },
  run: {
    spine: [22, 0, 0], chest: [10, 0, 0], head: [-26, 0, 0],
    shL: [-30, 0, 18], elL: [-80, 0, 0], shR: [-30, 0, -18], elR: [-80, 0, 0],
    hipL: [-14, 0, 6], knL: [30, 0, 0], hipR: [-6, 0, -6], knR: [26, 0, 0],
  },
  // the sentai pose: one fist to the sky
  taunt: {
    spine: [-4, 0, 0], chest: [-8, 14, 0], head: [-12, -12, 0],
    shR: [-172, 0, -12], elR: [-8, 0, 0], shL: [-40, 0, 38], elL: [-112, 0, 0],
    hipL: [-26, 0, 14], knL: [28, 0, 0], hipR: [10, 0, -14], knR: [10, 0, 0],
  },
  roar: {
    spine: [-6, 0, 0], chest: [-12, 0, 0], head: [-46, 0, 0], jaw: [42, 0, 0],
    shL: [-40, 0, 60], elL: [-50, 0, 0], shR: [-40, 0, -60], elR: [-50, 0, 0],
    hipL: [-20, 0, 12], knL: [26, 0, 0], hipR: [6, 0, -12], knR: [16, 0, 0],
    tail1: [4, 0, 0], tail2: [0, 0, 0],
  },
  // airborne: a jump (knees tucked) and the slam / flying kick on the way down
  air: {
    spine: [-4, 0, 0], chest: [0, 0, 0], head: [-10, 0, 0],
    shL: [-30, 0, 44], elL: [-40, 0, 0], shR: [-30, 0, -44], elR: [-40, 0, 0],
    hipL: [-56, 0, 6], knL: [84, 0, 0], ftL: [10, 0, 0], hipR: [-24, 0, -6], knR: [64, 0, 0], ftR: [20, 0, 0],
  },
  dive: {
    spine: [8, 0, 0], chest: [6, 0, 0], head: [-10, 0, 0],
    shL: [-20, 0, 50], elL: [-60, 0, 0], shR: [10, 0, -30], elR: [-40, 0, 0],
    hipL: [-84, 0, 4], knL: [6, 0, 0], ftL: [-10, 0, 0], hipR: [12, 0, -4], knR: [96, 0, 0], ftR: [20, 0, 0],
  },
  jabW: { chest: [4, -28, 0], shL: [-62, 0, 10], elL: [-112, 0, 0], shR: [-45, 0, -22], elR: [-125, 0, 0] },
  jabS: { chest: [6, -42, 0], spine: [6, -8, 0], shL: [-92, 0, 4], elL: [-4, 0, 0], shR: [-40, 0, -24], elR: [-128, 0, 0], head: [-4, 30, 0] },
  crossW: { chest: [4, -24, 0], shL: [-70, 0, 14], elL: [-104, 0, 0], shR: [-40, 0, -22], elR: [-132, 0, 0] },
  crossS: { chest: [8, 46, 0], spine: [8, 10, 0], shR: [-92, 0, -4], elR: [-4, 0, 0], shL: [-38, 0, 18], elL: [-124, 0, 0], head: [-4, -34, 0] },
  hookW: { chest: [4, 30, 0], shL: [-40, 0, 60], elL: [-90, 0, 0], shR: [-50, 0, -20], elR: [-120, 0, 0] },
  hookS: { chest: [10, -62, 0], spine: [6, -14, 0], shL: [-84, 0, 62], elL: [-84, 0, 0], shR: [-40, 0, -24], elR: [-126, 0, 0], head: [0, 35, 0] },
  // KAISER HAMMER: both fists overhead, then down on him
  smashW: { spine: [-14, 0, 0], chest: [-18, 0, 0], head: [-24, 0, 0], shL: [-176, 0, -10], elL: [-30, 0, 0], shR: [-176, 0, 10], elR: [-30, 0, 0], hipL: [-30, 0, 8], knL: [30, 0, 0], hipR: [12, 0, -8], knR: [20, 0, 0] },
  smashS: { spine: [30, 0, 0], chest: [26, 0, 0], head: [-16, 0, 0], shL: [-56, 0, -14], elL: [-10, 0, 0], shR: [-56, 0, 14], elR: [-10, 0, 0], hipL: [-50, 0, 8], knL: [70, 0, 0], hipR: [20, 0, -8], knR: [30, 0, 0] },
  chargeW: {
    spine: [-6, -20, 0], chest: [-4, -48, 0], head: [-4, 46, 0],
    shR: [-6, 0, -28], elR: [-132, 0, 0], shL: [-82, 0, 22], elL: [-24, 0, 0],
    hipL: [-44, 0, 10], knL: [64, 0, 0], hipR: [18, 0, -8], knR: [36, 0, 0],
  },
  chargeS: {
    spine: [14, 16, 0], chest: [14, 58, 0], head: [-4, -44, 0],
    shR: [-94, 0, -2], elR: [0, 0, 0], shL: [24, 0, 34], elL: [-70, 0, 0],
    hipL: [-56, 0, 8], knL: [44, 0, 0], hipR: [28, 0, -4], knR: [18, 0, 0],
  },
  upperW: { spine: [28, 0, 0], chest: [18, -20, 0], shR: [24, 0, -18], elR: [-95, 0, 0], shL: [-60, 0, 20], elL: [-100, 0, 0], hipL: [-56, 0, 0], knL: [84, 0, 0], hipR: [-30, 0, 0], knR: [70, 0, 0] },
  upperS: { spine: [-22, 10, 0], chest: [-14, 30, 0], shR: [-172, 0, -10], elR: [-30, 0, 0], shL: [-20, 0, 30], elL: [-80, 0, 0], head: [-25, 0, 0], hipL: [-10, 0, 0], knL: [20, 0, 0], hipR: [10, 0, 0], knR: [10, 0, 0] },
  // STOMP: knee to the chest, then the foot comes down like a pile driver
  stompW: { spine: [-8, 0, 0], chest: [-6, 0, 0], head: [-6, 0, 0], shL: [-30, 0, 64], elL: [-30, 0, 0], shR: [-30, 0, -64], elR: [-30, 0, 0], hipR: [-92, 0, -6], knR: [96, 0, 0], hipL: [-6, 0, 6], knL: [14, 0, 0] },
  stompS: { spine: [18, 0, 0], chest: [12, 0, 0], head: [6, 0, 0], shL: [-50, 0, 30], elL: [-80, 0, 0], shR: [-50, 0, -30], elR: [-80, 0, 0], hipR: [-26, 0, -8], knR: [24, 0, 0], hipL: [-8, 0, 10], knL: [44, 0, 0] },
  // KAISER BEAM: the chest thrown open, arms flung back
  beamW: { spine: [-10, 0, 0], chest: [-14, 0, 0], head: [-10, 0, 0], shL: [24, 0, 44], elL: [-90, 0, 0], shR: [24, 0, -44], elR: [-90, 0, 0], hipL: [-30, 0, 10], knL: [40, 0, 0], hipR: [16, 0, -10], knR: [24, 0, 0] },
  beamS: { spine: [-4, 0, 0], chest: [-8, 0, 0], head: [-4, 0, 0], shL: [34, 0, 64], elL: [-30, 0, 0], shR: [34, 0, -64], elR: [-30, 0, 0], hipL: [-36, 0, 12], knL: [50, 0, 0], hipR: [24, 0, -12], knR: [30, 0, 0] },
  // running shoulder tackle
  tackle: { spine: [26, -30, 0], chest: [14, -36, 0], head: [-26, 30, 0], shR: [-14, 0, -8], elR: [-30, 0, 0], shL: [-70, 0, 40], elL: [-100, 0, 0], hipL: [-50, 0, 8], knL: [60, 0, 0], hipR: [24, 0, -8], knR: [40, 0, 0] },
  grab: { spine: [10, 0, 0], chest: [10, 0, 0], shL: [-86, 0, -6], elL: [-24, 0, 0], shR: [-86, 0, 6], elR: [-24, 0, 0] },
  hold: { spine: [8, 10, 0], chest: [8, 18, 0], shR: [-92, 0, 0], elR: [-6, 0, 0], shL: [-50, 0, 30], elL: [-95, 0, 0], head: [-6, -10, 0] },
  lift: { spine: [-10, 0, 0], chest: [-14, 0, 0], head: [-30, 0, 0], shL: [-170, 0, -6], elL: [-20, 0, 0], shR: [-170, 0, 6], elR: [-20, 0, 0], hipL: [-30, 0, 12], knL: [40, 0, 0], hipR: [14, 0, -12], knR: [24, 0, 0] },
  throw: { spine: [24, 30, 0], chest: [18, 62, 0], shR: [-100, 0, -40], elR: [-10, 0, 0], shL: [-60, 0, 50], elL: [-40, 0, 0], head: [0, -40, 0] },
  block: {
    spine: [10, 0, 0], chest: [12, 0, 0], head: [16, 0, 0],
    shL: [-84, 0, -34], elL: [-112, 0, 0], shR: [-84, 0, 34], elR: [-112, 0, 0],
    hipL: [-30, 0, 8], knL: [50, 0, 0], hipR: [-18, 0, -8], knR: [40, 0, 0],
  },
  hitHigh: { spine: [-16, 0, 0], chest: [-22, 0, 0], head: [-38, 0, 0], jaw: [24, 0, 0], shL: [24, 0, 46], elL: [-40, 0, 0], shR: [24, 0, -46], elR: [-40, 0, 0], hipL: [10, 0, 0], knL: [30, 0, 0], hipR: [20, 0, 0], knR: [40, 0, 0] },
  hitBody: { spine: [34, 0, 0], chest: [22, 0, 0], head: [18, 0, 0], jaw: [18, 0, 0], shL: [-34, 0, 22], elL: [-50, 0, 0], shR: [-34, 0, -22], elR: [-50, 0, 0], hipL: [-50, 0, 0], knL: [70, 0, 0], hipR: [-40, 0, 0], knR: [60, 0, 0] },
  tumble: {
    spine: [-18, 0, 0], chest: [-16, 0, 0], head: [-30, 0, 0], jaw: [20, 0, 0],
    shL: [-30, 0, 78], elL: [-38, 0, 0], shR: [-30, 0, -78], elR: [-38, 0, 0],
    hipL: [-26, 0, 14], knL: [44, 0, 0], ftL: [30, 0, 0], hipR: [12, 0, -14], knR: [22, 0, 0], ftR: [30, 0, 0],
    tail1: [20, 0, 0], tail2: [16, 0, 0], tail3: [10, 0, 0],
  },
  dangle: { spine: [12, 0, 0], chest: [10, 0, 0], head: [30, 0, 0], jaw: [20, 0, 0], shL: [12, 0, 12], elL: [-14, 0, 0], shR: [12, 0, -12], elR: [-14, 0, 0], hipL: [-8, 0, 4], knL: [18, 0, 0], ftL: [40, 0, 0], hipR: [4, 0, -4], knR: [10, 0, 0], ftR: [40, 0, 0] },
  down: { spine: [-6, 0, 0], chest: [-4, 0, 0], head: [-14, 20, 0], jaw: [16, 0, 0], shL: [-40, 0, 80], elL: [-30, 0, 0], shR: [-120, 0, -70], elR: [-20, 0, 0], hipL: [-6, 0, 18], knL: [12, 0, 0], ftL: [20, 0, 0], hipR: [-30, 0, -10], knR: [50, 0, 0], ftR: [20, 0, 0], tail1: [0, 20, 0], tail2: [0, 14, 0], tail3: [0, 10, 0] },
  // heaving himself up out of the rubble
  recover: { spine: [34, 0, 0], chest: [20, 0, 0], head: [-26, 0, 0], shL: [-50, 0, 30], elL: [-20, 0, 0], shR: [-50, 0, -30], elR: [-20, 0, 0], hipL: [-80, 0, 10], knL: [110, 0, 0], hipR: [-10, 0, -10], knR: [100, 0, 0] },
  heroLand: { spine: [34, 0, 0], chest: [18, 0, 0], head: [-34, 0, 0], shR: [-30, 0, -8], elR: [-6, 0, 0], shL: [18, 0, 46], elL: [-30, 0, 0], hipL: [-96, 0, 12], knL: [104, 0, 0], hipR: [28, 0, -8], knR: [118, 0, 0] },
  punchL: { chest: [6, -40, 0], shL: [-90, 0, 4], elL: [-4, 0, 0], shR: [-90, 0, 0], elR: [-6, 0, 0] },
  punchR: { chest: [6, 40, 0], shR: [-90, 0, 0], elR: [-4, 0, 0], shL: [-80, 0, 10], elL: [-40, 0, 0] },
  // KAISER SABER: raised to the sky, slashed, then the final cleave
  swordUp: { spine: [-6, 0, 0], chest: [-10, 0, 0], head: [-22, 0, 0], shR: [-178, 0, -4], elR: [-4, 0, 0], shL: [-40, 0, 34], elL: [-96, 0, 0], hipL: [-30, 0, 10], knL: [32, 0, 0], hipR: [14, 0, -10], knR: [16, 0, 0] },
  slashW: { chest: [0, 50, 0], spine: [4, 20, 0], head: [-6, -30, 0], shR: [-110, 0, -84], elR: [-20, 0, 0], shL: [-60, 0, 30], elL: [-100, 0, 0] },
  slashS: { chest: [10, -56, 0], spine: [10, -20, 0], head: [-6, 30, 0], shR: [-80, 0, 40], elR: [-6, 0, 0], shL: [-30, 0, 40], elL: [-90, 0, 0] },
  cleaveW: { spine: [-12, 0, 0], chest: [-16, 0, 0], head: [-24, 0, 0], shR: [-176, 0, -8], elR: [-34, 0, 0], shL: [-172, 0, 8], elL: [-34, 0, 0], hipL: [-30, 0, 8], knL: [30, 0, 0], hipR: [14, 0, -8], knR: [18, 0, 0] },
  cleaveS: { spine: [28, 0, 0], chest: [20, 0, 0], head: [-14, 0, 0], shR: [-62, 0, -4], elR: [-6, 0, 0], shL: [-62, 0, 4], elL: [-6, 0, 0], hipL: [-54, 0, 6], knL: [72, 0, 0], hipR: [26, 0, -6], knR: [30, 0, 0] },
};

// GORRAX: hunched forward, claws up, tail low. His combo is claw, claw, bite, tail whip.
const BEAST_POSES = {
  idle: {
    spine: [12, 0, 0], chest: [8, 0, 0], head: [-18, 0, 0], jaw: [4, 0, 0],
    shL: [-26, 0, 24], elL: [-56, 0, 0], shR: [-26, 0, -24], elR: [-56, 0, 0],
    hipL: [-12, 0, 8], knL: [22, 0, 0], hipR: [-2, 0, -8], knR: [16, 0, 0],
  },
  guard: {
    spine: [16, 0, 0], chest: [10, -8, 0], head: [-24, 8, 0], jaw: [8, 0, 0],
    shL: [-50, 0, 30], elL: [-74, 0, 0], shR: [-40, 0, -30], elR: [-84, 0, 0],
    hipL: [-22, 0, 10], knL: [36, 0, 0], hipR: [6, 0, -10], knR: [24, 0, 0],
  },
  run: {
    spine: [34, 0, 0], chest: [14, 0, 0], head: [-40, 0, 0], jaw: [10, 0, 0],
    shL: [-40, 0, 30], elL: [-60, 0, 0], shR: [-40, 0, -30], elR: [-60, 0, 0],
    hipL: [-14, 0, 8], knL: [32, 0, 0], hipR: [-6, 0, -8], knR: [28, 0, 0],
    tail1: [-2, 0, 0], tail2: [-4, 0, 0],
  },
  taunt: POSES.roar,
  jabW: { spine: [14, 10, 0], chest: [0, 26, 0], head: [-20, -14, 0], shL: [-150, 0, 44], elL: [-40, 0, 0], shR: [-40, 0, -30], elR: [-84, 0, 0] },
  jabS: { spine: [22, -12, 0], chest: [12, -34, 0], head: [-22, 22, 0], shL: [-56, 0, -18], elL: [-16, 0, 0], shR: [-40, 0, -30], elR: [-84, 0, 0] },
  crossW: { spine: [14, -10, 0], chest: [0, -26, 0], head: [-20, 14, 0], shR: [-150, 0, -44], elR: [-40, 0, 0], shL: [-50, 0, 30], elL: [-74, 0, 0] },
  crossS: { spine: [22, 12, 0], chest: [12, 34, 0], head: [-22, -22, 0], shR: [-56, 0, 18], elR: [-16, 0, 0], shL: [-50, 0, 30], elL: [-74, 0, 0] },
  // the bite: rear back with the jaws open, then lunge and snap
  hookW: { spine: [4, 0, 0], chest: [-12, 0, 0], head: [-44, 0, 0], jaw: [40, 0, 0], shL: [-60, 0, 44], elL: [-60, 0, 0], shR: [-60, 0, -44], elR: [-60, 0, 0] },
  hookS: { spine: [30, 0, 0], chest: [24, 0, 0], head: [-6, 0, 0], jaw: [2, 0, 0], shL: [-84, 0, 30], elL: [-30, 0, 0], shR: [-84, 0, -30], elR: [-30, 0, 0] },
  // tail whip: wind the body one way, the whole kaiju spins (fighter.js) and the tail sweeps
  smashW: { spine: [14, 34, 0], chest: [10, 50, 0], head: [-24, -30, 0], shL: [-40, 0, 50], elL: [-60, 0, 0], shR: [-40, 0, -50], elR: [-60, 0, 0], tail1: [-4, -40, 0], tail2: [0, -24, 0], tail3: [0, -12, 0] },
  smashS: { spine: [14, -26, 0], chest: [10, -40, 0], head: [-24, 20, 0], shL: [-30, 0, 60], elL: [-50, 0, 0], shR: [-30, 0, -60], elR: [-50, 0, 0], tail1: [4, 44, 0], tail2: [6, 30, 0], tail3: [6, 20, 0], tail4: [4, 12, 0], tail5: [2, 8, 0] },
  chargeW: { spine: [-10, 0, 0], chest: [-16, 0, 0], head: [-34, 0, 0], jaw: [34, 0, 0], shL: [-164, 0, 30], elL: [-40, 0, 0], shR: [-164, 0, -30], elR: [-40, 0, 0], hipL: [-40, 0, 10], knL: [56, 0, 0], hipR: [18, 0, -10], knR: [30, 0, 0] },
  chargeS: { spine: [36, 0, 0], chest: [24, 0, 0], head: [-34, 0, 0], jaw: [12, 0, 0], shL: [-52, 0, 8], elL: [-10, 0, 0], shR: [-52, 0, -8], elR: [-10, 0, 0], hipL: [-56, 0, 10], knL: [60, 0, 0], hipR: [26, 0, -10], knR: [24, 0, 0] },
  upperS: { spine: [-20, 0, 0], chest: [-14, 20, 0], head: [-40, 0, 0], jaw: [30, 0, 0], shR: [-170, 0, -20], elR: [-30, 0, 0], shL: [-30, 0, 40], elL: [-70, 0, 0], hipL: [-10, 0, 0], knL: [20, 0, 0], hipR: [10, 0, 0], knR: [10, 0, 0] },
  // ATOMIC BREATH: rear back while the plates light up, then lean in and pour it out
  beamW: { spine: [-8, 0, 0], chest: [-18, 0, 0], head: [-40, 0, 0], jaw: [16, 0, 0], shL: [-20, 0, 54], elL: [-60, 0, 0], shR: [-20, 0, -54], elR: [-60, 0, 0], hipL: [-26, 0, 10], knL: [34, 0, 0], hipR: [14, 0, -10], knR: [22, 0, 0], tail1: [-2, 0, 0] },
  beamS: { spine: [24, 0, 0], chest: [14, 0, 0], head: [-14, 0, 0], jaw: [46, 0, 0], shL: [-40, 0, 50], elL: [-70, 0, 0], shR: [-40, 0, -50], elR: [-70, 0, 0], hipL: [-36, 0, 12], knL: [50, 0, 0], hipR: [24, 0, -12], knR: [30, 0, 0] },
  // body slam from a leap: belly first
  dive: {
    spine: [44, 0, 0], chest: [20, 0, 0], head: [-50, 0, 0], jaw: [30, 0, 0],
    shL: [-150, 0, 40], elL: [-20, 0, 0], shR: [-150, 0, -40], elR: [-20, 0, 0],
    hipL: [10, 0, 10], knL: [30, 0, 0], ftL: [20, 0, 0], hipR: [10, 0, -10], knR: [30, 0, 0], ftR: [20, 0, 0],
    tail1: [16, 0, 0], tail2: [10, 0, 0],
  },
  grab: { spine: [16, 0, 0], chest: [10, 0, 0], head: [-20, 0, 0], jaw: [30, 0, 0], shL: [-86, 0, -6], elL: [-24, 0, 0], shR: [-86, 0, 6], elR: [-24, 0, 0] },
  hold: { spine: [16, 10, 0], chest: [10, 16, 0], head: [-6, -10, 0], jaw: [6, 0, 0], shR: [-92, 0, 0], elR: [-30, 0, 0], shL: [-70, 0, 20], elL: [-60, 0, 0] },
  tackle: { spine: [40, 0, 0], chest: [20, 0, 0], head: [-30, 0, 0], jaw: [10, 0, 0], shL: [-40, 0, 40], elL: [-60, 0, 0], shR: [-40, 0, -40], elR: [-60, 0, 0], hipL: [-50, 0, 8], knL: [60, 0, 0], hipR: [24, 0, -8], knR: [40, 0, 0] },
};

export const JOINTS = ['spine', 'chest', 'head', 'jaw', 'shL', 'elL', 'shR', 'elR', 'hipL', 'knL', 'ftL', 'hipR', 'knR', 'ftR', 'tail1', 'tail2', 'tail3', 'tail4', 'tail5'];
const TAIL = ['tail1', 'tail2', 'tail3', 'tail4', 'tail5'];
// poses that keep their whole shape (everything else falls back to the guard for unspecified joints)
const WHOLE = ['idle', 'run', 'air', 'dive', 'tumble', 'down', 'dangle', 'taunt', 'roar', 'block', 'recover'];
// poses off the ground: no auto-flat feet
const AIRBORNE = ['air', 'dive', 'tumble', 'down', 'dangle'];

const POSE_CACHE = new Map();
function poseTable(def) {
  if (POSE_CACHE.has(def.name)) return POSE_CACHE.get(def.name);
  const src = { ...POSES, ...(def.poses || {}) };
  const out = {};
  for (const [name, p] of Object.entries(src)) {
    const full = {};
    for (const j of JOINTS) {
      let e = p[j];
      if (!e && !WHOLE.includes(name) && src.guard[j]) e = src.guard[j];
      if (!e) e = src.idle[j] || POSES.idle[j] || [0, 0, 0];
      full[j] = e.slice();
    }
    if (!AIRBORNE.includes(name)) {
      for (const s of ['L', 'R']) if (!p['ft' + s]) full['ft' + s] = [-(full['hip' + s][0] + full['kn' + s][0]), 0, 0];
    }
    out[name] = {};
    for (const j of JOINTS) out[name][j] = new THREE.Quaternion().setFromEuler(new THREE.Euler(D(full[j][0]), D(full[j][1]), D(full[j][2])));
  }
  POSE_CACHE.set(def.name, out);
  return out;
}

const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();

const GEO = new Map();
const geo = (key, make) => { if (!GEO.has(key)) GEO.set(key, make()); return GEO.get(key); };
const rbox = (w, h, d, r = 0.2) => geo(`rb${w},${h},${d},${r}`, () => new RoundedBoxGeometry(w, h, d, 2, Math.min(w, h, d) * r));
const cap = (r, len, seg = 12) => geo(`c${r},${len},${seg}`, () => new THREE.CapsuleGeometry(r, len, 4, seg));
const sph = (r, ws = 16, hs = 12) => geo(`s${r},${ws},${hs}`, () => new THREE.SphereGeometry(r, ws, hs));
const cone = (r, h, seg = 6) => geo(`k${r},${h},${seg}`, () => new THREE.ConeGeometry(r, h, seg));
const cyl = (r0, r1, h, seg = 14) => geo(`y${r0},${r1},${h},${seg}`, () => new THREE.CylinderGeometry(r0, r1, h, seg));
// a cone hanging down from its base (thruster flames)
const flame = (r, h, seg) => geo(`f${r},${h},${seg}`, () => new THREE.ConeGeometry(r, h, seg).translate(0, -h / 2, 0).rotateX(Math.PI));

export class CharacterModel {
  constructor(scene, def) {
    this.def = def;
    this.root = new THREE.Group();
    this.body = new THREE.Group();
    this.root.add(this.body);
    scene.add(this.root);
    this.mats = [];
    this.flash = 0;
    this.squash = 0;
    this.squashDir = new THREE.Vector3(0, 1, 0);
    this.smearL = 0; this.smearR = 0;
    this.base = 'idle';
    this.action = null;
    this.actionW = 0;
    this.actionWTarget = 0;
    this.rate = 14;
    this.damage = 0;
    this.glow = 0;          // dorsal plates / chest emblem charging up (0..1.5)
    this.thrust = 0;        // rocket thrusters (robot)
    this.gaitPhase = 0;
    this.gaitAmt = 0;
    this.gaitRun = 0;
    this.onStep = null;     // (side, amount) => void, at each footfall
    this.P = poseTable(def);
    this.outline = outlineMaterial(def.outline || 0.07, def.ink || 0x0b0b14);
    const S = def.scale || 1;
    this.body.scale.setScalar(S);

    const mat = (key, c) => {
      const m = new THREE.MeshToonMaterial({ color: c, gradientMap: gradientMap(3) });
      m.userData.base = new THREE.Color(c);
      m.userData.key = key;
      m.userData.glow = def.glows && def.glows[key] ? new THREE.Color(def.glows[key]) : null;
      const uniforms = { uDamage: { value: 0 } };
      m.userData.u = uniforms;
      m.onBeforeCompile = (sh) => {
        sh.uniforms.uDamage = uniforms.uDamage;
        Object.assign(sh.uniforms, rimLight);
        sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vObjP;')
          .replace('#include <begin_vertex>', '#include <begin_vertex>\nvObjP = position;');
        sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
          uniform float uDamage; varying vec3 vObjP;
          uniform vec3 uRimColor; uniform float uRim;
          float hh(vec3 p){ return fract(sin(dot(floor(p), vec3(12.7, 51.3, 97.1))) * 43758.5453); }`)
          .replace('#include <color_fragment>', `#include <color_fragment>
          { float n = hh(vObjP * 22.0) * 0.6 + hh(vObjP * 9.0) * 0.4;
            float bruise = step(1.0 - uDamage * 0.55, n);
            diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.42, 0.36, 0.34), bruise * 0.75); }`)
          .replace('#include <opaque_fragment>', RIM_GLSL);
      };
      m.customProgramCacheKey = () => 'kaiju-' + def.name;
      this.mats.push(m);
      return m;
    };
    const M = {};
    for (const [k, c] of Object.entries(def.colors)) M[k] = mat(k, c);
    this.M = M;

    this.add = (parent, g, m, pos, scale, rot, outline = true) => {
      const mesh = new THREE.Mesh(g, m);
      if (pos) mesh.position.set(...pos);
      if (scale) mesh.scale.set(...scale);
      if (rot) mesh.rotation.set(...rot);
      mesh.castShadow = true;
      parent.add(mesh);
      if (outline) addOutline(mesh, this.outline);
      return mesh;
    };
    this.grp = (parent, pos) => { const g = new THREE.Group(); g.position.set(...pos); parent.add(g); return g; };

    this.J = {};
    (def.rig === 'beast' ? buildBeast : buildMech)(this);
    for (const j of JOINTS) if (!this.J[j]) this.J[j] = this.grp(this.J.pelvis, [0, 0, 0]); // a robot has no tail
    this.cur = {};
    for (const j of JOINTS) { this.cur[j] = this.P.idle[j].clone(); this.J[j].quaternion.copy(this.cur[j]); }
    this._guardLow = this._legLow(this.P.guard);
  }

  setBase(name) { this.base = name; }
  // Pose override with a blend rate. rate ~60 snaps for strike frames.
  setAction(name, rate = 18) {
    if (name) { this.action = name; this.actionWTarget = 1; this.rate = rate; }
    else { this.actionWTarget = 0; this.rate = rate; }
  }
  // Pose override held at an exact weight, for scripted blends (standing up out of a kneel).
  blend(name, w, rate = 30) { this.action = name; this.actionW = this.actionWTarget = w; this.rate = rate; }
  // Straight into a pose, no blend (a cut: a skipped round opener).
  snap(name) {
    this.base = name; this.action = null; this.actionW = this.actionWTarget = 0; this.rate = 8;
    for (const j of JOINTS) { this.cur[j].copy(this.P[name][j]); this.J[j].quaternion.copy(this.cur[j]); }
  }

  // How much higher the lowest knee or sole of the pose as blended right now sits than in the
  // guard stance (model units; 0 for anything straighter). Kneeling, the body comes down by this
  // much so the knee is on the street (Fighter.update).
  legDrop() { return Math.max(0, this._legLow(this.cur) - this._guardLow); }
  _legLow(Q) {
    const J = this.J;
    let low = Infinity;
    for (const s of ['L', 'R']) {
      const knee = _v.copy(J['kn' + s].position).applyQuaternion(Q['hip' + s]).add(J['hip' + s].position);
      const ky = knee.y;
      _q2.copy(Q['hip' + s]).multiply(Q['kn' + s]);
      const ankle = knee.add(_v2.copy(J['ft' + s].position).applyQuaternion(_q2));
      low = Math.min(low, ky - 0.14, ankle.y - 0.1); // the kneecap's and the sole's thickness
    }
    return low;
  }

  hitFlash(v = 1) { this.flash = Math.max(this.flash, v); }
  hitSquash(dir, v = 1) { this.squash = Math.max(this.squash, v); this.squashDir.copy(dir); }
  smear(side, v = 1) { if (side === 'L') this.smearL = v; else this.smearR = v; }
  setDamage(v) { this.damage = v; for (const m of this.mats) m.userData.u.uDamage.value = v; }
  showSword(v) { if (this.sword) this.sword.visible = v; }

  // grounded: walking on the street (drives the gait)
  update(dt, realDt, vel, frozen, grounded = false) {
    const J = this.J;
    this.actionW = damp(this.actionW, this.actionWTarget, this.actionWTarget > 0 ? 40 : 10, dt || 0);
    if (this.actionWTarget === 0 && this.actionW < 0.01) this.action = null;
    const baseQ = this.P[this.base] || this.P.idle;
    const actQ = this.action ? this.P[this.action] : null;
    const k = 1 - Math.exp(-this.rate * dt);
    for (const j of JOINTS) {
      _q.copy(baseQ[j]);
      if (actQ) _q.slerp(actQ[j], this.actionW);
      this.cur[j].slerp(_q, k);
      J[j].quaternion.copy(this.cur[j]);
    }
    this._gait(dt, vel, grounded);
    // smear frames: stretch the striking arm for a couple of frames
    this.smearL = Math.max(0, this.smearL - dt * 9);
    this.smearR = Math.max(0, this.smearR - dt * 9);
    this.flash = Math.max(0, this.flash - realDt * 6);
    this.looks(this.smearL, this.smearR, this.flash, this.damage, this.glow, this.thrust);
    // squash & stretch (decays in real time; jitters during hitstop)
    this.squash = Math.max(0, this.squash - realDt * 5);
    const sq = this.squash;
    const S = this.def.scale || 1;
    const jitter = frozen && sq > 0 ? (Math.random() - 0.5) * 0.05 * sq : 0;
    this.body.scale.set(S * (1 + sq * 0.08 + jitter), S * (1 - sq * 0.1), S * (1 + sq * 0.08 - jitter));
  }

  // Procedural walk on top of the pose: legs swing (forward / back / sideways from the local
  // velocity), knees lift in the swing phase, feet stay flat, the body bobs and rolls, arms swing
  // against the legs, the tail waves behind. A footfall event at each step.
  _gait(dt, vel, grounded) {
    const J = this.J, def = this.def, t = performance.now() * 0.001;
    _v.set(vel ? vel.x : 0, 0, vel ? vel.z : 0);
    _q2.copy(this.root.quaternion).invert();
    _v.applyQuaternion(_q2);
    const sp = Math.hypot(_v.x, _v.z);
    const want = grounded ? clamp(sp / def.walk, 0, 1.25) : 0;
    this.gaitAmt = damp(this.gaitAmt, want, want > this.gaitAmt ? 7 : 5, dt);
    this.gaitRun = damp(this.gaitRun, grounded && sp > def.walk * 1.5 ? 1 : 0, 4, dt);
    const a = this.gaitAmt;
    if (dt > 0 && a > 0.02) {
      const prev = Math.floor((this.gaitPhase - Math.PI / 2) / Math.PI);
      this.gaitPhase += (Math.max(sp, def.walk * 0.45 * a) / (def.stride * (1 + this.gaitRun * 0.5))) * Math.PI * dt;
      const now = Math.floor((this.gaitPhase - Math.PI / 2) / Math.PI);
      if (now !== prev && a > 0.3 && this.onStep) this.onStep(now % 2 === 0 ? 'L' : 'R', a);
    }
    const ph = this.gaitPhase, s = Math.sin(ph), c = Math.cos(ph);
    const dirF = sp > 0.5 ? _v.z / sp : 1, dirS = sp > 0.5 ? _v.x / sp : 0;
    const A = D(26 + 14 * this.gaitRun) * a, Kn = D(40 + 30 * this.gaitRun) * a;
    const rot = (j, x, y, z) => { _q.setFromEuler(_e.set(x, y, z)); J[j].quaternion.premultiply(_q); };
    if (a > 0.005) {
      const hL = -A * s * dirF, hR = A * s * dirF, kL = Kn * Math.max(0, c), kR = Kn * Math.max(0, -c);
      rot('hipL', hL, 0, A * 0.6 * s * dirS);
      rot('hipR', hR, 0, A * 0.6 * s * dirS);
      // knees bend in the leg's own frame, feet undo both so the soles stay flat
      J.knL.quaternion.multiply(_q.setFromEuler(_e.set(kL, 0, 0)));
      J.knR.quaternion.multiply(_q.setFromEuler(_e.set(kR, 0, 0)));
      J.ftL.quaternion.multiply(_q.setFromEuler(_e.set(-(hL + kL), 0, 0)));
      J.ftR.quaternion.multiply(_q.setFromEuler(_e.set(-(hR + kR), 0, 0)));
      rot('shL', D(12) * a * s * dirF, 0, 0);
      rot('shR', -D(12) * a * s * dirF, 0, 0);
      rot('spine', D(6) * this.gaitRun * a, 0, D(4) * a * s);
      rot('chest', 0, D(7) * a * s * dirF, 0);
      rot('head', 0, -D(5) * a * s * dirF, -D(3) * a * s);
    }
    this.body.position.y = def.bob * a * (Math.abs(c) - 0.6);
    if (def.rig === 'beast') {
      // the tail lives: a slow idle wave plus a sway that follows the stride
      for (let i = 0; i < TAIL.length; i++) {
        const sway = D(5) * Math.sin(t * 1.1 - i * 0.7) + D(9) * a * Math.sin(ph - i * 0.8);
        rot(TAIL[i], D(2) * Math.sin(t * 0.9 - i * 0.5), sway, 0);
      }
    }
  }

  // Arm stretch, hit-flash glow, bruises, plate glow and thruster flames from these values (the
  // match recap drives them too).
  looks(smearL, smearR, flash, damage, glow = this.glow, thrust = this.thrust) {
    const J = this.J, A = this.arm, def = this.def;
    J.uaL.scale.set(1, 1 + smearL * 0.3, 1); J.faL.scale.set(1, 1 + smearL * 0.4, 1);
    J.elL.position.y = A.el * (1 + smearL * 0.3); J.handL.position.y = A.hand * (1 + smearL * 0.4);
    J.uaR.scale.set(1, 1 + smearR * 0.3, 1); J.faR.scale.set(1, 1 + smearR * 0.4, 1);
    J.elR.position.y = A.el * (1 + smearR * 0.3); J.handR.position.y = A.hand * (1 + smearR * 0.4);
    const f = flash > 0.5 ? 1 : flash * 0.6;
    const pulse = 0.85 + 0.15 * Math.sin(performance.now() * 0.025);
    for (const m of this.mats) {
      const gc = m.userData.glow;
      if (gc) {
        const key = m.userData.key;
        const g = clamp((def.glowIdle[key] ?? 0) + glow * (def.glowCharge[key] ?? 1) * pulse, 0, 2.2);
        m.emissive.copy(gc).multiplyScalar(g).addScalar(f);
      } else m.emissive.setScalar(f);
      m.userData.u.uDamage.value = damage;
    }
    if (this.flames) {
      for (const fl of this.flames) {
        fl.visible = thrust > 0.02;
        fl.scale.set(1, thrust * (0.8 + Math.random() * 0.4), 1);
      }
    }
  }

  handWorld(side, out) { return this.J['hand' + side].getWorldPosition(out); }
  headWorld(out) { return this.J.head.getWorldPosition(out); }
  chestWorld(out) { return this.J.chest.getWorldPosition(out); }
  footWorld(side, out) { return this.J['ft' + side].getWorldPosition(out); }
  // where the beam comes out: the open jaws or the chest emblem
  mouthWorld(out) { return (this.muzzle || this.J.head).getWorldPosition(out); }
  tailTipWorld(out) { return (this.tailTip || this.J.tail5).getWorldPosition(out); }
  swordTipWorld(out) { return (this.swordTip || this.J.handR).getWorldPosition(out); }
  setVisible(v) { this.root.visible = v; }
}

// ---------------------------------------------------------------- KAISER-OH (the robot)
// Rounded boxes in red, white, blue and gold: V-crest helmet, glowing visor, big pauldrons, a
// chest emblem that fires the beam, twin back thrusters and a sword it summons for the finisher.
function buildMech(m) {
  const { add, grp, M, J } = m;
  m.arm = { el: -0.3, hand: -0.29 };
  J.pelvis = grp(m.body, [0, 0, 0]);
  add(J.pelvis, rbox(0.34, 0.16, 0.24), M.grey, [0, 0, 0]);
  add(J.pelvis, rbox(0.14, 0.18, 0.06, 0.3), M.red, [0, -0.06, 0.12]);              // crotch plate
  for (const sx of [-1, 1]) add(J.pelvis, rbox(0.16, 0.2, 0.05, 0.3), M.white, [sx * 0.13, -0.08, 0.11], null, [0.12, 0, sx * -0.12]); // skirt
  add(J.pelvis, rbox(0.38, 0.06, 0.27, 0.4), M.gold, [0, 0.07, 0]);                   // belt
  J.spine = grp(J.pelvis, [0, 0.1, 0]);
  add(J.spine, rbox(0.3, 0.16, 0.2), M.grey, [0, 0.06, 0]);
  J.chest = grp(J.spine, [0, 0.16, 0]);
  add(J.chest, rbox(0.62, 0.32, 0.32, 0.18), M.blue, [0, 0.15, 0]);
  add(J.chest, rbox(0.66, 0.1, 0.34, 0.3), M.red, [0, 0.3, 0]);                       // collar
  // gold V across the chest, the emblem in the middle
  for (const sx of [-1, 1]) add(J.chest, rbox(0.3, 0.07, 0.04, 0.3), M.gold, [sx * 0.13, 0.18, 0.165], null, [0, 0, sx * -0.45]);
  add(J.chest, cyl(0.085, 0.085, 0.04, 20), M.gold, [0, 0.12, 0.17], null, [Math.PI / 2, 0, 0]);
  const emb = add(J.chest, cyl(0.06, 0.06, 0.03, 20), M.emblem, [0, 0.12, 0.19], null, [Math.PI / 2, 0, 0]);
  emb.castShadow = false;
  m.muzzle = grp(J.chest, [0, 0.12, 0.26]);
  // back: the thrusters, with flames for jumps and dives
  m.flames = [];
  const flameMat = new THREE.MeshBasicMaterial({ color: 0xffa53a, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
  const coreMat = new THREE.MeshBasicMaterial({ color: 0xfff6d0, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
  for (const sx of [-1, 1]) {
    add(J.chest, cyl(0.07, 0.09, 0.3, 12), M.grey, [sx * 0.15, 0.12, -0.2]);
    add(J.chest, cyl(0.1, 0.1, 0.06, 12), M.red, [sx * 0.15, 0.28, -0.2]);
    const fl = new THREE.Mesh(flame(0.08, 0.6, 10), flameMat);
    fl.position.set(sx * 0.15, -0.03, -0.2);
    fl.visible = false;
    fl.add(new THREE.Mesh(flame(0.04, 0.38, 8), coreMat));
    J.chest.add(fl);
    m.flames.push(fl);
  }
  J.neck = grp(J.chest, [0, 0.33, 0]);
  add(J.neck, cyl(0.06, 0.07, 0.08), M.grey, [0, 0.03, 0]);
  J.head = grp(J.neck, [0, 0.07, 0]);
  add(J.head, rbox(0.2, 0.19, 0.21, 0.25), M.white, [0, 0.1, 0]);                    // helmet
  add(J.head, rbox(0.15, 0.09, 0.05, 0.3), M.grey, [0, 0.05, 0.1]);                  // faceplate
  for (let i = 0; i < 3; i++) add(J.head, rbox(0.1, 0.012, 0.01, 0.4), M.dark, [0, 0.025 + i * 0.022, 0.127], null, null, false); // grill
  for (const sx of [-1, 1]) {
    const eye = add(J.head, rbox(0.065, 0.028, 0.02, 0.3), M.visor, [sx * 0.045, 0.115, 0.104], null, [0, 0, sx * -0.18]);
    eye.castShadow = false;
    add(J.head, rbox(0.04, 0.12, 0.08, 0.3), M.red, [sx * 0.11, 0.1, 0]);             // ear fins
    add(J.head, rbox(0.03, 0.2, 0.025, 0.3), M.gold, [sx * 0.07, 0.25, 0.08], null, [0.2, 0, sx * -0.55]); // V-crest
  }
  add(J.head, rbox(0.05, 0.07, 0.03, 0.3), M.red, [0, 0.19, 0.105]);                  // forehead jewel
  for (const side of ['L', 'R']) {
    const sx = side === 'L' ? 1 : -1;
    const sh = J['sh' + side] = grp(J.chest, [sx * 0.38, 0.24, 0]);
    add(sh, rbox(0.26, 0.2, 0.28, 0.2), M.red, [sx * 0.04, 0.05, 0]);               // pauldron
    add(sh, rbox(0.27, 0.05, 0.29, 0.4), M.gold, [sx * 0.04, 0.15, 0]);
    add(sh, rbox(0.06, 0.16, 0.2, 0.3), M.white, [sx * 0.16, 0.03, 0]);
    const ua = J['ua' + side] = new THREE.Group(); sh.add(ua);
    add(ua, rbox(0.13, 0.26, 0.13, 0.25), M.white, [0, -0.15, 0]);
    const el = J['el' + side] = grp(sh, [0, -0.3, 0]);
    const fa = J['fa' + side] = new THREE.Group(); el.add(fa);
    add(fa, rbox(0.16, 0.24, 0.17, 0.22), M.red, [0, -0.12, 0]);
    add(fa, rbox(0.17, 0.05, 0.18, 0.4), M.gold, [0, -0.22, 0]);                     // cuff
    const hand = J['hand' + side] = grp(el, [0, -0.29, 0]);
    add(hand, rbox(0.14, 0.13, 0.15, 0.3), M.grey, [0, -0.04, 0.01]);
    const hip = J['hip' + side] = grp(J.pelvis, [sx * 0.14, -0.08, 0]);
    add(hip, rbox(0.17, 0.32, 0.2, 0.22), M.white, [0, -0.19, 0]);
    const kn = J['kn' + side] = grp(hip, [0, -0.44, 0]);
    add(kn, rbox(0.12, 0.1, 0.06, 0.3), M.gold, [0, 0.02, 0.11]);                    // knee cap
    add(kn, rbox(0.2, 0.36, 0.24, 0.2), M.blue, [0, -0.19, 0]);
    add(kn, rbox(0.21, 0.12, 0.05, 0.3), M.red, [0, -0.2, 0.12]);
    const ft = J['ft' + side] = grp(kn, [0, -0.42, 0]);
    add(ft, rbox(0.22, 0.1, 0.34, 0.25), M.red, [0, -0.03, 0.05]);
    add(ft, rbox(0.23, 0.04, 0.12, 0.4), M.gold, [0, 0.02, 0.17]);
  }
  // KAISER SABER, summoned for the super: it continues the line of the arm from the fist
  const sw = m.sword = grp(J.handR, [0, -0.04, 0.02]);
  add(sw, rbox(0.05, 0.16, 0.05, 0.3), M.dark, [0, 0.02, 0]);                        // grip
  add(sw, rbox(0.2, 0.05, 0.08, 0.3), M.gold, [0, -0.08, 0]);                         // guard
  const blade = new THREE.Mesh(rbox(0.07, 1.4, 0.022, 0.3), new THREE.MeshBasicMaterial({ color: 0xe8fbff }));
  blade.position.set(0, -0.8, 0);
  sw.add(blade);
  const aura = new THREE.Mesh(rbox(0.16, 1.5, 0.08, 0.4), new THREE.MeshBasicMaterial({ color: 0x5fd8ff, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false }));
  aura.position.set(0, -0.8, 0);
  sw.add(aura);
  m.swordTip = grp(sw, [0, -1.5, 0]);
  sw.visible = false;
}

// ---------------------------------------------------------------- GORRAX (the monster)
// Capsules and spheres: barrel body, belly scales, thick legs with claws, a reptile head with a
// working jaw and teeth, three rows of dorsal plates down the back and a five-segment tail.
function buildBeast(m) {
  const { add, grp, M, J } = m;
  m.arm = { el: -0.27, hand: -0.25 };
  const plate = (parent, pos, h, tilt = 0, side = 0) => {
    const p = add(parent, cone(0.06, h, 4), M.plates, pos, [0.35, 1, 1], [tilt, 0, side]);
    p.castShadow = false;
    return p;
  };
  J.pelvis = grp(m.body, [0, 0, 0]);
  add(J.pelvis, sph(0.22, 18, 14), M.skin, [0, 0, -0.02], [1.35, 1, 1.15]);
  J.spine = grp(J.pelvis, [0, 0.1, 0]);
  add(J.spine, sph(0.24, 18, 14), M.skin, [0, 0.08, 0], [1.2, 1.1, 1.05]);
  add(J.spine, sph(0.2, 16, 12), M.belly, [0, 0.04, 0.1], [1.05, 1.15, 0.8]);
  J.chest = grp(J.spine, [0, 0.18, 0]);
  add(J.chest, sph(0.25, 18, 14), M.skin, [0, 0.12, 0], [1.3, 1.1, 1.05]);
  add(J.chest, sph(0.2, 16, 12), M.belly, [0, 0.08, 0.11], [1.15, 1.15, 0.78]);
  for (let i = 0; i < 4; i++) add(J.chest, cap(0.012, 0.28, 6), M.dark, [0, -0.02 + i * 0.07, 0.268 - Math.abs(i - 1.5) * 0.012], null, [0, 0, Math.PI / 2], false); // belly scale lines
  // dorsal plates: tall in the middle row, smaller either side, from the neck down the back
  for (let i = 0; i < 4; i++) {
    const y = 0.3 - i * 0.09, z = -0.22 - i * 0.02;
    plate(J.chest, [0, y, z], 0.2 - i * 0.015, -0.5);
    plate(J.chest, [0.07, y - 0.03, z + 0.01], 0.13, -0.5, -0.25);
    plate(J.chest, [-0.07, y - 0.03, z + 0.01], 0.13, -0.5, 0.25);
  }
  for (let i = 0; i < 2; i++) {
    plate(J.spine, [0, 0.12 - i * 0.1, -0.25], 0.17, -0.7);
    plate(J.spine, [0.07, 0.1 - i * 0.1, -0.23], 0.11, -0.7, -0.25);
    plate(J.spine, [-0.07, 0.1 - i * 0.1, -0.23], 0.11, -0.7, 0.25);
  }
  J.neck = grp(J.chest, [0, 0.32, 0.06]);
  add(J.neck, cap(0.13, 0.12), M.skin, [0, 0.04, 0.02], [1.1, 1, 1], [0.5, 0, 0]);
  plate(J.neck, [0, 0.1, -0.1], 0.15, -0.3);
  J.head = grp(J.neck, [0, 0.13, 0.07]);
  add(J.head, sph(0.12, 18, 14), M.skin, [0, 0.03, 0], [1.05, 0.9, 1.15]);            // skull
  add(J.head, rbox(0.17, 0.09, 0.2, 0.4), M.skin, [0, 0.0, 0.13]);                   // snout
  add(J.head, rbox(0.13, 0.03, 0.06, 0.4), M.dark, [0, 0.045, 0.21], null, null, false); // nostril ridge
  for (const sx of [-1, 1]) {
    add(J.head, rbox(0.07, 0.025, 0.09, 0.4), M.dark, [sx * 0.06, 0.085, 0.05], null, [0.2, 0, sx * 0.3]); // brow
    const eye = add(J.head, sph(0.022, 10, 8), M.eyes, [sx * 0.072, 0.06, 0.085], [1, 0.7, 1]);
    eye.castShadow = false;
    for (let i = 0; i < 4; i++) add(J.head, cone(0.012, 0.035, 4), M.teeth, [sx * 0.07, -0.045, 0.08 + i * 0.045], null, [Math.PI, 0, 0], false);
  }
  add(J.head, rbox(0.15, 0.03, 0.18, 0.4), M.mouth, [0, -0.04, 0.12], null, null, false); // mouth roof
  J.jaw = grp(J.head, [0, -0.05, 0.03]);
  add(J.jaw, rbox(0.15, 0.05, 0.2, 0.4), M.skin, [0, -0.025, 0.1]);
  add(J.jaw, rbox(0.12, 0.02, 0.16, 0.4), M.mouth, [0, 0.005, 0.1], null, null, false);
  for (const sx of [-1, 1]) for (let i = 0; i < 3; i++) add(J.jaw, cone(0.011, 0.03, 4), M.teeth, [sx * 0.06, 0.02, 0.08 + i * 0.05], null, null, false);
  m.muzzle = grp(J.head, [0, -0.03, 0.26]);
  for (const side of ['L', 'R']) {
    const sx = side === 'L' ? 1 : -1;
    const sh = J['sh' + side] = grp(J.chest, [sx * 0.3, 0.2, 0.06]);
    add(sh, sph(0.11, 14, 10), M.skin, [0, 0, 0]);
    const ua = J['ua' + side] = new THREE.Group(); sh.add(ua);
    add(ua, cap(0.095, 0.17), M.skin, [0, -0.13, 0]);
    const el = J['el' + side] = grp(sh, [0, -0.27, 0]);
    const fa = J['fa' + side] = new THREE.Group(); el.add(fa);
    add(fa, cap(0.08, 0.15), M.skin, [0, -0.12, 0]);
    const hand = J['hand' + side] = grp(el, [0, -0.25, 0]);
    add(hand, sph(0.085, 12, 10), M.skin, [0, -0.02, 0.01], [1, 1.05, 1.1]);
    for (let i = -1; i <= 1; i++) add(hand, cone(0.022, 0.1, 5), M.claws, [i * 0.04, -0.09, 0.05], null, [Math.PI * 0.85, 0, 0]);
    const hip = J['hip' + side] = grp(J.pelvis, [sx * 0.16, -0.06, 0]);
    add(hip, cap(0.16, 0.2), M.skin, [0, -0.18, 0]);
    const kn = J['kn' + side] = grp(hip, [0, -0.44, 0]);
    add(kn, cap(0.12, 0.25), M.skin, [0, -0.2, 0]);
    const ft = J['ft' + side] = grp(kn, [0, -0.42, 0]);
    add(ft, sph(0.13, 14, 10), M.skin, [0, -0.02, 0.06], [1, 0.5, 1.5]);
    for (let i = -1; i <= 1; i++) add(ft, cone(0.03, 0.09, 5), M.claws, [i * 0.065, -0.04, 0.24], null, [Math.PI / 2, 0, 0]);
  }
  // the tail: five segments out of the back of the pelvis, each joint at the end of the last
  const L = [0.3, 0.3, 0.28, 0.26, 0.24], R = [0.17, 0.14, 0.11, 0.085, 0.06];
  let parent = J.pelvis, at = [0, 0.02, -0.22];
  for (let i = 0; i < 5; i++) {
    const t = J['tail' + (i + 1)] = grp(parent, at);
    add(t, cap(R[i], L[i], 12), M.skin, [0, 0, -L[i] / 2], null, [Math.PI / 2, 0, 0]);
    const ph = 0.15 - i * 0.022;
    plate(t, [0, R[i] * 0.8, -L[i] * 0.3], ph, -0.9);
    plate(t, [0, R[i] * 0.75, -L[i] * 0.75], ph * 0.85, -0.9);
    if (i < 3) { plate(t, [R[i] * 0.5, R[i] * 0.6, -L[i] * 0.5], ph * 0.6, -0.9, -0.3); plate(t, [-R[i] * 0.5, R[i] * 0.6, -L[i] * 0.5], ph * 0.6, -0.9, 0.3); }
    parent = t; at = [0, 0, -L[i]];
  }
  m.tailTip = grp(J.tail5, [0, 0, -0.26]);
}

// Each fighter: look, scale (model units are ~2 m tall), pelvis height, walk tuning and voice.
export const KAIJU = {
  kaiser: {
    name: 'kaiser', display: 'KAISER-OH', rig: 'mech', scale: 24, outline: 0.07,
    hip: 0.94, walk: 17, stride: 9.5, bob: 0.025, height: 47, radius: 9, // walk was 13 m/s
    voice: 'heir', voiceRate: 0.92, trail: 0x9fe2ff, beamColor: 0xffd23a, beamCore: 0xfffbe8,
    beamName: 'KAISER BEAM', superName: 'SABER FINAL STRIKE', jumpName: 'ROCKET JUMP', diveName: 'KAISER KICK',
    colors: {
      red: 0xd72a31, white: 0xf1efe8, blue: 0x2547b5, gold: 0xf1b52c, grey: 0x8c95a3, dark: 0x262934,
      visor: 0x6ff2ff, emblem: 0xffd84a,
    },
    glows: { visor: 0x6ff2ff, emblem: 0xffcf33 },
    glowIdle: { visor: 0.75, emblem: 0.35 },
    glowCharge: { visor: 0.4, emblem: 1.3 },
  },
  gorrax: {
    name: 'gorrax', display: 'GORRAX', rig: 'beast', scale: 26, outline: 0.07,
    hip: 0.94, walk: 16, stride: 9, bob: 0.035, height: 46, radius: 10, // walk was 12 m/s
    voice: 'patriarch', voiceRate: 0.62, trail: 0x7fe0ff, beamColor: 0x46c4ff, beamCore: 0xe6fbff,
    beamName: 'ATOMIC BREATH', superName: 'NUCLEAR NOVA', jumpName: 'MIGHTY LEAP', diveName: 'BODY SLAM',
    poses: BEAST_POSES,
    colors: {
      skin: 0x3e4c40, dark: 0x1f2721, belly: 0x8b8a68, plates: 0xdcdac6, eyes: 0xffa531,
      teeth: 0xf2ecd8, mouth: 0x5b1d22, claws: 0xe6dec4,
    },
    glows: { plates: 0x52d6ff, eyes: 0xffa020 },
    glowIdle: { plates: 0, eyes: 0.9 },
    glowCharge: { plates: 1.4, eyes: 0.6 },
  },
};
