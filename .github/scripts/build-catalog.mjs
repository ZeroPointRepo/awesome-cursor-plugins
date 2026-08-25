#!/usr/bin/env node
/**
 * Rebuilds every derived artifact in this repository from live sources.
 *
 * Sources, all live, none committed as a snapshot:
 *   1. cursor.com/marketplace          the listing payload (name, description, publisher, repo)
 *   2. cursor.com/marketplace/<slug>   the /add-plugin line, read off Cursor's own page
 *   3. api.github.com                  each source repo's metadata and full file tree
 *   4. the plugin's own mcp.json       the MCP endpoint, then a live initialize handshake
 *
 * Writes: CATALOG.md, catalog.csv, plugins.json, badges/*.json,
 *         .github/data/first-seen.json, and the count line + badge in README.md.
 *
 * Run locally with GH_TOKEN set. It prints every drop and refuses to shrink silently.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.argv[2] || '.');
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
if (!TOKEN) { console.error('GH_TOKEN or GITHUB_TOKEN is required'); process.exit(1); }

const OWNER = 'ZeroPointRepo';
const REPO = 'awesome-cursor-plugins';
const MARKETPLACE = 'https://cursor.com/marketplace';
const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const GH_HEADERS = { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': `${OWNER}/${REPO}` };

/* Manifest directory -> the client that reads it. Add a row when a new one appears in the wild;
   never guess a client from a name alone, and never claim a client with no manifest evidence. */
const CLIENTS = [
  ['claude',      '.claude-plugin',      'Claude Code'],
  ['codex',       '.codex-plugin',       'Codex'],
  ['copilot',     '.github/plugin',      'GitHub Copilot'],
  ['grok',        '.grok-plugin',        'Grok Bot'],
  ['antigravity', '.antigravity-plugin', 'Antigravity'],
  ['opencode',    '.opencode-plugin',    'OpenCode'],
  ['kimi',        '.kimi-plugin',        'Kimi'],
  ['hermes',      '.hermes-plugin',      'Hermes Agent'],
  ['devin',       '.devin-plugin',       'Devin'],
  ['tessl',       '.tessl-plugin',       'Tessl'],
  ['cortex',      '.cortex-plugin',      'Cortex'],
  ['minimax',     '.minimax-plugin',     'MiniMax'],
  ['qoder',       '.qoder-plugin',       'Qoder'],
];
const AUTH_LABEL = {
  oauth: 'OAuth sign-in', token: 'Paste a token', none: 'No sign-in', local: 'Runs locally',
  'skills-only': 'No sign-in', 'self-hosted': 'Points at your own instance', unknown: 'Sign-in not established',
};
const KEYRE = /(api[_-]?key|token|secret|bearer|password|credential|_pat$|^pat$)/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const drops = [];
const drop = (why) => { drops.push(why); console.log('  DROP ' + why); };

async function getText(url, headers = {}, tries = 3, timeoutMs = 25000) {
  for (let i = 0; i < tries; i++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { headers, signal: ctl.signal });
      clearTimeout(t);
      if (r.status === 403 || r.status === 429) { await sleep(2000 * (i + 1)); continue; }
      if (!r.ok) return null;
      return await r.text();
    } catch { clearTimeout(t); await sleep(1000 * (i + 1)); }
  }
  return null;
}
const gh = async (p) => { const t = await getText('https://api.github.com' + p, GH_HEADERS); if (!t) return null; try { return JSON.parse(t); } catch { return null; } };
const slugOf = (url) => { const m = String(url || '').match(/github\.com\/([^/]+)\/([^/#?]+?)(?:\.git)?(?:[/#?].*)?$/i); return m ? `${m[1]}/${m[2]}` : null; };
const num = (n) => (n == null ? '' : Number(n).toLocaleString('en-US'));
const csvCell = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };

/* ---------- 1. the marketplace payload ---------- */
async function readMarketplace() {
  const html = await getText(MARKETPLACE, { 'User-Agent': BROWSER_UA }, 3, 60000);
  if (!html) throw new Error('marketplace page did not load');
  let buf = '';
  const re = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g;
  let m;
  while ((m = re.exec(html))) buf += JSON.parse(m[1]);
  const key = '"initialPlugins":';
  const i = buf.indexOf(key);
  if (i < 0) throw new Error('marketplace payload not found: the page shape changed, fix this parser rather than falling back to a snapshot');
  let s = i + key.length;
  while (buf[s] === ' ') s++;
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let j = s; j < buf.length; j++) {
    const c = buf[j];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') { depth--; if (depth === 0) { end = j + 1; break; } }
  }
  const all = JSON.parse(buf.slice(s, end));
  return all.filter((p) => p.status === 'PLUGIN_STATUS_APPROVED' && p.lifecycleState === 'PLUGIN_LIFECYCLE_STATE_PUBLIC_LISTED');
}

/* ---------- 2. the install command, off Cursor's own page ---------- */
async function verifyInstall(p) {
  const want = `/add-plugin ${p.name}`;
  const pub = p.publisher && p.publisher.name;
  const candidates = [`${MARKETPLACE}/${p.name}`];
  if (pub) candidates.push(`${MARKETPLACE}/${pub}/${p.name}`, `${MARKETPLACE}/${pub}`);
  for (const u of candidates) {
    const h = await getText(u, { 'User-Agent': BROWSER_UA });
    if (h && h.includes(want)) {
      const cm = h.match(/<link rel="canonical" href="(https:\/\/cursor\.com\/marketplace\/[^"]+)"/);
      return { install: want, url: cm ? cm[1] : u };
    }
  }
  return null;
}

/* ---------- 3. the file tree, which is where portability comes from ---------- */
async function readRepo(slug) {
  const meta = await gh(`/repos/${slug}`);
  if (!meta || !meta.full_name) return null;
  const tree = await gh(`/repos/${meta.full_name}/git/trees/${meta.default_branch}?recursive=1`);
  const paths = tree && tree.tree ? tree.tree.filter((t) => t.type === 'blob').map((t) => t.path) : [];
  /* A tree that failed to read, or came back truncated, is NOT evidence of absence. Saying
     "Cursor only" because an API call timed out is the one failure mode that would quietly make
     this list dishonest, so it is tracked and reported instead of defaulted to false. */
  const treeOk = !!(tree && tree.tree) && !(tree && tree.truncated);
  return {
    full_name: meta.full_name, stars: meta.stargazers_count, license: meta.license?.spdx_id || null,
    archived: !!meta.archived, fork: !!meta.fork, default_branch: meta.default_branch,
    description: meta.description || null, pushed_at: meta.pushed_at, truncated: !!(tree && tree.truncated), treeOk, paths,
  };
}

/* ---------- 4. the MCP endpoint, then a live handshake ---------- */
function collectMcp(obj, acc) {
  if (!obj || typeof obj !== 'object') return acc;
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'url' && typeof v === 'string') acc.urls.add(v);
    else if (k === 'command' && typeof v === 'string') acc.commands.add(v);
    else if (k === 'env' && v && typeof v === 'object') Object.keys(v).forEach((x) => acc.env.add(x));
    else if (k === 'headers' && v && typeof v === 'object') Object.keys(v).forEach((x) => acc.headers.add(x));
    else if (typeof v === 'object') collectMcp(v, acc);
  }
  return acc;
}
async function readMcpConfig(slug, branch, base, relPaths) {
  const acc = { urls: new Set(), commands: new Set(), env: new Set(), headers: new Set() };
  const direct = relPaths.filter((x) => /(^|\/)\.?mcp([_.-]?config|[_.-]?servers)?\.json$/i.test(x)).slice(0, 3);
  for (const f of direct) {
    const t = await getText(`https://raw.githubusercontent.com/${slug}/${branch}/${base}${f}`, GH_HEADERS);
    if (!t) continue;
    try { collectMcp(JSON.parse(t), acc); } catch {
      try { collectMcp(JSON.parse(t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '')), acc); } catch { /* not JSON, ignore */ }
    }
  }
  if (!acc.urls.size && !acc.commands.size) {
    for (const c of ['.cursor-plugin/plugin.json', 'plugin.json', '.claude-plugin/plugin.json']) {
      const t = await getText(`https://raw.githubusercontent.com/${slug}/${branch}/${base}${c}`, GH_HEADERS);
      if (!t) continue;
      let j; try { j = JSON.parse(t); } catch { continue; }
      const ms = j.mcpServers;
      if (typeof ms === 'string') {
        const t2 = await getText(`https://raw.githubusercontent.com/${slug}/${branch}/${base}${ms.replace(/^\.\//, '')}`, GH_HEADERS);
        if (t2) { try { collectMcp(JSON.parse(t2), acc); } catch { /* ignore */ } }
      } else if (ms && typeof ms === 'object') collectMcp({ mcpServers: ms }, acc);
    }
  }
  return { urls: [...acc.urls], commands: [...acc.commands], env: [...acc.env], headers: [...acc.headers] };
}
const INIT_BODY = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: `${OWNER}-${REPO}`, version: '1.0.0' } } });
const probeCache = new Map();
async function probe(url) {
  if (probeCache.has(url)) return probeCache.get(url);
  let out = { auth: 'unreachable' };
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 12000);
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'User-Agent': `${OWNER}/${REPO}` }, body: INIT_BODY, signal: ctl.signal });
    clearTimeout(t);
    const wa = r.headers.get('www-authenticate');
    const txt = (await r.text()).slice(0, 400);
    if (r.status === 401 || r.status === 403) {
      out = { auth: wa && /resource_metadata/i.test(wa) ? 'oauth' : 'auth-required' };
      const m = wa && wa.match(/resource_metadata="?([^",]+)"?/i);
      const prm = m ? m[1] : (() => { const o = new URL(url); return `${o.origin}/.well-known/oauth-protected-resource${o.pathname}`; })();
      const pt = await getText(prm, {}, 1, 8000);
      if (pt) { try { if (JSON.parse(pt).authorization_servers) out.auth = 'oauth'; } catch { /* ignore */ } }
    } else if (r.ok || r.status === 202) out = { auth: /"result"/.test(txt) ? 'none' : 'responds' };
    else out = { auth: 'http' + r.status };
  } catch { out = { auth: 'unreachable' }; }
  probeCache.set(url, out);
  return out;
}
function classifyAuth(e) {
  const urls = e.mcp.urls, tmpl = urls.filter((u) => u.includes('${'));
  const concrete = urls.filter((u) => /^https?:\/\//.test(u) && !u.includes('${'));
  const declaresKey = [...e.mcp.headers, ...e.mcp.env].some((k) => KEYRE.test(k));
  if (!e.hasMcpComponent) return ['skills-only', 'no MCP server component'];
  if (concrete.length) {
    const kinds = concrete.map((u) => probeCache.get(u)?.auth).filter(Boolean);
    if (kinds.includes('oauth')) return ['oauth', 'unauthenticated initialize returns 401 with protected-resource metadata that resolves'];
    if (declaresKey || kinds.includes('auth-required')) return ['token', 'unauthenticated initialize is rejected, or the config declares a key header'];
    if (kinds.includes('none')) return ['none', 'unauthenticated initialize returns a JSON-RPC result'];
    if (tmpl.length) return ['self-hosted', 'endpoint is a template you fill in'];
    return ['unknown', 'endpoint did not answer the probe'];
  }
  if (tmpl.length) return ['self-hosted', 'endpoint is a template you fill in with your own instance'];
  if (e.mcp.commands.length) return declaresKey ? ['token', 'runs locally and reads a key from the environment'] : ['local', 'runs locally over stdio, no key declared'];
  return ['unknown', 'no MCP configuration found in the source repo'];
}

/* ---------- main ---------- */
console.log('Reading the Cursor marketplace payload');
const listings = await readMarketplace();
console.log(`  ${listings.length} approved, publicly listed plugins`);
if (listings.length < 50) throw new Error('marketplace returned an implausibly small payload, refusing to write');

const repoSlugs = [...new Set(listings.map((p) => slugOf(p.repositoryUrl || p.gitUrl)).filter(Boolean))];
console.log(`Resolving ${repoSlugs.length} source repositories`);
const repos = {};
{
  let i = 0;
  const worker = async () => { while (i < repoSlugs.length) { const s = repoSlugs[i++]; repos[s] = await readRepo(s); } };
  await Promise.all(Array.from({ length: 8 }, worker));
}
const unresolved = repoSlugs.filter((s) => !repos[s]).length;
console.log(`  ${repoSlugs.length - unresolved} resolved, ${unresolved} did not`);
if (unresolved / repoSlugs.length > 0.05) throw new Error('more than 5% of source repos failed to resolve, refusing to publish a matrix built on gaps');

console.log('Deriving the portability matrix and reading MCP configs');
const entries = [];
{
  let i = 0;
  const worker = async () => {
    while (i < listings.length) {
      const p = listings[i++];
      const slug = slugOf(p.repositoryUrl || p.gitUrl);
      const r = slug ? repos[slug] : null;
      if (!r) { drop(`${p.name}: source repository ${slug || 'missing'} did not resolve`); continue; }
      if (r.archived) drop(`${p.name}: source repository is archived, kept but flagged`);
      const gp = p.gitPath && p.gitPath !== '.' ? p.gitPath.replace(/^\.\//, '').replace(/\/$/, '') : '';
      const base = gp ? gp + '/' : '';
      const rel = r.paths.filter((x) => !base || x.startsWith(base)).map((x) => (base ? x.slice(base.length) : x));
      const relSet = new Set(rel);
      const clients = {};
      for (const [key, dir] of CLIENTS) clients[key] = relSet.has(`${dir}/plugin.json`) || relSet.has(`${dir}/marketplace.json`);
      const cursorManifest = relSet.has('.cursor-plugin/plugin.json') || relSet.has('.cursor-plugin/marketplace.json');
      const portable = relSet.has('plugin.json') || rel.some((x) => /^\.agents\/plugins\/[^/]+\/plugin\.json$/.test(x));
      /* the marketplace pins a gitRef, so a gitPath can point at a directory that no longer exists
         at HEAD. Link the repo root rather than shipping a 404. */
      const pathLive = !gp || r.paths.some((x) => x.startsWith(gp + '/'));
      const hasMcpComponent = (p.mcpServers || []).length > 0;
      const mcp = hasMcpComponent ? await readMcpConfig(r.full_name, r.default_branch, base, rel) : { urls: [], commands: [], env: [], headers: [] };
      entries.push({
        name: p.name, displayName: p.displayName || p.name, description: (p.description || '').replace(/\s+/g, ' ').trim(),
        publisher: p.publisher?.displayName || p.publisher?.name || null, publisherUrl: p.publisher?.websiteUrl || null,
        repo: r.full_name, gitPath: gp || '.', stars: r.stars, license: r.license, archived: r.archived,
        repoDescription: r.description, pushedAt: r.pushed_at,
        skills: (p.skills || []).length, mcpServers: (p.mcpServers || []).length, commands: (p.commands || []).length,
        rules: (p.rules || []).length, agents: (p.agents || []).length, hooks: (p.hooks || []).length,
        clients, cursorManifest, portable, hasMcpComponent, mcp, pathLive, portabilityKnown: r.treeOk,
      });
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
}

console.log('Probing MCP endpoints for the sign-in column');
const allUrls = [...new Set(entries.flatMap((e) => e.mcp.urls).filter((u) => /^https?:\/\//.test(u) && !u.includes('${')))];
{
  let i = 0;
  const worker = async () => { while (i < allUrls.length) await probe(allUrls[i++]); };
  await Promise.all(Array.from({ length: 12 }, worker));
}
for (const e of entries) { const [a, why] = classifyAuth(e); e.auth = a; e.authEvidence = why; }

console.log('Verifying every install command against its own marketplace page');
{
  let i = 0;
  const worker = async () => {
    while (i < entries.length) {
      const e = entries[i++];
      const v = await verifyInstall({ name: e.name, publisher: listings.find((l) => l.name === e.name)?.publisher });
      if (v) { e.install = v.install; e.marketplaceUrl = v.url; e.installVerified = true; }
      else { e.install = `/add-plugin ${e.name}`; e.marketplaceUrl = `${MARKETPLACE}/${e.name}`; e.installVerified = false; }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
}
const unreadTrees = entries.filter((e) => !e.portabilityKnown).length;
if (unreadTrees) console.log(`  ${unreadTrees} entr(ies) had an unreadable or truncated file tree: reported as not established, never as "Cursor only"`);
if (entries.length && unreadTrees / entries.length > 0.05) throw new Error('more than 5% of file trees could not be read, refusing to publish a portability matrix built on gaps');

const verified = entries.filter((e) => e.installVerified).length;
console.log(`  ${verified} of ${entries.length} install commands read off Cursor's own pages`);
if (entries.length && verified / entries.length < 0.8) throw new Error('under 80% of install commands verified, refusing to publish unverified marks as if they were checked');

/* first-seen ledger: only ever records a date earlier, never later, so a re-listed entry keeps its original */
const seenPath = path.join(ROOT, '.github/data/first-seen.json');
let seen = { _note: 'When THIS catalog first listed each plugin. Written by build-catalog.mjs, never edited by hand, never back-dated.', entries: {} };
if (fs.existsSync(seenPath)) seen = JSON.parse(fs.readFileSync(seenPath, 'utf8'));
const today = new Date().toISOString().slice(0, 10);
for (const e of entries) if (!seen.entries[e.name]) seen.entries[e.name] = today;
fs.writeFileSync(seenPath, JSON.stringify(seen, null, 2) + '\n');

/* refuse to shrink silently */
const catalogPath = path.join(ROOT, 'CATALOG.md');
if (fs.existsSync(catalogPath)) {
  const prev = (fs.readFileSync(catalogPath, 'utf8').match(/^\| \[/gm) || []).length;
  if (prev && entries.length < prev * 0.9) throw new Error(`catalog would shrink from ${prev} to ${entries.length}, refusing. Investigate before forcing.`);
}

const clientLabel = Object.fromEntries(CLIENTS.map(([k, , label]) => [k, label]));
const alsoOf = (e) => { const a = CLIENTS.map(([k]) => k).filter((k) => e.clients[k]).map((k) => clientLabel[k]); if (e.portable) a.push('Agent Plugins'); return a; };
const portCell = (e) => (!e.portabilityKnown ? 'Not established' : alsoOf(e).length ? alsoOf(e).join(', ') : 'Cursor only');

/* ---------- CATALOG.md ---------- */
const sorted = [...entries].sort((a, b) => (b.stars || 0) - (a.stars || 0) || a.name.localeCompare(b.name));
const multi = entries.filter((e) => e.portabilityKnown && alsoOf(e).length).length;
const cursorOnly = entries.filter((e) => e.portabilityKnown && !alsoOf(e).length).length;
const authCount = (k) => entries.filter((e) => e.auth === k).length;
const noSignin = authCount('none') + authCount('local') + authCount('skills-only');
const md = [];
md.push('# Cursor plugin catalog: all ' + entries.length + ' listings, with portability and sign-in\n');
md.push(`Every approved, publicly listed plugin on [cursor.com/marketplace](${MARKETPLACE}), rebuilt from live sources on ${today}.`);
md.push('The curated page is [README.md](README.md). This file is the whole set.\n');
md.push(`**${multi} of ${entries.length}** ship a manifest for at least one agent besides Cursor. **${cursorOnly}** are Cursor and nothing else${unreadTrees ? `, and ${unreadTrees} could not be established this run` : ''}.`);
md.push(`**${authCount('oauth')}** use OAuth, **${noSignin}** have nothing to sign in to, **${authCount('token')}** want a token, **${authCount('self-hosted')}** point at your own instance.\n`);
md.push('Sorted by stars on the source repository. `Also runs in` is manifest presence in that repository, nothing inferred.\n');
md.push('| Plugin | Publisher | Stars | Also runs in | Sign-in | Install |');
md.push('|---|---|---:|---|---|---|');
for (const e of sorted) {
  md.push(`| [${e.name}](https://github.com/${e.repo}${e.gitPath !== '.' && e.pathLive ? '/tree/HEAD/' + e.gitPath : ''}) | ${e.publisher || ''} | ${num(e.stars)} | ${portCell(e)} | ${AUTH_LABEL[e.auth]} | \`${e.install}\` |`);
}
md.push('\n---\n');
md.push('<sub>Unofficial, community-maintained. Not affiliated with or endorsed by Anysphere or Cursor.</sub>');
fs.writeFileSync(catalogPath, md.join('\n') + '\n');

/* ---------- catalog.csv ---------- */
const cols = ['name', 'display_name', 'publisher', 'repo', 'git_path', 'stars', 'license', 'archived', 'skills', 'mcp_servers', 'commands', 'rules', 'agents', 'hooks', 'cursor_manifest', 'agent_plugins_portable', 'portability_established', ...CLIENTS.map(([k]) => 'runs_in_' + k), 'sign_in', 'sign_in_evidence', 'install', 'marketplace_url', 'install_verified', 'first_seen'];
const rows = [cols.join(',')];
for (const e of sorted) {
  rows.push([e.name, e.displayName, e.publisher, e.repo, e.gitPath, e.stars, e.license, e.archived, e.skills, e.mcpServers, e.commands, e.rules, e.agents, e.hooks, e.cursorManifest, e.portable, e.portabilityKnown, ...CLIENTS.map(([k]) => e.clients[k]), e.auth, e.authEvidence, e.install, e.marketplaceUrl, e.installVerified, seen.entries[e.name]].map(csvCell).join(','));
}
fs.writeFileSync(path.join(ROOT, 'catalog.csv'), rows.join('\n') + '\n');

/* ---------- plugins.json ---------- */
fs.writeFileSync(path.join(ROOT, 'plugins.json'), JSON.stringify({
  name: 'awesome-cursor-plugins',
  url: `https://github.com/${OWNER}/${REPO}`,
  source: `https://raw.githubusercontent.com/${OWNER}/${REPO}/main/plugins.json`,
  updated: today,
  count: entries.length,
  plugins: sorted.map((e) => ({
    name: e.name, owner: e.repo.split('/')[0], url: `https://github.com/${e.repo}`,
    description: { en: e.description || e.repoDescription || '' },
    stars: e.stars, install: e.install, added: seen.entries[e.name],
    page: e.marketplaceUrl, license: e.license,
    runs_in: e.portabilityKnown ? ['Cursor', ...alsoOf(e)] : null, sign_in: e.auth,
  })),
}, null, 2) + '\n');

/* ---------- badges ---------- */
const badge = (label, message, color) => JSON.stringify({ schemaVersion: 1, label, message, color }, null, 2) + '\n';
fs.mkdirSync(path.join(ROOT, 'badges'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'badges/verified.json'), badge('install commands', `${verified}/${entries.length} verified`, verified === entries.length ? 'brightgreen' : 'yellow'));
fs.writeFileSync(path.join(ROOT, 'badges/portability.json'), badge('runs beyond cursor', `${multi}/${entries.length}`, '6799FE'));
fs.writeFileSync(path.join(ROOT, 'badges/checked-at.json'), badge('last checked', new Date().toISOString().replace(/\.\d+Z$/, 'Z'), 'blue'));

/* ---------- README: every number on the page is written from this run ----------
   The curated prose is hand-written, but the counts are not. A page that says 110 while the
   catalog says 108 is worse than no page, so the three number-bearing blocks are regenerated
   here between markers and can never drift from the data behind them. */
const mcpCount = entries.filter((e) => e.hasMcpComponent).length;
const clientCounts = CLIENTS.map(([k, dir, label]) => ({ label, dir, n: entries.filter((e) => e.portabilityKnown && e.clients[k]).length })).filter((c) => c.n > 0).sort((a, b) => b.n - a.n);
const portableCount = entries.filter((e) => e.portabilityKnown && e.portable).length;
const bigRows = clientCounts.filter((c) => c.n >= 4);
const tailRows = clientCounts.filter((c) => c.n < 4);
const widest = [...entries].filter((e) => e.portabilityKnown).sort((a, b) => alsoOf(b).length - alsoOf(a).length)[0];
const second = [...entries].filter((e) => e.portabilityKnown && e.name !== widest?.name).sort((a, b) => alsoOf(b).length - alsoOf(a).length)[0];

const portBlock = [
  'A Cursor plugin is a directory with a manifest in it. Ship a second manifest and the same folder',
  `loads in a second agent. **${multi} of the ${entries.length} listings do exactly that. ${cursorOnly} are Cursor and nothing`,
  'else.** Both numbers come from reading the manifest directories in each plugin\'s own source',
  'repository.',
  '',
  '| Also loads in | Plugins | What proves it |',
  '|---|---:|---|',
  ...(() => {
    const rows = [];
    let placedPortable = false;
    for (const c of bigRows) {
      if (!placedPortable && portableCount > c.n) { rows.push(`| The Agent Plugins standard | ${portableCount} | \`plugin.json\` at the plugin root |`); placedPortable = true; }
      rows.push(`| ${c.label} | ${c.n} | \`${c.dir}/plugin.json\` |`);
    }
    if (!placedPortable) rows.push(`| The Agent Plugins standard | ${portableCount} | \`plugin.json\` at the plugin root |`);
    if (tailRows.length) rows.push(`| ${tailRows.map((c) => c.label).join(', ')} | ${tailRows.reduce((a, c) => a + c.n, 0)} | one manifest directory each |`);
    return rows;
  })(),
  '',
  'The widest-travelling plugin in the marketplace is',
  `[${widest.name}](https://github.com/${widest.repo}), which ships`,
  `manifests for ${alsoOf(widest).length} agents besides Cursor.`,
  `[${second.name}](https://github.com/${second.repo}) ships ${alsoOf(second).length}.`,
  'Per-plugin rows are on every entry below and in [CATALOG.md](CATALOG.md).',
].join('\n');

const signBlock = [
  `${mcpCount} of the ${entries.length} plugins bring an MCP server. The question that decides whether you install one`,
  'right now is whether it will ask you for credentials, and no listing page answers it. This one',
  'does, from a live handshake against each server.',
  '',
  '| What happens when you install | Plugins |',
  '|---|---:|',
  `| OAuth sign-in, click once and you are in | ${authCount('oauth')} |`,
  `| Nothing to sign in to | ${noSignin} |`,
  `| Paste a token or an API key first | ${authCount('token')} |`,
  `| Points at your own instance, so you configure the URL | ${authCount('self-hosted')} |`,
  `| Could not be established from outside | ${authCount('unknown')} |`,
  '',
  '`Nothing to sign in to` covers three honest cases: a plugin that is skills, rules, and commands',
  'only, a local server that runs on your machine, and a remote server that answers an',
  'unauthenticated request. Each entry says which.',
].join('\n');

const noSignBlock = [
  `**3. Sign in only if the entry says so.** ${noSignin} of the ${entries.length} have nothing to sign in to. The rest say`,
  '`OAuth sign-in`, `Paste a token`, or `Points at your own instance` on their own line, so you know',
  'before you install rather than after.',
].join('\n');

const readmePath = path.join(ROOT, 'README.md');
if (fs.existsSync(readmePath)) {
  let r = fs.readFileSync(readmePath, 'utf8');
  const between = (name, body) => {
    const re = new RegExp(`(<!-- ${name}:start -->\\n)[\\s\\S]*?(<!-- ${name}:end -->)`);
    if (!re.test(r)) { console.log(`  WARN: ${name} markers missing from README, block not refreshed`); return; }
    r = r.replace(re, `$1${body}\n$2`);
  };
  between('portability', portBlock);
  between('signin', signBlock);
  between('nosignin', noSignBlock);
  r = r.replace(/badge\/plugins-\d+-/, `badge/plugins-${entries.length}-`);
  r = r.replace(/\*\*Full catalog:\*\* all \d+ Cursor plugins/, `**Full catalog:** all ${entries.length} Cursor plugins`);
  r = r.replace(/^\*\*\d+ plugins from the Cursor marketplace/m, `**${entries.length} plugins from the Cursor marketplace`);
  fs.writeFileSync(readmePath, r);
}

console.log(`\nWrote CATALOG.md (${entries.length}), catalog.csv, plugins.json, 3 badges, first-seen ledger.`);
console.log(`Portability: ${multi} multi-client, ${cursorOnly} Cursor only, ${unreadTrees} not established.`);
console.log(`Sign-in: ${authCount('oauth')} OAuth, ${noSignin} none, ${authCount('token')} token, ${authCount('self-hosted')} self-hosted, ${authCount('unknown')} unestablished.`);
console.log(drops.length ? `${drops.length} drop(s) this run, listed above.` : 'No drops this run.');
