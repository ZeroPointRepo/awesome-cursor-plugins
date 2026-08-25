#!/usr/bin/env node
/* Resolves every GitHub repo linked from README.md through the API and reports renames, archives,
   and 404s. A link check cannot see any of these: all three return HTTP 200.
   Advisory by design. It always exits 0 so it can never gate a contributor's PR. */
import fs from 'node:fs';
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const H = { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'awesome-cursor-plugins/entry-health' };
const readme = fs.readFileSync('README.md', 'utf8');
const slugs = [...new Set([...readme.matchAll(/https:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)/g)].map((m) => `${m[1]}/${m[2]}`))];
const findings = [];
let checked = 0, unchecked = 0;
for (const slug of slugs) {
  const r = await fetch(`https://api.github.com/repos/${slug}`, { headers: H });
  if (r.status === 403 || r.status === 429) { unchecked++; continue; }
  if (r.status === 404) { findings.push(`GONE      ${slug}`); checked++; continue; }
  if (!r.ok) { unchecked++; continue; }
  const j = await r.json();
  checked++;
  if (j.full_name.toLowerCase() !== slug.toLowerCase()) findings.push(`RENAMED   ${slug} is now ${j.full_name}`);
  if (j.archived) findings.push(`ARCHIVED  ${slug}`);
}
const summary = `${checked} repos checked, ${unchecked} not checked (rate limited, reported rather than counted clean), ${findings.length} finding(s).`;
console.log(summary);
findings.forEach((f) => console.log('  ' + f));
fs.writeFileSync('entry-health.txt', [summary, ...findings].join('\n') + '\n');
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `found=${findings.length > 0}\n`);
process.exit(0);
