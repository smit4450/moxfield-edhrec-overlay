/**
 * Unit test: the drawer's "a filter may be active" warning must compare copies
 * with copies.  Run: node tools/test-deck-count.mjs
 *
 * The drawer warns when fewer cards are on the page than Moxfield's "N main
 * deck" says, because a filter would make "not in this deck" a lie. That
 * figure counts copies; the drawer counted distinct names. So 32 Mountains made
 * a fully shown 100-card deck read as "Only 69 of 100 cards are visible", on
 * nearly every Commander deck, at the top of every tab.
 *
 * The quantity markup below is Moxfield's, read off a live deck on 2026-10-03
 * in each view: "x32" on a grid card, "32" in a text row's first cell, "32"
 * beside a stack's strip.
 *
 * Stubbed messenger, no network, no Moxfield: deterministic and headless.
 */

import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(root, 'src', f), 'utf8');

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? '  ' + detail : ''}`);
};

// A 100-card deck: a commander, 67 other singles, and 32 Mountains. 69 names.
const ids = (i) => `C${String(i).padStart(3, '0')}x`;
const cards = [
  { id: 'Cmdr1', name: 'Test Commander', qty: 1 },
  ...Array.from({ length: 67 }, (_, i) => ({ id: ids(i), name: `Single ${i}`, qty: 1 })),
  { id: 'G4D2Z', name: 'Mountain', qty: 32 },
];
const VIEWS = {
  grid: (c) =>
    `<div data-hash="${c.id}" class="decklist-card"><div class="decklist-card-phantomsearch">${c.name}</div>` +
    `<div class="decklist-card-quantity">x${c.qty}</div><div style="position:relative">` +
    `<div id="vd-${c.id}" class="img-card-visual"><img class="img-card" alt="${c.name}" width="60" height="84"></div></div></div>`,
  text: (c) =>
    `<li data-hash="${c.id}"><div class="text-end"><div style="width:20px">${c.qty}</div></div>` +
    `<div class="w-100"><a id="id_r_${c.id}_-${c.id}" class="table-deck-row-link" href="/cards/${c.id}-x">${c.name}</a></div></li>`,
  stacks: (c) =>
    `<div class="strip">${c.qty > 1 ? `<div>${c.qty}</div>` : ''}` +
    `<div id="id277-legal-${c.id}" style="height:40px"><img class="img-card" alt="${c.name}" width="60" height="84"></div></div>`,
};
const pageFor = (view, shown) => `<!doctype html>
  <head><meta property="og:description" content="A Commander deck featuring Test Commander by tester"></head>
  <body><style>${read('badge.css')}</style><div>100 main deck</div>
  <ul>${shown.map(VIEWS[view]).join('')}</ul></body>`;

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));

  for (const view of Object.keys(VIEWS)) {
    await page.setContent(pageFor(view, cards));
    await page.evaluate(read('moxfield-dom.js'));
    const counted = await page.evaluate(() => ({
      copies: globalThis.MoxfieldDom.deckCardCount(),
      names: globalThis.MoxfieldDom.deckCardNames().size,
      stated: globalThis.MoxfieldDom.statedDeckSize(),
    }));
    check(counted.copies === counted.stated, `${view}: copies on the page match "100 main deck"`, `(${counted.copies} copies, ${counted.names} names)`);
  }

  // The drawer itself, on a fully shown deck and then on a filtered one.
  const warning = async (shown) => {
    await page.setContent(pageFor('grid', shown));
    await page.evaluate(() => {
      globalThis.chrome = {
        runtime: {
          sendMessage: async (msg) => {
            if (msg.type === 'lookup-ranks') {
              return { ok: true, ranks: Object.fromEntries(msg.names.map((n) => [n, { rank: 100, name: n }])) };
            }
            if (msg.type === 'lookup-edhrec') {
              return { ok: true, stats: {}, lists: [{ header: 'Top Cards', cards: ['Sol Ring'] }], commanderCard: null, salt: {}, matched: true };
            }
            if (msg.type === 'lookup-prices') return { ok: true, prices: {} };
            return { ok: false };
          },
        },
      };
    });
    for (const f of ['moxfield-dom.js', 'panel.js', 'content.js']) await page.evaluate(read(f));
    await page.waitForSelector('.edhrec-panel-launcher', { timeout: 10000 });
    await page.click('.edhrec-panel-launcher');
    await page.waitForTimeout(300);
    return page.evaluate(() => [...document.querySelectorAll('.edhrec-panel *')].map((e) => e.textContent).find((t) => /^Only \d+ of \d+ cards are visible/.test(t)) ?? null);
  };
  const full = await warning(cards);
  check(full === null, 'no filter warning on a deck shown in full', full ? `("${full}")` : '');
  // A filter hiding ten cards: the warning still has a job to do.
  const filtered = await warning(cards.filter((_, i) => i < 1 || i > 10));
  check(/Only 90 of 100/.test(filtered || ''), 'the warning still fires when cards really are hidden', `(${filtered ?? 'no warning'})`);
} catch (err) {
  failures++;
  console.log('FAILED:', err.message.split('\n')[0]);
} finally {
  await browser.close();
}

console.log(failures === 0 ? '\nPASS' : `\nFAIL - ${failures} check(s) failed`);
process.exitCode = failures ? 1 : 0;
