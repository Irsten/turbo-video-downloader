// Page script: finds videos embedded in <video>/<source> and links to video files.
// After the first full scan it checks only new and changed elements, so pages
// with infinite scrolling aren't searched from the start over and over.
(() => {
  if (window.__turboVdLoaded) return;
  window.__turboVdLoaded = true;

  const VIDEO_LINK = /\.(mp4|m4v|webm|mov|mkv|flv|ogv|avi|3gp|wmv|m3u8)(\?|#|$)/i;
  const SELECTOR = 'video, source, track[src], a[href]';
  const MAX_PENDING = 2000; // on a massive page rebuild it's cheaper to rescan everything once
  const seen = new Set();
  let pending = new Set(); // elements to check (with their descendants)
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
      // Subtitles embedded in the video (WebVTT) – attached to the video's item.
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
    pageInfo();
    if (items.length) send({ type: 'dom-media', items });
  }

  function send(msg) {
    try {
      chrome.runtime.sendMessage(msg).catch(() => {});
    } catch {
      // the extension was reloaded – ignore
    }
  }

  // Thumbnails and duration for the popup list: <video> posters, the page's og:image, duration.
  let lastInfo = '';
  const abs = (u) => {
    try {
      const url = new URL(u, location.href);
      return /^https?:$/.test(url.protocol) ? url.href : '';
    } catch {
      return '';
    }
  };
  function pageInfo() {
    const videos = [];
    for (const v of document.querySelectorAll('video')) {
      const src = v.currentSrc || v.src || '';
      const info = {
        src: /^https?:/i.test(src) ? src : '',
        stream: /^blob:/i.test(src), // HLS/DASH player (MediaSource)
        poster: v.poster ? abs(v.poster) : '',
        duration: isFinite(v.duration) ? Math.round(v.duration) : 0,
        height: v.videoHeight || 0
      };
      if (info.poster || info.duration) videos.push(info);
      if (videos.length >= 20) break;
    }
    const meta = window === window.top && document.querySelector('meta[property="og:image"], meta[property="og:image:url"], meta[name="twitter:image"]');
    const og = meta ? abs(meta.content || '') : '';
    if (!videos.length && !og) return;
    const key = JSON.stringify([videos, og]);
    if (key === lastInfo) return;
    lastInfo = key;
    send({ type: 'page-info', videos, og });
  }

  const schedule = () => {
    if (!timer) timer = setTimeout(collect, 800);
  };

  new MutationObserver((records) => {
    if (fullScan) return; // a full scan is scheduled anyway
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

  // The player started loading a video (currentSrc changes without attribute changes),
  // and once the metadata is loaded we know the duration.
  for (const type of ['loadstart', 'loadedmetadata']) {
    document.addEventListener(
      type,
      (e) => {
        if (e.target instanceof Element) {
          pending.add(e.target);
          schedule();
        }
      },
      true
    );
  }

  collect();
})();
