#!/usr/bin/env node
const { execSync } = require('child_process');
const { readFileSync } = require('fs');
const pkg = JSON.parse(readFileSync('./package.json'));
const version = JSON.stringify(pkg.version);

const targets = [
  ['--target', 'bun-linux-x64', '--outfile', 'dist/pty-mgr-linux-x64'],
  ['--target', 'bun-linux-arm64', '--outfile', 'dist/pty-mgr-linux-arm64'],
  ['--target', 'bun-darwin-x64', '--outfile', 'dist/pty-mgr-darwin-x64'],
  ['--target', 'bun-darwin-arm64', '--outfile', 'dist/pty-mgr-darwin-arm64'],
];

// single build (current platform)
if (process.argv.includes('--all')) {
  for (const [target, arch, , outfile] of targets) {
    console.log(`building ${outfile}...`);
    execSync(`bun build bin/pty-mgr.mjs --compile --define:VERSION=${version} ${target} --arch ${arch.split('-')[1]} ${outfile}`, { stdio: 'inherit' });
  }
} else {
  execSync(`bun build bin/pty-mgr.mjs --compile --define:VERSION=${version} --outfile dist/pty-mgr`, { stdio: 'inherit' });
}
