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

async function main() {
  console.log('[1/4] Solving captcha via 2Captcha...');
  const token = await solve(SITE_KEY, '2captcha');
  console.log('  Token:', token.substring(0, 40) + '...');

  console.log('[2/4] Launching visible browser...');
  const browser = await puppeteer.launch({
    headless: false,
    args: ['--no-sandbox', '--disable-setuid-bounce', '--window-size=1280,720'],
    defaultViewport: { width: 1280, height: 720 }
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });

  const targetUrl = 'https://community.secop.gov.co/Public/Tendering/ContractNoticeManagement/Index?currentLanguage=es-CO&Page=login&Country=CO&SkinName=CCE';
  const captchaUrl = 'https://community.secop.gov.co/Public/Common/GoogleReCaptcha/Index?previousUrl=' + encodeURIComponent(targetUrl);

  console.log('[3/4] Opening SECOP Captcha page...');
  await page.goto(captchaUrl, { waitUntil: 'networkidle0' });
  await page.screenshot({ path: path.join(frameDir, '01-captcha-page.png'), fullPage: true });
  console.log('  Captcha page loaded');

  await page.waitForSelector('iframe[src*="recaptcha"]', { timeout: 15000 });
  await page.screenshot({ path: path.join(frameDir, '02-recaptcha-visible.png'), fullPage: true });
  console.log('  reCAPTCHA appeared');

  let mkey = await page.evaluate(() => {
    const btn = document.getElementById('btnCaptchaCheckButton');
    if (!btn) return null;
    const match = (btn.getAttribute('onclick') || '').match(/mkey=([a-f0-9_]+)/);
    return match ? match[1] : null;
  });
  console.log('  mkey:', mkey || DEFAULT_MKEY);

  const checkUrl = `${SECOP_CAPTCHA_CHECK_URL}?responseKey=${encodeURIComponent(token)}&mkey=${encodeURIComponent(mkey || DEFAULT_MKEY)}`;
  console.log('[4/4] Submitting token to SECOP CaptchaCheck...');
  await page.goto(checkUrl, { waitUntil: 'networkidle0' });
  await page.screenshot({ path: path.join(frameDir, '03-submitting-token.png'), fullPage: true });
  console.log('  Token submitted');

  await new Promise(r => setTimeout(r, 4000));
  await page.screenshot({ path: path.join(frameDir, '04-page-redirected.png'), fullPage: true });
  console.log('  -> Gatekept page loaded');
  console.log('  Final:', page.url().substring(0, 70));

  await browser.close();

  // Create GIF from frames
  console.log('\nCreating GIF...');
  execSync('ffmpeg -y -framerate 1 -i frames/%02d-*.png -vf "scale=640:-1:flags=lanczos" -c:v gif89a captcha-proof.gif 2>/dev/null', { cwd: process.cwd() });

  const gifSize = fs.statSync('captcha-proof.gif').size;
  console.log(`GIF saved: captcha-proof.gif (${Math.round(gifSize / 1024)}KB)`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
