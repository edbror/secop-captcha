#!/usr/bin/env node
/**
 * solver-ponytail.js — SECOP reCAPTCHA solver (single-file, zero-framework).
 *
 * Solves Google reCAPTCHA v2 for SECOP Colombia via 2Captcha / CapSolver
 * and returns the raw token. Tokens are SINGLE-USE and expire ~2 minutes
 * after the farm generates them: nothing in this module may submit a token
 * to Google's siteverify or SECOP's CaptchaCheck before handing it to the
 * caller, or the caller's own submission will be rejected as a duplicate.
 *
 * Usage (CLI):
 *   node src/solver-ponytail.js solve [url]
 *   node src/solver-ponytail.js solve-puppeteer [url]
 *   node src/solver-ponytail.js balance
 *   node src/solver-ponytail.js verify <token>   (Google siteverify — consumes the token)
 *   node src/solver-ponytail.js check <token>    (SECOP CaptchaCheck — consumes the token)
 */

// ---------------------------------------------------------------------------
// Configuration — all external-facing constants live here for easy audit
// ---------------------------------------------------------------------------
const SITE_KEY = '6LcMmakZAAAAAB157Q90hORUGtNd790TCws4vBNw';

const SECOP_CAPTCHA_INDEX_URL =
  'https://community.secop.gov.co/Public/Common/GoogleReCaptcha/Index';

const SECOP_CAPTCHA_CHECK_URL =
  'https://community.secop.gov.co/Public/Common/GoogleReCaptcha/CaptchaCheck';

const GOOGLE_VERIFY_URL = 'https://www.google.com/recaptcha/api/siteverify';

// 2Captcha API endpoints
const _2CAPTCHA_IN = 'https://2captcha.com/in.php';
const _2CAPTCHA_RES = 'https://2captcha.com/res.php';

// CapSolver API endpoints
const CAPSOLVER_CREATE = 'https://api.capsolver.com/createTask';
const CAPSOLVER_RESULT = 'https://api.capsolver.com/getTaskResult';

// User-agent masquerade
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// reCAPTCHA tokens are single-use and valid for ~2 minutes after generation
const TOKEN_TTL_SECONDS = 110;

// Polling intervals
const _2CAPTCHA_POLL_MS = 1000;   // 1 s between 2Captcha polls
const _2CAPTCHA_MAX_POLLS = 120;  // up to 2 min
const CAPSOLVER_POLL_MS = 3000;   // 3 s between CapSolver polls
const CAPSOLVER_MAX_POLLS = 40;   // up to 2 min
const TOKEN_POLL_MS = 500;        // 500 ms waiting for recaptcha-token
const TOKEN_MAX_POLLS = 60;       // up to 30 s
const TOKEN_CHALLENGE_GRACE_POLLS = 10; // 5 s before declaring an interactive challenge

// ponytail: replaced 87-line httpJson with native fetch — same behavior, zero deps

// ---------------------------------------------------------------------------
// 2Captcha service
// ---------------------------------------------------------------------------

// ponytail: was 62 lines with httpJson; fetch is cleaner for polling loops
/**
 * Submit a reCAPTCHA task to 2Captcha and poll until solved.
 * Returns the response token string.
 *
 * 2Captcha JSON responses are {status: 1|0, request: <id|token|ERROR_CODE>};
 * errors arrive in `request`, never in an `error` field.
 */
async function solveVia2Captcha(apiKey, siteKey, opts = {}) {
  const pollDelayMs = Number.isFinite(opts.pollDelayMs) ? opts.pollDelayMs : _2CAPTCHA_POLL_MS;

  // Submit task
  const submit = await fetch(_2CAPTCHA_IN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      key: apiKey,
      method: 'userrecaptcha',
      pageurl: SECOP_CAPTCHA_INDEX_URL,
      googlekey: siteKey,
      json: 1,
    }),
  });
  const submitBody = await submit.json();
  const captchaId = submitBody.request;

  if (submitBody.status === 0 || (typeof captchaId === 'string' && captchaId.startsWith('ERROR_'))) {
    throw new Error(`2Captcha submit error: ${captchaId || JSON.stringify(submitBody)}`);
  }
  if (!captchaId) {
    throw new Error(`2Captcha returned no captcha ID: ${JSON.stringify(submitBody)}`);
  }

  // Poll for result
  for (let i = 0; i < _2CAPTCHA_MAX_POLLS; i++) {
    await delay(pollDelayMs);

    const poll = await fetch(
      `${_2CAPTCHA_RES}?key=${apiKey}&action=get&id=${captchaId}&json=1`
    );
    const raw = await poll.text();
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      // Plain-text responses: the token, "CAPCHA_NOT_READY" or "ERROR_..."
      body = { status: 1, request: raw };
    }

    if (body.request === 'CAPCHA_NOT_READY') {
      continue;
    }
    if (body.status === 0 || (typeof body.request === 'string' && body.request.startsWith('ERROR_'))) {
      throw new Error(`2Captcha solve failed: ${body.request || JSON.stringify(body)}`);
    }

    const token = typeof body === 'string' ? body : body.request;
    return token;
  }

  throw new Error('2Captcha: timeout after polling');
}

/**
 * Check the 2Captcha account balance (free call, does not solve anything).
 * Returns the balance as a number.
 */
async function get2CaptchaBalance(apiKey) {
  const res = await fetch(`${_2CAPTCHA_RES}?key=${apiKey}&action=getbalance&json=1`);
  const body = await res.json();
  if (body.status === 0 || (typeof body.request === 'string' && body.request.startsWith('ERROR_'))) {
    throw new Error(`2Captcha balance error: ${body.request || JSON.stringify(body)}`);
  }
  return parseFloat(body.request);
}

// ---------------------------------------------------------------------------
// CapSolver service
// ---------------------------------------------------------------------------

// ponytail: was 41 lines with httpJson; fetch is cleaner
/**
 * Submit a reCAPTCHA task to CapSolver and poll until solved.
 * Returns the response token string.
 *
 * Task type must be ReCaptchaV2TaskProxyLess (CapSolver naming) and the
 * polling endpoint is getTaskResult; the token arrives in
 * solution.gRecaptchaResponse.
 */
async function solveViaCapSolver(apiKey, siteKey, opts = {}) {
  const pollDelayMs = Number.isFinite(opts.pollDelayMs) ? opts.pollDelayMs : CAPSOLVER_POLL_MS;

  // Create task
  const create = await fetch(CAPSOLVER_CREATE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientKey: apiKey,
      task: {
        type: 'ReCaptchaV2TaskProxyLess',
        websiteURL: SECOP_CAPTCHA_INDEX_URL,
        websiteKey: siteKey,
      },
    }),
  });
  const createBody = await create.json();

  // errorId !== 0 means an error (1 = key/parameter problems, 2 = usage problems)
  if (createBody.errorId) {
    throw new Error(`CapSolver createTask error: ${createBody.errorCode} - ${createBody.errorMessage}`);
  }

  const taskId = createBody.taskId;
  if (!taskId) {
    throw new Error(`CapSolver returned no task ID: ${JSON.stringify(createBody)}`);
  }

  // Poll for result
  for (let i = 0; i < CAPSOLVER_MAX_POLLS; i++) {
    await delay(pollDelayMs);

    const result = await fetch(CAPSOLVER_RESULT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientKey: apiKey,
        taskId,
      }),
    });
    const raw = await result.text();
    const data = raw.startsWith('{') ? JSON.parse(raw) : { errorId: 2, errorCode: 'NO_RESPONSE', errorMessage: 'No response from CapSolver' };

    if (data.status === 'ready' && data.solution) {
      return data.solution.gRecaptchaResponse || data.solution.token;
    }
    if (data.errorId) {
      throw new Error(`CapSolver error: ${data.errorCode} - ${data.errorMessage}`);
    }
  }

  throw new Error('CapSolver: timeout after polling');
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/**
 * Verify a reCAPTCHA token with Google's siteverify API.
 * Returns { success, hostname, score, error, skipped } for full context.
 */
async function verifyWithGoogle(token, secretKey) {
  // ponytail: was 22 lines with httpJson; native fetch does the same in one call
  try {
    const res = await fetch(GOOGLE_VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `secret=${encodeURIComponent(secretKey)}&response=${encodeURIComponent(token)}`,
    });
    return await res.json();
  } catch (err) {
    console.warn(`verifyWithGoogle: Google siteverify failed: ${err.message}`);
    return { success: false, error: err.message, skipped: false };
  }
}

/**
 * Fetch the live SECOP Captcha Index page and extract the per-page-load mkey
 * plus the session cookie it was issued with. The mkey is only valid inside
 * the session that requested it — keep both together.
 */
async function fetchSecopSession() {
  const res = await fetch(SECOP_CAPTCHA_INDEX_URL, {
    headers: { 'User-Agent': USER_AGENT },
  });
  const raw = await res.text();
  const mkeyMatch = raw.match(/mkey=([a-f0-9_]+)/);

  let cookie = '';
  try {
    const setCookies =
      (typeof res.headers.getSetCookie === 'function' && res.headers.getSetCookie()) || [];
    cookie = setCookies.map((c) => c.split(';')[0]).join('; ');
  } catch {
    // no cookie header — proceed without it
  }

  return { mkey: mkeyMatch ? mkeyMatch[1] : null, cookie };
}

/**
 * Convenience wrapper: just the live mkey (or null).
 */
async function fetchSecopMkey() {
  try {
    const { mkey } = await fetchSecopSession();
    return mkey;
  } catch {
    return null;
  }
}

/**
 * Check token with SECOP via direct HTTP.
 *
 * DESTRUCTIVE: submitting a token to CaptchaCheck consumes it (single-use).
 * Use only for diagnostics — never on a token the caller still needs.
 *
 * If mkey is not provided, fetches one live along with its session cookie
 * so the mkey and the request at least belong to the same session.
 */
async function checkWithSecop(token, mkey) {
  let mk = mkey;
  let cookie = '';
  if (!mk) {
    const session = await fetchSecopSession();
    mk = session.mkey;
    cookie = session.cookie;
  }
  if (!mk) {
    throw new Error('Could not extract a live mkey from the SECOP captcha page — aborting instead of submitting with a stale one');
  }

  const url = `${SECOP_CAPTCHA_CHECK_URL}?responseKey=${encodeURIComponent(token)}&mkey=${encodeURIComponent(mk)}`;

  const res = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Referer: SECOP_CAPTCHA_INDEX_URL,
      ...(cookie ? { Cookie: cookie } : {}),
    },
  });
  const finalUrl = res.url; // fetch follows redirects, .url is the final URL
  const success = !finalUrl.includes('ErrorPage') && res.status !== 403;

  return {
    success,
    status: res.status,
    url,
    finalUrl,
    mkey: mk,
    body: (await res.text()).substring(0, 500),
  };
}

/**
 * Check token with SECOP via headless browser — the only reliable shape for
 * this check: one session loads the Index page, extracts the mkey issued to
 * that session, and submits CaptchaCheck from that same session.
 *
 * DESTRUCTIVE: submitting a token to CaptchaCheck consumes it (single-use).
 * Use only for diagnostics/live tests — never on a token the caller still needs.
 */
async function checkWithSecopBrowser(token, siteKey = SITE_KEY) {
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

  if (require('fs').existsSync(execPath)) {
    launchOpts.executablePath = execPath;
  }

  const browser = await puppeteer.launch(launchOpts);

  try {
    const page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);

    // Step 1: Navigate to the Index page to establish session and extract mkey
    // This mimics the user journey where the token is generated for this specific page/session
    const targetUrl = `${SECOP_CAPTCHA_INDEX_URL}?previousUrl=${encodeURIComponent('https://community.secop.gov.co/Public/Tendering/ContractNoticeManagement/Index?currentLanguage=es-CO&Page=login&Country=CO&SkinName=CCE')}`;

    console.log('  Navigating to Captcha Index to establish session...');
    await page.goto(targetUrl, { waitUntil: 'networkidle0', timeout: 15000 });

    // Step 2: Extract the dynamic mkey from the page — no fallback: a stale
    // mkey guarantees the "página expirada" ErrorPage
    const mkey = await page.evaluate(() => {
      try {
        const btn = document.getElementById('btnCaptchaCheckButton');
        if (!btn) return null;
        const onClick = btn.getAttribute('onclick') || '';
        const match = onClick.match(/mkey=([a-f0-9_]+)/);
        return match ? match[1] : null;
      } catch {
        return null;
      }
    });

    if (!mkey) {
      return {
        success: false,
        status: 0,
        url: targetUrl,
        finalUrl: page.url(),
        error: 'Could not extract mkey from btnCaptchaCheckButton — page structure may have changed',
      };
    }

    // Step 3: Navigate directly to the CaptchaCheck endpoint with the token and extracted mkey
    // The Python scraper does exactly this after extracting the mkey
    const checkUrl = `${SECOP_CAPTCHA_CHECK_URL}?responseKey=${encodeURIComponent(token)}&mkey=${encodeURIComponent(mkey)}`;
    console.log('  Navigating to CaptchaCheck with extracted mkey...');

    try {
      const response = await page.goto(checkUrl, { waitUntil: 'networkidle0', timeout: 15000 });
      const status = response ? response.status() : 0;
      const finalUrl = page.url();

      console.log('  Response status: ' + status);
      console.log('  Final URL: ' + finalUrl.substring(0, 150));

      const success = !finalUrl.includes('ErrorPage') && !finalUrl.includes('expired') && !finalUrl.includes('GoogleReCaptcha');

      return {
        success,
        status,
        url: checkUrl,
        finalUrl,
        mkey,
        body: success ? 'SECOP accepted the token' : 'SECOP rejected the token (check finalUrl)',
      };
    } catch (gotoErr) {
      // If navigation fails, return the last known state
      return {
        success: false,
        status: 0,
        url: checkUrl,
        finalUrl: page.url(),
        mkey,
        error: gotoErr.message,
      };
    }
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// Puppeteer-based solver (local browser, no human farm)
// ---------------------------------------------------------------------------

/**
 * Open a headless browser, navigate to a page with reCAPTCHA,
 * click the checkbox, and extract the generated token from the
 * anchor frame's #recaptcha-token input.
 * 
 * @param {string} url - URL to navigate to (optional)
 * @param {object} siteKeyOverride - Site key override (optional)
 * @param {object} browser - Existing browser instance to reuse (optional). If not provided, creates a new one and closes it when done.
 */
async function solveWithPuppeteer(url, siteKeyOverride, browser = null) {
  let createdBrowser = false;
  
  if (!browser) {
    // Lazy-load puppeteer only when actually invoked
    const puppeteer = require('puppeteer');

    // Determine Chrome binary — falls back to bundled Chromium in Docker
    const fs = require('fs');
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
        // Stealth settings
        '--disable-blink-features=AutomationControlled',
      ],
      defaultViewport: { width: 1280, height: 720 },
    };

    // If exec path exists on disk, use it; otherwise puppeteer's bundled browser
    if (fs.existsSync(execPath)) {
      launchOpts.executablePath = execPath;
    }

    browser = await puppeteer.launch(launchOpts);
    createdBrowser = true;
  }

  try {
    const page = await browser.newPage();

    // Stealth: hide webdriver signal
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      window.navigator.chrome = { runtime: {}, loadTimes: () => ({}), csi: () => ({}), app: {} };
      Object.setPrototypeOf(navigator.plugins, []);
      Object.setPrototypeOf(navigator.languages, []);
    });

    await page.setUserAgent(USER_AGENT);

    // Navigate if a URL was given
    if (url) {
      await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
    } else {
      // Default to SECOP's captcha page
      const previousUrl = encodeURIComponent(
        'https://community.secop.gov.co/Public/Tendering/ContractNoticeManagement/Index?currentLanguage=es-CO&Page=login&Country=CO&SkinName=CCE'
      );
      await page.goto(
        `${SECOP_CAPTCHA_INDEX_URL}?previousUrl=${previousUrl}`,
        { waitUntil: 'networkidle0', timeout: 30000 }
      );
    }

    // Wait for the reCAPTCHA anchor iframe to appear
    await page.waitForSelector('iframe[src*="recaptcha/api2/anchor"]', {
      timeout: 15000,
    });

    // Give reCAPTCHA time to initialise
    await delay(3000);

    // Find the anchor frame and click the checkbox
    const anchorFrame = page.frames().find((f) => {
      const u = typeof f.url === 'function' ? f.url() : f.url;
      return u && u.includes('recaptcha/api2/anchor');
    });

    if (!anchorFrame) {
      throw new Error('Could not find reCAPTCHA anchor frame');
    }

    // Click the checkbox — this triggers token generation
    await anchorFrame.click('.recaptcha-checkbox-border', { count: 1 });

    // Poll for the token value in #recaptcha-token. If the checkbox never
    // turns checked, Google served an interactive (image/audio) challenge
    // that this local solver cannot complete — fail fast with a clear error.
    for (let i = 0; i < TOKEN_MAX_POLLS; i++) {
      await delay(TOKEN_POLL_MS);
      const token = await anchorFrame.evaluate(() =>
        document.getElementById('recaptcha-token')?.value || ''
      );
      if (token && token.length > 100) return token;

      if (i >= TOKEN_CHALLENGE_GRACE_POLLS) {
        const checked = await anchorFrame
          .$eval('.recaptcha-checkbox', (el) => el.classList.contains('recaptcha-checkbox-checked'))
          .catch(() => false);
        if (!checked) {
          throw new Error(
            'reCAPTCHA served an interactive challenge (image/audio) — the local solver cannot complete it; use method "service" (farm)'
          );
        }
      }
    }

    throw new Error('reCAPTCHA solve timeout — no token obtained from anchor frame');
  } finally {
    // Only close the browser if we created it
    if (createdBrowser) {
      await browser.close();
    }
  }
}

// ---------------------------------------------------------------------------
// Main solver orchestration
// ---------------------------------------------------------------------------

/**
 * Solve a reCAPTCHA: try the primary farm first, fall back to the other.
 * Returns the raw token string — the caller must submit it to SECOP itself;
 * nothing here consumes it.
 */
async function solve(siteKey, farmService) {
  const apiKey = process.env.RECAPTCHA_SERVICE_KEY;
  const capSolverKey = process.env.CAPSOLVER_API_KEY;
  const farm = farmService || '2captcha';

  let token, used;

  if (farm === 'capsolver') {
    if (!capSolverKey) throw new Error('CAPSOLVER_API_KEY is required for capsolver farm');
    try {
      token = await solveViaCapSolver(capSolverKey, siteKey);
      used = 'CapSolver';
    } catch (err) {
      console.error(`CapSolver failed: ${err.message}`);
      if (!apiKey) throw err;
      console.log('Falling back to 2Captcha...');
      token = await solveVia2Captcha(apiKey, siteKey);
      used = '2Captcha (fallback)';
    }
  } else {
    // default: 2captcha primary
    if (!apiKey) throw new Error('RECAPTCHA_SERVICE_KEY is required for 2captcha farm');
    try {
      token = await solveVia2Captcha(apiKey, siteKey);
      used = '2Captcha';
    } catch (err) {
      console.error(`2Captcha failed: ${err.message}`);
      if (!capSolverKey) throw err;
      console.log('Falling back to CapSolver...');
      token = await solveViaCapSolver(capSolverKey, siteKey);
      used = 'CapSolver (fallback)';
    }
  }

  if (!token || typeof token !== 'string' || token.length < 50) {
    throw new Error(`Invalid token returned from ${used}: ${JSON.stringify(token)?.substring(0, 100)}`);
  }

  console.log(`  Solved via ${used}`);
  return token;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// CLI entry-point
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command) {
    console.log(`\nSECOP reCAPTCHA Solver — ponytail edition\n`);
    console.log('Commands:');
    console.log('  node src/solver-ponytail.js solve [url]            Solve reCAPTCHA (service farm)');
    console.log('  node src/solver-ponytail.js solve-puppeteer [url]  Solve with local browser');
    console.log('  node src/solver-ponytail.js balance                Show farm account balance (free)');
    console.log('  node src/solver-ponytail.js verify <token>         Google siteverify (consumes the token)');
    console.log('  node src/solver-ponytail.js check <token>          SECOP CaptchaCheck (consumes the token)');
    console.log(`\nSite key: ${SITE_KEY}`);
    console.log(`Env: RECAPTCHA_SERVICE_KEY, CAPSOLVER_API_KEY, FARM_SERVICE, PORT\n`);
    process.exit(0);
  }

  switch (command) {
    // ── solve via 2Captcha / CapSolver ────────────────────────────────
    case 'solve': {
      const farm = process.env.FARM_SERVICE || '2captcha';
      console.log(`\n[1/1] Solving reCAPTCHA (farm: ${farm})`);
      const token = await solve(SITE_KEY, farm);
      console.log(`  Token: ${token.substring(0, 50)}...`);
      console.log(`  Note: single-use, expires in ~${TOKEN_TTL_SECONDS}s — submit it to SECOP immediately.`);

      // Write result to stdout as JSON for CLI consumers. No verification
      // step here: siteverify/CaptchaCheck would consume the token.
      console.log(JSON.stringify({ success: true, token, expiresIn: TOKEN_TTL_SECONDS }));
      break;
    }

    // ── solve with local puppeteer (no farm) ──────────────────────────
    case 'solve-puppeteer': {
      const url = args[1];
      console.log(`\n[1/1] Solving with local browser${url ? ` on ${url}` : ''}`);
      const token = await solveWithPuppeteer(url);
      console.log(`  Token: ${token.substring(0, 50)}...`);
      console.log(`  Note: single-use, expires in ~${TOKEN_TTL_SECONDS}s — submit it to SECOP immediately.`);
      console.log(JSON.stringify({ success: true, token, expiresIn: TOKEN_TTL_SECONDS }));
      break;
    }

    // ── farm balance (free) ───────────────────────────────────────────
    case 'balance': {
      const apiKey = process.env.RECAPTCHA_SERVICE_KEY;
      const capSolverKey = process.env.CAPSOLVER_API_KEY;
      const out = {};
      if (apiKey) {
        out['2captcha'] = await get2CaptchaBalance(apiKey);
      }
      if (capSolverKey) {
        // CapSolver has no free balance endpoint on the legacy API; report presence only
        out.capsolver = 'key set (no free balance endpoint)';
      }
      if (!apiKey && !capSolverKey) {
        console.error('No farm keys configured (RECAPTCHA_SERVICE_KEY / CAPSOLVER_API_KEY)');
        process.exit(1);
      }
      console.log(JSON.stringify(out, null, 2));
      break;
    }

    // ── verify with Google (DESTRUCTIVE — consumes the token) ────────
    case 'verify': {
      const token = args[1];
      if (!token) { console.error('Usage: solver-ponytail.js verify <token>'); process.exit(1); }
      console.error('Note: siteverify consumes this single-use token.');
      const google = await verifyWithGoogle(token, SITE_KEY);
      console.log(JSON.stringify(google, null, 2));
      break;
    }

    // ── check with SECOP (DESTRUCTIVE — consumes the token) ──────────
    case 'check': {
      const token = args[1];
      if (!token) { console.error('Usage: solver-ponytail.js check <token>'); process.exit(1); }
      console.error('Note: CaptchaCheck consumes this single-use token and is session-bound (use test/live.test.js for the full flow).');
      const secop = await checkWithSecop(token);
      console.log(JSON.stringify(secop, null, 2));
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// CLI auto-start when run directly (not required as module)
// ---------------------------------------------------------------------------
if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal:', err.message);
    process.exit(1);
  });
}

// ---------------------------------------------------------------------------
// Exports for the server module
// ---------------------------------------------------------------------------
module.exports = {
  solveVia2Captcha,
  solveViaCapSolver,
  get2CaptchaBalance,
  solve,
  solveWithPuppeteer,
  verifyWithGoogle,
  fetchSecopSession,
  fetchSecopMkey,
  checkWithSecop,
  checkWithSecopBrowser,
  SITE_KEY,
  SECOP_CAPTCHA_INDEX_URL,
  SECOP_CAPTCHA_CHECK_URL,
  USER_AGENT,
  TOKEN_TTL_SECONDS,
};
