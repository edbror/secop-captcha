import { config } from 'dotenv';
import puppeteer from 'puppeteer';
import { solve, SECOP_CAPTCHA_CHECK_URL, DEFAULT_MKEY, SITE_KEY } from './src/solver-ponytail.js';
import { execSync } from 'child_process';
import fs from 'fs';

config();

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
  console.log('  Page:', page.url().substring(0, 70));

  await page.waitForSelector('iframe[src*="recaptcha"]', { timeout: 15000 });

  let mkey = await page.evaluate(() => {
    const btn = document.getElementById('btnCaptchaCheckButton');
    if (!btn) return null;
    const match = (btn.getAttribute('onclick') || '').match(/mkey=([a-f0-9_]+)/);
    return match ? match[1] : null;
  });
  console.log('  mkey:', mkey || DEFAULT_MKEY);

  await page.screenshot({ path: 'captcha-mid.png' });

  const checkUrl = `${SECOP_CAPTCHA_CHECK_URL}?responseKey=${encodeURIComponent(token)}&mkey=${encodeURIComponent(mkey || DEFAULT_MKEY)}`;
  console.log('[4/4] Submitting token to SECOP CaptchaCheck...');
  await page.goto(checkUrl, { waitUntil: 'networkidle0' });
  console.log('  ->', page.url().substring(0, 80));

  await new Promise(r => setTimeout(r, 4000));
  await page.screenshot({ path: 'captcha-solved.png', fullPage: true });

  await browser.close();

  const videoSize = fs.statSync('captcha-solved.png').size;
  console.log(`\nScreenshot saved (captcha-solved.png, ${Math.round(videoSize / 1024)}KB)`);
  console.log('Open it to see the gatekept SECOP page after captcha was solved.');
}

main().catch(e => { console.error(e.message); process.exit(1); });
