# AMO listing copy

Paste-ready text for the addons.mozilla.org listing. Screenshots are in
`listing/screenshots/` at 1280×800, the size AMO displays.

---

## Name

```
Moxfield EDHREC Overlay
```

## Summary

AMO limit is **250 characters**. This is 196.

```
Puts EDHREC rank, synergy and price on every card in your Moxfield deck, then shows what to add, what to cut, and which combos you are one card away from. Reads the page only - never your account.
```

## Description

```
Moxfield tells you what is in your deck. This tells you how it compares.

Every card gets a badge showing its EDHREC rank, colour-coded so the staples and the filler are distinguishable at a glance. Hover one for the numbers that rank alone cannot express:

• Synergy — how much more this card is played WITH your commander than in decks generally. A card at +58% belongs in your deck specifically; a card at +2% is just popular everywhere.
• Inclusion — the share of decks for your commander that run it.
• Salt, and whether the card is on the Commander Game Changer list.

A drawer on the right adds four views:

• Add — EDHREC's recommendations that your deck does not already run, led by the highest-synergy picks, with prices and a running total. Tick the ones you want and copy them straight into Moxfield's bulk import.
• Cuts — your own deck sorted worst-first, so the cards pulling their weight least are the ones you see. Includes a deck salt total.
• Combos — from Commander Spellbook: combos already assembled in your deck, and the ones a SINGLE card away. "Add Hullbreaker Horror for infinite mana" is a more useful suggestion than a rank.
• Avg — how your list compares to EDHREC's average deck for your commander, in both directions: the consensus picks you passed on, and what makes your list yours.

Works in all six Moxfield view styles, including the large hover preview.

WHAT IT DOES NOT DO

It never touches your Moxfield account or their API. It reads the page you are already
looking at and asks three public services about the cards on it: Scryfall, EDHREC and
Commander Spellbook. No account, no analytics, no tracking. Full privacy policy:
https://github.com/smit4450/moxfield-edhrec-overlay/blob/main/PRIVACY.md

Open source: https://github.com/smit4450/moxfield-edhrec-overlay

Unofficial Fan Content permitted under the Wizards of the Coast Fan Content Policy. Not
produced by or endorsed by Wizards of the Coast, Moxfield, EDHREC, Scryfall or Commander
Spellbook.
```

## Categories

Pick at most two — AMO warns that spreading across categories hurts more than it helps.

- **Games & Entertainment** (primary; this is a Magic: the Gathering tool)
- Leave the second blank rather than reaching for a poor fit.

## License

`MIT` — matches `LICENSE` in the repo.

## Privacy policy

Required, because the extension transmits card names off the device. Paste the contents
of [`PRIVACY.md`](../PRIVACY.md), or link to it.

## Support

- Support site: `https://github.com/smit4450/moxfield-edhrec-overlay`
- Support email: your preference — AMO shows whichever you provide publicly.

## Notes for reviewers

Reviewers see this; users do not. It saves a round trip on the questions this
extension's permissions will obviously raise.

```
Source is unminified and unbundled, and there is no build step: the JavaScript in the
package is the JavaScript in the repository, byte for byte.
https://github.com/smit4450/moxfield-edhrec-overlay

The package contains manifest.json, src/, icons/, README.md, PRIVACY.md and LICENSE.
Development tooling (tools/, listing/, CI config) is excluded via web-ext-config.cjs and
is not part of the extension.

Host permissions, and why each is needed:
- moxfield.com — the content script reads card names from the rendered deck page and
  draws the overlay. It never calls Moxfield's own API and never touches the user's
  account or session.
- api.scryfall.com — card ranks and prices, via POST /cards/collection.
- json.edhrec.com — commander-specific synergy and recommendations, one request per deck.
- backend.commanderspellbook.com — combo detection, one request per deck.

data_collection_permissions is declared as websiteContent rather than none, because card
names read from the page are transmitted to those three services. That is the extension's
core function and is described in the listing and the privacy policy.

Results are cached in storage.local for 24 hours to 7 days to minimise requests. No
analytics, no remote code, no eval in shipped code.
```
