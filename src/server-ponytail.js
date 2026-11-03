#!/usr/bin/env node
/**
 * server-ponytail.js — minimal HTTP server for SECOP reCAPTCHA solving.
 *
 * Zero dependencies beyond puppeteer and dotenv (no express, no axios).
 * Uses Node.js built-in `http` module for the server.
 *
 * API (compatible with secop-scraper Python client):
 *   POST /solve   {"method":"service","url":"..."}  → {"success":true,"token":"..."}
 *   POST /verify  {"token":"..."}                   → verification result
 *   GET  /health                                → {"status":"ok"}
 *   GET  /redirect                              → redirect URL JSON
 */

require('dotenv').config();

const http = require('http');
const { URL } = require('url');
const {
  solve,
  solveWithPuppeteer,
  verifyWithGoogle,
  checkWithSecop,
  SITE_KEY,
  DEFAULT_MKEY,
  shouldSkipGoogleVerification,
} = require('./solver-ponytail');

// ---------------------------------------------------------------------------
// Server configuration
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || '127.0.0.1';

// Farm service: "2captcha" (default) or "capsolver"
const FARM_SERVICE = process.env.FARM_SERVICE || '2captcha';

// 2Captcha API key (used by farm)
const RECAPTCHA_SERVICE_KEY = process.env.RECAPTCHA_SERVICE_KEY || '';

// Google siteverify secret key — NOTE: SITE_KEY is public, not secret.
// Google siteverify always fails with the site key; VERIFY_WITH_GOOGLE=false is required.
const GOOGLE_SECRET_KEY = SITE_KEY;

// Whether to skip Google verification entirely
const SKIP_GOOGLE = shouldSkipGoogleVerification();

// Validate API keys at startup
const apiKey = process.env.RECAPTCHA_SERVICE_KEY;
const capSolverKey = process.env.CAPSOLVER_API_KEY;
if (!apiKey && !capSolverKey) {
  console.error('CRITICAL: No API keys found. Set RECAPTCHA_SERVICE_KEY or CAPSOLVER_API_KEY in your .env file.');
  process.exit(1);
}

// Rate limiting configuration
const RATE_LIMIT_WINDOW_MS = 60000; // 1 minute window
const RATE_LIMIT_MAX_REQUESTS = 60; // max requests per window per IP

// In-memory rate limit tracking
const rateLimitMap = new Map();

// Max concurrent requests
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT, 10) || 10;
let activeRequests = 0;

// Shared browser state — keep one instance alive across requests
let browser = null;
let mkey = DEFAULT_MKEY; // set at runtime if we visit the SECOP page

// ---------------------------------------------------------------------------
// API key authentication middleware

const API_KEY = process.env.SECOP_CAPTCHA_API_KEY || '';
const AUTH_ENABLED = API_KEY.length > 0;

function authMiddleware(req, res, next) {
  // Public GET endpoints — no auth needed (match pathname, not full URL with query string)
  const pathname = req.url.split('?')[0];
  if (pathname === '/health' || pathname === '/redirect' || req.method === 'OPTIONS') {
    return next();
  }
  if (!AUTH_ENABLED) {
    return next();
  }
  const headerKey = req.headers['x-api-key'] || '';
  if (headerKey === API_KEY) {
    return next();
  }
  console.warn(`[${new Date().toISOString()}] Unauthorized request from ${getClientIp(req)}: missing or invalid X-API-Key`);
  sendJson(res, 401, {
    success: false,
    error: 'Unauthorized. Valid X-API-Key required.',
  });
}


// Logging middleware
// ---------------------------------------------------------------------------

function logMiddleware(req, res, next) {
  const start = Date.now();
  const startTimestamp = new Date().toISOString();
  const clientIp = getClientIp(req);
  const method = req.method;
  const url = req.url;

  res.on('finish', () => {
    const duration = Date.now() - start;
    if (res.statusCode >= 400) {
      console.error(`[${startTimestamp}] ${clientIp} ${method} ${url} → ${res.statusCode} (${duration}ms)`);
    } else {
      console.log(`[${startTimestamp}] ${clientIp} ${method} ${url} → ${res.statusCode} (${duration}ms)`);
    }
  });

  next();
}

// ---------------------------------------------------------------------------
// Rate limiting middleware
// ---------------------------------------------------------------------------

function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0].trim()
    || req.socket.remoteAddress
    || '127.0.0.1';
}

function rateLimitMiddleware(req, res, next) {
  const ip = getClientIp(req);
  const now = Date.now();

  if (!rateLimitMap.has(ip)) {
    rateLimitMap.set(ip, []);
  }

  const timestamps = rateLimitMap.get(ip);
  // Remove old timestamps outside the window
  const recentTimestamps = timestamps.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  rateLimitMap.set(ip, recentTimestamps);

  if (recentTimestamps.length >= RATE_LIMIT_MAX_REQUESTS) {
    console.warn(`[${new Date().toISOString()}] Rate limit exceeded for ${ip}`);
    sendJson(res, 429, {
      success: false,
      error: 'Too many requests. Please try again later.',
      retryAfter: `${Math.ceil((recentTimestamps[0] + RATE_LIMIT_WINDOW_MS - now) / 1000)}s`,
    });
    return;
  }

  recentTimestamps.push(now);
  next();
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

function validateSolveInput(body) {
  const errors = [];

  if (body.method && !['service', 'puppeteer', 'local'].includes(body.method)) {
    errors.push('method must be "service", "puppeteer", or "local"');
  }

  if (body.method === 'puppeteer' || body.method === 'local') {
    if (!body.url) {
      errors.push('url is required when method is "puppeteer" or "local"');
    } else {
      try {
        const parsed = new URL(body.url);
        const allowedHosts = ['community.secop.gov.co', 'localhost', '127.0.0.1'];
        const isValidHost = allowedHosts.some(h => parsed.hostname.includes(h));
        if (!isValidHost) {
          errors.push('url hostname "' + parsed.hostname + '" not in allowed list');
        }
      } catch {
        errors.push('url is not a valid URL');
      }
    }
  }

  return errors;
}

function validateVerifyInput(body) {
  const errors = [];

  if (!body.token || typeof body.token !== 'string') {
    errors.push('token is required and must be a string');
  } else if (body.token.length < 50) {
    errors.push('token appears to be too short');
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Request body parser — no body-parser needed
// ---------------------------------------------------------------------------

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf-8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(new Error('Invalid JSON: ' + err.message));
      }
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handleHealth(_req, res) {
  sendJson(res, 200, {
    status: 'ok',
    service: 'secop-captcha-ponytail',
    timestamp: new Date().toISOString(),
    siteKey: SITE_KEY,
    farm: FARM_SERVICE,
  });
}

async function handleSolve(req, res) {
  try {
    const body = await parseBody(req);

    // Validate input
    const validationErrors = validateSolveInput(body);
    if (validationErrors.length > 0) {
      return sendJson(res, 400, {
        success: false,
        error: 'Validation failed',
        details: validationErrors,
      });
    }

    const { method = 'service', url, fallback } = body;

    let token;
    let serviceUsed;

    if (process.env.MOCK_SOLVER === 'true') {
      console.log('Mock solver: returning fake token');
      sendJson(res, 200, {
        success: true,
        token: 'FAKE_TOKEN_123456789012345678901234567890',
        method: 'mock',
      });
      return;
    }

    if (method === 'puppeteer' || method === 'local') {
      // Solve locally with headless browser
      token = await solveWithPuppeteer(url);
      serviceUsed = 'puppeteer';
    } else {
      // Solve via 2Captcha / CapSolver farm
      const farm = fallback && FARM_SERVICE !== 'capsolver' ? 'capsolver' : FARM_SERVICE;
      token = await solve(SITE_KEY, farm);
      serviceUsed = fallback && farm === 'capsolver' ? 'CapSolver (fallback)' : `${farm === 'capsolver' ? 'CapSolver' : '2Captcha'}`;
    }

    // Verify with Google (or skip if configured)
    let google;
    if (SKIP_GOOGLE) {
      google = { success: true, skipped: true, hostname: 'community.secop.gov.co' };
    } else {
      google = await verifyWithGoogle(token, GOOGLE_SECRET_KEY);
    }

    // Check with SECOP
    const secop = await checkWithSecop(token);

    sendJson(res, 200, {
      success: true,
      token,
      google,
      secop,
      method: serviceUsed,
    });
  } catch (err) {
    console.error('POST /solve error:', err.message);
    sendJson(res, 500, {
      success: false,
      error: err.message,
    });
  }
}

async function handleVerify(req, res) {
  try {
    const body = await parseBody(req);

    // Validate input
    const validationErrors = validateVerifyInput(body);
    if (validationErrors.length > 0) {
      return sendJson(res, 400, {
        success: false,
        error: 'Validation failed',
        details: validationErrors,
      });
    }

    const { token } = body;

    let google;
    if (SKIP_GOOGLE) {
      google = { success: true, skipped: true, hostname: 'community.secop.gov.co' };
    } else {
      google = await verifyWithGoogle(token, GOOGLE_SECRET_KEY);
    }
    const secop = await checkWithSecop(token);

    sendJson(res, 200, { success: true, google, secop });
  } catch (err) {
    console.error('POST /verify error:', err.message);
    sendJson(res, 500, { success: false, error: err.message });
  }
}

function handleRedirect(req, res) {
  const urlObj = new URL(req.url, `http://localhost:${PORT}`);
  const previousUrl = urlObj.searchParams.get('previousUrl')
    || 'https://community.secop.gov.co/Public/Tendering/ContractNoticeManagement/Index?currentLanguage=es-CO&Page=login&Country=CO&SkinName=CCE';

  sendJson(res, 200, {
    success: true,
    captchaPage: 'https://community.secop.gov.co/Public/Common/GoogleReCaptcha/Index',
    redirectUrl: previousUrl,
    captchaCheckUrl: `${require('url').format({
      protocol: 'https',
      hostname: 'community.secop.gov.co',
      pathname: '/Public/Common/GoogleReCaptcha/CaptchaCheck',
      query: { mkey: DEFAULT_MKEY },
    })}`,
    siteKey: SITE_KEY,
  });
}

// ---------------------------------------------------------------------------
// Main router
// ---------------------------------------------------------------------------

async function router(req, res) {
  // CORS — allow secop-scraper Python client to hit this from browser
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsed = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = parsed.pathname;

  if (req.method === 'GET' && pathname === '/health') {
    return handleHealth(req, res);
  }

  if (req.method === 'POST' && pathname === '/solve') {
    handleSolve(req, res).catch(err => {
      console.error('POST /solve unhandled:', err.message);
      if (!res.headersSent) {
        sendJson(res, 500, { success: false, error: err.message });
      }
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/verify') {
    handleVerify(req, res).catch(err => {
      console.error('POST /verify unhandled:', err.message);
      if (!res.headersSent) {
        sendJson(res, 500, { success: false, error: err.message });
      }
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/redirect') {
    return handleRedirect(req, res);
  }

  sendJson(res, 404, {
    error: 'not found',
    routes: {
      GET: '/health',
      POST: '/solve',
      POST: '/verify',
      GET: '/redirect',
    },
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  // Concurrency gate — safe decrement via finally even on 429
  if (activeRequests >= MAX_CONCURRENT) {
    activeRequests++;
    console.warn('[' + new Date().toISOString() + '] Concurrency limit reached (' + activeRequests + '/' + MAX_CONCURRENT + ')');
    activeRequests--;
    sendJson(res, 429, {
      success: false,
      error: 'Too many concurrent requests.',
    });
    return;
  }
  activeRequests++;

  try {
    authMiddleware(req, res, () => {
      rateLimitMiddleware(req, res, () => {
        logMiddleware(req, res, () => {
          router(req, res);
        });
      });
    });
  } finally {
    activeRequests--;
  }
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log(`SECOP reCAPTCHA Solver (ponytail) running on http://localhost:${PORT}`);
  console.log('');
  console.log('  Routes:');
  console.log(`    POST /solve    — Solve reCAPTCHA`);
  console.log(`    POST /verify   — Verify token`);
  console.log(`    GET  /health   — Health check`);
  console.log(`    GET  /redirect — Redirect URL info`);
  console.log('');
  console.log(`  Config:`);
  console.log(`    Farm:         ${FARM_SERVICE}`);
  console.log(`    Site:         ${SITE_KEY}`);
  console.log(`    2Cap:         ${RECAPTCHA_SERVICE_KEY ? `${RECAPTCHA_SERVICE_KEY.substring(0, 4)}...` : '(not set)'}`);
  console.log(`    CapSol:       ${process.env.CAPSOLVER_API_KEY ? '(set)' : '(not set)'}`);
  console.log(`    VerifyGoogle: ${SKIP_GOOGLE ? 'skipped' : 'enabled'}`);
  console.log(`    RateLimit:    ${RATE_LIMIT_MAX_REQUESTS} req/${RATE_LIMIT_WINDOW_MS / 1000}s per IP`);
  console.log('');
  console.log('  Environment:');
  console.log('    RECAPTCHA_SERVICE_KEY  — 2Captcha API key');
  console.log('    CAPSOLVER_API_KEY      — CapSolver API key');
  console.log('    FARM_SERVICE           — "2captcha" or "capsolver"');
  console.log('    VERIFY_WITH_GOOGLE     — "true" (default) or "false" to skip Google siteverify');
  console.log('    PORT                   — Server port (default: 3000)');
  console.log('    PUPPETEER_EXECUTABLE_PATH — Chrome binary path');
  console.log('');
});

// Graceful shutdown
function shutdown() {
  console.log('\nShutting down...');
  server.close(() => {
    process.exit(0);
  });
  // Force exit after 5s if server won't close
  setTimeout(() => process.exit(0), 5000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Export for testing
module.exports = { server, router };