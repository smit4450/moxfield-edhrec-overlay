/**
 * Unit test: a commander displayed under a FLAVOR name still gets its commander
 * rank, and only its real name leaves the page.  Run: node tools/test-commander.mjs
 *
 * Secret Lair and Universes Beyond reskins display under flavor names. The
 * Hatsune Miku precon's commander, Trostani, Selesnya's Voice, shows as "Miku,
 * Song of the People". The displayed name used to be sent as-is. EDHREC answers
 * that slug too but titles the page with it, so the badge never matched the
 * commander and kept its card rank (#3,154 rather than #221); Commander
 * Spellbook does not know flavor names, so the commander read as missing from
 * every combo it is in.
 *
 * The badge face was also painted only once. If it went up before EDHREC
 * answered, it kept the card rank for good, because only its label was
 * refreshed. The stub answers EDHREC late on purpose to hold that window open;
 * live, it depends on which request wins.
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
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
  // Moxfield's text-view markup: the "Commander (1)" group is how the adapter
  // finds the commander, and it reads the name the page displays.
  await page.setContent(`<!doctype html><body>
    <style>${read('badge.css')}</style>
    <ul>
      <li>Commander(1)</li>
      <li><div class="w-100"><a id="id_r_1l_-TrSv1" class="table-deck-row-link" href="/cards/TrSv1-miku-song-of-the-people">Miku, Song of the People</a></div></li>
    </ul>
    <ul>
      <li>Creatures(1)</li>
      <li><div class="w-100"><a id="id_r_1m_-AjPm1" class="table-deck-row-link" href="/cards/AjPm1-ajanis-pridemate">Ajani's Pridemate</a></div></li>
    </ul>
  </body>`);

  await page.evaluate(() => {
    // Real figures, 2026-10-01: Trostani is the 221st most-played commander and
    // the 3,154th most-played card.
    const RANKS = {
      'Miku, Song of the People': { rank: 3154, name: "Trostani, Selesnya's Voice" },
      "Ajani's Pridemate": { rank: 2558, name: "Ajani's Pridemate" },
    };
    globalThis.asked = { edhrec: [], spellbook: [] };
    globalThis.chrome = {
      runtime: {
        sendMessage: async (msg) => {
          if (msg.type === 'lookup-ranks') {
            return { ok: true, ranks: Object.fromEntries(msg.names.map((n) => [n, RANKS[n] ?? null])) };
          }
          if (msg.type === 'lookup-edhrec') {
            asked.edhrec.push(...msg.commanders);
            await new Promise((r) => setTimeout(r, 900)); // after the badges are up
            asked.faceWhenAnswered = document.querySelector('.edhrec-badge[data-card-name^="Miku"]')?.textContent ?? null;
            return {
              ok: true,
              stats: { "ajani's pridemate": { name: "Ajani's Pridemate", lift: 1.4, synergy: 0.05, inclusion: 0.3, numDecks: 300, potentialDecks: 1000, lists: [] } },
              lists: [{ header: 'Creatures', cards: ["Ajani's Pridemate", 'Some Recommendation'] }],
              // EDHREC titles the page with the name it was asked for.
              commanderCard: { name: msg.commanders[0], rank: 221, numDecks: 10801, salt: null },
              salt: {},
              matched: true,
            };
          }
          if (msg.type === 'lookup-combos') {
            asked.spellbook.push(...msg.commanders);
            return { ok: true, included: [], almost: [] };
          }
          if (msg.type === 'lookup-prices') return { ok: true, prices: {} };
          if (msg.type === 'lookup-average') return { ok: true, cards: [] };
          return { ok: false };
        },
      },
    };
  });
  for (const f of ['moxfield-dom.js', 'panel.js', 'content.js']) await page.evaluate(read(f));

  await page.waitForFunction(() => globalThis.asked.faceWhenAnswered !== undefined, null, { timeout: 10000 });
  await page.waitForTimeout(300);
  const asked = await page.evaluate(() => globalThis.asked);
  const badge = (prefix) =>
    page.evaluate((p) => {
      const b = document.querySelector(`.edhrec-badge[data-card-name^="${p}"]`);
      return b ? { face: b.textContent, label: b.getAttribute('aria-label') } : null;
    }, prefix);
  const cmd = await badge('Miku');
  const other = await badge('Ajani');

  check(
    JSON.stringify(asked.edhrec) === JSON.stringify(["Trostani, Selesnya's Voice"]),
    'EDHREC is asked about the real name, not the flavor name',
    `(${JSON.stringify(asked.edhrec)})`
  );
  // Without this the next check could pass without exercising anything.
  check(asked.faceWhenAnswered === '#3,154', 'the badge was up, at its card rank, before EDHREC answered', `(${asked.faceWhenAnswered})`);
  check(cmd?.face === '#221', 'the commander badge then shows its commander rank', `(${cmd?.face})`);
  check(/Commander rank 221/.test(cmd?.label || ''), 'and its label says so', `(${(cmd?.label || '').split('. ').slice(0, 2).join('. ')})`);
  check(other?.face === '#2,558', 'other badges keep their card rank', `(${other?.face})`);

  await page.click('.edhrec-panel-launcher');
  await page.locator('.edhrec-panel-tab', { hasText: 'Combos' }).first().click();
  await page.waitForFunction(() => globalThis.asked.spellbook.length > 0, null, { timeout: 5000 }).catch(() => {});
  const spellbook = await page.evaluate(() => globalThis.asked.spellbook);
  check(
    JSON.stringify(spellbook) === JSON.stringify(["Trostani, Selesnya's Voice"]),
    'Commander Spellbook gets the real name too',
    `(${JSON.stringify(spellbook)})`
  );
} catch (err) {
  failures++;
  console.log('FAILED:', err.message.split('\n')[0]);
} finally {
  await browser.close();
}

console.log(failures === 0 ? '\nPASS' : `\nFAIL - ${failures} check(s) failed`);
process.exitCode = failures ? 1 : 0;
