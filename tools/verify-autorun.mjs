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

// Wipe the profile every run. Chromium caches the unpacked extension inside the
// profile, so a persistent one silently keeps serving an older build: a run
// against stale code reported the background missing functions that were
// plainly in the file, which is a deeply misleading failure to debug.
const profileDir = join(root, '.pw-profile-ext');
rmSync(profileDir, { recursive: true, force: true });

const ctx = await chromium.launchPersistentContext(profileDir, {
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

// The background runs in its own worker context; its errors never reach the
// page console, so subscribe separately or EDHREC failures are invisible.
const swLog = [];
const watchWorker = (w) => {
  swLog.push(`[sw] started ${w.url()}`);
  w.on('console', (m) => swLog.push(`[sw:${m.type()}] ${m.text()}`));
};
ctx.on('serviceworker', watchWorker);
// Attach BEFORE navigating and wait for the worker to exist, or its early logs
// (including the ones that explain an EDHREC failure) are lost to the race.
{
  const existing = ctx.serviceWorkers();
  if (existing.length) existing.forEach(watchWorker);
  else await ctx.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => swLog.push('[sw] never started'));
}

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

  // --- EDHREC enrichment ----------------------------------------------------
  // NOTE: content scripts run in an isolated world, so MoxfieldDom is not
  // reachable from page.evaluate here. Everything below is read from the shared
  // DOM the extension actually produced, which is the better test anyway.
  const edh = await page.evaluate(() => {
    const titles = [...document.querySelectorAll('.edhrec-badge')].map(
      (b) => b.getAttribute('aria-label') || ''
    );
    const desc = document.querySelector('meta[property="og:description"]')?.content || '';
    return {
      commanders: (desc.match(/featuring\s+(.+?)\s+by\s/i)?.[1] ?? '').trim() || null,
      withSynergy: titles.filter((t) => /Synergy [+-]/.test(t)).length,
      withInclusion: titles.filter((t) => /Played in [\d.]+%/.test(t)).length,
      withList: titles.filter((t) => /High Synergy Cards|Top Cards|New Cards|Game Changer/.test(t)).length,
      withSalt: titles.filter((t) => /Salt \d/.test(t)).length,
      total: titles.length,
      richest: titles.slice().sort((a, b) => b.split('. ').length - a.split('. ').length)[0] || '',
    };
  });

  console.log(`\ncommander detected: ${JSON.stringify(edh.commanders)}`);
  if (edh.commanders?.length) {
    check(edh.withSynergy > 0, 'synergy % in tooltips', `(${edh.withSynergy}/${edh.total})`);
    check(edh.withInclusion > 0, 'inclusion % in tooltips', `(${edh.withInclusion}/${edh.total})`);
    console.log(`   list tags ${edh.withList}, salt ${edh.withSalt}`);
    console.log('\n   richest tooltip:');
    for (const line of edh.richest.split('. ')) console.log('     ' + line);
  } else {
    console.log('   (deck has no commander; EDHREC enrichment correctly skipped)');
  }

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

  // --- Recommendations panel -------------------------------------------------
  const launcher = await page.$('.edhrec-panel-launcher');
  check(Boolean(launcher), 'recommendations launcher appears');
  if (launcher) {
    await launcher.click();
    await page.waitForTimeout(800);
    const panel = await page.evaluate(() => {
      const deck = new Set(
        [...document.querySelectorAll('.edhrec-badge')]
          .map((b) => (b.dataset.cardName || '').split('//')[0].trim().toLowerCase())
          .filter(Boolean)
      );
      const rows = [...document.querySelectorAll('.edhrec-panel-row')];
      const names = rows.map((r) => r.querySelector('.edhrec-panel-name')?.textContent?.trim() || '');
      return {
        open: document.querySelector('.edhrec-panel')?.classList.contains('is-open') === true,
        rows: rows.length,
        sections: [...document.querySelectorAll('.edhrec-panel-title')].map((t) => t.textContent),
        // The whole point of the feature: nothing listed may already be in the deck.
        alreadyInDeck: names.filter((n) => deck.has(n.split('//')[0].trim().toLowerCase())),
      };
    });
    check(panel.open && panel.rows > 0, 'panel opens with recommendations', `(${panel.rows} rows)`);
    check(
      panel.alreadyInDeck.length === 0,
      'nothing recommended is already in the deck',
      panel.alreadyInDeck.length ? `(${panel.alreadyInDeck.slice(0, 3).join(', ')})` : ''
    );
    check(
      panel.sections[0] === 'High Synergy Cards',
      'curated sections lead the list',
      `(first: ${panel.sections[0]})`
    );

    // Prices arrive on a second round trip after the rows render.
    await page.waitForTimeout(2500);
    const money = await page.evaluate(() => {
      const cells = [...document.querySelectorAll('.edhrec-panel-price')].map((p) => p.textContent.trim());
      return {
        cells: cells.length,
        withPrice: cells.filter((t) => t.startsWith('$')).length,
        sample: cells.slice(0, 4),
      };
    });
    check(
      money.withPrice > 0,
      'prices load for visible rows',
      `(${money.withPrice}/${money.cells}: ${money.sample.join(' ')})`
    );
    await launcher.click(); // close again so it cannot occlude later checks
    await page.waitForTimeout(400);
  }

  // --- Styled tooltip -------------------------------------------------------
  // A leftover `title` would race our own tooltip and the OS would win the
  // first second, so assert it is gone as well as that ours shows.
  const anyTitle = await page.evaluate(
    () => [...document.querySelectorAll('.edhrec-badge')].filter((b) => b.hasAttribute('title')).length
  );
  check(anyTitle === 0, 'no native title attributes left', `(${anyTitle} found)`);

  const tipBadge = await page.$('.edhrec-badge');
  if (tipBadge) {
    await tipBadge.scrollIntoViewIfNeeded();
    await tipBadge.hover();
    await page.waitForTimeout(500);
    const tip = await page.evaluate(() => {
      const t = document.querySelector('.edhrec-tip');
      if (!t) return null;
      const r = t.getBoundingClientRect();
      return {
        visible: t.classList.contains('is-visible'),
        onScreen: r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth,
        // Must not swallow clicks meant for the card underneath.
        inert: getComputedStyle(t).pointerEvents === 'none',
        lines: t.innerText.split('\n').filter(Boolean).length,
      };
    });
    check(Boolean(tip?.visible), 'styled tooltip appears on hover');
    check(Boolean(tip?.onScreen), 'tooltip stays inside the viewport');
    check(Boolean(tip?.inert), 'tooltip does not intercept the pointer');
  }

  // --- Game Changer: ours shows only where Moxfield's does not ---------------
  // Moxfield prints its own fa-gauge icon beside game changers, but only in the
  // text views. We must fill the gap in image views and stay quiet in text
  // ones, so assert the invariant rather than a fixed expectation.
  const gc = await page.evaluate(() => {
    const moxIcons = [...document.querySelectorAll('.fa-gauge[id*="-brackets-"]')].filter((e) => e.offsetParent);
    const ours = [...document.querySelectorAll('.edhrec-badge.edhrec-game-changer')];
    return { mox: moxIcons.length, ours: ours.length, view: 'image' };
  });
  check(
    !(gc.mox > 0 && gc.ours > 0),
    'game-changer marker is not duplicated',
    `(moxfield ${gc.mox}, ours ${gc.ours} in an image view)`
  );

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

if (swLog.length) {
  console.log('\nbackground console:');
  for (const l of swLog.slice(0, 20)) console.log('  ', l);
}

if (pageLog.length) {
  console.log('\npage console:');
  for (const l of pageLog.slice(0, 15)) console.log('  ', l);
}

console.log(failures === 0 ? '\nPASS' : `\nFAIL - ${failures} check(s) failed`);
process.exitCode = failures ? 1 : 0;
