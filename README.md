# SECOP reCAPTCHA Solver (Ponytail)

A minimal, zero-friction Node.js service designed to solve Google reCAPTCHA v2 for the SECOP (Colombian State Commercialization Company) tendering platform.

## Features

- **Zero-Framework Dependency:** Uses only Node.js built-in modules (`http`, `url`) and `puppeteer`. No Express or Axios required.
- **Multi-Farm Support:** Automatically solves reCAPTCHAs via **2Captcha** (primary) or **CapSolver** (fallback).
- **Local Solving:** Supports headless browser solving via Puppeteer for scenarios where third-party farms are unavailable.
- **Verification:** Includes built-in verification against Google's siteverify API and SECOP's internal CaptchaCheck endpoint.
- **Docker Ready:** Lightweight Alpine-based Docker image for easy deployment.

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
   - `CAPSOLVER_API_KEY` (Optional): Your CapSolver API key for fallback.
   - `FARM_SERVICE`: "2captcha" or "capsolver".
   - `PORT`: Server port (default: 3000).
   - `VERIFY_WITH_GOOGLE`: Set to "false" to skip Google validation (recommended for SECOP).
   - `PUPPETEER_EXECUTABLE_PATH`: Path to your local Chrome/Chromium binary (if not using Docker).

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
     -e VERIFY_WITH_GOOGLE=false \
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
    "url": "https://..." // Optional: specific URL to solve if method is 'puppeteer'
  }
  ```
- **Response:**
  ```json
  {
    "success": true,
    "token": "0cAF... (long token string)",
    "google": {
      "success": true,
      "skipped": true,
      "hostname": "community.secop.gov.co"
    },
    "secop": {
      "success": true,
      "status": 200,
      "finalUrl": "https://community.secop.gov.co/Public/Common/GoogleReCaptcha/CaptchaCheck"
    },
    "method": "2Captcha"
  }
  ```

### Verify Token
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
    "google": { "skipped": true, ... },
    "secop": { "success": true, ... }
  }
  ```

### Redirect Info
- **Method:** `GET`
- **Endpoint:** `/redirect?previousUrl=https://...`
- **Response:**
  ```json
  {
    "success": true,
    "captchaPage": "https://community.secop.gov.co/Public/Common/GoogleReCaptcha/Index",
    "redirectUrl": "...",
    "captchaCheckUrl": "https://community.secop.gov.co/Public/Common/GoogleReCaptcha/CaptchaCheck?mkey=...",
    "siteKey": "6LcMmakZAAAAAB157Q90hORUGtNd790TCws4vBNw"
  }
  ```

## CLI Usage

You can also use the solver directly from the command line:

```bash
# Solve via farm
node src/solver-ponytail.js solve

# Solve with local puppeteer
node src/solver-ponytail.js solve-puppeteer

# Verify a token with Google
node src/solver-ponytail.js verify <token>

# Check token with SECOP
node src/solver-ponytail.js check <token>
```

## Configuration Reference

| Variable | Description | Default |
|----------|-------------|---------|
| `RECAPTCHA_SERVICE_KEY` | Primary 2Captcha API Key | - |
| `CAPSOLVER_API_KEY` | Fallback CapSolver API Key | - |
| `FARM_SERVICE` | Primary farm service | `2captcha` |
| `PORT` | Server port | `3000` |
| `VERIFY_WITH_GOOGLE` | Skip Google siteverify | `true` |
| `PUPPETEER_EXECUTABLE_PATH` | Path to Chrome binary | Auto-detect |

## License

ISC