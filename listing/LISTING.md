# Listing on AMO

Everything a public addons.mozilla.org listing needs. The copy itself lives in
[`amo-metadata.json`](amo-metadata.json) so it exists in exactly one place; this file is
the guide around it.

## Two ways to submit

**Developer Hub — recommended for the first listing.** The web form presents license,
categories, name and summary as fields with the valid options shown, so nothing depends
on getting a slug exactly right. Once the listing exists, later versions go up with a
plain `npx web-ext sign --channel=listed`.

**CLI.** A listed submission needs metadata the unlisted channel does not — the first
attempt fails with `version.license: This field, or custom_license, is required for
listed versions`. web-ext takes that metadata as a file:

```bash
npx web-ext sign --channel=listed --amo-metadata=listing/amo-metadata.json
```

The slugs in that file were read off the live AMO API rather than guessed:

| Field | Value | How it was confirmed |
|---|---|---|
| `version.license` | `MIT` | Dark Reader's listing reports exactly this slug |
| `categories` | `["games-entertainment"]` | from `/api/v5/addons/categories/` |

Both are case-sensitive; `mit` or `Games & Entertainment` will be rejected.

## Before every submission

**Bump `version` in `manifest.json`.** AMO refuses a version it has already accepted for
the add-on, whichever channel used it — `0.1.0` was consumed by the unlisted signing.

## What the metadata file does not cover

**Screenshots.** Upload the five in [`screenshots/`](screenshots/) through the Developer
Hub. They are 1280×800, the size AMO displays, captured from the real extension driven
through a real deck.

**Privacy policy.** Required, because the extension transmits card names off the device.
Paste [`../PRIVACY.md`](../PRIVACY.md) or link to it. It has to agree with the
`websiteContent` declaration in the manifest — a reviewer comparing a `none` declaration
against a policy describing three outbound APIs will ask.

**Support email.** AMO shows it publicly, so it is deliberately not in the repo. The
support URL is already in the metadata file.

## Category

`games-entertainment`, one only. AMO warns that spreading across categories does more
harm than good, and no second category is a good fit for a Magic: the Gathering tool.

## Review

Listed submissions get the automated checks plus possible human review. The
`approval_notes` in the metadata file pre-empt the obvious question — why an extension
needs four host permissions — by naming each one and what it is for.
