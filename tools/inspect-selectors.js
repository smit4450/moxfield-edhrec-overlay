/**
 * Selector diagnostic — paste into the devtools console on a Moxfield DECK page.
 *
 * Reports whether the selectors in src/moxfield-dom.js actually match anything,
 * and if not, dumps enough structure to write correct ones.
 *
 * Not part of the extension; never shipped.
 */

(() => {
  const CANDIDATES = [
    '.img-card',
    '[class*="visual-spoiler"] a[href*="/cards/"]',
    'a[href*="/cards/"] img',
  ];

  console.group('%cMoxfield selector check', 'font-weight:bold;font-size:13px');

  console.table(
    CANDIDATES.map((selector) => ({ selector, matches: document.querySelectorAll(selector).length }))
  );

  const links = document.querySelectorAll('a[href*="/cards/"]');
  const imgs = document.querySelectorAll('img[alt]');
  console.log('all /cards/ links:', links.length, '| all img[alt]:', imgs.length);

  const describe = (el) =>
    el.tagName.toLowerCase() +
    (el.id ? '#' + el.id : '') +
    (el.className ? '.' + String(el.className).trim().split(/\s+/).join('.') : '');

  const sample = links[0] || imgs[0];
  if (!sample) {
    console.warn('No card links or alt-tagged images found. Is this a deck page, fully loaded?');
  } else {
    console.log('sample element:', describe(sample));
    console.log('sample href:', sample.getAttribute('href'));

    const img = sample.tagName === 'IMG' ? sample : sample.querySelector('img');
    if (img) console.log('sample img alt:', JSON.stringify(img.getAttribute('alt')));

    const chain = [];
    for (let el = sample, i = 0; el && i < 6; el = el.parentElement, i++) chain.push(describe(el));
    console.log('ancestor chain (innermost first):');
    chain.forEach((c, i) => console.log('  '.repeat(i) + '↳ ' + c));
  }

  const badges = document.querySelectorAll('.edhrec-badge').length;
  console.log(`%cbadges currently injected: ${badges}`, badges ? 'color:#15803d' : 'color:#dc2626');

  console.groupEnd();
})();
