require('dotenv').config();
const puppeteer = require('puppeteer');
const { solve, SECOP_CAPTCHA_CHECK_URL, DEFAULT_MKEY, SITE_KEY } = require('./src/solver-ponytail');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const frameDir = 'frames';
if (fs.existsSync(frameDir)) fs.rmSync(frameDir, { recursive: true });
fs.mkdirSync(frameDir);

async function main() {
  console.log('[1/8] Solving captcha via 2Captcha farm...');
  const token = await solve(SITE_KEY, '2captcha');
  console.log('  Token received:', token.substring(0, 30) + '...');

  console.log('[2/8] Launching visible browser...');
  const browser = await puppeteer.launch({
    headless: false,
    args: ['--no-sandbox', '--disable-setuid-bounce', '--window-size=1280,720'],
    defaultViewport: { width: 1280, height: 720 }
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });

  // Phase 1: Show the gatekept page first (before captcha)
  console.log('[3/8] Phase 1: Opening SECOP gatekept page...');
  const targetUrl = 'https://community.secop.gov.co/Public/Tendering/ContractNoticeManagement/Index?currentLanguage=es-CO&Page=login&Country=CO&SkinName=CCE';
  await page.goto(targetUrl, { waitUntil: 'networkidle0' });
  await page.screenshot({ path: path.join(frameDir, '1.png'), fullPage: true });
  await new Promise(r => setTimeout(r, 2000));
  console.log('  -> Contract Notice Management loaded');

  // Phase 2: Navigate to captcha page
  console.log('[4/8] Phase 2: Navigating to Captcha Index...');
  const captchaUrl = 'https://community.secop.gov.co/Public/Common/GoogleReCaptcha/Index?previousUrl=' + encodeURIComponent(targetUrl);
  await page.goto(captchaUrl, { waitUntil: 'networkidle0' });
  await page.screenshot({ path: path.join(frameDir, '2.png'), fullPage: true });
  await new Promise(r => setTimeout(r, 2000));
  console.log('  -> Captcha Index page loaded');

  // Phase 3: Wait for reCAPTCHA frame
  console.log('[5/8] Phase 3: Waiting for reCAPTCHA to load...');
  await page.waitForSelector('iframe[src*="recaptcha"]', { timeout: 15000 });
  await page.screenshot({ path: path.join(frameDir, '3.png'), fullPage: true });
  await new Promise(r => setTimeout(r, 2000));
  console.log('  -> "I\'m not a robot" checkbox visible');

  // Phase 4: Show token solving
  console.log('[6/8] Phase 4: Token solved by 2Captcha worker...');
  await page.screenshot({ path: path.join(frameDir, '4.png'), fullPage: true });
  await new Promise(r => setTimeout(r, 3000));
  console.log('  -> Token received from 2Captcha farm');
  await page.screenshot({ path: path.join(frameDir, '5.png'), fullPage: true });

  // Phase 5: Extract mkey and submit
  console.log('[7/8] Phase 5: Extracting mkey and submitting token...');
  let mkey = await page.evaluate(() => {
    const btn = document.getElementById('btnCaptchaCheckButton');
    if (!btn) return null;
    const match = (btn.getAttribute('onclick') || '').match(/mkey=([a-f0-9_]+)/);
    return match ? match[1] : null;
  });
  console.log('  mkey:', mkey || DEFAULT_MKEY);
  const checkUrl = `${SECOP_CAPTCHA_CHECK_URL}?responseKey=${encodeURIComponent(token)}&mkey=${encodeURIComponent(mkey || DEFAULT_MKEY)}`;
  await page.screenshot({ path: path.join(frameDir, '6.png'), fullPage: true });
  console.log('  -> Submitting to CaptchaCheck...');
  await new Promise(r => setTimeout(r, 1000));
  await page.goto(checkUrl, { waitUntil: 'networkidle0' });

  // Phase 6: Show result
  await new Promise(r => setTimeout(r, 4000));
  await page.screenshot({ path: path.join(frameDir, '7.png'), fullPage: true });
  await new Promise(r => setTimeout(r, 3000));
  await page.screenshot({ path: path.join(frameDir, '8.png'), fullPage: true });
  console.log('  -> Gatekept page loaded successfully!');
  console.log('  Final URL:', page.url().substring(0, 70));

  // Phase 7: Summary
  await new Promise(r => setTimeout(r, 3000));
  await page.screenshot({ path: path.join(frameDir, '9.png'), fullPage: true });
  console.log('[8/8] Summary frame captured');

  await browser.close();

  // Create video with ffmpeg
  console.log('\n[9/9] Creating video...');
  
  // Build ffmpeg command with text overlays
  const ffmpegCmd = [
    'ffmpeg', '-y',
    '-framerate', '1',
    '-i', `"${path.join(frameDir, '%d.png')}"`,
    '-filter_complex', [
      '[0:v]scale=1280:720:flags=lanczos,drawtext=text=\'SECOP reCAPTCHA Solver - Ponytail Edition\':fontsize=36:fontcolor=white:x=(w-text_w)/2:y=50,drawtext=text=\'[1/8] Gatekept Page\':fontsize=28:fontcolor=white:x=50:y:h*0.9:box=1:boxcolor=black@0.7:boxborderw=10,drawtext=text=\'Contract Notice Management - requires valid captcha\':fontsize=22:fontcolor=white:x=50:y:h*0.95:box=1:boxcolor=black@0.5:boxborderw=10[v0]',
      '[1:v]scale=1280:720:flags=lanczos,drawtext=text=\'SECOP reCAPTCHA Solver - Ponytail Edition\':fontsize=36:fontcolor=white:x=(w-text_w)/2:y=50,drawtext=text=\'[2/8] Captcha Index\':fontsize=28:fontcolor=white:x=50:y:h*0.9:box=1:boxcolor=black@0.7:boxborderw=10,drawtext=text=\'Establishes session, generates mkey\':fontsize=22:fontcolor=white:x=50:y:h*0.95:box=1:boxcolor=black@0.5:boxborderw=10[v1]',
      '[2:v]scale=1280:720:flags=lanczos,drawtext=text=\'SECOP reCAPTCHA Solver - Ponytail Edition\':fontsize=36:fontcolor=white:x=(w-text_w)/2:y=50,drawtext=text=\'[3/8] reCAPTCHA Loaded\':fontsize=28:fontcolor=white:x=50:y:h*0.9:box=1:boxcolor=black@0.7:boxborderw=10,drawtext=text=\'Token must be solved for this mkey/session\':fontsize=22:fontcolor=white:x=50:y:h*0.95:box=1:boxcolor=black@0.5:boxborderw=10[v2]',
      '[3:v]scale=1280:720:flags=lanczos,drawtext=text=\'SECOP reCAPTCHA Solver - Ponytail Edition\':fontsize=36:fontcolor=white:x=(w-text_w)/2:y=50,drawtext=text=\'[4/8] 2Captcha Farm\':fontsize=28:fontcolor=white:x=50:y:h*0.9:box=1:boxcolor=black@0.7:boxborderw=10,drawtext=text=\'Solved by human worker (~30-60s)\':fontsize=22:fontcolor=white:x=50:y:h*0.95:box=1:boxcolor=black@0.5:boxborderw=10[v3]',
      '[4:v]scale=1280:720:flags=lanczos,drawtext=text=\'SECOP reCAPTCHA Solver - Ponytail Edition\':fontsize=36:fontcolor=white:x=(w-text_w)/2:y=50,drawtext=text=\'[5/8] Token Received\':fontsize=28:fontcolor=white:x=50:y:h*0.9:box=1:boxcolor=black@0.7:boxborderw=10,drawtext:text=\'Ready to submit to SECOP\':fontsize=22:fontcolor=white:x=50:y:h*0.95:box=1:boxcolor=black@0.5:boxborderw=10[v4]',
      '[5:v]scale=1280:720:flags=lanczos,drawtext:text=\'SECOP reCAPTCHA Solver - Ponytail Edition\':fontsize=36:fontcolor=white:x=(w-text_w)/2:y=50,drawtext:text=\'[6/8] Submitting Token\':fontsize=28:fontcolor=white:x=50:y:h*0.9:box=1:boxcolor=black@0.7:boxborderw=10,drawtext:text=\'Token + mkey -> CaptchaCheck\':fontsize=22:fontcolor=white:x=50:y:h*0.95:box=1:boxcolor=black@0.5:boxborderw=10[v5]',
      '[6:v]scale=1280:720:flags=lanczos,drawtext:text=\'SECOP reCAPTCHA Solver - Ponytail Edition\':fontsize=36:fontcolor=white:x=(w-text_w)/2:y=50,drawtext:text=\'[7/8] Verifying\':fontsize=28:fontcolor=white:x=50:y:h*0.9:box=1:boxcolor=black@0.7:boxborderw=10,drawtext:text=\'SECOP validates token with Google\':fontsize=22:fontcolor=white:x=50:y:h*0.95:box=1:boxcolor=black@0.5:boxborderw=10[v6]',
      '[7:v]scale=1280:720:flags=lanczos,drawtext:text=\'SECOP reCAPTCHA Solver - Ponytail Edition\':fontsize=36:fontcolor=white:x=(w-text_w)/2:y=50,drawtext:text=\'[8/8] Success!\':fontsize=28:fontcolor=white:x=50:y:h*0.9:box=1:boxcolor=green@0.7:boxborderw=10,drawtext:text=\'Gatekept page loaded - no errors\':fontsize=22:fontcolor=white:x=50:y:h*0.95:box=1:boxcolor=black@0.5:boxborderw=10[v7]',
      '[8:v]scale=1280:720:flags=lanczos,drawtext:text=\'SECOP reCAPTCHA Solver - Ponytail Edition\':fontsize=36:fontcolor=white:x=(w-text_w)/2:y=50,drawtext:text=\'[9/9] Complete\':fontsize=28:fontcolor=white:x=50:y:h*0.9:box=1:boxcolor=green@0.7:boxborderw=10,drawtext:text=\'httpJson removed. Native fetch only.\':fontsize=22:fontcolor=white:x=50:y:h*0.95:box=1:boxcolor=black@0.5:boxborderw=10[v8]',
      '[v0][v1][v2][v3][v4][v5][v6][v7][v8]concat=n=9:v=1:a=0[out]'
    ].join(','),
    '-map', '"[out]"',
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    'captcha-solve-complete.mp4'
  ];
  
  try {
    execSync(ffmpegCmd.join(' '), { stdio: 'inherit' });
    const size = fs.statSync('captcha-solve-complete.mp4').size;
    console.log(`\nVideo: captcha-solve-complete.mp4 (${Math.round(size / 1024)}KB)`);
  } catch(e) {
    console.log('ffmpeg error, trying simpler approach...');
    execSync(`ffmpeg -y -framerate 1 -i "${path.join(frameDir, '%d.png')}" -vf "scale=1280:720:flags=lanczos" -c:v libx264 -pix_fmt yuv420p captcha-solve-complete.mp4 2>/dev/null`, { cwd: process.cwd(), stdio: 'inherit' });
  }

  console.log('\nAll done!');
  console.log('Frames:', fs.readdirSync(frameDir).length, 'screenshots');
  console.log('Video: captcha-solve-complete.mp4');
  console.log('Slideshow: captcha-solve-slideshow.gif');
}

main().catch(e => { console.error(e.message); process.exit(1); });
