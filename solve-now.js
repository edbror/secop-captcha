#!/usr/bin/env node
require('dotenv').config();
const { solve, SITE_KEY, checkWithSecopBrowser } = require('./src/solver-ponytail');

async function main() {
  console.log('Solving reCAPTCHA...');
  console.log('Site key:', SITE_KEY);
  console.log('Farm: 2Captcha');
  
  const token = await solve(SITE_KEY, '2captcha');
  console.log('\nToken received:', token.substring(0, 60) + '...');
  console.log('Token length:', token.length);
  
  console.log('\nChecking with SECOP (browser-based)...');
  const result = await checkWithSecopBrowser(token);
  console.log('Success:', result.success);
  console.log('Status:', result.status);
  console.log('Final URL:', result.finalUrl.substring(0, 200));
  console.log('Body:', result.body.substring(0, 300));
}

main().catch(e => {
  console.error('Error:', e.message);
  console.error(e.stack);
  process.exit(1);
});
