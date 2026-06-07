#!/usr/bin/env node
// VERSION is baked into the source literal by scripts/version-sync.cjs, so the
// build needs no --define (bun's --define can't replace a `const` declaration).
const { execSync } = require('child_process');

// matches the cross-compile commands in .github/workflows/release.yml
const targets = [
  ['bun-linux-x64', 'dist/pty-mgr-linux-x64'],
  ['bun-linux-arm64', 'dist/pty-mgr-linux-arm64'],
  ['bun-darwin-x64', 'dist/pty-mgr-darwin-x64'],
  ['bun-darwin-arm64', 'dist/pty-mgr-darwin-arm64'],
];

if (process.argv.includes('--all')) {
  // cross-compile every platform binary
  for (const [target, outfile] of targets) {
    console.log(`building ${outfile} (${target})...`);
    execSync(`bun build bin/pty-mgr.mjs --compile --target=${target} --outfile ${outfile}`, { stdio: 'inherit' });
  }
} else {
  // single build for the current platform
  execSync(`bun build bin/pty-mgr.mjs --compile --outfile dist/pty-mgr`, { stdio: 'inherit' });
}
