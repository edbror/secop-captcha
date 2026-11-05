#!/usr/bin/env node
/**
 * e2e.test.js — HTTP tests for the secop-captcha server, fully offline.
 *
 * The server runs in-process with MOCK_SOLVER=true and a mocked global.fetch
 * (for /redirect's live mkey lookup), so no farm, Google or SECOP calls happen.
 *
 * For live verification (paid farm solve → SECOP submission) use:
 *   npm run live         (free checks only)
 *   npm run live:paid    (runs one paid end-to-end solve, ~$0.003)
 *
 * Run: npm run e2e
 */

const supertest = require('supertest');

const TEST_PORT = 3099;
const API_KEY = 'test-e2e-api-key';

// Create a fresh server instance for testing
let server;
let agent;
let realFetch;

async function startServer() {
  // Set up environment for testing
  process.env.RECAPTCHA_SERVICE_KEY = 'test-2captcha-key';
  process.env.CAPSOLVER_API_KEY = 'test-capsolver-key';
  process.env.SECOP_CAPTCHA_API_KEY = API_KEY;
  process.env.PORT = TEST_PORT;
  process.env.FARM_SERVICE = '2captcha';
  process.env.HOST = '127.0.0.1';
  process.env.MOCK_SOLVER = 'true';

  // Mock fetch so /redirect's live mkey lookup stays offline
  realFetch = global.fetch;
  global.fetch = async () => ({
    status: 200,
    url: 'https://community.secop.gov.co/Public/Common/GoogleReCaptcha/Index',
    headers: { getSetCookie: () => ['ASP.NET_SessionId=e2e; Path=/'] },
    text: async () =>
      `<button id="btnCaptchaCheckButton" onclick="location.href='/Public/Common/GoogleReCaptcha/CaptchaCheck?responseKey=x&amp;mkey=e2e7113a_4716_4a39_ac70_aa44898aee3c'">`,
    json: async () => { throw new Error('not json'); },
  });

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
    if (realFetch) {
      global.fetch = realFetch;
      realFetch = null;
    }
    if (server) {
      server.close(() => resolve());
    } else {
      resolve();
    }
  });
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

async function runHttpTests() {
  console.log('SECOP Captcha HTTP E2E Tests (local server, MOCK_SOLVER, offline)');
  console.log('====================================================================\n');

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

  // 2. Solve endpoint - mock response shape (no google/secop fields)
  await test('POST /solve (mock) returns 200 with the no-consume response shape', async () => {
    const res = await agent.post('/solve')
      .send({ method: 'service' })
      .set('X-API-Key', API_KEY);
    assert(res.status === 200, 'status is 200');
    assert(res.body.success === true, 'body.success is true');
    assert(typeof res.body.token === 'string' && res.body.token.length > 0, 'body.token is a non-empty string');
    assert(res.body.method === 'mock', 'body.method is "mock"');
    assert(typeof res.body.solvedAt === 'string', 'body.solvedAt is an ISO string');
    assert(typeof res.body.expiresIn === 'number' && res.body.expiresIn > 60, 'body.expiresIn is ~2 minutes');
    assert(res.body.google === undefined, 'body.google is absent (no Google verify — it would consume the token)');
    assert(res.body.secop === undefined, 'body.secop is absent (no SECOP check — it would consume the token)');
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

  // 5. Verify endpoint - passive validation (no token consumption)
  await test('POST /verify returns 200 passive validation, does not consume the token', async () => {
    const res = await agent.post('/verify')
      .send({ token: '03AGdBq26TestTokenValueLongEnoughForVerification12345' })
      .set('X-API-Key', API_KEY);
    assert(res.status === 200, 'status is 200');
    assert(res.body.success === true, 'body.success is true');
    assert(res.body.valid === true, 'body.valid is true');
    assert(res.body.singleUse === true, 'body.singleUse is true');
    assert(typeof res.body.length === 'number', 'body.length is present');
    assert(res.body.google === undefined, 'body.google is absent');
    assert(res.body.secop === undefined, 'body.secop is absent');
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

  // 8. Redirect endpoint - live-mkey based captchaCheckUrl
  await test('GET /redirect returns 200 with a live-mkey captchaCheckUrl', async () => {
    const res = await agent.get('/redirect');
    assert(res.status === 200, 'status is 200');
    assert(res.body.success === true, 'body.success is true');
    assert(typeof res.body.captchaPage === 'string', 'body.captchaPage is present');
    assert(typeof res.body.redirectUrl === 'string', 'body.redirectUrl is present');
    assert(typeof res.body.captchaCheckUrl === 'string', 'body.captchaCheckUrl is a string (live mkey)');
    assert(res.body.captchaCheckUrl.includes('mkey=e2e7113a'), 'captchaCheckUrl uses the extracted live mkey');
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

  // 16. Solve with valid URL for puppeteer method (mocked — no browser launch)
  await test('POST /solve with method=puppeteer and valid url returns 200 (mock)', async () => {
    const res = await agent.post('/solve')
      .send({ method: 'puppeteer', url: 'https://community.secop.gov.co' })
      .set('X-API-Key', API_KEY);
    assert(res.status === 200, 'status is 200');
    assert(res.body.method === 'mock', 'body.method is "mock"');
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

  // 19. Solve with fallback flag (mocked)
  await test('POST /solve with fallback=true returns 200 (mock)', async () => {
    const res = await agent.post('/solve')
      .send({ method: 'service', fallback: true })
      .set('X-API-Key', API_KEY);
    assert(res.status === 200, 'status is 200');
    assert(res.body.success === true, 'body.success is true');
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
    assert(res.status === 200, 'status is 200');
    assert(res.body.success === true, 'body.success is true');
  });

  // 22. POST /solve without body (defaults to method=service, mocked)
  await test('POST /solve without body returns 200 (mock)', async () => {
    const res = await agent.post('/solve')
      .set('X-API-Key', API_KEY);
    assert(res.status === 200, 'status is 200');
    assert(res.body.success === true, 'body.success is true');
  });

  // 23. POST /solve with invalid JSON
  await test('POST /solve with invalid JSON returns 500', async () => {
    const res = await agent.post('/solve')
      .set('X-API-Key', API_KEY)
      .set('Content-Type', 'application/json')
      .send('not-valid-json');
    assert(res.status === 500, 'status is 500 (body parse error)');
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

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

runHttpTests().then((success) => {
  stopServer().then(() => {
    process.exit(success ? 0 : 1);
  });
}).catch((err) => {
  console.error('Fatal error:', err);
  stopServer().then(() => {
    process.exit(1);
  });
});
