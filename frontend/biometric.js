/**
 * iCash Server-Authoritative Biometric Subsystem (v8.0)
 *
 * Implements:
 *   - Zero Client-Trust: Client is camera-only; server evaluates all liveness and PAD proofs.
 *   - Continuous Canvas Evidence Streaming: 640x480 @ 6-8 fps with quality control.
 *   - 5-Stage Verification UX: Center Face → Live Check → Blink Challenge → Match → Authorized.
 *   - Multi-Modal Audio & Screen-Reader Feedback (Web Speech API + ARIA live).
 *   - Biometric-only login with accessible voice guidance.
 *   - Retry limits with cooldown, lighting detection, graceful service degradation.
 */

// Model URLs: Express local static assets first, fallback to Vlad Mandic CDN
const FACEAPI_MODEL_URL = '/models';
const FACEAPI_MODEL_URL_CDN = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model/';

// Core Thresholds
const MATCH_THRESHOLD = 0.52;
const ENROLL_SAMPLES = 5;

// ── Retry Limiting ───────────────────────────────────────────────────────────
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_COOLDOWN_MS  = 30 * 1000; // 30 seconds
let _loginAttempts = 0;
let _loginCooldownUntil = 0;

// ── Math & Geometry Helpers ──────────────────────────────────────────────────
function euclidean(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

function calculateSampleDiversity(samples) {
  if (!samples || samples.length < 2) return 1.0;
  let totalDist = 0;
  let pairs = 0;
  for (let i = 0; i < samples.length; i++) {
    for (let j = i + 1; j < samples.length; j++) {
      totalDist += euclidean(Array.from(samples[i]), Array.from(samples[j]));
      pairs++;
    }
  }
  return pairs > 0 ? totalDist / pairs : 1.0;
}

// ── Camera Manager ────────────────────────────────────────────────────────────
const CameraManager = {
  activeStreams: new WeakMap(),

  async start(videoEl, errEl) {
    if (errEl) {
      errEl.textContent = '';
      errEl.classList.remove('active');
    }
    if (!videoEl) throw new Error('NO_VIDEO_ELEMENT');

    videoEl.setAttribute('playsinline', 'true');
    videoEl.setAttribute('webkit-playsinline', 'true');
    videoEl.setAttribute('muted', 'true');
    videoEl.muted = true;

    this.stop(videoEl);

    if (!window.isSecureContext) {
      const err = new Error('INSECURE_CONTEXT');
      if (errEl) {
        errEl.textContent = 'Camera requires a secure HTTPS or localhost context.';
        errEl.classList.add('active');
      }
      throw err;
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      const err = new Error('NO_MEDIA_API');
      if (errEl) {
        errEl.textContent = 'Camera access is not supported by this browser.';
        errEl.classList.add('active');
      }
      throw err;
    }

    const constraints = {
      video: {
        width: { ideal: 640 },
        height: { ideal: 480 },
        facingMode: 'user',
        frameRate: { ideal: 30, max: 30 },
      },
      audio: false,
    };

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (_) {
      stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    }

    videoEl.srcObject = stream;
    this.activeStreams.set(videoEl, stream);

    await new Promise((resolve) => {
      if (videoEl.readyState >= 2) {
        resolve();
      } else {
        videoEl.onloadedmetadata = () => resolve();
        setTimeout(resolve, 1500);
      }
    });

    try {
      await videoEl.play();
    } catch (_) {}

    return stream;
  },

  stop(videoEl) {
    if (!videoEl) return;
    const stream = this.activeStreams.get(videoEl) || videoEl.srcObject;
    if (stream && typeof stream.getTracks === 'function') {
      stream.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch (_) {}
      });
    }
    videoEl.srcObject = null;
    this.activeStreams.delete(videoEl);
  },
};

// ── Model Loader ──────────────────────────────────────────────────────────────
window._bioModelsLoaded = false;
window._bioModelsLoading = false;

async function ensureBioModels() {
  if (window._bioModelsLoaded) return true;
  if (window._bioModelsLoading) {
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 250));
      if (window._bioModelsLoaded) return true;
    }
    return false;
  }
  window._bioModelsLoading = true;

  const sources = [FACEAPI_MODEL_URL, FACEAPI_MODEL_URL_CDN];
  for (const src of sources) {
    try {
      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri(src),
        faceapi.nets.faceLandmark68Net.loadFromUri(src),
        faceapi.nets.faceRecognitionNet.loadFromUri(src),
      ]);
      window._bioModelsLoaded = true;
      window._bioModelsLoading = false;
      console.log('[iCash Biometric] Client face models loaded from:', src);
      return true;
    } catch (e) {
      console.warn('[iCash Biometric] Model load fallback notice:', e.message || e);
    }
  }

  window._bioModelsLoading = false;
  return false;
}

function getDetectOptions() {
  return new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.30 });
}

// ── Client Frame Quality Gate (UI Coaching) ───────────────────────────────────
const FaceQualityGate = {
  validate(detections, videoEl) {
    if (!detections || detections.length === 0) {
      return { ok: false, reason: 'NO_FACE', message: 'Position your face inside the frame' };
    }
    if (detections.length > 1) {
      return { ok: false, reason: 'MULTI_FACE', message: 'Multiple faces detected — only one person allowed' };
    }

    const det = detections[0];
    const box = det.detection.box;
    const vw = videoEl.videoWidth || 640;
    const vh = videoEl.videoHeight || 480;

    const faceCoverage = Math.max(box.width / vw, box.height / vh);
    if (faceCoverage < 0.18) {
      return { ok: false, reason: 'TOO_FAR', message: 'Move closer to the camera' };
    }
    if (faceCoverage > 0.88) {
      return { ok: false, reason: 'TOO_CLOSE', message: 'Move slightly back from the camera' };
    }

    // Partial visibility check
    if (box.x < 0 || box.y < 0 || box.x + box.width > vw || box.y + box.height > vh) {
      return { ok: false, reason: 'PARTIAL', message: 'Keep your full face in the frame' };
    }

    const faceCenterX = (box.x + box.width / 2) / vw;
    const faceCenterY = (box.y + box.height / 2) / vh;
    if (Math.abs(faceCenterX - 0.5) > 0.30 || Math.abs(faceCenterY - 0.5) > 0.30) {
      return { ok: false, reason: 'NOT_CENTERED', message: 'Center your face in the frame' };
    }

    return { ok: true, det };
  },

  /**
   * Estimate brightness from a video frame via offscreen canvas.
   * Returns value 0-255. < 40 = too dark, > 220 = overexposed.
   */
  sampleBrightness(videoEl, canvas) {
    try {
      const ctx = canvas.getContext('2d');
      ctx.drawImage(videoEl, 0, 0, 80, 60);
      const data = ctx.getImageData(0, 0, 80, 60).data;
      let total = 0;
      for (let i = 0; i < data.length; i += 4) {
        total += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      }
      return total / (80 * 60);
    } catch (_) { return 128; }
  },
};

// ── UI Overlay & Step Checklist Helpers ───────────────────────────────────────
function getOverlayCanvas(id, parentEl) {
  let oc = document.getElementById(id);
  if (!oc && parentEl) {
    oc = document.createElement('canvas');
    oc.id = id;
    oc.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;width:100%;height:100%;z-index:2;';
    parentEl.style.position = 'relative';
    parentEl.appendChild(oc);
  }
  return oc;
}

function updateChecklistStep(prefix, currentStep) {
  // Step 1: Center face
  // Step 2: Live check
  // Step 3: Blink challenge
  // Step 4: Identity match
  // Step 5: Authorized
  for (let s = 1; s <= 5; s++) {
    const item = document.getElementById(`${prefix}-step-${s}`);
    if (item) {
      if (s < currentStep) {
        item.className = 'bio-step completed';
      } else if (s === currentStep) {
        item.className = 'bio-step active';
      } else {
        item.className = 'bio-step pending';
      }
    }
  }
}

/**
 * Update the blink progress dots: 0=none, 1=first done, 2=both done.
 * Handles both legacy .blink-dot elements and the new .blink-chip elements.
 */
function updateBlinkDots(prefix, blinkCount) {
  // New .blink-chip style
  const chip1 = document.getElementById(`${prefix}-dot-1`);
  const chip2 = document.getElementById(`${prefix}-dot-2`);
  if (chip1 && chip1.classList.contains('blink-chip')) {
    chip1.classList.toggle('done',   blinkCount >= 1);
    chip1.classList.toggle('active', blinkCount === 0);
    chip1.setAttribute('aria-label', blinkCount >= 1 ? 'Blink 1 complete' : 'Blink 1 pending');
    chip2.classList.toggle('done',   blinkCount >= 2);
    chip2.classList.toggle('active', blinkCount === 1);
    chip2.setAttribute('aria-label', blinkCount >= 2 ? 'Blink 2 complete' : 'Blink 2 pending');
  } else {
    // Legacy fallback
    if (chip1) chip1.classList.toggle('active', blinkCount >= 1);
    if (chip2) chip2.classList.toggle('active', blinkCount >= 2);
  }
}

let _lastSpokenInstruction = '';

function setBannerStatus(prefix, text, stateClass = 'info', speak = true) {
  const banner = document.getElementById(`${prefix}-instruction-banner`);
  const textEl = document.getElementById(`${prefix}-instruction-text`);
  if (textEl) textEl.textContent = text;
  if (banner) banner.className = `scan-instruction-banner ${stateClass}`;

  const statusEl = document.getElementById(`${prefix}-scan-status`);
  if (statusEl) {
    statusEl.textContent = text;
    if (stateClass === 'bad') statusEl.classList.add('bad');
    else statusEl.classList.remove('bad');
  }

  // Multi-modal speech announcement
  if (speak && text && text !== _lastSpokenInstruction && window.iCashAccessibility) {
    _lastSpokenInstruction = text;
    window.iCashAccessibility.announce(text, stateClass === 'bad' ? 'assertive' : 'polite');
  }
}

function drawFaceRing(canvas, video, quality, isLive = false) {
  if (!canvas || !video) return;
  const w = video.videoWidth || 640;
  const h = video.videoHeight || 480;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);

  if (!quality || !quality.ok || !quality.det) return;

  const det = quality.det;
  const box = det.detection.box;
  const color = isLive ? '#22c55e' : '#38bdf8';

  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  ctx.strokeRect(box.x, box.y, box.width, box.height);

  // Corner brackets
  const s = 14;
  const corners = [
    [box.x, box.y, 1, 1],
    [box.x + box.width, box.y, -1, 1],
    [box.x, box.y + box.height, 1, -1],
    [box.x + box.width, box.y + box.height, -1, -1],
  ];
  ctx.lineWidth = 3.5;
  corners.forEach(([cx, cy, dx, dy]) => {
    ctx.beginPath();
    ctx.moveTo(cx, cy + dy * s);
    ctx.lineTo(cx, cy);
    ctx.lineTo(cx + dx * s, cy);
    ctx.stroke();
  });
  ctx.restore();
}

// ── Shared Challenge State ────────────────────────────────────────────────────
let _currentChallenge = null;

// ==============================================================================
// 1. LOGIN BIOMETRIC SCAN (SERVER-AUTHORITATIVE)
// ==============================================================================
let _loginActive = false;
let _brightCanvas = null; // tiny offscreen canvas for brightness sampling

async function beginLoginScan() {
  _loginActive = false;
  _lastSpokenInstruction = '';

  // ── Cooldown guard ─────────────────────────────────────────────────────────
  if (Date.now() < _loginCooldownUntil) {
    const remainSec = Math.ceil((_loginCooldownUntil - Date.now()) / 1000);
    setBannerStatus('login',
      `Too many failed attempts. Please wait ${remainSec}s before retrying.`, 'bad', true);
    return;
  }

  const video  = document.getElementById('login-video');
  const errEl  = document.getElementById('login-cam-error');
  const retryBtn = document.getElementById('login-retry-cam-btn');

  // Hide retry button at start
  if (retryBtn) retryBtn.style.display = 'none';
  // Clear error box
  if (errEl) { errEl.textContent = ''; errEl.classList.remove('active'); }

  updateChecklistStep('login', 1);
  updateBlinkDots('login', 0);
  setBannerStatus('login', 'Initializing secure camera…', 'info', false);

  // Brightness probe canvas (80×60 is enough for mean luminance)
  if (!_brightCanvas) {
    _brightCanvas = document.createElement('canvas');
    _brightCanvas.width = 80;
    _brightCanvas.height = 60;
  }

  const parent = video ? video.parentElement : null;
  const overlayCanvas = getOverlayCanvas('login-overlay-canvas', parent);

  // 1. Pre-load face-api models in background (for overlay only — server does the real work)
  ensureBioModels().catch(() => {});

  // 2. Start Camera
  try {
    await CameraManager.start(video, errEl);
  } catch (camErr) {
    const msg = 'Camera unavailable or permission was denied. ' +
      'Grant camera permission and tap Retry, or use Assisted Mode.';
    setBannerStatus('login', msg, 'bad', true);
    if (errEl) { errEl.textContent = msg; errEl.classList.add('active'); }
    if (retryBtn) retryBtn.style.display = '';
    return;
  }

  // 3. Request fresh cryptographic challenge from server
  const targetUser = window._loginTargetUser;
  let challenge;
  try {
    setBannerStatus('login', 'Connecting to biometric server…', 'info', false);
    const challengeRes = await window.iCashApi.issueChallenge({
      userIdHint: targetUser ? targetUser.id : undefined,
    });
    if (!challengeRes || !challengeRes.ok || !challengeRes.challengeId) {
      throw new Error((challengeRes && challengeRes.message) || 'Challenge generation failed');
    }
    challenge = challengeRes;
    _currentChallenge = challenge;
    setBannerStatus('login', challenge.instruction || 'Center your face in the frame', 'info', true);
  } catch (chalErr) {
    const offline = chalErr.message && (
      chalErr.message.includes('NO_BACKEND') ||
      chalErr.message.includes('unavailable') ||
      chalErr.message.includes('fetch')
    );
    const msg = offline
      ? 'Biometric server is offline. Tap Retry or use Assisted Mode.'
      : `Unable to start verification: ${chalErr.message}`;
    setBannerStatus('login', msg, 'bad', true);
    if (errEl) { errEl.textContent = msg; errEl.classList.add('active'); }
    if (retryBtn) retryBtn.style.display = '';
    CameraManager.stop(video);
    return;
  }

  // 4. Offscreen canvas for frame capture (640×480 JPEG)
  const offCanvas = document.createElement('canvas');
  offCanvas.width  = 640;
  offCanvas.height = 480;
  const offCtx = offCanvas.getContext('2d');

  _loginActive = true;
  updateChecklistStep('login', 1);

  let framesProcessed = 0;
  let consecutiveNetworkErrors = 0;
  const MAX_FRAMES = 350; // ~50 seconds at 7 fps
  const MAX_NET_ERRORS = 8; // give up if network stays broken

  const runLoop = async () => {
    if (!_loginActive) return;

    framesProcessed++;
    if (framesProcessed > MAX_FRAMES) {
      _loginActive = false;
      _loginAttempts++;
      if (_loginAttempts >= LOGIN_MAX_ATTEMPTS) {
        _loginCooldownUntil = Date.now() + LOGIN_COOLDOWN_MS;
        _loginAttempts = 0;
      }
      setBannerStatus('login',
        'Authentication timed out — please blink naturally and retry.', 'bad', true);
      if (retryBtn) retryBtn.style.display = '';
      CameraManager.stop(video);
      return;
    }

    // Brightness check every 15 frames
    if (framesProcessed % 15 === 0 && window._bioModelsLoaded) {
      const brightness = FaceQualityGate.sampleBrightness(video, _brightCanvas);
      if (brightness < 35) {
        setBannerStatus('login', 'Improve lighting — it is too dark', 'warning', true);
      } else if (brightness > 220) {
        setBannerStatus('login', 'Reduce glare — too much light behind you', 'warning', true);
      }
    }

    // Capture JPEG frame
    offCtx.drawImage(video, 0, 0, 640, 480);
    const frameB64 = offCanvas.toDataURL('image/jpeg', 0.82);

    // Optional local face-api overlay (visual only, no auth logic)
    if (window._bioModelsLoaded && typeof faceapi !== 'undefined') {
      try {
        const detections = await faceapi.detectAllFaces(video, getDetectOptions());
        const quality = FaceQualityGate.validate(detections, video);
        drawFaceRing(overlayCanvas, video, quality, false);
        // Warn about quality issues the server hasn't seen yet
        if (!quality.ok && quality.reason !== 'NO_FACE') {
          setBannerStatus('login', quality.message, 'warning', false);
        }
      } catch (_) {}
    }

    // Stream frame to Server Liveness Engine
    try {
      const serverRes = await window.iCashApi.sendBiometricFrame({
        challengeId: challenge.challengeId,
        nonce: challenge.nonce,
        image: frameB64,
        timestamp: Date.now(),
      });

      consecutiveNetworkErrors = 0; // reset on success

      if (!_loginActive) return;

      if (serverRes && serverRes.ok) {
        const step = serverRes.current_step || 1;
        updateChecklistStep('login', step);

        // Blink count from server
        if (typeof serverRes.blink_count === 'number') {
          updateBlinkDots('login', serverRes.blink_count);
        }

        if (serverRes.instruction) {
          const stateClass = serverRes.quality_ok ? 'info' : 'warning';
          setBannerStatus('login', serverRes.instruction, stateClass, true);
        }

        // ── LIVENESS CONFIRMED ────────────────────────────────────────────────
        if (serverRes.live) {
          _loginActive = false;
          updateChecklistStep('login', 4);
          updateBlinkDots('login', 2);
          setBannerStatus('login', '✅ Liveness verified — matching identity…', 'ok', true);

          try {
            const verifyPayload = {
              challengeId: challenge.challengeId,
              nonce: challenge.nonce,
            };
            if (targetUser && targetUser.id) verifyPayload.userId = targetUser.id;

            const verifyRes = await window.iCashApi.verifyChallenge(verifyPayload);
            if (!verifyRes || !verifyRes.ok || !verifyRes.biometricToken) {
              throw new Error((verifyRes && verifyRes.message) || 'Identity verification failed.');
            }

            updateChecklistStep('login', 5);
            setBannerStatus('login', '✅ Identity verified — entering portal…', 'ok', true);
            CameraManager.stop(video);
            _loginAttempts = 0; // reset on success

            const authRes = await window.iCashApi.loginBiometric(verifyRes.biometricToken);
            if (authRes.ok && authRes.user) {
              window.currentUser = authRes.user;
              if (typeof currentUser !== 'undefined') currentUser = authRes.user;
              sessionStorage.setItem('icash_session_active', 'true');
              enterDashboard();
            } else {
              throw new Error((authRes && authRes.message) || 'Failed to establish session');
            }
          } catch (verifyErr) {
            console.error('[iCash Bio] Verify error:', verifyErr);
            _loginAttempts++;
            setBannerStatus('login',
              'We could not confidently verify you. Please try again.', 'bad', true);
            if (retryBtn) retryBtn.style.display = '';
          }
          return;
        }

        // ── SPOOF DETECTED ────────────────────────────────────────────────────
        if (serverRes.spoof_detected) {
          _loginActive = false;
          _loginAttempts++;
          if (_loginAttempts >= LOGIN_MAX_ATTEMPTS) {
            _loginCooldownUntil = Date.now() + LOGIN_COOLDOWN_MS;
            _loginAttempts = 0;
          }
          setBannerStatus('login',
            'Presentation attack detected. Please use your live face.', 'bad', true);
          if (retryBtn) retryBtn.style.display = '';
          CameraManager.stop(video);
          return;
        }
      }
    } catch (netErr) {
      consecutiveNetworkErrors++;
      console.warn('[iCash Bio] Frame network error:', netErr.message);
      if (consecutiveNetworkErrors >= MAX_NET_ERRORS) {
        _loginActive = false;
        setBannerStatus('login',
          'Network connection lost. Check your connection and tap Retry.', 'bad', true);
        if (retryBtn) retryBtn.style.display = '';
        CameraManager.stop(video);
        return;
      }
    }

    // Schedule next frame (~7 fps)
    setTimeout(runLoop, 140);
  };

  runLoop();
}

function cancelLoginScan() {
  teardownLoginScan();
  goTo('screen-welcome');
}

function teardownLoginScan() {
  _loginActive = false;
  _currentChallenge = null;
  const video = document.getElementById('login-video');
  CameraManager.stop(video);
  const oc = document.getElementById('login-overlay-canvas');
  if (oc) oc.getContext('2d').clearRect(0, 0, oc.width, oc.height);
}

function captureLoginFace() {
  setBannerStatus('login', 'Automatic secure scan is active. Keep your face in frame and follow the blink prompt.', 'info', true);
}

// ==============================================================================
// 2. TRANSACTION BIOMETRIC GATE (SERVER-AUTHORITATIVE)
// ==============================================================================
let _gateActive = false;

async function launchBiometricGate(title, lead) {
  document.getElementById('verify-title').textContent = title || 'Authorize Transaction';
  document.getElementById('verify-lead').textContent = lead || 'Please complete server biometric verification';
  document.getElementById('verify-msg').textContent = '';
  document.getElementById('verify-pin-block').style.display = 'none';

  openModal('verify');

  const video = document.getElementById('verify-video');
  const errEl = document.getElementById('verify-cam-error');
  const statusEl = document.getElementById('verify-scan-status');
  const retryBtn = document.getElementById('verify-retry-cam-btn');
  const captureBtn = document.getElementById('verify-capture-btn');

  if (captureBtn) captureBtn.style.display = 'none';
  if (retryBtn) retryBtn.style.display = 'none';
  if (statusEl) statusEl.textContent = 'Initializing biometric verification…';

  const parent = video ? video.parentElement : null;
  const overlayCanvas = getOverlayCanvas('verify-overlay-canvas', parent);

  try {
    await CameraManager.start(video, errEl);
  } catch (camErr) {
    if (statusEl) statusEl.textContent = 'Camera unavailable. Use PIN authorization.';
    toggleVerifyPin();
    return;
  }

  // Issue server challenge
  let challenge;
  try {
    challenge = await window.iCashApi.issueChallenge({
      userIdHint: currentUser ? currentUser.id : undefined,
    });
    if (!challenge || !challenge.ok) throw new Error('Challenge creation failed');
  } catch (e) {
    if (statusEl) statusEl.textContent = 'Biometric service unavailable. Use PIN.';
    toggleVerifyPin();
    return;
  }

  const offCanvas = document.createElement('canvas');
  offCanvas.width = 640;
  offCanvas.height = 480;
  const offCtx = offCanvas.getContext('2d');

  _gateActive = true;
  if (statusEl) statusEl.textContent = challenge.instruction || 'Look at camera to authorize';

  let framesProcessed = 0;
  const MAX_FRAMES = 300;

  const runLoop = async () => {
    if (!_gateActive) return;

    framesProcessed++;
    if (framesProcessed > MAX_FRAMES) {
      _gateActive = false;
      if (statusEl) statusEl.textContent = 'Verification timed out. Use PIN to authorize.';
      toggleVerifyPin();
      return;
    }

    offCtx.drawImage(video, 0, 0, 640, 480);
    const frameB64 = offCanvas.toDataURL('image/jpeg', 0.82);

    try {
      const serverRes = await window.iCashApi.sendBiometricFrame({
        challengeId: challenge.challengeId,
        nonce: challenge.nonce,
        image: frameB64,
        timestamp: Date.now(),
      });

      if (!_gateActive) return;

      if (serverRes && serverRes.ok) {
        if (serverRes.instruction && statusEl) {
          statusEl.textContent = serverRes.instruction;
        }

        if (serverRes.live) {
          _gateActive = false;
          if (statusEl) statusEl.textContent = '✅ Verified! Executing transaction…';

          try {
            const verifyRes = await window.iCashApi.verifyChallenge({
              challengeId: challenge.challengeId,
              nonce: challenge.nonce,
              userId: currentUser ? currentUser.id : undefined,
            });

            if (!verifyRes || !verifyRes.ok || !verifyRes.biometricToken) {
              throw new Error(verifyRes.message || 'Authorization denied.');
            }

            CameraManager.stop(video);
            await executePendingAction();
            teardownVerifyGate();
            closeModal('verify');
          } catch (err) {
            const msgEl = document.getElementById('verify-msg');
            if (msgEl) {
              msgEl.textContent = err.message || 'Authorization failed.';
              msgEl.className = 'modal-msg err';
            }
            if (statusEl) statusEl.textContent = '❌ Authorization failed.';
          }
          return;
        }

        if (serverRes.spoof_detected) {
          _gateActive = false;
          if (statusEl) statusEl.textContent = '❌ Presentation attack detected. Use PIN.';
          toggleVerifyPin();
          return;
        }
      }
    } catch (_) {}

    setTimeout(runLoop, 140);
  };

  runLoop();
}

function cancelVerify() {
  teardownVerifyGate();
  closeModal('verify');
  pendingVerificationAction = null;
  showAlertToast('Transaction cancelled.', true);
}

function teardownVerifyGate() {
  _gateActive = false;
  const video = document.getElementById('verify-video');
  CameraManager.stop(video);
  const oc = document.getElementById('verify-overlay-canvas');
  if (oc) oc.getContext('2d').clearRect(0, 0, oc.width, oc.height);
}

function captureVerifyFace() {
  toggleVerifyPin();
}

// ==============================================================================
// 3. REGISTRATION BIOMETRIC SCAN (ENROLLMENT)
// ==============================================================================
let _regActive = false;

async function beginRegisterScan() {
  _regActive = false;
  const video = document.getElementById('reg-video');
  const errEl = document.getElementById('reg-cam-error');
  const retryBtn = document.getElementById('reg-retry-cam-btn');
  const captureBtn = document.getElementById('reg-capture-btn');

  if (captureBtn) captureBtn.style.display = 'none';
  if (retryBtn) retryBtn.style.display = 'none';

  setBannerStatus('reg', 'Initializing camera for biometric enrollment…', 'info');

  const modelsOk = await ensureBioModels();
  if (!modelsOk) {
    setBannerStatus('reg', 'Biometric enrollment models unavailable. Please try again.', 'bad');
    return;
  }

  try {
    await CameraManager.start(video, errEl);
  } catch (camErr) {
    setBannerStatus('reg', 'Camera access denied or unavailable.', 'bad');
    if (retryBtn) retryBtn.style.display = '';
    return;
  }

  _regActive = true;
  setBannerStatus('reg', 'Look at camera to capture enrolled face samples…', 'info');

  const descriptors = [];
  let framesProcessed = 0;
  const MAX_FRAMES = 400;

  const runLoop = async () => {
    if (!_regActive) return;

    framesProcessed++;
    if (framesProcessed > MAX_FRAMES) {
      _regActive = false;
      setBannerStatus('reg', 'Enrollment timed out. Click Retry to scan again.', 'bad');
      if (retryBtn) retryBtn.style.display = '';
      return;
    }

    try {
      const detections = await faceapi
        .detectAllFaces(video, getDetectOptions())
        .withFaceLandmarks()
        .withFaceDescriptors();

      const quality = FaceQualityGate.validate(detections, video);
      if (!quality.ok) {
        setBannerStatus('reg', quality.message, 'warning');
      } else {
        const det = quality.det;
        if (det.descriptor && descriptors.length < ENROLL_SAMPLES) {
          descriptors.push(Array.from(det.descriptor));
          setBannerStatus('reg', `Capturing face sample ${descriptors.length}/${ENROLL_SAMPLES}…`, 'info');
        }

        if (descriptors.length >= ENROLL_SAMPLES) {
          const diversity = calculateSampleDiversity(descriptors);
          if (diversity < 0.002) {
            setBannerStatus('reg', '⚠️ Static photo detected — live person required.', 'bad');
            descriptors.length = 0;
          } else {
            _regActive = false;
            setBannerStatus('reg', '✅ Biometrics captured! Creating account…', 'ok');
            CameraManager.stop(video);

            try {
              const payload = {
                ...window._pendingRegPayload,
                faceDescriptors: descriptors,
                descriptors,
              };
              const regRes = await window.iCashApi.register(payload);
              if (regRes.ok && regRes.user) {
                window.currentUser = regRes.user;
                if (typeof currentUser !== 'undefined') currentUser = regRes.user;
                sessionStorage.setItem('icash_session_active', 'true');
                enterDashboard();
              } else {
                throw new Error(regRes.message || 'Registration failed');
              }
            } catch (err) {
              setBannerStatus('reg', `❌ ${err.message || 'Registration failed.'}`, 'bad');
              if (retryBtn) retryBtn.style.display = '';
            }
            return;
          }
        }
      }
    } catch (_) {}

    setTimeout(runLoop, 120);
  };

  runLoop();
}

function cancelRegisterScan() {
  teardownRegisterScan();
  goTo('screen-register-form');
}

function teardownRegisterScan() {
  _regActive = false;
  const video = document.getElementById('reg-video');
  CameraManager.stop(video);
}

function captureRegisterFace() {
  setBannerStatus('reg', 'Automatic scan active. Look at camera to enroll.', 'info');
}

// ── Multi-Modal Authentication Selector (Phase 14) ───────────────────────────
function selectAuthMode(mode) {
  if (mode === 'voice') {
    if (window.iCashAccessibility) {
      window.iCashAccessibility.voiceGuidance = true;
      window.iCashAccessibility.announce('Voice guided authentication selected. Opening camera.');
    }
    if (typeof openAssistedVoiceMode === 'function') openAssistedVoiceMode();
  } else if (mode === 'assisted') {
    goTo('screen-delegate-collect');
    if (window.iCashAccessibility) {
      window.iCashAccessibility.announce('Assisted banking mode selected.');
    }
  } else {
    // Default face + blink
    goTo('screen-login-scan');
    beginLoginScan();
  }
}

// Preload models in background
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => ensureBioModels(), 800);
});
