/**
 * Recommendations panel: EDHREC cards for this commander that the deck does
 * not already run.
 *
 * Anchored to <body> rather than injected into Moxfield's own sections. That is
 * deliberate. Appending "ghost" cards into the Creatures/Instants containers
 * would mean fighting React's reconciliation in three different layouts, keyed
 * off build-hashed class names; a surface we own is untouched by any of that
 * and behaves identically in all six view styles. It is the same reasoning that
 * made the tooltip a singleton on <body>.
 *
 * Owns no data. content.js calls update() whenever the commander data or the
 * deck contents change.
 */

globalThis.EdhrecPanel = (() => {
  const api = globalThis.browser ?? globalThis.chrome;

  /**
   * EDHREC returns ~265 recommendations against a ~67-card deck, so ~200 are
   * "missing" — far too many to dump in a list. These four are the curated
   * ones and carry most of the value; everything else is a bulk type list that
   * stays collapsed behind a "show all".
   */
  const CURATED = ['High Synergy Cards', 'Top Cards', 'Game Changers', 'New Cards'];

  const PREVIEW_ROWS = 8; // rows shown before a bulk section is expanded

  let state = {
    lists: [],
    stats: {},
    salt: {},
    deck: new Set(),
    deckCards: [],
    commander: '',
    mismatch: null,
  };

  /** "add" = recommendations not in the deck; "cuts" = the deck, worst first. */
  let tab = 'add';

  /**
   * Prices, fetched lazily for whatever is on screen rather than for all ~216
   * recommendations. Opening the drawer costs one request for the curated
   * rows; expanding a type list costs one more. Most sessions never expand
   * anything, so fetching everything up front would be mostly waste.
   */
  const prices = new Map(); // card name -> { usd, foil } | null
  let pricesPending = false;
  let root = null;
  let open = false;
  let sortBy = 'synergy';
  const expanded = new Set();
  const picked = new Set();

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    // textContent throughout: card names come off the page and out of an API.
    if (text != null) n.textContent = text;
    return n;
  };

  const pct = (n) => `${(n * 100).toFixed(1)}%`;

  /** Foil-only cards have a null `usd`, so fall back rather than show nothing. */
  const usdOf = (p) => (p ? (p.usd ?? p.foil ?? null) : null);
  const money = (n) => (n >= 100 ? `$${Math.round(n).toLocaleString()}` : `$${n.toFixed(2)}`);

  /**
   * Price bands, in dollars. Card prices span four orders of magnitude, so a
   * single "expensive" colour puts a $20 card and a $1,600 card in the same
   * bucket. These are the boundaries a Commander player actually thinks in:
   * pocket change, cheap, a real pick, an investment, and so on up.
   *
   * The ramp deliberately runs dim -> neutral -> warm -> hot rather than
   * green -> red: green already means positive synergy one column to the left,
   * and a cheap card should recede rather than announce itself.
   */
  const PRICE_BANDS = [1, 5, 20, 50, 100, 500];
  function priceTier(usd) {
    let i = 0;
    while (i < PRICE_BANDS.length && usd >= PRICE_BANDS[i]) i++;
    return i; // 0 (under $1) .. 6 ($500+)
  }
  const norm = (s) => s.split('//')[0].trim().toLowerCase();

  /** The EDHREC cardview id is a Scryfall card id, so images need no API call. */
  const imageFor = (id) =>
    id ? `https://cards.scryfall.io/normal/front/${id[0]}/${id[1]}/${id}.jpg` : null;

  /**
   * The deck's own cards, worst first.
   *
   * This is the shape of Moxfield's most-requested EDHREC feature (53 votes,
   * open three years): "sort cards by EDHREC rank ... would help a lot in
   * getting rid of cards that aren't useful when trying to trim your deck".
   * The ask is phrased as sorting, but the goal is finding cuts - so rather
   * than reorder Moxfield's React-managed list, the same answer is given in a
   * surface we own.
   *
   * Cards EDHREC does not list for this commander are separated out rather
   * than sorted to the bottom: "nobody plays this with your commander" is a
   * different statement from "this has low synergy", and conflating them would
   * bury every pet card in with the genuine duds.
   */
  function cutCandidates() {
    const rated = [];
    const unlisted = [];
    for (const card of state.deckCards) {
      const stat = state.stats[card.name.toLowerCase()] ?? state.stats[norm(card.name)];
      const merged = { ...card, ...(stat || {}) };
      if (stat && typeof stat.synergy === 'number') rated.push(merged);
      else unlisted.push(merged);
    }
    rated.sort((a, b) => a.synergy - b.synergy);
    unlisted.sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0));
    return { rated, unlisted };
  }

  /**
   * Deck salt, from EDHREC's global top-100 saltiest.
   *
   * Moxfield's second-most-requested EDHREC feature (43 votes) asks for exactly
   * this: "a salt sum calculator with a list of the salty cards in a given
   * deck". Only top-100 cards can contribute, which is stated in the UI rather
   * than quietly implied - a total that silently ignores most of the card pool
   * would be worse than no total.
   */
  function saltSummary() {
    const hits = [];
    let total = 0;
    for (const card of state.deckCards) {
      const v = state.salt[card.name.toLowerCase()] ?? state.salt[norm(card.name)];
      if (typeof v === 'number') {
        hits.push({ ...card, salt: v });
        total += v;
      }
    }
    hits.sort((a, b) => b.salt - a.salt);
    return { hits, total };
  }

  /** Ask the background for any on-screen card whose price we do not have yet. */
  function ensurePrices(cards) {
    if (pricesPending) return;
    const need = cards.filter((c) => !prices.has(c.name)).slice(0, 75);
    if (!need.length) return;

    pricesPending = true;
    // By name, not by EDHREC's card id: those ids point at arbitrary printings
    // (its Volcanic Island is Beta, unpriced in USD), and the useful number is
    // the cheapest printing you could actually buy.
    Promise.resolve(api.runtime.sendMessage({ type: 'lookup-prices', names: need.map((c) => c.name) }))
      .then((res) => {
        if (!res?.ok) return;
        for (const c of need) prices.set(c.name, res.prices[c.name] ?? null);
        render();
      })
      .catch((err) => console.warn('[edhrec-overlay] price lookup failed:', err.message))
      .finally(() => {
        pricesPending = false;
      });
  }

  /** Recommendations the deck does not already contain, grouped as EDHREC has them. */
  function missingByList() {
    const out = [];
    for (const list of state.lists) {
      const cards = list.cards
        .filter((name) => !state.deck.has(norm(name)))
        .map((name) => state.stats[name.toLowerCase()] || { name })
        .sort((a, b) => {
          if (sortBy === 'inclusion') return (b.inclusion ?? -1) - (a.inclusion ?? -1);
          if (sortBy === 'price') {
            // Cheapest first, and anything unpriced sinks to the bottom rather
            // than masquerading as free.
            const pa = usdOf(prices.get(a.name));
            const pb = usdOf(prices.get(b.name));
            return (pa ?? Infinity) - (pb ?? Infinity);
          }
          return (b.synergy ?? -Infinity) - (a.synergy ?? -Infinity);
        });
      if (cards.length) out.push({ header: list.header, cards, curated: CURATED.includes(list.header) });
    }
    // Curated lists first, in CURATED order rather than EDHREC's own. EDHREC
    // leads with "New Cards", but a card being new says nothing about whether
    // it belongs here; High Synergy is the reason to open the panel at all.
    // Sort is stable, so the bulk type lists keep EDHREC's ordering.
    const rank = (s) => (s.curated ? CURATED.indexOf(s.header) : CURATED.length);
    return out.sort((a, b) => rank(a) - rank(b));
  }

  function buildRow(card) {
    const row = el('div', 'edhrec-panel-row');

    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'edhrec-panel-check';
    box.checked = picked.has(card.name);
    box.addEventListener('change', () => {
      if (box.checked) picked.add(card.name);
      else picked.delete(card.name);
      refreshFooter();
    });
    row.append(box);

    const main = el('div', 'edhrec-panel-main');
    main.append(el('div', 'edhrec-panel-name', card.name));

    const meta = el('div', 'edhrec-panel-meta');
    if (typeof card.synergy === 'number') {
      const tone = card.synergy >= 0 ? 'pos' : 'neg';
      meta.append(el('span', `edhrec-panel-syn edhrec-tip-${tone}`, `${card.synergy >= 0 ? '+' : ''}${pct(card.synergy)}`));
    }
    if (typeof card.inclusion === 'number') {
      meta.append(el('span', 'edhrec-panel-inc', pct(card.inclusion)));
      const bar = el('span', 'edhrec-panel-bar');
      const fill = document.createElement('i');
      fill.style.width = `${Math.max(0, Math.min(1, card.inclusion)) * 100}%`;
      bar.append(fill);
      meta.append(bar);
    }
    if (card.rank != null) meta.append(el('span', 'edhrec-panel-rank', `#${card.rank.toLocaleString()}`));
    if (typeof card.salt === 'number') {
      meta.append(el('span', 'edhrec-panel-chip is-salt', `Salt ${card.salt.toFixed(2)}`));
    }
    main.append(meta);
    row.append(main);

    const usd = usdOf(prices.get(card.name));
    // An em dash rather than a blank, matching the badge: an empty cell reads
    // as a rendering gap, not as "no price known".
    const price = el('div', 'edhrec-panel-price', usd == null ? '—' : money(usd));
    if (usd == null) price.classList.add('is-unknown');
    else price.classList.add(`edhrec-price-t${priceTier(usd)}`);
    if (usd != null && usd >= 20) price.classList.add('is-pricey');
    row.append(price);

    const img = imageFor(card.id);
    if (img) {
      row.addEventListener('mouseenter', () => showImage(row, img, card.name));
      row.addEventListener('mouseleave', hideImage);
    }
    return row;
  }

  function buildSection(section) {
    const wrap = el('div', 'edhrec-panel-section');
    const head = el('div', 'edhrec-panel-head');
    head.append(el('span', 'edhrec-panel-title', section.header));
    head.append(el('span', 'edhrec-panel-count', String(section.cards.length)));
    wrap.append(head);

    const isOpen = section.curated || expanded.has(section.header);
    const shown = isOpen ? section.cards : section.cards.slice(0, 0);
    for (const c of shown) wrap.append(buildRow(c));

    if (!section.curated) {
      const more = el('button', 'edhrec-panel-more', isOpen ? 'Hide' : `Show all ${section.cards.length}`);
      more.addEventListener('click', () => {
        if (expanded.has(section.header)) expanded.delete(section.header);
        else expanded.add(section.header);
        render();
      });
      wrap.append(more);
    } else if (section.cards.length > PREVIEW_ROWS) {
      // Curated lists are small by construction, but guard anyway.
      wrap.querySelectorAll('.edhrec-panel-row').forEach((r, i) => {
        if (i >= PREVIEW_ROWS) r.remove();
      });
    }
    return wrap;
  }

  // --- hover image ----------------------------------------------------------
  let imgEl = null;
  function showImage(row, src, alt) {
    if (!imgEl) {
      imgEl = el('img', 'edhrec-panel-img');
      imgEl.alt = '';
      document.body.appendChild(imgEl);
    }
    imgEl.src = src;
    imgEl.alt = alt;
    const r = row.getBoundingClientRect();
    // Cards are tall; clamp so the image never runs off the top or bottom.
    const top = Math.max(8, Math.min(r.top - 60, window.innerHeight - 320));
    imgEl.style.top = `${Math.round(top)}px`;
    imgEl.style.right = `${Math.round(window.innerWidth - r.left + 12)}px`;
    imgEl.classList.add('is-visible');
  }
  function hideImage() {
    imgEl?.classList.remove('is-visible');
  }

  // --- footer ---------------------------------------------------------------
  function refreshFooter() {
    const foot = root?.querySelector('.edhrec-panel-foot');
    if (!foot) return;
    foot.replaceChildren();

    // Running total is the point of showing prices at all: "should I add these"
    // is a budget question as much as a synergy one.
    let total = 0;
    let unknown = 0;
    for (const n of picked) {
      const usd = usdOf(prices.get(n));
      if (usd == null) unknown++;
      else total += usd;
    }
    const cost = picked.size ? ` · ${money(total)}${unknown ? '+' : ''}` : '';

    const copy = el('button', 'edhrec-panel-copy', picked.size ? `Copy ${picked.size} as list${cost}` : 'Select cards to copy');
    copy.disabled = picked.size === 0;
    copy.addEventListener('click', async () => {
      // We never write to Moxfield's API, so the honest action is a list the
      // user can paste into Moxfield's own bulk import.
      const text = [...picked].map((n) => `1 ${n}`).join('\n');
      try {
        await navigator.clipboard.writeText(text);
        copy.textContent = `Copied ${picked.size}`;
      } catch {
        copy.textContent = 'Copy failed — clipboard blocked';
      }
      setTimeout(refreshFooter, 1400);
    });
    foot.append(copy);

    if (picked.size) {
      const clear = el('button', 'edhrec-panel-clear', 'Clear');
      clear.addEventListener('click', () => {
        picked.clear();
        render();
      });
      foot.append(clear);
    }
  }

  // --- shell ----------------------------------------------------------------
  function ensureRoot() {
    if (root) return root;
    root = el('div', 'edhrec-panel');

    const launcher = el('button', 'edhrec-panel-launcher');
    launcher.addEventListener('click', () => {
      open = !open;
      render();
    });
    root.append(launcher);

    const body = el('div', 'edhrec-panel-body');
    root.append(body);
    document.body.appendChild(root);
    return root;
  }

  function tabButton(key, label, count) {
    const b = el('button', `edhrec-panel-tab${tab === key ? ' is-on' : ''}`, label);
    if (count != null) b.append(el('span', 'edhrec-panel-tabcount', String(count)));
    b.addEventListener('click', () => {
      tab = key;
      render();
    });
    return b;
  }

  function renderAdd(body, sections, total) {
    const shownNow = sections.reduce(
      (n, sec) => n + (sec.curated || expanded.has(sec.header) ? sec.cards.length : 0),
      0
    );
    if (shownNow < total) {
      body.append(el('div', 'edhrec-panel-sub', `Showing ${shownNow} of ${total} — type lists collapsed`));
    }

    const sort = el('div', 'edhrec-panel-sort');
    for (const [key, label] of [
      ['synergy', 'Synergy'],
      ['inclusion', 'Played in'],
      ['price', 'Price'],
    ]) {
      const b = el('button', `edhrec-panel-sortbtn${sortBy === key ? ' is-on' : ''}`, label);
      b.addEventListener('click', () => {
        sortBy = key;
        render();
      });
      sort.append(b);
    }
    body.append(sort);

    for (const sec of sections) body.append(buildSection(sec));
    ensurePrices(sections.filter((sec) => sec.curated || expanded.has(sec.header)).flatMap((sec) => sec.cards));

    const foot = el('div', 'edhrec-panel-foot');
    body.append(foot);
    refreshFooter();
  }

  function renderCuts(body) {
    const { rated, unlisted } = cutCandidates();
    const { hits, total } = saltSummary();

    if (hits.length) {
      const box = el('div', 'edhrec-panel-salt');
      box.append(el('span', 'edhrec-panel-saltnum', total.toFixed(2)));
      box.append(
        el(
          'span',
          'edhrec-panel-saltlbl',
          `total salt across ${hits.length} card${hits.length === 1 ? '' : 's'} — EDHREC's 100 saltiest only`
        )
      );
      body.append(box);
    }

    const sec = (title, cards, note) => {
      if (!cards.length) return;
      const wrap = el('div', 'edhrec-panel-section');
      const head = el('div', 'edhrec-panel-head');
      head.append(el('span', 'edhrec-panel-title', title));
      head.append(el('span', 'edhrec-panel-count', String(cards.length)));
      wrap.append(head);
      if (note) wrap.append(el('div', 'edhrec-panel-sub', note));
      for (const c of cards) wrap.append(buildRow(c));
      body.append(wrap);
    };

    const salty = new Map(hits.map((h) => [h.name, h.salt]));
    const withSalt = (c) => (salty.has(c.name) ? { ...c, salt: salty.get(c.name) } : c);

    sec('Lowest synergy', rated.slice(0, 15).map(withSalt), 'Played least often with your commander relative to everywhere else.');
    sec(
      'Not in EDHREC’s lists',
      unlisted.slice(0, 15).map(withSalt),
      'EDHREC does not list these for this commander at all. Often the real cuts — sometimes the pet cards.'
    );

    ensurePrices([...rated.slice(0, 15), ...unlisted.slice(0, 15)]);

    const foot = el('div', 'edhrec-panel-foot');
    body.append(foot);
    refreshFooter();
  }

  function render() {
    if (!state.lists.length) {
      // EDHREC is the one fragile dependency; with no data there is nothing to
      // offer, so the launcher should not appear at all.
      root?.remove();
      root = null;
      return;
    }

    ensureRoot();
    const sections = missingByList();
    const total = new Set(sections.flatMap((sec) => sec.cards.map((c) => c.name))).size;

    const launcher = root.querySelector('.edhrec-panel-launcher');
    launcher.textContent = open ? '✕' : `${total} recs`;
    launcher.title = open ? 'Close recommendations' : `${total} EDHREC cards not in this deck`;

    root.classList.toggle('is-open', open);
    const body = root.querySelector('.edhrec-panel-body');
    body.replaceChildren();
    if (!open) return;

    const head = el('div', 'edhrec-panel-topbar');
    head.append(el('div', 'edhrec-panel-h1', tab === 'add' ? 'Not in this deck' : 'Trim this deck'));
    if (state.commander) head.append(el('div', 'edhrec-panel-sub', `EDHREC · ${state.commander}`));
    body.append(head);

    const tabs = el('div', 'edhrec-panel-tabs');
    tabs.append(tabButton('add', 'Add', total));
    tabs.append(tabButton('cuts', 'Cuts', state.deckCards.length || null));
    body.append(tabs);

    if (state.mismatch) {
      body.append(
        el(
          'div',
          'edhrec-panel-warn',
          `Only ${state.mismatch.seen} of ${state.mismatch.stated} cards are visible — a filter may be active, so this list may be wrong.`
        )
      );
    }

    if (tab === 'add') renderAdd(body, sections, total);
    else renderCuts(body);
  }

  /** Called by content.js whenever the commander data or deck contents change. */
  function update(next) {
    state = { ...state, ...next };
    render();
  }

  return { update };
})();
