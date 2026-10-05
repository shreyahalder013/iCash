const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');

const defaultDirs = [
  path.join(rootDir, 'dist'),
  path.join(rootDir, 'build'),
  path.join(rootDir, '.next'),
  path.join(rootDir, 'coverage'),
  path.join(rootDir, 'backend', 'coverage'),
];

function removeDirectory(dirPath) {
  if (fs.existsSync(dirPath)) {
    try {
      fs.rmSync(dirPath, { recursive: true, force: true });
      console.log(`🗑️  Removed: ${path.relative(rootDir, dirPath) || dirPath}`);
    } catch (err) {
      console.warn(`⚠️  Could not remove ${dirPath}:`, err.message);
    }
  }
}

function cleanPycache(dir) {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__pycache__' || entry.name === '.pytest_cache') {
        removeDirectory(fullPath);
      } else if (entry.name !== 'node_modules' && entry.name !== '.git') {
        cleanPycache(fullPath);
      }
    } else if (entry.name.endsWith('.pyc') || entry.name.endsWith('.pyo')) {
      try {
        fs.unlinkSync(fullPath);
        console.log(`🗑️  Removed file: ${path.relative(rootDir, fullPath)}`);
      } catch (e) {
        // ignore
      }
    }
  }
}

console.log('🧹 Cleaning project build artifacts and caches...');

// 1. Remove standard build output directories
for (const dir of defaultDirs) {
  removeDirectory(dir);
}

// 2. Remove Python caches recursively
cleanPycache(rootDir);

// 3. Optional --all flag for node_modules
if (process.argv.includes('--all')) {
  console.log('🧹 Cleaning node_modules...');
  removeDirectory(path.join(rootDir, 'node_modules'));
  removeDirectory(path.join(rootDir, 'backend', 'node_modules'));
}

console.log('✨ Cleanup complete.');
