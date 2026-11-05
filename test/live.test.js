#!/usr/bin/env node
/**
 * live.test.js — staged live verification against the real SECOP portal.
 *
 * Stage 1 (free, default):
 *   1. 2Captcha balance check (key valid + funded)
 *   2. SECOP captcha page reachable + mkey extraction works
 *
 * Stage 2 (paid, --paid flag — ~$0.003 per run, consumes one token):
 *   3. Farm solve → token
 *   4. ONE browser session: load captcha page → extract fresh mkey →
 *      submit CaptchaCheck with the token → verify access to the protected
 *      page.
 *
 * This is the reference implementation of the correct flow: one session,
 * fresh mkey, single submission. The scraper's _inject_token does the same.
 *
 * Run:  npm run live          (free checks only)
 *       npm run live:paid     (adds the paid end-to-end solve)
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const {
  solve,
  get2CaptchaBalance,
  fetchSecopSession,
  SECOP_CAPTCHA_INDEX_URL,
  SECOP_CAPTCHA_CHECK_URL,
  USER_AGENT,
} = require('../src/solver-ponytail');

const PAID = process.argv.includes('--paid');
const PREVIOUS_URL =
  'https://community.secop.gov.co/Public/Tendering/ContractNoticeManagement/Index?currentLanguage=es-CO&Page=login&Country=CO&SkinName=CCE';

let failures = 0;
function check(name, ok, detail) {
  if (ok) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

async function stage1() {
  console.log('\n=== STAGE 1: free checks ===\n');

  // 1. Farm balance
  const apiKey = process.env.RECAPTCHA_SERVICE_KEY;
  check('RECAPTCHA_SERVICE_KEY is configured', Boolean(apiKey));
  if (apiKey) {
    try {
      const balance = await get2CaptchaBalance(apiKey);
      check('2Captcha key valid, balance available', balance > 0, `balance: $${balance.toFixed(5)}`);
      if (balance < 0.01) {
        console.error('  ⚠️  Balance below $0.01 — paid solves will fail.');
      }
    } catch (err) {
      check('2Captcha key valid', false, err.message);
    }
  }

  // 2. SECOP captcha page + mkey extraction
  try {
    const { mkey, cookie } = await fetchSecopSession();
    check('SECOP captcha page reachable, mkey extracted', Boolean(mkey), `mkey: ${mkey}`);
    check('SECOP session cookie captured', Boolean(cookie), cookie ? '' : 'no set-cookie header');
    return mkey;
  } catch (err) {
    check('SECOP captcha page reachable', false, err.message);
    return null;
  }
}

async function stage2() {
  console.log('\n=== STAGE 2: paid end-to-end (one farm solve, ~$0.003) ===\n');

  const puppeteer = require('puppeteer');
  const execPath =
    process.env.PUPPETEER_EXECUTABLE_PATH ||
    process.env.CHROME_PATH ||
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const launchOpts = {
    headless: 'new',
    args: [
      '--disable-setuid-bounce',
      '--disable-dev-shm-usage',
      '--disable-extensions',
      '--disable-gpu',
      '--disable-blink-features=AutomationControlled',
    ],
    defaultViewport: { width: 1280, height: 720 },
  };
  if (fs.existsSync(execPath)) {
    launchOpts.executablePath = execPath;
  } else {
    // A stale PUPPETEER_EXECUTABLE_PATH would make puppeteer.launch fail
    // even without an explicit executablePath — clear it and use the
    // browser bundled with the puppeteer package.
    delete process.env.PUPPETEER_EXECUTABLE_PATH;
    delete process.env.CHROME_PATH;
  }

  // 1. Solve via farm FIRST — the token clock (~2 min) starts now
  const farm = process.env.FARM_SERVICE || '2captcha';
  console.log(`  [1/4] Solving via ${farm} (10-120 s)...`);
  const token = await solve(require('../src/solver-ponytail').SITE_KEY, farm);
  console.log(`        Token: ${token.substring(0, 40)}... (${token.length} chars)`);
  console.log('        ⏱ token is single-use and expires in ~2 min — submitting immediately');

  // 2. One browser session for the whole submission
  const browser = await puppeteer.launch(launchOpts);
  try {
    const page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);

    console.log('  [2/4] Loading captcha page (establishing session + fresh mkey)...');
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
    check('Fresh mkey extracted from the live session', Boolean(mkey), `mkey: ${mkey}`);
    if (!mkey) throw new Error('no mkey — page structure may have changed');

    // Set the token into the field the real button reads ($.getURIVal('txaresponseKey'))
    await page.evaluate((t) => {
      const txa = document.getElementById('txaresponseKey');
      if (txa) txa.value = t;
    }, token);

    // 3. Submit — the ONLY submission of this single-use token
    const checkUrl = `${SECOP_CAPTCHA_CHECK_URL}?responseKey=${encodeURIComponent(token)}&mkey=${encodeURIComponent(mkey)}`;
    console.log('  [3/4] Submitting CaptchaCheck (single submission)...');
    const response = await page.goto(checkUrl, { waitUntil: 'networkidle0', timeout: 30000 });
    // Allow a possible JS redirect to settle
    await new Promise((r) => setTimeout(r, 3000));

    const status = response ? response.status() : 0;
    const finalUrl = page.url();
    const title = await page.title().catch(() => '');
    console.log(`        status: ${status}`);
    console.log(`        final URL: ${finalUrl.substring(0, 120)}`);
    console.log(`        title: ${title.substring(0, 80)}`);

    const rejected =
      finalUrl.includes('ErrorPage') ||
      finalUrl.toLowerCase().includes('expired') ||
      finalUrl.includes('GoogleReCaptcha');

    // 4. Confirm access to the protected page in the same session
    console.log('  [4/4] Navigating to the protected page...');
    await page.goto(PREVIOUS_URL, { waitUntil: 'networkidle0', timeout: 30000 });
    const protectedUrl = page.url();
    const protectedHtml = await page.content();
    const bouncedToCaptcha = protectedUrl.includes('GoogleReCaptcha') || protectedHtml.includes('btnCaptchaCheckButton');

    const shot = path.join(__dirname, '..', 'live-verify-result.png');
    await page.screenshot({ path: shot, fullPage: true });

    check('CaptchaCheck did not land on an error/expired page', !rejected, finalUrl);
    check('Protected page accessible without captcha wall', !bouncedToCaptcha, protectedUrl);
    console.log(`        screenshot: ${shot}`);

    const success = !rejected && !bouncedToCaptcha;
    console.log('\n=== VERDICT: ' + (success ? '✅ END-TO-END PASS — SECOP accepted the farm token' : '✗ FAIL — see above') + ' ===');
    return success;
  } finally {
    await browser.close();
  }
}

(async () => {
  console.log('secop-captcha live verification');
  console.log(`mode: ${PAID ? 'PAID (one farm solve)' : 'free checks only (--paid for the full run)'}`);

  await stage1();

  if (PAID) {
    await stage2();
  } else {
    console.log('\nFree checks done. Run "npm run live:paid" for the full end-to-end verification (~$0.003).');
  }

  process.exit(failures > 0 ? 1 : 0);
})().catch((err) => {
  console.error('\nFatal:', err.message);
  process.exit(1);
});
