/**
 * Unit test: switching decks must invalidate everything the panel holds
 * per-deck.  Run: node tools/test-panel-deckswitch.mjs
 *
 * Moxfield routes client-side, so moving between decks does NOT reload the
 * content script. Combos, the average list and the current selection are all
 * per-deck and have to be invalidated by hand. A tab that is not currently
 * open is the easiest place to get that wrong: it renders on next open, from
 * whatever it was last given.
 *
 * This loads src/panel.js into a blank page with a stubbed messenger, rather
 * than driving Moxfield. That is deliberate — the logic under test is the
 * invalidation, and a real two-deck run depends on Moxfield's public deck list
 * being clickable, which made it slow and flaky without testing anything more.
 * Headless is fine here: no Cloudflare involved.
 */

import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const panelSrc = readFileSync(join(root, 'src', 'panel.js'), 'utf8');
const css = readFileSync(join(root, 'src', 'badge.css'), 'utf8');

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? '  ' + detail : ''}`);
};

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
page.on('console', (m) => { if (m.type() === 'error' || /edhrec/i.test(m.text())) console.log('CONSOLE:', m.text().slice(0, 200)); });

// The stub must exist BEFORE panel.js runs: it captures the messenger at
// evaluation time, so a stub installed afterwards is never seen. addInitScript
// is no good here either - setContent does not re-run init scripts.
const STUB = `
  globalThis.chrome = {
    runtime: {
      sendMessage: async (msg) => {
        if (msg.type === 'lookup-combos') {
          // Deliberately slow. A real combo lookup takes a moment, and the bug
          // being tested lives in that gap: if the old answer is not cleared,
          // it is what the tab shows until the new one lands. An instant stub
          // would hide the bug behind its own replacement.
          await new Promise((r) => setTimeout(r, 700));
          const who = msg.commanders[0] || '?';
          return { ok: true, included: [], almost: [{
            id: who + '-1',
            cards: [who + ' Piece A', who + ' Piece B'],
            produces: ['Infinite something'],
            popularity: 10,
            missing: [who + ' Piece B'],
          }] };
        }
        if (msg.type === 'lookup-average') return { ok: true, cards: [msg.commanders[0] + ' avg card'] };
        if (msg.type === 'lookup-prices') return { ok: true, prices: {} };
        return { ok: false };
      },
    },
  };
`;

await page.setContent(`<style>${css}</style>`);
await page.evaluate(STUB);
await page.evaluate(panelSrc);

const deckState = (deckId, commander) => ({
  deckId,
  commander,
  commanders: [commander],
  lists: [{ header: 'High Synergy Cards', cards: [`${commander} rec`] }],
  stats: { [`${commander.toLowerCase()} rec`]: { name: `${commander} rec`, synergy: 0.5 } },
  salt: {},
  deck: new Set(['something']),
  deckCards: [{ name: 'Something', canonical: 'Something' }],
  mismatch: null,
});

const snap = () =>
  page.evaluate(() => ({
    sub: document.querySelector('.edhrec-panel-sub')?.textContent ?? null,
    lines: [...document.querySelectorAll('.edhrec-panel-combolines')].map((n) => n.textContent.trim()),
  }));

try {
  // Deck A: open the drawer and select Combos.
  await page.evaluate((s) => globalThis.EdhrecPanel.update({ ...s, deck: new Set(s.deck) }), {
    ...deckState('/decks/AAA', 'Alpha'),
    deck: [...deckState('/decks/AAA', 'Alpha').deck],
  });
  await page.click('.edhrec-panel-launcher');
  await page.locator('.edhrec-panel-tab', { hasText: 'Combos' }).first().click();
  await page.waitForTimeout(1600);
  const a = await snap();
  check(a.lines.some((l) => l.includes('Alpha')), 'deck A combos render', `(${a.lines[0] ?? 'none'})`);

  // Deck B, with the Combos tab still selected. Nothing from A may survive,
  // and it must not merely be replaced later — it must be gone immediately.
  await page.evaluate((s) => globalThis.EdhrecPanel.update({ ...s, deck: new Set(s.deck) }), {
    ...deckState('/decks/BBB', 'Beta'),
    deck: [...deckState('/decks/BBB', 'Beta').deck],
  });
  const immediate = await snap();
  check(
    !immediate.lines.some((l) => l.includes('Alpha')),
    'deck A combos are gone before deck B answers',
    `(${immediate.lines.join(' | ') || 'empty'})`
  );

  await page.waitForTimeout(1600);
  const b = await snap();
  check(b.lines.some((l) => l.includes('Beta')), 'deck B combos load in their place', `(${b.lines[0] ?? 'none'})`);
  check(b.sub?.includes('Beta') === true, 'panel header follows the new deck', `(${b.sub})`);
} catch (err) {
  failures++;
  console.log('FAILED:', err.message.split('\n')[0]);
} finally {
  await browser.close();
}

console.log(failures === 0 ? '\nPASS' : `\nFAIL - ${failures} check(s) failed`);
process.exitCode = failures ? 1 : 0;
