// Headers for the extension's requests: many video servers check Referer/Origin
// (hotlink protection). fetch() doesn't allow setting them, so we do it with a
// declarativeNetRequest rule that applies only to requests made by THIS extension.

const EXT_ID = chrome.runtime.id;

/** fetch options for extension pages: the site's cookies, no writing to the cache. */
export const FETCH_INIT = {
  credentials: 'include',
  cache: 'no-store',
  referrerPolicy: 'no-referrer'
};

function ruleId(host) {
  // Stable rule id for a host (1 … 2^30).
  let h = 2166136261;
  for (let i = 0; i < host.length; i++) {
    h ^= host.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 2) + 1;
}

/**
 * Returns a prepare(url) function the engine calls before the first request to a given host.
 * headers: { referer, origin } – the same ones the page sent.
 * outsideTabs: a separate rule only for requests outside tabs (service worker, popup) with a higher
 * priority – playlist analysis in the background won't overwrite the headers of a download running in the manager.
 */
export function makePrepare(headers = {}, { outsideTabs = false } = {}) {
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

    const id = ruleId(outsideTabs ? host + '#bg' : host);
    const condition = {
      requestDomains: [host],
      initiatorDomains: [EXT_ID],
      resourceTypes: ['xmlhttprequest', 'media', 'other']
    };
    if (outsideTabs) condition.tabIds = [chrome.tabs.TAB_ID_NONE];
    try {
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [id],
        addRules: [
          {
            id,
            priority: outsideTabs ? 2 : 1,
            action: { type: 'modifyHeaders', requestHeaders },
            condition
          }
        ]
      });
    } catch (e) {
      console.warn('Could not set headers for', host, e);
    }
  };
}
