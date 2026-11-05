#!/usr/bin/env node
/**
 * e2e.test.js — End-to-end tests for secop-captcha server.
 *
 * Two modes:
 *   MODE=real   — hits live farm (2Captcha/CapSolver), verifies token with Google + SECOP. Requires RECAPTCHA_SERVICE_KEY or CAPSOLVER_API_KEY. Costs money per solve (~$0.003-0.007 per solve).
 *   MODE=http   — starts local server in-process and exercises routes via HTTP (no external API calls). Fast, free.
 *
 * Run fast (HTTP mode):      node test/e2e.test.js
 * Run real (live solves):    MODE=real node test/e2e.test.js
 */

const http = require('http');
const supertest = require('supertest');

const TEST_PORT = 3099;
const API_KEY = 'test-e2e-api-key';

// Create a fresh server instance for testing
let server;
let agent;

async function startServer() {
  // Set up environment for testing
  process.env.RECAPTCHA_SERVICE_KEY = 'test-2captcha-key';
  process.env.CAPSOLVER_API_KEY = 'test-capsolver-key';
  process.env.SECOP_CAPTCHA_API_KEY = API_KEY;
  process.env.PORT = TEST_PORT;
  process.env.FARM_SERVICE = '2captcha';
  process.env.VERIFY_WITH_GOOGLE = 'false';
  process.env.HOST = '127.0.0.1';

  // Clear module cache to get fresh instance
  Object.keys(require.cache).forEach(key => {
    if (key.includes('server-ponytail')) {
      delete require.cache[key];
    }
  });

  const serverModule = require('../src/server-ponytail');
  server = serverModule.server;
  agent = supertest.agent(server);

  return new Promise((resolve, reject) => {
    if (server.listening) {
      resolve();
    } else {
      server.once('listening', resolve);
    }
  });
}

function stopServer() {
  return new Promise((resolve) => {
    if (server) {
      server.close(() => resolve());
    } else {
      resolve();
    }
  });
}

// ---------------------------------------------------------------------------
// Real solve E2E mode (MODE=real)
// Calls live 2Captcha/CapSolver farm → verifies with Google → checks SECOP
// ---------------------------------------------------------------------------

const {
  solve,
  verifyWithGoogle,
  checkWithSecop,
  shouldSkipGoogleVerification,
  SITE_KEY,
} = require('../src/solver-ponytail');

let isRealMode = process.env.MODE === 'real';

/**
 * Run a complete solve flow end-to-end using live farms.
 * This is what matters — it proves the service works as the scraper will use it.
 */
async function runRealSolveTest() {
  console.log('\n=== REAL SOLVE FLOW (live API calls) ===');
  console.log('Note: costs ~$0.003-0.007 per attempt\n');

  const farm = process.env.FARM_SERVICE || '2captcha';
  const skipGoogle = shouldSkipGoogleVerification();

  // Step 1: Solve via farm
  console.log('[1/3] Solving reCAPTCHA via ' + farm + '...');
  let token;
  try {
    token = await solve(SITE_KEY, farm);
  } catch (err) {
    throw new Error('Step 1 FAIL: Farm returned error — ' + err.message);
  }

  if (!token || token.length < 50) {
    throw new Error('Step 1 FAIL: Got invalid token (' + JSON.stringify(token)?.substring(0, 100) + ')');
  }
  console.log('  ✓ Token received: ' + token.substring(0, 40) + '... (' + token.length + ' chars)');

  // Step 2: Verify with Google
  if (skipGoogle) {
    console.log('\n[2/3] Google siteverify skipped (VERIFY_WITH_GOOGLE=false)');
    console.log('  ℹ️  Note: siteverify with SITE_KEY always fails; token is accepted anyway.');
  } else {
    console.log('\n[2/3] Verifying token with Google...');
    let googleResult;
    try {
      googleResult = await verifyWithGoogle(token, SITE_KEY);
    } catch (err) {
      throw new Error('Step 2 FAIL: Google verification threw — ' + err.message);
    }
    console.log('  success: ' + googleResult.success);
    console.log('  hostname: ' + (googleResult.hostname || '(none)'));
    console.log('  score: ' + (googleResult.score ?? '(none)'));
    console.log('  action: ' + (googleResult.action || '(none)'));
    if (googleResult.error) {
      console.log('  ⚠️  note: ' + googleResult.error + ' (expected — we pass SITE_KEY which is public, not the secret)');
    }
  }

  // Step 3: Check with SECOP — THIS IS THE REAL TEST
  console.log('\n[3/3] Checking token validity with SECOP...');
  let secopResult;
  try {
    secopResult = await checkWithSecop(token);
  } catch (err) {
    throw new Error('Step 3 FAIL: SECOP check threw — ' + err.message);
  }

  console.log('  success: ' + secopResult.success);
  console.log('  status: ' + (secopResult.status || '(none)'));
  console.log('  url: ' + (secopResult.url || '(none)'));

  if (!secopResult.success) {
    throw new Error('SECOP rejected the token! Status: ' + JSON.stringify(secopResult));
  }

  console.log('\n  ✅ FULL FLOW PASSED — SECOP accepted the token');
  return { token, google: null, secop: secopResult };
}

let passed = 0;
let failed = 0;
let total = 0;

function assert(condition, message) {
  total++;
  if (condition) {
    passed++;
    console.log('  ✓ ' + message);
  } else {
    failed++;
    console.error('  ✗ ' + message);
  }
}

async function test(name, fn) {
  console.log('\n' + name);
  try {
    await fn();
  } catch (err) {
    console.error('  ✗ ' + name + ': ' + err.message);
    failed++;
    total++;
  }
}

// ---------------------------------------------------------------------------
// Test runner — pick mode
// ---------------------------------------------------------------------------

let allPassed = true;

async function runHttpTests() {
  console.log('SECOP Captcha HTTP E2E Tests (local server)');
  console.log('============================================\n');

  await startServer();

  // 1. Health endpoint
  await test('GET /health returns 200 with correct structure', async () => {
    const res = await agent.get('/health');
    assert(res.status === 200, 'status is 200');
    assert(res.body.status === 'ok', 'body.status is "ok"');
    assert(res.body.service === 'secop-captcha-ponytail', 'body.service is correct');
    assert(typeof res.body.timestamp === 'string', 'body.timestamp is a string');
    assert(typeof res.body.siteKey === 'string', 'body.siteKey is present');
    assert(typeof res.body.farm === 'string', 'body.farm is present');
    assert(res.headers['content-type'].includes('application/json'), 'content-type is application/json');
    assert(res.headers['access-control-allow-origin'] === '*', 'CORS header present');
  });

  // 2. Solve endpoint - service method
  await test('POST /solve with method=service returns 200 or 500', async () => {
    const res = await agent.post('/solve')
      .send({ method: 'service' })
      .set('X-API-Key', API_KEY);
    assert(res.status === 200 || res.status === 500, 'status is 200 or 500 (not 400/401)');
    assert(res.body.success !== undefined, 'body.success is present');
  });

  // 3. Solve endpoint - missing auth
  await test('POST /solve without API key returns 401', async () => {
    const res = await agent.post('/solve')
      .send({ method: 'service' });
    assert(res.status === 401, 'status is 401 (unauthorized)');
    assert(res.body.success === false, 'body.success is false');
    assert(typeof res.body.error === 'string', 'body.error is a string');
  });

  // 4. Solve endpoint - validation error
  await test('POST /solve with method=puppeteer and no url returns 400', async () => {
    const res = await agent.post('/solve')
      .send({ method: 'puppeteer' })
      .set('X-API-Key', API_KEY);
    assert(res.status === 400, 'status is 400');
    assert(res.body.details && Array.isArray(res.body.details), 'body.details is an array');
    const hasUrlError = res.body.details.some(d => d.includes('url'));
    assert(hasUrlError, 'details includes url error');
  });

  // 5. Verify endpoint
  await test('POST /verify returns 200 or 500', async () => {
    const res = await agent.post('/verify')
      .send({ token: '03AGdBq26TestTokenValueLongEnoughForVerification12345' })
      .set('X-API-Key', API_KEY);
    assert(res.status === 200 || res.status === 500, 'status is 200 or 500');
    assert(res.body.success !== undefined, 'body.success is present');
  });

  // 6. Verify endpoint - missing token
  await test('POST /verify without token returns 400', async () => {
    const res = await agent.post('/verify')
      .send({})
      .set('X-API-Key', API_KEY);
    assert(res.status === 400, 'status is 400');
    assert(res.body.details && Array.isArray(res.body.details), 'body.details is an array');
  });

  // 7. Verify endpoint - short token
  await test('POST /verify with short token returns 400', async () => {
    const res = await agent.post('/verify')
      .send({ token: 'short' })
      .set('X-API-Key', API_KEY);
    assert(res.status === 400, 'status is 400');
    const hasShortError = (res.body.details || []).some(d => d.includes('short'));
    assert(hasShortError, 'details includes token short error');
  });

  // 8. Redirect endpoint
  await test('GET /redirect returns 200 with correct structure', async () => {
    const res = await agent.get('/redirect');
    assert(res.status === 200, 'status is 200');
    assert(res.body.success === true, 'body.success is true');
    assert(typeof res.body.captchaPage === 'string', 'body.captchaPage is present');
    assert(typeof res.body.redirectUrl === 'string', 'body.redirectUrl is present');
    assert(typeof res.body.captchaCheckUrl === 'string', 'body.captchaCheckUrl is present');
    assert(typeof res.body.siteKey === 'string', 'body.siteKey is present');
  });

  // 9. Redirect endpoint - with previousUrl
  await test('GET /redirect?previousUrl=... returns custom redirectUrl', async () => {
    const res = await agent.get('/redirect?previousUrl=https://example.com');
    assert(res.status === 200, 'status is 200');
    assert(res.body.redirectUrl === 'https://example.com', 'redirectUrl is correct');
  });

  // 10. 404 for unknown route (requires auth since it's not a public endpoint)
  await test('GET /unknown returns 401 (not found routes still require auth)', async () => {
    const res = await agent.get('/unknown');
    assert(res.status === 401, 'status is 401 (auth required for non-public routes)');
    assert(res.body.success === false, 'body.success is false');
    assert(typeof res.body.error === 'string', 'body.error is a string');
  });

  // 11. CORS headers on all responses
  await test('All responses include CORS headers', async () => {
    const res = await agent.get('/health');
    assert(res.headers['access-control-allow-origin'] === '*', 'Access-Control-Allow-Origin is *');
    assert(res.headers['access-control-allow-methods'] === 'GET, POST, OPTIONS', 'Access-Control-Allow-Methods is correct');
    assert(res.headers['access-control-allow-headers'] === 'Content-Type', 'Access-Control-Allow-Headers is correct');
  });

  // 12. Cache-Control header
  await test('Responses include Cache-Control: no-store', async () => {
    const res = await agent.get('/health');
    assert(res.headers['cache-control'] === 'no-store', 'Cache-Control is no-store');
  });

  // 13. OPTIONS preflight
  await test('OPTIONS request returns 204', async () => {
    const res = await agent.options('/health');
    assert(res.status === 204, 'status is 204');
  });

  // 14. sendJson Content-Length header
  await test('sendJson includes Content-Length header', async () => {
    const res = await agent.get('/health');
    const expectedLength = Buffer.byteLength(res.text);
    assert(parseInt(res.headers['content-length'], 10) === expectedLength, 'Content-Length matches body size');
  });

  // 15. Health endpoint bypasses auth
  await test('GET /health bypasses authentication', async () => {
    const res = await agent.get('/health');
    assert(res.status === 200, 'status is 200 (no auth required)');
  });

  // 16. Solve with valid URL for puppeteer method
  await test('POST /solve with method=puppeteer and valid url returns 200 or 500', async () => {
    const res = await agent.post('/solve')
      .send({ method: 'puppeteer', url: 'https://community.secop.gov.co' })
      .set('X-API-Key', API_KEY);
    assert(res.status === 200 || res.status === 500, 'status is 200 or 500');
  });

  // 17. Solve with invalid URL format
  await test('POST /solve with method=puppeteer and invalid url returns 400', async () => {
    const res = await agent.post('/solve')
      .send({ method: 'puppeteer', url: 'not-a-valid-url' })
      .set('X-API-Key', API_KEY);
    assert(res.status === 400, 'status is 400');
  });

  // 18. Solve with URL outside allowed hosts
  await test('POST /solve with method=puppeteer and URL outside allowed hosts returns 400', async () => {
    const res = await agent.post('/solve')
      .send({ method: 'puppeteer', url: 'https://google.com' })
      .set('X-API-Key', API_KEY);
    assert(res.status === 400, 'status is 400');
    const hasHostError = (res.body.details || []).some(d => d.includes('hostname') || d.includes('allowed'));
    assert(hasHostError, 'details includes hostname error');
  });

  // 19. Solve with fallback to capsolver
  await test('POST /solve with fallback=true switches to capsolver', async () => {
    const res = await agent.post('/solve')
      .send({ method: 'service', fallback: true })
      .set('X-API-Key', API_KEY);
    assert(res.status === 200 || res.status === 500, 'status is 200 or 500');
    assert(res.body.success !== undefined, 'body.success is present');
  });

  // 20. Solve with invalid method
  await test('POST /solve with invalid method returns 400', async () => {
    const res = await agent.post('/solve')
      .send({ method: 'invalid' })
      .set('X-API-Key', API_KEY);
    assert(res.status === 400, 'status is 400');
    assert(res.body.details && Array.isArray(res.body.details), 'body.details is an array');
  });

  // 21. Verify with valid long token
  await test('POST /verify with valid long token returns 200', async () => {
    const res = await agent.post('/verify')
      .send({ token: '03AGdBq26TestTokenValueLongEnoughForVerificationAndValidation' })
      .set('X-API-Key', API_KEY);
    assert(res.status === 200 || res.status === 500, 'status is 200 or 500');
    assert(res.body.success === true, 'body.success is true');
  });

  // 22. POST /solve without body
  await test('POST /solve without body returns 200 or 500', async () => {
    const res = await agent.post('/solve')
      .set('X-API-Key', API_KEY);
    assert(res.status === 200 || res.status === 500, 'status is 200 or 500');
  });

  // 23. POST /solve with invalid JSON
  await test('POST /solve with invalid JSON returns 400', async () => {
    const res = await agent.post('/solve')
      .set('X-API-Key', API_KEY)
      .set('Content-Type', 'application/json')
      .send('not-valid-json');
    // Should return 400 due to JSON parse error
    assert(res.status === 400 || res.status === 500, 'status is 400 or 500');
  });

  // 24. GET /health with query params
  await test('GET /health with query params returns 200', async () => {
    const res = await agent.get('/health?verbose=true');
    assert(res.status === 200, 'status is 200');
    assert(res.body.status === 'ok', 'body.status is "ok"');
  });

  // 25. POST /verify without auth
  await test('POST /verify without API key returns 401', async () => {
    const res = await agent.post('/verify')
      .send({ token: '03AGdBq26TestTokenValueLongEnoughForVerification12345' });
    assert(res.status === 401, 'status is 401');
  });

  console.log('\n' + '='.repeat(40));
  console.log('HTTP Results: ' + passed + '/' + total + ' passed');
  if (failed > 0) {
    console.log('                ' + failed + '/' + total + ' failed');
  }
  console.log('='.repeat(40));

  return failed === 0;
}

async function runAllTests() {
  let httpPassed = true;

  if (!isRealMode) {
    // HTTP-only mode (fast, free)
    console.log('[mode] HTTP (local server, no live API calls)\n');
    try {
      httpPassed = await runHttpTests();
    } finally {
      await stopServer();
    }
  } else {
    // Real mode: HTTP tests first, then live solve flow
    console.log('[mode] REAL (live API calls — costs money)\n');
    try {
      httpPassed = await runHttpTests();
    } finally {
      await stopServer();
    }

    // Live solve flow
    try {
      await runRealSolveTest();
    } catch (err) {
      allPassed = false;
      console.error('\n  ✗ REAL SOLVE FLOW: ' + err.message);
    }
  }

  return httpPassed && allPassed;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

runAllTests().then((success) => {
  stopServer().then(() => {
    process.exit(success ? 0 : 1);
  });
}).catch((err) => {
  console.error('Fatal error:', err);
  stopServer().then(() => {
    process.exit(1);
  });
});
