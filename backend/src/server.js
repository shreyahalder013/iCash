const path = require('path');
try {
  const dotenv = require('dotenv');
  const isTestEnv = process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID !== undefined;
  // Load local env files without overriding environment variables already set by the deployment host
  dotenv.config({ path: path.join(__dirname, '..', '.env') });
  dotenv.config();
  if (isTestEnv) {
    process.env.NODE_ENV = 'test';
  }
} catch (e) {
  // dotenv optional in production where process.env is injected by host
}

// Fallback: If DATABASE_URL is defined but DIRECT_URL is missing, default DIRECT_URL to DATABASE_URL
if (process.env.DATABASE_URL && !process.env.DIRECT_URL) {
  process.env.DIRECT_URL = process.env.DATABASE_URL;
}

const express = require('express');
const crypto = require('crypto');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');

const { errorHandler, notFoundHandler } = require('./middleware/errorMiddleware');
const { generalApiLimiter } = require('./middleware/rateLimitMiddleware');
const { registerRoutes } = require('./routes');

const app = express();
const PORT = Number(process.env.PORT) || 4000;
const FRONTEND_DIR = path.join(__dirname, '..', '..', 'frontend');

// Disable server fingerprinting
app.disable('x-powered-by');

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrcAttr: ["'unsafe-inline'"],
        scriptSrc: [
          "'self'",
          "'unsafe-inline'",
          "'unsafe-hashes'",
          "'wasm-unsafe-eval'",
          'https://cdn.jsdelivr.net',
          'https://*.cloud.appwrite.io',
          'https://sfo.cloud.appwrite.io',
          'https://nyc.cloud.appwrite.io',
        ],
        styleSrc: [
          "'self'",
          "'unsafe-inline'",
          'https://fonts.googleapis.com',
          'https://cdn.jsdelivr.net',
        ],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
        imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
        connectSrc: [
          "'self'",
          'http://localhost:*',
          'http://127.0.0.1:*',
          'https://*.cloud.appwrite.io',
          'https://sfo.cloud.appwrite.io',
          'https://nyc.cloud.appwrite.io',
          'https://cdn.jsdelivr.net',
          'https:',
          'ws:',
          'wss:',
        ],
        mediaSrc: ["'self'", 'blob:', 'data:'],
        objectSrc: ["'none'"],
        frameSrc: ["'none'"],
        workerSrc: ["'self'", 'blob:'],
        upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null,
      },
    },
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true,
    },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  })
);

// Explicit Security & Permissions Headers & Server Cloaking
app.use((req, res, next) => {
  res.setHeader(
    'Permissions-Policy',
    'camera=(self), microphone=(self), geolocation=(), payment=(self), interest-cohort=()'
  );
  res.removeHeader('Server');
  res.removeHeader('X-Powered-By');

  // Request ID / Correlation ID tracing
  const requestId = req.headers['x-request-id'] || (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()));
  req.id = requestId;
  res.setHeader('X-Request-ID', requestId);

  next();
});

app.use(
  cors({
    origin(origin, callback) {
      const configured = (process.env.CORS_ORIGIN || process.env.CORS_ORIGINS || '')
        .split(',')
        .map((value) => value.trim().replace(/^["']|["']$/g, '').replace(/\/+$/, ''))
        .filter(Boolean);

      const defaults = [
        'https://icash.onrender.com',
        'https://icash-server.onrender.com',
        ...(process.env.RENDER_EXTERNAL_URL
          ? [process.env.RENDER_EXTERNAL_URL.trim().replace(/^["']|["']$/g, '').replace(/\/+$/, '')]
          : []),
        ...(process.env.NODE_ENV === 'production'
          ? []
          : [
              'http://localhost:3000',
              'http://localhost:4000',
              'http://localhost:4001',
              'http://localhost:4002',
              'http://localhost:5173',
              'http://localhost:5500',
              'http://localhost:8080',
              'http://127.0.0.1:3000',
              'http://127.0.0.1:4000',
              'http://127.0.0.1:4001',
              'http://127.0.0.1:4002',
              'http://127.0.0.1:5173',
              'http://127.0.0.1:5500',
              'http://127.0.0.1:8080',
            ]),
      ];

      const allowed = Array.from(new Set([...configured, ...defaults]));

      // Non-browser clients do not send Origin and remain supported.
      if (!origin) {
        return callback(null, true);
      }

      const normalizedOrigin = origin.trim().replace(/\/+$/, '').toLowerCase();
      const normalizedAllowed = allowed.map((url) => url.trim().replace(/\/+$/, '').toLowerCase());

      if (normalizedAllowed.includes('*') || normalizedAllowed.includes(normalizedOrigin)) {
        return callback(null, true);
      }

      // Allow wildcard patterns like https://*.onrender.com if configured
      const matchesWildcard = allowed.some((pattern) => {
        if (!pattern.includes('*')) return false;
        const regexStr =
          '^' + pattern.trim().replace(/\/+$/, '').replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$';
        try {
          return new RegExp(regexStr, 'i').test(normalizedOrigin);
        } catch {
          return false;
        }
      });
      if (matchesWildcard) {
        return callback(null, true);
      }

      // Automatically allow any icash*.onrender.com deployments
      if (/^https:\/\/(icash|icash-[a-z0-9-]+)\.onrender\.com$/i.test(normalizedOrigin)) {
        return callback(null, true);
      }

      // In development, allow any localhost / 127.0.0.1 port automatically
      if (
        process.env.NODE_ENV !== 'production' &&
        /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(normalizedOrigin)
      ) {
        return callback(null, true);
      }

      return callback(new Error(`Origin ${origin} is not allowed by CORS`));
    },
    credentials: true,
  })
);

app.use(cookieParser());
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));
app.use(generalApiLimiter);

let lastDbCheck = 0;
let cachedDbStatus = 'connected';
let dbCheckInProgress = false;
let dbLoggedWarning = false;

async function refreshDbHealth() {
  if (dbCheckInProgress) return;
  dbCheckInProgress = true;
  try {
    const prisma = require('./prisma');
    await prisma.$queryRaw`SELECT 1`;
    cachedDbStatus = 'connected';
    dbLoggedWarning = false;
  } catch (e) {
    cachedDbStatus = `unreachable (${e.code || e.message || 'error'})`;
    if (!dbLoggedWarning) {
      dbLoggedWarning = true;
      const rawUrl = process.env.DATABASE_URL || '';
      const hostMatch = rawUrl.match(/@([^/:?]+)(?::(\d+))?/);
      const host = hostMatch ? hostMatch[1] : 'unknown';
      const port = hostMatch && hostMatch[2] ? hostMatch[2] : '5432';
      console.warn(`\n⚠️  [Database Warning] Unable to reach PostgreSQL at \`${host}:${port}\`: ${e.message}`);
      if (host.startsWith('dpg-') && !host.includes('.')) {
        console.warn(`💡 Render Guidance:
   Host "${host}" is a Render Internal Database hostname.
   1. Internal hostnames ONLY work if your Web Service and Database are in the SAME Render region.
   2. If they are in different regions, or if connecting externally, use Render's External Database URL
      (e.g., postgresql://user:password@${host}.oregon-postgres.render.com/dbname?sslmode=require).
   3. Or set your Render DATABASE_URL environment variable to your active Supabase connection string.`);
      }
      console.warn('');
    }
  } finally {
    lastDbCheck = Date.now();
    dbCheckInProgress = false;
  }
}

// Initial background check on startup
refreshDbHealth().catch(() => {});

// Health check — used by frontend/api.js to auto-detect the API base URL and check DB health.
app.get('/api/health', (req, res) => {
  if (Date.now() - lastDbCheck > 30000) {
    refreshDbHealth().catch(() => {});
  }
  res.json({
    ok: true,
    service: 'icash-backend',
    database: cachedDbStatus,
    time: new Date().toISOString(),
  });
});

registerRoutes(app);

// Any unmatched /api/* route is a genuine 404, not the SPA fallback.
app.use('/api', notFoundHandler);

// Serve the static frontend (index.html, script.js, style.css, api.js).
app.use(express.static(FRONTEND_DIR));

// SPA fallback for any other non-API route.
app.get('*', (req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
});

app.use(errorHandler);

// Universal entrypoint: supports standalone Node execution, Express middleware, and Appwrite Functions
async function handler(contextOrReq, res, next) {
  // 1. Appwrite Function Context: { req, res, log, error }
  const isAppwriteContext =
    contextOrReq &&
    contextOrReq.req &&
    contextOrReq.res &&
    (typeof contextOrReq.res.json === 'function' ||
      typeof contextOrReq.res.send === 'function' ||
      typeof contextOrReq.res.text === 'function' ||
      typeof contextOrReq.res.empty === 'function');

  if (isAppwriteContext) {
    const { req: appwriteReq, res: appwriteRes, log, error } = contextOrReq;
    const reqPath = appwriteReq.path || '/';

    const sendResponse = (body, status = 200, headers = {}) => {
      if (typeof appwriteRes.send === 'function') {
        return appwriteRes.send(body, status, headers);
      }
      if (typeof appwriteRes.text === 'function' && typeof body === 'string') {
        return appwriteRes.text(body, status, headers);
      }
      if (typeof appwriteRes.json === 'function') {
        return appwriteRes.json(typeof body === 'string' ? { content: body } : body, status, headers);
      }
    };

    // Health check
    if (reqPath === '/api/health' || reqPath === '/health') {
      return typeof appwriteRes.json === 'function'
        ? appwriteRes.json({
            ok: true,
            service: 'icash-backend',
            mode: 'appwrite-function',
            time: new Date().toISOString(),
          })
        : sendResponse('OK', 200);
    }

    // Static assets serving for Appwrite Function
    if (!reqPath.startsWith('/api')) {
      const fs = require('fs');
      const target = reqPath === '/' ? 'index.html' : reqPath.replace(/^\//, '');
      const filePath = path.join(FRONTEND_DIR, target);

      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath).toLowerCase();
        const mimeTypes = {
          '.html': 'text/html; charset=utf-8',
          '.js': 'application/javascript; charset=utf-8',
          '.css': 'text/css; charset=utf-8',
          '.json': 'application/json; charset=utf-8',
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.svg': 'image/svg+xml',
          '.bin': 'application/octet-stream',
        };
        const mime = mimeTypes[ext] || 'text/plain';
        const isBinary = ext.match(/\.(png|jpg|jpeg|ico|bin|shard\d+)$/);
        const data = fs.readFileSync(filePath, isBinary ? null : 'utf8');
        return sendResponse(data, 200, { 'Content-Type': mime });
      }

      // SPA index fallback
      const indexPath = path.join(FRONTEND_DIR, 'index.html');
      if (fs.existsSync(indexPath)) {
        return sendResponse(fs.readFileSync(indexPath, 'utf8'), 200, {
          'Content-Type': 'text/html; charset=utf-8',
        });
      }
    }

    // Default API response
    return typeof appwriteRes.json === 'function'
      ? appwriteRes.json({
          ok: true,
          service: 'icash-backend',
          message: 'iCash API active on Appwrite Open-Runtimes',
          path: reqPath,
        })
      : sendResponse('iCash API Active', 200);
  }

  // 2. Standard Express middleware / server request
  return app(contextOrReq, res, next);
}

// Attach Express properties onto handler
Object.setPrototypeOf(handler, app);

function autoSyncDatabase() {
  if (process.env.AUTO_SYNC_DB !== 'true') {
    return;
  }
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl || dbUrl.includes('localhost:5432')) {
    return;
  }
  try {
    const { exec } = require('child_process');
    console.log('🔄 Checking database schema with Prisma db push (non-blocking)...');
    const prismaBin = path.join(__dirname, '..', '..', 'node_modules', '.bin', process.platform === 'win32' ? 'prisma.cmd' : 'prisma');
    const cmd = require('fs').existsSync(prismaBin)
      ? `"${prismaBin}" db push --schema=backend/prisma/schema.prisma --skip-generate`
      : 'npx --no-install prisma db push --schema=backend/prisma/schema.prisma --skip-generate';
    exec(cmd, { env: process.env, timeout: 30000 }, (err) => {
      if (err) {
        console.warn('⚠️  Database schema sync note:', err.message);
      } else {
        console.log('✅ Database schema synchronized.');
      }
    });
  } catch (err) {
    console.warn('⚠️  Database schema sync note:', err.message);
  }
}

function ensureLivenessServerRunning() {
  if (process.env.NODE_ENV === 'production') return;
  const http = require('http');
  const req = http.get('http://127.0.0.1:5001/health', () => {});
  req.on('error', () => {
    const pythonExe = process.platform === 'win32'
      ? path.join(__dirname, '..', '..', '.venv', 'Scripts', 'python.exe')
      : path.join(__dirname, '..', '..', '.venv', 'bin', 'python');
    const fs = require('fs');
    const cmd = fs.existsSync(pythonExe) ? pythonExe : 'python';
    const appPath = path.join(__dirname, '..', '..', 'liveness_server', 'app.py');
    try {
      const { spawn } = require('child_process');
      const p = spawn(cmd, [appPath], {
        stdio: 'ignore',
        detached: true,
      });
      p.unref();
      console.log('[iCash] Started local Python liveness service on port 5001');
    } catch (err) {
      console.warn('[iCash] Could not auto-spawn liveness service:', err.message);
    }
  });
}

function startServer(port) {
  const server = app.listen(port, () => {
    console.log(`\n=======================================================`);
    console.log(`🚀 iCash Full-Stack Banking Backend running on: http://localhost:${port}`);
    console.log(`🔒 Security: Argon2/Bcrypt + HTTP-Only Session Cookies`);
    console.log(`🗄️  Database: PostgreSQL with Prisma ORM`);
    console.log(`👁️  Biometrics: Facial Feature Vector Verification Gate`);
    console.log(`=======================================================\n`);

    // Auto sync schema if cloud database is configured
    setTimeout(autoSyncDatabase, 1500);
    // Ensure liveness service is active in dev
    setTimeout(ensureLivenessServerRunning, 1000);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`Port ${port} is in use, attempting ${port + 1}...`);
      startServer(port + 1);
    } else {
      console.error('Server error:', err);
    }
  });

  return server;
}

if (require.main === module) {
  startServer(PORT);
}

module.exports = handler;
module.exports.app = app;
module.exports.default = handler;
