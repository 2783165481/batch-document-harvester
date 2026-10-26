// Batch collector for dynamic, scroll-loaded content.
// Usage: node src/collect.js <page-url>
// Requires: npm i playwright  (system Edge/Chrome is reused, no Chromium download)
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const USER_DATA = path.join(__dirname, '.profile');   // persistent session directory
const OUT = path.join(__dirname, 'items.json');

// Reuse installed Edge/Chrome instead of downloading Chromium.
function launchOptions() {
  const base = {
    headless: false,
    viewport: { width: 1440, height: 950 },
    args: ['--disable-blink-features=AutomationControlled'],
  };
  const cands = {
    msedge: [
      `${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
    ],
    chrome: [
      `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env['ProgramFiles(x86)']}\\Google\\Chrome\\Application\\chrome.exe`,
    ],
  };
  for (const [channel, paths] of Object.entries(cands)) {
    if (paths.some((p) => p && fs.existsSync(p))) return { ...base, channel };
  }
  return base;
}

(async () => {
  const ctx = await chromium.launchPersistentContext(USER_DATA, launchOptions());
  const page = ctx.pages()[0] || (await ctx.newPage());
  const url = process.argv[2];
  if (url) await page.goto(url, { waitUntil: 'domcontentloaded' });

  console.log('>>> Browser open. Log in, go to the target page, wait for content to load, then press Enter.');
  await new Promise((r) => process.stdin.once('data', r));

  const items = await page.evaluate(() => {
    const norm = (s) =>
      (s || '').replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();

    const SEL = '.contentCard, .legacyCard, [class*="questionItem"], [class*="question-item"], .mark_item';
    const nodes = [...document.querySelectorAll(SEL)];

    return nodes
      .map((n, i) => {
        const stemEl = n.querySelector(
          '.mark_name, .Zy_TItle, .qtContent, [class*="stem"], [class*="title"]'
        );
        const stem = norm(stemEl ? stemEl.innerText : n.innerText).slice(0, 1200);

        const optEls = [
          ...n.querySelectorAll(
            '.payloadBg, .Zy_ulTop li, [class*="option"], [class*="choice"] li'
          ),
        ];
        const options = optEls.map((o) => norm(o.innerText)).filter(Boolean);

        const ed = n.querySelector(
          'textarea, [contenteditable="true"], .ace_text-input, .monaco-editor textarea'
        );
        const inputs = [...n.querySelectorAll('input[type=text]')].length;
        const kind = (n.className || '') + ' ' + (n.getAttribute('data-type') || '');

        let type = 'unknown';
        if (ed) type = 'code';
        else if (options.length) {
          const binary = options.length === 2 && /^(true|false|yes|no|t|f|on|off)/i.test(options[0].trim());
          type = binary || /bool|judge/i.test(kind) ? 'boolean' : 'choice';
        } else if (inputs) type = 'fill';
        else if (/essay|long|free.?text|describe/i.test(kind + stem.slice(0, 30))) type = 'text';

        return { i, type, stem, options, blanks: inputs, hasEditor: !!ed };
      })
      .filter((q) => q.stem);
  });

  fs.writeFileSync(OUT, JSON.stringify(items, null, 2), 'utf8');
  const byType = items.reduce((a, q) => ((a[q.type] = (a[q.type] || 0) + 1), a), {});
  console.log(`>>> collected ${items.length} items -> ${OUT}`);
  console.log('>>> by type:', JSON.stringify(byType));
  console.log('>>> Done. Review the output file, then close the browser.');
})();
