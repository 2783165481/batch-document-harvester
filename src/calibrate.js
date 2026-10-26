// Calibration: find the real "selected" class, test whether state survives a reload,
// and map the rich-text editor iframe structure.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const USER_DATA = path.join(__dirname, '.profile');
const OUT = path.join(__dirname, 'calibrate.json');

function launchOptions() {
  const base = { headless: false, viewport: { width: 1500, height: 980 }, args: ['--disable-blink-features=AutomationControlled'] };
  const cands = {
    msedge: [`${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`, `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`],
    chrome: [`${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`, `${process.env['ProgramFiles(x86)']}\\Google\\Chrome\\Application\\chrome.exe`],
  };
  for (const [channel, paths] of Object.entries(cands)) if (paths.some((p) => p && fs.existsSync(p))) return { ...base, channel };
  return base;
}

function DUMP() {
  const a = document.querySelector('.mark_name');
  if (!a) return null;
  const box = a.closest('.contentCard, .legacyCard') || a.parentElement;
  return {
    no: (a.innerText.match(/^\s*(\d{1,3})\s*[.、]/) || [])[1],
    opts: [...box.querySelectorAll('.payloadBg')].map((o) => ({
      cls: String(o.className),
      head: (o.innerHTML || '').replace(/\s+/g, ' ').slice(0, 120),
    })),
  };
}

async function ensureCard(page) {
  const vis = await page.evaluate(() => {
    let c = 0;
    for (const e of document.querySelectorAll('li,a,span,div')) {
      const t = (e.innerText || '').trim();
      if (!/^\d{1,3}$/.test(t) || e.offsetParent === null) continue;
      const r = e.getBoundingClientRect();
      if (r.width > 5 && r.height > 5) c++;
    }
    return c;
  });
  if (vis >= 20) return;
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('a,button,div,span')].find((e) => (e.innerText || '').trim() === 'Answer sheet' && e.offsetParent !== null);
    if (el) el.click();
  });
  await page.waitForTimeout(700);
}

async function jump(page, n) {
  return await page.evaluate((n) => {
    const cands = [];
    for (const e of document.querySelectorAll('*')) {
      const t = (e.innerText || '').trim();
      if (t !== String(n) || e.offsetParent === null) continue;
      const r = e.getBoundingClientRect();
      if (r.width < 5 || r.height < 5) continue;
      cands.push(e);
    }
    if (!cands.length) return false;
    cands.sort((a, b) => a.children.length - b.children.length);
    cands[0].click();
    return true;
  }, n);
}

(async () => {
  const ctx = await chromium.launchPersistentContext(USER_DATA, launchOptions());
  const page = ctx.pages()[0] || (await ctx.newPage());
  const url = process.argv[2];
  if (url) await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(3000);

  const out = {};

  // 1) first item, state before any click
  await ensureCard(page);
  await jump(page, 1);
  await page.waitForTimeout(800);
  out.q1_before = await page.evaluate(DUMP);

  // 2) class change after clicking option A
  await page.evaluate(() => {
    const box = document.querySelector('.contentCard') || document.body;
    const o = box.querySelectorAll('.payloadBg')[0];
    if (o) o.click();
  });
  await page.waitForTimeout(900);
  out.q1_afterClick = await page.evaluate(DUMP);

  // 3) does it survive a reload
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  await ensureCard(page);
  await jump(page, 1);
  await page.waitForTimeout(800);
  out.q1_afterReload = await page.evaluate(DUMP);

  // 4) restore state (click again to deselect)
  await page.evaluate(() => {
    const box = document.querySelector('.contentCard') || document.body;
    const o = box.querySelectorAll('.payloadBg')[0];
    if (o && /check|active|selected|cur/i.test(o.className)) o.click();
  });
  await page.waitForTimeout(600);

  // 5) rich-text editor iframe structure
  await ensureCard(page);
  await jump(page, 31);
  await page.waitForTimeout(1200);
  out.q31_frameList = page.frames().map((f) => ({ url: f.url().slice(0, 120), name: f.name() }));

  for (const f of page.frames()) {
    if (f === page.mainFrame()) continue;
    try {
      const info = await f.evaluate(() => ({
        hasBody: !!document.body,
        editable: document.body ? document.body.isContentEditable : false,
        editorFound: !!document.querySelector('.edui-body-container, [contenteditable="true"], body'),
        html: (document.body ? document.body.innerHTML : '').slice(0, 300),
        text: (document.body ? document.body.innerText : '').slice(0, 100),
      }));
      out.q31_frame = { url: f.url().slice(0, 120), ...info };
      break;
    } catch (e) {
      out.q31_frameErr = e.message;
    }
  }

  // 6) main-frame textarea vs iframe relationship
  out.q31_mainDom = await page.evaluate(() => {
    const box = document.querySelector('.contentCard') || document.body;
    const ta = box.querySelector('textarea');
    const ifr = box.querySelector('iframe');
    return {
      textareaId: ta ? ta.id : null,
      textareaName: ta ? ta.name : null,
      textareaDisplay: ta ? getComputedStyle(ta).display : null,
      iframeId: ifr ? ifr.id : null,
      iframeSrc: ifr ? ifr.src.slice(0, 120) : null,
      boxHtml: box.innerHTML.replace(/\s+/g, ' ').slice(0, 800),
    };
  });

  fs.writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');
  console.log(JSON.stringify(out, null, 2).slice(0, 3000));
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
