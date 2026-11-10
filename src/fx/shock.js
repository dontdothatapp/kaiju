// Shockwave rings, impact flash spheres and anime-style radial impact bursts.
import * as THREE from 'three';
import { easeOutExpo, easeOutCubic } from '../core/math.js';

const ringMat = () => new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
  uniforms: { uT: { value: 0 }, uColor: { value: new THREE.Color(1, 1, 1) }, uAlpha: { value: 1 }, uThick: { value: 0.2 } },
  vertexShader: /* glsl */`varying vec2 vUv; void main(){ vUv = uv * 2.0 - 1.0; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: /* glsl */`
    uniform float uT, uAlpha, uThick; uniform vec3 uColor; varying vec2 vUv;
    void main(){
      float r = length(vUv);
      float inner = 1.0 - uThick;
      float a = smoothstep(inner - 0.04, inner + uThick * 0.4, r) * (1.0 - smoothstep(0.97, 1.0, r));
      // hard bright leading edge (cel look)
      a = max(a * 0.55, step(0.93, r) * step(r, 0.985));
      if (a < 0.01) discard;
      gl_FragColor = vec4(uColor * a * uAlpha, 1.0);
    }`,
});

const flashMat = () => new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  uniforms: { uColor: { value: new THREE.Color(1, 1, 1) }, uAlpha: { value: 1 } },
  vertexShader: /* glsl */`varying vec3 vN; varying vec3 vV; void main(){
    vec4 mv = modelViewMatrix * vec4(position,1.0); vN = normalize(normalMatrix*normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv;
    // never white out the screen from inside the sphere
    if (distance(cameraPosition, modelMatrix[3].xyz) < length(modelMatrix[0].xyz) * 1.1 + 0.5) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  }`,
  fragmentShader: /* glsl */`
    uniform vec3 uColor; uniform float uAlpha; varying vec3 vN; varying vec3 vV;
    void main(){
      // brightest at the heart, gone at the edge: a ball of light. (Brightest at the rim, as it
      // was, a hit drew a cluster of soap bubbles that whited the fighters out.)
      float f = abs(dot(normalize(vN), normalize(vV)));
      float a = pow(f, 2.2) * 1.15 + pow(f, 9.0) * 0.5;
      gl_FragColor = vec4(uColor * a * uAlpha, 1.0);
    }`,
});

// Spiky radial burst ("impact star") drawn as a camera-facing star polygon.
function starGeometry(points = 14) {
  const pos = [0, 0, 0];
  const idx = [];
  for (let i = 0; i <= points * 2; i++) {
    const a = (i / (points * 2)) * Math.PI * 2;
    const r = i % 2 === 0 ? 1 : 0.38 + Math.random() * 0.12;
    const rr = i % 2 === 0 ? r * (0.75 + Math.random() * 0.5) : r;
    pos.push(Math.cos(a) * rr, Math.sin(a) * rr, 0);
    if (i > 0) idx.push(0, i, i + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

export class ShockSystem {
  constructor(scene) {
    this.scene = scene;
    this.rings = [];
    this.flashes = [];
    this.stars = [];
    const plane = new THREE.PlaneGeometry(2, 2);
    for (let i = 0; i < 44; i++) {
      const m = new THREE.Mesh(plane, ringMat());
      m.visible = false; m.frustumCulled = false; m.renderOrder = 6;
      scene.add(m);
      this.rings.push({ m, t: 1, life: 1 });
    }
    const sph = new THREE.IcosahedronGeometry(1, 3);
    for (let i = 0; i < 28; i++) {
      const m = new THREE.Mesh(sph, flashMat());
      m.visible = false; m.renderOrder = 7;
      scene.add(m);
      this.flashes.push({ m, t: 1, life: 1 });
    }
    for (let i = 0; i < 8; i++) {
      const m = new THREE.Mesh(starGeometry(10 + i), new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      }));
      m.visible = false; m.renderOrder = 8;
      scene.add(m);
      this.stars.push({ m, t: 1, life: 1 });
    }
  }

  _get(pool) {
    let best = pool[0];
    for (const p of pool) { if (p.t >= p.life) return p; if (p.t / p.life > best.t / best.life) best = p; }
    return best;
  }

  // normal: facing direction of the ring plane (null -> horizontal ground ring)
  ring(pos, normal, radius, color = 0xffffff, life = 0.45, thick = 0.25, alpha = 1) {
    const r = this._get(this.rings);
    r.t = 0; r.life = life; r.radius = radius; r.alpha = alpha;
    r.m.position.copy(pos);
    if (normal) r.m.lookAt(pos.x + normal.x, pos.y + normal.y, pos.z + normal.z);
    else r.m.rotation.set(-Math.PI / 2, 0, 0);
    r.m.material.uniforms.uColor.value.set(color);
    r.m.material.uniforms.uThick.value = thick;
    r.m.visible = true;
    r.m.scale.setScalar(0.01);
  }

  flash(pos, radius, color = 0xffffff, life = 0.18) {
    const f = this._get(this.flashes);
    f.t = 0; f.life = life; f.radius = radius;
    f.m.position.copy(pos);
    f.m.material.uniforms.uColor.value.set(color);
    f.m.visible = true;
  }

  star(pos, radius, color = 0xffffff, life = 0.12) {
    const s = this._get(this.stars);
    s.t = 0; s.life = life; s.radius = radius;
    s.m.position.copy(pos);
    s.m.material.color.set(color);
    s.m.rotation.z = Math.random() * Math.PI;
    s.m.visible = true;
  }

  update(dt, camera) {
    for (const r of this.rings) {
      if (r.t >= r.life) continue;
      r.t += dt;
      const k = Math.min(1, r.t / r.life);
      r.m.scale.setScalar(Math.max(0.01, r.radius * easeOutExpo(k)));
      r.m.material.uniforms.uAlpha.value = r.alpha * (1 - k) * (1 - k);
      if (r.t >= r.life) r.m.visible = false;
    }
    for (const f of this.flashes) {
      if (f.t >= f.life) continue;
      f.t += dt;
      const k = Math.min(1, f.t / f.life);
      f.m.scale.setScalar(f.radius * (0.4 + 0.8 * easeOutCubic(k)));
      f.m.material.uniforms.uAlpha.value = (1 - k) * (1 - k);
      if (f.t >= f.life) f.m.visible = false;
    }
    for (const s of this.stars) {
      if (s.t >= s.life) continue;
      s.t += dt;
      const k = Math.min(1, s.t / s.life);
      s.m.quaternion.copy(camera.quaternion);
      s.m.rotateZ(k * 0.3);
      s.m.scale.setScalar(s.radius * (0.6 + 0.6 * k));
      s.m.material.opacity = 1 - k;
      if (s.t >= s.life) s.m.visible = false;
    }
  }
}
