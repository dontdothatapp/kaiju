// Thin wrapper around Rapier: world, ground heightfield, collision groups, events.
let RAPIER = null;

// membership bits
export const GROUP = { GROUND: 1, STATIC: 2, DEBRIS: 4, SMALL: 8, PROP: 16, CHAR: 32 };
export const groups = (member, filter) => ((member & 0xffff) << 16) | (filter & 0xffff);
export const CG = {
  ground: groups(GROUP.GROUND, 0xffff),
  static: groups(GROUP.STATIC, GROUP.DEBRIS | GROUP.SMALL | GROUP.PROP),
  debris: groups(GROUP.DEBRIS, GROUP.GROUND | GROUP.STATIC | GROUP.DEBRIS | GROUP.SMALL | GROUP.PROP | GROUP.CHAR),
  small: groups(GROUP.SMALL, GROUP.GROUND | GROUP.STATIC | GROUP.DEBRIS | GROUP.PROP | GROUP.CHAR),
  prop: groups(GROUP.PROP, 0xffff & ~GROUP.CHAR),
  char: groups(GROUP.CHAR, GROUP.DEBRIS | GROUP.SMALL),
};

export class Physics {
  static async create() {
    // SIMD build is ~10-30% faster; fall back to the scalar build on old browsers.
    try {
      RAPIER = (await import('@dimforge/rapier3d-simd-compat')).default;
      await RAPIER.init();
    } catch (e) {
      console.warn('Rapier SIMD unavailable, using scalar build', e);
      RAPIER = (await import('@dimforge/rapier3d-compat')).default;
      await RAPIER.init();
    }
    return new Physics();
  }

  constructor() {
    this.R = RAPIER;
    this.world = new RAPIER.World({ x: 0, y: -13, z: 0 });
    this.world.numSolverIterations = 2;
    this.events = new RAPIER.EventQueue(true);
    this.groundCollider = null;
    this.onContactForce = null; // (h1, h2, force, dirY) => void
    this.stepMs = 0;
  }

  // Chrome compiles WebAssembly lazily: the first time a contact code path runs (hull vs
  // hull, hull vs heightfield...) it can stall ~100 ms. Exercise every path once at load.
  warmup(fractureLib) {
    const R = this.R;
    const w = new R.World({ x: 0, y: -13, z: 0 });
    w.numSolverIterations = 2;
    const q = new R.EventQueue(true);
    const n = 16;
    w.createCollider(R.ColliderDesc.heightfield(n, n, new Float32Array((n + 1) * (n + 1)), { x: 60, y: 1, z: 60 }, R.HeightFieldFlags.FIX_INTERNAL_EDGES));
    for (let i = 0; i < 6; i++) w.createCollider(R.ColliderDesc.cuboid(1.5, 1.8, 0.5).setTranslation(i * 3 - 9, 1.8, 0));
    let k = 0;
    for (const variant of fractureLib) {
      for (const p of variant) {
        const b = w.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation((k % 6) * 1.5 - 4, 3 + Math.floor(k / 6) * 1.2, (k % 3) - 1).setLinvel(k % 2 ? 20 : -20, -10, 0));
        const pts = new Float32Array(p.hull.length);
        for (let i = 0; i < pts.length; i++) pts[i] = p.hull[i] * 2;
        w.createCollider(R.ColliderDesc.convexHull(pts).setActiveEvents(R.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(1), b);
        k++;
      }
    }
    for (let i = 0; i < 6; i++) {
      const b = w.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(i * 2 - 6, 6, 1).setLinvel(0, -15, 0));
      w.createCollider(i % 2 ? R.ColliderDesc.cuboid(0.8, 0.4, 0.6) : R.ColliderDesc.ball(0.5), b);
    }
    const kin = w.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(0, 3, 0));
    w.createCollider(R.ColliderDesc.ball(1), kin);
    for (let s = 0; s < 40; s++) {
      kin.setNextKinematicTranslation({ x: Math.sin(s * 0.2) * 3, y: 3, z: 0 });
      w.timestep = 1 / 60;
      w.step(q);
      q.drainContactForceEvents(() => {});
    }
    w.free();
  }

  setGroundHeights(heights, n, size) {
    const R = this.R;
    if (this.groundCollider) this.world.removeCollider(this.groundCollider, false); // don't wake the whole city
    const desc = R.ColliderDesc.heightfield(n, n, heights, { x: size, y: 1, z: size }, R.HeightFieldFlags.FIX_INTERNAL_EDGES)
      .setFriction(0.9).setRestitution(0.05).setCollisionGroups(CG.ground);
    this.groundCollider = this.world.createCollider(desc);
  }

  fixedBox(cx, cy, cz, hx, hy, hz) {
    const d = this.R.ColliderDesc.cuboid(hx, hy, hz).setTranslation(cx, cy, cz)
      .setCollisionGroups(CG.static).setFriction(0.8);
    return this.world.createCollider(d);
  }

  removeCollider(c) {
    if (c) this.world.removeCollider(c, true);
  }

  kinematicBall(radius) {
    const b = this.world.createRigidBody(this.R.RigidBodyDesc.kinematicPositionBased().setTranslation(0, -100, 0));
    this.world.createCollider(this.R.ColliderDesc.ball(radius).setCollisionGroups(CG.char), b);
    return b;
  }

  // kaiju body: an upright capsule that shoves debris (and cars) out of the way
  kinematicCapsule(halfHeight, radius) {
    const b = this.world.createRigidBody(this.R.RigidBodyDesc.kinematicPositionBased().setTranslation(0, -200, 0));
    this.world.createCollider(this.R.ColliderDesc.capsule(halfHeight, radius).setCollisionGroups(CG.char), b);
    return b;
  }

  step(dt) {
    if (dt <= 0) return;
    const t0 = performance.now();
    const steps = dt > 1 / 40 ? 2 : 1;
    const h = Math.min(dt / steps, 1 / 30);
    this.world.timestep = h;
    for (let i = 0; i < steps; i++) {
      this.world.step(this.events);
      if (this.onContactForce) {
        this.events.drainContactForceEvents((e) => {
          this.onContactForce(e.collider1(), e.collider2(), e.totalForceMagnitude());
        });
      } else {
        this.events.drainContactForceEvents(() => {});
      }
    }
    this.stepMs = performance.now() - t0;
  }
}
