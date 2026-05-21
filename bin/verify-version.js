#!/usr/bin/env node
/**
 * Release Version Guardrail
 * Replicates Claude's version-bumping judgment rules.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// 1. Resolve paths
const rootDir = path.join(__dirname, '..');
const pkgPath = path.join(rootDir, 'package.json');
const targetPkgPath = path.join(rootDir, 'target', 'package.json');
const cargoPath = path.join(rootDir, 'sidecar', 'Cargo.toml');

// 2. Read current versions
const rootVersion = require(pkgPath).version;
let targetVersion = 'unknown';
if (fs.existsSync(targetPkgPath)) {
  targetVersion = require(targetPkgPath).version;
}
let cargoVersion = 'unknown';
if (fs.existsSync(cargoPath)) {
  const cargoContent = fs.readFileSync(cargoPath, 'utf8');
  const match = cargoContent.match(/^version\s*=\s*"([^"]+)"/m);
  if (match) cargoVersion = match[1];
}

console.log('=== Active Workspace Version Status ===');
console.log(`- root package.json:   v${rootVersion}`);
console.log(`- target package.json: v${targetVersion}`);
console.log(`- sidecar Cargo.toml:  v${cargoVersion}`);
console.log('=======================================');

// 3. Sync verification
const filesAreInSync = rootVersion === targetVersion && rootVersion === cargoVersion;
if (!filesAreInSync) {
  console.error('\n\x1b[31m[ERROR] Version files are out of sync!\x1b[0m');
  console.error('All files must match before compiling/publishing.');
  process.exit(1);
}

// 4. Git status & tag analysis
try {
  // Find last tag
  const lastTag = execSync('git tag --sort=-version:refname | head -n 1', { encoding: 'utf8' }).trim();
  if (!lastTag) {
    console.log('No git tags found. Proceeding with initial version.');
    process.exit(0);
  }

  // Get commits since last tag
  const commits = execSync(`git log ${lastTag}..HEAD --oneline`, { encoding: 'utf8' })
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  console.log(`\nLast released tag: \x1b[36m${lastTag}\x1b[0m`);
  console.log(`Commits since last tag: ${commits.length}`);

  if (commits.length === 0) {
    console.log('\n\x1b[32m[Rule 1] Local iteration detected.\x1b[0m No commits since last tag. No bump is needed.');
    process.exit(0);
  }

  // Analyze changes for SemVer
  let recommendsMinor = false;
  let recommendsPatch = false;

  for (const commit of commits) {
    if (/feat(\(.*?\))?:/.test(commit)) {
      recommendsMinor = true;
    } else if (/fix(\(.*?\))?:/.test(commit) || /refactor(\(.*?\))?:/.test(commit)) {
      recommendsPatch = true;
    }
  }

  const cleanLastTagVer = lastTag.replace(/^v/, '');
  
  if (cleanLastTagVer === rootVersion) {
    // We are attempting to build/publish under the exact same version as the last tag
    console.warn('\n\x1b[33m[WARNING] Immutability Violation Warning!\x1b[0m');
    console.warn(`You have made commits since ${lastTag}, but your files are still set to v${rootVersion}.`);
    console.warn('If you publish this, you will mutate a published version.');
    
    // Semver recommendation
    if (recommendsMinor) {
      console.log('\x1b[35m[Recommendation]\x1b[0m New features detected. Bump to \x1b[32mMinor\x1b[0m (e.g., v0.11.0).');
    } else if (recommendsPatch) {
      console.log('\x1b[35m[Recommendation]\x1b[0m Bug fixes detected. Bump to \x1b[32mPatch\x1b[0m (e.g., v0.10.9).');
    } else {
      console.log('\x1b[35m[Recommendation]\x1b[0m Commits detected. Consider a patch bump before releasing.');
    }
  } else {
    console.log('\x1b[32m[PASS]\x1b[0m Version successfully bumped from last release.');
  }

} catch (err) {
  console.error('Could not run Git analysis:', err.message);
}
