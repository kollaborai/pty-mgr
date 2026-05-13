#!/usr/bin/env node

// Syncs the version from the root package.json to all platform packages
// and updates optionalDependencies to match.

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const rootPkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const version = rootPkg.version;

const platforms = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"];
const platformPackage = platform => `@mentiko/pty-mgr-${platform}`;

for (const platform of platforms) {
  const pkgPath = path.join(root, "npm", platform, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  pkg.name = platformPackage(platform);
  pkg.version = version;
  delete pkg.bin;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  console.log(`  ${platform} -> ${version}`);
}

// update optionalDependencies in root
rootPkg.optionalDependencies = {};
for (const platform of platforms) {
  rootPkg.optionalDependencies[platformPackage(platform)] = version;
}
fs.writeFileSync(
  path.join(root, "package.json"),
  JSON.stringify(rootPkg, null, 2) + "\n"
);

// update VERSION in lib/pty-manager.mjs
const libPath = path.join(root, "lib", "pty-manager.mjs");
const lib = fs.readFileSync(libPath, "utf8");
const updated = lib.replace(
  /export const VERSION = "[^"]+";/,
  `export const VERSION = "${version}";`
);
if (updated !== lib) {
  fs.writeFileSync(libPath, updated);
  console.log(`  lib/pty-manager.mjs -> ${version}`);
}

console.log(`\nall packages synced to v${version}`);
