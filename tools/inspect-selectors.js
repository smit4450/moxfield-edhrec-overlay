/**
 * Selector diagnostic — paste into the devtools console on a Moxfield DECK page.
 *
 * Round 2. Round 1 established that `.img-card` matches (88 elements on a live
 * page) while the link-based candidates matched nothing, and that
 * `a[href*="/cards/"]` is a trap because image-download buttons live under
 * assets.moxfield.net/cards/*.jpg.
 *
 * This pass answers what's left: are we anchoring badges to the right element,
 * and does every card actually get one?
 *
 * Not part of the extension; never shipped.
 */

(() => {
  const describe = (el) =>
    !el
      ? '(none)'
      : el.tagName.toLowerCase() +
        (el.id ? '#' + el.id : '') +
        (el.className ? '.' + String(el.className).trim().split(/\s+/).slice(0, 4).join('.') : '');

  const cards = [...document.querySelectorAll('.img-card')];
  console.group('%cMoxfield selector check — round 2', 'font-weight:bold;font-size:13px');
  console.log('.img-card matches:', cards.length);

  // --- 1. What kind of element is .img-card, and does it carry the name? ---
  const tags = {};
  let withAlt = 0;
  const noAlt = [];
  for (const el of cards) {
    tags[el.tagName] = (tags[el.tagName] || 0) + 1;
    const alt = (el.getAttribute('alt') || '').trim();
    if (alt) withAlt++;
    else noAlt.push(el);
  }
  console.log('tag distribution:', tags);
  console.log(`carry a non-empty alt: ${withAlt}/${cards.length}`);
  console.log('sample alts:', cards.slice(0, 6).map((e) => e.getAttribute('alt')));
  if (noAlt.length) {
    console.warn(`${noAlt.length} .img-card without alt — these lose their name:`);
    noAlt.slice(0, 8).forEach((e) => console.log('   ', describe(e), '| parent:', describe(e.parentElement)));
  }

  // --- 2. Host anchoring: does closest('a,div') collapse distinct cards? ---
  const strategies = {
    "closest('a, div')  [current]": (el) => el.closest('a, div') || el,
    'parentElement': (el) => el.parentElement || el,
    'the .img-card itself': (el) => el,
  };
  const rows = [];
  for (const [label, fn] of Object.entries(strategies)) {
    const hosts = new Map();
    for (const el of cards) {
      const h = fn(el);
      if (!hosts.has(h)) hosts.set(h, []);
      hosts.get(h).push(el);
    }
    const collisions = [...hosts.values()].filter((g) => g.length > 1);
    rows.push({
      strategy: label,
      distinctHosts: hosts.size,
      lostToCollision: cards.length - hosts.size,
      collidingGroups: collisions.length,
    });
    if (collisions.length && label.includes('current')) {
      console.warn('collisions under the current strategy (these share one badge):');
      collisions.slice(0, 6).forEach((g) => {
        console.log('   host:', describe(g[0].closest('a, div')));
        g.forEach((e) => console.log('      ↳ alt:', JSON.stringify(e.getAttribute('alt'))));
      });
    }
  }
  console.table(rows);

  // --- 3. Are distinct card NAMES preserved? ---
  const names = new Set(cards.map((e) => (e.getAttribute('alt') || '').trim()).filter(Boolean));
  console.log('distinct card names among .img-card:', names.size);

  // --- 4. Classify every /cards/ link: real page vs image asset. ---
  const links = [...document.querySelectorAll('a[href*="/cards/"]')];
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
  const pages = links.filter((a) => isCardPage(a.getAttribute('href')));
  console.log(`a[href*="/cards/"]: ${links.length} total → ${pages.length} real card pages, ${links.length - pages.length} image assets`);
  if (pages.length) console.log('   sample real card href:', pages[0].getAttribute('href'));

  // --- 5. Where did badges actually land? ---
  const badges = [...document.querySelectorAll('.edhrec-badge')];
  console.log(`%cbadges injected: ${badges.length}`, badges.length ? 'color:#15803d' : 'color:#dc2626');
  const offParents = {};
  for (const b of badges) {
    const k = describe(b.offsetParent);
    offParents[k] = (offParents[k] || 0) + 1;
  }
  console.log('badge offsetParent distribution (should be the card tile, not a page-level panel):');
  console.table(
    Object.entries(offParents)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([host, count]) => ({ host, count }))
  );

  console.groupEnd();
})();
