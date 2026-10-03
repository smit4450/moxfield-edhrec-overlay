# Listing on the Chrome Web Store

Everything the Chrome Web Store asks for, field by field, ready to paste. The package is
the one AMO gets: a single manifest serves both browsers. [`LISTING.md`](LISTING.md) is
the AMO guide.

## Before the first upload

All of this is the account holder's to do, at the
[developer dashboard](https://chrome.google.com/webstore/devconsole):

- Register as a developer: a one-time US$5 fee, and 2-Step Verification on the Google
  account.
- On the **Account** page, set a contact email and verify it. The store will not publish
  until it is verified.

## The package

```bash
npm run build
```

Upload `web-ext-artifacts/moxfield_edhrec_overlay-<version>.zip` as it is. Chrome reads
`background.service_worker` and ignores `background.scripts` and
`browser_specific_settings`; Firefox does the reverse. There is no signing step: the
store signs what it publishes.

Like AMO, the store refuses a version it has already published. Bump `version` in
`manifest.json` before every upload.

## Store listing

**Description.** The same copy as AMO, kept in one place, `amo-metadata.json`. Print it
as plain text and paste:

```bash
node -p "require('./listing/amo-metadata.json').description['en-US']"
```

The short summary under the title is not a field here: the store takes it from the
manifest's `description`, which Chrome caps at 132 characters.

**Category.** Lifestyle → **Games**. Like AMO, there is no better fit for a Magic: the
Gathering tool, and one category is all the store allows.

**Language.** English.

**Graphic assets:**

| Field | File | Size |
|---|---|---|
| Store icon | [`chrome/store-icon-128.png`](chrome/store-icon-128.png) | 128×128, the artwork at 96×96 with transparent padding, as Google's icon guidelines ask |
| Screenshots | the five in [`screenshots/`](screenshots/), in order | 1280×800 |
| Small promo tile | [`chrome/promo-tile-440x280.png`](chrome/promo-tile-440x280.png) | 440×280 |
| Marquee promo tile | none; optional | |
| Promo video | none | |

Google's documentation lists a YouTube video among the assets you "must provide", but
most published listings have none. If the dashboard will not save without one, a short
screen recording of the extension in use, uploaded to YouTube, is enough.

**Additional fields:**

| Field | Value |
|---|---|
| Official URL | leave empty: it needs a site verified in Search Console, and github.com cannot be |
| Homepage URL | `https://github.com/smit4450/moxfield-edhrec-overlay` |
| Support URL | `https://github.com/smit4450/moxfield-edhrec-overlay/issues` |
| Mature content | off |

## Privacy practices

This tab is what review reads most closely. Each answer below must agree with
[`PRIVACY.md`](../PRIVACY.md), and the store shows the data disclosures to users.

**Single purpose description:**

> Shows EDHREC deckbuilding data on Moxfield deck pages: each card's rank, lift and
> price, and for the deck as a whole, the cards to add, the cards to cut, and the combos
> it is one card away from. It does nothing on any other site.

**Permission justifications:**

`storage`

> Caches the card statistics the extension looks up (ranks, prices, EDHREC commander
> data, combos) in chrome.storage.local for 24 hours to 7 days, so a card already looked
> up is not requested again on every page view. This keeps the extension inside
> Scryfall's published rate limit. The cache holds card statistics only, no personal
> data.

`unlimitedStorage`

> The same cache can outgrow chrome.storage.local's 10 MB default for someone who views
> many decks, and writes then fail. Expired entries are deleted at startup, so the cache
> stays bounded by its expiry times; this permission only stops a large cache from
> losing writes. It stores card statistics only.

Host permissions — the content script's match counts as one:

> https://*.moxfield.com/* (content script): reads the card names already displayed on
> the Moxfield deck page and draws the rank badges, tooltips and drawer. It never calls
> Moxfield's API and never touches the user's account or session.
>
> https://api.scryfall.com/*: card ranks and prices.
>
> https://json.edhrec.com/*: lift, synergy, inclusion, recommendations and the average
> deck for the deck's commander, one request per deck.
>
> https://backend.commanderspellbook.com/*: combos in the deck and combos one card away,
> one request per deck.
>
> Every request is made by the background service worker, so one queue keeps to
> Scryfall's rate limit however many tabs are open.

**Remote code:** *No, I am not using remote code.* If a justification is asked for:

> All JavaScript ships in the package, unminified. Responses from the three APIs are
> JSON data and are never evaluated: there is no eval, new Function or remote script.

**Data usage.** Tick **Website content** and nothing else:

| Category | Ticked | Why |
|---|---|---|
| Website content | **yes** | card names read from the page are sent to Scryfall, EDHREC and Commander Spellbook |
| Web history | no | no URL is stored or sent; caches are keyed by card name, by commander, and by a hash of the card list |
| User activity | no | hovers and clicks are handled on the page, never recorded or sent |
| Personally identifiable, health, financial and payment, authentication, personal communications, location | no | none is read. Card prices are not the user's financial information |

Then tick all three certifications: no selling or transfer outside the approved uses, no
use unrelated to the single purpose, no use for creditworthiness or lending. All three
are true: nothing reaches the developer at all.

**Privacy policy URL:**

```
https://github.com/smit4450/moxfield-edhrec-overlay/blob/main/PRIVACY.md
```

The Limited Use policy asks for an affirmative statement on a site belonging to the
extension. PRIVACY.md carries it, under *Chrome Web Store: Limited Use*.

## Test instructions

If the dashboard offers a field for reviewers:

> No account or sign-in is needed. Open any Moxfield deck, for example the official
> precon https://moxfield.com/decks/tsKfnd0haUax0CLKMHWVHQ. Every card gets a rank
> badge; hover one for lift, synergy and inclusion. The tab on the right edge of the
> page ("… recs") opens the drawer: Add, Cuts, Combos and Avg.

## Distribution

| Field | Value |
|---|---|
| Payments | free, no in-app purchases |
| Visibility | Public |
| Regions | all |

## Review

**Submit for review.** The dialog offers to publish as soon as the item passes; leave
that on unless you want to choose the moment. The dashboard shows the item's status
while it waits, and the result goes to the contact email.

The permissions are deliberately narrow, which is what review looks for: four named
hosts, no `tabs`, no `<all_urls>`, and a content script that matches Moxfield alone.

## After it is live

Add the store link to the README's Install section. For each later version: bump
`version`, `npm run build`, then **Package → Upload new package**, and submit.
