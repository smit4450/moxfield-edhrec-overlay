/**
 * Unit test: the two ways the extension failed only in Chrome, reproduced
 * without Chrome.  Run: node tools/test-chrome.mjs
 *
 * 1. A full storage.local. Firefox does not cap it; Chrome caps it at 10 MB
 *    unless the extension asks for unlimitedStorage, and one commander page is
 *    ~60 KB. A rejected cache write used to reject the lookup it belonged to -
 *    no badge for any card not already cached - and a failed EDHREC or salt
 *    write threw away data just fetched. Nothing removed expired entries
 *    either, so a full storage never emptied. Here the real background runs
 *    over a storage stub whose writes fail the way Chrome's do, and its sweep
 *    runs over entries of every cache family: fresh, expired and superseded.
 *
 * 2. A page element with id="browser". Chrome had no `browser` namespace
 *    before 148, and named access makes such an element globalThis.browser,
 *    which `browser ?? chrome` handed back as the extension API.
 *
 * No network: fetch is stubbed. Part 1 runs in Node, part 2 in headless
 * Chromium.
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

// --- 1. storage ------------------------------------------------------------------
console.log('storage');
const store = new Map();
let writesFail = false;
globalThis.browser = {
  runtime: { onMessage: { addListener: () => {} } },
  storage: {
    local: {
      get: async (keys) =>
        keys === null
          ? Object.fromEntries(store)
          : Object.fromEntries([].concat(keys).filter((k) => store.has(k)).map((k) => [k, store.get(k)])),
      // Chrome's wording when storage.local is over its quota.
      set: async (patch) => {
        if (writesFail) throw new Error('Resource::kQuotaBytes quota exceeded');
        for (const [k, v] of Object.entries(patch)) store.set(k, v);
      },
      remove: async (keys) => {
        for (const k of [].concat(keys)) store.delete(k);
      },
    },
  },
};
const reply = (body) => ({ ok: true, status: 200, json: async () => body });
globalThis.fetch = async (url, opts = {}) => {
  url = String(url);
  if (url.includes('api.scryfall.com/cards/collection')) {
    const { identifiers } = JSON.parse(opts.body);
    return reply({
      data: identifiers.map(({ name }) => ({
        object: 'card',
        id: '0123abcd-0000-4000-8000-000000000000',
        name,
        edhrec_rank: 42,
        game_changer: false,
        prices: { usd: '0.50' },
      })),
      not_found: [],
    });
  }
  if (url.includes('/pages/commanders/')) {
    return reply({
      container: {
        json_dict: {
          card: { name: 'Test Commander', rank: 7, num_decks: 100 },
          cardlists: [
            { header: 'High Lift Cards', tag: 'highliftcards', cardviews: [{ name: 'Sol Ring', lift: 1.2, synergy: 0.01, num_decks: 50, potential_decks: 100 }] },
          ],
        },
      },
    });
  }
  if (url.includes('/pages/top/salt')) {
    return reply({ container: { json_dict: { cardlists: [{ cardviews: [{ name: 'Sol Ring', salt: 1.5 }] }] } } });
  }
  throw new Error(`unexpected fetch: ${url}`);
};

const bg = await (0, eval)(
  `(async () => { ${read('background.js')}\n; return { lookup, lookupPrices, edhrecForDeck, purgeStaleCache,
    PREFIX: { rank: CACHE_PREFIX, price: PRICE_PREFIX, edhrec: EDHREC_PREFIX, salt: SALT_KEY, combos: COMBO_PREFIX, average: AVERAGE_PREFIX } }; })()`
);
const P = bg.PREFIX;

// The sweep. Keys are built from the live prefixes, so a version bump does not
// quietly turn every "fresh" entry here into a superseded one.
const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();
const old = (prefix) => prefix.replace(/:v(\d+)/, (_, n) => `:v${Number(n) - 1}`);
const KEEP = {
  [`${P.rank}sol ring`]: { value: { rank: 1 }, ts: now - 6 * DAY },
  [`${P.price}sol ring`]: { value: { usd: 1 }, ts: now - DAY / 2 },
  [P.salt]: { value: {}, ts: now - 6 * DAY },
  [`${P.combos}deck`]: { value: {}, ts: now - DAY / 2 },
  'some-other-extension-key': { untouched: true },
};
const DROP = {
  [`${P.rank}old card`]: { value: { rank: 9 }, ts: now - 8 * DAY },
  [`${P.price}old card`]: { value: { usd: 9 }, ts: now - 2 * DAY },
  [`${P.edhrec}old-commander`]: { value: {}, ts: now - 2 * DAY },
  [`${P.combos}old-deck`]: { value: {}, ts: now - 2 * DAY },
  [`${P.average}old-commander`]: { value: [], ts: now - 2 * DAY },
  [`${old(P.rank)}sol ring`]: { value: { rank: 1 }, ts: now },
  [`${P.rank}no timestamp`]: { value: { rank: 5 } },
};
for (const [k, v] of Object.entries({ ...KEEP, ...DROP })) store.set(k, v);
await bg.purgeStaleCache();
const kept = Object.keys(KEEP).filter((k) => store.has(k));
const leftover = Object.keys(DROP).filter((k) => store.has(k));
check(kept.length === Object.keys(KEEP).length, 'fresh entries, and keys that are not ours, survive the sweep', `(${kept.length}/${Object.keys(KEEP).length})`);
check(leftover.length === 0, 'expired, superseded and timestamp-less entries are swept, in every family', leftover.length ? `(left: ${leftover.join(', ')})` : '');

// A full storage.local. Every write now fails, as Chrome's do once over quota.
// Start from nothing cached, so every lookup has to fetch and then write.
store.clear();
writesFail = true;
const settle = (p) => p.then((value) => ({ value }), (error) => ({ error: error.message }));
const ranks = await settle(bg.lookup(['Brand New Card']));
check(ranks.value?.['Brand New Card']?.rank === 42, 'a rank lookup still answers when the write fails', `(${JSON.stringify(ranks.value?.['Brand New Card'] ?? ranks.error)})`);
const prices = await settle(bg.lookupPrices(['Brand New Card']));
check(prices.value?.['Brand New Card']?.usd != null, 'so does a price lookup', `(${JSON.stringify(prices.value?.['Brand New Card'] ?? prices.error)})`);
const edh = await settle(bg.edhrecForDeck(['Test Commander']));
check(
  edh.value?.matched === true && edh.value?.stats?.['sol ring']?.lift === 1.2 && edh.value?.salt?.['sol ring'] === 1.5,
  'and EDHREC data, salt included, is returned rather than thrown away',
  `(matched ${edh.value?.matched ?? edh.error}, salt ${JSON.stringify(edh.value?.salt)})`
);

// --- 2. a page element named "browser" --------------------------------------------------
console.log('\nnamespace');
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
  await page.setContent(`<!doctype html><body>
    <div id="browser">a page's own element, named "browser"</div>
    <div id="vd-Sol01"><img class="img-card" alt="Sol Ring" width="120" height="168"></div>
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
  // Without this the check below could pass without exercising anything.
  const shadowed = await page.evaluate(() => globalThis.browser instanceof HTMLElement);
  check(shadowed, 'the page element is what globalThis.browser resolves to');
  for (const f of ['moxfield-dom.js', 'panel.js', 'content.js']) await page.evaluate(read(f));
  const badged = await page
    .waitForFunction(() => document.querySelector('.edhrec-badge')?.textContent === '#1', null, { timeout: 5000 })
    .then(() => true, () => false);
  check(badged, 'the content scripts still find the real extension API, and badge the card');
} catch (err) {
  failures++;
  console.log('FAILED:', err.message.split('\n')[0]);
} finally {
  await browser.close();
}

console.log(failures === 0 ? '\nPASS' : `\nFAIL - ${failures} check(s) failed`);
process.exitCode = failures ? 1 : 0;
