#!/usr/bin/env node
/* =========================================================
   ICASH — MediaPipe folder checker
   Verifies that the MediaPipe Face Mesh files are CSP-compliant
   and all required files are present.
   ========================================================= */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REQUIRED_FILES = [
  'face_mesh.js',
  'face_mesh.binarypb',
  'face_mesh_solution_wasm_bin.js',
  'face_mesh_solution_wasm_bin.wasm',
  'face_mesh_solution_simd_wasm_bin.js',
  'face_mesh_solution_simd_wasm_bin.wasm',
  'face_mesh_solution_packed_assets.data',
  'face_mesh_solution_packed_assets_loader.js'
];

const FORBIDDEN_PATTERNS = [
  { pattern: /new Function/, name: 'new Function' },
  { pattern: /new_\(Function/, name: 'new_(Function' },
  // The Python patch script incorrectly replaced new_(Function,...) with Function.apply(null,...)
  // which is STILL eval-style code (Function() builds from strings whether called with new or not)
  { pattern: /Function\.apply\(null, args1Local\)/, name: 'Function.apply(null, args1Local) [python-patch-remnant]' },
  { pattern: /Function\.apply\(null, paramsLocal\)/, name: 'Function.apply(null, paramsLocal) [python-patch-remnant]' },
];

function checkFile(filePath, relPath) {
  const results = { missing: false, forbidden: [], size: 0 };
  
  if (!fs.existsSync(filePath)) {
    results.missing = true;
    return results;
  }
  
  const stats = fs.statSync(filePath);
  results.size = stats.size;
  
  // Only check JS files for forbidden patterns
  if (filePath.endsWith('.js')) {
    const content = fs.readFileSync(filePath, 'utf8');
    for (const { pattern, name } of FORBIDDEN_PATTERNS) {
      if (pattern.test(content)) {
        results.forbidden.push(name);
      }
    }
  }
  
  return results;
}

function checkFolder(folderPath) {
  console.log(`\nChecking: ${folderPath}\n`);
  console.log('File                    | Size      | Status');
  console.log('------------------------|-----------|------------------');
  
  let allGood = true;
  const missingFiles = [];
  const forbiddenFiles = [];
  
  for (const file of REQUIRED_FILES) {
    const filePath = path.join(folderPath, file);
    const results = checkFile(filePath, file);
    
    let status = 'OK';
    if (results.missing) {
      status = 'MISSING';
      missingFiles.push(file);
      allGood = false;
    } else if (results.forbidden.length > 0) {
      status = `FORBIDDEN: ${results.forbidden.join(', ')}`;
      forbiddenFiles.push({ file, patterns: results.forbidden });
      allGood = false;
    }
    
    const sizeStr = results.missing ? 'N/A' : formatSize(results.size);
    console.log(`${file.padEnd(24)} | ${sizeStr.padStart(9)} | ${status}`);
  }
  
  console.log('');
  if (allGood) {
    console.log('✓ All good - CSP compliant and all files present');
    return true;
  } else {
    if (missingFiles.length > 0) {
      console.log('✗ Missing files:', missingFiles.join(', '));
    }
    if (forbiddenFiles.length > 0) {
      console.log('✗ Files with forbidden patterns:');
      for (const { file, patterns } of forbiddenFiles) {
        console.log(`    ${file}: ${patterns.join(', ')}`);
      }
    }
    return false;
  }
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Main
const folders = process.argv.slice(2);
if (folders.length === 0) {
  console.log('Usage: node check-mediapipe-folder.js <folder> [folder2...]');
  console.log('Example: node check-mediapipe-folder.js public/vendor/mediapipe models/face_mesh');
  process.exit(1);
}

let overallSuccess = true;
for (const folder of folders) {
  const fullPath = path.resolve(folder);
  if (!fs.existsSync(fullPath)) {
    console.log(`Folder not found: ${fullPath}`);
    overallSuccess = false;
    continue;
  }
  const success = checkFolder(fullPath);
  overallSuccess = overallSuccess && success;
}

if (overallSuccess) {
  console.log('\n✓ All folders passed!');
  process.exit(0);
} else {
  console.log('\n✗ Some checks failed');
  process.exit(1);
}