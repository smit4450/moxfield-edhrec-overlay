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
 * It loads the SHIPPED manifest, unmodified - the same file both stores get.
 * One manifest serves Firefox and Chrome: Firefox runs background.scripts,
 * Chrome background.service_worker, and preferred_environment keeps web-ext's
 * lint quiet about the pair. This used to rewrite a Chromium-only copy, which
 * meant keeping that rewrite in sync with the real manifest by hand - and
 * adding `icons` once broke all 30 checks when it fell out of sync. The files
 * are still copied, into .pw-ext/, so that what loads is what ships rather
 * than the whole repository - node_modules, .git, and this rig's own browser
 * profile, which lives in the repository root.
 *
 * Cloudflare blocks headless, so this runs headed. A window will open.
 */

import { chromium } from 'playwright';
import { readFileSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// An official precon rather than anyone's own deck: players edit theirs, and the
// previous default quietly lost its commander, which skipped every EDHREC check
// below. This one (Hatsune Miku, Secret Lair Commander 2026) also displays
// flavor names, and carries a salty card, the High Lift list and combos.
const DECK = process.argv[2] || 'https://moxfield.com/decks/n3QS3JZ_zkmwLhmLDTc8Sw';

// --- copy the extension's own files ------------------------------------------
const extDir = join(root, '.pw-ext');
rmSync(extDir, { recursive: true, force: true });
mkdirSync(extDir, { recursive: true });
cpSync(join(root, 'src'), join(extDir, 'src'), { recursive: true });
// Icons too: the manifest references them, and Chromium refuses to load an
// extension whose declared icon files are missing.
cpSync(join(root, 'icons'), join(extDir, 'icons'), { recursive: true });
cpSync(join(root, 'manifest.json'), join(extDir, 'manifest.json'));

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
      withLift: titles.filter((t) => /Lift [\d.]+x/.test(t)).length,
      withSynergy: titles.filter((t) => /Synergy [+-]/.test(t)).length,
      withInclusion: titles.filter((t) => /Played in [\d.]+%/.test(t)).length,
      withList: titles.filter((t) => /High (Lift|Synergy) Cards|Top Cards|New Cards|Game Changer/.test(t)).length,
      withSalt: titles.filter((t) => /Salt \d/.test(t)).length,
      total: titles.length,
      richest: titles.slice().sort((a, b) => b.split('. ').length - a.split('. ').length)[0] || '',
    };
  });

  console.log(`\ncommander detected: ${JSON.stringify(edh.commanders)}`);
  // A failure, not a skip. Every EDHREC check in this file needs a commander,
  // and a deck without one used to pass by running almost none of them.
  check(Boolean(edh.commanders?.length), 'deck has a commander', edh.commanders ? '' : '(pass a Commander deck URL)');
  if (edh.commanders?.length) {
    check(edh.withLift > 0, 'lift in tooltips', `(${edh.withLift}/${edh.total})`);
    check(edh.withSynergy > 0, 'synergy % in tooltips', `(${edh.withSynergy}/${edh.total})`);
    check(edh.withInclusion > 0, 'inclusion % in tooltips', `(${edh.withInclusion}/${edh.total})`);
    console.log(`   list tags ${edh.withList}, salt ${edh.withSalt}`);
    console.log('\n   richest tooltip:');
    for (const line of edh.richest.split('. ')) console.log('     ' + line);
  }

  // --- Commander rank -------------------------------------------------------
  // A commander's rank as a CARD is a different, much larger number than its
  // rank as a commander, and the card one is useless on its own deck page.
  //
  // Found by the name the page DISPLAYS, asked of the adapter itself (injected
  // here, since the extension's copy lives in an isolated world). A reskinned
  // commander shows under a flavor name, so matching og:description's real name
  // found no badge at all on the Hatsune Miku precon.
  if (edh.commanders?.length) {
    await page.evaluate(readFileSync(join(root, 'src', 'moxfield-dom.js'), 'utf8'));
    const cmdBadge = await page.evaluate(() => {
      const key = (n) => (n || '').split('//')[0].trim().toLowerCase();
      const shown = globalThis.MoxfieldDom.findCommanderNames().map(key);
      const b = [...document.querySelectorAll('.edhrec-badge')].find((x) => shown.includes(key(x.dataset.cardName)));
      return b ? { text: b.textContent.trim(), label: b.getAttribute('aria-label') || '' } : null;
    });
    const face = cmdBadge ? Number(cmdBadge.text.replace(/[^\d]/g, '')) : null;
    const labelled = Number(cmdBadge?.label.match(/Commander rank ([\d,]+)/)?.[1].replace(/,/g, '') ?? NaN);
    check(
      Boolean(cmdBadge) && /Commander rank/.test(cmdBadge.label),
      'commander badge shows its commander rank',
      cmdBadge ? `(${cmdBadge.text}, ${cmdBadge.label.split('.')[1]?.trim()})` : '(no commander badge)'
    );
    // The face as well as the label: only the label used to be repainted when
    // EDHREC answered, so a badge painted first kept its card rank on its face.
    // Matching the label replaces a "< 2000" guess, which any less popular
    // commander would have failed.
    check(face === labelled, 'badge face shows the commander rank, not the card rank', `(#${face}; commander rank ${labelled})`);
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

  // --- Badges sit where the card is visible -----------------------------------
  // Visual Grid overlaps its rows, and a badge in the bottom corner sat under
  // the next card on every card but a group's last - while verify-live, which
  // only checks that badges exist and are laid out, passed. Only badges under
  // ANOTHER CARD count: the sticky footer and floating ads cover things too,
  // and say nothing about the extension.
  const occlusion = await page.evaluate(async () => {
    const hosts = [...document.querySelectorAll('.edhrec-host:not(.edhrec-preview-host)')].filter((h) => h.offsetParent);
    hosts[Math.min(4, hosts.length - 1)]?.scrollIntoView({ block: 'center' });
    await new Promise((r) => setTimeout(r, 500));
    let onScreen = 0;
    const under = [];
    for (const h of hosts) {
      const b = h.querySelector(':scope > .edhrec-badge');
      if (!b) continue;
      const r = b.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      if (y < 60 || y > innerHeight - 80 || x < 0 || x > innerWidth) continue;
      onScreen++;
      const card = document.elementFromPoint(x, y)?.closest('.edhrec-host');
      if (card && card !== h) under.push(b.dataset.cardName);
    }
    return { onScreen, under };
  });
  check(
    occlusion.onScreen > 0 && occlusion.under.length === 0,
    'no badge is hidden under another card',
    `(${occlusion.onScreen} on screen${occlusion.under.length ? `; ${occlusion.under.length} under the next card, e.g. ${occlusion.under.slice(0, 2).join(', ')}` : ''})`
  );

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
        warning:
          [...document.querySelectorAll('.edhrec-panel *')]
            .map((e) => e.textContent)
            .find((t) => /^Only \d+ of \d+ cards are visible/.test(t)) ?? null,
      };
    });
    // This deck is shown in full, so the filter warning must stay quiet. It
    // compared distinct names with Moxfield's count of copies, and fired on
    // nearly every Commander deck: 32 Mountains are one name.
    check(!panel.warning, 'no filter warning on a deck shown in full', panel.warning ? `("${panel.warning}")` : '');
    check(panel.open && panel.rows > 0, 'panel opens with recommendations', `(${panel.rows} rows)`);
    check(
      panel.alreadyInDeck.length === 0,
      'nothing recommended is already in the deck',
      panel.alreadyInDeck.length ? `(${panel.alreadyInDeck.slice(0, 3).join(', ')})` : ''
    );
    // Assert the ORDERING, not which section happens to be first. Any given
    // curated section can legitimately be empty - and vanish - once the deck
    // already runs everything in it, which is exactly what the Add tab is for.
    // Pinning "High Synergy Cards is first" made this fail as a side effect of
    // the deck improving.
    //
    // This cannot catch a curated list being RENAMED: the panel then files it
    // with the bulk lists, after the curated ones, so the ordering still holds.
    // That is how "High Lift Cards" went unnoticed; tools/test-lift.mjs covers
    // it deterministically.
    const CURATED = ['High Lift Cards', 'High Synergy Cards', 'Top Cards', 'Game Changers', 'New Cards'];
    const kinds = panel.sections.map((t) => (CURATED.includes(t) ? 'curated' : 'bulk'));
    const firstBulk = kinds.indexOf('bulk');
    const lastCurated = kinds.lastIndexOf('curated');
    check(
      kinds.includes('curated') && (firstBulk === -1 || firstBulk > lastCurated),
      'curated sections come before the bulk type lists',
      `(${panel.sections.slice(0, 4).join(' / ')})`
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
    // --- Cuts tab -----------------------------------------------------------
    await page.locator('.edhrec-panel-tab', { hasText: 'Cuts' }).first().click();
    await page.waitForTimeout(2500);
    const cuts = await page.evaluate(() => {
      const sections = [...document.querySelectorAll('.edhrec-panel-section')].map((s) => ({
        title: s.querySelector('.edhrec-panel-title')?.textContent,
        rows: [...s.querySelectorAll('.edhrec-panel-row')].map((r) => ({
          name: r.querySelector('.edhrec-panel-name')?.textContent,
          lift: r.querySelector('.edhrec-panel-lift')?.textContent,
        })),
      }));
      const deck = new Set(
        [...document.querySelectorAll('.edhrec-badge')]
          .map((b) => (b.dataset.cardName || '').split('//')[0].trim().toLowerCase())
          .filter(Boolean)
      );
      const listed = sections.flatMap((s) => s.rows.map((r) => r.name || ''));
      return {
        heading: document.querySelector('.edhrec-panel-h1')?.textContent,
        salt: document.querySelector('.edhrec-panel-salt')?.innerText.replace(/\n/g, ' ') || null,
        sections: sections.map((s) => s.title),
        liftOrder: (sections.find((s) => s.title === 'Lowest lift')?.rows || [])
          .map((r) => parseFloat(r.lift))
          .filter((n) => !Number.isNaN(n)),
        // Every cut candidate must actually BE in the deck - the mirror of the
        // Add tab's invariant.
        notInDeck: listed.filter((n) => n && !deck.has(n.split('//')[0].trim().toLowerCase())),
        sectionsRows: listed,
      };
    });
    check(cuts.heading === 'Trim this deck', 'cuts tab switches', `(${cuts.heading})`);
    check(
      cuts.notInDeck.length === 0,
      'every cut candidate is actually in the deck',
      cuts.notInDeck.length ? `(${cuts.notInDeck.slice(0, 3).join(', ')})` : ''
    );
    const ascending = cuts.liftOrder.every((v, i, a) => i === 0 || a[i - 1] <= v);
    check(ascending && cuts.liftOrder.length > 1, 'cuts sorted lowest-lift first', `(${cuts.liftOrder.slice(0, 4).join(', ')})`);
    // The property, not the deck: a total shows exactly when some card carries a
    // salt score. Demanding one failed on any deck without a top-100 salty card,
    // which says nothing about the extension.
    const salty = edh.withSalt > 0;
    check(
      Boolean(cuts.salt) === salty,
      salty ? 'deck salt total shown' : 'no salt total for a deck with no salty cards',
      cuts.salt ? `(${cuts.salt.slice(0, 44)})` : `(${edh.withSalt} salty badges)`
    );
    // You cannot cut your commander, so it must never be offered as a cut.
    const cmdName = (edh.commanders || '').split(' and ')[0].trim().toLowerCase();
    const cutListsCommander = cmdName
      ? cuts.sectionsRows.some((n) => n.toLowerCase() === cmdName)
      : false;
    check(!cutListsCommander, 'commander is not listed as a cut', cmdName ? `(${cmdName})` : '(no commander)');

    // --- Combos (Commander Spellbook) -----------------------------------------
    await page.locator('.edhrec-panel-tab', { hasText: 'Combos' }).first().click();
    await page.waitForTimeout(7000);
    const combo = await page.evaluate(() => {
      const deck = new Set(
        [...document.querySelectorAll('.edhrec-badge')]
          .map((b) => (b.dataset.cardName || '').split('//')[0].trim().toLowerCase())
          .filter(Boolean)
      );
      const rows = [...document.querySelectorAll('.edhrec-panel-combo')];
      const needed = rows
        .map((r) => r.querySelector('.edhrec-panel-name')?.textContent?.trim())
        .filter(Boolean);
      return {
        heading: document.querySelector('.edhrec-panel-h1')?.textContent,
        rows: rows.length,
        withLine: rows.filter((r) => r.querySelector('.edhrec-panel-combolines')).length,
        // A card you must ADD cannot be one you already have.
        alreadyHave: needed.filter((n) => deck.has(n.split('//')[0].trim().toLowerCase())),
        sample: rows[0]?.innerText.replace(/\s+/g, ' ').slice(0, 90) || '',
      };
    });
    check(combo.rows > 0, 'combos load from Commander Spellbook', `(${combo.rows} rows)`);
    check(combo.withLine === combo.rows, 'every combo shows the line it completes', `(${combo.withLine}/${combo.rows})`);
    check(
      combo.alreadyHave.length === 0,
      'no combo asks for a card already in the deck',
      combo.alreadyHave.length ? `(${combo.alreadyHave.slice(0, 3).join(', ')})` : ''
    );
    console.log('   e.g.', combo.sample);

    // Combo pieces are usually NOT in EDHREC's list for the commander, so they
    // arrive with no Scryfall id and used to get no hover preview at all.
    // Must be a row EDHREC does NOT list for this commander, i.e. one with no
    // lift figure. Those are the rows that had no id and so no preview;
    // hovering any old row tests nothing, because the listed ones always
    // worked.
    //
    // And one whose price has landed, since prices carry the id. A fixed 4s was
    // enough for the 11 unlisted pieces on one deck and not the 14 on another,
    // so it tested the wait rather than the preview.
    await page
      .waitForFunction(
        () =>
          [...document.querySelectorAll('.edhrec-panel-combo .edhrec-panel-row')].some(
            (r) => !r.querySelector('.edhrec-panel-lift') && /^\$/.test(r.querySelector('.edhrec-panel-price')?.textContent || '')
          ),
        null,
        { timeout: 30000 }
      )
      .catch(() => {});
    const rowSplit = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.edhrec-panel-combo .edhrec-panel-row')];
      const unlisted = rows.filter((r) => !r.querySelector('.edhrec-panel-lift'));
      const target = unlisted.find((r) => /^\$/.test(r.querySelector('.edhrec-panel-price')?.textContent || ''));
      // Mark it so the hover below targets it unambiguously.
      target?.setAttribute('data-test-unlisted', '1');
      return { rows: rows.length, unlisted: unlisted.length, name: target?.querySelector('.edhrec-panel-name')?.textContent };
    });
    console.log(`   combo rows ${rowSplit.rows}, of which ${rowSplit.unlisted} are not in EDHREC's list` +
      (rowSplit.name ? ` (testing ${rowSplit.name})` : ''));
    const comboRow = await page.$('[data-test-unlisted="1"]');
    let preview = null;
    if (comboRow) {
      await comboRow.scrollIntoViewIfNeeded();
      await comboRow.hover();
      await page.waitForTimeout(1500);
      preview = await page.evaluate(() => {
        const i = document.querySelector('.edhrec-panel-img');
        return i ? { visible: i.classList.contains('is-visible'), loaded: i.complete && i.naturalWidth > 0 } : null;
      });
    }
    check(
      Boolean(preview?.visible && preview?.loaded),
      'combo pieces EDHREC does not list still preview',
      preview ? JSON.stringify(preview) : `(no preview; ${rowSplit.unlisted} unlisted rows available)`
    );

    // --- Average decklist -----------------------------------------------------
    await page.locator('.edhrec-panel-tab', { hasText: 'Avg' }).first().click();
    await page.waitForTimeout(6000);
    const avg = await page.evaluate(() => ({
      heading: document.querySelector('.edhrec-panel-h1')?.textContent,
      stat: document.querySelector('.edhrec-panel-avgstat')?.innerText.replace(/\s+/g, ' ') || null,
      sections: [...document.querySelectorAll('.edhrec-panel-title')].map((t) => t.textContent),
    }));
    check(Boolean(avg.stat), 'average-list comparison loads', avg.stat ? `(${avg.stat.slice(0, 48)})` : '');
    check(
      avg.sections.includes('In the average, not yours') && avg.sections.includes('Yours, not in the average'),
      'both directions of the comparison shown',
      `(${avg.sections.join(' / ')})`
    );
    // EDHREC keeps the commander out of the average's card list, so leaving it
    // in ours would always report it as a difference.
    const avgNames = await page.evaluate(() =>
      [...document.querySelectorAll('.edhrec-panel-name')].map((n) => n.textContent.trim().toLowerCase())
    );
    check(
      !cmdName || !avgNames.includes(cmdName),
      'commander is not listed in the average comparison',
      cmdName ? `(${cmdName})` : '(no commander)'
    );

    await page.locator('.edhrec-panel-tab', { hasText: 'Add' }).first().click();
    await page.waitForTimeout(600);
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

  // A tile or row badge, not the hover preview's: the preview's badge is
  // replaced whenever Moxfield swaps the preview, which can happen mid-hover.
  //
  // And one that is actually on top once centred. The first badge in the DOM
  // was the commander's, at the bottom edge of the screen, where Moxfield's
  // sticky footer and a floating video ad slide over it - and an ad arriving
  // under a still pointer hides the tooltip, correctly. That made this pass or
  // fail with the ads. Any scroll hides it too, and the scroll event lands a
  // frame after scrollIntoView() returns, so each candidate settles first.
  const tipBadge = (
    await page.evaluateHandle(async () => {
      for (const b of document.querySelectorAll('.edhrec-badge:not(.edhrec-preview-host > .edhrec-badge)')) {
        if (!b.offsetParent) continue;
        b.scrollIntoView({ block: 'center' });
        await new Promise((r) => setTimeout(r, 400));
        const r = b.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        if (hit === b || b.contains(hit)) return b;
      }
      return null;
    })
  ).asElement();
  if (tipBadge) {
    await tipBadge.hover();
    await page
      .waitForFunction(() => document.querySelector('.edhrec-tip')?.classList.contains('is-visible'), null, { timeout: 2000 })
      .catch(() => {});
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
    if (!tip?.visible) {
      // Say what the pointer was actually over: "no tooltip" alone cannot tell a
      // covered badge from a replaced one from a tooltip that was hidden again.
      const diag = await tipBadge.evaluate((b) => {
        const r = b.getBoundingClientRect();
        const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return {
          badge: b.dataset.cardName,
          stillAttached: b.isConnected,
          underPointer: at ? `${at.tagName.toLowerCase()}.${[...at.classList].slice(0, 2).join('.')}` : null,
          tipExists: Boolean(document.querySelector('.edhrec-tip')),
        };
      });
      console.log('   diagnosis:', JSON.stringify(diag));
    }
  }

  // --- Game Changer: ours shows only where Moxfield's does not ---------------
  // Moxfield prints its own fa-gauge icon beside game changers, but only on text
  // rows. Judged per host, not per page: in the visual views the sideboard stays
  // a text list, so the page can show Moxfield's icon on one card's sideboard
  // row and our ring on another card's tile with nothing duplicated - which the
  // old page-wide count reported as a failure. Holds in any view and any deck,
  // including one with no game changers at all.
  const gc = await page.evaluate(() => {
    const MARK = '.fa-gauge[id*="-brackets-"]';
    const iconOn = (host) => [...host.querySelectorAll(MARK)].some((e) => e.offsetParent);
    const badges = [...document.querySelectorAll('.edhrec-badge')].filter((b) => b.offsetParent);
    const ringed = badges.filter((b) => b.classList.contains('edhrec-game-changer'));
    return {
      icons: [...document.querySelectorAll(MARK)].filter((e) => e.offsetParent).length,
      rings: ringed.length,
      // Our ring on a host where Moxfield's icon already shows.
      doubled: ringed.filter((b) => iconOn(b.parentElement)).map((b) => b.dataset.cardName),
      // A ring withheld in favour of an icon that is not on this host.
      unmarked: badges.filter((b) => b.dataset.moxGameChanger === '1' && !iconOn(b.parentElement)).map((b) => b.dataset.cardName),
    };
  });
  check(
    gc.doubled.length === 0,
    'game-changer marker is not duplicated',
    `(moxfield ${gc.icons}, ours ${gc.rings}${gc.doubled.length ? `; both on ${gc.doubled.join(', ')}` : ''})`
  );
  check(gc.unmarked.length === 0, 'no game changer is left unmarked', gc.unmarked.length ? `(${gc.unmarked.join(', ')})` : '');

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
