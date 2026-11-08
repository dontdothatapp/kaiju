// Arena edge: the destructible core is a square. When a fighter nears its edge a patch of
// glowing grid "force field" fades in around them, so the limit reads as part of the world
// instead of an invisible wall.
import * as THREE from 'three';
import { ARENA } from './city.js';

export { ARENA };

export class Boundary {
  constructor(scene) {
    this.u = {
      uA: { value: new THREE.Vector3(0, -1e4, 0) },
      uB: { value: new THREE.Vector3(0, -1e4, 0) },
      uTime: { value: 0 },
      uColor: { value: new THREE.Color(0x5fd4ff) },
    };
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
      uniforms: this.u,
      vertexShader: /* glsl */`varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: /* glsl */`
        uniform vec3 uA, uB, uColor; uniform float uTime; varying vec3 vW;
        float fieldPatch(vec3 p) {
          float d = distance(vW, p);
          return 1.0 - smoothstep(30.0, 120.0, d);
        }
        void main() {
          float a = max(fieldPatch(uA), fieldPatch(uB) * 0.7);
          if (a < 0.01) discard;
          vec2 uv = vec2(vW.x + vW.z, vW.y);
          vec2 g = abs(fract(uv / 9.0 - 0.5) - 0.5) / max(fwidth(uv / 9.0), vec2(1e-4));
          float line = 1.0 - min(min(g.x, g.y), 1.0);
          float scan = 0.5 + 0.5 * sin(vW.y * 0.2 - uTime * 6.0);
          gl_FragColor = vec4(uColor * (line * 1.1 + 0.1 + scan * 0.08) * a, 1.0);
        }`,
    });
    const size = ARENA * 2, h = 420;
    for (const [x, z, ry] of [[ARENA, 0, Math.PI / 2], [-ARENA, 0, Math.PI / 2], [0, ARENA, 0], [0, -ARENA, 0]]) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(size, h), mat);
      m.position.set(x, h / 2, z);
      m.rotation.y = ry;
      m.renderOrder = 6;
      m.frustumCulled = false;
      scene.add(m);
    }
  }

  update(t, a, b) {
    this.u.uTime.value = t;
    this.u.uA.value.copy(a);
    this.u.uB.value.copy(b);
  }
}
