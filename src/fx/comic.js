// Comic-book onomatopoeia ("KRAKOOM!") popping out of big impacts, plus speech bubbles.
import * as THREE from 'three';
import { easeOutBack, rand, pick } from '../core/math.js';

const WORDS = {
  light: ['WHAP!', 'THWAK!', 'POW!', 'SMAK!', 'BAP!'],
  heavy: ['KRAK!', 'WHAM!', 'THOOM!', 'KRUNCH!', 'SKRAKK!'],
  huge: ['KRAKOOM!', 'KA-BLAM!', 'SKRA-KOOOM!', 'BWAKOOM!', 'KRA-THOOM!'],
  break: ['KRSSH!', 'KRUMBLE!', 'SMASH!', 'KRAK-KRAK!'],
  glass: ['TSSHH!', 'KSHH!'],
  ground: ['THOOOM!', 'KA-THUD!', 'BOOOM!'],
  parry: ['PARRY!'],
  block: ['TINK!', 'KLANG!'],
  slash: ['SHING!', 'ZANG!', 'SLASH!'],
  throw: ['HEAVE!', 'WHOOMPH!', 'YAAARGH!'],
  finish: ['KA-BOOOOM!', 'KRA-KA-BOOM!'],
  dive: ['WHOOOSH!'],
  beam: ['ZZRAAAK!'],
  super: ['FINISH HIM!'],
  boom: ['KA-BOOM!', 'BOOOOM!', 'KABLAM!'],
};
const SCHEMES = [
  { fill: '#ffe23d', stroke: '#e2231a' },
  { fill: '#ffffff', stroke: '#1d4fd8' },
  { fill: '#ff7a1a', stroke: '#2a0d0d' },
  { fill: '#fff3b0', stroke: '#c81d6b' },
];

const texCache = new Map();
function wordTexture(word, scheme) {
  const key = word + scheme.fill;
  if (texCache.has(key)) return texCache.get(key);
  const c = document.createElement('canvas');
  const fontSize = 120;
  const ctx = c.getContext('2d');
  ctx.font = `${fontSize}px Bangers, Impact, 'Arial Black', sans-serif`;
  const w = Math.ceil(ctx.measureText(word).width + 80);
  c.width = w; c.height = 190;
  ctx.font = `${fontSize}px Bangers, Impact, 'Arial Black', sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  const x = w / 2, y = 98;
  // drop shadow block
  ctx.fillStyle = '#111';
  ctx.fillText(word, x + 8, y + 9);
  ctx.lineWidth = 26; ctx.strokeStyle = '#111'; ctx.strokeText(word, x, y);
  ctx.lineWidth = 14; ctx.strokeStyle = scheme.stroke; ctx.strokeText(word, x, y);
  const g = ctx.createLinearGradient(0, y - 50, 0, y + 50);
  g.addColorStop(0, '#ffffff');
  g.addColorStop(0.35, scheme.fill);
  g.addColorStop(1, scheme.fill);
  ctx.fillStyle = g;
  ctx.fillText(word, x, y);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const out = { tex, aspect: w / 190 };
  texCache.set(key, out);
  return out;
}

export class ComicText {
  constructor(scene) {
    this.items = [];
    for (let i = 0; i < 10; i++) {
      const mat = new THREE.SpriteMaterial({ transparent: true, depthTest: false, depthWrite: false, toneMapped: false });
      const s = new THREE.Sprite(mat);
      s.visible = false;
      s.renderOrder = 20;
      scene.add(s);
      this.items.push({ s, t: 1, life: 1 });
    }
    this.cooldown = 0;
  }

  // text: say this instead of a word from the kind's list (move names: "ATOMIC BREATH!")
  pop(kind, pos, size = 1, camera, text = null) {
    if (this.cooldown > 0 && kind !== 'parry' && !text) return;
    this.cooldown = 0.12;
    const word = text || pick(WORDS[kind] || WORDS.heavy);
    const scheme = pick(SCHEMES);
    const { tex, aspect } = wordTexture(word, scheme);
    let it = this.items.find((x) => x.t >= x.life) || this.items.reduce((a, b) => (a.t / a.life > b.t / b.life ? a : b));
    it.s.material.map = tex;
    it.s.material.needsUpdate = true;
    it.s.material.rotation = rand(-0.35, 0.35);
    it.t = 0; it.life = 0.75 + size * 0.15;
    it.aspect = aspect;
    // keep readable size regardless of distance
    const dist = camera ? camera.position.distanceTo(pos) : 20;
    it.base = Math.max(2.2, dist * 0.085) * size;
    it.s.position.copy(pos);
    it.vel = new THREE.Vector3(rand(-1, 1), 2.5, rand(-1, 1)).multiplyScalar(dist * 0.02);
    it.s.visible = true;
  }

  update(dt, realDt) {
    this.cooldown -= realDt;
    for (const it of this.items) {
      if (it.t >= it.life) continue;
      it.t += realDt; // text animates in real time so it pops even during hitstop
      const k = it.t / it.life;
      const pop = k < 0.18 ? easeOutBack(k / 0.18) : 1 + (k - 0.18) * 0.15;
      const s = it.base * pop;
      it.s.scale.set(s * it.aspect * 0.5, s * 0.5, 1);
      it.s.position.addScaledVector(it.vel, realDt);
      it.s.material.opacity = k > 0.7 ? 1 - (k - 0.7) / 0.3 : 1;
      if (it.t >= it.life) it.s.visible = false;
    }
  }
}
