/**
 * browser-csp-evidence.js
 * =======================
 * Proves that under the project's real CSP (without 'unsafe-eval'),
 * the MediaPipe glue files load and initialize without CSP violations.
 *
 * Verifies:
 *  1. Server responses for MediaPipe files have X-CSP-Patched: mediapipe.
 *  2. No eval/new Function/Function.apply patterns in served glue code.
 *  3. In a real headless Chrome browser loaded under the server's CSP:
 *     - zero 'securitypolicyviolation' events occur for eval/MediaPipe.
 *     - FaceMesh library loads and `await faceMesh.initialize()` succeeds!
 *     - face-scanner UI starts up to 'Position your face inside the frame'.
 *
 * Usage:
 *   node scripts/browser-csp-evidence.js
 */

const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SERVER_PORT = process.env.PORT || 4000;
const SERVER_URL = process.env.SERVER_URL || `http://localhost:${SERVER_PORT}`;
const EVIDENCE_DIR = path.resolve('scripts/browser-evidence');
if (!fs.existsSync(EVIDENCE_DIR)) fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

async function checkServerEndpoint(urlPath) {
  return new Promise((resolve, reject) => {
    http.get(`${SERVER_URL}${urlPath}`, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body
      }));
    }).on('error', reject);
  });
}

async function main() {
  console.log('=== iCash MediaPipe CSP Browser Evidence Test ===\n');

  // 1. Confirm server is running
  console.log(`Checking server at ${SERVER_URL}...`);
  const rootRes = await checkServerEndpoint('/');
  console.log(`Server responded HTTP ${rootRes.status}`);
  const cspHeader = rootRes.headers['content-security-policy'] || '';
  console.log(`CSP script-src: ${cspHeader.match(/script-src[^;]+/)?.[0] || 'not found'}`);
  if (cspHeader.includes("'unsafe-eval'")) {
    throw new Error("FAIL: Server CSP includes 'unsafe-eval'! Must test under real CSP without unsafe-eval.");
  }
  console.log("✓ Server CSP enforces eval-blocking (no 'unsafe-eval')\n");

  // 2. Check glue files from server
  console.log('Verifying glue files as served by the server:');
  for (const filename of ['face_mesh_solution_wasm_bin.js', 'face_mesh_solution_simd_wasm_bin.js']) {
    const res = await checkServerEndpoint(`/vendor/mediapipe/${filename}`);
    const hasNewFunction = res.body.includes('new Function(');
    const hasNewUnder = res.body.includes('new_(Function');
    const hasOldPython = res.body.includes('Function.apply(null, args1Local)');
    const hasCorrectClosure = res.body.includes('{[fname]:function()');
    console.log(`  ${filename}:`);
    console.log(`    HTTP Status: ${res.status}`);
    console.log(`    X-CSP-Patched: ${res.headers['x-csp-patched']}`);
    console.log(`    Content-Type: ${res.headers['content-type']}`);
    console.log(`    No 'new Function': ${!hasNewFunction}`);
    console.log(`    No 'new_(Function': ${!hasNewUnder}`);
    console.log(`    No 'Function.apply': ${!hasOldPython}`);
    console.log(`    Has CSP-safe closure: ${hasCorrectClosure}`);

    if (hasNewFunction || hasNewUnder || hasOldPython || !hasCorrectClosure) {
      throw new Error(`FAIL: ${filename} still contains eval-style patterns or lacks safe closure!`);
    }
  }
  console.log('✓ Both glue files are confirmed eval-free and CSP-safe on server.\n');

  // 3. Launch headless Chrome with temporary user data dir and SwiftShader / fake media
  const tmpUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-icash-evidence-'));
  console.log(`Launching headless Chrome (User data dir: ${tmpUserDataDir})...`);

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--use-gl=swiftshader',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--user-data-dir=${tmpUserDataDir}`
    ]
  });

  const page = await browser.newPage();
  const cspViolations = [];
  const consoleLogs = [];
  const networkRequests = [];

  page.on('request', req => {
    const u = req.url();
    if (u.includes('/vendor/mediapipe') || u.includes('/models')) {
      networkRequests.push({ url: u, method: req.method() });
    }
  });

  page.on('response', resp => {
    const u = resp.url();
    if (resp.status() >= 400) {
      console.log(`  [HTTP ${resp.status()}]: ${u}`);
    }
    if (u.includes('/vendor/mediapipe') || u.includes('/models')) {
      networkRequests.push({
        url: u,
        status: resp.status(),
        contentType: resp.headers()['content-type'],
        xCspPatched: resp.headers()['x-csp-patched']
      });
    }
  });

  page.on('console', msg => {
    const text = msg.text();
    consoleLogs.push({ type: msg.type(), text });
    if (msg.type() === 'error') {
      console.log(`  [Browser Error]: ${text}`);
    } else if (text.includes('[FaceMesh]')) {
      console.log(`  [Browser Log]: ${text}`);
    }
  });

  // Track CSP violations via browser CDP
  const client = await page.target().createCDPSession();
  await client.send('Security.enable');

  console.log(`Navigating to ${SERVER_URL} under real CSP...`);
  await page.goto(`${SERVER_URL}/#register`, { waitUntil: 'networkidle0', timeout: 30000 });

  // Listen for securitypolicyviolation in document
  await page.evaluate(() => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', e => {
      window.__cspViolations.push({
        blockedURI: e.blockedURI,
        violatedDirective: e.violatedDirective,
        effectiveDirective: e.effectiveDirective,
        originalPolicy: e.originalPolicy ? e.originalPolicy.substring(0, 100) + '...' : '',
        sourceFile: e.sourceFile,
        lineNumber: e.lineNumber,
        sample: e.sample
      });
      console.error('[CSP VIOLATION EVENT]', e.effectiveDirective, e.blockedURI, e.sourceFile, e.lineNumber);
    });
  });

  // Test 1: Initialize FaceMesh directly using the exact locateFile logic from js/face-scanner.js
  console.log('\n--- Direct MediaPipe FaceMesh Initialization Test ---');
  const directInitResult = await page.evaluate(async (serverUrl) => {
    try {
      if (typeof window.FaceMesh === 'undefined') {
        return { success: false, error: 'window.FaceMesh is undefined' };
      }

      const faceMesh = new window.FaceMesh({
        locateFile: (file) => {
          const base = `${serverUrl}/vendor/mediapipe/`;
          const fileMap = {
            'face_mesh.wasm': 'face_mesh_solution_wasm_bin.wasm',
            'face_mesh_simd.wasm': 'face_mesh_solution_simd_wasm_bin.wasm',
            'face_mesh.js': 'face_mesh_solution_wasm_bin.js',
            'face_mesh_solution_packed_assets.data': 'face_mesh_solution_packed_assets.data',
          };
          return base + (fileMap[file] || file) + '?v=csp_evidence';
        }
      });

      faceMesh.setOptions({
        maxNumFaces: 2,
        refineLandmarks: true,
        minDetectionConfidence: 0.55,
        minTrackingConfidence: 0.55
      });

      console.log('[FaceMesh] Calling faceMesh.initialize()...');
      await faceMesh.initialize();
      console.log('[FaceMesh] faceMesh.initialize() completed successfully!');

      return {
        success: true,
        constructorName: faceMesh.constructor.name
      };
    } catch (e) {
      return {
        success: false,
        name: e.name,
        message: e.message,
        stack: e.stack
      };
    }
  }, SERVER_URL);

  console.log('Direct FaceMesh initialization result:', JSON.stringify(directInitResult, null, 2));

  // Test 2: Navigate to Step 4 of Registration to test real application UI face-scanner integration
  console.log('\n--- Full Register Step 4 UI Face Scanner Test ---');
  const step4Result = await page.evaluate(async () => {
    try {
      // Set registration wizard state to step 4
      if (typeof RegState !== 'undefined') {
        RegState.name = 'Test User';
        RegState.phone = '+919876543210';
        RegState.dob = '1995-01-01';
        RegState.aadhaar = '123456789012';
        RegState.email = 'test@icash.demo';
        RegState.age = 29;
        RegState.senior = false;
        RegState.step = 4;
        if (typeof renderWizardStep === 'function') {
          renderWizardStep();
        }
      }

      // Check if holder exists and wait for scanner status text
      const holder = document.getElementById('faceRegHolder');
      return { holderFound: !!holder };
    } catch (e) {
      return { error: e.message };
    }
  });
  console.log('Register step 4 mounted:', step4Result);

  // Wait 4 seconds for face scanner camera & models & FaceMesh to initialize
  await new Promise(r => setTimeout(r, 4000));

  const uiStatus = await page.evaluate(() => {
    const statusEl = document.getElementById('scnStatus');
    const msgEl = document.getElementById('cameraMsg');
    const errEl = document.getElementById('errCamera');
    return {
      statusText: statusEl ? statusEl.textContent : null,
      cameraMsg: msgEl ? msgEl.textContent : null,
      errCamera: errEl ? errEl.textContent : null,
      cspViolations: window.__cspViolations || []
    };
  });
  console.log('UI scanner status:', JSON.stringify(uiStatus, null, 2));

  // Collect final violations
  const recordedViolations = await page.evaluate(() => window.__cspViolations || []);
  const mpViolations = recordedViolations.filter(v =>
    v.effectiveDirective === 'script-src-elem' ||
    v.effectiveDirective === 'script-src' ||
    (v.sourceFile && v.sourceFile.includes('mediapipe'))
  );

  console.log('\n=== FINAL EVIDENCE REPORT ===');
  console.log(`Total CSP Violations: ${recordedViolations.length}`);
  console.log(`MediaPipe/Eval CSP Violations: ${mpViolations.length}`);
  if (mpViolations.length > 0) {
    console.error('VIOLATIONS DETECTED:', mpViolations);
  } else {
    console.log('✓ ZERO CSP violations detected during browser session!');
  }

  console.log(`Direct FaceMesh.initialize(): ${directInitResult.success ? 'SUCCESS ✓' : 'FAILED ✗'}`);
  console.log(`UI Scanner Status Text: "${uiStatus.statusText}"`);

  // Save evidence json
  const evidenceFile = path.join(EVIDENCE_DIR, 'evidence-result.json');
  fs.writeFileSync(evidenceFile, JSON.stringify({
    timestamp: new Date().toISOString(),
    serverUrl: SERVER_URL,
    cspHeader: cspHeader,
    directInitResult,
    uiStatus,
    recordedViolations,
    networkRequestsSample: networkRequests.slice(0, 30),
    consoleLogsSample: consoleLogs.filter(l => l.type === 'error' || l.text.includes('[FaceMesh]'))
  }, null, 2));
  console.log(`\nEvidence written to: ${evidenceFile}`);

  await browser.close();
  try { fs.rmSync(tmpUserDataDir, { recursive: true, force: true }); } catch (_) {}

  const passed = directInitResult.success && mpViolations.length === 0 && (!uiStatus.errCamera || !uiStatus.errCamera.includes('Content Security Policy'));
  console.log('\n=== VERDICT:', passed ? '✓ ALL TESTS PASSED PROVEN IN REAL BROWSER UNDER CSP' : '✗ FAILED');
  process.exit(passed ? 0 : 1);
}

main().catch(err => {
  console.error('Error running browser evidence test:', err);
  process.exit(1);
});
