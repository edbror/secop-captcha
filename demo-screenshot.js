require('dotenv').config();
const puppeteer = require('puppeteer');
const { solve, SECOP_CAPTCHA_INDEX_URL, SECOP_CAPTCHA_CHECK_URL, SITE_KEY, USER_AGENT } = require('./src/solver-ponytail');

async function demo() {
  console.log('Solving captcha using 2captcha farm (this might take 30-60s)...');
  const token = await solve(SITE_KEY, '2captcha');
  console.log('Got token:', token.substring(0, 40) + '...');
  console.log('Note: single-use token, ~2 min TTL — submitting immediately.');

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-bounce', '--disable-blink-features=AutomationControlled'],
    defaultViewport: { width: 1280, height: 720 }
  });
  try {
    const page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);

    console.log('Navigating to establish session and get a fresh mkey...');
    const targetUrl = 'https://community.secop.gov.co/Public/Tendering/ContractNoticeManagement/Index?currentLanguage=es-CO&Page=login&Country=CO&SkinName=CCE';
    await page.goto(`${SECOP_CAPTCHA_INDEX_URL}?previousUrl=${encodeURIComponent(targetUrl)}`, { waitUntil: 'networkidle0' });

    // Fresh mkey from THIS session — a stale/hardcoded one always
    // produces the "página expirada por inactividad" ErrorPage.
    const mkey = await page.evaluate(() => {
      const btn = document.getElementById('btnCaptchaCheckButton');
      if (!btn) return null;
      const match = (btn.getAttribute('onclick') || '').match(/mkey=([a-f0-9_]+)/);
      return match ? match[1] : null;
    });
    if (!mkey) throw new Error('Could not extract mkey from the captcha page');
    console.log('Extracted mkey:', mkey);

    // Token into the field the real button reads ($.getURIVal('txaresponseKey'))
    await page.evaluate((t) => {
      const txa = document.getElementById('txaresponseKey');
      if (txa) txa.value = t;
      const g = document.getElementById('g-recaptcha-response');
      if (g) g.value = t;
    }, token);

    console.log('Submitting token to SECOP CaptchaCheck (single submission)...');
    const checkUrl = `${SECOP_CAPTCHA_CHECK_URL}?responseKey=${encodeURIComponent(token)}&mkey=${encodeURIComponent(mkey)}`;
    await page.goto(checkUrl, { waitUntil: 'networkidle0' });

    console.log('Final URL before wait:', page.url());
    await new Promise(r => setTimeout(r, 5000));
    console.log('Final URL after wait:', page.url());

    await page.screenshot({ path: 'captcha-success.png', fullPage: true });
    console.log('Screenshot saved to captcha-success.png');
  } finally {
    await browser.close();
  }
}

demo().catch(e => { console.error(e.message); process.exit(1); });
