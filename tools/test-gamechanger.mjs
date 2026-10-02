/**
 * Unit test: our Game Changer ring yields to Moxfield's own icon per host, never
 * per card.  Run: node tools/test-gamechanger.mjs
 *
 * Moxfield marks Game Changers itself with a gauge icon, but only on text rows.
 * In the visual views the mainboard is images and the SIDEBOARD stays a text
 * list. So a card in both boards - Chrome Mox, on the deck this was found on -
 * carries Moxfield's icon on its sideboard row and nothing on its mainboard
 * tile. The adapter used to suppress our ring by card id, page-wide: the
 * sideboard row silenced the tile, and the one place our ring is the only
 * marker showed none.
 *
 * The markup below is Moxfield's, as read off a live deck in Visual Grid on
 * 2026-10-01: tiles whose id ends in the card id, and rows whose link id does
 * too, with the icon `<rowId>-brackets-<cardId>` inside the link.
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

const GAME_CHANGERS = ['Chrome Mox', "Jeska's Will"];

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
  await page.setContent(`<!doctype html><body>
    <style>${read('badge.css')}</style>
    <!-- Mainboard, Visual Grid: images, and no icon from Moxfield on any of them. -->
    <div id="vd-Q4gNy" class="img-card-visual"><img class="img-card" alt="Chrome Mox" width="120" height="168"></div>
    <div id="vd-LDznW" class="img-card-visual"><img class="img-card" alt="Jeska's Will" width="120" height="168"></div>
    <div id="vd-N9J2z" class="img-card-visual"><img class="img-card" alt="Sol Ring" width="120" height="168"></div>
    <ul>
      <!-- Sideboard, still text: Moxfield shows its own icon here. -->
      <li><div class="w-100"><a id="id_r_4i_-Q4gNy" class="table-deck-row-link" href="/cards/Q4gNy-chrome-mox">Chrome Mox<span><span
        id="id_r_4i_-brackets-Q4gNy" class="fal fa-gauge"></span></span></a></div></li>
      <!-- A row whose icon Moxfield hides at this width (d-none d-md-inline). -->
      <li><div class="w-100"><a id="id_r_2a_-LDznW" class="table-deck-row-link" href="/cards/LDznW-jeskas-will">Jeska's Will<span><span
        id="id_r_2a_-brackets-LDznW" class="fal fa-gauge" style="display:none"></span></span></a></div></li>
    </ul>
  </body>`);

  // Installed before the scripts run: they capture the messenger on load.
  await page.evaluate((gcs) => {
    globalThis.chrome = {
      runtime: {
        sendMessage: async (msg) => {
          if (msg.type === 'lookup-ranks') {
            return {
              ok: true,
              ranks: Object.fromEntries(msg.names.map((n) => [n, { rank: 100, name: n, gameChanger: gcs.includes(n) }])),
            };
          }
          return { ok: false };
        },
      },
    };
  }, GAME_CHANGERS);
  for (const f of ['moxfield-dom.js', 'panel.js', 'content.js']) await page.evaluate(read(f));
  await page.waitForFunction(() => document.querySelectorAll('.edhrec-badge').length === 5, null, { timeout: 10000 });

  const marks = await page.evaluate(() => {
    const tile = (id) => document.querySelector(`#${id} > .edhrec-badge`);
    const row = (id) => document.getElementById(id).parentElement.querySelector(':scope > .edhrec-badge');
    const describe = (b) => (!b ? 'no badge' : b.classList.contains('edhrec-game-changer') ? 'ring' : b.dataset.moxGameChanger === '1' ? 'deferred to Moxfield' : 'plain');
    return {
      chromeTile: describe(tile('vd-Q4gNy')),
      chromeRow: describe(row('id_r_4i_-Q4gNy')),
      jeskaTile: describe(tile('vd-LDznW')),
      jeskaRow: describe(row('id_r_2a_-LDznW')),
      solTile: describe(tile('vd-N9J2z')),
    };
  });
  check(marks.chromeTile === 'ring', 'a mainboard tile keeps its ring when the sideboard row has Moxfield\'s icon', `(${marks.chromeTile})`);
  check(marks.chromeRow === 'deferred to Moxfield', 'the row Moxfield marks gets no ring of ours', `(${marks.chromeRow})`);
  check(marks.jeskaTile === 'ring', 'a game changer with no icon anywhere is ringed', `(${marks.jeskaTile})`);
  check(marks.jeskaRow === 'ring', 'a row whose icon is hidden at this width is ringed', `(${marks.jeskaRow})`);
  check(marks.solTile === 'plain', 'a card that is not a game changer gets no ring', `(${marks.solTile})`);
} catch (err) {
  failures++;
  console.log('FAILED:', err.message.split('\n')[0]);
} finally {
  await browser.close();
}

console.log(failures === 0 ? '\nPASS' : `\nFAIL - ${failures} check(s) failed`);
process.exitCode = failures ? 1 : 0;
