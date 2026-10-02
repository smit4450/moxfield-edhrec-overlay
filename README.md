# Moxfield EDHREC Overlay

A Firefox extension that badges every card on a Moxfield page with its **EDHREC rank**.

Nothing like this appeared to exist when this repo was started (2026-09-09). The closest
neighbors — [Moxfield Card Pricer][pricer], [Moxfield to Scryfall Linker][linker],
[MTG Collection Lens][lens] — either overlay prices, or overlay collection data onto
*other* sites. Moxfield users have an open feature request for native
[EDHREC rank on the deck page][nolt706] that has not shipped.

Working on it? **[CLAUDE.md](CLAUDE.md)** is the guide for contributors and coding
agents: architecture rules, the verification workflow, and the traps in each third-party
API — most of which were found by something breaking.

## How it works

The badge face is a rank, from Scryfall. Everything else lives in a styled tooltip:

```
┌──────────────────────────────────────┐
│ Ral, Crackling Wit             #2,209│
├──────────────────────────────────────┤
│ Lift                             6.2x│   ← green above 1x; red below
│ vs. decks that could play it         │
│ Synergy                        +58.8%│
│ Played in                       70.0%│
│ ████████████████░░░░░░░              │
│ 7,013 of 10,014 decks                │
│ ( High Lift Cards )                  │
├──────────────────────────────────────┤
│ Bria, Riptide Rogue · click to open  │
└──────────────────────────────────────┘
```

It replaces the native `title` tooltip, which is OS-rendered: about a second before it
appears, no structure, and no way to make a low lift read differently from a high
one. One shared element lives on `<body>` and is repositioned per hover —
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
expires. Cache keys carry a version (`rank:v2:`, `edhrec:v3:`, `price:v2:`); bumping one retires
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
| Lift | inclusion-with-this-commander divided by inclusion in every deck that could play it |
| Synergy | the same comparison as a difference; EDHREC's figure until 2026-10-01 |
| Inclusion | `In 16.7% of those decks (1,674 of 10,014)` |
| List tags | High Lift, Top Cards, Game Changers, New Cards |
| Salt | from the global top-100 list |

### Flavor names

Moxfield displays a card's **flavor name** where it has one — *Valley Farmstead* rather
than *Yavimaya, Cradle of Growth* — and Scryfall's `name` identifier matches only real
names:

```
/cards/collection {name:"Valley Farmstead"}  →  not_found
/cards/search ?q=!"Valley Farmstead"         →  Yavimaya, Cradle of Growth  (rank 77)
```

So every Universes Beyond reskin came back not_found and rendered as unranked — and,
worse, the miss was *negative-cached*, so it stayed unranked for a week. Scryfall's
search does match flavor names, so a name the collection endpoint rejects is now chased
with an exact search before any negative is written. Bounded per call, since each miss
costs a request; tokens still resolve to nothing and are cached as such.

Prices were already fine here by accident: their fallback path uses search, which
matches flavor names for free.

### Commanders get their commander rank

Scryfall's `edhrec_rank` answers *"how often is this card played in any deck"*. For a
commander the useful question is *"how often is it played **as** the commander"*, and
that is a different number:

| | as a card | as a commander |
|---|---:|---:|
| Bria, Riptide Rogue | #3,058 | **#240** |
| Atraxa, Praetors' Voice | — | **#4** |
| The Ur-Dragon | — | **#2** |

Showing the card rank on a commander's own deck page is technically true and practically
useless. The commander rank comes from `container.json_dict.card.rank` on the commander
page we already fetch, so it costs nothing extra, and the tooltip says *Commander rank*
rather than *EDHREC rank* so the two are never confused. It also reports how many decks
run it as their commander.

Partner and background pairings share one EDHREC page; whichever commander that page
describes gets the commander rank, and the other falls back to its card rank.

Lift is the field a rank cannot express. It divides how often a card is played with your
commander by how often it is played in every deck that could run it, so 1x is neutral.
Sol Ring is **1.0x** with Xyris, the Writhing Storm: in 82% of those decks, and saying
nothing about any of them. Orcrist, Goblin-cleaver is **9.4x**: in only 5.7% of Xyris
decks, but over nine times as often as anywhere else.

EDHREC [replaced synergy with lift][lift] on 2026-10-01. Synergy is the same comparison as
a difference (Orcrist is +5.1%), so it is largest for cards that are common everywhere,
and staples crowd both ends of a synergy ranking. The tooltip shows both; the drawer ranks
by lift. EDHREC still sends both figures, and the background derives whichever one it
stops sending from the other, since lift = inclusion ÷ (inclusion − synergy) — an
identity `npm test` checks against the live API.

The commander is found from the `Commander (N)` group heading, falling back to the
server-rendered `og:description` (*"A Commander deck featuring Bria, Riptide Rogue
by…"*). Commander slugs are derived and verified against the live API for 10 commanders,
including possessives, leading articles and a double-faced commander.

**This is the one fragile dependency in the project.** `json.edhrec.com` is what
edhrec.com's own frontend calls — no key, no Cloudflare, but undocumented and free to
change, unlike Scryfall. So every EDHREC failure is swallowed, the fetch is never awaited
by the badge render, and the overlay degrades to rank-only. Cards EDHREC does not list
for your commander simply show no lift or synergy line: 49 of 70 badges carried one on
the deck last measured.

### Recommendations panel

A right-edge drawer listing EDHREC cards for your commander that the deck does not
already run, opened from a tab that shows the count.

It is anchored to `<body>`, **not** injected into Moxfield's own card sections. Appending
"ghost" cards into the Creatures/Instants containers would mean fighting React
reconciliation in three different layouts keyed off build-hashed class names; a surface
we own is untouched by all of it and behaves identically in all six view styles. Same
reasoning as the tooltip.

**Curated first, bulk collapsed.** EDHREC returns ~265 recommendations against a 67-card
deck, so ~216 are "missing" — unusable as a flat list. High Lift, Top Cards, Game
Changers and New Cards (14 rows on the deck measured) are open by default; the type lists
sit behind *Show all 41*. The header states `Showing 14 of 216` so the collapsed ones are
not a mystery.

Curated lists are matched by exact header, so a rename demotes one silently. When EDHREC
renamed *High Synergy Cards* to *High Lift Cards*, the drawer's most useful section
collapsed to zero rows and dropped below the other three, with no error anywhere.
`tools/test-lift.mjs` now pins both names.

**Sorted by lift, not rank**, for the reason the whole EDHREC section exists: rank says
"popular everywhere", lift says "belongs in this deck". *Synergy*, *Played in* and *Price*
are the alternates; unpriced cards sort last rather than masquerading as free.

**Prices, because "should I add this" is a budget question.** Each row shows its USD
price in a right-hand column, and the footer totals the selection — *Copy 3 as list ·
$76.47*. Fetched **lazily for the rows actually on screen**: opening the drawer costs one
request, expanding a type list costs one more, and a session that expands nothing never
pays for the other 200. Cached 24h rather than the ranks' week, since Scryfall updates
prices daily.

Prices run over seven bands, because card prices span four orders of magnitude and one
"expensive" colour puts a $20 card and a $1,600 card in the same bucket:

| | | | | | | |
|---|---|---|---|---|---|---|
| `<$1` | `$1–5` | `$5–20` | `$20–50` | `$50–100` | `$100–500` | `$500+` |
| dim | slate | neutral | amber | orange | red | red pill |

The ramp runs dim → neutral → warm → hot rather than green → red: green already means
a high lift one column to the left, and a cheap card should recede rather than
compete for attention. The top band gets a tinted pill because two shades of red at
different weights were not separable at a glance.

### Cuts: the deck, worst first

The drawer has two tabs. **Add** is the recommendations above; **Cuts** is your own deck
sorted worst-first, with rank, lift, salt and price on each row.

This answers Moxfield's most-requested EDHREC feature —
[sort cards by EDHREC rank][nolt706], **53 votes, open three years** — whose author
explains the real goal: *"would help a lot in getting rid of cards that aren't useful
when trying to trim your deck"*. The ask is phrased as sorting, but the goal is finding
cuts, so rather than reorder Moxfield's React-managed list we give the same answer in a
surface we own.

The commander is excluded — you cannot cut it — and so is the second commander of a
partner or background pairing.

Two sections, deliberately not merged:

- **Lowest lift** — played least often with your commander, relative to every deck that
  could play it.
- **Not in EDHREC's lists** — EDHREC does not list these for this commander at all.

"Nobody plays this with your commander" is a different statement from "this has low
lift", and conflating them buries every pet card in with the genuine duds.

Ranked by lift rather than synergy because synergy is a difference: the biggest gaps
belong to staples, whose base rates are largest, so they would top the list. A staple
played as often here as anywhere sits at 1.0x however popular it is.

The header also totals **deck salt**, which is
[the second-most-requested EDHREC feature][nolt304] (43 votes): *"a salt sum calculator
with a list of the salty cards in a given deck"*. Only EDHREC's global top-100 saltiest
can contribute, and the label says so — a total that silently ignored most of the card
pool would be worse than showing none.

### Combos, via Commander Spellbook

The **Combos** tab answers the question rank and lift cannot: *what does this card
turn on?*

[Commander Spellbook][spellbook] is open, needs no key, and takes
`{commanders: [{card}], main: [{card}]}` — bare strings are rejected. One request per
deck returns combos already assembled and, more usefully, the ones a **single card**
away:

```
Niv-Mizzet, Parun    -6.9%  18.5%   $5.70
  Curiosity + Niv-Mizzet, Parun
  ( Infinite draw triggers ) ( Infinite card draw ) ( Near-infinite damage )
```

The missing card is rendered as an ordinary recommendation row, so it prices, previews
and copies like anything else in the Add tab.

Card images need a Scryfall id, and EDHREC supplies one only for cards it lists for your
commander — which most combo pieces are not. On the deck measured, **10 of 15** combo
rows fell into that gap and showed no preview at all. The id now travels back with the
price, which resolves those cards by name anyway, so it costs no extra request. The
fallback search also keeps the first printing when a card has no price anywhere: an
unpriced card still deserves its image. Only combos missing exactly one card are
shown — "you are five cards from this" is not a suggestion. Its `missing` list is
recomputed locally against the deck we sent rather than trusted from the reply, so it
always agrees with what is actually on the page.

Only a distilled form is cached: the raw reply runs to hundreds of KB, while all the
panel needs is the cards, what they produce, and how popular the line is. The cache key
is a hash of the decklist, so editing the deck invalidates it.

### Versus the average list

The **Avg** tab answers [Moxfield's 31-vote request][nolt466] to compare a deck against
EDHREC's average decklist, and shows both directions:

> **25** of EDHREC's 80-card average list are in your deck
> · In the average, not yours — 55 · Yours, not in the average — 42

The second direction is the interesting one, and the reason this is not just the Add tab
again: it is what makes the list yours rather than everyone's.

The commander is excluded here too. EDHREC keeps it out of the average's card list
entirely, so leaving it in ours would report it forever as a card the average does not
run.

### Pricing the printing you would actually buy

The obvious implementation is wrong, and quietly so. Asking Scryfall for the id EDHREC
supplies prices **an arbitrary printing**: its Volcanic Island is Limited Edition Beta,
which has no USD price at all and a EUR price of €10,577. Its Island, Mountain and Steam
Vents are a promo set with no prices either. Asking by name is no better — Scryfall's
default printing for Volcanic Island is Vintage Masters, an MTGO-only set.

So pricing batches by name for the common case, then falls back to a per-card search
across all printings ordered by price for anything still unpriced. That turns Volcanic
Island into **$938.50** and Island into **$0.06**, which is the number someone deciding
whether to add a card actually needs. On the deck measured this cut unpriced rows from
six to one — and that one is a card with genuinely no USD price anywhere.

The fallback costs one request per card, so it is bounded per call and cached for a day.

One sharp edge found on the way: Scryfall rejects an **entire batch** with HTTP 400 if a
single `id` identifier is not a valid UUID, rather than reporting it as not_found — so
the id-based approach had a second failure mode on top of the wrong-printing one.

**It ends in something you can use.** We never write to Moxfield's API, so the honest
action is checkboxes plus *Copy as list*, which produces `1 Card Name` lines to paste into
Moxfield's own bulk import.

Rows show lift, inclusion and a bar, and hovering one previews the card — the EDHREC
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

## Publishing

`npm run build` produces `web-ext-artifacts/*.zip`. Signing is mandatory: Firefox release
and beta will not permanently install an unsigned extension, whether or not it is
publicly listed.

| | Unlisted (self-distributed) | Listed (public AMO) |
|---|---|---|
| Discoverable | no | yes |
| Review | automated | automated, may be followed by human review |
| Result | a signed `.xpi` you host | an AMO listing page |
| Needs listing copy | no | yes |

Get API credentials from the [AMO key page](https://addons.mozilla.org/developers/addon/api/key/).

**Put them in `~/.web-ext-config.cjs`, never in this repo — it is public.** web-ext
auto-discovers that file from the home directory, so no flags and no shell history:

```js
// ~/.web-ext-config.cjs  (home directory, note the leading dot)
module.exports = {
  sign: {
    apiKey: 'user:12345678:123',
    apiSecret: '...',
  },
};
```

Then signing is just:

```bash
npm run sign
```

Source-code submission is only required for minified or obfuscated code, which this is
not.

### Listing publicly

Everything AMO asks for is prepared in [`listing/LISTING.md`](listing/LISTING.md) —
summary (within the 250-character limit), description, categories, and notes for
reviewers — with screenshots at AMO's 1280×800 in `listing/screenshots/`.

1. **Bump `version` in `manifest.json` first.** AMO refuses a version it has already
   accepted, *for the add-on as a whole* — so `0.1.0`, already used for the unlisted
   signing, cannot be reused on the listed channel.
2. Submit a listed version. The Developer Hub form is the easier first pass; by CLI, a
   listed submission needs metadata the unlisted channel does not, and fails without it
   (`version.license ... is required for listed versions`):

   ```bash
   npx web-ext sign --channel=listed --amo-metadata=listing/amo-metadata.json
   ```
3. Fill the listing from `listing/LISTING.md`, upload the screenshots, and attach
   [`PRIVACY.md`](PRIVACY.md).
4. A listed submission may get human review on top of the automated checks.

A privacy policy is **required**, because the extension transmits card names off the
device. That is also why `data_collection_permissions` is `websiteContent` and not
`none`; the two need to agree or a reviewer will ask.

The signed `.xpi` lands in `web-ext-artifacts/` under an AMO-assigned filename; the
extension id inside it is unchanged. Install it permanently via `about:addons` → the
gear icon → **Install Add-on From File**, or by dragging it onto a Firefox window.
Remove the temporary copy from `about:debugging` first — it shares an id with the signed
one.

Two things that bite on the second release:

- **Bump `version` in `manifest.json` every time.** AMO rejects a version it has already
  seen, so re-signing without a bump fails.
- **Unlisted add-ons do not auto-update.** Firefox only checks for updates if the
  manifest carries an `update_url` pointing at an update manifest you host. Without one,
  a new version means signing and installing by hand — fine for personal use, worth
  knowing before handing the file to anyone else.

Three ways to get this wrong, in descending order of pain:

- **`web-ext-config.cjs` in this repo is tracked.** It is the file web-ext reads from the
  working directory, so it looks like the obvious home for credentials, and committing
  it would publish them. The home-directory file is the dot-prefixed one and is a
  different path entirely.
- **`--api-secret=...` on the command line** lands in shell history and in process
  listings on a shared machine.
- **Inline environment variables** (`WEB_EXT_API_SECRET=... npx web-ext sign`) also land
  in shell history.

If a secret is ever committed, deleting the commit is not enough — history, forks and
caches persist. Revoke and regenerate the credential on the AMO key page instead. The
gitignore covers `.env*`, `.web-ext-config.*` and `*.pem` as a backstop, but a backstop
is not a plan.

### Data collection must be declared accurately

`data_collection_permissions` is `["websiteContent"]`, **not** `none`. Mozilla defines
that category as anything visible on a website that is "collected, used, transferred,
shared, or handled outside the add-on or the local browser" — and this extension sends
deck card names to Scryfall, EDHREC and Commander Spellbook. That is the extension's
whole purpose, so it is `required` rather than optional, but declaring `none` would be
inaccurate and is the sort of thing a reviewer catches.

Nothing personal is transmitted, and nothing leaves the browser except card names.

### Before listing publicly

- **EDHREC and Commander Spellbook are unofficial APIs.** One user is negligible; a
  popular listing is not. Caching keeps it to roughly one request per deck per day, but
  it would be courteous to tell them before a public launch — and either could change or
  block without notice, at which point every user degrades to rank-only at once.
- **Read [Moxfield's terms][moxterms].** The extension only reads the rendered page and
  never touches their API, which is the defensible position, but check it yourself.
- **Wizards' Fan Content Policy** covers the card names and images. Carry the disclaimer
  at the bottom of this file into the AMO listing.

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
- **Rank only, not full EDHREC data.** Lift, synergy, per-commander inclusion rate, and salt
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
- [x] Per-commander lift, synergy, inclusion, list tags and salt via `json.edhrec.com`
- [x] Show EDHREC recommendations not yet in the deck
- [x] Cuts tab: the deck sorted worst-first, plus a deck salt total
- [x] Compare against EDHREC's average decklist ([31 votes](https://moxfield.nolt.io/466))
- [x] Combos via Commander Spellbook, including ones a single card away
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
[nolt304]: https://moxfield.nolt.io/304
[nolt466]: https://moxfield.nolt.io/466
[lift]: https://edhrec.com/articles/changelog-replacing-synergy-with-lift-on-edhrecs-card-pages
[spellbook]: https://commanderspellbook.com/
[cards]: https://scryfall.com/docs/api/cards
[limits]: https://scryfall.com/docs/api/rate-limits
[bulk]: https://scryfall.com/docs/api/bulk-data
[signing]: https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/
[moxtweet]: https://x.com/moxfieldmtg/status/1861599720142967082
[moxterms]: https://moxfield.com/help/terms

[forbidden]: https://developer.mozilla.org/en-US/docs/Glossary/Forbidden_request_header
