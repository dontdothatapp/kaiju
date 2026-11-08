// The game flow end to end, without rendering: the title's kaiju swap, the round opener, a match
// won in a hurry, the recap, the rampage afterwards (with a beam), the rematch, and the tutorial.
// node tools/shot.mjs "http://localhost:5173/?norender&mute" /tmp/f.png 4000 tools/s_flow.mjs
export default async function (page) {
  const ev = (f, a) => page.evaluate(f, a);
  const adv = (s) => ev((s) => window.__test.advance(s), s);
  const st = (tag) => ev((tag) => {
    const G = window.__G, p = G.player, b = G.bot;
    return `${tag.padEnd(12)} game=${G.game.state} r${G.game.round} wins=${G.game.wins} P:${p.name}/${p.state} B:${b.name}/${b.state} recap=${G.recap.active} chunks=${G.stats.chunksDestroyed}`;
  }, tag);
  const log = [];
  await ev(() => window.__test.hold(true));
  log.push(await st('title'));
  await ev(() => window.__G.game.setPlayAs('gorrax'));
  await adv(1);
  log.push(await st('swapped'));
  await ev(() => window.__G.game.setPlayAs('kaiser'));
  await ev(() => { const G = window.__G; G.game.start('training'); });
  log.push(await st('start'));
  await adv(4); log.push(await st('opener 4s'));
  await adv(8); log.push(await st('opener 12s'));
  await adv(6); log.push(await st('fight'));
  // round 1 and 2 to the player
  for (let r = 0; r < 2; r++) {
    await ev(() => { const G = window.__G; if (G.game.state === 'fight') G.bot.takeDamage(999, G.player, false); });
    await adv(5); log.push(await st('ko ' + r));
    await adv(14); log.push(await st('next ' + r));
  }
  await adv(10); log.push(await st('recap?'));
  await ev(() => window.__G.recap.active && window.__G.recap.skip());
  await adv(3); log.push(await st('after recap'));
  // the rampage: walk, then a beam where the camera looks
  await ev(() => window.__G.input.press('fwd')); await adv(2); await ev(() => window.__G.input.release('fwd'));
  await ev(() => { window.__G.input.press('rise'); }); await adv(0.05); await ev(() => window.__G.input.release('rise'));
  await adv(1.5); log.push(await st('rampage beam'));
  await adv(2);
  await ev(() => window.__G.game.rematch()); await adv(2); log.push(await st('rematch'));
  // the tutorial, skipped step by step
  await ev(() => { const G = window.__G; G.game.state = 'title'; G.game.startTutorial(); });
  for (let i = 0; i < 15; i++) { await ev(() => window.__G.game.tutorial.skip()); await adv(1.6); }
  log.push(await st('tutorial') + ' panel=' + await ev(() => window.__G.game.tutorial.panel));
  console.log(log.join('\n'));
}
