# Privacy Policy

**Moxfield EDHREC Overlay** · last updated 2026-10-03

This policy covers the extension in both Firefox and Chrome. The two are the same code
and behave identically.

## The short version

The extension sends the names of cards on the Moxfield page you are viewing to three
public Magic: the Gathering data services, so it can look up their statistics. It sends
nothing else, collects nothing about you, and has no analytics, no accounts and no
tracking of any kind.

## What is transmitted, and to whom

The extension reads the card names already displayed on a Moxfield deck page and sends
them to:

| Service | What is sent | Why |
|---|---|---|
| [Scryfall](https://scryfall.com/docs/api) | card names | EDHREC rank, prices, card images |
| [EDHREC](https://edhrec.com) | the deck's commander name | lift, synergy, inclusion rates, recommendations, salt |
| [Commander Spellbook](https://commanderspellbook.com) | the deck's card list | combos in the deck, and combos one card away |

Card images are loaded directly from Scryfall's image servers
(`cards.scryfall.io`), which means those servers receive a request when an image is
shown.

These requests happen only on `moxfield.com` pages. The extension does nothing on any
other site.

## What is **not** transmitted

- No name, email, account, or any other identifying information.
- No Moxfield login, cookies, or session data. The extension never signs in to
  anything and never calls Moxfield's own API.
- No browsing history. It cannot see, and never records, any page other than the
  Moxfield page you are actively viewing.
- No analytics, telemetry, crash reporting, advertising or fingerprinting.
- Nothing is ever sent to the developer. There is no server behind this extension.

## What is stored, and where

Looked-up data is cached in your browser's local extension storage so the same card is
not requested repeatedly:

| Cached | Kept for |
|---|---|
| Card ranks | 7 days |
| Prices | 24 hours |
| EDHREC commander data | 24 hours |
| Salt list | 7 days |
| Combo results | 24 hours |

This cache holds card statistics only — no personal data. Expired entries are deleted
whenever the extension starts. The cache never leaves your browser and is deleted when
you uninstall the extension. You can clear it at any time by
removing and reinstalling the extension.

## Third-party services

Scryfall, EDHREC and Commander Spellbook are independent services, not operated by this
extension's developer. Requests to them are subject to their own privacy policies. The
extension sends them card names only, with no information about who is asking.

## Permissions, and why each is needed

| Permission | Reason |
|---|---|
| `storage` | The local cache described above |
| `unlimitedStorage` | Lets that cache grow past Chrome's 10 MB default. It holds the same card statistics, nothing more |
| `moxfield.com` | Read card names from the page and draw the overlay |
| `api.scryfall.com` | Look up ranks and prices |
| `json.edhrec.com` | Look up lift, synergy and recommendations |
| `backend.commanderspellbook.com` | Look up combos |

The manifest declares `websiteContent` under Firefox's data-collection disclosure,
because card names read from the page are transmitted off the device. That declaration
is deliberately not `none`.

## Changes

Any change to what is transmitted will be reflected here and in the extension's listing
before the version that makes the change is published.

## Contact

Questions or concerns: open an issue at
<https://github.com/smit4450/moxfield-edhrec-overlay/issues>.
