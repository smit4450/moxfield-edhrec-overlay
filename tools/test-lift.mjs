/**
 * Unit test: EDHREC's switch from Synergy to Lift.  Run: node tools/test-lift.mjs
 *
 * On 2026-10-01 EDHREC replaced synergy with lift on its site and renamed
 * "High Synergy Cards" to "High Lift Cards". Nothing errored. The drawer
 * matches curated lists by exact header, so it filed the renamed list with the
 * bulk type lists - collapsed to zero rows, below the other curated sections -
 * and the tooltip lost the list's chip. verify-autorun could not notice: a
 * misfiled list still sorts after the curated ones, so its ordering check held.
 *
 * EDHREC still sends synergy as well, for now. If it stops, everything keyed on
 * it empties without a sound, which is why the background fills in whichever
 * of the two figures is missing and why the drawer ranks by lift.
 *
 * Three layers, each against a fixed payload. No network and no Moxfield, so
 * this is deterministic and runs headless:
 *
 *   background  indexCommanderPage keeps lift and derives the missing figure,
 *               checked against EDHREC's own numbers for real cards
 *   panel       the renamed list is curated, rows show lift, and the default
 *               sort and the Cuts tab rank by it - even with no synergy
 *   tooltip     the real content script, on a minimal Moxfield-shaped page,
 *               shows lift and synergy and keeps the list chip
 */

import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(root, 'src', f), 'utf8');

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? '  ' + detail : ''}`);
};

// Real figures from EDHREC's Xyris, the Writhing Storm page, 2026-10-01.
const ORCRIST = { name: 'Orcrist, Goblin-cleaver', synergy: 0.05101006271883821, lift: 9.354848154960772, num_decks: 179, potential_decks: 3134 };
const SOL_RING = { name: 'Sol Ring', synergy: -0.007440933245842829, lift: 0.9909732264170337, num_decks: 16166, potential_decks: 19790 };
const SIGNET = { name: 'Arcane Signet', synergy: 0.03625105924383265, lift: 1.0505587818039885, num_decks: 14907, potential_decks: 19790 };
const without = (card, key) => Object.fromEntries(Object.entries(card).filter(([k]) => k !== key));

// --- background: indexCommanderPage ------------------------------------------
// The real src/background.js under stubbed extension APIs, as in
// test-lookup.mjs, but fed a fixed page instead of the live API.
console.log('background');
globalThis.browser = {
  storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
  runtime: { onMessage: { addListener: () => {} } },
};
const { indexCommanderPage } = await (0, eval)(
  `(async () => { ${read('background.js')}\n; return { indexCommanderPage }; })()`
);

const indexed = indexCommanderPage({
  container: {
    json_dict: {
      cardlists: [
        { header: 'High Lift Cards', tag: 'highliftcards', cardviews: [ORCRIST] },
        // Sol Ring as EDHREC would send it once synergy is retired, and Arcane
        // Signet as a page from before lift existed.
        { header: 'Mana Artifacts', tag: 'manaartifacts', cardviews: [without(SOL_RING, 'synergy'), without(SIGNET, 'lift')] },
      ],
    },
  },
});
const near = (a, b) => typeof a === 'number' && Math.abs(a - b) < 1e-9;
const orc = indexed.stats['orcrist, goblin-cleaver'];
check(orc?.lift === ORCRIST.lift && orc?.synergy === ORCRIST.synergy, 'lift and synergy are both kept as sent');
const sol = indexed.stats['sol ring'];
check(near(sol?.synergy, SOL_RING.synergy), 'synergy derived from lift matches EDHREC', `(${sol?.synergy} vs ${SOL_RING.synergy})`);
const signet = indexed.stats['arcane signet'];
check(near(signet?.lift, SIGNET.lift), 'lift derived from synergy matches EDHREC', `(${signet?.lift} vs ${SIGNET.lift})`);
check(indexed.lists[0]?.header === 'High Lift Cards', 'list headers pass through unchanged', `(${indexed.lists[0]?.header})`);

// --- browser layers ------------------------------------------------------------
const css = read('badge.css');
const browser = await chromium.launch({ headless: true });

/**
 * The messenger every content-side script captures at evaluation time, so it
 * must be installed BEFORE they run - see test-panel-deckswitch.mjs.
 */
const installStub = (page, edhrec) =>
  page.evaluate((edhrec) => {
    globalThis.chrome = {
      runtime: {
        sendMessage: async (msg) => {
          if (msg.type === 'lookup-ranks') {
            return { ok: true, ranks: Object.fromEntries(msg.names.map((n) => [n, { rank: 1000, name: n }])) };
          }
          if (msg.type === 'lookup-edhrec') return { ok: true, ...edhrec };
          if (msg.type === 'lookup-prices') return { ok: true, prices: {} };
          if (msg.type === 'lookup-combos') return { ok: true, included: [], almost: [] };
          if (msg.type === 'lookup-average') return { ok: true, cards: [] };
          return { ok: false };
        },
      },
    };
  }, edhrec);

const sections = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.edhrec-panel-section')].map((s) => ({
      title: s.querySelector('.edhrec-panel-title')?.textContent,
      rows: [...s.querySelectorAll('.edhrec-panel-row')].map((r) => {
        const lift = r.querySelector('.edhrec-panel-lift');
        return {
          name: r.querySelector('.edhrec-panel-name')?.textContent,
          lift: lift?.textContent ?? null,
          tone: lift?.classList.contains('edhrec-tip-pos') ? 'pos' : lift?.classList.contains('edhrec-tip-neg') ? 'neg' : null,
        };
      }),
    }))
  );
const names = (sec) => (sec?.rows || []).map((r) => r.name).join(', ');

try {
  // --- panel ------------------------------------------------------------------
  console.log('\npanel');
  const page = await browser.newPage({ viewport: { width: 900, height: 1200 } });
  page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
  await page.setContent(`<style>${css}</style>`);
  await installStub(page, {});
  await page.evaluate(read('panel.js'));

  const state = {
    deckId: '/decks/LIFT',
    commander: 'Xyris, the Writhing Storm',
    commanders: ['Xyris, the Writhing Storm'],
    lists: [
      // EDHREC's own order, which leads with New Cards.
      { header: 'New Cards', cards: ['Orcrist, Goblin-cleaver'] },
      // Deliberately not in lift order, so the sort has something to do.
      { header: 'High Lift Cards', cards: ["Samut, Hazoret's Champion", 'Orcrist, Goblin-cleaver', 'Warg Tactics'] },
      { header: 'Creatures', cards: ['Warg Tactics'] },
    ],
    stats: {
      'orcrist, goblin-cleaver': { name: 'Orcrist, Goblin-cleaver', lift: ORCRIST.lift, synergy: ORCRIST.synergy, inclusion: 0.057 },
      'warg tactics': { name: 'Warg Tactics', lift: 3.283, synergy: 0.0097, inclusion: 0.014 },
      "samut, hazoret's champion": { name: "Samut, Hazoret's Champion", lift: 2.077, synergy: 0.0269, inclusion: 0.052 },
      // The deck's own cards, for Cuts. Pet Card has lift and no synergy: the
      // drawer must rank it, not file it under "not in EDHREC's lists".
      'pet card': { name: 'Pet Card', lift: 0.4, inclusion: 0.01 },
      filler: { name: 'Filler', lift: 0.8, synergy: -0.01, inclusion: 0.04 },
      staple: { name: 'Staple', lift: SOL_RING.lift, synergy: SOL_RING.synergy, inclusion: 0.82 },
      'good card': { name: 'Good Card', lift: 1.6, synergy: 0.02, inclusion: 0.05 },
    },
    salt: {},
    deck: ['pet card', 'filler', 'staple', 'good card', 'xyris, the writhing storm'],
    deckCards: ['Good Card', 'Staple', 'Pet Card', 'Filler', 'Xyris, the Writhing Storm'].map((name) => ({ name, canonical: name })),
    mismatch: null,
  };
  await page.evaluate((s) => globalThis.EdhrecPanel.update({ ...s, deck: new Set(s.deck) }), state);
  await page.click('.edhrec-panel-launcher');

  let add = await sections(page);
  check(add[0]?.title === 'High Lift Cards', 'the renamed list leads the drawer', `(${add.map((s) => s.title).join(' / ')})`);
  check(add[0]?.rows.length === 3, 'and is open, not collapsed behind "Show all"', `(${add[0]?.rows.length} rows)`);
  check(add[0]?.rows[0]?.lift === '9.4x', 'rows show lift as EDHREC prints it', `(${add[0]?.rows[0]?.lift})`);
  check(
    names(add[0]) === "Orcrist, Goblin-cleaver, Warg Tactics, Samut, Hazoret's Champion",
    'sorted by lift by default',
    `(${names(add[0])})`
  );

  await page.locator('.edhrec-panel-sortbtn', { hasText: 'Synergy' }).click();
  add = await sections(page);
  check(
    names(add[0]) === "Orcrist, Goblin-cleaver, Samut, Hazoret's Champion, Warg Tactics",
    'synergy is still a sort option',
    `(${names(add[0])})`
  );

  await page.locator('.edhrec-panel-tab', { hasText: 'Cuts' }).first().click();
  const cuts = await sections(page);
  const lowest = cuts.find((s) => s.title === 'Lowest lift');
  check(
    names(lowest) === 'Pet Card, Filler, Staple, Good Card',
    'Cuts ranks by lift, including a card with no synergy',
    `(${cuts.map((s) => `${s.title}: ${names(s)}`).join(' | ')})`
  );
  const tones = Object.fromEntries((lowest?.rows || []).map((r) => [r.name, `${r.lift} ${r.tone}`]));
  check(
    tones['Filler'] === '0.8x neg' && tones['Staple'] === '1.0x null' && tones['Good Card'] === '1.6x pos',
    'lift is red below 1x, green above, and neutral at 1.0x',
    `(${Object.values(tones).join(', ')})`
  );
  await page.close();

  // --- tooltip ------------------------------------------------------------------
  // The real adapter, panel and content script, in manifest order, on the
  // smallest page the adapter recognises: card tiles whose element id ends in a
  // card id, and the og:description Moxfield names the commander in.
  console.log('\ntooltip');
  const tip = await browser.newPage({ viewport: { width: 900, height: 900 } });
  tip.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
  await tip.setContent(`<!doctype html>
    <head><meta property="og:description" content="A Commander deck featuring Xyris, the Writhing Storm by tester"></head>
    <body>
      <style>${css}</style>
      <div id="vd-Orcr1"><img class="img-card" alt="Orcrist, Goblin-cleaver" width="200" height="280"></div>
      <div id="vd-SolR1"><img class="img-card" alt="Sol Ring" width="200" height="280"></div>
    </body>`);
  const inc = (c) => c.num_decks / c.potential_decks;
  const stat = (c, lists) => ({
    name: c.name,
    lift: c.lift,
    synergy: c.synergy,
    inclusion: inc(c),
    numDecks: c.num_decks,
    potentialDecks: c.potential_decks,
    lists,
  });
  await installStub(tip, {
    stats: {
      'orcrist, goblin-cleaver': stat(ORCRIST, ['New Cards', 'High Lift Cards']),
      'sol ring': stat(SOL_RING, ['Mana Artifacts']),
    },
    lists: [{ header: 'High Lift Cards', cards: ['Orcrist, Goblin-cleaver'] }],
    commanderCard: null,
    salt: {},
    matched: true,
  });
  for (const f of ['moxfield-dom.js', 'panel.js', 'content.js']) await tip.evaluate(read(f));

  // EDHREC data lands after the badges, and repaints their labels in place.
  await tip.waitForFunction(
    () => /Lift/.test(document.querySelector('.edhrec-badge[data-card-name^="Orcrist"]')?.getAttribute('aria-label') || ''),
    null,
    { timeout: 10000 }
  );
  const label = await tip.getAttribute('.edhrec-badge[data-card-name^="Orcrist"]', 'aria-label');
  check(/Lift 9\.4x/.test(label), 'tooltip shows lift as EDHREC prints it', `(${label})`);
  check(/Synergy \+5\.1%/.test(label), 'and synergy alongside it');
  check(/High Lift Cards/.test(label), 'the renamed list keeps its chip');

  const liftTone = async (card) => {
    await tip.focus(`.edhrec-badge[data-card-name="${card}"]`);
    return tip.evaluate(() => {
      const row = [...document.querySelectorAll('.edhrec-tip .edhrec-tip-row')].find(
        (r) => r.querySelector('.edhrec-tip-label')?.textContent === 'Lift'
      );
      const v = row?.querySelector('.edhrec-tip-value');
      return v ? `${v.textContent} ${v.classList.contains('edhrec-tip-pos') ? 'pos' : v.classList.contains('edhrec-tip-neg') ? 'neg' : 'neutral'}` : null;
    });
  };
  const orcTone = await liftTone('Orcrist, Goblin-cleaver');
  const solTone = await liftTone('Sol Ring');
  check(orcTone === '9.4x pos' && solTone === '1.0x neutral', 'tooltip colours lift the same way', `(${orcTone}; ${solTone})`);
} catch (err) {
  failures++;
  console.log('FAILED:', err.message.split('\n')[0]);
} finally {
  await browser.close();
}

console.log(failures === 0 ? '\nPASS' : `\nFAIL - ${failures} check(s) failed`);
process.exitCode = failures ? 1 : 0;
