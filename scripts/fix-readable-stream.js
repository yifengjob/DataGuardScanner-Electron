#!/usr/bin/env node

/**
 * Fix readable-stream compatibility for electron-builder
 * Creates passthrough.js entry point for subpath imports
 */

const fs = require('fs');
const path = require('path');

// Try multiple possible locations for node_modules
const possiblePaths = [
  path.join(__dirname, '..', 'node_modules', 'readable-stream'),
  path.join(process.cwd(), 'node_modules', 'readable-stream'),
];

let readableStreamPath = null;
for (const p of possiblePaths) {
  if (fs.existsSync(p)) {
    readableStreamPath = p;
    break;
  }
}

if (!readableStreamPath) {
  console.log('readable-stream not found, skipping fix');
  process.exit(0);
}

const passthroughPath = path.join(readableStreamPath, 'passthrough.js');

// Check if readable-stream exists
if (!fs.existsSync(readableStreamPath)) {
  console.log('readable-stream not found, skipping fix');
  process.exit(0);
}

// Check if passthrough.js already exists
if (fs.existsSync(passthroughPath)) {
  console.log('passthrough.js already exists, skipping fix');
  process.exit(0);
}

// Create passthrough.js
const content = 'module.exports = require(\'./lib/_stream_passthrough.js\');\n';
fs.writeFileSync(passthroughPath, content);

console.log('✓ Created readable-stream/passthrough.js for compatibility');
