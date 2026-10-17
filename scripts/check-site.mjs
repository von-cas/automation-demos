#!/usr/bin/env node
// Static checks for site/: every page has lang, title and description; every image has alt text;
// internal links and #anchors resolve; no inline styles or inline scripts (the CSP blocks them).
// `--external` also requests each external link once and fails on 4xx/5xx.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';

const ROOT = new URL('../site/', import.meta.url).pathname;
const external = process.argv.includes('--external');
const problems = [];
const externalLinks = new Set();

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const pages = walk(ROOT).filter((p) => p.endsWith('.html'));
const ids = new Map(pages.map((p) => [p, new Set([...readFileSync(p, 'utf8').matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]))]));

function resolvePage(fromPage, href) {
  const [path, hash] = href.split('#');
  let target = fromPage;
  if (path) {
    let p = path.startsWith('/') ? join(ROOT, path) : join(dirname(fromPage), path);
    if (p.endsWith('/')) p = join(p, 'index.html');
    else if (!existsSync(p) && existsSync(join(p, 'index.html'))) p = join(p, 'index.html');
    target = p;
  }
  return { target, hash };
}

for (const page of pages) {
  const html = readFileSync(page, 'utf8');
  const rel = relative(ROOT, page);
  const flag = (msg) => problems.push(`${rel}: ${msg}`);

  if (!/<html[^>]*\slang="[a-z-]+"/.test(html)) flag('missing <html lang>');
  if (!/<title>[^<]{10,}<\/title>/.test(html)) flag('missing or short <title>');
  if (!/<meta name="description" content="[^"]{50,}"/.test(html)) flag('missing or short meta description');
  if (!/<meta name="viewport"/.test(html)) flag('missing viewport meta');
  if (/\sstyle="/.test(html)) flag('inline style attribute (blocked by CSP)');
  for (const m of html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>/g)) flag(`inline script (blocked by CSP): ${m[0]}`);
  for (const m of html.matchAll(/<img\b[^>]*>/g)) if (!/\salt="[^"]+"/.test(m[0])) flag(`image without alt: ${m[0].slice(0, 80)}`);
  const h1 = (html.match(/<h1\b/g) ?? []).length;
  if (h1 !== 1) flag(`expected one <h1>, found ${h1}`);

  for (const m of html.matchAll(/\shref="([^"]+)"/g)) {
    const href = m[1].replace(/&amp;/g, '&');
    if (/^(mailto:|tel:)/.test(href)) continue;
    if (/^https?:\/\//.test(href)) {
      if (!href.startsWith('https://fonts.')) externalLinks.add(href.split('#')[0]);
      continue;
    }
    const { target, hash } = resolvePage(page, href);
    if (!existsSync(target)) {
      flag(`broken link ${href}`);
      continue;
    }
    if (hash && target.endsWith('.html') && !ids.get(target)?.has(hash)) flag(`missing anchor ${href}`);
  }
  for (const m of html.matchAll(/\ssrc="(\/[^"]+)"/g)) if (!existsSync(join(ROOT, m[1]))) flag(`missing file ${m[1]}`);
  for (const m of html.matchAll(/aria-(?:labelledby|controls)="([^"]+)"/g)) {
    for (const id of m[1].split(/\s+/)) if (!ids.get(page)?.has(id)) flag(`aria reference to missing id ${id}`);
  }
}

if (external) {
  for (const url of externalLinks) {
    try {
      const res = await fetch(url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(15_000) });
      if (res.status >= 400) problems.push(`external ${url}: HTTP ${res.status}`);
      else console.log(`ok ${res.status} ${url}`);
    } catch (err) {
      problems.push(`external ${url}: ${err.message}`);
    }
  }
}

if (problems.length) {
  console.error(problems.map((p) => `✗ ${p}`).join('\n'));
  process.exit(1);
}
console.log(`site ok: ${pages.length} pages${external ? `, ${externalLinks.size} external links` : ''}`);
