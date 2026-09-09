# Moxfield EDHREC Overlay

A Firefox extension that badges every card on a Moxfield page with its **EDHREC rank**.

Nothing like this appeared to exist when this repo was started (2026-09-09). The closest
neighbors — [Moxfield Card Pricer][pricer], [Moxfield to Scryfall Linker][linker],
[MTG Collection Lens][lens] — either overlay prices, or overlay collection data onto
*other* sites. Moxfield users have an open feature request for native
[EDHREC rank on the deck page][nolt706] that has not shipped.

## How it works

The badge face is a rank, from Scryfall. Everything else lives in a styled tooltip:

```
┌──────────────────────────────────────┐
│ Ral, Crackling Wit             #2,209│
├──────────────────────────────────────┤
│ Synergy                        +58.8%│   ← green; red when negative
│ vs. decks that could play it         │
│ Played in                       70.0%│
│ ████████████████░░░░░░░              │
│ 7,013 of 10,014 decks                │
│ ( High Synergy Cards )               │
├──────────────────────────────────────┤
│ Bria, Riptide Rogue · click to open  │
└──────────────────────────────────────┘
```

It replaces the native `title` tooltip, which is OS-rendered: about a second before it
appears, no structure, and no way to make a negative synergy read differently from a
positive one. One shared element lives on `<body>` and is repositioned per hover —
per-badge listeners would mean thousands being attached and torn down as React
reconciles the deck, so the tooltip delegates from the document and the badges stay
inert. It is `pointer-events: none` so it can never swallow a click meant for a card,
flips below the badge when there is no room above, and clamps to the viewport.

`title` is removed rather than kept as a fallback: both would show, and the OS one wins
the first second. The same content goes to `aria-label`, so it stays available to screen
readers, and the tooltip is keyboard-reachable via focus.

The tooltip also **backfills its own data**. Every path that creates a badge resolves the
rank first, so a cache miss at hover time should be impossible — but "should be
impossible" is exactly what produces a tooltip reading `unranked` until you hover it a
second time. Rather than trust the invariant, a miss triggers a lookup and repaints the
tooltip, and repairs the badge face in place. (Note that a plain rescan would *not* fix
the badge: `findTargets()` skips hosts already marked done.)

The rank comes from Scryfall's card object:

> `edhrec_rank` · Integer · Nullable — "This card's overall rank/popularity on EDHREC.
> Not all cards are ranked." — [Scryfall Card Objects][cards]

So the whole data path is one well-documented, CORS-friendly, officially-supported API.

```
content.js ──▶ background.js ──▶ POST api.scryfall.com/cards/collection
   │               │                  (≤75 names/request, 2 req/sec)
   │               ├──▶ json.edhrec.com/pages/commanders/<slug>.json
   │               │        one request per DECK, ~270 cards, 24h cache
   │               ├──▶ json.edhrec.com/pages/top/salt.json
   │               │        one request ever, 7-day cache
   │               └──▶ storage.local cache, 7-day TTL
   └──◀ ranks + edhrec ──┘
```

A 100-card Commander deck is **two requests, ~1 second**, then nothing until the cache
expires. Cache keys carry a version (`rank:v2:`, `edhrec:v3:`); bumping one retires
entries whose values a fix has invalidated, and superseded entries in every family are
purged on startup.

**Bumping a version means changing the value, not the identifier.** Splitting the EDHREC
version out of `CACHE_VERSION` while keeping the value `v2` left the key byte-identical,
so nothing was invalidated: browsers kept serving the previous payload shape, the
recommendations panel saw no lists and never rendered, and synergy vanished from
tooltips — while a wiped test profile passed every check. Reads are now shape-checked as
well as version-checked, so a fumbled bump cannot serve garbage, and
`tools/test-lookup.mjs` primes a stale entry to prove it. All Moxfield tabs share one queue and one cache in the background script, so
the rate limit holds no matter how many tabs are open.

The badge also surfaces Scryfall's `game_changer` flag (the Commander Game Changer list)
as a gold ring, and links out to the card's EDHREC page.

It sits in the **bottom-left** of the card. The top-right is the mana cost, which is the
one thing you most need to read at a glance; the bottom-left is the set-symbol area and
the cheapest thing to cover.

### EDHREC data

Scryfall gives a card's *global* rank. Everything context-dependent lives on EDHREC, and
one request per **deck** buys all of it:

| | |
|---|---|
| Synergy | inclusion-with-this-commander minus inclusion-everywhere |
| Inclusion | `In 16.7% of those decks (1,674 of 10,014)` |
| List tags | High Synergy, Top Cards, Game Changers, New Cards |
| Salt | from the global top-100 list |

Synergy is the field a rank cannot express. Arcane Signet is **+2.9%** with Alania and
**−0.2%** with Atraxa: played constantly, but it says nothing about either deck. A card
at +71% is one that basically only exists for that commander.

The commander is found from the `Commander (N)` group heading, falling back to the
server-rendered `og:description` (*"A Commander deck featuring Bria, Riptide Rogue
by…"*). Commander slugs are derived and verified against the live API for 10 commanders,
including possessives, leading articles and a double-faced commander.

**This is the one fragile dependency in the project.** `json.edhrec.com` is what
edhrec.com's own frontend calls — no key, no Cloudflare, but undocumented and free to
change, unlike Scryfall. So every EDHREC failure is swallowed, the fetch is never awaited
by the badge render, and the overlay degrades to rank-only. Cards EDHREC does not list
for your commander simply show no synergy line: 49 of 70 badges carried one on the deck
last measured.

### Recommendations panel

A right-edge drawer listing EDHREC cards for your commander that the deck does not
already run, opened from a tab that shows the count.

It is anchored to `<body>`, **not** injected into Moxfield's own card sections. Appending
"ghost" cards into the Creatures/Instants containers would mean fighting React
reconciliation in three different layouts keyed off build-hashed class names; a surface
we own is untouched by all of it and behaves identically in all six view styles. Same
reasoning as the tooltip.

**Curated first, bulk collapsed.** EDHREC returns ~265 recommendations against a 67-card
deck, so ~216 are "missing" — unusable as a flat list. High Synergy, Top Cards, Game
Changers and New Cards (14 rows on the deck measured) are open by default; the type lists
sit behind *Show all 41*. The header states `Showing 14 of 216` so the collapsed ones are
not a mystery.

**Sorted by synergy, not rank**, for the reason the whole EDHREC section exists: rank says
"popular everywhere", synergy says "belongs in this deck". *Played in* is the alternate.

**It ends in something you can use.** We never write to Moxfield's API, so the honest
action is checkboxes plus *Copy as list*, which produces `1 Card Name` lines to paste into
Moxfield's own bulk import.

Rows show synergy, inclusion and a bar, and hovering one previews the card — the EDHREC
cardview `id` turns out to be a **Scryfall card id**, so images come straight from
`cards.scryfall.io` with no extra API call. Moxfield sets no `img-src` CSP, so they load
directly; this was checked before building rather than after.

**The correctness risk is filtering.** "Not in this deck" is computed by subtracting what
is on the page, so an active filter would make the panel recommend cards you already run.
Moxfield states its own total (`67 main deck`), which matched our enumeration exactly on
an unfiltered page; when the two disagree the panel says so instead of lying.
`verify-autorun.mjs` asserts that nothing listed is already in the deck.

### Game Changers: don't say it twice

Moxfield marks game changers itself — but only in some views. Measured across all six:

| View | Moxfield's per-card icon | Ours |
|---|---|---|
| Text, Condensed Text | `fal fa-gauge`, present | suppressed |
| Visual Grid / Stacks / Split / Spoiler | **absent** | gold ring |

So the ring fills a real gap rather than duplicating: it appears exactly where Moxfield
shows nothing, which is also where the cards are largest. Moxfield's icon also carries
`d-none d-md-inline`, so it vanishes on narrow screens — hence the check is on actual
visibility, not mere presence.

One trap worth knowing: matching the marker by its id pattern alone is wrong. Visual
views carry a *different* element sharing the same `-brackets-<cardId>` id — a
`companion-container cursor-pointer` tile wrapper, not an icon — and matching on the id
suppressed our ring in precisely the views that needed it. The selector requires the
`.fa-gauge` class for that reason. `verify-autorun.mjs` asserts the two markers are
never both present.

### The hover preview

The large card preview on the left is badged too, but it cannot use the same path as the
grid. React swaps the image in place rather than remounting the wrapper, so a badge
marked done would go stale and keep reporting the first card you hovered. It is instead
re-derived on every pass, and the MutationObserver watches `src`/`alt` attributes so a
hover actually triggers one.

Hovering has its own fast path, because routing it through the normal scan made the
badge visibly lag the pointer. That route had a 300ms debounce as a hard floor, and on
top of it ran a whole-page `findTargets()`, a `querySelectorAll('[id]')` across the
entire document to rebuild the id->name index, and an async round trip to the background
for a rank it had already fetched. Now: preview mutations skip the debounce entirely, the
id->name index is memoized and only rebuilt on structural change, and the content script
keeps its own synchronous rank cache so an already-seen card repaints in the same task as
the mutation. Measured over successive hovers: **31-34ms**.

Double-faced previews are a further wrinkle: their images are labelled `"Front"`,
`"Back"` and `"Transform"` rather than with the card name. For those, the Moxfield card
id is read out of the image URL (`card-Lze8j-normal.jpg` → `Lze8j`) and resolved against
an id→name index harvested from the page, where the same id appears both as a
`vd-<id>` grid tile and in `/cards/<id>-…` links.

### Files

| File | Role |
|---|---|
| `src/moxfield-dom.js` | **All Moxfield-specific selectors.** The one file to fix when a deploy breaks things. |
| `src/content.js` | MutationObserver loop, badge construction, injection |
| `src/background.js` | Scryfall batching, rate limiting, persistent cache |
| `src/panel.js` | Recommendations drawer — owns no data, `content.js` feeds it |
| `src/badge.css` | Badge, tooltip and panel styling, scoped to `.edhrec-*` |
| `tools/test-lookup.mjs` | Contract test for the Scryfall path — `node tools/test-lookup.mjs` |
| `tools/verify-live.mjs` | Drives a real browser over all six view styles, screenshots each |
| `tools/verify-autorun.mjs` | Loads the built extension and proves it badges unaided — `npm run verify:autorun` |

### Multi-face cards

Every multi-face layout — modal DFC, transform, split, adventure — needs two things
right, and getting either wrong makes the card silently read as unranked.

**Ask for the front face.** Scryfall's `name` identifier does not accept the combined
`A // B` form at all. Verified 2026-09-09: `Fire // Ice`, `Bonecrusher Giant // Stomp`
and `Malakir Rebirth // Malakir Mire` all came back `not_found`, while the front face
alone resolved every one.

**Index the reply under every alias.** A front-face query answers with the card's *full*
name — ask for `Malakir Rebirth`, get back `Malakir Rebirth // Malakir Mire`. A response
map keyed only on `card.name` therefore fails to match the very request that produced
it. `indexCards()` registers each card under its full name, each face name, and the
front-face split, with full names indexed first so a real card always beats another
card's face.

`tools/test-lookup.mjs` covers all four layouts in both spellings.

## Install (temporary, for development)

Requires **Firefox 140+** (142+ on Android) — that's the floor for the
`data_collection_permissions` manifest key AMO now requires. This extension declares
`"none"`; it stores only a Scryfall rank cache locally and sends nothing anywhere.

```bash
npm run dev
```

That launches Firefox with the extension loaded and opens a deck. Or load it by hand at
`about:debugging#/runtime/this-firefox` -> **Load Temporary Add-on...** -> pick
`manifest.json`.

**Badges appear on their own.** There is no script to run and no button to press: the
content script matches every `moxfield.com` page and badges the deck as it renders.
Verified end to end by `npm run verify:autorun`, which loads the built extension and
waits for badges without injecting anything - most recently **31 badges, all ranked,
~1.8s after navigation**, and still 31 after routing away and back through Moxfield's
client-side router.

If badges stop appearing entirely, suspect the install before the code: **Firefox
removes temporary add-ons on restart**, so a browser restart silently leaves you with
no extension. Permanent installation needs [signing through AMO][signing].

## Verifying against a live page

`tools/verify-live.mjs` drives a real browser at a real deck, injects
`src/moxfield-dom.js` and `src/badge.css`, paints a badge on everything
`findTargets()` returns, and screenshots all six view styles into `.pw-shots/`.

```bash
npm i -D playwright && npx playwright install chromium
node tools/verify-live.mjs [deckUrl]
```

**Cloudflare blocks headless outright** — a headless request gets *"Sorry, you have
been blocked"* rather than the page — so this runs **headed** with a persistent
profile and a browser window will open. That block is also why an automated browser
appeared to hang on `"Loading Moxfield…"` during early development; it was never
slowness.

The extension is not loaded in that run, which is fine: this verifies the DOM adapter,
the fragile half. The Scryfall half is covered by `tools/test-lookup.mjs`.

Last full run — 27-card deck, all six styles, zero duplicate hosts, zero nested anchors,
every badge visible:

| View style | image | row | preview |
|---|---:|---:|---:|
| Text | 0 | 29 | 2 |
| Condensed Text | 0 | 29 | 2 |
| Visual Grid | 27 | 2 | 2 |
| Visual Stacks | 27 | 2 | 2 |
| Visual Stacks (Split) | 27 | 2 | 2 |
| Visual Spoiler | 27 | 2 | 2 |

### Anchor on the id, not the class

The card's own id is the last `-` segment of the element id, in every view:

```
vd-Mxm76              Visual Grid / Visual Spoiler
id87-legal-Mxm76      Visual Stacks
id169-legal-Mxm76     Visual Stacks (Split)
id_r_1l_-Mxm76        Text / Condensed Text row link
deckviewimage-_r_os_  preview wrapper - correctly NOT a match
```

The classes on those same elements are hashed CSS-module names
(`qqvQq_L4ZyNhF25VQaOA`, `XIi4jFys2lGhYwseGpBo`) that change on every Moxfield build.
The id pattern held across all six styles and excludes the preview for free, since
React's generated suffixes carry underscores.

It also settles a false positive: category headers (`Creatures(4)`) reuse the
`table-deck-row-link` class but carry no id at all, so requiring a card id filters
them out.

### The `/cards/` trap

Do not match card links with `a[href*="/cards/"]`. Moxfield's card-image **download
buttons** point at
`https://assets.moxfield.net/cards/card-Lze8j-normal.jpg?...&download=true`, which
contains `/cards/` but is an image asset. Measured on a live page: **91 elements
matched, only 13 were real card pages, 78 were download links.** Unguarded, the slug
parser turned one into the card name `Lze8j normal.jpg`. `cardPageSlug()` requires a
same-host `/cards/<slug>` path with no image extension.

## Known limitations

- **Rows wrap in narrow columns.** In text views the inline badge adds width, which
  pushes some longer card names onto a second line. The inline badge is deliberately
  smaller than the card badge to limit this.
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
  images whose alts are just `"Front"` and `"Back"`. The preview is no longer skipped —
  it has its own live path — but the sample hand still is.
- **Rank only, not full EDHREC data.** Synergy %, per-commander inclusion rate, and salt
  score are *not* in Scryfall. They live behind `json.edhrec.com/pages`, which is
  undocumented, unofficial, keyless, Cloudflare-fronted, and can break without notice.
- **Unrecognized names show `—`.** Tokens and bad reads get a negative cache entry so
  they stop being re-requested. Genuine unranked cards (basic lands) also show `—`.

## Roadmap

- [x] Verify selectors against a live page
- [x] Badge the hover preview on the left
- [x] Support all six view styles
- [ ] Badge the sample-hand widget (needs injected per-card wrappers)
- [ ] **Sort a deck by EDHREC rank** — the real differentiator, since Moxfield won't
      build it natively
- [ ] Optional bundled rank map built from [Scryfall bulk data][bulk] for instant,
      zero-network rendering (`oracle_id → edhrec_rank` is only a few hundred KB)
- [x] Per-commander synergy, inclusion, list tags and salt via `json.edhrec.com`
- [x] Show EDHREC recommendations not yet in the deck
- [ ] Options page: tier thresholds, badge position, toggle EDHREC enrichment off

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
