/**
 * Live DOM verification.  Run: node tools/verify-live.mjs [deckUrl]
 *
 * Drives a real browser at a real Moxfield deck, injects src/moxfield-dom.js
 * and src/badge.css, paints badges on everything findTargets() returns, and
 * screenshots each of Moxfield's six view styles into .pw-shots/.
 *
 * Replaces pasting a diagnostic into devtools by hand.
 *
 * Two constraints shape this:
 *
 *   - Cloudflare blocks headless outright ("Sorry, you have been blocked"), so
 *     this runs HEADED with a persistent profile. A browser window will open.
 *   - The extension itself is not loaded. That is fine: this verifies the DOM
 *     adapter, which is the fragile half. The Scryfall half is covered by
 *     tools/test-lookup.mjs.
 *
 * Requires playwright + its chromium build:
 *   npm i -D playwright && npx playwright install chromium
 */

import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DECK = process.argv[2] || 'https://moxfield.com/decks/ri44zg2DG0iBE2jUNXEdPg';
const adapter = readFileSync(join(root, 'src', 'moxfield-dom.js'), 'utf8');
const css = readFileSync(join(root, 'src', 'badge.css'), 'utf8');
const SHOTS = join(root, '.pw-shots');
mkdirSync(SHOTS, { recursive: true });

/** Every option under "View Style" in Moxfield's Customize View dialog. */
const VIEW_STYLES = [
  'Text',
  'Condensed Text',
  'Visual Grid',
  'Visual Stacks',
  'Visual Stacks (Split)',
  'Visual Spoiler',
];

const ctx = await chromium.launchPersistentContext(join(root, '.pw-profile'), {
  headless: false,
  viewport: { width: 1600, height: 1000 },
  args: ['--disable-blink-features=AutomationControlled'],
});
const page = ctx.pages()[0] || (await ctx.newPage());

const settle = () =>
  page.waitForFunction(
    () =>
      !document.body.innerText.includes('Loading Moxfield') &&
      (document.querySelectorAll('.img-card').length > 0 ||
        document.querySelectorAll('a.table-deck-row-link').length > 0),
    { timeout: 60000 }
  );

async function setViewStyle(style) {
  await page.getByRole('button', { name: /view options/i }).first().click();
  // Scope everything to the dialog: card names in the deck list collide with
  // the option labels, and a bare getByText picks up hidden copies elsewhere
  // and then waits forever for them to become clickable.
  const dialog = page.getByRole('dialog').first();
  await dialog.waitFor({ state: 'visible', timeout: 15000 });

  // "Visual Stacks" is a prefix of "Visual Stacks (Split)", so match exactly.
  const radio = dialog.getByRole('radio', { name: style, exact: true });
  await radio.waitFor({ state: 'visible', timeout: 15000 });
  await radio.check({ force: true });

  await dialog.getByRole('button', { name: 'Save' }).first().click();
  await dialog.waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1200);
  await settle();
}

/** Inject the adapter + stylesheet, paint badges, and report what happened. */
async function probeAndPaint(label) {
  await page.addStyleTag({ content: css });
  await page.evaluate(adapter);

  const out = await page.evaluate(() => {
    const desc = (el) =>
      !el
        ? '(none)'
        : el.tagName.toLowerCase() +
          (el.id ? '#' + el.id : '') +
          (el.className
            ? '.' + String(el.className).trim().split(/\s+/).slice(0, 2).join('.')
            : '');
    const visible = (el) => !!(el.offsetParent || getComputedStyle(el).position === 'fixed');

    const dom = globalThis.MoxfieldDom;
    dom.removeAllBadges();
    const targets = dom.findTargets();

    const kinds = { image: 0, row: 0, preview: 0 };
    const names = new Map();
    const hosts = new Set();
    let dupHosts = 0;
    let hidden = 0;

    let n = 0;
    for (const t of targets) {
      const kind = t.live ? 'preview' : t.inline ? 'row' : 'image';
      kinds[kind]++;
      names.set(t.name, (names.get(t.name) || 0) + 1);
      if (hosts.has(t.host)) dupHosts++;
      hosts.add(t.host);
      if (!visible(t.host)) hidden++;

      // Stand-in badge: this run verifies placement, not ranks.
      const el = document.createElement('a');
      el.className = 'edhrec-badge edhrec-tier-' + ((n % 4) + 1);
      el.dataset.cardName = t.name;
      el.textContent = '#' + (((n * 137) % 9000) + 100).toLocaleString();
      dom.attachBadge(t, el);
      n++;
    }

    const painted = document.querySelectorAll('.edhrec-badge').length;
    const visiblePainted = [...document.querySelectorAll('.edhrec-badge')].filter(visible).length;

    return {
      total: targets.length,
      kinds,
      distinctNames: names.size,
      repeated: [...names.entries()].filter(([, c]) => c > 1).slice(0, 4),
      dupHosts,
      hiddenHosts: hidden,
      mountInsideLink: targets.filter((t) => t.mount.closest('a')).length,
      painted,
      visiblePainted,
      sample: targets.slice(0, 3).map((t) => ({
        name: t.name,
        kind: t.live ? 'preview' : t.inline ? 'row' : 'image',
        host: desc(t.host),
        mount: desc(t.mount),
      })),
    };
  });

  const flag = (n) => (n ? ` <-- ${n}` : '');
  console.log(`\n=== ${label} ===`);
  console.log(`targets ${out.total}  image ${out.kinds.image}  row ${out.kinds.row}  preview ${out.kinds.preview}`);
  console.log(`painted ${out.painted} (${out.visiblePainted} visible)  distinct names ${out.distinctNames}`);
  console.log(`dupHosts ${out.dupHosts}${flag(out.dupHosts)}  hiddenHosts ${out.hiddenHosts}${flag(out.hiddenHosts)}  mountInsideLink ${out.mountInsideLink}${flag(out.mountInsideLink)}`);
  if (out.repeated.length) console.log('repeated names:', JSON.stringify(out.repeated));
  for (const s of out.sample) console.log(`   [${s.kind}] ${JSON.stringify(s.name)}  host ${s.host}  mount ${s.mount}`);

  await page.screenshot({ path: join(SHOTS, label.replace(/[^a-z0-9]+/gi, '-').toLowerCase() + '.png') });
  return out;
}

try {
  await page.goto(DECK, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await settle();
  console.log('loaded:', await page.title());

  for (const style of VIEW_STYLES) {
    try {
      await setViewStyle(style);
      await probeAndPaint(style);
    } catch (err) {
      console.log(`\n=== ${style} ===\nFAILED: ${err.message.split('\n')[0]}`);
    }
  }
} catch (err) {
  console.log('FAILED:', err.message.split('\n')[0]);
  console.log('body:', await page.evaluate(() => document.body?.innerText.slice(0, 200).replace(/\s+/g, ' ')).catch(() => '?'));
} finally {
  await ctx.close();
}
