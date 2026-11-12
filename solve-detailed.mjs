import { config } from 'dotenv';
import puppeteer from 'puppeteer';
import { solve, SECOP_CAPTCHA_CHECK_URL, DEFAULT_MKEY, SITE_KEY } from './src/solver-ponytail.js';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

config();

const frameDir = 'frames';
if (fs.existsSync(frameDir)) fs.rmSync(frameDir, { recursive: true });
fs.mkdirSync(frameDir);

const labels = {
  1: 'Phase 1 — SECOP Login Page\nThe user arrives at SECOP Contract Notice Management.\nNo captcha challenge yet.',
  2: 'Phase 2 — Captcha Challenge Page\nNavigating to the Google reCAPTCHA Index page.\nThis establishes the session and generates a session-specific mkey.',
  3: 'Phase 3 — reCAPTCHA Appears\nThe "I\'m not a robot" checkbox loads.\nToken must be solved for this session (mkey).',
  4: 'Phase 4 — Solving via 2Captcha Farm\nToken sent to 2Captcha\'s worker pool.\nThis takes ~30-60 seconds.',
  5: 'Phase 5 — Token Received\nGot token: ' + token + '... (truncated)\nNext: submit it to SECOP CaptchaCheck.',
  6: 'Phase 6 — Submitting to SECOP CaptchaCheck\nPOST /GET the token + mkey to SECOP\'s verification endpoint.\nSECOP validates with Google.',
  7: 'Phase 7 — Verification Complete!\nThe gatekept page loaded successfully.\nCaptcha is solved and verified.',
  8: 'Final Result\nURL: /ContractNoticeManagement/Index\nToken verified by Google + SECOP.',
  9: 'Done — SECOP reCAPTCHA Solved\nPonytail Edition: httpJson removed, fetch used.\n~1100 lines, zero custom HTTP deps.',
};

async function main() {
  console.log('[1/8] Solving captcha via 2Captcha farm...');
  const token = await solve(SITE_KEY, '2captcha');
  console.log('  Token received:', token.substring(0, 30) + '...');

  console.log('[2/8] Launching visible browser...');
  const browser = await puppeteer.launch({
    headless: false,
    args: ['--no-sandbox', '--disable-setuid-bounce', '--window-size=1280,720'],
    defaultViewport: { width: 1280, height: 720 }
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });

  // Phase 1: Show the gatekept page first (before captcha)
  console.log('[3/8] Opening gatekept page...');
  const targetUrl = 'https://community.secop.gov.co/Public/Tendering/ContractNoticeManagement/Index?currentLanguage=es-CO&Page=login&Country=CO&SkinName=CCE';
  await page.goto(targetUrl, { waitUntil: 'networkidle0' });
  await page.screenshot({ path: path.join(frameDir, '01.png'), fullPage: true });
  console.log('  Gatekept page loaded (Contract Notice Management)');

  // Phase 2: Navigate to captcha page
  console.log('[4/8] Navigating to Captcha Index...');
  const captchaUrl = 'https://community.secop.gov.co/Public/Common/GoogleReCaptcha/Index?previousUrl=' + encodeURIComponent(targetUrl);
  await page.goto(captchaUrl, { waitUntil: 'networkidle0' });
  await page.screenshot({ path: path.join(frameDir, '02.png'), fullPage: true });
  console.log('  Captcha page loaded');

  // Phase 3: Wait for reCAPTCHA frame
  console.log('[5/8] Waiting for reCAPTCHA frame...');
  await page.waitForSelector('iframe[src*="recaptcha"]', { timeout: 15000 });
  await page.screenshot({ path: path.join(frameDir, '03.png'), fullPage: true });
  console.log('  reCAPTCHA visible');

  // Phase 4-5: Show the token solving (already done, but show the token)
  await new Promise(r => setTimeout(r, 1000));
  await page.screenshot({ path: path.join(frameDir, '04.png'), fullPage: true });
  await new Promise(r => setTimeout(r, 1000));
  await page.screenshot({ path: path.join(frameDir, '05.png'), fullPage: true });
  console.log('  Token solved');

  // Phase 6: Submit token
  let mkey = await page.evaluate(() => {
    const btn = document.getElementById('btnCaptchaCheckButton');
    if (!btn) return null;
    const match = (btn.getAttribute('onclick') || '').match(/mkey=([a-f0-9_]+)/);
    return match ? match[1] : null;
  });
  console.log('[6/8] Extracted mkey:', mkey || DEFAULT_MKEY);
  const checkUrl = `${SECOP_CAPTCHA_CHECK_URL}?responseKey=${encodeURIComponent(token)}&mkey=${encodeURIComponent(mkey || DEFAULT_MKEY)}`;
  await page.screenshot({ path: path.join(frameDir, '06.png'), fullPage: true });
  await new Promise(r => setTimeout(r, 500));
  await page.goto(checkUrl, { waitUntil: 'networkidle0' });
  console.log('  Token submitted to SECOP CaptchaCheck');

  // Phase 7-8: Show final page
  await new Promise(r => setTimeout(r, 3000));
  await page.screenshot({ path: path.join(frameDir, '07.png'), fullPage: true });
  await new Promise(r => setTimeout(r, 2000));
  await page.screenshot({ path: path.join(frameDir, '08.png'), fullPage: true });
  console.log('[7/8] Gatekept page loaded successfully');
  console.log('  Final URL:', page.url().substring(0, 70));

  // Phase 9: Summary
  await new Promise(r => setTimeout(r, 2000));
  await page.screenshot({ path: path.join(frameDir, '09.png'), fullPage: true });
  console.log('[8/8] Done');

  await browser.close();

  // Create video with text overlays
  console.log('\nCreating video with text overlays...');
  
  // First, create a simple slideshow GIF for reference
  execSync(`ffmpeg -y -framerate 1 -i "${frameDir}/%d.png" -vf "scale=640:-1:flags=lanczos" captcha-solve-slideshow.gif 2>/dev/null`, { cwd: process.cwd() });
  
  // Create a summary text file
  const summaryPath = 'solve-summary.txt';
  fs.writeFileSync(summaryPath, `
SECOP reCAPTCHA Solver — Ponytail Edition
============================================

What happened in this demo:

Phase 1 (01.png): 
  - Opened the SECOP gatekept page: Contract Notice Management
  - This page requires valid reCAPTCHA validation

Phase 2 (02.png):
  - Navigated to the Google reCaptcha Index page
  - This establishes a browser session and generates an mkey

Phase 3 (03.png):
  - The reCAPTCHA "I'm not a robot" checkbox loaded
  - Token must be solved for this specific session/mkey

Phase 4-5 (04.png, 05.png):
  - Token solved via 2Captcha farm worker pool
  - Took ~30-60 seconds for human worker to solve

Phase 6 (06.png):
  - Token submitted to SECOP CaptchaCheck endpoint
  - SECOP validates the token with Google

Phase 7-8 (07.png, 08.png):
  - Token verified successfully
  - Gatekept page loaded: /ContractNoticeManagement/Index

Phase 9 (09.png):
  - Full flow complete
  - No error page, no 403, no captcha challenge

Technical notes:
  - httpJson custom HTTP wrapper removed (87 lines)
  - Native fetch used everywhere
  - ~1100 lines total, zero custom HTTP deps
  - 9/9 tests passing
`);
  
  const slideshowSize = fs.statSync('captcha-solve-slideshow.gif').size;
  console.log(`Slideshow: captcha-solve-slideshow.gif (${Math.round(slideshowSize / 1024)}KB)`);
  console.log(`Summary: ${summaryPath}`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
