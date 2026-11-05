# SECOP reCAPTCHA Solver (Ponytail)

A minimal, zero-friction Node.js service designed to solve Google reCAPTCHA v2 for the SECOP (Colombian State Commercialization Company) tendering platform.

## Features

- **Zero-Framework Dependency:** Uses only Node.js built-in modules (`http`, `url`) and `puppeteer`. No Express or Axios required.
- **Multi-Farm Support:** Automatically solves reCAPTCHAs via **2Captcha** (primary) or **CapSolver** (fallback).
- **Local Solving:** Supports headless browser solving via Puppeteer for scenarios where third-party farms are unavailable (fails fast with a clear error if Google serves an interactive challenge).
- **Token-Safe by Design:** `/solve` never verifies the tokens it returns — Google siteverify and SECOP's CaptchaCheck both consume single-use tokens, so only the caller's own submission may touch them.
- **Docker Ready:** Lightweight Docker image for easy deployment.

## Token lifecycle (read this first)

reCAPTCHA tokens are **single-use** and expire **~2 minutes** after the farm generates them:

1. `POST /solve` returns a fresh token (nothing has consumed it).
2. The caller loads SECOP's captcha page **in its own browser session** and extracts the **fresh mkey** from `btnCaptchaCheckButton` (the mkey is per-page-load; a stale one produces the *"página expirada por inactividad"* ErrorPage).
3. The caller navigates to `CaptchaCheck?responseKey=<token>&mkey=<mkey>` **immediately** — that is the one and only submission.
4. Retry the original download in the same session.

This flow is proven end-to-end by `npm run live:paid` and implemented by `secop-scraper`'s `_inject_token`.

## Setup

### Local Development

1. **Install Dependencies:**
   ```bash
   npm install
   ```

2. **Configure Environment Variables:**
   Copy the example file and fill in your keys:
   ```bash
   cp .env.example .env
   ```
   Required variables:
   - `RECAPTCHA_SERVICE_KEY`: Your 2Captcha API key.
   - `CAPSOLVER_API_KEY` (Optional): Your CapSolver API key for fallback. Leave empty if unused — a placeholder key makes fallback errors misleading.
   - `FARM_SERVICE`: "2captcha" or "capsolver".
   - `PORT`: Server port (default: 3000).
   - `MOCK_SOLVER`: "true" to return fake tokens from `/solve` (testing only).
   - `PUPPETEER_EXECUTABLE_PATH` (Optional): Path to a Chrome binary. Omit to use the Chromium bundled with puppeteer.

3. **Run the Server:**
   ```bash
   npm start
   # or for development with auto-reload:
   npm run dev
   ```

### Docker Deployment

1. **Build the Image:**
   ```bash
   docker build -t secop-captcha .
   ```

2. **Run the Container:**
   ```bash
   docker run -d -p 3000:3000 \
     -e RECAPTCHA_SERVICE_KEY=your_2captcha_key \
     secop-captcha
   ```

## API Documentation

The server exposes the following endpoints at `http://localhost:3000`.

### Health Check
- **Method:** `GET`
- **Endpoint:** `/health`
- **Response:**
  ```json
  {
    "status": "ok",
    "service": "secop-captcha-ponytail",
    "timestamp": "2026-10-31T23:20:25.165Z",
    "siteKey": "6LcMmakZAAAAAB157Q90hORUGtNd790TCws4vBNw",
    "farm": "2captcha"
  }
  ```

### Solve reCAPTCHA
- **Method:** `POST`
- **Endpoint:** `/solve`
- **Body:**
  ```json
  {
    "method": "service", // or "puppeteer"
    "url": "https://...", // Optional: specific URL to solve if method is 'puppeteer'
    "fallback": true // Optional: switch farm for this request
  }
  ```
- **Response:**
  ```json
  {
    "success": true,
    "token": "0cAF... (long token string)",
    "method": "2Captcha",
    "solvedAt": "2026-11-05T04:55:00.000Z",
    "expiresIn": 110
  }
  ```
  The token is **not verified** by the server on purpose — see *Token lifecycle* above. Submit it to SECOP yourself, once, from your own session.

### Verify Token (passive)
- **Method:** `POST`
- **Endpoint:** `/verify`
- **Body:**
  ```json
  {
    "token": "0cAF... (long token string)"
  }
  ```
- **Response:**
  ```json
  {
    "success": true,
    "valid": true,
    "length": 2446,
    "singleUse": true,
    "ttlSeconds": 110,
    "note": "Passive validation only. Submitting the token to SECOP CaptchaCheck consumes it."
  }
  ```
  Passive format validation only — the server does not call Google or SECOP for this token (that would consume it). For a full live verification use `npm run live:paid`.

### Redirect Info
- **Method:** `GET`
- **Endpoint:** `/redirect?previousUrl=https://...`
- **Response:**
  ```json
  {
    "success": true,
    "captchaPage": "https://community.secop.gov.co/Public/Common/GoogleReCaptcha/Index",
    "redirectUrl": "...",
    "captchaCheckUrl": "https://community.secop.gov.co/Public/Common/GoogleReCaptcha/CaptchaCheck?mkey=<live mkey>",
    "siteKey": "6LcMmakZAAAAAB157Q90hORUGtNd790TCws4vBNw"
  }
  ```
  `captchaCheckUrl` carries a **live** mkey fetched on each request (or `null` if extraction fails — never a stale hardcoded one).

## CLI Usage

You can also use the solver directly from the command line:

```bash
# Solve via farm (returns the raw token; nothing consumes it)
node src/solver-ponytail.js solve

# Solve with local puppeteer
node src/solver-ponytail.js solve-puppeteer

# Check farm balance (free, no solve)
node src/solver-ponytail.js balance

# Verify a token with Google (CONSUMES the token)
node src/solver-ponytail.js verify <token>

# Check token with SECOP (CONSUMES the token; session-bound)
node src/solver-ponytail.js check <token>
```

## Testing

```bash
npm test        # unit tests, fetch fully mocked — no network, no cost
npm run e2e     # HTTP tests with MOCK_SOLVER + mocked fetch — offline
npm run live    # free live checks: farm balance, SECOP page, mkey extraction
npm run live:paid  # full end-to-end: farm solve → single-session CaptchaCheck →
                # protected page (~$0.003 per run; consumes one token)
```

## Configuration Reference

| Variable | Description | Default |
|----------|-------------|---------|
| `RECAPTCHA_SERVICE_KEY` | Primary 2Captcha API Key | - |
| `CAPSOLVER_API_KEY` | Fallback CapSolver API Key | - |
| `FARM_SERVICE` | Primary farm service | `2captcha` |
| `PORT` | Server port | `3000` |
| `SECOP_CAPTCHA_API_KEY` | API key required via `X-API-Key` on `/solve` and `/verify` | off |
| `MAX_CONCURRENT` | Max in-flight requests (429 beyond this) | `10` |
| `MOCK_SOLVER` | Return fake tokens from `/solve` (testing only) | `false` |
| `PUPPETEER_EXECUTABLE_PATH` | Path to Chrome binary | puppeteer's bundled Chromium |

## License

ISC
