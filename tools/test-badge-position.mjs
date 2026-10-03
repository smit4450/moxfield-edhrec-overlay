/**
 * Unit test: a badge must sit where the card is visible.
 * Run: node tools/test-badge-position.mjs
 *
 * Moxfield's Visual Grid overlaps its rows: each card shows only its top ~100px
 * of 240 before the next row covers the rest. Badges sat in the bottom-left
 * corner, so on every card but the last row of each group they were under the
 * next card - 21 of 29 on screen, measured on a live deck. verify-live checked
 * that badges existed and were laid out, not that anything could see them.
 *
 * Visual Stacks are the opposite case: the tile is the ~40px strip itself, and
 * its bottom corner lands on the visible name strip, so strips keep it.
 *
 * The page below reproduces both. Each tile is its own stacking context, as
 * Moxfield's are; without that, the badge's z-index would float it above the
 * next card and this test could not fail.
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

const tile = (id, alt, left, top, height) =>
  `<div id="${id}" style="position:absolute; z-index:1; left:${left}px; top:${top}px; width:170px; height:${height}px">` +
  `<img class="img-card" alt="${alt}" style="display:block; width:170px; height:238px; background:#345"></div>`;

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
  await page.setContent(`<!doctype html><body style="margin:0">
    <style>${read('badge.css')}</style>
    <div style="position:relative; height:600px">
      ${tile('vd-RowA1', 'Sol Ring', 0, 0, 238)}
      ${tile('vd-RowB1', 'Command Tower', 0, 100, 238)}
      ${tile('id272-legal-Strp1', 'Arcane Signet', 400, 0, 40)}
    </div>
  </body>`);
  await page.evaluate(() => {
    globalThis.chrome = {
      runtime: {
        sendMessage: async (msg) =>
          msg.type === 'lookup-ranks'
            ? { ok: true, ranks: Object.fromEntries(msg.names.map((n) => [n, { rank: 1, name: n }])) }
            : { ok: false },
      },
    };
  });
  for (const f of ['moxfield-dom.js', 'panel.js', 'content.js']) await page.evaluate(read(f));
  await page.waitForFunction(() => document.querySelectorAll('.edhrec-badge').length === 3, null, { timeout: 10000 });

  const at = await page.evaluate(() => {
    const place = (id) => {
      const host = document.getElementById(id);
      const b = host.querySelector(':scope > .edhrec-badge');
      const h = host.getBoundingClientRect();
      const r = b.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { top: Math.round(r.top - h.top), bottom: Math.round(h.bottom - r.bottom), height: Math.round(r.height), onTop: hit === b };
    };
    return { overlapped: place('vd-RowA1'), strip: place('id272-legal-Strp1') };
  });
  const o = at.overlapped;
  check(o.onTop, 'a card overlapped by the next row keeps its badge in view', `(badge ${o.top}px from the top; the next row starts at 100px)`);
  // Moxfield's menu button appears on hover over 25-50px of a 240px card,
  // measured live. At a fifth of the way down (48px) the two overlapped, and
  // the button took the pointer before our tooltip could open.
  check(o.top > 50 && o.top + o.height <= 100, "and clear of Moxfield's hover menu, still inside the visible strip", `(${o.top}-${o.top + o.height}px)`);
  check(at.strip.bottom <= 6, 'a stack strip keeps its badge in the bottom corner, on the name strip', `(${at.strip.bottom}px from the bottom of a 40px strip)`);
} catch (err) {
  failures++;
  console.log('FAILED:', err.message.split('\n')[0]);
} finally {
  await browser.close();
}

console.log(failures === 0 ? '\nPASS' : `\nFAIL - ${failures} check(s) failed`);
process.exitCode = failures ? 1 : 0;
