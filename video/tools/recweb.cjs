'use strict';
// Record a web app (local demo stacks or the live demo site) in the frames.json/events.json format of
// recpage.cjs, for post.py. Launches its own Chrome for Testing (headless) instead of attaching to a
// signed-in window, and records event coordinates in screencast-frame pixels.
// node recweb.cjs scene.json outdir [--dry]
//
// scene: {viewport:{width,height}, dsf, mobile, storageState, init:[js...], start:{x,y} (css px), steps:[...]}
// steps (targets: sel | text | role+name, optional nth):
//   {op:'caption', text, say?, wait?}       caption bar text; say = narration (defaults to text)
//   {op:'goto', url, wait?}                  local URLs only
//   {op:'click', <target>, wait?, move?}     eased cursor move, click pulse, real click
//   {op:'tap', <target>, wait?}              same as click, for touch scenes
//   {op:'hover', <target>, wait?}
//   {op:'type', <target>?, text, delay?, select?, wait?}   click the target first when given
//   {op:'press', key, wait?}
//   {op:'drag', from:<target>, to:<target>, wait?}
//   {op:'scroll', js, wait?}                 run a smooth-scroll snippet in the page
//   {op:'swipe', from:{x,y}, to:{x,y}, js, wait?}  draw a finger swipe (css px) while js scrolls
//   {op:'wait', ms} | {op:'waitfor', <target>} | {op:'eval', js}
const fs = require('fs'); const path = require('path');
// PLAYWRIGHT: path to a playwright package (default: resolve 'playwright'); CHROME: browser binary.
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');
const EXE = process.env.CHROME || undefined;  // undefined: playwright's own Chromium
const scene = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const out = process.argv[3]; const dry = process.argv.includes('--dry');
// goto is limited to local stacks and the demo's own hosts; RECWEB_ALLOW (a regex) overrides.
const LOCAL = new RegExp(process.env.RECWEB_ALLOW || '^(http://(localhost|127\\.0\\.0\\.1):\\d+/|https://vondemo\\.pages\\.dev/|https://automation-demos\\.vonc\\.workers\\.dev/)');
if (!dry) { fs.rmSync(out, {recursive: true, force: true}); fs.mkdirSync(out, {recursive: true}); }
const VW = scene.viewport.width, VH = scene.viewport.height, DSF = scene.dsf || 1;
(async () => {
  const browser = await chromium.launch({executablePath: EXE, args: ['--hide-scrollbars']});
  const ctx = await browser.newContext({viewport: {width: VW, height: VH}, deviceScaleFactor: DSF, isMobile: !!scene.mobile, hasTouch: !!scene.mobile, permissions: scene.permissions || [], extraHTTPHeaders: Object.fromEntries(Object.entries(scene.headers || {}).map(([k, v]) => [k, String(v).replace('RAND', String(2 + Math.floor(Math.random() * 250)))])),  // RAND: a fresh client IP per take (FixLink allows one vote per IP and guide per day, in memory)
    storageState: scene.storageState ? path.resolve(path.dirname(process.argv[2]), scene.storageState) : undefined});
  // Hide the Next.js dev indicator and any scrollbars.
  await ctx.addInitScript(() => document.addEventListener('DOMContentLoaded', () => { const s = document.createElement('style'); s.textContent = 'nextjs-portal{display:none!important}'; document.head.append(s); }));
  for (const js of scene.init || []) await ctx.addInitScript(js);
  await ctx.route((u) => !/^(http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/|data:|blob:)/.test(u.toString()), (r) => r.abort());
  // scene.originSwap {match, from, to}: routes that print their own request origin (FixLink agent.md) show the
  // production origin they would print there; next dev always reports localhost.
  if (scene.originSwap) await ctx.route((u) => u.toString().includes(scene.originSwap.match), async (r) => { const res = await r.fetch(); const body = (await res.text()).split(scene.originSwap.from).join(scene.originSwap.to); await r.fulfill({response: res, body}); });
  const page = await ctx.newPage();
  const events = []; const frames = []; const t0 = Date.now(); const now = () => (Date.now() - t0) / 1000;
  const cdp = await ctx.newCDPSession(page);
  // Screenshot loop instead of Page.startScreencast: the screencast ignores deviceScaleFactor, while
  // captureScreenshot with clip.scale returns device pixels (about 35 fps at 1920x968 or 1170x2532).
  // The clip is in document coordinates, so it follows the scroll position.
  let capturing = !dry; let loopDone = Promise.resolve();
  const startLoop = () => { loopDone = (async () => { while (capturing) { const a = now(); try { const m = await cdp.send('Page.getLayoutMetrics'); const r = await cdp.send('Page.captureScreenshot', {format: 'jpeg', quality: 90, optimizeForSpeed: true, clip: {x: m.cssVisualViewport.pageX, y: m.cssVisualViewport.pageY, width: VW, height: VH, scale: DSF}}); const n = frames.length; frames.push((a + now()) / 2); fs.writeFile(path.join(out, `f${String(n).padStart(5, '0')}.jpg`), Buffer.from(r.data, 'base64'), () => {}); } catch (e) { await new Promise((r) => setTimeout(r, 30)); } const left = 1 / 30 - (now() - a); if (left > 0) await new Promise((r) => setTimeout(r, left * 1000)); } })(); };
  const tick = null;
  const S = (v) => Math.round(v * DSF);  // css px -> frame px
  let cur = scene.start || {x: VW * 0.6, y: VH * 0.6};
  events.push({t: 0, type: 'cursor', x: S(cur.x), y: S(cur.y)});
  const moveTo = async (p, ms) => {
    const dur = ms || 650; const steps = Math.max(8, Math.round(dur / 16));
    events.push({t: now(), type: 'move', x0: S(cur.x), y0: S(cur.y), x: S(p.x), y: S(p.y), dur: dur / 1000});
    for (let i = 1; i <= steps; i++) { const k = i / steps; const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2; if (!scene.mobile) await page.mouse.move(cur.x + (p.x - cur.x) * e, cur.y + (p.y - cur.y) * e); await page.waitForTimeout(16); }
    cur = {x: p.x, y: p.y};
  };
  const loc = (s) => {
    let l = s.sel ? page.locator(s.sel) : s.role ? page.getByRole(s.role, {name: s.name, exact: !!s.exact}) : page.getByText(s.text, {exact: !!s.exact});
    l = s.nth !== undefined ? l.nth(s.nth) : l.first();
    return l;
  };
  const center = async (l, s = {}) => {
    await l.waitFor({state: 'visible', timeout: 8000});
    // A target outside the viewport is scrolled to the middle smoothly first (mouse clicks do not scroll).
    const vis = await l.evaluate((el) => { const r = el.getBoundingClientRect(); return r.top >= 60 && r.bottom <= innerHeight - 20; });
    if (!vis) { await l.evaluate((el) => { const r = el.getBoundingClientRect(); window.scrollBy({top: r.top + r.height / 2 - innerHeight / 2, behavior: 'smooth'}); }); await page.waitForTimeout(900);
      // still hidden: it sits in its own scroll box (a drawer), so scroll that box
      if (!(await l.evaluate((el) => { const r = el.getBoundingClientRect(); return r.top >= 60 && r.bottom <= innerHeight - 20; }))) { await l.evaluate((el) => el.scrollIntoView({behavior: 'smooth', block: 'nearest', inline: 'nearest'})); await page.waitForTimeout(800); } }  // vertical window scroll first: scrollIntoView also scrolled sideways
    const b = await l.boundingBox(); return {x: Math.round(b.x + (s.dx !== undefined ? s.dx : Math.min(b.width / 2, 140))), y: Math.round(b.y + (s.dy !== undefined ? s.dy : b.height / 2))}; };
  const res = [];
  let started = false;
  try {
    for (const s of scene.steps) {
      if (!started && !dry && s.op !== 'goto' && s.op !== 'eval') { startLoop(); started = true; }  // skip blank frames before the first page draws
      if (dry) res.push(s.op + ' ' + (s.sel || s.text || s.name || s.url || ''));
      if (s.op === 'caption') { events.push({t: now(), type: 'caption', text: s.text, say: s.say || s.text}); if (s.wait) await page.waitForTimeout(s.wait); }
      else if (s.op === 'goto') { if (!LOCAL.test(s.url)) throw new Error('blocked url ' + s.url); await page.goto(s.url, {waitUntil: 'load', timeout: 30000}); await page.waitForTimeout(s.wait || 1500); }
      else if (s.op === 'click' || s.op === 'tap' || s.op === 'hover') {
        const l = loc(s); const p = await center(l, s); await moveTo(p, s.move); await page.waitForTimeout(s.op === 'hover' ? 100 : 250);
        if (s.op !== 'hover') { events.push({t: now(), type: 'click', x: S(cur.x), y: S(cur.y)}); if (s.op === 'tap') await page.touchscreen.tap(p.x, p.y); else await page.mouse.click(p.x, p.y); }
        await page.waitForTimeout(s.wait || 1200);
      }
      else if (s.op === 'type') {
        if (s.sel || s.text || s.role) { const l = loc(s); const p = await center(l, s); await moveTo(p, s.move); await page.waitForTimeout(200); events.push({t: now(), type: 'click', x: S(cur.x), y: S(cur.y)}); await page.mouse.click(p.x, p.y); }
        if (s.select) { await page.keyboard.press('Meta+A'); }
        if (s.end) { await page.keyboard.press('End'); }
        await page.keyboard.type(s.text, {delay: s.delay || 45}); await page.waitForTimeout(s.wait || 500);
      }
      else if (s.op === 'press') { await page.keyboard.press(s.key); await page.waitForTimeout(s.wait || 400); }
      else if (s.op === 'drag') {
        const a = await center(loc(s.from), s.from); await moveTo(a, s.move); await page.waitForTimeout(250);
        events.push({t: now(), type: 'click', x: S(cur.x), y: S(cur.y)}); await page.mouse.down();
        const b = await center(loc(s.to), s.to); await moveTo({x: b.x, y: b.y + (s.overshoot || 0)}, s.dragMs || 1100); await page.waitForTimeout(250);
        await page.mouse.up(); await page.waitForTimeout(s.wait || 1200);
      }
      else if (s.op === 'scroll') { await page.evaluate(s.js); await page.waitForTimeout(s.wait || 1200); }
      else if (s.op === 'swipe') {
        await moveTo(s.from, 350); events.push({t: now(), type: 'click', x: S(cur.x), y: S(cur.y)});
        const pr = page.evaluate(s.js); await moveTo(s.to, s.ms || 450); await pr; await page.waitForTimeout(s.wait || 1000);
      }
      else if (s.op === 'wait') await page.waitForTimeout(s.ms);
      else if (s.op === 'waitfor') await loc(s).waitFor({state: 'visible', timeout: s.timeout || 15000});
      else if (s.op === 'eval') res.push(await page.evaluate(s.js));
      else if (s.op === 'shot') await page.screenshot({path: s.path});
    }
  } catch (e) { res.push('ERR ' + String(e && e.message || e).slice(0, 400)); }
  events.push({t: now(), type: 'end'});
  clearInterval(tick); capturing = false; await loopDone; await page.waitForTimeout(400);
  if (!dry) { fs.writeFileSync(path.join(out, 'frames.json'), JSON.stringify(frames)); fs.writeFileSync(path.join(out, 'events.json'), JSON.stringify(events, null, 1)); }
  await browser.close();
  process.stdout.write(JSON.stringify({frames: frames.length, seconds: Number(now().toFixed(1)), res}, null, 1) + '\n'); process.exit(0);
})().catch((e) => { process.stdout.write('ERR ' + (e && e.message || e) + '\n'); process.exit(1); });
