// Nagłówki dla żądań rozszerzenia: wiele serwerów wideo sprawdza Referer/Origin
// (ochrona przed hotlinkowaniem). fetch() nie pozwala ich ustawić, więc robimy to
// regułą declarativeNetRequest działającą tylko na żądania TEGO rozszerzenia.

const EXT_ID = chrome.runtime.id;

/** Opcje fetch dla stron rozszerzenia: ciasteczka strony, bez zapisu do cache. */
export const FETCH_INIT = {
  credentials: 'include',
  cache: 'no-store',
  referrerPolicy: 'no-referrer'
};

function ruleId(host) {
  // Stały identyfikator reguły dla hosta (1 … 2^30).
  let h = 2166136261;
  for (let i = 0; i < host.length; i++) {
    h ^= host.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 2) + 1;
}

/**
 * Zwraca funkcję prepare(url), którą silnik woła przed pierwszym żądaniem do danego hosta.
 * headers: { referer, origin } – takie, jakie wysyłała strona.
 */
export function makePrepare(headers = {}) {
  const done = new Set();
  return async (url) => {
    let host;
    try {
      host = new URL(url).hostname;
    } catch {
      return;
    }
    if (done.has(host)) return;
    done.add(host);

    const requestHeaders = [];
    if (headers.referer) requestHeaders.push({ header: 'referer', operation: 'set', value: headers.referer });
    if (headers.origin) requestHeaders.push({ header: 'origin', operation: 'set', value: headers.origin });
    else requestHeaders.push({ header: 'origin', operation: 'remove' });

    const id = ruleId(host);
    try {
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [id],
        addRules: [
          {
            id,
            priority: 1,
            action: { type: 'modifyHeaders', requestHeaders },
            condition: {
              requestDomains: [host],
              initiatorDomains: [EXT_ID],
              resourceTypes: ['xmlhttprequest', 'media', 'other']
            }
          }
        ]
      });
    } catch (e) {
      console.warn('Nie udało się ustawić nagłówków dla', host, e);
    }
  };
}
