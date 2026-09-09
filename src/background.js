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

/**
 * Drop entries left behind by an older cache version, across every family.
 *
 * Previously this only swept `rank:`, so superseded EDHREC and salt entries
 * accumulated instead of being cleaned up.
 */
async function purgeStaleCacheVersions() {
  // Deferred to the end of the file: the current-key constants are declared
  // below, and reading them here would hit the temporal dead zone.
  const families = [
    ['rank:', CACHE_PREFIX],
    ['edhrec:', EDHREC_PREFIX],
    ['salt:', SALT_KEY],
    ['price:', PRICE_PREFIX],
    ['combos:', COMBO_PREFIX],
    ['average:', AVERAGE_PREFIX],
  ];
  const all = await api.storage.local.get(null);
  const dead = Object.keys(all).filter((k) =>
    families.some(([family, current]) => k.startsWith(family) && !k.startsWith(current))
  );
  if (!dead.length) return;
  await api.storage.local.remove(dead);
  console.info(`[edhrec-overlay] cleared ${dead.length} cache entries from an older version`);
}

/**
 * Prices live in their own cache family with a much shorter life than ranks.
 *
 * Scryfall states it updates prices once a day and that fetching more often
 * than 24h yields nothing new, so a day is both the useful and the polite TTL.
 * Ranks keep their week, since gameplay data barely moves.
 */
const PRICE_VERSION = 'v1';
const PRICE_PREFIX = `price:${PRICE_VERSION}:`;
const PRICE_TTL_MS = 24 * 60 * 60 * 1000;

/** Serial queue - guarantees we never exceed the documented rate limit. */
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

// ---------------------------------------------------------------------------
// EDHREC
//
// Scryfall gives us a card's global rank. Everything context-dependent - how
// much more a card is played with THIS commander than in general, what share
// of those decks run it - only exists on EDHREC.
//
// Unlike Scryfall this is an unofficial, undocumented API: json.edhrec.com is
// what edhrec.com's own frontend calls. It needs no key and is not behind
// Cloudflare, but it can change without notice, so every failure here is
// swallowed and the overlay falls back to rank-only.
//
// Cost is one request per deck, not per card: a commander page carries
// ~270-290 cards, which covered 100% of the average decklist for both
// commanders measured.
// ---------------------------------------------------------------------------

const EDHREC_COMMANDER = 'https://json.edhrec.com/pages/commanders/';
const EDHREC_SALT = 'https://json.edhrec.com/pages/top/salt.json';

// Commander recommendations shift slowly; the saltiest-cards list barely moves.
const EDHREC_TTL_MS = 24 * 60 * 60 * 1000;
const SALT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Versioned separately from the rank cache: the EDHREC payload shape changes
 * on its own schedule, and bumping it should not throw away every rank and
 * force a full Scryfall refetch.
 *
 * v3: the cached value gained `lists` (ordered recommendations) and a Scryfall
 * `id` per card, so earlier entries are the wrong shape.
 *
 * v2 was a mistake worth recording: this constant was split out of
 * CACHE_VERSION but kept the same VALUE, so the key stayed "edhrec:v2:" and
 * nothing was invalidated. Browsers carried on serving the old shape, the
 * panel saw no lists and never rendered, and synergy silently vanished from
 * tooltips. Bumping a version means changing the value, not the identifier -
 * and see the shape check in commanderStats(), which now catches this class of
 * error even when the version is fumbled.
 */
const EDHREC_VERSION = 'v3';
const EDHREC_PREFIX = `edhrec:${EDHREC_VERSION}:`;
const SALT_KEY = `salt:${EDHREC_VERSION}`;

/**
 * EDHREC card slugs: front face only, lowercase, apostrophes dropped, every
 * other run of non-alphanumerics collapsed to one hyphen. Verified against the
 * live API for 10 commanders including possessives (Atraxa, Praetors' Voice),
 * leading articles (The Ur-Dragon) and a double-faced commander (Esika, God of
 * the Tree // The Prismatic Bridge -> esika-god-of-the-tree).
 */
function edhrecSlug(name) {
  return name
    .split('//')[0]
    .trim()
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function readJsonCache(key, ttl) {
  const stored = await api.storage.local.get([key]);
  const hit = stored[key];
  return hit && Date.now() - hit.ts < ttl ? hit.value : null;
}

const writeJsonCache = (key, value) => api.storage.local.set({ [key]: { value, ts: Date.now() } });

/**
 * Flatten a commander page into two views of the same data:
 *
 *   stats  name -> the fields the badge tooltip shows
 *   lists  EDHREC's own groupings, in order, for the recommendations panel
 *
 * The panel needs the ordering and grouping that the flat map throws away, and
 * the Scryfall `id` on each cardview (verified to be a real Scryfall card id)
 * so card images can be built without another API call.
 */
function indexCommanderPage(page) {
  const stats = {};
  const lists = [];

  for (const list of page?.container?.json_dict?.cardlists || []) {
    const label = list.header || list.tag || '';
    const cards = [];

    for (const c of list.cardviews || []) {
      if (!c?.name) continue;
      const key = c.name.toLowerCase();
      const entry = (stats[key] ||= { name: c.name, lists: [] });
      // A card appears in several lists (a category plus, say, "Top Cards");
      // the stats are identical, so first write wins and we just collect labels.
      if (!entry.id && c.id) entry.id = c.id;
      if (entry.synergy === undefined && typeof c.synergy === 'number') entry.synergy = c.synergy;
      if (entry.inclusion === undefined && c.potential_decks > 0) {
        entry.inclusion = c.num_decks / c.potential_decks;
        entry.numDecks = c.num_decks;
        entry.potentialDecks = c.potential_decks;
      }
      if (label && !entry.lists.includes(label)) entry.lists.push(label);
      cards.push(c.name);
    }

    if (label && cards.length) lists.push({ header: label, cards });
  }

  return { stats, lists };
}

/**
 * Stats for one commander (or a partner pair).
 *
 * Partner slugs join the two names, and EDHREC fixes the order, so a miss on
 * the given order is retried reversed before giving up.
 */
async function commanderStats(names) {
  const slugs = names.map(edhrecSlug).filter(Boolean);
  if (!slugs.length) return null;

  const candidates = slugs.length > 1 ? [slugs.join('-'), [...slugs].reverse().join('-')] : [slugs[0]];

  for (const slug of candidates) {
    const key = EDHREC_PREFIX + slug;
    const cached = await readJsonCache(key, EDHREC_TTL_MS);
    // Belt as well as braces: refetch anything that is not the shape this
    // build expects, whatever the version string claims.
    if (cached?.stats && Array.isArray(cached.lists)) return cached;

    try {
      // Not on the Scryfall queue: that queue exists to honour Scryfall's
      // documented 2/sec limit, and borrowing it here would add 550ms of
      // needless latency and delay the rank batches behind it. This is at
      // most two requests per deck, then cached for a day.
      const res = await fetch(EDHREC_COMMANDER + slug + '.json', { headers: { Accept: 'application/json' } });
      if (!res.ok) continue;
      const value = indexCommanderPage(await res.json());
      if (!Object.keys(value.stats).length) continue;
      await writeJsonCache(key, value);
      return value;
    } catch (err) {
      console.warn('[edhrec-overlay] commander fetch failed:', slug, err.message);
    }
  }
  return null;
}

/**
 * Saltiest 100 cards, as name -> score.
 *
 * Per-card salt would mean one request per card - about 100 for a Commander
 * deck - so only the global top 100 is fetched. Salt is only interesting where
 * it is high anyway, so the cards this misses are the ones nobody cares about.
 */
async function saltScores() {
  const cached = await readJsonCache(SALT_KEY, SALT_TTL_MS);
  if (cached) return cached;
  try {
    const res = await fetch(EDHREC_SALT, { headers: { Accept: 'application/json' } });
    if (!res.ok) return {};
    const json = await res.json();
    const out = {};
    for (const list of json?.container?.json_dict?.cardlists || []) {
      for (const c of list.cardviews || []) {
        if (c?.name && typeof c.salt === 'number') out[c.name.toLowerCase()] = c.salt;
      }
    }
    await writeJsonCache(SALT_KEY, out);
    return out;
  } catch (err) {
    console.warn('[edhrec-overlay] salt fetch failed:', err.message);
    return {};
  }
}

/** Everything EDHREC can tell us about this deck, or null if it cannot. */
async function edhrecForDeck(commanderNames) {
  const [page, salt] = await Promise.all([
    commanderNames?.length ? commanderStats(commanderNames) : Promise.resolve(null),
    saltScores(),
  ]);
  return {
    stats: page?.stats || {},
    lists: page?.lists || [],
    salt: salt || {},
    matched: Boolean(page),
  };
}

/**
 * USD prices for Scryfall card ids.
 *
 * Same endpoint and rate limit as the rank lookup, so it goes through the same
 * serial queue. Addressed by id rather than name because the panel already has
 * Scryfall ids from EDHREC, which sidesteps every multi-face naming problem
 * that the rank path had to solve.
 *
 * `usd` is null for cards that only exist in foil, so fall back to `usd_foil`
 * rather than showing nothing.
 */
/**
 * USD price per card NAME, meaning the cheapest printing you could actually buy.
 *
 * The obvious implementation - ask Scryfall for the id EDHREC gives us - is
 * wrong, and quietly so. Those ids point at arbitrary printings: EDHREC's
 * Volcanic Island is Limited Edition Beta, which carries no USD price at all
 * and a EUR price of 10,577. Its Island, Mountain and Steam Vents are a promo
 * set with no prices either. Asking by name is no better: Scryfall's default
 * printing for Volcanic Island is Vintage Masters, an MTGO-only set.
 *
 * So: batch by name for the common case, then fall back to a per-card search
 * over all printings ordered by price for anything still unpriced. That turns
 * Volcanic Island into $938.50 (Revised) and Island into $0.06, which is the
 * number someone deciding whether to add a card actually needs.
 */
const SCRYFALL_SEARCH = 'https://api.scryfall.com/cards/search';

// The fallback costs one request per card, so bound it. Anything left over is
// picked up by the next call, and the cache means it is paid at most once a day.
const MAX_PRICE_FALLBACKS = 30;

const priceKey = (name) => PRICE_PREFIX + name.trim().toLowerCase();

/** Cheapest printing with a USD price, or null if the card has never had one. */
async function cheapestPrinting(name) {
  const q = encodeURIComponent(`!"${name.replace(/"/g, '')}" unique:prints`);
  try {
    const res = await enqueue(() =>
      fetch(`${SCRYFALL_SEARCH}?q=${q}&order=usd&dir=asc`, { headers: { Accept: 'application/json' } })
    );
    // 404 simply means nothing matched; that is an answer, not a failure.
    if (!res.ok) return null;
    const body = await res.json();
    const hit = (body.data || []).find((c) => c.prices?.usd != null);
    return hit ? Number(hit.prices.usd) : null;
  } catch (err) {
    console.warn('[edhrec-overlay] price fallback failed:', name, err.message);
    return null;
  }
}

async function lookupPrices(names) {
  const unique = [...new Set((names || []).filter(Boolean).map((n) => n.trim()))];
  if (!unique.length) return {};

  const stored = await api.storage.local.get(unique.map(priceKey));
  const now = Date.now();
  const result = {};
  const stale = [];
  for (const name of unique) {
    const hit = stored[priceKey(name)];
    if (hit && now - hit.ts < PRICE_TTL_MS) result[name] = hit.value;
    else stale.push(name);
  }
  if (!stale.length) return result;

  // Pass 1: batch by name. Multi-face names are asked for by front face, and
  // the reply indexed under every alias, exactly as the rank lookup does.
  const needFallback = [];
  for (const batch of chunk(stale, MAX_IDENTIFIERS)) {
    let found;
    try {
      found = await enqueue(async () => {
        const res = await fetch(SCRYFALL_COLLECTION, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ identifiers: batch.map((n) => ({ name: frontFace(n) })) }),
        });
        if (!res.ok) throw new Error(`scryfall ${res.status}`);
        return indexPrices((await res.json()).data || []);
      });
    } catch (err) {
      console.warn('[edhrec-overlay] price batch failed:', err.message);
      continue;
    }
    for (const name of batch) {
      const usd = found.get(name.toLowerCase()) ?? found.get(frontFace(name).toLowerCase()) ?? null;
      if (usd == null) needFallback.push(name);
      else result[name] = { usd };
    }
  }

  // Pass 2: whatever the default printing could not price.
  for (const name of needFallback.slice(0, MAX_PRICE_FALLBACKS)) {
    const usd = await cheapestPrinting(frontFace(name));
    result[name] = usd == null ? null : { usd };
  }

  const patch = {};
  for (const name of stale) {
    if (name in result) patch[priceKey(name)] = { value: result[name], ts: now };
  }
  if (Object.keys(patch).length) await api.storage.local.set(patch);
  return result;
}

/** Index a price response under full name, each face name, and the front face. */
function indexPrices(cards) {
  const byName = new Map();
  const put = (key, usd) => {
    const k = (key || '').trim().toLowerCase();
    if (k && !byName.has(k)) byName.set(k, usd);
  };
  const priced = cards.map((c) => ({
    card: c,
    usd: c.prices?.usd != null ? Number(c.prices.usd) : c.prices?.usd_foil != null ? Number(c.prices.usd_foil) : null,
  }));
  for (const { card, usd } of priced) put(card.name, usd);
  for (const { card, usd } of priced) {
    for (const face of card.card_faces || []) put(face.name, usd);
    put(frontFace(String(card.name)), usd);
  }
  return byName;
}

// ---------------------------------------------------------------------------
// Commander Spellbook and EDHREC's average decklist
// ---------------------------------------------------------------------------

const SPELLBOOK_COMBOS = 'https://backend.commanderspellbook.com/find-my-combos/';
const EDHREC_AVERAGE = 'https://json.edhrec.com/pages/average-decks/';

const COMBO_VERSION = 'v1';
const COMBO_PREFIX = `combos:${COMBO_VERSION}:`;
const AVERAGE_PREFIX = `average:${COMBO_VERSION}:`;
const COMBO_TTL_MS = 24 * 60 * 60 * 1000;

/** Keep the stored shape small; the raw reply is hundreds of KB. */
const MAX_COMBOS = 40;

/** Stable key for a decklist, so editing the deck invalidates its combos. */
function deckHash(names) {
  const joined = [...names].map((n) => n.toLowerCase()).sort().join('|');
  let h = 5381;
  for (let i = 0; i < joined.length; i++) h = ((h << 5) + h + joined.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36) + '-' + joined.length.toString(36);
}

const comboName = (u) => u?.card?.name || u?.name || null;
const featureName = (p) => p?.feature?.name || p?.name || null;

/**
 * Combos in this deck, and combos it is a single card away from.
 *
 * Commander Spellbook is open and needs no key. The payload shape is
 * `{commanders: [{card}], main: [{card}]}` - passing bare strings is rejected.
 *
 * Only a distilled form is cached: the raw reply runs to hundreds of KB, and
 * all the panel shows is which cards, what they produce, and how popular the
 * line is.
 */
async function lookupCombos(commanders, main) {
  const all = [...(commanders || []), ...(main || [])].filter(Boolean);
  if (!all.length) return { included: [], almost: [] };

  const key = COMBO_PREFIX + deckHash(all);
  const cached = await readJsonCache(key, COMBO_TTL_MS);
  if (cached?.included && cached?.almost) return cached;

  const res = await fetch(SPELLBOOK_COMBOS, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      commanders: (commanders || []).map((card) => ({ card })),
      main: (main || []).map((card) => ({ card })),
    }),
  });
  if (!res.ok) throw new Error(`spellbook ${res.status}`);

  const r = (await res.json()).results || {};
  const have = new Set(all.map((n) => frontFace(n).toLowerCase()));

  const distil = (v) => {
    const cards = (v.uses || []).map(comboName).filter(Boolean);
    return {
      id: v.id,
      cards,
      produces: (v.produces || []).map(featureName).filter(Boolean),
      popularity: v.popularity ?? 0,
      // What you would have to add. Computed here rather than trusted from the
      // reply, so it always agrees with the deck we actually sent.
      missing: cards.filter((n) => !have.has(frontFace(n).toLowerCase())),
    };
  };

  const bypop = (a, b) => b.popularity - a.popularity;
  const value = {
    included: (r.included || []).map(distil).sort(bypop).slice(0, MAX_COMBOS),
    almost: (r.almostIncluded || [])
      .map(distil)
      .filter((c) => c.missing.length === 1)
      .sort(bypop)
      .slice(0, MAX_COMBOS),
  };
  await writeJsonCache(key, value);
  return value;
}

/**
 * EDHREC's average decklist for this commander, as a flat list of card names.
 *
 * The payload nests cards by type as [name, quantity] pairs under
 * `deck.cards`, which is why this is not just a map over an array.
 */
async function averageDeck(commanders) {
  const slugs = (commanders || []).map(edhrecSlug).filter(Boolean);
  if (!slugs.length) return null;
  const candidates = slugs.length > 1 ? [slugs.join('-'), [...slugs].reverse().join('-')] : [slugs[0]];

  for (const slug of candidates) {
    const key = AVERAGE_PREFIX + slug;
    const cached = await readJsonCache(key, EDHREC_TTL_MS);
    if (Array.isArray(cached)) return cached;
    try {
      const res = await fetch(`${EDHREC_AVERAGE}${slug}.json`, { headers: { Accept: 'application/json' } });
      if (!res.ok) continue;
      const json = await res.json();
      const names = Object.values(json?.deck?.cards || {})
        .flat()
        .map((entry) => (Array.isArray(entry) ? entry[0] : entry))
        .filter(Boolean);
      if (!names.length) continue;
      await writeJsonCache(key, names);
      return names;
    } catch (err) {
      console.warn('[edhrec-overlay] average deck failed:', slug, err.message);
    }
  }
  return null;
}

purgeStaleCacheVersions().catch((err) => console.warn('[edhrec-overlay] cache purge failed:', err));

api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'lookup-ranks') {
    lookup(msg.names)
      .then((ranks) => sendResponse({ ok: true, ranks }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true; // keep the message channel open for the async response
  }

  if (msg?.type === 'lookup-combos') {
    lookupCombos(msg.commanders, msg.main)
      .then((data) => sendResponse({ ok: true, ...data }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (msg?.type === 'lookup-average') {
    averageDeck(msg.commanders)
      .then((cards) => sendResponse({ ok: true, cards: cards || [] }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (msg?.type === 'lookup-prices') {
    lookupPrices(msg.names)
      .then((prices) => sendResponse({ ok: true, prices }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (msg?.type === 'lookup-edhrec') {
    edhrecForDeck(msg.commanders)
      .then((data) => sendResponse({ ok: true, ...data }))
      // EDHREC is a nice-to-have; never let it break the rank badges.
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  return false;
});
