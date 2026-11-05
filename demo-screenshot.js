require('dotenv').config();
const puppeteer = require('puppeteer');
const { solve, SECOP_CAPTCHA_CHECK_URL, DEFAULT_MKEY, SITE_KEY } = require('./src/solver-ponytail');

async function demo() {
  console.log('Solving captcha using 2captcha farm (this might take 30-60s)...');
  const token = await solve(SITE_KEY, '2captcha');
  console.log('Got token:', token.substring(0, 40) + '...');

  const browser = await puppeteer.launch({ 
    headless: 'new', 
    args: ['--no-sandbox', '--disable-setuid-bounce'],
    defaultViewport: { width: 1280, height: 720 } 
  });
  const page = await browser.newPage();
  
  console.log('Navigating to establish session and get mkey...');
  const targetUrl = 'https://community.secop.gov.co/Public/Tendering/ContractNoticeManagement/Index?currentLanguage=es-CO&Page=login&Country=CO&SkinName=CCE';
  await page.goto('https://community.secop.gov.co/Public/Common/GoogleReCaptcha/Index?previousUrl=' + encodeURIComponent(targetUrl), { waitUntil: 'networkidle0' });
  
  let mkey = await page.evaluate(() => {
    const btn = document.getElementById('btnCaptchaCheckButton');
    if (!btn) return null;
    const match = (btn.getAttribute('onclick') || '').match(/mkey=([a-f0-9_]+)/);
    return match ? match[1] : null;
  });
  
  console.log('Extracted mkey:', mkey || DEFAULT_MKEY);
  
  console.log('Submitting token to SECOP CaptchaCheck...');
  const checkUrl = `${SECOP_CAPTCHA_CHECK_URL}?responseKey=${encodeURIComponent(token)}&mkey=${encodeURIComponent(mkey || DEFAULT_MKEY)}`;
  await page.goto(checkUrl, { waitUntil: 'networkidle0' });
  
  console.log('Final URL before wait:', page.url());
  await new Promise(r => setTimeout(r, 5000));
  console.log('Final URL after wait:', page.url());
  
  await page.screenshot({ path: 'captcha-success.png', fullPage: true });
  console.log('Screenshot saved to captcha-success.png');
  
  await browser.close();
}

demo().catch(console.error);
