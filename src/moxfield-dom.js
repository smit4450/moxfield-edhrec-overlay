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
  const CARD_HOST_SELECTORS = [
    '.img-card',
    '[class*="visual-spoiler"] a[href*="/cards/"]',
    'a[href*="/cards/"] img',
  ];

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

    const link = host.matches('a[href*="/cards/"]')
      ? host
      : host.querySelector('a[href*="/cards/"]') || host.closest('a[href*="/cards/"]');
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
   * Moxfield card URLs look like /cards/YNRXG-extraplanar-lens — a short id,
   * a hyphen, then a slugified name. Recovering the name from a slug is lossy
   * (apostrophes, commas and hyphens in real names are all flattened), so this
   * is a last resort; Scryfall's fuzzy matching usually rescues it.
   */
  function nameFromCardHref(href) {
    if (!href) return null;
    const m = href.match(/\/cards\/([^/?#]+)/);
    if (!m) return null;
    const slug = m[1].replace(/^[A-Za-z0-9]{4,8}-/, '');
    if (!slug || slug === m[1]) return null;
    return slug.split('-').filter(Boolean).join(' ');
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
