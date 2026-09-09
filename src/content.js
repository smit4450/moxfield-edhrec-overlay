/**
 * Watches Moxfield's React tree for card tiles and badges each one with its
 * EDHREC rank.
 *
 * Moxfield renders everything client-side and re-renders on every view, sort
 * and filter change, so this runs continuously rather than once on load.
 */

(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  const dom = globalThis.MoxfieldDom;

  // React can reconcile our badges away mid-burst; debouncing lets the DOM
  // settle before we re-scan, and keeps us off the main thread during scroll.
  const DEBOUNCE_MS = 300;

  // Lower rank = played in more decks. Thresholds are display-only.
  const TIERS = [
    { max: 100, cls: 'edhrec-tier-1' },
    { max: 500, cls: 'edhrec-tier-2' },
    { max: 2000, cls: 'edhrec-tier-3' },
    { max: Infinity, cls: 'edhrec-tier-4' },
  ];

  const tierFor = (rank) => TIERS.find((t) => rank <= t.max).cls;

  /** EDHREC card URLs are the lowercased name, non-alphanumerics collapsed. */
  function edhrecUrl(name) {
    const slug = name
      .split('//')[0]
      .trim()
      .toLowerCase()
      .replace(/['’]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return `https://edhrec.com/cards/${slug}`;
  }

  /**
   * Commander-specific EDHREC data for this deck.
   *
   * The badge face stays a rank - it has to fit in a card corner - so
   * everything else lives in the tooltip.
   */
  let edhrec = { stats: {}, salt: {}, matched: false, commander: '' };

  const frontFace = (n) => n.split('//')[0].trim().toLowerCase();
  const statFor = (name, table) => table[name.toLowerCase()] ?? table[frontFace(name)];
  const pct = (n) => `${(n * 100).toFixed(1)}%`;

  /** Only these list memberships say something a rank does not. */
  const NOTABLE_LISTS = /high synergy|top cards|game changer|new cards/i;

  /**
   * Structured description of one card, rendered by the tooltip and flattened
   * for the accessible label. Building a model rather than a string is what
   * lets a negative synergy be coloured differently from a positive one.
   */
  function tooltipModel(name, info, moxfieldFlagsGameChanger = false) {
    const model = { name, rank: info?.rank ?? null, rows: [], chips: [] };
    const stat = statFor(name, edhrec.stats);

    if (stat && typeof stat.synergy === 'number') {
      // Synergy is inclusion-with-this-commander minus inclusion-everywhere, so
      // the sign carries the meaning and drives the colour.
      model.rows.push({
        label: 'Synergy',
        value: `${stat.synergy >= 0 ? '+' : ''}${pct(stat.synergy)}`,
        tone: stat.synergy >= 0 ? 'pos' : 'neg',
        sub: 'vs. decks that could play it',
      });
    }
    if (stat && typeof stat.inclusion === 'number') {
      model.rows.push({
        label: 'Played in',
        value: pct(stat.inclusion),
        bar: stat.inclusion,
        sub: `${stat.numDecks.toLocaleString()} of ${stat.potentialDecks.toLocaleString()} decks`,
      });
    }

    if (stat) {
      // Drop "Game Changers" when it is already shown as its own chip below.
      for (const l of stat.lists || []) {
        if (NOTABLE_LISTS.test(l) && !(info?.gameChanger && /game changer/i.test(l))) {
          model.chips.push({ text: l });
        }
      }
    }
    // Moxfield prints its own icon in text views; no need to say it twice.
    if (info?.gameChanger && !moxfieldFlagsGameChanger) {
      model.chips.push({ text: 'Game Changer', kind: 'gc' });
    }
    const salt = statFor(name, edhrec.salt);
    if (typeof salt === 'number') {
      model.chips.push({ text: `Salt ${salt.toFixed(2)}`, kind: 'salt' });
    }

    model.commander = edhrec.commander;
    return model;
  }

  /** Flattened for `aria-label`, since the visual tooltip is not readable. */
  function plainSummary(m) {
    const parts = [m.name, m.rank == null ? 'not ranked on EDHREC' : `EDHREC rank ${m.rank.toLocaleString()}`];
    for (const r of m.rows) parts.push(`${r.label} ${r.value}${r.sub ? ` (${r.sub})` : ''}`);
    for (const c of m.chips) parts.push(c.text);
    return parts.join('. ');
  }

  function buildBadge(name, info, moxfieldFlagsGameChanger = false) {
    const el = document.createElement('a');
    el.className = 'edhrec-badge';
    // Lets a live host tell whether it is already showing this card.
    el.dataset.cardName = name;
    el.href = edhrecUrl(name);
    el.target = '_blank';
    el.rel = 'noopener noreferrer';

    if (!info || info.rank == null) {
      el.classList.add('edhrec-unranked');
      el.textContent = '—';
    } else {
      el.classList.add(tierFor(info.rank));
      el.textContent = `#${info.rank.toLocaleString()}`;
      // The gold ring is suppressed only where Moxfield is already showing its
      // own marker - text views. In every visual view it is the sole indicator.
      if (info.gameChanger && !moxfieldFlagsGameChanger) el.classList.add('edhrec-game-changer');
    }
    // Remembered so a later tooltip repaint keeps making the same choice.
    if (moxfieldFlagsGameChanger) el.dataset.moxGameChanger = '1';
    // No `title`: the native tooltip would race our own and win the first
    // second. The same content goes to aria-label so it stays readable.
    el.setAttribute('aria-label', plainSummary(tooltipModel(name, info, moxfieldFlagsGameChanger)));

    // Moxfield's tiles are themselves clickable; don't trigger their handler.
    el.addEventListener('click', (e) => e.stopPropagation());
    return el;
  }

  /**
   * Ranks already seen in this page, mirrored from the background's answers.
   *
   * The background has its own durable cache, but reaching it costs a message
   * round trip plus an async storage read. On the hover path that is the
   * difference between the preview badge updating instantly and visibly
   * lagging behind the pointer, so we keep a synchronous copy here too.
   */
  const rankCache = new Map();

  /**
   * Load EDHREC data for whatever commander this deck has, once.
   *
   * Deliberately NOT awaited by scan(). EDHREC is an unofficial API and pure
   * enrichment, so the rank badges must never wait on it — on a cold start the
   * background has to boot and make two requests, which is slower than the
   * badges should ever take to paint. Instead this fires in the background and
   * repaints tooltips in place once the data lands.
   *
   * Keyed on the commander so switching decks in the same tab refetches. The
   * key is recorded only on success, so a failed or slow attempt retries on the
   * next pass rather than disabling enrichment for the rest of the page's life.
   */
  let edhrecKey = null;
  let edhrecLoading = false;

  function ensureEdhrec() {
    const commanders = dom.findCommanderNames();
    const key = commanders.join(' + ');
    if (key === edhrecKey || edhrecLoading) return;
    edhrecLoading = true;

    Promise.resolve(api.runtime.sendMessage({ type: 'lookup-edhrec', commanders }))
      .then((res) => {
        if (!res?.ok) return;
        edhrec = { ...res, commander: commanders[0] || '' };
        edhrecKey = key;
        // Badges are already on the page; only their tooltips need to change.
        for (const b of document.querySelectorAll('.edhrec-badge')) {
          const name = b.dataset.cardName;
          if (!name) continue;
          const m = tooltipModel(name, rankCache.get(name), b.dataset.moxGameChanger === '1');
          b.setAttribute('aria-label', plainSummary(m));
          // If this badge's tooltip is open right now, refresh it in place.
          if (tipFor === b) {
            renderTip(m);
            positionTip(b);
          }
        }
      })
      .catch((err) => console.warn('[edhrec-overlay] edhrec lookup failed:', err.message))
      .finally(() => {
        edhrecLoading = false;
      });
  }

  // ---------------------------------------------------------------------------
  // Tooltip
  //
  // One shared element on <body>, positioned per hover. Per-badge listeners
  // would mean thousands of them being attached and torn down as React
  // reconciles the deck, so this delegates from the document instead and the
  // badges themselves stay inert.
  // ---------------------------------------------------------------------------

  const TIP_DELAY_MS = 110;
  let tipEl = null;
  let tipTimer = null;
  let tipFor = null;

  function tipRoot() {
    if (!tipEl) {
      tipEl = document.createElement('div');
      tipEl.className = 'edhrec-tip';
      tipEl.setAttribute('role', 'presentation');
      document.body.appendChild(tipEl);
    }
    return tipEl;
  }

  const div = (cls, text) => {
    const d = document.createElement('div');
    if (cls) d.className = cls;
    // textContent, never innerHTML: card names come off the page.
    if (text != null) d.textContent = text;
    return d;
  };

  function renderTip(m) {
    const root = tipRoot();
    root.replaceChildren();

    const head = div('edhrec-tip-head');
    head.append(div('edhrec-tip-name', m.name));
    head.append(div('edhrec-tip-rank', m.rank == null ? 'unranked' : `#${m.rank.toLocaleString()}`));
    root.append(head);

    for (const r of m.rows) {
      const row = div('edhrec-tip-row');
      row.append(div('edhrec-tip-label', r.label));
      row.append(div(`edhrec-tip-value${r.tone ? ` edhrec-tip-${r.tone}` : ''}`, r.value));
      root.append(row);
      if (r.bar != null) {
        const bar = div('edhrec-tip-bar');
        const fill = document.createElement('i');
        fill.style.width = `${Math.max(0, Math.min(1, r.bar)) * 100}%`;
        bar.append(fill);
        root.append(bar);
      }
      if (r.sub) root.append(div('edhrec-tip-sub', r.sub));
    }

    if (m.chips.length) {
      const chips = div('edhrec-tip-chips');
      for (const c of m.chips) {
        chips.append(div(`edhrec-tip-chip${c.kind ? ` is-${c.kind}` : ''}`, c.text));
      }
      root.append(chips);
    }

    // Keep the click affordance: the badge is a link, and nothing else says so.
    root.append(
      div('edhrec-tip-foot', m.commander ? `${m.commander} · click to open on EDHREC` : 'Click to open on EDHREC')
    );
    return root;
  }

  /** Place the tooltip above the badge, flipping or clamping at the edges. */
  function positionTip(badge) {
    const root = tipRoot();
    // A rescan can replace the badge between hover and show. A detached node
    // measures as all zeros, which would fling the tooltip to the top-left
    // corner rather than leave it near the card.
    if (!badge.isConnected) return hideTip();
    const b = badge.getBoundingClientRect();
    const t = root.getBoundingClientRect();
    const margin = 8;

    let left = b.left + b.width / 2 - t.width / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - t.width - margin));

    let top = b.top - t.height - margin;
    if (top < margin) top = b.bottom + margin;

    root.style.left = `${Math.round(left)}px`;
    root.style.top = `${Math.round(top)}px`;
  }

  function paintTip(badge, name) {
    renderTip(tooltipModel(name, rankCache.get(name), badge.dataset.moxGameChanger === '1'));
    // Measure with it laid out but still transparent, or the first frame jumps.
    positionTip(badge);
  }

  function showTip(badge) {
    const name = badge.dataset.cardName;
    if (!name) return;
    paintTip(badge, name);
    tipRoot().classList.add('is-visible');
    tipFor = badge;

    // Self-healing. Every path that creates a badge resolves its rank first, so
    // a cache miss here should be impossible - but "should be impossible" is
    // exactly what produces a tooltip that says "unranked" until you hover it a
    // second time. Rather than trust the invariant, fetch what is missing and
    // repaint if this tooltip is still the one on screen.
    if (rankCache.has(name)) return;
    Promise.resolve(api.runtime.sendMessage({ type: 'lookup-ranks', names: [name] }))
      .then((res) => {
        if (!res?.ok) return;
        rankCache.set(name, res.ranks[name] ?? null);
        if (tipFor === badge && badge.isConnected) paintTip(badge, name);

        // The badge face came from the same missing entry, so repair it too.
        // A rescan would not: findTargets() skips hosts already marked done.
        const info = rankCache.get(name);
        if (badge.isConnected && info?.rank != null && badge.textContent === '—') {
          badge.classList.remove('edhrec-unranked');
          badge.classList.add(tierFor(info.rank));
          badge.textContent = `#${info.rank.toLocaleString()}`;
          badge.setAttribute(
            'aria-label',
            plainSummary(tooltipModel(name, info, badge.dataset.moxGameChanger === '1'))
          );
        }
      })
      .catch((err) => console.warn('[edhrec-overlay] tooltip backfill failed:', err.message));
  }

  function hideTip() {
    clearTimeout(tipTimer);
    tipFor = null;
    if (tipEl) tipEl.classList.remove('is-visible');
  }

  document.addEventListener(
    'mouseover',
    (e) => {
      const badge = e.target?.closest?.('.edhrec-badge');
      if (!badge || badge === tipFor) return;
      clearTimeout(tipTimer);
      tipTimer = setTimeout(() => showTip(badge), TIP_DELAY_MS);
    },
    true
  );

  document.addEventListener(
    'mouseout',
    (e) => {
      if (e.target?.closest?.('.edhrec-badge')) hideTip();
    },
    true
  );

  // Keyboard parity, and the position is stale the moment anything scrolls.
  document.addEventListener('focusin', (e) => {
    const badge = e.target?.closest?.('.edhrec-badge');
    if (badge) showTip(badge);
  });
  document.addEventListener('focusout', hideTip);
  window.addEventListener('scroll', hideTip, true);
  window.addEventListener('resize', hideTip);

  let running = false;
  let rescanQueued = false;

  async function scan() {
    if (running) {
      rescanQueued = true;
      return;
    }
    running = true;
    try {
      ensureEdhrec();
      // The adapter decides what is badgeable and how; this loop stays ignorant
      // of grids, rows and previews. Live targets come back every pass, so drop
      // the ones already showing the right card before we bother the network.
      const targets = dom
        .findTargets()
        .filter((t) => !(t.live && dom.badgedName(t.mount) === t.name));
      if (!targets.length) return;

      const names = [...new Set(targets.map((t) => t.name))];
      const unknown = names.filter((n) => !rankCache.has(n));

      if (unknown.length) {
        const res = await api.runtime.sendMessage({ type: 'lookup-ranks', names: unknown });
        if (!res?.ok) {
          console.warn('[edhrec-overlay] lookup failed:', res?.error);
          return;
        }
        for (const n of unknown) rankCache.set(n, res.ranks[n] ?? null);
      }

      for (const t of targets) {
        // The tile may have been unmounted while we were awaiting.
        if (!t.host.isConnected) continue;
        // A live host may have moved on to another card in the meantime.
        if (t.live && dom.badgedName(t.mount) === t.name) continue;
        dom.attachBadge(t, buildBadge(t.name, rankCache.get(t.name), t.moxfieldFlagsGameChanger));
      }
    } finally {
      running = false;
      if (rescanQueued) {
        rescanQueued = false;
        schedule();
      }
    }
  }

  /**
   * Repaint just the hover preview, synchronously where possible.
   *
   * Hovering a new card must not wait on the debounce, a full-page
   * findTargets(), and a background round trip. Once a rank is in rankCache —
   * which it is for every card already badged on the page — this repaints in
   * the same task as the mutation. Only a genuinely unseen card falls back to
   * the normal async scan.
   */
  function refreshPreviews() {
    let needsLookup = false;
    for (const t of dom.findPreviewTargets()) {
      if (dom.badgedName(t.mount) === t.name) continue;
      if (rankCache.has(t.name))
        dom.attachBadge(t, buildBadge(t.name, rankCache.get(t.name), t.moxfieldFlagsGameChanger));
      else needsLookup = true;
    }
    if (needsLookup) schedule();
  }

  let timer = null;
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(scan, DEBOUNCE_MS);
  }

  const isOurs = (n) => n.nodeType === 1 && n.classList?.contains('edhrec-badge');

  const observer = new MutationObserver((records) => {
    let previewTouched = false;
    let structural = false;

    for (const r of records) {
      // Ignore mutations we caused ourselves, or we'd loop forever.
      if (r.target?.closest?.('.edhrec-badge')) continue;

      // A hover swap only rewrites the preview's image. Route it to the fast
      // path instead of debouncing a whole-page rescan.
      if (r.target?.closest?.('.deckview-image-wrapper')) {
        previewTouched = true;
        continue;
      }
      if (r.type === 'attributes') {
        structural = true;
        continue;
      }
      if ([...r.addedNodes, ...r.removedNodes].some((n) => !isOurs(n))) structural = true;
    }

    if (structural) {
      // The page's card set may have changed, so the id->name index is stale.
      dom.invalidateNameIndex();
      schedule();
    }
    if (previewTouched) refreshPreviews();
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    // The preview replaces its image's src/alt in place rather than remounting,
    // so without watching attributes its badge would never update on hover.
    attributes: true,
    attributeFilter: ['src', 'alt'],
  });
  schedule();
})();
