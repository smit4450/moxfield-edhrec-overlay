/**
 * End-to-end check that the extension badges a deck page BY ITSELF.
 *
 *   node tools/verify-autorun.mjs [deckUrl]
 *
 * Unlike tools/verify-live.mjs, this injects nothing. It loads the actual
 * built extension into the browser, opens a deck, and waits for badges to
 * appear on their own — which is the whole claim "it works automatically".
 * It then hovers cards and measures how long the preview badge takes to
 * follow, since that path is easy to regress.
 *
 * The shipped manifest is Firefox-only on purpose: Firefox MV3 uses
 * background.scripts, Chromium MV3 requires background.service_worker, and
 * declaring both makes web-ext warn on every lint. So this builds a throwaway
 * Chromium-flavoured copy under .pw-ext/ rather than compromising the real one.
 * The content scripts, adapter, CSS and background logic are byte-identical —
 * only the background entry point differs.
 *
 * Cloudflare blocks headless, so this runs headed. A window will open.
 */

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DECK = process.argv[2] || 'https://moxfield.com/decks/ri44zg2DG0iBE2jUNXEdPg';

// --- build the throwaway Chromium copy -------------------------------------
const extDir = join(root, '.pw-ext');
rmSync(extDir, { recursive: true, force: true });
mkdirSync(extDir, { recursive: true });
cpSync(join(root, 'src'), join(extDir, 'src'), { recursive: true });

const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
delete manifest.browser_specific_settings; // Firefox-only, and Chromium rejects the id
manifest.background = { service_worker: 'src/background.js' };
writeFileSync(join(extDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

const ctx = await chromium.launchPersistentContext(join(root, '.pw-profile-ext'), {
  headless: false,
  viewport: { width: 1600, height: 1000 },
  args: [
    `--disable-extensions-except=${extDir}`,
    `--load-extension=${extDir}`,
    '--disable-blink-features=AutomationControlled',
  ],
});

const page = ctx.pages()[0] || (await ctx.newPage());

// Surface anything the content script complains about; a silent failure here
// is indistinguishable from "the selectors stopped matching".
const pageLog = [];
page.on('console', (m) => {
  const t = m.text();
  if (/edhrec|extension|Error/i.test(t)) pageLog.push(`[${m.type()}] ${t}`);
});
page.on('pageerror', (e) => pageLog.push(`[pageerror] ${e.message}`));

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? '  ' + detail : ''}`);
};

try {
  const t0 = Date.now();
  await page.goto(DECK, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // Nothing is injected: if badges show up, the extension did it.
  await page.waitForFunction(() => document.querySelectorAll('.edhrec-badge').length > 0, {
    timeout: 60000,
  });
  const firstBadgeMs = Date.now() - t0;

  await page.waitForTimeout(2500); // let the first full pass settle

  const state = await page.evaluate(() => {
    const badges = [...document.querySelectorAll('.edhrec-badge')];
    return {
      badges: badges.length,
      withRank: badges.filter((b) => /^#[\d,]+$/.test(b.textContent.trim())).length,
      unranked: badges.filter((b) => b.textContent.trim() === '—').length,
      inline: document.querySelectorAll('.edhrec-badge.edhrec-inline').length,
      previewBadges: document.querySelectorAll('.edhrec-preview-host > .edhrec-badge').length,
      sample: badges.slice(0, 5).map((b) => `${b.dataset.cardName} ${b.textContent.trim()}`),
    };
  });

  console.log(`\nfirst badge appeared ${firstBadgeMs}ms after navigation, with nothing injected`);
  check(state.badges > 0, 'badges auto-appear on a deck page', `(${state.badges} badges)`);
  check(state.withRank > 0, 'ranks resolved from Scryfall', `(${state.withRank} ranked, ${state.unranked} unranked)`);
  console.log('   sample:', state.sample.join(' | '));

  // --- SPA navigation -------------------------------------------------------
  // The content script is injected once per document load. Moxfield routes
  // client-side, so arriving at a deck without a reload must still badge it —
  // that is the difference between "works" and "works only if you hard-load".
  // Route away via the site's own header (same tab, client-side) and come back.
  // Card links open in a new tab, so clicking one leaves this page where it was
  // and makes goBack() land on the context's initial about:blank.
  const home = page.getByRole('link', { name: 'Home', exact: true }).first();
  if (await home.count()) {
    await home.click();
    await page.waitForTimeout(3000);
    console.log(`   routed away to ${await page.evaluate(() => location.pathname)}`);
    await page.goBack();
    await page.waitForTimeout(1500);
    console.log(`   routed back to ${await page.evaluate(() => location.pathname)}`);
    const back = await page
      .waitForFunction(() => document.querySelectorAll('.edhrec-badge').length > 0, { timeout: 20000 })
      .then(() => true)
      .catch(() => false);
    const n = await page.evaluate(() => document.querySelectorAll('.edhrec-badge').length);
    check(back, 'badges survive client-side navigation', `(${n} badges after back)`);
    if (!back) {
      const diag = await page.evaluate(() => ({
        url: location.href,
        adapterPresent: typeof globalThis.MoxfieldDom !== 'undefined',
        targets: globalThis.MoxfieldDom ? globalThis.MoxfieldDom.findTargets().length : null,
        imgCards: document.querySelectorAll('.img-card').length,
        rowLinks: document.querySelectorAll('a.table-deck-row-link').length,
        marked: document.querySelectorAll('[data-edhrec-badge]').length,
      }));
      console.log('   diagnosis:', JSON.stringify(diag));
    }
  }

  // --- preview latency ------------------------------------------------------
  // Hover several different cards and time how long the preview badge takes to
  // change. This is the path that was "pretty slow".
  // Force an image view first: in text views there is nothing to hover.
  try {
    await page.getByRole('button', { name: /view options/i }).first().click();
    const dialog = page.getByRole('dialog').first();
    await dialog.waitFor({ state: 'visible', timeout: 15000 });
    await dialog.getByRole('radio', { name: 'Visual Grid', exact: true }).check({ force: true });
    await dialog.getByRole('button', { name: 'Save' }).first().click();
    await dialog.waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2500);
  } catch {
    console.log('   (could not switch to Visual Grid; hovering whatever is here)');
  }

  const tiles = await page.$$('.img-card');
  const timings = [];
  for (const tile of tiles.slice(0, 6)) {
    const before = await page.evaluate(
      () => document.querySelector('.edhrec-preview-host > .edhrec-badge')?.dataset.cardName ?? null
    );
    await tile.hover().catch(() => {});
    const started = Date.now();
    try {
      await page.waitForFunction(
        (prev) => {
          const b = document.querySelector('.edhrec-preview-host > .edhrec-badge');
          return b && b.dataset.cardName !== prev;
        },
        before,
        { timeout: 4000 }
      );
      timings.push(Date.now() - started);
    } catch {
      /* hovering the same card twice legitimately changes nothing */
    }
  }

  if (timings.length) {
    const max = Math.max(...timings);
    const avg = Math.round(timings.reduce((a, b) => a + b, 0) / timings.length);
    console.log(`\npreview badge follow-up over ${timings.length} hovers: ${timings.join('ms, ')}ms`);
    check(max < 400, 'preview keeps up with the pointer', `(avg ${avg}ms, worst ${max}ms)`);
  } else {
    console.log('\npreview latency: no card changes observed (could not hover distinct cards)');
  }

  await page.screenshot({ path: join(root, '.pw-shots', 'autorun.png') });
} catch (err) {
  failures++;
  console.log('FAILED:', err.message.split('\n')[0]);
  console.log('body:', await page.evaluate(() => document.body?.innerText.slice(0, 200).replace(/\s+/g, ' ')).catch(() => '?'));
} finally {
  await ctx.close();
}

if (pageLog.length) {
  console.log('\npage console:');
  for (const l of pageLog.slice(0, 15)) console.log('  ', l);
}

console.log(failures === 0 ? '\nPASS' : `\nFAIL - ${failures} check(s) failed`);
process.exitCode = failures ? 1 : 0;
