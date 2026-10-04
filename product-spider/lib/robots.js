// Minimal robots.txt support: groups for "*" (or our own agent name),
// Allow/Disallow with * and $ wildcards (longest match wins), Crawl-delay.

const AGENT = 'productspider';
const cache = new Map(); // origin -> Promise<{rules, crawlDelay}>

function toRegex(pattern) {
  const anchored = pattern.endsWith('$');
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .replace(/[.+?^{}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp('^' + body + (anchored ? '$' : ''));
}

export function parseRobots(text) {
  const groups = [];
  let current = null;
  let lastWasAgent = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    const m = line.match(/^([\w-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const field = m[1].toLowerCase();
    const value = m[2].trim();
    if (field === 'user-agent') {
      if (!lastWasAgent) groups.push((current = { agents: [], rules: [], crawlDelay: 0 }));
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if ((field === 'allow' || field === 'disallow') && value) {
      current.rules.push({ allow: field === 'allow', length: value.length, re: toRegex(value) });
    } else if (field === 'crawl-delay') {
      current.crawlDelay = parseFloat(value) || 0;
    }
  }
  const mine = groups.filter((g) => g.agents.some((a) => a !== '*' && AGENT.includes(a)));
  const chosen = mine.length ? mine : groups.filter((g) => g.agents.includes('*'));
  return {
    rules: chosen.flatMap((g) => g.rules),
    crawlDelay: Math.max(0, ...chosen.map((g) => g.crawlDelay)),
  };
}

async function load(origin) {
  try {
    const res = await fetch(origin + '/robots.txt', { credentials: 'omit', cache: 'no-cache' });
    if (!res.ok) return { rules: [], crawlDelay: 0 };
    return parseRobots(await res.text());
  } catch {
    return { rules: [], crawlDelay: 0 };
  }
}

export async function getRobots(url) {
  const origin = new URL(url).origin;
  if (!cache.has(origin)) cache.set(origin, load(origin));
  return cache.get(origin);
}

export async function isAllowedByRobots(url) {
  const { rules } = await getRobots(url);
  const u = new URL(url);
  const path = u.pathname + u.search;
  let best = null;
  for (const r of rules) {
    if (r.re.test(path) && (!best || r.length > best.length || (r.length === best.length && r.allow))) best = r;
  }
  return !best || best.allow;
}
