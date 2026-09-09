/**
 * Scryfall client: batching, rate limiting, and persistent caching.
 *
 * Content scripts never talk to Scryfall directly — they message this script,
 * which keeps one shared cache and one serial request queue for the whole
 * browser session. That makes the rate limit easy to honor no matter how many
 * Moxfield tabs are open.
 */

const api = globalThis.browser ?? globalThis.chrome;

const SCRYFALL_COLLECTION = 'https://api.scryfall.com/cards/collection';

// Scryfall documents /cards/collection at 2 requests/second and a maximum of
// 75 identifiers per request. https://scryfall.com/docs/api/cards/collection
const MAX_IDENTIFIERS = 75;
const MIN_REQUEST_SPACING_MS = 550; // 500ms + margin

// Scryfall asks callers to cache for at least 24h, and notes that gameplay
// data changes rarely. edhrec_rank drifts slowly, so a week is plenty.
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Bumped whenever previously-cached values could be wrong, so entries written
 * by an older build are ignored instead of served.
 *
 * v2: before the multi-face fix, every MDFC, transform, split and adventure
 * card was negative-cached as `null`. Without a bump those entries would keep
 * reporting "unranked" for the full 7-day TTL after the fix shipped, making the
 * fix look like it had not worked.
 */
const CACHE_VERSION = 'v2';
const CACHE_PREFIX = `rank:${CACHE_VERSION}:`;

/** Drop entries left behind by an older cache version. */
async function purgeStaleCacheVersions() {
  const all = await api.storage.local.get(null);
  const dead = Object.keys(all).filter((k) => k.startsWith('rank:') && !k.startsWith(CACHE_PREFIX));
  if (!dead.length) return;
  await api.storage.local.remove(dead);
  console.info(`[edhrec-overlay] cleared ${dead.length} cache entries from an older version`);
}
purgeStaleCacheVersions().catch((err) => console.warn('[edhrec-overlay] cache purge failed:', err));

/** Serial queue — guarantees we never exceed the documented rate limit. */
let queueTail = Promise.resolve();
function enqueue(task) {
  const run = queueTail.then(task, task);
  queueTail = run.then(() => sleep(MIN_REQUEST_SPACING_MS), () => sleep(MIN_REQUEST_SPACING_MS));
  return run;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Scryfall matches names case-insensitively; normalize so the cache does too. */
const cacheKey = (name) => CACHE_PREFIX + name.toLowerCase();

async function readCache(names) {
  const keys = names.map(cacheKey);
  const stored = await api.storage.local.get(keys);
  const fresh = new Map();
  const stale = [];
  const now = Date.now();
  for (const name of names) {
    const hit = stored[cacheKey(name)];
    if (hit && now - hit.ts < CACHE_TTL_MS) fresh.set(name, hit.value);
    else stale.push(name);
  }
  return { fresh, stale };
}

async function writeCache(entries) {
  const now = Date.now();
  const patch = {};
  for (const [name, value] of entries) {
    patch[cacheKey(name)] = { value, ts: now };
  }
  if (Object.keys(patch).length) await api.storage.local.set(patch);
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Every multi-face layout reaches us as "Front // Back".
 *
 * Scryfall's `name` identifier does NOT accept that combined form. Verified
 * 2026-09-09: full-name requests came back not_found for split (Fire // Ice),
 * adventure (Bonecrusher Giant // Stomp), modal_dfc (Malakir Rebirth // Malakir
 * Mire) and transform (Fable of the Mirror-Breaker // ...) alike, while the
 * front face alone resolved every one. So we always ask for the front face.
 */
const frontFace = (name) => name.split('//')[0].trim();

/**
 * Index a Scryfall response so it can be matched back to whatever name we were
 * given.
 *
 * This is the subtle half. A front-face query answers with the card's FULL
 * name — ask for "Malakir Rebirth" and you get back "Malakir Rebirth // Malakir
 * Mire". Keying the map on `card.name` alone therefore fails to match the very
 * request that produced it, and every multi-face card silently reads as
 * unranked even though its rank is right there in the payload.
 *
 * So index each card under its full name, each of its face names, and the
 * front-face split of its full name. Full names are indexed first, so a real
 * card's own name always wins if it ever collides with another card's face.
 */
function indexCards(cards) {
  const byName = new Map();
  const put = (key, value) => {
    const k = (key || '').trim().toLowerCase();
    if (k && !byName.has(k)) byName.set(k, value);
  };

  const entries = cards.map((card) => ({
    card,
    value: {
      rank: card.edhrec_rank ?? null,
      gameChanger: card.game_changer === true,
      scryfallUri: card.scryfall_uri ?? null,
    },
  }));

  for (const { card, value } of entries) put(card.name, value);
  for (const { card, value } of entries) {
    for (const face of card.card_faces || []) put(face.name, value);
    put(frontFace(String(card.name)), value);
  }
  return byName;
}

async function fetchBatch(names) {
  const identifiers = names.map((name) => ({ name: frontFace(name) }));
  const res = await fetch(SCRYFALL_COLLECTION, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Scryfall REJECTS default HTTP-library User-Agents outright (HTTP 400,
      // rule "generic_user_agent"), and `User-Agent` is a forbidden header name
      // that fetch() cannot set. We rely on Firefox sending its own UA, which
      // Scryfall accepts — verified 2026-09-09. See README before changing this.
      Accept: 'application/json',
    },
    body: JSON.stringify({ identifiers }),
  });

  if (res.status === 429) throw new Error('rate-limited');
  if (!res.ok) throw new Error(`scryfall ${res.status}`);

  const body = await res.json();
  return indexCards(body.data || []);
}

/** Resolve names to rank records, hitting the network only for cache misses. */
async function lookup(names) {
  const unique = [...new Set(names.filter(Boolean).map((n) => n.trim()))];
  const { fresh, stale } = await readCache(unique);
  const result = Object.fromEntries(fresh);
  if (!stale.length) return result;

  const resolved = [];

  for (const batch of chunk(stale, MAX_IDENTIFIERS)) {
    let found;
    try {
      found = await enqueue(() => fetchBatch(batch));
    } catch (err) {
      console.warn('[edhrec-overlay] batch failed:', err.message);
      continue;
    }

    for (const name of batch) {
      // Look up under the name we were handed, then under its front face. The
      // response is indexed under both, so this resolves whether Moxfield gave
      // us "Malakir Rebirth" or "Malakir Rebirth // Malakir Mire".
      const hit = found.get(name.toLowerCase()) ?? found.get(frontFace(name).toLowerCase()) ?? null;
      // A miss here means Scryfall genuinely does not know the name (a token,
      // or a bad read). Cache the negative so we stop asking.
      result[name] = hit;
      resolved.push([name, hit]);
    }
  }

  await writeCache(resolved);
  return result;
}

api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'lookup-ranks') return false;
  lookup(msg.names)
    .then((ranks) => sendResponse({ ok: true, ranks }))
    .catch((err) => sendResponse({ ok: false, error: String(err) }));
  return true; // keep the message channel open for the async response
});
