/**
 * Moxfield DOM adapter.
 *
 * EVERYTHING THAT KNOWS ABOUT MOXFIELD'S MARKUP LIVES HERE.
 *
 * Moxfield is a React SPA with unversioned internal class names. When a deploy
 * breaks the overlay, this file is the only one that should need editing.
 *
 * The selectors below are derived from the Moxfield Card Pricer extension
 * (github.com/Jesse-Culver/Moxfield-Card-Pricer---Firefox-Addon) and have NOT
 * been verified against a live page by the author. Verify before trusting.
 * See README "Verifying the selectors".
 */

globalThis.MoxfieldDom = (() => {
  // Marks a host element as already handled, so re-running is idempotent.
  const DONE_ATTR = 'data-edhrec-badge';

  // Ordered by confidence. Anything matching is treated as one card tile.
  // Verified against a live deck page 2026-09-09: `.img-card` matched 88
  // elements; the two link-based candidates that used to sit here matched zero
  // and were removed. `.img-card` is on the <img> itself, which is also where
  // the card name lives (alt), so it is both the anchor and the identity.
  const CARD_HOST_SELECTORS = ['.img-card'];

  // Alt/title values Moxfield uses that are not card names.
  const JUNK_NAMES = new Set(['front', 'back', 'transform', 'flip', 'card', '']);

  /** All card tiles on the page that still need a badge. */
  function findUnprocessedCards(root = document) {
    const seen = new Set();
    const out = [];
    for (const sel of CARD_HOST_SELECTORS) {
      for (const el of root.querySelectorAll(sel)) {
        const host = el.tagName === 'IMG' ? el.closest('a, div') || el : el;
        if (!host || seen.has(host) || host.hasAttribute(DONE_ATTR)) continue;
        seen.add(host);
        out.push(host);
      }
    }
    return out;
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

  /** Attach the badge, or replace one that React reconciled away. */
  function attachBadge(host, badgeEl) {
    const existing = host.querySelector(':scope > .edhrec-badge');
    if (existing) existing.remove();
    host.classList.add('edhrec-host');
    host.setAttribute(DONE_ATTR, '1');
    host.appendChild(badgeEl);
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
    extractCardName,
    attachBadge,
    removeAllBadges,
  };
})();
