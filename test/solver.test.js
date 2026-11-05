#!/usr/bin/env node
/**
 * solver.test.js — unit tests for the solver, with fetch fully mocked.
 * No network calls, no farm costs. Run: npm test
 */

const assert = require('assert');
const {
  solve,
  solveVia2Captcha,
  solveViaCapSolver,
  get2CaptchaBalance,
  fetchSecopMkey,
  fetchSecopSession,
  checkWithSecop,
  SITE_KEY,
  TOKEN_TTL_SECONDS,
  SECOP_CAPTCHA_INDEX_URL,
} = require('../src/solver-ponytail');

// ---------------------------------------------------------------------------
// fetch mock — every test installs its own handler
// ---------------------------------------------------------------------------

const realFetch = global.fetch;
let fetchImpl = null;
let fetchCalls = [];

global.fetch = async (url, opts) => {
  fetchCalls.push({ url: String(url), opts });
  if (!fetchImpl) throw new Error('fetch called without a mock installed');
  return fetchImpl(String(url), opts);
};

function installFetch(fn) {
  fetchImpl = fn;
  fetchCalls = [];
}

function resetFetch() {
  fetchImpl = null;
  fetchCalls = [];
}

function restoreFetch() {
  global.fetch = realFetch;
}

// Response-like helpers matching the bits the solver uses
function resJson(body, { status = 200, url = 'https://mocked' } = {}) {
  return {
    status,
    url,
    headers: { getSetCookie: () => [] },
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

function resText(text, { status = 200, url = 'https://mocked' } = {}) {
  return {
    status,
    url,
    headers: { getSetCookie: () => [] },
    text: async () => text,
    json: async () => { throw new Error('not json'); },
  };
}

// Queue of responses consumed in order
function respondWithQueue(queue) {
  let i = 0;
  installFetch(() => {
    if (i >= queue.length) throw new Error(`unexpected fetch call #${i + 1}`);
    const next = queue[i++];
    return typeof next === 'function' ? next() : next;
  });
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}: ${err.message}`);
    failed++;
  } finally {
    resetFetch();
  }
}

async function assertRejects(promise, needle) {
  let threw = null;
  try {
    await promise;
  } catch (err) {
    threw = err;
  }
  assert.ok(threw, 'expected the promise to reject');
  if (needle) {
    assert.ok(
      threw.message.includes(needle),
      `expected rejection message to include "${needle}", got: ${threw.message}`
    );
  }
}

const LONG_TOKEN = '03AGdBq26' + 'x'.repeat(300);
const ENV_KEYS = {
  RECAPTCHA_SERVICE_KEY: process.env.RECAPTCHA_SERVICE_KEY,
  CAPSOLVER_API_KEY: process.env.CAPSOLVER_API_KEY,
};

function setEnv(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function runTests() {
  console.log('Solver unit tests (fetch mocked, no network)\n');

  // ── constants ──────────────────────────────────────────────────────

  await test('SITE_KEY is defined', async () => {
    assert.ok(SITE_KEY.length > 20, 'SITE_KEY should be long enough');
  });

  await test('TOKEN_TTL_SECONDS is a sane number', async () => {
    assert.ok(TOKEN_TTL_SECONDS > 60 && TOKEN_TTL_SECONDS <= 120, 'should be ~2 min');
  });

  // ── get2CaptchaBalance ─────────────────────────────────────────────

  await test('get2CaptchaBalance parses a numeric balance', async () => {
    respondWithQueue([resJson({ status: 1, request: '9.51263' })]);
    const balance = await get2CaptchaBalance('test-key');
    assert.strictEqual(balance, 9.51263);
    assert.ok(fetchCalls[0].url.includes('action=getbalance'), 'calls the balance endpoint');
  });

  await test('get2CaptchaBalance throws on ERROR_WRONG_USER_KEY', async () => {
    respondWithQueue([resJson({ status: 0, request: 'ERROR_WRONG_USER_KEY' })]);
    await assertRejects(get2CaptchaBalance('bad-key'), 'ERROR_WRONG_USER_KEY');
  });

  // ── solveVia2Captcha ───────────────────────────────────────────────

  await test('solveVia2Captcha: happy path after CAPCHA_NOT_READY', async () => {
    respondWithQueue([
      resJson({ status: 1, request: '2122988149' }),                    // submit
      resJson({ status: 0, request: 'CAPCHA_NOT_READY' }),              // poll 1
      resJson({ status: 1, request: LONG_TOKEN }),                      // poll 2
    ]);
    const token = await solveVia2Captcha('k', SITE_KEY, { pollDelayMs: 0 });
    assert.strictEqual(token, LONG_TOKEN);

    const submit = fetchCalls[0];
    assert.strictEqual(submit.url, 'https://2captcha.com/in.php');
    const body = JSON.parse(submit.opts.body);
    assert.strictEqual(body.method, 'userrecaptcha');
    assert.strictEqual(body.googlekey, SITE_KEY);
    assert.strictEqual(body.pageurl, SECOP_CAPTCHA_INDEX_URL);
    assert.ok(fetchCalls[1].url.includes('id=2122988149'), 'polls with the captcha id');
  });

  await test('solveVia2Captcha: submit error ERROR_ZERO_BALANCE surfaces immediately', async () => {
    // The old code treated this error string as a captcha ID and only failed
    // later with a misleading ERROR_WRONG_CAPTCHA_ID.
    respondWithQueue([resJson({ status: 0, request: 'ERROR_ZERO_BALANCE' })]);
    await assertRejects(solveVia2Captcha('k', SITE_KEY, { pollDelayMs: 0 }), 'ERROR_ZERO_BALANCE');
    assert.strictEqual(fetchCalls.length, 1, 'must not poll after a submit error');
  });

  await test('solveVia2Captcha: poll error ERROR_CAPTCHA_UNSOLVABLE', async () => {
    respondWithQueue([
      resJson({ status: 1, request: '42' }),
      resJson({ status: 0, request: 'ERROR_CAPTCHA_UNSOLVABLE' }),
    ]);
    await assertRejects(solveVia2Captcha('k', SITE_KEY, { pollDelayMs: 0 }), 'ERROR_CAPTCHA_UNSOLVABLE');
  });

  await test('solveVia2Captcha: poll timeout', async () => {
    let call = 0;
    installFetch(() => {
      call++;
      if (call === 1) return resJson({ status: 1, request: '42' });
      return resJson({ status: 0, request: 'CAPCHA_NOT_READY' });
    });
    await assertRejects(solveVia2Captcha('k', SITE_KEY, { pollDelayMs: 0 }), 'timeout');
  });

  await test('solveVia2Captcha: plain-text token response', async () => {
    respondWithQueue([
      resJson({ status: 1, request: '42' }),
      resText(LONG_TOKEN), // 2captcha without json=1 returns bare text
    ]);
    const token = await solveVia2Captcha('k', SITE_KEY, { pollDelayMs: 0 });
    assert.strictEqual(token, LONG_TOKEN);
  });

  // ── solveViaCapSolver ──────────────────────────────────────────────

  await test('solveViaCapSolver: happy path with correct task type and endpoint', async () => {
    respondWithQueue([
      resJson({ errorId: 0, taskId: 'task-1' }),
      resJson({ errorId: 0, status: 'processing' }),
      resJson({ errorId: 0, status: 'ready', solution: { gRecaptchaResponse: LONG_TOKEN } }),
    ]);
    const token = await solveViaCapSolver('k', SITE_KEY, { pollDelayMs: 0 });
    assert.strictEqual(token, LONG_TOKEN);

    const create = JSON.parse(fetchCalls[0].opts.body);
    assert.strictEqual(create.task.type, 'ReCaptchaV2TaskProxyLess');
    assert.strictEqual(create.task.websiteKey, SITE_KEY);
    assert.strictEqual(fetchCalls[2].url, 'https://api.capsolver.com/getTaskResult');
  });

  await test('solveViaCapSolver: createTask error surfaces', async () => {
    respondWithQueue([
      resJson({ errorId: 1, errorCode: 'ERROR_KEY_DOES_NOT_EXIST', errorMessage: 'key invalid' }),
    ]);
    await assertRejects(solveViaCapSolver('k', SITE_KEY, { pollDelayMs: 0 }), 'ERROR_KEY_DOES_NOT_EXIST');
  });

  await test('solveViaCapSolver: missing taskId rejected', async () => {
    respondWithQueue([resJson({ errorId: 0 })]);
    await assertRejects(solveViaCapSolver('k', SITE_KEY, { pollDelayMs: 0 }), 'no task ID');
  });

  // ── solve() orchestration ──────────────────────────────────────────

  await test('solve: falls back from 2captcha to capsolver', async () => {
    setEnv('RECAPTCHA_SERVICE_KEY', 'k2cap');
    setEnv('CAPSOLVER_API_KEY', 'kcap');
    respondWithQueue([
      resJson({ status: 0, request: 'ERROR_ZERO_BALANCE' }),             // 2captcha fails
      resJson({ errorId: 0, taskId: 't' }),                             // capsolver create
      resJson({ errorId: 0, status: 'ready', solution: { gRecaptchaResponse: LONG_TOKEN } }),
    ]);
    const token = await solve(SITE_KEY, '2captcha');
    assert.strictEqual(token, LONG_TOKEN);
    setEnv('RECAPTCHA_SERVICE_KEY', ENV_KEYS.RECAPTCHA_SERVICE_KEY);
    setEnv('CAPSOLVER_API_KEY', ENV_KEYS.CAPSOLVER_API_KEY);
  });

  await test('solve: requires a farm key', async () => {
    setEnv('RECAPTCHA_SERVICE_KEY', undefined);
    setEnv('CAPSOLVER_API_KEY', undefined);
    await assertRejects(solve(SITE_KEY, '2captcha'), 'RECAPTCHA_SERVICE_KEY');
    setEnv('RECAPTCHA_SERVICE_KEY', ENV_KEYS.RECAPTCHA_SERVICE_KEY);
    setEnv('CAPSOLVER_API_KEY', ENV_KEYS.CAPSOLVER_API_KEY);
  });

  await test('solve: rejects a short/invalid token', async () => {
    setEnv('RECAPTCHA_SERVICE_KEY', 'k');
    respondWithQueue([
      resJson({ status: 1, request: '42' }),
      resJson({ status: 1, request: 'SHORT' }),
    ]);
    await assertRejects(solve(SITE_KEY, '2captcha'), 'Invalid token');
    setEnv('RECAPTCHA_SERVICE_KEY', ENV_KEYS.RECAPTCHA_SERVICE_KEY);
  });

  // ── SECOP session / mkey ───────────────────────────────────────────

  await test('fetchSecopSession extracts mkey and session cookie together', async () => {
    installFetch(() => ({
      status: 200,
      url: SECOP_CAPTCHA_INDEX_URL,
      headers: { getSetCookie: () => ['ASP.NET_SessionId=abc123; Path=/; HttpOnly', 'lang=es; Path=/'] },
      text: async () => `<html><button onclick="javascript:window.location.href='/Public/Common/GoogleReCaptcha/CaptchaCheck' + '?' + 'responseKey=' + $.getURIVal('txaresponseKey') + '&mkey=dd7e7113_4716_4a39_ac70_aa44898aee3c'">`,
      json: async () => { throw new Error('not json'); },
    }));
    const { mkey, cookie } = await fetchSecopSession();
    assert.strictEqual(mkey, 'dd7e7113_4716_4a39_ac70_aa44898aee3c');
    assert.strictEqual(cookie, 'ASP.NET_SessionId=abc123; lang=es');
  });

  await test('fetchSecopMkey returns null when the page has no mkey', async () => {
    installFetch(() => resText('<html><body>no captcha button here</body></html>'));
    assert.strictEqual(await fetchSecopMkey(), null);
  });

  await test('checkWithSecop: throws instead of using a stale mkey fallback', async () => {
    // No mkey provided and the live page yields none — must NOT fall back
    // to a hardcoded default (that always produces the "expired" ErrorPage).
    installFetch(() => resText('<html>no mkey</html>'));
    await assertRejects(checkWithSecop('dummy-token'), 'mkey');
  });

  await test('checkWithSecop: success when final URL is not an error page', async () => {
    installFetch((url) => {
      if (url.includes('GoogleReCaptcha/Index')) {
        return resText(`<button onclick="x?mkey=abc123_def456_789012_abcdef012345">`, { url });
      }
      // The CaptchaCheck request itself: redirected to the protected page
      return resText('<html>protected page</html>', { status: 200, url: 'https://community.secop.gov.co/Public/Tendering/ContractNoticeManagement/Index' });
    });
    const result = await checkWithSecop('dummy-token');
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.mkey, 'abc123_def456_789012_abcdef012345');
    const check = fetchCalls[1];
    assert.ok(check.url.includes('responseKey=dummy-token'), 'submits the token');
    assert.ok(check.url.includes('mkey=abc123_def456_789012_abcdef012345'), 'submits the fresh mkey');
  });

  await test('checkWithSecop: failure when SECOP redirects to ErrorPage', async () => {
    installFetch((url) => {
      if (url.includes('GoogleReCaptcha/Index')) {
        return resText(`<button onclick="x?mkey=abc123_def456_789012_abcdef012345">`, { url });
      }
      return resText('<html>ErrorPage</html>', { status: 302, url: 'https://community.secop.gov.co/Public/Common/ErrorPage/Index' });
    });
    const result = await checkWithSecop('dummy-token');
    assert.strictEqual(result.success, false);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  restoreFetch();
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
