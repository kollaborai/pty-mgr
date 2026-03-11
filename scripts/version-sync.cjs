#!/usr/bin/env node

// Syncs the version from the root package.json to all platform packages
// and updates optionalDependencies to match.

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const rootPkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const version = rootPkg.version;

const platforms = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"];

for (const platform of platforms) {
  const pkgPath = path.join(root, "npm", platform, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  pkg.version = version;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  console.log(`  ${platform} -> ${version}`);
}

// update optionalDependencies in root
for (const platform of platforms) {
  rootPkg.optionalDependencies[`@pty-mgr/${platform}`] = version;
}
fs.writeFileSync(
  path.join(root, "package.json"),
  JSON.stringify(rootPkg, null, 2) + "\n"
);

console.log(`\nall packages synced to v${version}`);
