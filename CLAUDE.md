# Working on this project

A Firefox and Chrome MV3 extension that overlays EDHREC data onto Moxfield. The README
explains *what it does and why*; this file is *how to work on it without relearning the
traps*.

Almost everything below was discovered by something breaking. Where a rule looks
arbitrary, it is usually load-bearing — the reason is given so you can tell when it
stops applying.

## Commands

| | |
|---|---|
| `npm test` | Contract test for the Scryfall/EDHREC paths. **Hits live APIs on purpose.** |
| `npm run test:panel` | Unit tests — panel, tooltip, badges, storage — with a stubbed messenger, storage and fetch. Deterministic, headless, no network. |
| `npm run verify:autorun` | Loads the real built extension in a browser and checks 34 behaviours end to end. |
| `npm run verify` | DOM-adapter check across all six Moxfield view styles; screenshots to `.pw-shots/`. |
| `npm run lint` | `web-ext lint`. Keep it at **0 errors, 0 warnings**. |
| `npm run dev` | Launches Firefox with the extension loaded on a deck page. |
| `npm run build` / `npm run sign` | Package / sign for distribution. |

`verify:autorun` and `verify` need Playwright's Chromium:
`npm i -D playwright && npx playwright install chromium`.

## Architecture, and the one rule that shapes it

**Own your surfaces. Never inject into Moxfield's React-managed containers.**

Moxfield is a React SPA whose class names are build-hashed (`qqvQq_L4ZyNhF25VQaOA`) and
which re-renders on every view, sort and filter change. Anything we append inside its
own card sections gets reconciled away, and would need a separate strategy for each of
six view styles. So the tooltip and the drawer are single elements anchored to `<body>`.
Badges are the one exception — they must sit on the card — and they are re-added by a
MutationObserver when React removes them.

| File | Owns | Never |
|---|---|---|
| `src/moxfield-dom.js` | **Every Moxfield selector.** The only file that knows their markup. | Network, rendering |
| `src/content.js` | Badges, tooltips, the observer loop, the rank cache | Moxfield selectors, `fetch` |
| `src/panel.js` | The four-tab drawer. Owns no data — `content.js` feeds it. | Moxfield selectors |
| `src/background.js` | **All network.** Scryfall, EDHREC, Spellbook, every cache. | DOM |

Content scripts never `fetch`. Everything goes through `background.js` so a single
serial queue honours Scryfall's rate limit no matter how many tabs are open.

When a Moxfield deploy breaks the overlay, `moxfield-dom.js` should be the only file
that needs editing. If a fix needs to touch anything else, the abstraction has leaked —
fix that instead.

## Verifying a change

Two rules, both learned the hard way.

**Run headed.** Cloudflare blocks headless outright — you get *"Sorry, you have been
blocked"*, not the page. This also explains any "Moxfield never finishes loading"
symptom in automation; it is a block, not slowness.

**Do not assert on values that depend on deck contents.** `verify:autorun` asserted
that "High Synergy Cards" was the first Add section; it failed once the deck already ran
everything in that section, so the section vanished. Assert the *property* — curated
sections precede bulk ones — not the incidental value. The same mistake failed valid decks
twice more: the salt check demanded a top-100 salty card, and the commander check a
commander ranked under 2,000.

**Test against a deck nobody edits.** The rigs default to an official precon — Moxfield's
*"Official … Precon Decklist"* decks do not change. The previous default was a player's
deck that lost its commander, which quietly skipped every EDHREC check, so the rig now
fails outright when a deck has no commander.

**Any scroll hides the tooltip**, and the scroll event lands a frame after
`scrollIntoViewIfNeeded()` returns. Hovering straight after it made the tooltip checks
pass or fail with the page's scroll position; let the scroll settle first.

**Validate every regression test by reverting the fix and confirming it fails.** Two
tests in this repo passed against the very bug they were written for:

- the tooltip-preview test hovered the first combo row, which happened to be a card
  EDHREC *does* list, so it never exercised the missing-id path;
- the commander-exclusion test needed the specific commander to appear in the visible
  top 15.

A test that cannot fail is worse than no test, because it is believed.

`verify:autorun` loads the **shipped manifest, unmodified**, into Chromium: one manifest
serves both browsers (see Chrome below). It used to rewrite a Chromium-only copy, and that
rewrite drifting from the real manifest is how adding `icons` broke all 30 checks at once.
It still copies the extension's files into `.pw-ext/` — every file the manifest names, or
Chromium refuses to load it — so that what loads is what ships.

It also wipes its browser profile every run. That is deliberate: Chromium caches the
unpacked extension inside the profile and will silently serve a stale build. The cost is
that the rig never sees a stale *cache*, which is exactly how the `edhrec:v2` bug below
shipped green.

## Traps, by system

### Moxfield DOM

- **Anchor on the card id in element ids, never on class names.** The same card is
  `vd-Mxm76`, `id87-legal-Mxm76`, `id169-legal-Mxm76` or `id_r_1l_-Mxm76` depending on
  view; the classes on those elements are build-hashed. The card id is the final `-`
  segment (`CARD_ID_SUFFIX`), and it conveniently excludes the preview wrapper, whose
  React-generated suffix contains underscores.
- **`a[href*="/cards/"]` is a trap.** Moxfield's card-image *download buttons* point at
  `assets.moxfield.net/cards/card-Lze8j-normal.jpg`. On one page, 91 elements matched
  and only 13 were real card pages. Use `cardPageSlug()`.
- **Category headers reuse the row-link class.** `Creatures(4)` is an
  `a.table-deck-row-link` with no id. Requiring a card id filters them out.
- **There are six view styles**, not three: Text, Condensed Text, Visual Grid, Visual
  Stacks, Visual Stacks (Split), Visual Spoiler. `npm run verify` covers all six.
- **Laid out is not visible.** Visual Grid overlaps its rows (each card shows its top
  ~100px of 240) and Visual Stacks show a ~40px strip, so a badge can be present, sized
  and `offsetParent`-visible while sitting under the next card. Bottom-left badges were
  hidden on three Grid cards in four, and every check passed. The adapter marks full
  cards (taller than wide) so their badge sits a quarter of the way down; strips keep
  the bottom corner. Not a fifth: Moxfield's hover menu button covers 25–50px of a
  240px card, and at 48px it came up over the badge and took the pointer. Judge
  visibility with `elementFromPoint`, and only count a badge hidden when another
  *card* is on top: Stacks lay a transparent layer over the strips, which hit-testing
  reports as covering badges you can plainly see.
- **The hover preview swaps cards in place** rather than remounting, so it needs the
  live path and an `attributes` observer. It gets a fast path that skips the debounce;
  routing it through the normal scan made it visibly lag the pointer.
- **Moxfield marks Game Changers itself** — but only on text rows, with a
  `.fa-gauge[id*="-brackets-"]` icon. Ours fills the gap in the visual views. Match on
  the icon class too: visual views carry a *different* element with the same id pattern.
  And judge it **per host, never per card id**: the sideboard stays a text list in the
  visual views, so one card can carry Moxfield's icon on its sideboard row and nothing
  on its mainboard tile.

### Scryfall

- **Never send a combined `A // B` name.** Every multi-face layout — split, adventure,
  modal DFC, transform — comes back `not_found`. Always ask for the front face.
- **A front-face query answers with the FULL name.** Ask for `Malakir Rebirth`, get back
  `Malakir Rebirth // Malakir Mire`. Index responses under the full name, every face
  name, and the front-face split, or you cannot match the reply to the request.
- **Flavor names need the search fallback.** Moxfield shows *Valley Farmstead*;
  `/cards/collection` matches only real names. `/cards/search?q=!"…"` matches flavor
  names and rescues them.
- **Default User-Agents are rejected** with `HTTP 400 / generic_user_agent`. Extensions
  *cannot* set that header — it is a forbidden header name. Firefox's and Chrome's own UAs
  are accepted, so this works, but do not "fix" it by adding the header.
- **One malformed `id` 400s the entire batch**, not just that identifier. Validate UUIDs
  before sending.
- **Prices need the cheapest printing, resolved by name.** EDHREC ids point at arbitrary
  printings — its Volcanic Island is Beta, with no USD price and a €10,577 EUR one. Even
  by name, Scryfall's default printing can be an MTGO-only set. Batch by name, then fall
  back to a print search ordered by price.

### Card names, everywhere

**Moxfield displays FLAVOR names; every third-party service keys on real ones.**
"Power Sneakers" is Lightning Greaves, "Valley Farmstead" is Yavimaya, Cradle of Growth
— 476 cards on Scryfall carry one, including staples like Dark Ritual.

Comparing display names against those services makes a card you own look absent, in
every view at once: it stays in Add, drops into "not in EDHREC's lists" under Cuts,
reads as a difference from the average, loses its lift and synergy, and — the visible
symptom — gets reported as a combo piece you still need. Spellbook's card database does
not know flavor names at all; a lookup returns no match.

So the rank lookup returns the card's real `name`, `content.js` exposes `canonicalOf()`,
and **everything that compares or is sent outbound uses the canonical name**. Display
names are for display only: badge text, badge links, panel row labels.

That includes the **commander's** name, which escaped the rule until a reskinned one
turned up (the Hatsune Miku precon's Trostani displays as "Miku, Song of the People").
EDHREC answers flavor-name slugs but titles the page with the flavor name, so nothing
errors — the commander just never matches, keeps its card rank, and reaches Spellbook
under a name it does not know. It is resolved before EDHREC is asked, because that
happens before the first rank lookup has filled `rankCache`.

Moxfield is not even consistent within a deck: text rows show the flavor name, but in the
visual views an image's `alt` carries the real one. So a bug of this kind shows up in some
views and not others.

### EDHREC (`json.edhrec.com`)

Unofficial and undocumented — the project's one fragile dependency. No key, no
Cloudflare, but free to change. Every failure is swallowed and the overlay degrades to
rank-only. Never `await` it on the badge-render path.

- One request per **deck** buys lift, synergy, inclusion and list tags for ~270 cards.
- **EDHREC renames things without notice, and nothing errors.** On 2026-10-01 it
  replaced synergy with lift and renamed "High Synergy Cards" to "High Lift Cards". The
  drawer matches curated lists by exact header, so its most useful section silently
  collapsed to zero rows. List names live in `CURATED` (`panel.js`), `NOTABLE_LISTS`
  (`content.js`) and `verify-autorun.mjs`'s own copy — change all three, and extend
  `tools/test-lift.mjs`.
- **Lift = inclusion ÷ (inclusion − synergy).** The background derives whichever figure
  EDHREC stops sending from the other. `npm test` checks the identity against the live
  API, so a redefined lift fails the weekly contract run instead of quietly skewing
  every derived number.
- **A commander's rank is not its rank as a card.** `container.json_dict.card.rank` is
  the commander rank (Bria #240); Scryfall's `edhrec_rank` is the card rank (#3,058).
  Use `infoFor()`, which is the single place that decides.

### Commander Spellbook

`POST /find-my-combos/` takes `{commanders:[{card}], main:[{card}]}` — bare strings are
rejected. Only combos missing exactly one card are shown. Recompute `missing` locally
against the deck actually sent rather than trusting the reply.

### Deck switching

Moxfield routes client-side, so moving between decks does **not** reload the content
script. Anything held per-deck has to be invalidated by hand, and the tab that is *not*
currently open is where that goes wrong — it renders on next open, from whatever it was
last given.

- Key per-deck caches on the deck's own path. Commander plus card count collides
  between two different decks for the same commander with the same size.
- **Clear** stale data as well as refetching it. Refetch alone leaves a window where the
  previous deck's answer is on screen, and `tools/test-panel-deckswitch.mjs` deliberately
  slows its stub to keep that window open — an instant stub hides the bug behind its own
  replacement.

### Caching

- **Bumping a version means changing its VALUE, not the identifier.** Splitting
  `EDHREC_VERSION` out of `CACHE_VERSION` while keeping `'v2'` left the key byte-identical.
  Nothing was invalidated, the panel silently rendered nothing, and every test passed
  because the rig wipes its profile.
- **Shape-check reads as well as versions**, so a fumbled bump cannot serve garbage.
- Every family (`rank:`, `edhrec:`, `salt:`, `price:`, `combos:`, `average:`) must be
  registered in `purgeStaleCache()`, with its TTL. That sweep is the only thing that ever
  deletes an entry: reads skip expired ones but do not remove them.
- **A cache write must never fail a lookup.** Route every write through `cacheWrite()`.
  The answer is already in hand when it is cached; a rejected write used to reject the
  lookup itself, and a failed EDHREC or salt write threw away data just fetched.
- TTLs encode upstream reality: ranks 7 days, prices 24h (Scryfall updates daily),
  EDHREC 24h, salt 7 days.

### Chrome

Everything above runs in Chrome unchanged; these are the differences that bite.

- **One manifest, both background keys.** Firefox runs `background.scripts`, Chrome runs
  `background.service_worker` and has ignored `scripts` beside it since 121 (hence
  `minimum_chrome_version`). `"preferred_environment": ["document"]` is what keeps
  `web-ext lint` at 0 warnings about the pair — and only from web-ext 9.3. Chrome also
  ignores `browser_specific_settings`, so there is no separate Chrome build.
- **storage.local is capped at 10 MB in Chrome** unless the manifest asks for
  `unlimitedStorage`, which it does (no install warning in either browser). Firefox has no
  cap, which is why running out only ever happened in Chrome — and why the expiry sweep
  and non-fatal writes above matter even with the permission.
- **Detect the API with `browser?.runtime`, never `browser ?? chrome`.** Chrome had no
  `browser` object before 148, and a page element with `id="browser"` is reachable as
  `globalThis.browser` from a content script.
- **The background is a service worker**, stopped after 30s idle and restarted on the next
  message. In-memory state — the Scryfall queue — is lost then, which is harmless: an open
  `sendMessage` reply keeps the worker alive until it is answered, for up to 5 minutes.
- **Branded Chrome ignores `--load-extension`** since 137. `web-ext run -t chromium` loads
  through the DevTools protocol instead; the Playwright rigs use Playwright's own Chromium,
  which still accepts the flag.

## Publishing

Signing is mandatory even for private use. Credentials go in **`~/.web-ext-config.cjs`**
— the home directory, dot-prefixed. The repo is public and the working-directory
`web-ext-config.cjs` is tracked; the two differ only by a leading dot.

**web-ext must be 9 or newer.** Node 24 gives an imported `.cjs` file an extra
`'module.exports'` named export, and web-ext 8 reads every export as an option. So every
command — `lint`, `build`, `run`, `sign` — dies at startup with *The config option
"module.exports" must be specified in camel case*, before it looks at the extension at
all. web-ext 9.0.0 drops that key. Keep both configs `.cjs` (or `.mjs`): 9.0.0 also
stopped accepting `.js`.

Bump `version` in `manifest.json` before every re-sign — AMO rejects a version it has
seen. Unlisted add-ons do not auto-update without an `update_url`.

`data_collection_permissions` is `["websiteContent"]`, not `none`: card names leave the
browser for three third-party APIs, which is exactly what that category covers.

## Do not

- **Touch Moxfield's API.** The extension reads the rendered page and calls Scryfall,
  EDHREC and Spellbook. Moxfield restricted API access in 2024 after scraping abuse;
  staying read-only is what keeps this defensible. It is also why the drawer's action is
  *Copy as list* rather than adding cards directly.
- **Commit secrets.** The repo is public. A committed secret is not fixed by deleting
  the commit — revoke and regenerate it.
- **Use `innerHTML`.** Card names come off the page and out of third-party APIs.
  `textContent` throughout.
- **Add a dependency without a reason.** The extension itself has zero runtime
  dependencies and should stay that way; `playwright` and `web-ext` are dev-only.
