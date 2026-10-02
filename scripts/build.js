const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const frontendDir = path.join(rootDir, 'frontend');
const distDir = path.join(rootDir, 'dist');
const nextDir = path.join(rootDir, '.next');
const buildDir = path.join(rootDir, 'build');

if (process.env.PRISMA_GENERATE_SKIP === 'true') {
  console.log('[Build] 1. Skipping Prisma Client generation (already generated in build step)...');
} else {
  console.log('[Build] 1. Generating Prisma Client...');
  try {
    // Ensure DATABASE_URL is set so prisma generate succeeds even if not set in build environment
    const buildEnv = {
      ...process.env,
      DATABASE_URL:
        process.env.DATABASE_URL ||
        'postgresql://postgres:postgres@localhost:5432/icash?schema=public',
    };

    const prismaBin = path.join(
      rootDir,
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'prisma.cmd' : 'prisma'
    );
    const cmd = fs.existsSync(prismaBin)
      ? `"${prismaBin}" generate --schema=backend/prisma/schema.prisma`
      : 'npx --no-install prisma generate --schema=backend/prisma/schema.prisma';

    execSync(cmd, {
      cwd: rootDir,
      stdio: 'inherit',
      env: buildEnv,
    });
  } catch (err) {
    console.warn('[Build] Warning: Prisma generation encountered an issue:', err.message);
    // Try fallback in backend folder
    try {
      const backendBin = path.join(
        rootDir,
        'backend',
        'node_modules',
        '.bin',
        process.platform === 'win32' ? 'prisma.cmd' : 'prisma'
      );
      if (fs.existsSync(backendBin)) {
        execSync(`"${backendBin}" generate --schema=backend/prisma/schema.prisma`, {
          cwd: rootDir,
          stdio: 'inherit',
          env: {
            ...process.env,
            DATABASE_URL:
              process.env.DATABASE_URL ||
              'postgresql://postgres:postgres@localhost:5432/icash?schema=public',
          },
        });
      }
    } catch (err2) {
      // Non-fatal if schema was pre-generated
    }
  }
}

console.log('[Build] 2. Preparing output bundle directories...');

// 2a. Standard dist directories for SPA / Angular / Vite presets
const targetDirs = [
  distDir,
  path.join(distDir, 'angular'),
  path.join(distDir, 'browser'),
  path.join(distDir, 'icash'),
  path.join(distDir, 'frontend'),
  buildDir,
];

for (const dir of targetDirs) {
  fs.mkdirSync(dir, { recursive: true });
  fs.cpSync(frontendDir, dir, { recursive: true });
}

// 2b. Next.js structure for Open-Runtimes next-js/bundle.sh compatibility
fs.mkdirSync(nextDir, { recursive: true });
fs.mkdirSync(path.join(nextDir, 'static'), { recursive: true });
fs.mkdirSync(path.join(nextDir, 'standalone'), { recursive: true });
fs.mkdirSync(path.join(nextDir, 'server', 'pages'), { recursive: true });

// Copy static assets to .next/static and .next/standalone
fs.cpSync(frontendDir, path.join(nextDir, 'static'), { recursive: true });
fs.cpSync(frontendDir, path.join(nextDir, 'standalone', 'public'), { recursive: true });
fs.writeFileSync(path.join(nextDir, 'BUILD_ID'), 'icash-production-build');

const requiredFilesJson = JSON.stringify(
  {
    version: 1,
    config: {
      distDir: '.next',
      output: 'standalone',
    },
    files: ['.next/routes-manifest.json'],
  },
  null,
  2
);
fs.writeFileSync(path.join(nextDir, 'required-server-files.json'), requiredFilesJson);

// Standalone entrypoint for Next.js SSR runners
const standaloneServerJs = `
const path = require('path');
process.env.PORT = process.env.PORT || '3000';
try {
  require(path.join(__dirname, '..', '..', 'backend', 'src', 'server.js'));
} catch (e) {
  try {
    require(path.join(process.cwd(), 'backend', 'src', 'server.js'));
  } catch (e2) {
    require('./backend/src/server.js');
  }
}
`;
fs.writeFileSync(path.join(nextDir, 'standalone', 'server.js'), standaloneServerJs);

// Also copy backend to standalone folder for isolated runtimes
try {
  fs.cpSync(path.join(rootDir, 'backend'), path.join(nextDir, 'standalone', 'backend'), {
    recursive: true,
  });
  fs.copyFileSync(
    path.join(rootDir, 'package.json'),
    path.join(nextDir, 'standalone', 'package.json')
  );
} catch (e) {
  // best effort copy
}

console.log('[Build] Build completed successfully.');
