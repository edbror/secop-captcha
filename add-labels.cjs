const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const frames = fs.readdirSync('frames').sort().map(f => path.join('frames', f));
const labels = [
  'SECOP reCAPTCHA Solver — Ponytail Edition\n[1/9] Gatekept Page\nContract Notice Management Index\nNo captcha solved yet'
];

// We'll create a simple concat file for ffmpeg
const lines = frames.map((f, i) => `file '${f}'`);
fs.writeFileSync('concat.txt', lines.join('\n'));
console.log('Created concat.txt with', lines.length, 'frames');
