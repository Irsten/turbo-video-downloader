// Skrypt strony: znajduje filmy osadzone w <video>/<source> oraz linki do plików wideo.
(() => {
  if (window.__turboVdLoaded) return;
  window.__turboVdLoaded = true;

  const VIDEO_LINK = /\.(mp4|m4v|webm|mov|mkv|flv|ogv|avi|3gp|wmv|m3u8)(\?|#|$)/i;
  const seen = new Set();
  let timer = null;

  function collect() {
    const items = [];
    const add = (url, tag) => {
      if (!url || !/^https?:/i.test(url) || seen.has(url)) return;
      seen.add(url);
      items.push({ url, tag });
    };
    for (const v of document.querySelectorAll('video')) {
      add(v.currentSrc, 'video');
      add(v.src, 'video');
      for (const s of v.querySelectorAll('source')) add(s.src, 'source');
    }
    for (const a of document.querySelectorAll('a[href]')) {
      if (VIDEO_LINK.test(a.href)) add(a.href, 'a');
    }
    if (!items.length) return;
    try {
      chrome.runtime.sendMessage({ type: 'dom-media', items }).catch(() => {});
    } catch {
      // rozszerzenie zostało przeładowane – ignoruj
    }
  }

  const schedule = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      collect();
    }, 800);
  };

  collect();
  new MutationObserver(schedule).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'href']
  });
  document.addEventListener('loadstart', schedule, true);
})();
