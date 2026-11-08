// Every move once, against the training dummy, logging what each fighter is doing after it.
// node tools/shot.mjs "http://localhost:5173/?fight&norender&mute&kaiju=gorrax" /tmp/k.png 4000 tools/s_kaiju.mjs
export default async function (page) {
  const ev = (f, a) => page.evaluate(f, a);
  await ev(() => window.__test.hold(true));
  const adv = (s) => ev((s) => window.__test.advance(s), s);
  const st = () => ev(() => {
    const G = window.__G, p = G.player, b = G.bot;
    const up = (f) => (f.pos.y - G.ground.heightAt(f.pos.x, f.pos.z)).toFixed(0);
    return `P:${p.state}${p.move ? '(' + p.move.name + ')' : ''} y=${up(p)} B:${b.state}/${b.hp.toFixed(0)} y=${up(b)} d=${p.flatDist(b).toFixed(0)} chunks=${G.stats.chunksDestroyed} bodies=${G.debris.activeCount}`;
  });
  const press = (a) => ev((a) => window.__G.input.press(a), a);
  const release = (a) => ev((a) => window.__G.input.release(a), a);
  const tap = async (a) => { await press(a); await adv(1 / 60); await release(a); };
  // put the dummy `d` metres in front of the player, both standing still
  const close = (d) => ev((d) => {
    const G = window.__G, p = G.player, b = G.bot;
    const dir = b.pos.clone().sub(p.pos).setY(0).normalize();
    b.cancelActions(); p.cancelActions();
    b.pos.copy(p.pos).addScaledVector(dir, d); b.pos.y = G.ground.heightAt(b.pos.x, b.pos.z) + b.hipH;
    b.vel.set(0, 0, 0); b.setState('free'); b.invuln = 0;
    p.pos.y = G.ground.heightAt(p.pos.x, p.pos.z) + p.hipH; p.vel.set(0, 0, 0); p.setState('free');
  }, d);
  await ev(() => window.__G.game.brain.setDifficulty('training'));
  await adv(2.5);
  const log = [];
  await press('fwd'); await adv(2); log.push('walk      ' + await st()); await release('fwd'); await adv(1);
  await close(28); for (let i = 0; i < 4; i++) { await tap('light'); await adv(0.4); } log.push('combo     ' + await st()); await adv(3);
  await close(34); await press('heavy'); await adv(1.1); await release('heavy'); await adv(0.3); log.push('charged   ' + await st()); await adv(3);
  await close(36); await tap('down'); await adv(0.6); log.push('stomp     ' + await st()); await adv(3);
  await close(70); await tap('up'); await adv(0.5); log.push('jump      ' + await st()); await tap('light'); await adv(0.7); log.push('slam      ' + await st()); await adv(3);
  await close(110); await ev(() => { window.__G.player.beamE = 1; }); await tap('rise'); await adv(1.3); log.push('beam      ' + await st()); await adv(2); log.push('beam end  ' + await st()); await adv(1);
  await close(28); await tap('grab'); await adv(0.6); log.push('grab      ' + await st()); await adv(1.4); log.push('throw     ' + await st()); await adv(3);
  await close(150); await press('fwd'); await press('dash'); await adv(2.2); log.push('run       ' + await st()); await tap('light'); await adv(0.3); log.push('tackle    ' + await st()); await release('dash'); await release('fwd'); await adv(3);
  await close(30); await ev(() => { window.__G.player.meter = 100; }); await tap('super'); await adv(1.2); log.push('super     ' + await st()); await adv(2.6); log.push('super end ' + await st()); await adv(3);
  log.push('after     ' + await st());
  console.log(log.join('\n'));
}
