/**
 * Regression test for the Scryfall lookup path.  Run: node tools/test-lookup.mjs
 *
 * Loads the REAL src/background.js under stubbed extension APIs, so this
 * exercises shipped code rather than a reimplementation that can drift from it.
 *
 * Hits the live Scryfall API — it is a contract test, not a unit test. That is
 * deliberate: every bug this file exists to catch came from Scryfall behaving
 * differently than the docs implied, which a mocked test would have missed.
 *
 * Guards in particular against the multi-face bug: Scryfall answers a
 * front-face query with the card's FULL name, so a response map keyed only on
 * `card.name` cannot be matched back to the request, and every MDFC, transform,
 * split and adventure card silently reads as unranked.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const store = new Map();
globalThis.browser = {
  storage: {
    local: {
      get: async (keys) =>
        keys === null
          ? Object.fromEntries(store)
          : Object.fromEntries(keys.filter((k) => store.has(k)).map((k) => [k, store.get(k)])),
      set: async (patch) => {
        for (const [k, v] of Object.entries(patch)) store.set(k, v);
      },
      remove: async (keys) => {
        for (const k of [].concat(keys)) store.delete(k);
      },
    },
  },
  runtime: { onMessage: { addListener: () => {} } },
};

// Firefox supplies its own User-Agent. Node does not, and Scryfall rejects a
// default library UA with HTTP 400 (rule: generic_user_agent).
const realFetch = globalThis.fetch;
const uaFetch = (url, opts = {}) =>
  realFetch(url, {
    ...opts,
    headers: {
      ...(opts.headers || {}),
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0',
    },
  });
globalThis.fetch = uaFetch;

const src = readFileSync(join(root, 'src', 'background.js'), 'utf8');
// Prime the cache with a PREVIOUS payload shape before the module loads, so the
// stale-cache check below exercises what a real upgrade actually hits.
//
// This is the bug that shipped: the EDHREC cache version was split out of
// CACHE_VERSION but kept the same VALUE, so the key never changed. Browsers kept
// serving a payload with no lists, the recommendations panel rendered nothing,
// and synergy silently vanished from tooltips.
for (const v of ['v1', 'v2', 'v3']) {
  store.set(`edhrec:${v}:bria-riptide-rogue`, {
    ts: Date.now(),
    value: { 'sol ring': { name: 'Sol Ring', synergy: 0.017 } },
  });
}

const { lookup, edhrecForDeck } = await (0, eval)(
  `(async () => { ${src}\n; return { lookup, edhrecForDeck }; })()`
);

// `ranked: false` means we expect a resolved card with no EDHREC rank, or no
// card at all — not a failure.
const CASES = [
  { name: 'Sol Ring', ranked: true, note: 'plain card' },
  { name: 'Malakir Rebirth', ranked: true, note: 'modal_dfc, front face only' },
  { name: 'Malakir Rebirth // Malakir Mire', ranked: true, note: 'modal_dfc, full name' },
  { name: "Agadeem's Awakening // Agadeem, the Undercrypt", ranked: true, note: 'modal_dfc, apostrophe' },
  { name: 'Fable of the Mirror-Breaker // Reflection of Kiki-Jiki', ranked: true, note: 'transform, full' },
  { name: 'Brutal Cathar', ranked: true, note: 'transform, front face only' },
  { name: 'Fire // Ice', ranked: true, note: 'split' },
  { name: 'Bonecrusher Giant // Stomp', ranked: true, note: 'adventure' },
  { name: 'Valley Farmstead', ranked: true, note: 'FLAVOR name for Yavimaya, Cradle of Growth' },
  { name: 'Island', ranked: false, note: 'real card, legitimately unranked' },
  { name: 'Zzzzz Not A Card', ranked: false, note: 'genuine miss, negative-cached' },
];

let failures = 0;
const ranks = await lookup(CASES.map((c) => c.name));

for (const { name, ranked, note } of CASES) {
  const hit = ranks[name];
  const shown = !hit ? 'NO MATCH' : hit.rank == null ? 'unranked' : '#' + hit.rank;
  const ok = ranked ? Boolean(hit) && hit.rank != null : true;
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${shown.padEnd(10)} ${name}${note ? `  (${note})` : ''}`);
}

// A second pass must be served entirely from cache.
let calls = 0;
globalThis.fetch = () => {
  calls++;
  throw new Error('unexpected network call');
};
const replay = await lookup(CASES.map((c) => c.name));
const replayed = Object.keys(replay).length;
const cacheOk = calls === 0 && replayed === CASES.length;
if (!cacheOk) failures++;
console.log(`\n${cacheOk ? '  ok  ' : ' FAIL '} cache replay: ${calls} network calls, ${replayed}/${CASES.length} resolved`);

// A flavor name must resolve to the SAME rank as the card it reskins, or the
// fallback found some other card.
// The cache-replay check above swapped fetch for a throwing stub.
globalThis.fetch = uaFetch;
const pair = await lookup(['Valley Farmstead', 'Yavimaya, Cradle of Growth']);
const sameRank =
  pair['Valley Farmstead']?.rank != null &&
  pair['Valley Farmstead'].rank === pair['Yavimaya, Cradle of Growth']?.rank;
if (!sameRank) failures++;
console.log(
  `${sameRank ? '  ok  ' : ' FAIL '} flavor name resolves to the real card  ` +
    `(Valley Farmstead #${pair['Valley Farmstead']?.rank}, Yavimaya #${pair['Yavimaya, Cradle of Growth']?.rank})`
);

// --- stale / wrong-shape cache must not be served ---------------------------
// The cache-replay check above swapped fetch for a throwing stub; this section
// needs the network again.
globalThis.fetch = uaFetch;
const edh = await edhrecForDeck(['Bria, Riptide Rogue']);
const shapeOk = Object.keys(edh.stats).length > 50 && Array.isArray(edh.lists) && edh.lists.length > 0;
if (!shapeOk) failures++;
console.log(
  `${shapeOk ? '  ok  ' : ' FAIL '} stale-shaped cache is refetched, not served  ` +
    `(${Object.keys(edh.stats).length} stats, ${edh.lists.length} lists)`
);

console.log(failures === 0 ? '\nPASS' : `\nFAIL — ${failures} check(s) failed`);
process.exitCode = failures === 0 ? 0 : 1;
