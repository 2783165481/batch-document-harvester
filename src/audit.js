// Read-only audit: no clicks, only reads the current state of each item.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const USER_DATA = path.join(__dirname, '.profile');
const OUT = path.join(__dirname, 'audit.json');

function launchOptions() {
  const base = { headless: false, viewport: { width: 1500, height: 980 }, args: ['--disable-blink-features=AutomationControlled'] };
  const cands = {
    msedge: [`${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`, `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`],
    chrome: [`${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`, `${process.env['ProgramFiles(x86)']}\\Google\\Chrome\\Application\\chrome.exe`],
  };
  for (const [channel, paths] of Object.entries(cands)) if (paths.some((p) => p && fs.existsSync(p))) return { ...base, channel };
  return base;
}

function READ_STATE() {
  const norm = (s) => (s || '').replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').trim();
  const a = document.querySelector('.mark_name, .Zy_TItle, .qtContent');
  if (!a) return null;
  const stem = norm(a.innerText);
  const no = (stem.match(/^\s*(\d{1,3})\s*[.、]/) || [])[1];
  const box = a.closest('.contentCard, .legacyCard, [class*="questionItem"], [class*="question_box"], .mark_item') || a.parentElement;

  const opts = [...box.querySelectorAll('.payloadBg')].map((o) => {
    const cls = String(o.className || '');
    const inner = o.innerHTML || '';
    return {
      text: norm(o.innerText).slice(0, 30),
      cls: cls,
      selected: /check_payload|checked|active|selected|cur|choose/i.test(cls) || /checked|selected/i.test(inner),
    };
  });

  const controls = [];
  for (const el of box.querySelectorAll('input[type=text], textarea, [contenteditable="true"], iframe')) {
    controls.push({
      tag: el.tagName,
      cls: String(el.className || '').slice(0, 60),
      valueLen: el.value ? el.value.length : (el.innerText || '').length,
      valueHead: (el.value || el.innerText || '').slice(0, 40),
    });
  }

  return { no: no ? +no : null, stem: stem.slice(0, 60), opts, controls };
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

async function jumpHard(page, n) {
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

  await ensureCard(page);
  const nums = await page.evaluate(() => {
    const s = new Set();
    for (const e of document.querySelectorAll('li,a,span,div,p')) {
      const t = (e.innerText || '').trim();
      if (!/^\d{1,3}$/.test(t) || e.offsetParent === null) continue;
      const r = e.getBoundingClientRect();
      if (r.width > 5 && r.height > 5) s.add(+t);
    }
    return [...s].sort((a, b) => a - b);
  });

  const report = [];
  for (const n of nums) {
    let st = null;
    for (let a = 1; a <= 3 && !st; a++) {
      try {
        await ensureCard(page);
        await jumpHard(page, n);
        await page.waitForTimeout(450 + a * 150);
        const s = await page.evaluate(READ_STATE);
        if (s && s.no === n) st = s;
      } catch (e) {
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        await page.waitForTimeout(900);
      }
    }
    if (st) {
      report.push(st);
      const sel = st.opts.filter((o) => o.selected).map((o) => o.text.slice(0, 2)).join('');
      const ctl = st.controls.map((c) => `${c.tag}:${c.valueLen}`).join(',');
      console.log(`${String(n).padStart(2)} selected[${sel}] ${ctl}`);
    } else {
      console.log(`${String(n).padStart(2)} read failed`);
      report.push({ no: n, failed: true });
    }
  }

  fs.writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8');
  const filled = report.filter((r) => r.opts && r.opts.some((o) => o.selected)).length;
  const emptyCtl = report.filter((r) => r.controls && r.controls.length && r.controls.every((c) => c.valueLen === 0)).length;
  console.log(`\nAUDIT ${report.length} items: ${filled} filled, ${emptyCtl} empty`);
  console.log(`FILE ${OUT}`);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
