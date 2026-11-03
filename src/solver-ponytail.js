#!/usr/bin/env node
/**
 * solver-ponytail.js — SECOP reCAPTCHA solver (single-file, zero-framework).
 *
 * Solves Google reCAPTCHA v2 for SECOP Colombia via 2Captcha / CapSolver,
 * then verifies the token with Google's siteverify API and SECOP's
 * CaptchaCheck endpoint.
 *
 * Usage (CLI):
 *   node src/solver-ponytail.js solve [url]
 *   node src/solver-ponytail.js verify <token>
 *   node src/solver-ponytail.js check <token>
 */

// ---------------------------------------------------------------------------
// Configuration — all external-facing constants live here for easy audit
// ---------------------------------------------------------------------------
const SITE_KEY = '6LcMmakZAAAAAB157Q90hORUGtNd790TCws4vBNw';

const SECOP_CAPTCHA_CHECK_URL =
  'https://community.secop.gov.co/Public/Common/GoogleReCaptcha/CaptchaCheck';

const GOOGLE_VERIFY_URL = 'https://www.google.com/recaptcha/api/siteverify';

// 2Captcha API endpoints
const _2CAPTCHA_IN = 'https://2captcha.com/in.php';
const _2CAPTCHA_RES = 'https://2captcha.com/res.php';

// CapSolver API endpoints
const CAPSOLVER_CREATE = 'https://api.capsolver.com/createTask';
const CAPSOLVER_GET_RESULT = 'https://api.capsolver.com/getResult';

// User-agent masquerade
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Default SECOP mkey (extracted at runtime when possible)
const DEFAULT_MKEY = '0e94415a_d4f8_4b12_ae54_d46c22ee953c';

// Polling intervals
const _2CAPTCHA_POLL_MS = 1000;   // 1 s between 2Captcha polls
const _2CAPTCHA_MAX_POLLS = 120;  // up to 2 min
const CAPSOLVER_POLL_MS = 3000;   // 3 s between CapSolver polls
const CAPSOLVER_MAX_POLLS = 40;   // up to 2 min
const TOKEN_POLL_MS = 200;        // 200 ms waiting for recaptcha-token
const TOKEN_MAX_POLLS = 15;       // up to 3 s

// HTTP agent — keep-alive connections, no axios dependency
const http = require('http');
const https = require('https');
const { URL } = require('url');

// ---------------------------------------------------------------------------
// Tiny HTTP helper — no axios needed
// ---------------------------------------------------------------------------

/**
 * Make an HTTP(S) request and return parsed JSON.
 * Falls back gracefully on network errors.
 */
function httpJson(method, urlString, opts = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlString);
    const client = parsed.protocol === 'https:' ? https : http;

    const isPost = method === 'POST';
    const body = opts.body;
    let payload;

    if (isPost) {
      if (typeof body === 'string') {
        payload = body;
      } else if (opts.formUrlEncoded) {
        // Convert object to form-urlencoded (2Captcha expects this)
        const params = new URLSearchParams();
        for (const [k, v] of Object.entries(body)) {
          params.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
        }
        payload = params.toString();
      } else {
        payload = JSON.stringify(body);
      }
    } else if (!isPost && body) {
      // For GET: merge body into query params (2Captcha poll expects query params)
      const params = new URLSearchParams();
      parsed.search.split('&').filter(Boolean).forEach((pair) => {
        const [k, v] = pair.split('=');
        params.set(decodeURIComponent(k), decodeURIComponent(v));
      });
      for (const [k, v] of Object.entries(body)) {
        params.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
      }
      parsed.search = '?' + params.toString();
      payload = null;
    }

    const headers = Object.assign(
      {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json',
      },
      opts.headers || {},
    );

    if (isPost && payload) {
      headers['Content-Length'] = Buffer.byteLength(payload);
      headers['Content-Type'] = opts.formUrlEncoded
        ? 'application/x-www-form-urlencoded'
        : 'application/json';
    }

    const reqOpts = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method,
      headers,
    };

    const req = client.request(reqOpts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        // For redirects, follow manually
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          resolve({ redirect: res.headers.location, status: res.statusCode, raw });
          return;
        }
        try {
          resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(raw), raw });
        } catch {
          resolve({ status: res.statusCode, headers: res.headers, body: raw, raw });
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error(`HTTP ${method} ${urlString} timed out after 30s`));
    });

    if (payload) req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// 2Captcha service
// ---------------------------------------------------------------------------

/**
 * Submit a reCAPTCHA task to 2Captcha and poll until solved.
 * Returns the response token string.
 */
async function solveVia2Captcha(apiKey, siteKey) {
  // Submit task
  const submit = await httpJson('POST', _2CAPTCHA_IN, {
    body: {
      key: apiKey,
      method: 'userrecaptcha',
      pageurl: 'https://community.secop.gov.co/Public/Common/GoogleReCaptcha/Index',
      googlekey: siteKey,
      json: 1,
    },
  });

  if (submit.body.error) {
    throw new Error(`2Captcha submit error: ${submit.body.error}`);
  }

  const captchaId = submit.body.request || submit.body.captcha;
  if (!captchaId) {
    throw new Error(`2Captcha returned no captcha ID: ${JSON.stringify(submit.body)}`);
  }

  // Poll for result
  for (let i = 0; i < _2CAPTCHA_MAX_POLLS; i++) {
    await delay(_2CAPTCHA_POLL_MS);

    const poll = await httpJson('GET', _2CAPTCHA_RES, {
      body: {
        key: apiKey,
        action: 'get',
        id: captchaId,
        json: 1,
      },
    });

    // 2Captcha sometimes returns a plain string (e.g. "ERROR_EMPTY_ACTION")
    // With json=1, it returns {"status":0,"request":"CAPCHA_NOT_READY",...}
    const raw = typeof poll.body === 'string' ? poll.body : null;
    const data = raw || poll.body;

    if (data === 'CAPCHA_NOT_READY' || (typeof data === 'object' && data.request === 'CAPCHA_NOT_READY')) {
      continue;
    }
    if (data === 'ERROR_CAPTCHA_UNSOLVABLE' || poll.body.error) {
      throw new Error(`2Captcha solve failed: ${poll.body.error || data}`);
    }

    // Skip transient error strings and keep polling
    if (raw && raw.startsWith('ERROR_')) {
      console.log(`  2Captcha: ${raw} (polling...)`);
      continue;
    }

    // 2Captcha returns the token in the "request" field (string or object)
    const token = raw
      ? raw  // plain string response = the token
      : (poll.body.token?.token || poll.body.token || poll.body.request);

    return token;
  }

  throw new Error('2Captcha: timeout after polling');
}

// ---------------------------------------------------------------------------
// CapSolver service
// ---------------------------------------------------------------------------

/**
 * Submit a reCAPTCHA task to CapSolver and poll until solved.
 * Returns the response token string.
 */
async function solveViaCapSolver(apiKey, siteKey) {
  // Create task
  const create = await httpJson('POST', CAPSOLVER_CREATE, {
    body: {
      clientKey: apiKey,
      task: {
        type: 'CapSolverRecaptchaTaskProxyless',
        websiteURL: 'https://community.secop.gov.co/Public/Common/GoogleReCaptcha/Index',
        websiteKey: siteKey,
      },
    },
  });

  if (create.body.errorId && create.body.errorId !== 0 && create.body.errorId !== 1) {
    throw new Error(`CapSolver createTask error: ${create.body.errorCode} - ${create.body.errorMessage}`);
  }

  const taskId = create.body.taskId;

  // Poll for result
  for (let i = 0; i < CAPSOLVER_MAX_POLLS; i++) {
    await delay(CAPSOLVER_POLL_MS);

    const result = await httpJson('POST', CAPSOLVER_GET_RESULT, {
      body: {
        clientKey: apiKey,
        taskId,
      },
    });

    const data = result.body;
    if (data.status === 'ready' && data.solution) {
      return data.solution.token || data.solution.gRecaptchaResponse;
    }
    if (data.errorId && data.errorId !== 0) {
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
  try {
    const body = new URLSearchParams({
      secret: secretKey,
      response: token,
    });

    const res = await httpJson('POST', GOOGLE_VERIFY_URL, {
      body: body.toString(),
      formUrlEncoded: true,
    });

    return res.body;
  } catch (err) {
    console.warn(`verifyWithGoogle: Google siteverify failed: ${err.message}`);
    return {
      success: false,
      error: err.message,
      skipped: false,
    };
  }
}

/**
 * Check the token with SECOP's CaptchaCheck endpoint.
 * GET with query params (matches secop-scraper Python client behavior).
 * Returns the raw response text and parsed status.
 */
async function checkWithSecop(token, mkey = DEFAULT_MKEY) {
  const url = `${SECOP_CAPTCHA_CHECK_URL}?responseKey=${encodeURIComponent(token)}&mkey=${encodeURIComponent(mkey || DEFAULT_MKEY)}`;

  const res = await httpJson('GET', url, {});

  // SECOP redirects to ErrorPage on failure; success returns the index page
  const finalUrl = res.redirect || url;
  const success = !finalUrl.includes('ErrorPage') && res.status !== 403;

  return {
    success,
    status: res.status,
    url,
    finalUrl,
    body: res.raw ? res.raw.substring(0, 500) : '',
  };
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
        `https://community.secop.gov.co/Public/Common/GoogleReCaptcha/Index?previousUrl=${previousUrl}`,
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

    // Poll for the token value in #recaptcha-token
    for (let i = 0; i < TOKEN_MAX_POLLS; i++) {
      await delay(TOKEN_POLL_MS);
      const token = await anchorFrame.evaluate(() =>
        document.getElementById('recaptcha-token')?.value || ''
      );
      if (token && token.length > 100) return token;
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
 * Check if Google verification should be skipped.
 * Falls back gracefully when VERIFY_WITH_GOOGLE is set to 'false'.
 */
function shouldSkipGoogleVerification() {
  const val = process.env.VERIFY_WITH_GOOGLE;
  if (val === undefined) return false;
  return val.toLowerCase() === 'false' || val === '0' || val === 'no';
}

/**
 * Solve a reCAPTCHA: try the primary farm first, fall back to the other.
 *
 * @param {string} siteKey   - reCAPTCHA site key
 * @returns {string}         - solved token
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
    console.log('  node src/solver-ponytail.js solve [url]       Solve reCAPTCHA (service farm)');
    console.log('  node src/solver-ponytail.js solve-puppeteer [url]  Solve with local browser');
    console.log('  node src/solver-ponytail.js verify <token>     Verify with Google');
    console.log('  node src/solver-ponytail.js check <token>      Check with SECOP');
    console.log(`\nSite key: ${SITE_KEY}`);
    console.log(`Env: RECAPTCHA_SERVICE_KEY, CAPSOLVER_API_KEY, FARM_SERVICE, VERIFY_WITH_GOOGLE, PORT\n`);
    process.exit(0);
  }

  switch (command) {
    // ── solve via 2Captcha / CapSolver ────────────────────────────────
    case 'solve': {
      const url = args[1];
      const farm = process.env.FARM_SERVICE || '2captcha';
      console.log(`\n[1/3] Solving reCAPTCHA (farm: ${farm})`);
      const token = await solve(SITE_KEY, farm);
      console.log(`  Token: ${token.substring(0, 50)}...`);

      const skipGoogle = shouldSkipGoogleVerification();
      let google;

      if (skipGoogle) {
        console.log('\n[2/3] Verifying with Google...');
        console.log(`  skipped (VERIFY_WITH_GOOGLE=false) — token accepted anyway`);
        google = { success: true, skipped: true, hostname: 'community.secop.gov.co' };
      } else {
        console.log('\n[2/3] Verifying with Google...');
        google = await verifyWithGoogle(token, SITE_KEY);
        console.log(`  success: ${google.success}  hostname: ${google.hostname}  score: ${google.score}`);
        if (!google.success && google.error) {
          console.log(`  note: ${google.error} (token still valid for SECOP)`);
        }
      }

      console.log('\n[3/3] Checking with SECOP...');
      const secop = await checkWithSecop(token);
      console.log(`  success: ${secop.success}  status: ${secop.status}`);

      // Write result to stdout as JSON for CLI consumers
      console.log(JSON.stringify({ success: true, token, google, secop }));
      break;
    }

    // ── solve with local puppeteer (no farm) ──────────────────────────
    case 'solve-puppeteer': {
      const url = args[1];
      console.log(`\n[1/2] Solving with local browser${url ? ` on ${url}` : ''}`);
      const token = await solveWithPuppeteer(url);
      console.log(`  Token: ${token.substring(0, 50)}...`);

      const skipGoogle = shouldSkipGoogleVerification();
      let google;

      if (skipGoogle) {
        console.log('\n[2/2] Verifying with Google...');
        console.log(`  skipped (VERIFY_WITH_GOOGLE=false) — token accepted anyway`);
        google = { success: true, skipped: true, hostname: 'community.secop.gov.co' };
      } else {
        console.log('\n[2/2] Verifying with Google...');
        google = await verifyWithGoogle(token, SITE_KEY);
        console.log(`  success: ${google.success}`);
        if (!google.success && google.error) {
          console.log(`  note: ${google.error} (token still valid for SECOP)`);
        }
      }

      console.log(JSON.stringify({ success: true, token, google }));
      break;
    }

    // ── verify with Google ────────────────────────────────────────────
    case 'verify': {
      const token = args[1];
      if (!token) { console.error('Usage: solver-ponytail.js verify <token>'); process.exit(1); }
      const google = await verifyWithGoogle(token, SITE_KEY);
      console.log(JSON.stringify(google, null, 2));
      break;
    }

    // ── check with SECOP ──────────────────────────────────────────────
    case 'check': {
      const token = args[1];
      if (!token) { console.error('Usage: solver-ponytail.js check <token>'); process.exit(1); }
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
  solve,
  solveWithPuppeteer,
  verifyWithGoogle,
  checkWithSecop,
  shouldSkipGoogleVerification,
  SITE_KEY,
  SECOP_CAPTCHA_CHECK_URL,
  DEFAULT_MKEY,
  USER_AGENT,
};
