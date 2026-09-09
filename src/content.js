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

  function buildBadge(name, info) {
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
      el.title = `${name}\nNot ranked on EDHREC`;
    } else {
      el.classList.add(tierFor(info.rank));
      el.textContent = `#${info.rank.toLocaleString()}`;
      el.title = `${name}\nEDHREC rank ${info.rank.toLocaleString()}${
        info.gameChanger ? '\n⚠ Commander Game Changer' : ''
      }\nClick to open on EDHREC`;
      if (info.gameChanger) el.classList.add('edhrec-game-changer');
    }

    // Moxfield's tiles are themselves clickable; don't trigger their handler.
    el.addEventListener('click', (e) => e.stopPropagation());
    return el;
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
      // The adapter decides what is badgeable and how; this loop stays ignorant
      // of grids, rows and previews. Live targets come back every pass, so drop
      // the ones already showing the right card before we bother the network.
      const targets = dom
        .findTargets()
        .filter((t) => !(t.live && dom.badgedName(t.mount) === t.name));
      if (!targets.length) return;

      const names = [...new Set(targets.map((t) => t.name))];
      const res = await api.runtime.sendMessage({ type: 'lookup-ranks', names });
      if (!res?.ok) {
        console.warn('[edhrec-overlay] lookup failed:', res?.error);
        return;
      }

      for (const t of targets) {
        // The tile may have been unmounted while we were awaiting.
        if (!t.host.isConnected) continue;
        // A live host may have moved on to another card in the meantime.
        if (t.live && dom.badgedName(t.mount) === t.name) continue;
        dom.attachBadge(t, buildBadge(t.name, res.ranks[t.name]));
      }
    } finally {
      running = false;
      if (rescanQueued) {
        rescanQueued = false;
        schedule();
      }
    }
  }

  let timer = null;
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(scan, DEBOUNCE_MS);
  }

  const isOurs = (n) => n.nodeType === 1 && n.classList?.contains('edhrec-badge');

  const observer = new MutationObserver((records) => {
    for (const r of records) {
      // Ignore mutations we caused ourselves, or we'd loop forever.
      if (r.target?.closest?.('.edhrec-badge')) continue;
      if (r.type === 'attributes') {
        schedule();
        return;
      }
      if ([...r.addedNodes, ...r.removedNodes].some((n) => !isOurs(n))) {
        schedule();
        return;
      }
    }
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
