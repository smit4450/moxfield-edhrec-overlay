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

const CACHE_PREFIX = 'rank:';

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
 * Double-faced cards reach us as "Front // Back". Scryfall usually resolves the
 * full string, but front-face-only is the reliable fallback on a miss.
 */
const frontFace = (name) => name.split('//')[0].trim();

async function fetchBatch(names) {
  const identifiers = names.map((name) => ({ name }));
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
  const found = new Map();
  for (const card of body.data || []) {
    found.set(card.name.toLowerCase(), {
      rank: card.edhrec_rank ?? null,
      gameChanger: card.game_changer === true,
      scryfallUri: card.scryfall_uri ?? null,
    });
  }
  return found;
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

    const missed = [];
    for (const name of batch) {
      const hit = found.get(name.toLowerCase());
      if (hit) {
        result[name] = hit;
        resolved.push([name, hit]);
      } else if (name.includes('//')) {
        missed.push(name);
      } else {
        // Genuinely unknown to Scryfall (a token, or a broken name read).
        // Cache the negative so we stop asking.
        result[name] = null;
        resolved.push([name, null]);
      }
    }

    // Retry double-faced misses using just the front face.
    if (missed.length) {
      try {
        const retry = await enqueue(() => fetchBatch(missed.map(frontFace)));
        for (const name of missed) {
          const hit = retry.get(frontFace(name).toLowerCase()) ?? null;
          result[name] = hit;
          resolved.push([name, hit]);
        }
      } catch (err) {
        console.warn('[edhrec-overlay] DFC retry failed:', err.message);
      }
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
