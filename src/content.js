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
      const hosts = dom.findUnprocessedCards();
      if (!hosts.length) return;

      const pairs = [];
      for (const host of hosts) {
        const name = dom.extractCardName(host);
        if (name) pairs.push([host, name]);
      }
      if (!pairs.length) return;

      const names = [...new Set(pairs.map(([, n]) => n))];
      const res = await api.runtime.sendMessage({ type: 'lookup-ranks', names });
      if (!res?.ok) {
        console.warn('[edhrec-overlay] lookup failed:', res?.error);
        return;
      }

      for (const [host, name] of pairs) {
        // The tile may have been unmounted while we were awaiting.
        if (!host.isConnected) continue;
        dom.attachBadge(host, buildBadge(name, res.ranks[name]));
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

  const observer = new MutationObserver((records) => {
    // Ignore mutations we caused ourselves, or we'd loop forever.
    const external = records.some((r) =>
      [...r.addedNodes, ...r.removedNodes].some(
        (n) => !(n.nodeType === 1 && n.classList?.contains('edhrec-badge'))
      )
    );
    if (external) schedule();
  });

  observer.observe(document.body, { childList: true, subtree: true });
  schedule();
})();
