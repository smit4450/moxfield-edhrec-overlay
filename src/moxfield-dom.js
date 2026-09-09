/**
 * Moxfield DOM adapter.
 *
 * EVERYTHING THAT KNOWS ABOUT MOXFIELD'S MARKUP LIVES HERE.
 *
 * Moxfield is a React SPA. When a deploy breaks the overlay, this file is the
 * only one that should need editing. Verified against live deck pages in every
 * view mode; re-run tools/verify-live.mjs after any breakage.
 *
 * `findTargets()` is the whole public surface: it returns one descriptor per
 * badgeable thing on the page, so content.js stays ignorant of how any of it
 * was found.
 */

globalThis.MoxfieldDom = (() => {
  // Marks a host as handled, so re-running is idempotent. Live hosts never get it.
  const DONE_ATTR = 'data-edhrec-badge';

  /**
   * The card's own id is the final `-` segment of the element id, in EVERY view:
   *
   *   vd-Yd22G              visual spoiler tile
   *   id1288-legal-N9J2z    the second image grid
   *   id_r_12h_-N9J2z       table / list row link
   *   deckviewimage-_r_os_  preview wrapper - correctly NOT a match
   *
   * Anchoring on this rather than on a class is deliberate. The classes on
   * those same elements are hashed CSS-module names (`qqvQq_L4ZyNhF25VQaOA`,
   * `XIi4jFys2lGhYwseGpBo`) that change on every Moxfield build, whereas this
   * pattern held across all three layouts. It also excludes the preview for
   * free, since React's generated suffixes carry underscores.
   */
  const CARD_ID_SUFFIX = /-([A-Za-z0-9]{4,8})$/;

  /** The card image. Present in both image grids, absent in text views. */
  const CARD_IMAGE = '.img-card';

  /** The per-card row link in table and list views. Not a hashed class. */
  const ROW_LINK = 'a.table-deck-row-link';

  /** The large card preview on the left, which follows the mouse. */
  const PREVIEW_HOST = '.deckview-image-wrapper';

  /**
   * The sample-hand widget renders all 7 of its images as direct children of a
   * single container with no per-card wrapper, so every anchoring strategy
   * collapses them onto one badge. Badging it properly needs wrappers we inject
   * ourselves, which means fighting React's reconciliation.
   */
  const SKIP_CONTAINERS = '.samplehand';

  /** Moxfield card-image URLs: assets.moxfield.net/cards/card-<cardId>-normal.jpg */
  const CARD_ASSET_ID = /\/cards\/card-([A-Za-z0-9]+)-/;

  // Alt/title values Moxfield uses that are not card names.
  const JUNK_NAMES = new Set(['front', 'back', 'transform', 'flip', 'card', '']);

  /**
   * Every badgeable thing on the page, as descriptors:
   *   host   identity, and what gets marked done
   *   mount  where the badge element is appended
   *   name   the card name to look up
   *   inline text-view badges sit in the flow; image badges sit in a corner
   *   live   re-derived every pass instead of being marked done
   */
  function findTargets(root = document) {
    return [...imageTargets(root), ...rowTargets(root), ...previewTargets(root)];
  }

  /** Card images, in whichever grid layout this view uses. */
  function imageTargets(root) {
    const seen = new Set();
    const out = [];
    for (const img of root.querySelectorAll(CARD_IMAGE)) {
      if (img.closest(SKIP_CONTAINERS) || img.closest(PREVIEW_HOST)) continue;
      const host = tileFor(img);
      if (!host || seen.has(host) || host.hasAttribute(DONE_ATTR)) continue;
      const name = clean(img.getAttribute('alt'));
      if (!isPlausibleName(name)) continue;
      seen.add(host);
      out.push({ host, mount: host, name, inline: false, live: false });
    }
    return out;
  }

  /**
   * Table and list view rows.
   *
   * The badge is appended to the link's PARENT, never inside the link: the
   * badge is itself an <a>, and nesting anchors is invalid HTML that browsers
   * silently restructure.
   */
  function rowTargets(root) {
    const out = [];
    for (const link of root.querySelectorAll(ROW_LINK)) {
      if (link.closest(SKIP_CONTAINERS)) continue;
      // Category headers ("Creatures(4)", "Planeswalkers(1)") reuse the
      // row-link class. Verified live: real card rows carry a card id
      // (id_r_1l_-Mxm76) and headers carry no id at all.
      if (!link.id || !CARD_ID_SUFFIX.test(link.id)) continue;
      const mount = link.parentElement;
      if (!mount || link.hasAttribute(DONE_ATTR)) continue;
      const name = rowCardName(link);
      if (!name) continue;
      out.push({ host: link, mount, name, inline: true, live: false });
    }
    return out;
  }

  /** The hover preview, re-derived every pass because it swaps cards in place. */
  function previewTargets(root) {
    const out = [];
    for (const host of root.querySelectorAll(PREVIEW_HOST)) {
      const name = extractPreviewName(host);
      if (!name) {
        clearBadge(host);
        continue;
      }
      out.push({ host, mount: host, name, inline: false, live: true });
    }
    return out;
  }

  /** Nearest ancestor-or-self whose element id ends in a card id. */
  function tileFor(el) {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      if (n.id && CARD_ID_SUFFIX.test(n.id)) return n;
    }
    // Older markup, and a last resort if the id scheme ever changes.
    return el.closest('.img-card-visual') || el.closest('a, div');
  }

  /** Card name for a table/list row: the link's own text, else its slug. */
  function rowCardName(link) {
    const text = clean(link.textContent);
    if (isPlausibleName(text)) return text;
    return nameFromCardHref(link.getAttribute('href'));
  }

  /**
   * Card name shown in the hover preview.
   *
   * A single-faced preview carries the name in an image alt like everything
   * else. A double-faced one does not - its images are labelled "Front",
   * "Back" and "Transform" - so fall back to the Moxfield card id embedded in
   * the image URL, resolved against names harvested from the rest of the page.
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
   * Two independent sources: any element whose id ends in a card id and which
   * contains a named card image, and card links of the form
   * `/cards/<cardId>-<slugified-name>`. Link text beats the slug, which
   * flattens apostrophes and commas.
   */
  function cardNameById(root = document) {
    const map = new Map();

    for (const el of root.querySelectorAll('[id]')) {
      const m = el.id.match(CARD_ID_SUFFIX);
      if (!m || map.has(m[1])) continue;
      const name = clean(el.querySelector(CARD_IMAGE)?.getAttribute('alt'));
      if (isPlausibleName(name)) map.set(m[1], name);
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
   * Returns the slug of a genuine Moxfield card page, or null.
   *
   * Matching on `href*="/cards/"` alone is a trap: Moxfield's card-image
   * download buttons point at
   * `https://assets.moxfield.net/cards/card-Lze8j-normal.jpg?...&download=true`,
   * which contains `/cards/` but is an image asset. Left unguarded that yields
   * the "card name" `Lze8j normal.jpg`. Measured on a live page: 91 elements
   * matched, of which only 13 were real card pages and 78 were download links.
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

  /**
   * Moxfield card URLs look like /cards/YNRXG-extraplanar-lens. Recovering the
   * name from a slug is lossy (apostrophes, commas and hyphens in real names
   * all flatten), so it is a last resort; Scryfall's matching usually rescues it.
   */
  function nameFromCardHref(href) {
    const slug = cardPageSlug(href);
    if (!slug) return null;
    const rest = slug.replace(/^[A-Za-z0-9]{4,8}-/, '');
    if (!rest || rest === slug) return null;
    return rest.split('-').filter(Boolean).join(' ');
  }

  /** Attach a badge for one target, replacing any React reconciled away. */
  function attachBadge({ host, mount, inline, live }, badgeEl) {
    mount.querySelector(':scope > .edhrec-badge')?.remove();
    if (inline) {
      badgeEl.classList.add('edhrec-inline');
    } else {
      mount.classList.add('edhrec-host');
      if (live) mount.classList.add('edhrec-preview-host');
    }
    if (!live) host.setAttribute(DONE_ATTR, '1');
    mount.appendChild(badgeEl);
  }

  /** Name currently badged on a mount, so a live host can skip redundant work. */
  function badgedName(mount) {
    return mount.querySelector(':scope > .edhrec-badge')?.dataset.cardName ?? null;
  }

  /** Remove a live host's badge - e.g. a preview showing something unreadable. */
  function clearBadge(mount) {
    mount.querySelector(':scope > .edhrec-badge')?.remove();
    mount.classList.remove('edhrec-preview-host', 'edhrec-host');
  }

  /** Clear every badge and marker - used when the overlay is toggled off. */
  function removeAllBadges(root = document) {
    for (const b of root.querySelectorAll('.edhrec-badge')) b.remove();
    for (const h of root.querySelectorAll(`[${DONE_ATTR}]`)) h.removeAttribute(DONE_ATTR);
    for (const h of root.querySelectorAll('.edhrec-host, .edhrec-preview-host')) {
      h.classList.remove('edhrec-host', 'edhrec-preview-host');
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

  return { DONE_ATTR, findTargets, attachBadge, badgedName, clearBadge, removeAllBadges };
})();
