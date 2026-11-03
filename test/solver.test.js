const {
  solve,
  solveWithPuppeteer,
  verifyWithGoogle,
  checkWithSecop,
  shouldSkipGoogleVerification,
  SITE_KEY,
  DEFAULT_MKEY,
} = require('../src/solver-ponytail');
const assert = require('assert');

let passed = 0;
let failed = 0;

function test(name, fn) {
  return fn().then(
    () => { console.log(`  ✓ ${name}`); passed++; },
    (err) => { console.error(`  ✗ ${name}: ${err.message}`); failed++; }
  );
}

async function runTests() {
  console.log('Running tests...\n');

  await test('SITE_KEY is defined', async () => {
    assert.ok(SITE_KEY, 'SITE_KEY should be a non-empty string');
    assert.ok(SITE_KEY.length > 20, 'SITE_KEY should be long enough');
  });

  await test('DEFAULT_MKEY is defined', async () => {
    assert.ok(DEFAULT_MKEY, 'DEFAULT_MKEY should be a non-empty string');
  });

  await test('shouldSkipGoogleVerification returns false by default', async () => {
    // Only true when VERIFY_WITH_GOOGLE is 'false', '0', or 'no'
    const original = process.env.VERIFY_WITH_GOOGLE;
    process.env.VERIFY_WITH_GOOGLE = 'true';
    const result = shouldSkipGoogleVerification();
    process.env.VERIFY_WITH_GOOGLE = original;
    assert.strictEqual(result, false, 'should return false when VERIFY_WITH_GOOGLE=true');
  });

  await test('shouldSkipGoogleVerification returns true when false', async () => {
    const original = process.env.VERIFY_WITH_GOOGLE;
    process.env.VERIFY_WITH_GOOGLE = 'false';
    const result = shouldSkipGoogleVerification();
    process.env.VERIFY_WITH_GOOGLE = original;
    assert.strictEqual(result, true, 'should return true when VERIFY_WITH_GOOGLE=false');
  });

  await test('shouldSkipGoogleVerification returns true when 0', async () => {
    const original = process.env.VERIFY_WITH_GOOGLE;
    process.env.VERIFY_WITH_GOOGLE = '0';
    const result = shouldSkipGoogleVerification();
    process.env.VERIFY_WITH_GOOGLE = original;
    assert.strictEqual(result, true, 'should return true when VERIFY_WITH_GOOGLE=0');
  });

  await test('verifyWithGoogle returns valid structure', async () => {
    const result = await verifyWithGoogle('', SITE_KEY);
    assert.ok(result.success !== undefined || result.error !== undefined, 'has success or error');
    assert.ok(result instanceof Object, 'returns an object');
  });

  await test('checkWithSecop returns valid structure', async () => {
    const result = await checkWithSecop('dummy-token');
    assert.ok(result.success !== undefined, 'has success');
    assert.ok(result.status !== undefined, 'has status');
    assert.ok(result.url !== undefined, 'has url');
  });

  await test('solve exports is a function', async () => {
    assert.strictEqual(typeof solve, 'function', 'solve should be a function');
  });

  await test('solveWithPuppeteer exports is a function', async () => {
    assert.strictEqual(typeof solveWithPuppeteer, 'function', 'solveWithPuppeteer should be a function');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
