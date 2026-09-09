# Moxfield EDHREC Overlay

A Firefox extension that badges every card on a Moxfield page with its **EDHREC rank**.

Nothing like this appeared to exist when this repo was started (2026-09-09). The closest
neighbors — [Moxfield Card Pricer][pricer], [Moxfield to Scryfall Linker][linker],
[MTG Collection Lens][lens] — either overlay prices, or overlay collection data onto
*other* sites. Moxfield users have an open feature request for native
[EDHREC rank on the deck page][nolt706] that has not shipped.

## How it works

The overlay never scrapes EDHREC. Scryfall's card object already carries the number:

> `edhrec_rank` · Integer · Nullable — "This card's overall rank/popularity on EDHREC.
> Not all cards are ranked." — [Scryfall Card Objects][cards]

So the whole data path is one well-documented, CORS-friendly, officially-supported API.

```
content.js ──▶ background.js ──▶ POST api.scryfall.com/cards/collection
   │               │                  (≤75 names/request, 2 req/sec)
   │               └──▶ storage.local cache, 7-day TTL
   └──◀ rank map ──┘
```

A 100-card Commander deck is **two requests, ~1 second**, then nothing until the cache
expires. All Moxfield tabs share one queue and one cache in the background script, so
the rate limit holds no matter how many tabs are open.

The badge also surfaces Scryfall's `game_changer` flag (the Commander Game Changer list)
as a gold ring, and links out to the card's EDHREC page.

### Files

| File | Role |
|---|---|
| `src/moxfield-dom.js` | **All Moxfield-specific selectors.** The one file to fix when a deploy breaks things. |
| `src/content.js` | MutationObserver loop, badge construction, injection |
| `src/background.js` | Scryfall batching, rate limiting, persistent cache |
| `src/badge.css` | Badge styling, scoped to `.edhrec-*` |

## Install (temporary, for development)

Requires **Firefox 140+** (142+ on Android) — that's the floor for the
`data_collection_permissions` manifest key AMO now requires. This extension declares
`"none"`; it stores only a Scryfall rank cache locally and sends nothing anywhere.

1. `about:debugging#/runtime/this-firefox`
2. **Load Temporary Add-on…** → pick `manifest.json`
3. Open any Moxfield deck in **Visual Spoiler** view

Temporary add-ons are cleared when Firefox restarts. Permanent installation needs
[signing through AMO][signing].

## Verifying the selectors

Verified against a live deck page on **2026-09-09** with
[`tools/inspect-selectors.js`](tools/inspect-selectors.js):

| | |
|---|---|
| `.img-card` | **88** — all `<img>`, all with a non-empty `alt` |
| in skip containers | 11 — sample hand + sidebar previews |
| junk `alt` values | 3 — `"Transform"`, `"Front"`, `"Back"` |
| badgeable tiles | **77** |

`.img-card` sits on the `<img>` itself, so the name (`alt`) and the element are the same
thing. The badge is anchored one level out, on **`.img-card-visual`** — the per-card tile.

That tile also carries `id="vd-<cardId>"`, and the id matches the card-page slug:
`vd-Yd22G` alongside `/cards/Yd22G-elves-of-deep-shadow`. That's a stable per-card key
worth remembering if `alt` ever stops being reliable.

Anchoring was originally `closest('a, div')`. Measured against `parentElement` and the
image itself, the first two behaved **identically** (80 hosts, 8 images lost to
collisions) — so the fix was not a better generic strategy but naming the tile directly.

### The `/cards/` trap

Do not match card links with `a[href*="/cards/"]`. Moxfield's card-image **download
buttons** point at:

```
https://assets.moxfield.net/cards/card-Lze8j-normal.jpg?327820734&download=true
```

That contains `/cards/` but is an image asset. Measured on the page inspected: **91
elements matched, of which only 13 were real card pages and 78 were image assets.**
Unguarded, the slug parser turned one into the card name `Lze8j normal.jpg`, which would
be sent to Scryfall and negative-cached. `cardPageSlug()` now requires a same-host
`/cards/<slug>` path with no image extension.

### Re-running the check

Paste [`tools/inspect-selectors.js`](tools/inspect-selectors.js) into the devtools
console on a deck page. It mirrors the production logic and prints
`badges: N injected / M expected`, naming any tile that is missing a badge and any badge
that landed somewhere it shouldn't. If `.img-card` or `.img-card-visual` ever drops to
zero, update `CARD_HOST_SELECTORS` / `CARD_TILE` in `src/moxfield-dom.js` — nothing else
should need to change.

## Known limitations

- **Visual Spoiler only.** Table and list views need a different injection strategy — a
  real sortable column means injecting a header cell plus every row, and fighting React's
  reconciliation. See *Roadmap*.
- **`User-Agent` is out of our hands — and Scryfall enforces it.** Scryfall now rejects
  requests carrying a default HTTP-library User-Agent with `HTTP 400 / rule:
  generic_user_agent`. Extensions *cannot* set that header — `User-Agent` is a
  [forbidden header name][forbidden] that `fetch()` silently refuses. **Verified
  2026-09-09:** a real Firefox UA is accepted (200), so the overlay works as-is, but
  the UA doesn't identify this app the way Scryfall would prefer. The proper fix, if it
  ever matters, is a `declarativeNetRequest` rule appending an app identifier. Do not
  "fix" this by hand-setting the header — it will be dropped.
- **Selector fragility.** Moxfield's class names are unversioned internal markup and can
  change on any deploy. This is the permanent maintenance cost of the project.
- **Sample hand and sidebar preview are skipped.** Moxfield's sample-hand widget renders
  all 7 images as direct children of one `div.samplehand` with no per-card wrapper, so
  every anchoring strategy collapses them onto a single badge. Badging them properly
  means injecting our own wrappers, which means fighting React's reconciliation. The
  sidebar preview is skipped for a different reason: it is a magnified duplicate of a
  grid tile that already carries its own badge, and for double-faced cards it holds two
  images whose alts are just `"Front"` and `"Back"`.
- **Rank only, not full EDHREC data.** Synergy %, per-commander inclusion rate, and salt
  score are *not* in Scryfall. They live behind `json.edhrec.com/pages`, which is
  undocumented, unofficial, keyless, Cloudflare-fronted, and can break without notice.
- **Name matching is imperfect.** Double-faced cards retry on the front face; tokens and
  unrecognized names get a negative cache entry and show `—`. Verified 2026-09-09: the
  full DFC name (`Fable of the Mirror-Breaker // Reflection of Kiki-Jiki`) is **not
  found** by Scryfall, while the front face alone resolves — so the retry is load-bearing,
  not defensive.

## Roadmap

- [x] Verify selectors against a live page
- [ ] Support table + list views
- [ ] Badge the sample-hand widget (needs injected per-card wrappers)
- [ ] **Sort a deck by EDHREC rank** — the real differentiator, since Moxfield won't
      build it natively
- [ ] Options page: tier thresholds, badge position, on/off toggle
- [ ] Optional bundled rank map built from [Scryfall bulk data][bulk] for instant,
      zero-network rendering (`oracle_id → edhrec_rank` is only a few hundred KB)
- [ ] Per-commander inclusion % via `json.edhrec.com` — one request per deck, joined by
      name. Fragile; keep it strictly opt-in.

## A note on scope and etiquette

This extension reads the page Moxfield has **already rendered** and calls **Scryfall**.
It does not touch Moxfield's own API. That distinction matters: Moxfield
[restricted API access in late 2024][moxtweet] after scraping abuse and asked legitimate
consumers to establish a relationship via their Discord. Keep it this way.

Scryfall [asks callers][limits] to cache for at least 24h and to use bulk data for large
lookups — both respected here.

Read [Moxfield's Terms][moxterms] before publishing this to AMO.

## License

MIT — see [LICENSE](LICENSE).

Unofficial Fan Content permitted under the Wizards of the Coast Fan Content Policy.
Not produced by or endorsed by Wizards of the Coast, Moxfield, EDHREC, or Scryfall.

[pricer]: https://addons.mozilla.org/en-US/firefox/addon/moxfield-card-pricer/
[linker]: https://addons.mozilla.org/en-US/firefox/addon/moxfield-to-scryfall-linker/
[lens]: https://fccmtgdev.github.io/collectionlens/
[nolt706]: https://moxfield.nolt.io/706
[cards]: https://scryfall.com/docs/api/cards
[limits]: https://scryfall.com/docs/api/rate-limits
[bulk]: https://scryfall.com/docs/api/bulk-data
[signing]: https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/
[moxtweet]: https://x.com/moxfieldmtg/status/1861599720142967082
[moxterms]: https://moxfield.com/help/terms

[forbidden]: https://developer.mozilla.org/en-US/docs/Glossary/Forbidden_request_header
