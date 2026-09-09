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

  function tooltipFor(name, info, moxfieldFlagsGameChanger = false) {
    const lines = [name];
    lines.push(info?.rank == null ? 'Not ranked on EDHREC' : `EDHREC rank #${info.rank.toLocaleString()}`);

    const stat = statFor(name, edhrec.stats);
    if (stat) {
      if (typeof stat.synergy === 'number') {
        // Synergy is inclusion-with-this-commander minus inclusion-everywhere,
        // so the sign matters and a leading + is worth spelling out.
        const sign = stat.synergy >= 0 ? '+' : '';
        lines.push(`Synergy ${sign}${pct(stat.synergy)}${edhrec.commander ? ` with ${edhrec.commander}` : ''}`);
      }
      if (typeof stat.inclusion === 'number') {
        lines.push(
          `In ${pct(stat.inclusion)} of those decks (${stat.numDecks.toLocaleString()} of ${stat.potentialDecks.toLocaleString()})`
        );
      }
      // Drop "Game Changers" when Scryfall already flags it below, or the
      // tooltip says the same thing twice from two different sources.
      const tags = (stat.lists || []).filter(
        (l) => NOTABLE_LISTS.test(l) && !(info?.gameChanger && /game changer/i.test(l))
      );
      if (tags.length) lines.push(`Listed under ${tags.join(', ')}`);
    }

    // Moxfield prints its own Game Changer icon in text views; no need to say
    // it twice on the same row.
    if (info?.gameChanger && !moxfieldFlagsGameChanger) lines.push('⚠ Commander Game Changer');

    const salt = statFor(name, edhrec.salt);
    if (typeof salt === 'number') lines.push(`Salt ${salt.toFixed(2)} — top 100 saltiest`);

    lines.push('Click to open on EDHREC');
    return lines.join('\n');
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
    el.title = tooltipFor(name, info, moxfieldFlagsGameChanger);

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
          if (name) b.title = tooltipFor(name, rankCache.get(name), b.dataset.moxGameChanger === '1');
        }
      })
      .catch((err) => console.warn('[edhrec-overlay] edhrec lookup failed:', err.message))
      .finally(() => {
        edhrecLoading = false;
      });
  }

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
