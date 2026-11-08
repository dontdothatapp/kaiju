// Energy beams: ATOMIC BREATH and the KAISER BEAM. One slot per fighter: an additive glow tube
// with energy rippling down it, a hot white core, a blazing muzzle and a burning tip. The fighter
// re-aims it every frame with set(); if it stops calling, the beam dies on its own.
import * as THREE from 'three';

const _up = new THREE.Vector3(0, 1, 0);
const _d = new THREE.Vector3();

function beamMat(core) {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uColor: { value: new THREE.Color() }, uTime: { value: 0 }, uAlpha: { value: 1 }, uLen: { value: 100 } },
    vertexShader: /* glsl */`
      varying vec2 vUv; varying vec3 vN; varying vec3 vV;
      void main() {
        vUv = uv;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uColor; uniform float uTime, uAlpha, uLen; varying vec2 vUv; varying vec3 vN; varying vec3 vV;
      void main() {
        float f = abs(dot(normalize(vN), normalize(vV)));
        float along = vUv.y * uLen;
        float flow = 0.5 + 0.5 * sin(along * 0.12 - uTime * 38.0) * sin(along * 0.031 - uTime * 17.0 + vUv.x * 6.283);
        float a = ${core ? 'smoothstep(0.25, 0.75, f) * 1.6' : 'pow(f, 1.6) * (0.55 + 0.6 * flow)'};
        // the first few metres out of the mouth fade in
        a *= smoothstep(0.0, 6.0, along);
        gl_FragColor = vec4(uColor * a * uAlpha, 1.0);
      }`,
  });
}

function glowMat() {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uColor: { value: new THREE.Color() }, uAlpha: { value: 1 } },
    vertexShader: /* glsl */`varying vec3 vN; varying vec3 vV; void main(){
      vec4 mv = modelViewMatrix * vec4(position, 1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: /* glsl */`uniform vec3 uColor; uniform float uAlpha; varying vec3 vN; varying vec3 vV;
      void main(){ float f = abs(dot(normalize(vN), normalize(vV))); gl_FragColor = vec4(uColor * (pow(f, 2.0) * 1.4) * uAlpha, 1.0); }`,
  });
}

export class BeamSystem {
  constructor(scene) {
    const tube = new THREE.CylinderGeometry(1, 1, 1, 24, 1, true).translate(0, 0.5, 0);
    const ball = new THREE.IcosahedronGeometry(1, 3);
    this.t = 0;
    this.slots = [0, 1].map(() => {
      const g = new THREE.Group();
      const outer = new THREE.Mesh(tube, beamMat(false));
      const inner = new THREE.Mesh(tube, beamMat(true));
      const muzzle = new THREE.Mesh(ball, glowMat());
      const tip = new THREE.Mesh(ball, glowMat());
      for (const m of [outer, inner, muzzle, tip]) { m.frustumCulled = false; m.renderOrder = 9; }
      g.add(outer); g.add(inner);
      scene.add(g); scene.add(muzzle); scene.add(tip);
      g.visible = muzzle.visible = tip.visible = false;
      return { g, outer, inner, muzzle, tip, hold: 0, life: 0, max: 0, width: 5 };
    });
  }

  // aim slot `id` from a to b this frame
  set(id, a, b, color, core, width = 5) {
    const s = this.slots[id];
    _d.subVectors(b, a);
    const len = Math.max(0.1, _d.length());
    s.g.position.copy(a);
    s.g.quaternion.setFromUnitVectors(_up, _d.divideScalar(len));
    s.outer.scale.set(width, len, width);
    s.inner.scale.set(width * 0.38, len, width * 0.38);
    for (const m of [s.outer, s.inner]) { m.material.uniforms.uLen.value = len; }
    s.outer.material.uniforms.uColor.value.set(color);
    s.inner.material.uniforms.uColor.value.set(core);
    s.muzzle.material.uniforms.uColor.value.set(color);
    s.tip.material.uniforms.uColor.value.set(color);
    s.muzzle.position.copy(a); s.muzzle.scale.setScalar(width * 1.9);
    s.tip.position.copy(b); s.tip.scale.setScalar(width * (2.4 + Math.random() * 0.8));
    s.g.visible = s.muzzle.visible = s.tip.visible = true;
    s.hold = 0.1;
    s.width = width;
    if (!s.life) this._alpha(s, 1);
  }

  // a single short blast (GORRAX's point-blank nova): visible for `life` seconds, fading out
  flash(id, a, b, color, core, life = 0.4) {
    this.set(id, a, b, color, core, 9);
    const s = this.slots[id];
    s.life = life; s.max = life;
  }

  off(id) {
    const s = this.slots[id];
    s.g.visible = s.muzzle.visible = s.tip.visible = false;
    s.hold = 0; s.life = 0;
  }

  _alpha(s, a) {
    for (const m of [s.outer, s.inner, s.muzzle, s.tip]) m.material.uniforms.uAlpha.value = a;
  }

  update(dt) {
    this.t += dt;
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (!s.g.visible) continue;
      s.outer.material.uniforms.uTime.value = this.t;
      s.inner.material.uniforms.uTime.value = this.t;
      if (s.life > 0) {
        s.life -= dt;
        this._alpha(s, Math.max(0, s.life / s.max));
        if (s.life <= 0) this.off(i);
        continue;
      }
      s.hold -= dt;
      if (s.hold <= 0) this.off(i);
    }
  }
}
