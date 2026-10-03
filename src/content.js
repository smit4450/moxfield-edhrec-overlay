/**
 * Watches Moxfield's React tree for card tiles and badges each one with its
 * EDHREC rank.
 *
 * Moxfield renders everything client-side and re-renders on every view, sort
 * and filter change, so this runs continuously rather than once on load.
 */

(() => {
  // `browser.runtime`, not just `browser`. Chrome had no `browser` object
  // before 148, and a page element with id="browser" is reachable as
  // globalThis.browser - a node `??` would happily hand back as the API.
  const api = globalThis.browser?.runtime ? globalThis.browser : globalThis.chrome;
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

  /**
   * Moxfield's display name -> the card's real Scryfall name.
   *
   * Reskins are displayed under a FLAVOR name ("Valley Farmstead"), while
   * EDHREC, Commander Spellbook and the average decklist all key on the real
   * one ("Yavimaya, Cradle of Growth"). Comparing display names against those
   * services makes a card you own look absent: it stays in the Add list, drops
   * into "not in EDHREC's lists" under Cuts, reads as a difference from the
   * average, and - the visible symptom - gets reported as a combo piece you
   * still need.
   *
   * The rank lookup already resolves the real name, so this is free.
   */
  const canonicalOf = (displayName) => rankCache.get(displayName)?.name || displayName;

  /**
   * Rank info for a card, preferring the COMMANDER rank when it is one.
   *
   * Scryfall's edhrec_rank answers "how often is this played in any deck".
   * For a commander the question is "how often is it played AS the commander",
   * which is a different number: Bria, Riptide Rogue is the 240th commander
   * and the 3,058th card. On her own deck page the card rank is technically
   * true and practically useless.
   */
  function infoFor(name) {
    const base = rankCache.get(name);
    const cmd = edhrec.commanderCard;
    // Either name: EDHREC titles the page with whichever name it was asked for,
    // and that is the displayed one if resolving the real name ever failed.
    if (cmd && [name, canonicalOf(name)].some((n) => frontFace(n) === frontFace(cmd.name))) {
      return { ...(base || {}), rank: cmd.rank, isCommander: true, commanderDecks: cmd.numDecks };
    }
    return base;
  }
  const statFor = (name, table) => table[name.toLowerCase()] ?? table[frontFace(name)];
  const pct = (n) => `${(n * 100).toFixed(1)}%`;

  /** As EDHREC prints it ("9.4x lift"), so the two read the same side by side. */
  const liftText = (n) => `${n.toFixed(1)}x`;
  /** Neutral when it prints as 1.0x: a red "1.0x" would contradict itself. */
  const liftTone = (n) => (liftText(n) === '1.0x' ? null : n > 1 ? 'pos' : 'neg');

  /**
   * Only these list memberships say something a rank does not. EDHREC renamed
   * "High Synergy Cards" to "High Lift Cards" on 2026-10-01; both are matched so
   * a page still carrying the old name keeps its chip.
   */
  const NOTABLE_LISTS = /high (lift|synergy)|top cards|game changer|new cards/i;

  /**
   * Structured description of one card, rendered by the tooltip and flattened
   * for the accessible label. Building a model rather than a string is what
   * lets a low lift be coloured differently from a high one.
   */
  function tooltipModel(name, info, moxfieldFlagsGameChanger = false) {
    const model = {
      name,
      rank: info?.rank ?? null,
      isCommander: info?.isCommander === true,
      rows: [],
      chips: [],
    };

    if (model.isCommander && info?.commanderDecks != null) {
      model.rows.push({
        label: 'Decks',
        value: info.commanderDecks.toLocaleString(),
        sub: 'running it as commander',
      });
    }
    const stat = statFor(canonicalOf(name), edhrec.stats);

    if (stat && typeof stat.lift === 'number') {
      // Lift is inclusion-with-this-commander divided by inclusion in every deck
      // that could play it, so 1x is neutral and the ratio drives the colour.
      model.rows.push({
        label: 'Lift',
        value: liftText(stat.lift),
        tone: liftTone(stat.lift),
        sub: 'vs. decks that could play it',
      });
    }
    if (stat && typeof stat.synergy === 'number') {
      // The same comparison as a difference rather than a ratio, so the sign
      // carries the meaning. It favours staples where lift favours niche picks.
      model.rows.push({
        label: 'Synergy',
        value: `${stat.synergy >= 0 ? '+' : ''}${pct(stat.synergy)}`,
        tone: stat.synergy >= 0 ? 'pos' : 'neg',
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
    const salt = statFor(canonicalOf(name), edhrec.salt);
    if (typeof salt === 'number') {
      model.chips.push({ text: `Salt ${salt.toFixed(2)}`, kind: 'salt' });
    }

    model.commander = edhrec.commander;
    return model;
  }

  /** Flattened for `aria-label`, since the visual tooltip is not readable. */
  function plainSummary(m) {
    const parts = [
      m.name,
      m.rank == null
        ? 'not ranked on EDHREC'
        : `${m.isCommander ? 'Commander' : 'EDHREC'} rank ${m.rank.toLocaleString()}`,
    ];
    for (const r of m.rows) parts.push(`${r.label} ${r.value}${r.sub ? ` (${r.sub})` : ''}`);
    for (const c of m.chips) parts.push(c.text);
    return parts.join('. ');
  }

  /** The badge face: the rank in its tier colour, or a dash. Safe to repaint. */
  function paintRank(el, info) {
    el.classList.remove('edhrec-unranked', ...TIERS.map((t) => t.cls));
    if (!info || info.rank == null) {
      el.classList.add('edhrec-unranked');
      el.textContent = '—';
    } else {
      el.classList.add(tierFor(info.rank));
      el.textContent = `#${info.rank.toLocaleString()}`;
    }
  }

  function buildBadge(name, info, moxfieldFlagsGameChanger = false) {
    const el = document.createElement('a');
    el.className = 'edhrec-badge';
    // Lets a live host tell whether it is already showing this card.
    el.dataset.cardName = name;
    el.href = edhrecUrl(name);
    el.target = '_blank';
    el.rel = 'noopener noreferrer';

    paintRank(el, info);
    // The gold ring is suppressed only where Moxfield is already showing its
    // own marker on this same row. On every image tile it is the sole indicator.
    if (info?.rank != null && info.gameChanger && !moxfieldFlagsGameChanger) {
      el.classList.add('edhrec-game-changer');
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
    const shown = dom.findCommanderNames();
    const key = shown.join(' + ');
    if (key === edhrecKey || edhrecLoading) return;
    edhrecLoading = true;

    canonicalNames(shown)
      .then((commanders) =>
        Promise.resolve(api.runtime.sendMessage({ type: 'lookup-edhrec', commanders })).then((res) => {
          if (!res?.ok) return;
          // Keep the whole list, not just the first: partner and background
          // pairings have two, and the panel must exclude both.
          edhrec = { ...res, commander: commanders[0] || '', commanders };
          edhrecKey = key;
          lastPanelSig = ''; // new commander: the whole recommendation set changed
          syncPanel();
          // Badges are already on the page. Their tooltips need the new data, and
          // the commander's face needs its commander rank: a badge painted before
          // this answer arrived is still showing the card rank.
          for (const b of document.querySelectorAll('.edhrec-badge')) {
            const name = b.dataset.cardName;
            if (!name) continue;
            const info = infoFor(name);
            if (info?.isCommander) paintRank(b, info);
            const m = tooltipModel(name, info, b.dataset.moxGameChanger === '1');
            b.setAttribute('aria-label', plainSummary(m));
            // If this badge's tooltip is open right now, refresh it in place.
            if (tipFor === b) {
              renderTip(m);
              positionTip(b);
            }
          }
        })
      )
      .catch((err) => console.warn('[edhrec-overlay] edhrec lookup failed:', err.message))
      .finally(() => {
        edhrecLoading = false;
      });
  }

  /**
   * Real names for cards as the page displays them, asking the background about
   * any not seen yet.
   *
   * The commander's names go to EDHREC, to Commander Spellbook and to the
   * average-deck lookup, so they follow the rule for everything outbound. A
   * reskinned commander displays as "Miku, Song of the People" for Trostani,
   * Selesnya's Voice. EDHREC answers that slug too, but names the commander by
   * it, so the badge never matched it and kept the card rank; Spellbook does not
   * know the flavor name at all, so the commander read as missing from every
   * combo it is in. This runs before the first rank lookup has filled
   * rankCache, hence the lookup of its own.
   */
  async function canonicalNames(names) {
    const unknown = names.filter((n) => !rankCache.has(n));
    if (unknown.length) {
      const res = await api.runtime.sendMessage({ type: 'lookup-ranks', names: unknown });
      if (res?.ok) for (const n of unknown) rankCache.set(n, res.ranks[n] ?? null);
    }
    return names.map(canonicalOf);
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
    renderTip(tooltipModel(name, infoFor(name), badge.dataset.moxGameChanger === '1'));
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
        // Via infoFor, so repairing the commander's badge does not quietly
        // swap its commander rank back for its card rank.
        const info = infoFor(name);
        if (badge.isConnected && info?.rank != null && badge.textContent === '—') {
          paintRank(badge, info);
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

  /**
   * Hand the recommendations panel a fresh view of the deck.
   *
   * Recomputed rather than accumulated, because cards leave the deck too. The
   * signature check keeps this off the hot path: the deck only changes when a
   * card is added or removed, not on every mutation the observer sees.
   */
  let lastPanelSig = '';
  function syncPanel() {
    const panel = globalThis.EdhrecPanel;
    if (!panel || !edhrec.lists?.length) return;

    const names = dom.deckCardNames();
    // The deck's own identity, so switching decks cannot be mistaken for the
    // same deck. Commander plus card count is not enough: two different decks
    // for the same commander with the same size collide.
    const deckId = location.pathname;
    const sig = `${deckId}|${names.size}|${edhrecKey}|${rankCache.size}`;
    if (sig === lastPanelSig) return;
    lastPanelSig = sig;

    // If Moxfield says the deck is bigger than what is rendered, a filter or
    // search is active and "not in this deck" would be wrong. Say so rather
    // than quietly recommending cards the deck already runs.
    const stated = dom.statedDeckSize();
    // Canonical names, because everything the panel compares against uses them.
    const deck = new Set([...names].map((n) => frontFace(canonicalOf(n))));
    const mismatch = stated && names.size < stated ? { seen: names.size, stated } : null;

    // The Cuts view needs the deck's own cards with their ranks, which only
    // this side has: rankCache is populated as badges are built. `name` stays
    // the display name so rows read as the page does; `canonical` is what all
    // the matching uses.
    const deckCards = [...names].map((n) => {
      const info = rankCache.get(n) || {};
      return { ...info, name: n, canonical: info.name || n };
    });

    panel.update({
      deckId,
      lists: edhrec.lists,
      stats: edhrec.stats,
      salt: edhrec.salt,
      deck,
      deckCards,
      commander: edhrec.commander,
      commanders: edhrec.commanders || [],
      mismatch,
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
        dom.attachBadge(t, buildBadge(t.name, infoFor(t.name), t.moxfieldFlagsGameChanger));
      }
    } finally {
      running = false;
      syncPanel();
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
        dom.attachBadge(t, buildBadge(t.name, infoFor(t.name), t.moxfieldFlagsGameChanger));
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
