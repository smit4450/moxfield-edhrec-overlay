/**
 * Moxfield DOM adapter.
 *
 * EVERYTHING THAT KNOWS ABOUT MOXFIELD'S MARKUP LIVES HERE.
 *
 * Moxfield is a React SPA with unversioned internal class names. When a deploy
 * breaks the overlay, this file is the only one that should need editing.
 *
 * The selectors below were verified against a live Moxfield deck page on
 * 2026-09-09 with tools/inspect-selectors.js. Re-run it after any Moxfield
 * deploy that breaks the overlay; see README "Verifying the selectors".
 */

globalThis.MoxfieldDom = (() => {
  // Marks a host element as already handled, so re-running is idempotent.
  const DONE_ATTR = 'data-edhrec-badge';

  // Verified against a live deck page 2026-09-09: `.img-card` matched 88
  // elements, every one an <img>, and all 88 carried a non-empty alt. The two
  // link-based candidates that used to sit here matched zero and were removed.
  const CARD_HOST_SELECTORS = ['.img-card'];

  /**
   * The per-card tile in the deck grid, and what we anchor the badge to.
   *
   * Verified 2026-09-09: every badge that landed correctly had this as its
   * offsetParent, and each one carries `id="vd-<cardId>"` where the id matches
   * the card-page slug — `vd-Yd22G` alongside `/cards/Yd22G-elves-of-deep-shadow`.
   * That makes it a stable per-card key if `alt` ever stops being reliable.
   *
   * Anchoring here rather than via `closest('a, div')` is the difference between
   * naming the element we want and landing on whatever container happened to be
   * nearest.
   */
  const CARD_TILE = '.img-card-visual';

  /**
   * Contexts that render `.img-card` images with no per-card wrapper, where a
   * badge would attach once to a shared container instead of once per card.
   *
   * Verified 2026-09-09: the sample-hand widget puts all 7 images directly in a
   * single `div.samplehand` (they collapse to one host under every anchoring
   * strategy tried), and each sidebar preview holds up to three images for one
   * card (Transform / Front / Back).
   *
   * The preview is excluded here but NOT abandoned — it is badged by the live
   * path below, which re-derives it on every pass because it swaps cards on
   * hover without remounting.
   */
  const SKIP_CONTAINERS = '.samplehand, .deckview-image-wrapper';

  /**
   * The large card preview on the left, which follows the mouse.
   *
   * It cannot use the one-shot path: React swaps the image in place rather than
   * remounting the wrapper, so a badge marked done would go stale and start
   * reporting the rank of whatever card you hovered first.
   */
  const PREVIEW_HOST = '.deckview-image-wrapper';

  /** Moxfield card-image URLs: assets.moxfield.net/cards/card-<cardId>-normal.jpg */
  const CARD_ASSET_ID = /\/cards\/card-([A-Za-z0-9]+)-/;

  // Alt/title values Moxfield uses that are not card names. Verified present in
  // live alt text: "Transform", "Front", "Back" all appear on real images.
  const JUNK_NAMES = new Set(['front', 'back', 'transform', 'flip', 'card', '']);

  /** All card tiles on the page that still need a badge. */
  function findUnprocessedCards(root = document) {
    const seen = new Set();
    const out = [];
    for (const sel of CARD_HOST_SELECTORS) {
      for (const el of root.querySelectorAll(sel)) {
        if (el.closest(SKIP_CONTAINERS)) continue;
        const host =
          el.closest(CARD_TILE) || (el.tagName === 'IMG' ? el.closest('a, div') : el) || el;
        if (!host || seen.has(host) || host.hasAttribute(DONE_ATTR)) continue;
        seen.add(host);
        out.push(host);
      }
    }
    return out;
  }

  /** Preview hosts, returned every pass — never marked done. */
  function findPreviewHosts(root = document) {
    return [...root.querySelectorAll(PREVIEW_HOST)];
  }

  /**
   * Card name shown in the hover preview.
   *
   * A single-faced preview carries the name in an image alt like everything
   * else. A double-faced one does not — its images are labelled "Front",
   * "Back" and "Transform" — so fall back to the Moxfield card id embedded in
   * the image URL and resolve it against names harvested from the rest of the
   * page, where the same id appears as a `vd-<id>` tile and in `/cards/<id>-…`
   * links.
   */
  function extractPreviewName(host) {
    for (const img of host.querySelectorAll('img')) {
      const v = clean(img.getAttribute('alt'));
      if (isPlausibleName(v)) return v;
    }
    const id = previewCardId(host);
    return (id && cardNameById().get(id)) || null;
  }

  /** The Moxfield card id behind whatever the preview is currently showing. */
  function previewCardId(host) {
    const urls = [];
    for (const img of host.querySelectorAll('img')) urls.push(img.getAttribute('src'));
    for (const a of host.querySelectorAll('a[href]')) urls.push(a.getAttribute('href'));
    for (const u of urls) {
      const m = u && u.match(CARD_ASSET_ID);
      if (m) return m[1];
    }
    return null;
  }

  /**
   * Map of Moxfield card id -> card name, harvested from the page.
   *
   * Two independent sources, both verified 2026-09-09: grid tiles carry
   * `id="vd-<cardId>"` with the name in their image alt, and card links are
   * `/cards/<cardId>-<slugified-name>`. Link text is preferred over the slug,
   * which flattens apostrophes and commas.
   */
  function cardNameById(root = document) {
    const map = new Map();

    for (const tile of root.querySelectorAll(`${CARD_TILE}[id^="vd-"]`)) {
      const id = tile.id.slice(3);
      const name = clean(tile.querySelector('img')?.getAttribute('alt'));
      if (id && isPlausibleName(name) && !map.has(id)) map.set(id, name);
    }

    for (const a of root.querySelectorAll('a[href*="/cards/"]')) {
      const slug = cardPageSlug(a.getAttribute('href'));
      const m = slug && slug.match(/^([A-Za-z0-9]+)-(.+)$/);
      if (!m || map.has(m[1])) continue;
      const text = clean(a.textContent);
      const name = isPlausibleName(text) ? text : m[2].split('-').join(' ');
      if (isPlausibleName(name)) map.set(m[1], name);
    }

    return map;
  }

  /**
   * Best-effort card name for a tile.
   * Tries image alt/title/data-name, then the /cards/<id>-<slug> href, then
   * any descendant that looks like a name label.
   */
  function extractCardName(host) {
    const img = host.tagName === 'IMG' ? host : host.querySelector('img');
    if (img) {
      for (const attr of ['alt', 'title', 'data-name']) {
        const v = clean(img.getAttribute(attr));
        if (isPlausibleName(v)) return v;
      }
    }

    const link = findCardPageLink(host);
    if (link) {
      const fromHref = nameFromCardHref(link.getAttribute('href'));
      if (isPlausibleName(fromHref)) return fromHref;
    }

    const label = host.querySelector('[class*="card-name"], [class*="cardName"], [class*="name"]');
    const v = clean(label && label.textContent);
    if (isPlausibleName(v)) return v;

    return null;
  }

  /**
   * Returns the slug of a genuine Moxfield card page, or null.
   *
   * Matching on `href*="/cards/"` alone is a trap: Moxfield's card-image
   * download buttons point at
   * `https://assets.moxfield.net/cards/card-Lze8j-normal.jpg?...&download=true`,
   * which contains `/cards/` but is an image asset. Left unguarded that yields
   * the "card name" `Lze8j normal.jpg`, which then gets sent to Scryfall and
   * negative-cached. Observed on a live deck page 2026-09-09, where 93 elements
   * matched `a[href*="/cards/"]` and the sampled one was a download button.
   *
   * So: same host as the page, an exact /cards/<slug> path, no image extension.
   */
  function cardPageSlug(href) {
    if (!href) return null;
    let url;
    try {
      url = new URL(href, location.href);
    } catch {
      return null;
    }
    if (url.hostname !== location.hostname) return null;
    const m = url.pathname.match(/^\/cards\/([^/]+)\/?$/);
    if (!m) return null;
    if (/\.(?:jpe?g|png|webp|gif|avif|svg)$/i.test(m[1])) return null;
    return m[1];
  }

  /** The first descendant/ancestor link that is a real card page. */
  function findCardPageLink(host) {
    const candidates = [];
    if (host.matches?.('a[href*="/cards/"]')) candidates.push(host);
    candidates.push(...host.querySelectorAll('a[href*="/cards/"]'));
    const up = host.closest?.('a[href*="/cards/"]');
    if (up) candidates.push(up);
    for (const a of candidates) {
      if (cardPageSlug(a.getAttribute('href'))) return a;
    }
    return null;
  }

  /**
   * Moxfield card URLs look like /cards/YNRXG-extraplanar-lens — a short id,
   * a hyphen, then a slugified name. Recovering the name from a slug is lossy
   * (apostrophes, commas and hyphens in real names are all flattened), so this
   * is a last resort; Scryfall's fuzzy matching usually rescues it.
   */
  function nameFromCardHref(href) {
    const slug = cardPageSlug(href);
    if (!slug) return null;
    const rest = slug.replace(/^[A-Za-z0-9]{4,8}-/, '');
    if (!rest || rest === slug) return null;
    return rest.split('-').filter(Boolean).join(' ');
  }

  /**
   * Attach the badge, or replace one that React reconciled away.
   *
   * `live` hosts (the hover preview) are deliberately not marked done, so each
   * pass re-checks them and can swap the badge when the card changes.
   */
  function attachBadge(host, badgeEl, { live = false } = {}) {
    const existing = host.querySelector(':scope > .edhrec-badge');
    if (existing) existing.remove();
    host.classList.add('edhrec-host');
    if (live) host.classList.add('edhrec-preview-host');
    else host.setAttribute(DONE_ATTR, '1');
    host.appendChild(badgeEl);
  }

  /** Name currently badged on a host, so a live host can skip redundant work. */
  function badgedName(host) {
    return host.querySelector(':scope > .edhrec-badge')?.dataset.cardName ?? null;
  }

  /** Remove a live host's badge — e.g. the preview showing something unreadable. */
  function clearBadge(host) {
    host.querySelector(':scope > .edhrec-badge')?.remove();
    host.classList.remove('edhrec-preview-host');
  }

  /** Clear all badges and markers — used when the user toggles the overlay off. */
  function removeAllBadges(root = document) {
    for (const b of root.querySelectorAll('.edhrec-badge')) b.remove();
    for (const h of root.querySelectorAll(`[${DONE_ATTR}]`)) {
      h.removeAttribute(DONE_ATTR);
      h.classList.remove('edhrec-host');
    }
  }

  function clean(s) {
    return (s || '').replace(/\s+/g, ' ').trim();
  }

  function isPlausibleName(s) {
    if (!s) return false;
    if (JUNK_NAMES.has(s.toLowerCase())) return false;
    // Reject pure numbers / prices / quantities.
    if (/^[\d.,$x×+\-\s]+$/i.test(s)) return false;
    return s.length >= 2 && s.length <= 200;
  }

  return {
    DONE_ATTR,
    findUnprocessedCards,
    findPreviewHosts,
    extractCardName,
    extractPreviewName,
    attachBadge,
    badgedName,
    clearBadge,
    removeAllBadges,
  };
})();
