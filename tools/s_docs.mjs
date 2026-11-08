// Captures the README screenshots (docs/shot-*.jpg). Run it three times:
//   W=1280 H=720 node tools/shot.mjs "http://localhost:5173/?fight&mute&kaiju=kaiser" docs/x.png 5000 tools/s_docs.mjs
//   W=1280 H=720 node tools/shot.mjs "http://localhost:5173/?fight&mute&kaiju=gorrax&shot=beam" docs/x.png 5000 tools/s_docs.mjs
//   W=1280 H=720 node tools/shot.mjs "http://localhost:5173/?auto&intro&mute&kaiju=kaiser" docs/x.png 5000 tools/s_docs.mjs
// fight / down / leap, then the ATOMIC BREATH, then the round opener (the monster by the Flatiron).
export default async function (page, out) {
  const dir = out.replace(/[^/]+$/, '');
  const snap = (name) => page.screenshot({ path: dir + name, type: 'jpeg', quality: 86, timeout: 600000 });
  const ev = (f, a) => page.evaluate(f, a);
  const adv = (s) => ev((s) => window.__test.advance(s), s);
  const render = () => ev(() => window.__test.render());
  await ev(() => { window.__test.hold(true); window.__G.hud.hint(''); window.__G.hud.hint = () => {}; });
  const q = new URL(page.url()).searchParams;
  if (q.has('intro')) {
    await adv(5.7); await render();
    await snap('shot-intro.jpg');
    return;
  }
  await ev(() => window.__G.game.brain.setDifficulty('training'));
  const press = (a) => ev((a) => window.__G.input.press(a), a);
  const release = (a) => ev((a) => window.__G.input.release(a), a);
  const tap = async (a) => { await press(a); await adv(1 / 60); await release(a); };
  const close = (d) => ev((d) => {
    const G = window.__G, p = G.player, b = G.bot;
    const dir = b.pos.clone().sub(p.pos).setY(0).normalize();
    b.cancelActions(); p.cancelActions();
    b.pos.copy(p.pos).addScaledVector(dir, d); b.pos.y = G.ground.heightAt(b.pos.x, b.pos.z) + b.hipH;
    b.vel.set(0, 0, 0); b.setState('free'); b.invuln = 0;
    p.pos.y = G.ground.heightAt(p.pos.x, p.pos.z) + p.hipH; p.vel.set(0, 0, 0); p.setState('free');
  }, d);
  await adv(2.5);
  if (q.get('shot') === 'beam') {
    // play as GORRAX (?kaiju=gorrax): the plates blaze and the breath pours onto the robot's guard
    await close(95);
    await ev(() => { const G = window.__G; G.player.beamE = 1; G.bot.ctrl.press('block'); G.bot.setState('block'); });
    await tap('rise'); await adv(1.25);
    await ev(() => { const G = window.__G; G.bot.ctrl.press('block'); G.bot.setState('block'); G.bot.stateT = 0; });
    await adv(0.05); await render(); await snap('shot-beam.jpg');
    return;
  }
  // 1) a charged heavy landing, then him on his back in the street
  await close(34); await press('heavy'); await adv(1.05); await release('heavy'); await adv(0.14);
  await render(); await snap('shot-fight.jpg');
  // wait till he's on his back in the street (or 3 s), then a beat for the dust to roll out
  for (let i = 0; i < 30 && (await ev(() => window.__G.bot.state)) !== 'down'; i++) await adv(0.1);
  await adv(0.35); await render(); await snap('shot-down.jpg');
  await adv(2.5);
  // 2) leap, then the slam on the way down
  await close(85); await tap('up'); await adv(0.5); await tap('light'); await adv(0.22);
  await render(); await snap('shot-leap.jpg');
}
