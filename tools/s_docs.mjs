// Captures the README screenshots (docs/shot-*.jpg). Run it twice:
//   W=1280 H=720 node tools/shot.mjs "http://localhost:5173/?fight&mute" docs/x.png 5000 tools/s_docs.mjs
//   W=1280 H=720 node tools/shot.mjs "http://localhost:5173/?auto&intro&mute&kaiju=kaiser" docs/x.png 5000 tools/s_docs.mjs
// The second one (with ?intro) grabs the round opener: the monster landing by the Flatiron.
export default async function (page, out) {
  const dir = out.replace(/[^/]+$/, '');
  const snap = (name) => page.screenshot({ path: dir + name, type: 'jpeg', quality: 86, timeout: 600000 });
  const ev = (f, a) => page.evaluate(f, a);
  const adv = (s) => ev((s) => window.__test.advance(s), s);
  const render = () => ev(() => window.__test.render());
  await ev(() => { window.__test.hold(true); window.__G.hud.hint(''); window.__G.hud.hint = () => {}; });
  if (new URL(page.url()).searchParams.has('intro')) {
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
  // 1) a charged heavy landing, then him on his back in the street
  await close(34); await press('heavy'); await adv(1.05); await release('heavy'); await adv(0.14);
  await render(); await snap('shot-fight.jpg');
  await adv(1.7); await render(); await snap('shot-down.jpg');
  await adv(2.5);
  // 2) ATOMIC BREATH (or the KAISER BEAM) coming at you while you brace
  await close(110);
  await ev(() => { const b = window.__G.bot; b.beamE = 1; b.beamStart(); });
  await adv(0.4); await press('block'); await adv(0.75);
  await render(); await snap('shot-beam.jpg');
  await release('block'); await adv(2.5);
  // 3) leap, then the slam on the way down
  await close(85); await tap('up'); await adv(0.5); await tap('light'); await adv(0.22);
  await render(); await snap('shot-leap.jpg');
}
