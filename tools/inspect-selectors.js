/**
 * Selector diagnostic — paste into the devtools console on a Moxfield DECK page.
 *
 * Mirrors the production logic in src/moxfield-dom.js and reports where it
 * disagrees with reality, so a Moxfield deploy that breaks the overlay shows up
 * as a concrete number rather than "no badges appeared".
 *
 * Baseline from 2026-09-09 (a 78-distinct-name deck):
 *   .img-card                 88   all <img>, all with a non-empty alt
 *   in skip containers        11   7 sample-hand + 2 sidebar previews x 2 faces
 *   junk alts                  3   "Transform", "Front", "Back"
 *   badgeable tiles           77
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

  console.groupEnd();
})();
