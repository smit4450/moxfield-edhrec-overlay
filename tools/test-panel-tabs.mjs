/**
 * Unit test: switching tabs while a request is in flight must not lose the
 * new tab's request.  Run: node tools/test-panel-tabs.mjs
 *
 * The drawer allows one price request at a time, and one combos-or-average
 * request at a time, each guarded by a pending flag. On success it
 * re-rendered, and the render asked for whatever the tab now on screen still
 * lacked - but the flag only came down afterwards, in .finally(), so that ask
 * was dropped and nothing asked again. Switch to Cuts while the Add tab's
 * prices load and Cuts never got its prices; switch to Avg while combos load
 * and the average list never loaded. verify:autorun hit the first live as a
 * combo preview with no image, since prices carry the image id.
 *
 * Both stubs are deliberately slow, to hold the window open: an instant reply
 * lands before the click and hides the bug.
 *
 * The combo the stub returns also carries a result longer than the drawer is
 * wide. Result chips did not wrap, so one ran off the edge and was cut off - in
 * a store screenshot, which is where it was caught.
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

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 1000 } });
  page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
  await page.setContent(`<style>${read('badge.css')}</style>`);
  await page.evaluate(() => {
    const slow = (ms) => new Promise((r) => setTimeout(r, ms));
    globalThis.asked = { prices: [], average: 0 };
    globalThis.chrome = {
      runtime: {
        sendMessage: async (msg) => {
          if (msg.type === 'lookup-prices') {
            asked.prices.push(msg.names);
            await slow(700);
            return { ok: true, prices: Object.fromEntries(msg.names.map((n) => [n, { usd: 1.23, id: null }])) };
          }
          if (msg.type === 'lookup-combos') {
            await slow(700);
            // The longest result in Commander Spellbook's feature list, 147
            // characters. The one first seen cut off, at 70, fits this row in
            // some fonts.
            const almost = [{
              cards: ['Combo Piece', 'Filler'],
              produces: ['Infinite mana', 'Near-infinite colored mana that can only be spent to cast creature spells with mana value 4 or greater or creature spells with X in their mana cost'],
              missing: ['Combo Piece'],
            }];
            return { ok: true, included: [], almost };
          }
          if (msg.type === 'lookup-average') {
            asked.average++;
            return { ok: true, cards: ['Sol Ring', 'Arcane Signet'] };
          }
          return { ok: false };
        },
      },
    };
  });
  await page.evaluate(read('panel.js'));

  const deck = ['Pet Card', 'Filler', 'Staple', 'Xyris, the Writhing Storm'];
  await page.evaluate(
    (s) => globalThis.EdhrecPanel.update({ ...s, deck: new Set(s.deck) }),
    {
      deckId: '/decks/TABS',
      commander: 'Xyris, the Writhing Storm',
      commanders: ['Xyris, the Writhing Storm'],
      lists: [{ header: 'High Lift Cards', cards: ['Orcrist, Goblin-cleaver', 'Warg Tactics'] }],
      stats: {
        'orcrist, goblin-cleaver': { name: 'Orcrist, Goblin-cleaver', lift: 9.35, inclusion: 0.057 },
        'warg tactics': { name: 'Warg Tactics', lift: 3.28, inclusion: 0.014 },
        'pet card': { name: 'Pet Card', lift: 0.4, inclusion: 0.01 },
        filler: { name: 'Filler', lift: 0.8, inclusion: 0.04 },
        staple: { name: 'Staple', lift: 1.0, inclusion: 0.82 },
      },
      salt: {},
      deck: deck.map((n) => n.toLowerCase()),
      deckCards: deck.map((name) => ({ name, canonical: name })),
      mismatch: null,
    }
  );
  const tab = (name) => page.locator('.edhrec-panel-tab', { hasText: name }).first().click();

  // Opening the drawer asks for the Add tab's prices; Cuts is opened while
  // that answer is still on its way.
  await page.click('.edhrec-panel-launcher');
  await tab('Cuts');
  await page.waitForTimeout(2000);
  const cuts = await page.evaluate(() => ({
    asked: globalThis.asked.prices.length,
    shown: [...document.querySelectorAll('.edhrec-panel-row')].map((r) => r.querySelector('.edhrec-panel-price')?.textContent),
  }));
  check(cuts.asked === 2, 'the tab opened mid-request asks for its own prices once that request lands', `(${cuts.asked} price requests)`);
  check(cuts.shown.length > 0 && cuts.shown.every((p) => p === '$1.23'), 'and shows them', `(${cuts.shown.join(' ')})`);

  // Avg is opened while the combos are still on their way.
  await tab('Combos');
  await tab('Avg');
  await page.waitForTimeout(2000);
  const avg = await page.evaluate(() => ({
    asked: globalThis.asked.average,
    stat: document.querySelector('.edhrec-panel-avgstat')?.innerText.replace(/\s+/g, ' ') ?? null,
  }));
  check(avg.asked === 1 && Boolean(avg.stat), 'the average list loads when Avg is opened while combos load', `(${avg.asked} requests; ${avg.stat ?? 'nothing shown'})`);

  // The long combo result. Its unwrapped width is measured too: in a font
  // narrow enough to fit the row, this check could not fail.
  await tab('Combos');
  await page.waitForSelector('.edhrec-panel-combo .edhrec-panel-chip', { timeout: 5000 });
  const long = await page.evaluate(() => {
    const chip = [...document.querySelectorAll('.edhrec-panel-combo .edhrec-panel-chip')].find((c) => c.textContent.startsWith('Near-infinite'));
    const row = chip.parentElement.getBoundingClientRect();
    const probe = chip.cloneNode(true);
    probe.style.cssText = 'position: absolute; white-space: nowrap; visibility: hidden';
    chip.parentElement.append(probe);
    const unwrapped = probe.getBoundingClientRect().width;
    probe.remove();
    return { row: Math.round(row.width), unwrapped: Math.round(unwrapped), over: Math.round(chip.getBoundingClientRect().right - row.right) };
  });
  check(long.unwrapped > long.row && long.over <= 0, 'a combo result wider than the drawer wraps inside it', `(${long.unwrapped}px of text, ${long.row}px row, ${long.over > 0 ? `${long.over}px past the edge` : 'inside'})`);
} catch (err) {
  failures++;
  console.log('FAILED:', err.message.split('\n')[0]);
} finally {
  await browser.close();
}

console.log(failures === 0 ? '\nPASS' : `\nFAIL - ${failures} check(s) failed`);
process.exitCode = failures ? 1 : 0;
