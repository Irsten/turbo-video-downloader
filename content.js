// Skrypt strony: znajduje filmy osadzone w <video>/<source> oraz linki do plików wideo.
// Po pierwszym pełnym skanie sprawdza tylko nowe i zmienione elementy, więc strony
// z nieskończonym przewijaniem nie są co chwilę przeszukiwane od początku.
(() => {
  if (window.__turboVdLoaded) return;
  window.__turboVdLoaded = true;

  const VIDEO_LINK = /\.(mp4|m4v|webm|mov|mkv|flv|ogv|avi|3gp|wmv|m3u8)(\?|#|$)/i;
  const SELECTOR = 'video, source, track[src], a[href]';
  const MAX_PENDING = 2000; // przy masowej przebudowie strony taniej przeskanować całość raz
  const seen = new Set();
  let pending = new Set(); // elementy do sprawdzenia (wraz z potomkami)
  let fullScan = true;
  let timer = null;

  function check(el, add) {
    const tag = el.localName;
    if (tag === 'video') {
      add(el.currentSrc, 'video');
      add(el.src, 'video');
      for (const t of el.querySelectorAll('track[src]')) check(t, add);
    } else if (tag === 'source') {
      if (el.parentElement?.localName === 'video') add(el.src, 'source');
    } else if (tag === 'track') {
      // Napisy osadzone w filmie (WebVTT) – dopinane do pozycji filmu.
      const video = el.parentElement;
      const of = video?.localName === 'video' ? video.currentSrc || video.src : '';
      if (of && /^(subtitles|captions|)$/.test(el.kind || '')) add(el.src, 'track', { of, lang: el.srclang || '', label: el.label || '' });
    } else if (tag === 'a') {
      if (typeof el.href === 'string' && VIDEO_LINK.test(el.href)) add(el.href, 'a');
    }
  }

  function collect() {
    timer = null;
    const items = [];
    const add = (url, tag, extra) => {
      if (!url || !/^https?:/i.test(url) || seen.has(url)) return;
      seen.add(url);
      items.push({ url, tag, ...extra });
    };
    const roots = fullScan ? [document.documentElement] : pending;
    fullScan = false;
    pending = new Set();
    for (const root of roots) {
      if (!root.isConnected) continue;
      check(root, add);
      for (const el of root.querySelectorAll(SELECTOR)) check(el, add);
    }
    if (!items.length) return;
    try {
      chrome.runtime.sendMessage({ type: 'dom-media', items }).catch(() => {});
    } catch {
      // rozszerzenie zostało przeładowane – ignoruj
    }
  }

  const schedule = () => {
    if (!timer) timer = setTimeout(collect, 800);
  };

  new MutationObserver((records) => {
    if (fullScan) return; // pełny skan i tak jest zaplanowany
    for (const r of records) {
      if (r.type === 'attributes') pending.add(r.target);
      else for (const n of r.addedNodes) if (n.nodeType === 1) pending.add(n);
    }
    if (pending.size > MAX_PENDING) {
      fullScan = true;
      pending = new Set();
    }
    if (pending.size || fullScan) schedule();
  }).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'href']
  });

  // Odtwarzacz zaczął wczytywać film (currentSrc zmienia się bez zmiany atrybutów).
  document.addEventListener(
    'loadstart',
    (e) => {
      if (e.target instanceof Element) {
        pending.add(e.target);
        schedule();
      }
    },
    true
  );

  collect();
})();
