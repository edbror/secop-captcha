require('dotenv').config();
const { solve, SITE_KEY, checkWithSecopBrowser } = require('./src/solver-ponytail');

async function main() {
  console.log('[1/3] Solving via 2Captcha...');
  const token = await solve(SITE_KEY, '2captcha');
  console.log('  Token:', token.substring(0, 50) + '...');
  
  console.log('\n[2/3] Verifying with SECOP...');
  const result = await checkWithSecopBrowser(token);
  console.log('  Success:', result.success);
  console.log('  Status:', result.status);
  console.log('  Final URL:', result.finalUrl.substring(0, 150));
  
  console.log('\n[3/3] Navigating to gatekept page...');
}

main().catch(e => { console.error(e.message); process.exit(1); });
