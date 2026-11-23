// Minimal XML parser – enough for DASH manifests; works without DOMParser too (Node, worker).
// Returns a tree { name, attrs, children, text }; namespace prefixes are dropped.

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const local = (name) => name.slice(name.indexOf(':') + 1);

function parseAttrs(s) {
  const attrs = {};
  const re = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(s))) attrs[local(m[1])] = decodeEntities(m[2] ?? m[3]);
  return attrs;
}

export function parseXml(text) {
  const root = { name: '#document', attrs: {}, children: [], text: '' };
  const stack = [root];
  const re =
    /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([^\s/>!?]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(text))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.text += m[1];
    else if (m[3]) {
      if (m[2]) {
        if (stack.length > 1) stack.pop();
      } else {
        const el = { name: local(m[3]), attrs: parseAttrs(m[4] || ''), children: [], text: '' };
        top.children.push(el);
        if (!m[5]) stack.push(el);
      }
    } else if (m[6]) top.text += decodeEntities(m[6]);
  }
  return root.children.find((c) => c.name) || null;
}

export const kids = (el, name) => (el ? el.children.filter((c) => c.name === name) : []);
export const kid = (el, name) => (el ? el.children.find((c) => c.name === name) || null : null);
