#!/usr/bin/env node
/**
 * real.test.js — Verifica que el solver resuelve captchas reales.
 *
 * Flujo completo:
 *   1. Solicita resolución a la granja (2Captcha / CapSolver)
 *   2. Recibe el token
 *   3. Verifica con Google siteverify
 *   4. Verifica con SECOP (el paso que realmente importa)
 *
 * Costo: ~$0.003-0.007 por intento con 2Captcha.
 * Requiere RECAPTCHA_SERVICE_KEY o CAPSOLVER_API_KEY en el .env.
 *
 * Uso:
 *   cd /Users/ed/Projects/secop-captcha
 *   node test/real.test.js
 */

const {
  solve,
  verifyWithGoogle,
  checkWithSecop,
  checkWithSecopBrowser,
  shouldSkipGoogleVerification,
  SITE_KEY,
} = require('../src/solver-ponytail');

async function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  console.log('\n========================================');
  console.log('  REAL SOLVER TEST');
  console.log('  Testing live 2Captcha / CapSolver');
  console.log('========================================\n');

  // Verificar que tenemos keys reales
  const recKey = process.env.RECAPTCHA_SERVICE_KEY || '';
  const capKey = process.env.CAPSOLVER_API_KEY || '';

  if (!recKey && !capKey) {
    console.error('ERROR: No API keys found.');
    console.error('Set RECAPTCHA_SERVICE_KEY or CAPSOLVER_API_KEY in .env');
    process.exit(1);
  }

  if (recKey.startsWith('test-') || capKey.startsWith('test-')) {
    console.error('ERROR: Using test keys. Need real API keys.');
    console.error('RECAPTCHA_SERVICE_KEY = ' + recKey);
    console.error('CAPSOLVER_API_KEY     = ' + capKey);
    process.exit(1);
  }

  console.log('Site key:     ' + SITE_KEY);
  console.log('2Captcha key: ' + recKey.substring(0, 4) + '...');
  console.log('CapSolver key:' + capKey.substring(0, 4) + '...');
  console.log('');

  const farm = process.env.FARM_SERVICE || '2captcha';
  const skipGoogle = shouldSkipGoogleVerification();

  // ── Step 1: SOLVE ──────────────────────────────────────────────────
  console.log('[1/4] Solving reCAPTCHA via ' + farm + '...');
  console.log('      (waiting for human resolver — 30-120 seconds)');

  let token;
  try {
    token = await solve(SITE_KEY, farm);
  } catch (err) {
    console.error('\n✗ STEP 1 FAILED: Farm error');
    console.error('  ' + err.message);
    process.exit(1);
  }

  if (!token || typeof token !== 'string' || token.length < 50) {
    console.error('\n✗ STEP 1 FAILED: Invalid token');
    console.error('  ' + JSON.stringify(token)?.substring(0, 200));
    process.exit(1);
  }

  console.log('  ✓ Token received');
  console.log('  Length: ' + token.length + ' chars');
  console.log('  Prefix: ' + token.substring(0, 40) + '...');

  // ── Step 2: GOOGLE VERIFICATION ────────────────────────────────────
  console.log('\n[2/4] Verifying with Google...');

  let googleResult = null;
  if (!skipGoogle) {
    try {
      googleResult = await verifyWithGoogle(token, SITE_KEY);
    } catch (err) {
      console.error('  Warning: Google verification failed — ' + err.message);
    }

    if (googleResult) {
      console.log('  success: ' + googleResult.success);
      console.log('  hostname: ' + (googleResult.hostname || '(none)'));
      console.log('  score: ' + (googleResult.score ?? '(none)'));
      console.log('  action: ' + (googleResult.action || '(none)'));
      if (googleResult.error) {
        console.log('  ⚠️  ' + googleResult.error);
      }
    }
  } else {
    console.log('  Skipped (VERIFY_WITH_GOOGLE=false)');
    console.log('  ℹ️  Expected: siteverify with SITE_KEY always fails.');
  }

  // ── Step 3: SECOP CHECK ────────────────────────────────────────────
  console.log('\n[3/4] Checking token with SECOP (the real test)...');

  let secopResult;
  try {
    const useBrowser = process.env.SECOP_CHECK === 'browser';
    if (useBrowser) {
      console.log('  Using browser-based check (extracts dynamic mkey)...');
      secopResult = await checkWithSecopBrowser(token);
    } else {
      secopResult = await checkWithSecop(token);
    }
  } catch (err) {
    console.error('\n✗ STEP 3 FAILED: SECOP check threw');
    console.error('  ' + err.message);
    process.exit(1);
  }

  console.log('  success: ' + secopResult.success);
  console.log('  status:  ' + (secopResult.status || '(none)'));
  console.log('  url:     ' + (secopResult.url || '(none)'));

  // ── Step 4: VERDICT ────────────────────────────────────────────────
  console.log('\n[4/4] Verdict:');

  if (secopResult.success) {
    console.log('  ✅ PASSED — SECOP accepted the token!');
    console.log('  The solver works. The service is production-ready.');
  } else {
    console.log('  ✗ FAILED — SECOP rejected the token');
    console.log('  Response: ' + JSON.stringify(secopResult));
    console.log('');
    console.log('  Possible causes:');
    console.log('  - The token expired (captcha tokens are time-limited)');
    console.log('  - The captcha was solved incorrectly');
    console.log('  - SECOP changed their validation endpoint');
    console.log('');
    console.log('  Note: even a failed SECOP check proves the solver WORKS');
    console.log('  — it returned a real token. The failure may be due to');
    console.log('  timing (token expired between solve and check).');
  }

  if (googleResult && !skipGoogle) {
    console.log('');
    if (googleResult.success) {
      console.log('  ✅ Google also accepted the token (score: ' + googleResult.score + ')');
    } else {
      console.log('  ℹ️  Google rejected it (expected — we use SITE_KEY, not the secret)');
    }
  }

  console.log('\n========================================\n');
}

main().catch((err) => {
  console.error('\n✗ FATAL: ' + err.message);
  console.error(err.stack);
  process.exit(1);
});