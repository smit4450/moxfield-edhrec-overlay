/**
 * Selector diagnostic — paste into the devtools console on a Moxfield DECK page.
 *
 * Mirrors the production logic in src/moxfield-dom.js and reports where it
 * disagrees with reality, so a Moxfield deploy that breaks the overlay shows up
 * as a concrete number rather than "no badges appeared".
 *
 * Measured baseline, 2026-09-09:
 *   .img-card                 88   all <img>, all with a non-empty alt
 *   in skip containers        13   7 sample-hand + 2 previews x 3 images
 *   junk alts                  0   every junk alt sits inside a skip container
 *   badgeable images          75
 *   distinct tiles            75   1:1, no collisions
 *   badges                    75   injected == expected
 *
 * Not part of the extension; never shipped.
 */

(() => {
  const CARD_HOST = '.img-card';
  const CARD_TILE = '.img-card-visual';
  const SKIP_CONTAINERS = '.samplehand, .deckview-image-wrapper';
  const JUNK = new Set(['front', 'back', 'transform', 'flip', 'card', '']);

  const describe = (el) =>
    !el
      ? '(none)'
      : el.tagName.toLowerCase() +
        (el.id ? '#' + el.id : '') +
        (el.className ? '.' + String(el.className).trim().split(/\s+/).slice(0, 3).join('.') : '');

  const alt = (el) => (el.getAttribute('alt') || '').trim();
  const isJunk = (s) => !s || JUNK.has(s.toLowerCase());

  console.group('%cMoxfield overlay check', 'font-weight:bold;font-size:13px');

  const all = [...document.querySelectorAll(CARD_HOST)];
  const skipped = all.filter((el) => el.closest(SKIP_CONTAINERS));
  const live = all.filter((el) => !el.closest(SKIP_CONTAINERS));
  const junk = live.filter((el) => isJunk(alt(el)));
  const named = live.filter((el) => !isJunk(alt(el)));

  // Resolve each image to the host the extension would actually badge.
  const tiles = new Map();
  const noTile = [];
  for (const el of named) {
    const tile = el.closest(CARD_TILE);
    if (!tile) {
      noTile.push(el);
      continue;
    }
    if (!tiles.has(tile)) tiles.set(tile, []);
    tiles.get(tile).push(el);
  }

  console.table([
    { stage: `${CARD_HOST} on page`, count: all.length },
    { stage: 'in skip containers', count: skipped.length },
    { stage: 'junk alt (Front/Back/…)', count: junk.length },
    { stage: 'badgeable images', count: named.length },
    { stage: `distinct ${CARD_TILE} tiles`, count: tiles.size },
    { stage: 'no tile ancestor (!)', count: noTile.length },
  ]);

  const collisions = [...tiles.entries()].filter(([, g]) => g.length > 1);
  if (collisions.length) {
    console.warn(`${collisions.length} tiles hold more than one image — these share a badge:`);
    collisions.slice(0, 6).forEach(([t, g]) =>
      console.log('   ', describe(t), '←', g.map(alt))
    );
  }
  if (noTile.length) {
    console.warn(`${noTile.length} images have no ${CARD_TILE} ancestor — they fall back to closest('a, div'):`);
    noTile.slice(0, 8).forEach((el) =>
      console.log('   ', JSON.stringify(alt(el)), '| parent:', describe(el.parentElement))
    );
  }

  // Did every tile we expected to badge actually get one?
  const badges = [...document.querySelectorAll('.edhrec-badge')];
  const missing = [...tiles.keys()].filter((t) => !t.querySelector(':scope > .edhrec-badge'));
  const strays = badges.filter((b) => !b.parentElement?.matches(CARD_TILE));

  console.log(
    `%cbadges: ${badges.length} injected / ${tiles.size} expected`,
    badges.length === tiles.size ? 'color:#15803d;font-weight:bold' : 'color:#dc2626;font-weight:bold'
  );
  if (missing.length) {
    console.warn(`${missing.length} tiles missing a badge:`);
    missing.slice(0, 10).forEach((t) =>
      console.log('   ', describe(t), '|', JSON.stringify(alt(t.querySelector(CARD_HOST) || t)))
    );
  }
  if (strays.length) {
    console.warn(`${strays.length} badges are NOT on a ${CARD_TILE} tile:`);
    strays.slice(0, 10).forEach((b) => console.log('   host:', describe(b.parentElement), '|', b.textContent));
  }
  if (!missing.length && !strays.length && badges.length) {
    console.log('%c✓ every badgeable tile has exactly one badge, and none landed elsewhere', 'color:#15803d');
  }

  // --- Hover preview -------------------------------------------------------
  // Hover a card first so the preview is populated, THEN run this.
  console.group('hover preview');
  const previews = [...document.querySelectorAll('.deckview-image-wrapper')];
  console.log('.deckview-image-wrapper:', previews.length);
  previews.forEach((pv, i) => {
    const imgs = [...pv.querySelectorAll('img')];
    const badge = pv.querySelector(':scope > .edhrec-badge');
    console.log(`  [${i}]`, describe(pv));
    console.log('      images:', imgs.map((im) => ({ alt: alt(im), src: (im.getAttribute('src') || '').slice(-40) })));
    console.log('      asset ids:', imgs.map((im) => ((im.getAttribute('src') || '').match(/\/cards\/card-([A-Za-z0-9]+)-/) || [])[1]));
    console.log('      badge:', badge ? `${badge.textContent} (${badge.dataset.cardName})` : 'NONE');
  });
  console.groupEnd();

  // --- Text views (table / list) -------------------------------------------
  // Run this again after switching view mode; the grid selectors will read 0
  // and this section is what tells us how to anchor instead.
  console.group('text views');
  const isCardPage = (href) => {
    try {
      const u = new URL(href, location.href);
      return (
        u.hostname === location.hostname &&
        /^\/cards\/[^/]+\/?$/.test(u.pathname) &&
        !/\.(?:jpe?g|png|webp|gif|avif|svg)$/i.test(u.pathname)
      );
    } catch {
      return false;
    }
  };
  const cardLinks = [...document.querySelectorAll('a[href*="/cards/"]')].filter((a) =>
    isCardPage(a.getAttribute('href'))
  );
  console.log('real card-page links:', cardLinks.length, '| url:', location.href);

  if (cardLinks.length) {
    const a = cardLinks[0];
    console.log('sample link text:', JSON.stringify(a.textContent.trim()));
    console.log('sample href     :', a.getAttribute('href'));

    // Walk up until we hit the element that repeats once per card — that is
    // the row we would anchor a badge to.
    let row = a;
    for (let i = 0; i < 8 && row.parentElement; i++) {
      const parent = row.parentElement;
      const sig = (el) => el.tagName + '.' + String(el.className || '').trim().split(/\s+/).join('.');
      const twins = [...parent.children].filter((c) => sig(c) === sig(row));
      if (twins.length > 2) {
        console.log(`repeating row (${twins.length} siblings):`, describe(row));
        console.log('   parent          :', describe(parent));
        console.log('   row is positioned:', getComputedStyle(row).position);
        console.log('   row text        :', JSON.stringify(row.textContent.trim().slice(0, 70)));
        break;
      }
      row = parent;
    }

    const chain = [];
    for (let el = a, i = 0; el && i < 7; el = el.parentElement, i++) chain.push(describe(el));
    console.log('ancestor chain (innermost first):');
    chain.forEach((c, i) => console.log('  '.repeat(i) + '↳ ' + c));
  } else {
    console.warn('no card-page links here — text views may render names as plain text');
  }
  console.groupEnd();

  console.groupEnd();
})();
