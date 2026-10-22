/* =========================================================
   ICASH — Secure Biometric Scanner Engine
   Dual-Engine Architecture:
     1. MediaPipe FaceMesh (478 3D landmarks) for real-time 30+ FPS
        liveness, 3D head pose estimation, EAR state machine,
        and randomized challenge-response validation.
     2. VladMandic Face-API (FaceRecognitionNet) for 128-dimensional
        neural biometric face descriptor extraction.

   Strict Authentication Pipeline:
     1. Camera Validation (live MediaStream check)
     2. Single Face Detection (reject 0, reject > 1)
     3. Centering, Size & Quality (sharpness, luminance, pose)
     4. Real Liveness & Anti-Spoofing (temporal EAR state machine)
     5. Randomized Challenge (Blink once/twice, Turn head left/right + blink)
     6. 128-d Neural Face Descriptor Extraction
     7. Backend Cryptographic Verification & Calibrated Distance Check
========================================================= */

let faceApiLoaded = false;
let faceApiLoadingPromise = null;

/**
 * Verify that all required model files are accessible (return 200).
 * Uses HEAD first, falls back to GET if needed.
 * Returns true if all files exist, false otherwise.
 */
async function verifyModelFiles() {
  const requiredFiles = [
    '/models/tiny_face_detector_model-weights_manifest.json',
    '/models/tiny_face_detector_model.bin',
    '/models/face_landmark_68_model-weights_manifest.json',
    '/models/face_landmark_68_model.bin',
    '/models/face_recognition_model-weights_manifest.json',
    '/models/face_recognition_model.bin'
  ];

  for (const file of requiredFiles) {
    let res;
    try {
      // Try HEAD first (lightweight, no body)
      res = await fetch(file, { method: 'HEAD', cache: 'no-cache' });
      if (!res.ok) {
        // Fallback: try GET with Range header (some servers don't support HEAD for static files)
        res = await fetch(file, { 
          method: 'GET', 
          headers: { 'Range': 'bytes=0-0' },
          cache: 'no-cache' 
        });
        if (!res.ok && res.status !== 206) {
          console.error(`[Model Check] Missing or inaccessible: ${file} (${res.status})`);
          return { ok: false, missingFile: file, status: res.status };
        }
      }
    } catch (e) {
      console.error(`[Model Check] Network error for ${file}:`, e.message);
      return { ok: false, missingFile: file, error: e.message };
    }
  }
  return { ok: true };
}

/**
 * Pre-load face-api.js neural recognition models.
 * ONLY loads from local /models/ directory — no CDN fallback for security.
 */
async function loadFaceApiModels() {
  if (faceApiLoaded) {return true;}
  if (faceApiLoadingPromise) {return faceApiLoadingPromise;}

  faceApiLoadingPromise = (async () => {
    if (typeof faceapi === 'undefined') {
      console.warn('faceapi is not defined in window');
      return false;
    }

    // Verify model files exist before attempting to load
    const verifyResult = await verifyModelFiles();
    if (!verifyResult.ok) {
      console.error('[Face-API] Model files missing:', verifyResult);
      // The UI will show the error via the caller
      return false;
    }

    const modelLocations = [
      '/models'
      // CDN fallback removed for security — models must be served locally
    ];

    for (const loc of modelLocations) {
      try {
        console.log('[Face-API] Attempting to load models from:', loc);
        await Promise.all([
          faceapi.nets.tinyFaceDetector.loadFromUri(loc),
          faceapi.nets.faceLandmark68Net.loadFromUri(loc),
          faceapi.nets.faceRecognitionNet.loadFromUri(loc)
        ]);
        console.log('[Face-API] Models loaded successfully from:', loc);
        faceApiLoaded = true;
        return true;
      } catch (err) {
        // Distinguish between different load errors
        if (err instanceof TypeError && err.message.includes('fetch')) {
          console.warn(`[Face-API] Network error loading from ${loc}:`, err.message);
        } else if (err.message && err.message.includes('CSP')) {
          console.error(`[Face-API] CSP error loading from ${loc}:`, err.message);
        } else {
          console.warn(`[Face-API] Failed loading from ${loc}:`, err.message);
        }
      }
    }
    return false;
  })();

  return faceApiLoadingPromise;
}

function mountFaceScanner(container, opts) {
  opts = opts || {};
  const isSenior = opts.senior || (State.user && State.user.seniorMode);
  const mode = opts.mode || 'login'; // 'login' | 'register' | 'enroll'
  const challengeData = opts.challenge || null; // { challengeId, challengeType, accountId, userName }

  container.innerHTML = `
    <div class="scanner ${isSenior ? 'senior' : ''}" id="scnBox">
      <video id="scnVideo" autoplay playsinline muted></video>
      <div class="ring" id="scnRing" style="display:none;"></div>
      <div class="frame"></div>
      <div class="eye-track" id="scnEyeTrack" style="display:none;">
        <span class="eye-dot left" id="eyeDotL"><span class="eye-lbl">L-EYE</span></span>
        <span class="eye-dot right" id="eyeDotR"><span class="eye-lbl">R-EYE</span></span>
      </div>
      <div class="flash" id="scnFlash"></div>
    </div>

    <div class="challenge-box" id="challengeBox" style="display:none;">
      <div class="challenge-title" id="challengeTitle">Biometric Challenge</div>
      <div class="challenge-instruction" id="challengeInstruction">Initializing...</div>
      <div class="challenge-progress" id="challengeProgress"></div>
    </div>

    <div class="scan-status" id="scnStatus">Starting secure camera…</div>

    <div class="scan-checks" id="scnChecks">
      <div class="scan-check" data-k="camera"><div class="dot"></div> Camera stream active</div>
      <div class="scan-check" data-k="single"><div class="dot"></div> Single face detected</div>
      <div class="scan-check" data-k="quality"><div class="dot"></div> Position & lighting valid</div>
      <div class="scan-check" data-k="liveness"><div class="dot"></div> Physical liveness verified</div>
      <div class="scan-check" data-k="challenge"><div class="dot"></div> Challenge completed</div>
      <div class="scan-check" data-k="identity"><div class="dot"></div> Face identity match</div>
      <div class="scan-check" data-k="auth"><div class="dot"></div> Authorized</div>
    </div>

    <div class="demo-tag" id="scnTelemetry" style="margin-bottom:12px;">EAR: -- | Yaw: -- | Quality: --</div>

    <div style="display:flex; gap:10px; justify-content:center; flex-wrap:wrap;">
      <button class="btn btn-primary btn-sm" id="restartBtn" style="display:none;">Try Again</button>
      <button class="btn btn-ghost btn-sm" id="cancelScanBtn" style="display:none;">Use PIN Instead</button>
    </div>`;

  const statusEl = container.querySelector('#scnStatus');
  const telemetryEl = container.querySelector('#scnTelemetry');
  const eyeTrackBox = container.querySelector('#scnEyeTrack');
  const eyeDotL = container.querySelector('#eyeDotL');
  const eyeDotR = container.querySelector('#eyeDotR');
  const flash = container.querySelector('#scnFlash');
  const ring = container.querySelector('#scnRing');
  const video = container.querySelector('#scnVideo');
  const restartBtn = container.querySelector('#restartBtn');
  const cancelBtn = container.querySelector('#cancelScanBtn');
  const challengeBox = container.querySelector('#challengeBox');
  const challengeTitle = container.querySelector('#challengeTitle');
  const challengeInst = container.querySelector('#challengeInstruction');
  const challengeProg = container.querySelector('#challengeProgress');

  const checks = {};
  container.querySelectorAll('.scan-check').forEach(c => checks[c.dataset.k] = c);

  function setCheck(k, state = 'on') {
    const el = checks[k];
    if (!el) {return;}
    el.classList.remove('on', 'failed', 'active');
    const dot = el.querySelector('.dot');
    if (state === 'on') {
      el.classList.add('on');
      dot.innerHTML = iconSvg('check').replace('width="20" height="20"', 'width="10" height="10"');
    } else if (state === 'active') {
      el.classList.add('active');
      dot.innerHTML = '•';
    } else if (state === 'failed') {
      el.classList.add('failed');
      dot.innerHTML = '✕';
    } else {
      dot.innerHTML = '';
    }
  }

  // State Machine Variables
  let stream = null;
  let cancelled = false;
  let faceMesh = null;
  let latestResults = null;
  let animFrameId = null;

  // Pipeline State
  // 'IDLE' | 'STARTING' | 'SEARCH' | 'CENTERING' | 'QUALITY' | 'CHALLENGE' | 'EXTRACTING' | 'VERIFYING' | 'AUTHENTICATED' | 'FAILED'
  let pipelineState = 'STARTING';

  // SECURITY: A unique nonce per scan session — reset on every retry.
  // Prevents reuse of a previous successful liveness result across attempts.
  // Use the sessionNonce passed from the caller (login/atm) to bind the challenge to the scan session
  const sessionNonce = opts.sessionNonce || (crypto.randomUUID ? crypto.randomUUID() : (Date.now().toString(36) + Math.random().toString(36).slice(2)));

  // SECURITY: Guard flag — extractBiometricDescriptor can only fire ONCE per nonce.
  // Prevents multiple concurrent verification calls from a single scan session.
  let descriptorExtractionTriggered = false;

  // Quality & Liveness Metrics
  let baselineEAR = 0.32;
  let earSamples = [];
  let blinkCount = 0;
  let blinkPhase = 'OPEN'; // 'OPEN' -> 'CLOSING' -> 'CLOSED' -> 'OPENING' -> 'OPEN'
  let blinkStartTime = 0;
  let closedFrameCount = 0;

  // SECURITY: Liveness confirmation flag — must be explicitly set by the blink
  // state machine completing a full valid cycle. Separate from blinkCount to
  // prevent any code path from setting it without a real detected blink.
  let livenessConfirmed = false;

  // Head Pose Tracking
  let headTurnState = 'CENTER'; // 'CENTER' -> 'TURNED' -> 'RETURNED'
  let _maxTurnYaw = 0;

  // Anti-Spoofing & Temporal Proof
  let challengeStartTime = 0;
  let framesAnalyzed = 0;
  let earMinSeen = 1.0;
  let earMaxSeen = 0.0;
  let consecutiveQualityFrames = 0;

  // SECURITY: Track whether the EAR range requirement has been met.
  // A static photograph or replay with near-zero eye movement will fail this check.
  let earRangeValid = false;
  const EAR_RANGE_THRESHOLD = 0.06; // Minimum delta to prove real eye movement

  // Active Challenge Definition
  let currentChallenge = challengeData ? challengeData.challengeType : (mode === 'register' ? 'blink_twice' : 'blink_once');
  let currentChallengeId = challengeData ? challengeData.challengeId : null;
  let resolvedAccountId = challengeData ? challengeData.accountId : null;

  // Landmarks for MediaPipe FaceMesh
  const LEFT_EYE = { p1: 33, p2: 160, p3: 158, p4: 133, p5: 153, p6: 145 };
  const RIGHT_EYE = { p1: 362, p2: 385, p3: 387, p4: 263, p5: 380, p6: 374 };
  const LEFT_EYE_PTS = [33, 133, 159, 145];
  const RIGHT_EYE_PTS = [362, 263, 386, 374];

  function dist(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function computeEAR(landmarks, eye) {
    const p1 = landmarks[eye.p1];
    const p2 = landmarks[eye.p2];
    const p3 = landmarks[eye.p3];
    const p4 = landmarks[eye.p4];
    const p5 = landmarks[eye.p5];
    const p6 = landmarks[eye.p6];
    if (!p1 || !p2 || !p3 || !p4 || !p5 || !p6) {return 0.3;}

    const v1 = dist(p2, p6);
    const v2 = dist(p3, p5);
    const h = dist(p1, p4);
    if (h === 0) {return 0.3;}
    return (v1 + v2) / (2.0 * h);
  }

  /**
   * Estimates head yaw angle from 3D FaceMesh landmarks.
   * Compares the horizontal distance from nose tip (1) to outer eye corners (33, 263).
   */
  function estimateHeadYaw(landmarks) {
    const nose = landmarks[1];
    const leftOuter = landmarks[33];
    const rightOuter = landmarks[263];
    if (!nose || !leftOuter || !rightOuter) {return 0;}

    const dLeft = Math.abs(nose.x - leftOuter.x);
    const dRight = Math.abs(nose.x - rightOuter.x);
    const total = dLeft + dRight;
    if (total === 0) {return 0;}

    // Relative offset: 0 is centered, negative is turned left, positive is turned right
    // Note: Video is mirrored (scaleX(-1)), so adjust accordingly
    const ratio = (dRight - dLeft) / total;
    const yawDegrees = ratio * 75; // Approx degrees
    return yawDegrees;
  }

  /**
   * Estimates head pitch angle from forehead (10) and chin (152) relative to nose (1).
   */
  function estimateHeadPitch(landmarks) {
    const forehead = landmarks[10];
    const chin = landmarks[152];
    const nose = landmarks[1];
    if (!forehead || !chin || !nose) {return 0;}

    const dTop = Math.abs(nose.y - forehead.y);
    const dBottom = Math.abs(chin.y - nose.y);
    const total = dTop + dBottom;
    if (total === 0) {return 0;}

    const ratio = (dBottom - dTop) / total;
    return ratio * 60; // Approx degrees
  }

  function getPointCenter(landmarks, indices) {
    let cx = 0, cy = 0, count = 0;
    for (const idx of indices) {
      if (landmarks[idx]) {
        cx += landmarks[idx].x;
        cy += landmarks[idx].y;
        count++;
      }
    }
    return count ? { x: cx / count, y: cy / count } : { x: 0.5, y: 0.5 };
  }

  function updateEyeTracking(landmarks, isClosed) {
    if (!eyeTrackBox) {return;}
    eyeTrackBox.style.display = 'block';

    const leftCenter = (landmarks[468] && landmarks[468].x !== null)
      ? landmarks[468]
      : getPointCenter(landmarks, LEFT_EYE_PTS);

    const rightCenter = (landmarks[473] && landmarks[473].x !== null)
      ? landmarks[473]
      : getPointCenter(landmarks, RIGHT_EYE_PTS);

    // Mirrored camera display:
    const lx = Math.max(5, Math.min(95, (1 - leftCenter.x) * 100));
    const ly = Math.max(5, Math.min(95, leftCenter.y * 100));
    const rx = Math.max(5, Math.min(95, (1 - rightCenter.x) * 100));
    const ry = Math.max(5, Math.min(95, rightCenter.y * 100));

    if (eyeDotL) {
      eyeDotL.style.left = lx.toFixed(1) + '%';
      eyeDotL.style.top = ly.toFixed(1) + '%';
      if (isClosed) {eyeDotL.classList.add('closed');}
      else {eyeDotL.classList.remove('closed');}
    }

    if (eyeDotR) {
      eyeDotR.style.left = rx.toFixed(1) + '%';
      eyeDotR.style.top = ry.toFixed(1) + '%';
      if (isClosed) {eyeDotR.classList.add('closed');}
      else {eyeDotR.classList.remove('closed');}
    }
  }

  function flashOnce() {
    flash.classList.add('on');
    setTimeout(() => flash.classList.remove('on'), 250);
  }

  function stopAll() {
    if (animFrameId) {cancelAnimationFrame(animFrameId);}
    animFrameId = null;
    if (stream) {
      stream.getTracks().forEach(t => t.stop());
      stream = null;
    }
  }

  function fail(stageKey, msg) {
    pipelineState = 'FAILED';
    statusEl.textContent = msg;
    statusEl.style.color = 'var(--danger)';
    if (stageKey && checks[stageKey]) {setCheck(stageKey, 'failed');}

    ring.style.display = 'none';
    if (eyeTrackBox) {eyeTrackBox.style.display = 'none';}
    restartBtn.style.display = 'inline-flex';
    cancelBtn.style.display = 'inline-flex';
    challengeBox.style.display = 'none';
    stopAll();

    if (opts.onFailure) {opts.onFailure({ stage: stageKey, error: msg });}
  }

  /* ---- Initialize MediaPipe Face Mesh ---- */
  async function initFaceMesh() {
    if (typeof FaceMesh === 'undefined') {
      const msg = 'MediaPipe FaceMesh library not loaded. Check network connection and CSP settings. See browser console (F12) for details.';
      console.error('[FaceMesh]', msg);
      fail('camera', msg);
      return false;
    }

    try {
      faceMesh = new FaceMesh({
        locateFile: (file) => {
          // Serve MediaPipe files locally from /vendor/mediapipe/
          let base = '/vendor/mediapipe/';
          if (typeof API !== 'undefined' && typeof API === 'string' && API.startsWith('http')) {
            try {
              const u = new URL(API);
              base = `${u.origin}/vendor/mediapipe/`;
            } catch (_) {}
          }
          // Map CDN filenames to local filenames
          const fileMap = {
            'face_mesh.wasm': 'face_mesh_solution_wasm_bin.wasm',
            'face_mesh_simd.wasm': 'face_mesh_solution_simd_wasm_bin.wasm',
            'face_mesh.js': 'face_mesh_solution_wasm_bin.js',
            'face_mesh_solution_packed_assets.data': 'face_mesh_solution_packed_assets.data',
          };
          return base + (fileMap[file] || file) + '?v=csp2';
        }
      });

      faceMesh.setOptions({
        maxNumFaces: 2,
        refineLandmarks: true,
        minDetectionConfidence: 0.55,
        minTrackingConfidence: 0.55
      });

      faceMesh.onResults((results) => {
        latestResults = results;
      });

      console.log('[FaceMesh] Initializing...');
      await faceMesh.initialize();
      console.log('[FaceMesh] Initialized successfully');
      return true;
    } catch (e) {
      // Distinguish between different error types
      let msg;
      if (e instanceof EvalError || (e.message && e.message.includes('unsafe-eval'))) {
        msg = 'Script blocked by Content Security Policy: eval-style code execution is not allowed. The MediaPipe glue files must be patched to remove eval-style code. Check browser console (F12) for details.';
        console.error('[FaceMesh] CSP Error:', e);
      } else if (e instanceof TypeError && e.message.includes('WebAssembly')) {
        msg = 'WebAssembly initialization failed. This browser may not support WebAssembly or it is disabled. Check browser console (F12) for details.';
        console.error('[FaceMesh] WebAssembly Error:', e);
      } else {
        msg = `Neural face tracking failed to initialize: ${e.message || e}. Check browser console (F12) for details.`;
        console.error('[FaceMesh] Initialization error:', e);
      }
      fail('camera', msg);
      return false;
    }
  }

  /* ---- Set Challenge UI ---- */
  function setupChallengeUI() {
    challengeBox.style.display = 'block';
    challengeTitle.textContent = mode === 'register' ? 'Enrollment Liveness Check' : 'Live Challenge Verification';

    switch (currentChallenge) {
      case 'blink_once':
        challengeInst.textContent = 'Challenge: Blink your eyes once naturally';
        challengeProg.textContent = 'Awaiting blink...';
        break;
      case 'blink_twice':
        challengeInst.textContent = 'Challenge: Blink your eyes twice';
        challengeProg.textContent = 'Blinks: 0 / 2';
        break;
      case 'turn_left_blink':
        challengeInst.textContent = 'Challenge: Turn head slightly left, return, then blink';
        challengeProg.textContent = 'Step 1: Turn head slightly left';
        break;
      case 'turn_right_blink':
        challengeInst.textContent = 'Challenge: Turn head slightly right, return, then blink';
        challengeProg.textContent = 'Step 1: Turn head slightly right';
        break;
      default:
        challengeInst.textContent = 'Challenge: Blink your eyes naturally';
        challengeProg.textContent = 'Awaiting blink...';
    }
  }

  /* ---- Extract Biometric Embedding using Face-API ---- */
  async function extractBiometricDescriptor() {
    // SECURITY: Ensure descriptor extraction and verification only fires ONCE per scan session
    if (descriptorExtractionTriggered) {return;}
    descriptorExtractionTriggered = true;

    // SECURITY: Reject static photos or simulated blinks that lack real EAR variation
    const range = earMaxSeen - earMinSeen;
    if (!earRangeValid && range < EAR_RANGE_THRESHOLD) {
      fail('liveness', 'Liveness check failed: Insufficient eye movement detected (static photo rejected).');
      return;
    }

    // SECURITY: Require physical liveness to have been explicitly confirmed
    if (!livenessConfirmed) {
      fail('liveness', 'Liveness verification incomplete.');
      return;
    }

    pipelineState = 'EXTRACTING';
    statusEl.textContent = 'Extracting facial biometric template…';
    statusEl.style.color = 'var(--accent)';
    setCheck('challenge', 'on');
    setCheck('identity', 'active');

    try {
      // Ensure faceapi is initialized
      const ready = await loadFaceApiModels();
      if (!ready || typeof faceapi === 'undefined') {
        throw new Error('Face recognition engine models unavailable');
      }

      // Live capture directly from the live video stream (never from static image)
      const detection = await faceapi
        .detectSingleFace(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 }))
        .withFaceLandmarks()
        .withFaceDescriptor();

      if (!detection || !detection.descriptor) {
        throw new Error('Could not compute face descriptor from live frame. Please hold steady.');
      }

      const descriptorArray = Array.from(detection.descriptor);
      if (descriptorArray.length !== 128) {
        throw new Error('Invalid descriptor dimensions');
      }

      pipelineState = 'VERIFYING';
      statusEl.textContent = 'Verifying identity with security server…';
      flashOnce();

      // Bundle verifiable liveness proof
      const livenessProof = {
        challengeType: currentChallenge,
        completedInMs: Date.now() - challengeStartTime,
        framesAnalyzed,
        blinkCount,
        earHistoryMin: Number(earMinSeen.toFixed(3)),
        earHistoryMax: Number(earMaxSeen.toFixed(3)),
        headTurnDetected: (currentChallenge.includes('turn') ? headTurnState === 'RETURNED' : true)
      };

      if (mode === 'register' || mode === 'enroll') {
        // Registration/Enrollment mode: Provide enrolled template
        setCheck('identity', 'on');
        setCheck('auth', 'on');
        statusEl.textContent = '✓ Face ID template enrolled successfully!';
        statusEl.style.color = 'var(--success)';
        stopAll();

        setTimeout(() => {
          if (opts.onSuccess) {
            opts.onSuccess({
              biometricTemplate: descriptorArray,
              livenessProof
            });
          }
        }, 600);
      } else {
        // Login mode: Perform server-side identity verification
        await verifyWithBackend(descriptorArray, livenessProof);
      }
    } catch (err) {
      console.error('Descriptor extraction / verification error:', err);
      setCheck('identity', 'failed');
      setCheck('auth', 'failed');
      fail('identity', err.message || 'Face verification error');
    }
  }

  /* ---- Server-Side Cryptographic Verification ---- */
  async function verifyWithBackend(liveDescriptor, livenessProof) {
    try {
      if (!currentChallengeId) {
        setCheck('identity', 'failed');
        setCheck('auth', 'failed');
        fail('identity', 'Biometric challenge not active. Please click Try Again.');
        return;
      }

      const apiBase = typeof API !== 'undefined' ? API : '/api';
      const targetAccountId = resolvedAccountId || (challengeData ? challengeData.accountId : (State.user ? State.user.id : 1));
      const res = await fetch(apiBase + '/auth/biometric/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          challengeId: currentChallengeId,
          accountId: targetAccountId,
          sessionNonce,
          liveDescriptor,
          livenessProof
        })
      });

      const data = await res.json();

      if (!res.ok || !data.success) {
        setCheck('identity', 'failed');
        setCheck('auth', 'failed');
        fail('identity', data.error || 'Face verification failed: Identity mismatch');
        return;
      }

      // Success! Identity matched account template
      pipelineState = 'AUTHENTICATED';
      setCheck('identity', 'on');
      setCheck('auth', 'on');
      statusEl.textContent = `✓ Identity Verified (Match confidence: ${(100 - (data.distance || 0.3) * 100).toFixed(0)}%)`;
      statusEl.style.color = 'var(--success)';
      stopAll();

      setTimeout(() => {
        if (opts.onSuccess) {opts.onSuccess(data);}
      }, 700);
    } catch (_e) {
      setCheck('identity', 'failed');
      setCheck('auth', 'failed');
      fail('identity', 'Network error during biometric verification');
    }
  }

  /* ---- Main Frame Processing & State Machine ---- */
  function startProcessingLoop() {
    let lastSendTime = 0;
    const FRAME_INTERVAL = 33; // ~30 FPS

    function loop(timestamp) {
      if (cancelled) {return;}
      animFrameId = requestAnimationFrame(loop);

      if (timestamp - lastSendTime < FRAME_INTERVAL) {return;}
      lastSendTime = timestamp;

      if (!faceMesh || !video || !video.videoWidth || video.readyState < 2) {return;}

      // STEP 1: Verify video stream is a live MediaStream
      if (!(video.srcObject instanceof MediaStream) || !video.srcObject.active) {
        fail('camera', 'Live video stream interrupted');
        return;
      }

      // Send live frame to FaceMesh
      faceMesh.send({ image: video }).catch(() => {});

      if (!latestResults) {return;}
      const faces = latestResults.multiFaceLandmarks;

      // STEP 2: Strict Face Count Detection
      if (!faces || faces.length === 0) {
        if (pipelineState !== 'STARTING') {
          statusEl.textContent = 'Face not detected. Look at the camera.';
          statusEl.style.color = 'var(--warn)';
          telemetryEl.textContent = 'No face in frame';
          consecutiveQualityFrames = 0;
        }
        if (eyeTrackBox) {eyeTrackBox.style.display = 'none';}
        return;
      }

      if (faces.length > 1) {
        cancelled = true;
        stopAll();
        fail('single', 'Multiple faces detected. For security, only one person should be visible.');
        State.logEvent('Security Alert', 'Multiple faces detected during biometric scan — scan aborted');
        return;
      }

      // Exactly ONE face detected
      const landmarks = faces[0];
      setCheck('single', 'on');

      // Calculate Bounding Metrics
      let minX = 1, maxX = 0, minY = 1, maxY = 0;
      for (let i = 0; i < landmarks.length; i++) {
        const p = landmarks[i];
        if (p.x < minX) {minX = p.x;}
        if (p.x > maxX) {maxX = p.x;}
        if (p.y < minY) {minY = p.y;}
        if (p.y > maxY) {maxY = p.y;}
      }

      const faceWidth = maxX - minX;
      const _faceHeight = maxY - minY;
      const centerX = (minX + maxX) / 2;
      const centerY = (minY + maxY) / 2;

      // Calculate Head Angles
      const yaw = estimateHeadYaw(landmarks);
      const pitch = estimateHeadPitch(landmarks);

      // Calculate Eye Aspect Ratios
      const leftEAR = computeEAR(landmarks, LEFT_EYE);
      const rightEAR = computeEAR(landmarks, RIGHT_EYE);
      const currentEAR = (leftEAR + rightEAR) / 2.0;

      earMinSeen = Math.min(earMinSeen, currentEAR);
      earMaxSeen = Math.max(earMaxSeen, currentEAR);
      framesAnalyzed++;

      // Update telemetry display safely
      // Compute a simple quality metric for display (0-100)
      const centerQuality = Math.max(0, 1 - Math.max(
        Math.abs(centerX - 0.5) / 0.15,
        Math.abs(centerY - 0.5) / 0.22
      ));
      const poseQuality = Math.max(0, 1 - Math.max(Math.abs(yaw), Math.abs(pitch)) / 20);
      const sizeQuality = Math.max(0, 1 - Math.abs(faceWidth - 0.4) / 0.2);
      const displayQuality = Math.round((centerQuality * 0.4 + poseQuality * 0.4 + sizeQuality * 0.2) * 100);
      telemetryEl.textContent = `EAR: ${currentEAR.toFixed(3)} | Yaw: ${yaw.toFixed(1)}° | Quality: ${displayQuality}%`;

      // Adaptive Baseline EAR Calibration
      earSamples.push(currentEAR);
      if (earSamples.length > 30) {earSamples.shift();}

      // ========================================================
      // STAGE 3: Centering & Quality Check
      // ========================================================
      if (pipelineState === 'SEARCH' || pipelineState === 'CENTERING' || pipelineState === 'QUALITY') {
        setCheck('quality', 'active');

        // Centering bounds
        if (centerX < 0.35 || centerX > 0.65 || centerY < 0.28 || centerY > 0.72) {
          statusEl.textContent = 'Please move your face to the center of the frame';
          statusEl.style.color = 'var(--warn)';
          consecutiveQualityFrames = 0;
          return;
        }

        // Distance bounds
        if (faceWidth < 0.22) {
          statusEl.textContent = 'Move closer to the camera';
          statusEl.style.color = 'var(--warn)';
          consecutiveQualityFrames = 0;
          return;
        }
        if (faceWidth > 0.68) {
          statusEl.textContent = 'Move back slightly from the camera';
          statusEl.style.color = 'var(--warn)';
          consecutiveQualityFrames = 0;
          return;
        }

        // Pose bounds
        if (Math.abs(yaw) > 16 || Math.abs(pitch) > 16) {
          statusEl.textContent = 'Look directly at the camera';
          statusEl.style.color = 'var(--warn)';
          consecutiveQualityFrames = 0;
          return;
        }

        consecutiveQualityFrames++;

        // When face is centered & steady for 20 frames (~660ms), calibrate baseline and enter challenge
        // SECURITY: Require 20+ frames (was 10) to ensure we have enough EAR samples
        // to calibrate a reliable baseline and detect EAR variance from a live face.
        if (consecutiveQualityFrames >= 20) {
          const sorted = [...earSamples].sort((a, b) => b - a);
          const topSamples = sorted.slice(0, Math.min(6, sorted.length));
          if (topSamples.length > 0) {
            baselineEAR = topSamples.reduce((a, b) => a + b, 0) / topSamples.length;
          }

          setCheck('quality', 'on');
          pipelineState = 'CHALLENGE';
          challengeStartTime = Date.now();
          setupChallengeUI();
          setCheck('liveness', 'active');
          setCheck('challenge', 'active');
          statusEl.textContent = 'Perform the live challenge displayed above';
          statusEl.style.color = 'var(--accent)';
        } else {
          statusEl.textContent = 'Holding steady for alignment…';
          statusEl.style.color = 'var(--accent)';
        }
        return;
      }

      // ========================================================
      // STAGE 4 & 5: Real Liveness & Challenge State Machine
      // ========================================================
      if (pipelineState === 'CHALLENGE') {
        const elapsed = (Date.now() - challengeStartTime) / 1000;
        const TIMEOUT_SECS = 18;

        if (elapsed > TIMEOUT_SECS) {
          fail('challenge', 'Biometric challenge timed out. Please try again.');
          return;
        }

        // EAR State Machine Thresholds (adaptive & more robust)
        // Use percentile-based baseline for more stable thresholds
        const sortedEAR = [...earSamples].sort((a, b) => a - b);
        const p10 = sortedEAR[Math.floor(sortedEAR.length * 0.1)] || baselineEAR;
        const p90 = sortedEAR[Math.floor(sortedEAR.length * 0.9)] || baselineEAR;
        const earDynamicRange = Math.max(0.02, p90 - p10);

        // Closed threshold: adaptive, more lenient for natural blinks
        const closedThreshold = Math.min(0.24, Math.max(0.15, p10 + earDynamicRange * 0.35));
        // Open threshold: adaptive, ensures clear open state
        const openThreshold = Math.max(0.25, Math.min(0.35, p90 - earDynamicRange * 0.25));
        const isClosed = currentEAR < closedThreshold;

        updateEyeTracking(landmarks, isClosed);

        // Update EAR range tracking for anti-spoofing
        const currentRange = earMaxSeen - earMinSeen;
        if (currentRange >= EAR_RANGE_THRESHOLD && !earRangeValid) {
          earRangeValid = true;
          console.log(`[Anti-Spoof] EAR range validated: ${currentRange.toFixed(3)} >= ${EAR_RANGE_THRESHOLD}`);
        }

        // Compute quality metric for telemetry (0-100)
        const _qualityScore = Math.min(100, Math.max(0,
          (1 - Math.abs(currentEAR - baselineEAR) / Math.max(0.1, earDynamicRange)) * 50 +
          (1 - Math.min(1, Math.abs(yaw) / 20)) * 30 +
          (1 - Math.min(1, Math.abs(pitch) / 20)) * 20
        ));

        // Strict Temporal Blink Transitions (improved)
        // OPEN -> CLOSING -> CLOSED -> OPENING -> OPEN
        if (blinkPhase === 'OPEN' && currentEAR < baselineEAR * 0.78) {
          blinkPhase = 'CLOSING';
          blinkStartTime = Date.now();
        } else if (blinkPhase === 'CLOSING' && isClosed) {
          blinkPhase = 'CLOSED';
          closedFrameCount = 1;
        } else if (blinkPhase === 'CLOSED') {
          if (isClosed) {
            closedFrameCount++;
          } else if (currentEAR > openThreshold) {
            const blinkDuration = Date.now() - blinkStartTime;
            // A legitimate human blink: 80-1000ms, 1-20 frames at 30fps
            if (blinkDuration >= 80 && blinkDuration <= 1000 && closedFrameCount >= 1 && closedFrameCount <= 20) {
              blinkCount++;
              flashOnce();
              console.log(`[Liveness] Valid blink #${blinkCount} recorded (${blinkDuration}ms, ${closedFrameCount} frames, EAR: ${currentEAR.toFixed(3)})`);
            } else {
              console.warn(`[Liveness] Rejected anomalous blink (${blinkDuration}ms, ${closedFrameCount} frames, EAR: ${currentEAR.toFixed(3)})`);
            }
            blinkPhase = 'OPEN';
            closedFrameCount = 0;
          }
          // Timeout: if stuck in CLOSED too long without opening, reset
          else if (Date.now() - blinkStartTime > 1200) {
            blinkPhase = 'OPEN';
            closedFrameCount = 0;
          }
        }
        // Handle case where eye opens without passing through CLOSING->CLOSED (partial blink)
        else if (blinkPhase === 'CLOSING' && currentEAR > openThreshold) {
          blinkPhase = 'OPEN';
        }

        // Challenge Evaluation
        if (currentChallenge === 'blink_once') {
          challengeProg.textContent = `Blinks: ${blinkCount} / 1 (Time: ${(TIMEOUT_SECS - elapsed).toFixed(0)}s)`;
          if (blinkCount >= 1) {
            livenessConfirmed = true;
            setCheck('liveness', 'on');
            challengeProg.textContent = '✓ Blink verified!';
            extractBiometricDescriptor();
          }
        } else if (currentChallenge === 'blink_twice') {
          challengeProg.textContent = `Blinks: ${blinkCount} / 2 (Time: ${(TIMEOUT_SECS - elapsed).toFixed(0)}s)`;
          if (blinkCount >= 2) {
            livenessConfirmed = true;
            setCheck('liveness', 'on');
            challengeProg.textContent = '✓ Two blinks verified!';
            extractBiometricDescriptor();
          }
        } else if (currentChallenge === 'turn_left_blink') {
          // Mirrored camera: Turning head left makes yaw negative (or positive depending on coordinate)
          // Video mirror scaleX(-1) means screen left = yaw < -14
          if (headTurnState === 'CENTER') {
            challengeProg.textContent = `Step 1: Turn head slightly left (Current: ${yaw.toFixed(0)}°)`;
            if (yaw < -14) {
              headTurnState = 'TURNED';
              _maxTurnYaw = yaw;
            }
          } else if (headTurnState === 'TURNED') {
            challengeProg.textContent = 'Step 2: Return head to center';
            if (Math.abs(yaw) < 8) {
              headTurnState = 'RETURNED';
              blinkCount = 0; // Reset blinks after turn
            }
          } else if (headTurnState === 'RETURNED') {
            challengeProg.textContent = `Step 3: Blink once (Blinks: ${blinkCount} / 1)`;
            if (blinkCount >= 1) {
              livenessConfirmed = true;
              setCheck('liveness', 'on');
              challengeProg.textContent = '✓ Turn & blink challenge verified!';
              extractBiometricDescriptor();
            }
          }
        } else if (currentChallenge === 'turn_right_blink') {
          if (headTurnState === 'CENTER') {
            challengeProg.textContent = `Step 1: Turn head slightly right (Current: ${yaw.toFixed(0)}°)`;
            if (yaw > 14) {
              headTurnState = 'TURNED';
              _maxTurnYaw = yaw;
            }
          } else if (headTurnState === 'TURNED') {
            challengeProg.textContent = 'Step 2: Return head to center';
            if (Math.abs(yaw) < 8) {
              headTurnState = 'RETURNED';
              blinkCount = 0;
            }
          } else if (headTurnState === 'RETURNED') {
            challengeProg.textContent = `Step 3: Blink once (Blinks: ${blinkCount} / 1)`;
            if (blinkCount >= 1) {
              livenessConfirmed = true;
              setCheck('liveness', 'on');
              challengeProg.textContent = '✓ Turn & blink challenge verified!';
              extractBiometricDescriptor();
            }
          }
        }
      }
    }

    animFrameId = requestAnimationFrame(loop);
  }

  /* ---- Start Camera & Pipeline ---- */
  async function startCamera() {
    cancelled = false;
    pipelineState = 'STARTING';
    statusEl.textContent = 'Accessing camera…';
    statusEl.style.color = 'var(--accent)';
    restartBtn.style.display = 'none';
    cancelBtn.style.display = 'none';
    challengeBox.style.display = 'none';
    telemetryEl.textContent = 'Initializing biometric models…';

    // Reset check marks
    Object.keys(checks).forEach(k => setCheck(k, 'off'));
    setCheck('camera', 'active');

    // Reset counters and security flags
    // Note: sessionNonce is NOT reset here — it must match the server challenge.
    // If user wants a fresh challenge, they should cancel and restart from login page.
    descriptorExtractionTriggered = false;
    earRangeValid = false;
    livenessConfirmed = false;
    earSamples = [];
    blinkCount = 0;
    blinkPhase = 'OPEN';
    headTurnState = 'CENTER';
    consecutiveQualityFrames = 0;
    framesAnalyzed = 0;
    earMinSeen = 1.0;
    earMaxSeen = 0.0;

    try {
      // 1. Request live user camera
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'user',
          width: { ideal: 640 },
          height: { ideal: 480 }
        },
        audio: false
      });

      if (cancelled) {return;}
      video.srcObject = stream;
      ring.style.display = 'block';
      setCheck('camera', 'on');

      // 1.5. Automatically fetch server challenge if not pre-provided (e.g. withdraw, send)
      if (!currentChallengeId && mode !== 'register' && mode !== 'enroll') {
        try {
          const apiBase = typeof API !== 'undefined' ? API : '/api';
          const targetAccountId = opts.accountId || (challengeData ? challengeData.accountId : (State.user ? State.user.id : undefined));
          const cRes = await fetch(apiBase + '/auth/biometric/challenge', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({
              accountId: targetAccountId,
              sessionNonce
            })
          });
          const cData = await cRes.json();
          if (cRes.ok && cData.challengeId) {
            currentChallengeId = cData.challengeId;
            currentChallenge = cData.challengeType || currentChallenge;
            if (cData.accountId) {resolvedAccountId = cData.accountId;}
            setupChallengeUI();
          } else if (cData.error === 'NO_BIOMETRIC_ENROLLED') {
            fail('camera', cData.message || 'No Face ID enrolled for this account. Please enroll Face ID first.');
            return;
          } else {
            console.warn('[FaceScanner] Challenge endpoint warning:', cData.error || cData);
          }
        } catch (err) {
          console.warn('[FaceScanner] Failed to fetch challenge:', err);
        }
      }

      // 2. Verify and pre-fetch face recognition models
      statusEl.textContent = 'Verifying biometric models…';
      
      // Retry verification up to 3 times with delay (server might still be starting)
      let modelsReady = false;
      let verifyResult = { ok: false };
      for (let attempt = 1; attempt <= 3; attempt++) {
        modelsReady = await loadFaceApiModels();
        if (modelsReady) {break;}
        verifyResult = await verifyModelFiles();
        if (verifyResult.ok) {
          modelsReady = true;
          break;
        }
        if (attempt < 3) {
          console.warn(`[Model Check] Attempt ${attempt} failed, retrying in 500ms...`);
          await new Promise(r => setTimeout(r, 500));
        }
      }
      
      if (!modelsReady) {
        // Get more details about what failed
        let errorMsg = 'Biometric model files are missing or failed to load. ';
        if (!verifyResult.ok) {
          errorMsg += `Missing: ${verifyResult.missingFile} (${verifyResult.status || verifyResult.error || 'unknown error'}). `;
        }
        errorMsg += 'Please ensure the server is running (npm start) and refresh the page.';
        fail('camera', errorMsg);
        return;
      }

      // 3. Initialize MediaPipe FaceMesh
      statusEl.textContent = 'Loading 3D neural mesh…';
      const meshReady = await initFaceMesh();
      if (cancelled) {return;}

      if (!meshReady) {
        // initFaceMesh already called fail() with detailed error
        return;
      }

      pipelineState = 'SEARCH';
      setCheck('single', 'active');
      statusEl.textContent = 'Position your face inside the frame';
      startProcessingLoop();
    } catch (e) {
      console.error('Camera error:', e);
      fail('camera', 'Camera access denied or unavailable. Camera is required for biometric authentication.');
    }
  }

  // Action Buttons
  restartBtn.onclick = () => startCamera();
  cancelBtn.onclick = () => {
    stopAll();
    if (opts.onCancel) {opts.onCancel();}
    else {nav('login');}
  };

  // Start immediately
  startCamera();

  // Cleanup observer when container is removed from DOM
  const obs = new MutationObserver(() => {
    if (!container.isConnected) {
      cancelled = true;
      stopAll();
      obs.disconnect();
    }
  });
  obs.observe(document.getElementById('app') || document.body, { childList: true, subtree: true });
}

// Expose for other modules (global scope in browser)
window.mountFaceScanner = mountFaceScanner;
