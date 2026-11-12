#!/usr/bin/env node
/**
 * submit-container-token.js — submit a token obtained from the DEPLOYED
 * container's POST /solve to SECOP, in one browser session with a fresh mkey.
 *
 * Proves the production chain: scraper-shaped API call → container farm solve
 * → unconsumed token → single-session submission.
 *
 * Usage: node submit-container-token.js <path-to-response.json>
 * The JSON is the /solve response: {success, token, method, ...}
 */

require('dotenv').config();
const fs = require('fs');
const {
  SECOP_CAPTCHA_INDEX_URL,
  SECOP_CAPTCHA_CHECK_URL,
  USER_AGENT,
} = require('./src/solver-ponytail');

const PREVIOUS_URL =
  'https://community.secop.gov.co/Public/Tendering/ContractNoticeManagement/Index?currentLanguage=es-CO&Page=login&Country=CO&SkinName=CCE';

async function main() {
  const responsePath = process.argv[2];
  if (!responsePath) {
    console.error('Usage: node submit-container-token.js <solve-response.json>');
    process.exit(1);
  }
  const solve = JSON.parse(fs.readFileSync(responsePath, 'utf-8'));

  if (!solve.success || !solve.token || solve.token.length < 50) {
    console.error('✗ /solve response is not a success:', JSON.stringify(solve).substring(0, 300));
    process.exit(1);
  }

  console.log('Container /solve response:');
  console.log(`  method:    ${solve.method}`);
  console.log(`  solvedAt:  ${solve.solvedAt}`);
  console.log(`  expiresIn: ${solve.expiresIn}s`);
  console.log(`  token:     ${solve.token.substring(0, 40)}... (${solve.token.length} chars)`);
  console.log(`  google field present: ${'google' in solve} (want false)`);
  console.log(`  secop field present:  ${'secop' in solve} (want false)`);
  if ('google' in solve || 'secop' in solve) {
    console.error('✗ FAIL: /solve still carries verification fields — old image?');
    process.exit(1);
  }

  // Submit immediately — single-use token, ~2 min TTL
  const puppeteer = require('puppeteer');
  const execPath = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH || '';
  if (execPath && !fs.existsSync(execPath)) {
    delete process.env.PUPPETEER_EXECUTABLE_PATH;
    delete process.env.CHROME_PATH;
  }

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--disable-setuid-bounce',
      '--disable-dev-shm-usage',
      '--disable-extensions',
      '--disable-gpu',
      '--disable-blink-features=AutomationControlled',
    ],
    defaultViewport: { width: 1280, height: 720 },
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);

    await page.goto(`${SECOP_CAPTCHA_INDEX_URL}?previousUrl=${encodeURIComponent(PREVIOUS_URL)}`, {
      waitUntil: 'networkidle0',
      timeout: 30000,
    });

    const mkey = await page.evaluate(() => {
      const btn = document.getElementById('btnCaptchaCheckButton');
      if (!btn) return null;
      const match = (btn.getAttribute('onclick') || '').match(/mkey=([a-f0-9_]+)/);
      return match ? match[1] : null;
    });
    if (!mkey) throw new Error('could not extract mkey');
    console.log(`Fresh mkey: ${mkey}`);

    await page.evaluate((t) => {
      const txa = document.getElementById('txaresponseKey');
      if (txa) txa.value = t;
      const g = document.getElementById('g-recaptcha-response');
      if (g) g.value = t;
    }, solve.token);

    const checkUrl = `${SECOP_CAPTCHA_CHECK_URL}?responseKey=${encodeURIComponent(solve.token)}&mkey=${encodeURIComponent(mkey)}`;
    const res = await page.goto(checkUrl, { waitUntil: 'networkidle0', timeout: 30000 });
    await new Promise((r) => setTimeout(r, 3000));

    const finalUrl = page.url();
    const rejected =
      finalUrl.includes('ErrorPage') || finalUrl.toLowerCase().includes('expired') || finalUrl.includes('GoogleReCaptcha');
    console.log(`CaptchaCheck → status ${res ? res.status() : '?'} | ${finalUrl.substring(0, 110)}`);

    await page.goto(PREVIOUS_URL, { waitUntil: 'networkidle0', timeout: 30000 });
    const html = await page.content();
    const bounced = page.url().includes('GoogleReCaptcha') || html.includes('btnCaptchaCheckButton');

    const pass = !rejected && !bounced;
    console.log('\n=== VERDICT: ' + (pass
      ? '✅ PASS — the deployed container\'s token was accepted by SECOP'
      : '✗ FAIL — see above') + ' ===');
    process.exit(pass ? 0 : 1);
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
