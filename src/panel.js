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
  /**
   * EDHREC returns ~265 recommendations against a ~67-card deck, so ~200 are
   * "missing" — far too many to dump in a list. These four are the curated
   * ones and carry most of the value; everything else is a bulk type list that
   * stays collapsed behind a "show all".
   */
  const CURATED = ['High Synergy Cards', 'Top Cards', 'Game Changers', 'New Cards'];

  const PREVIEW_ROWS = 8; // rows shown before a bulk section is expanded

  let state = { lists: [], stats: {}, deck: new Set(), commander: '', mismatch: null };
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
  const norm = (s) => s.split('//')[0].trim().toLowerCase();

  /** The EDHREC cardview id is a Scryfall card id, so images need no API call. */
  const imageFor = (id) =>
    id ? `https://cards.scryfall.io/normal/front/${id[0]}/${id[1]}/${id}.jpg` : null;

  /** Recommendations the deck does not already contain, grouped as EDHREC has them. */
  function missingByList() {
    const out = [];
    for (const list of state.lists) {
      const cards = list.cards
        .filter((name) => !state.deck.has(norm(name)))
        .map((name) => state.stats[name.toLowerCase()] || { name })
        .sort((a, b) =>
          sortBy === 'inclusion'
            ? (b.inclusion ?? -1) - (a.inclusion ?? -1)
            : (b.synergy ?? -Infinity) - (a.synergy ?? -Infinity)
        );
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
    main.append(meta);
    row.append(main);

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

    const copy = el('button', 'edhrec-panel-copy', picked.size ? `Copy ${picked.size} as list` : 'Select cards to copy');
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
    const total = new Set(sections.flatMap((s) => s.cards.map((c) => c.name))).size;

    const launcher = root.querySelector('.edhrec-panel-launcher');
    launcher.textContent = open ? '✕' : `${total} recs`;
    launcher.title = open ? 'Close recommendations' : `${total} EDHREC cards not in this deck`;

    root.classList.toggle('is-open', open);
    const body = root.querySelector('.edhrec-panel-body');
    body.replaceChildren();
    if (!open) return;

    const shownNow = sections.reduce(
      (n, s) => n + (s.curated || expanded.has(s.header) ? s.cards.length : 0),
      0
    );

    const head = el('div', 'edhrec-panel-topbar');
    head.append(el('div', 'edhrec-panel-h1', 'Not in this deck'));
    if (state.commander) head.append(el('div', 'edhrec-panel-sub', `EDHREC · ${state.commander}`));
    // The launcher counts everything missing, but only the curated lists are
    // open. Say so, or the panel looks like it has lost 200 cards.
    if (shownNow < total) {
      head.append(el('div', 'edhrec-panel-sub', `Showing ${shownNow} of ${total} — type lists collapsed`));
    }
    body.append(head);

    if (state.mismatch) {
      // Better to say the list may be wrong than to quietly recommend cards the
      // deck already contains.
      body.append(
        el(
          'div',
          'edhrec-panel-warn',
          `Only ${state.mismatch.seen} of ${state.mismatch.stated} cards are visible — a filter may be active, so some of these may already be in the deck.`
        )
      );
    }

    const sort = el('div', 'edhrec-panel-sort');
    for (const [key, label] of [
      ['synergy', 'Synergy'],
      ['inclusion', 'Played in'],
    ]) {
      const b = el('button', `edhrec-panel-sortbtn${sortBy === key ? ' is-on' : ''}`, label);
      b.addEventListener('click', () => {
        sortBy = key;
        render();
      });
      sort.append(b);
    }
    body.append(sort);

    for (const s of sections) body.append(buildSection(s));

    const foot = el('div', 'edhrec-panel-foot');
    body.append(foot);
    refreshFooter();
  }

  /** Called by content.js whenever the commander data or deck contents change. */
  function update(next) {
    state = { ...state, ...next };
    render();
  }

  return { update };
})();
