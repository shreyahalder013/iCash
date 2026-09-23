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

// Debug EAR overlay is hidden in the customer flow; enable with ?debug=ear
const EAR_DEBUG_ENABLED =
  typeof location !== 'undefined' &&
  new URLSearchParams(location.search).get('debug') === 'ear';

// External functions defined in script.js but used here (loaded together in browser)
/* global enterDashboard, toggleVerifyPin, openAssistedVoiceMode */

// Core Thresholds
const ENROLL_SAMPLES = 5;

// ── Retry Limiting ───────────────────────────────────────────────────────────
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_COOLDOWN_MS = 30 * 1000; // 30 seconds
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
  return new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.3 });
}

// ── Client Frame Quality Gate (UI Coaching) ───────────────────────────────────
const FaceQualityGate = {
  validate(detections, videoEl) {
    if (!detections || detections.length === 0) {
      return { ok: false, reason: 'NO_FACE', message: 'Position your face inside the frame' };
    }
    if (detections.length > 1) {
      return {
        ok: false,
        reason: 'MULTI_FACE',
        message: 'Multiple faces detected — only one person allowed',
      };
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
    if (Math.abs(faceCenterX - 0.5) > 0.3 || Math.abs(faceCenterY - 0.5) > 0.3) {
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
    } catch (_) {
      return 128;
    }
  },
};

// ── Client-Side Eye Aspect Ratio (EAR) & Blink Detection ────────────────────────
// Uses face-api.js 68-point landmarks for real-time feedback
// Server remains authoritative; this provides immediate visual feedback

// 68-point landmark indices for eyes (face-api.js uses standard 68-point model)
const LEFT_EYE_INDICES = [36, 37, 38, 39, 40, 41];
const RIGHT_EYE_INDICES = [42, 43, 44, 45, 46, 47];

function calculateEAR(eyePoints) {
  // Soukupova & Cech EAR formula: (||p2-p6|| + ||p3-p5||) / (2 * ||p1-p4||)
  // eyePoints: array of 6 points [p1, p2, p3, p4, p5, p6]
  if (!eyePoints || eyePoints.length !== 6) return 0.3;
  const p1 = eyePoints[0];
  const p2 = eyePoints[1];
  const p3 = eyePoints[2];
  const p4 = eyePoints[3];
  const p5 = eyePoints[4];
  const p6 = eyePoints[5];

  const vertical1 = Math.hypot(p2.x - p6.x, p2.y - p6.y);
  const vertical2 = Math.hypot(p3.x - p5.x, p3.y - p5.y);
  const horizontal = Math.hypot(p1.x - p4.x, p1.y - p4.y);

  if (horizontal < 0.001) return 0.3;
  return (vertical1 + vertical2) / (2.0 * horizontal);
}

function extractEyePoints(landmarks, indices) {
  return indices.map((i) => ({ x: landmarks[i].x, y: landmarks[i].y }));
}

// Client-side blink state machine for real-time feedback
const BlinkStateMachine = {
  // States: 'OPEN', 'CLOSING', 'CLOSED', 'OPENING'
  state: 'OPEN',
  blinkCount: 0,
  closedStartTime: 0,
  lastBlinkEndTime: 0,
  baselineEAR: 0.29,
  isCalibrated: false,
  calibrationSamples: 0,
  earHistory: [],

  // Configurable thresholds (will be calibrated per session)
  EAR_CLOSE_RATIO: 0.72,
  EAR_OPEN_RATIO: 0.88,
  EAR_CLOSE_FLOOR: 0.12,
  EAR_OPEN_FLOOR: 0.18,
  MIN_BLINK_MS: 70,
  MAX_BLINK_MS: 700,
  BLINK_DEBOUNCE_MS: 250,
  MAX_CLOSED_DURATION_MS: 750,

  reset() {
    this.state = 'OPEN';
    this.blinkCount = 0;
    this.closedStartTime = 0;
    this.lastBlinkEndTime = 0;
    this.baselineEAR = 0.29;
    this.isCalibrated = false;
    this.calibrationSamples = 0;
    this.earHistory = [];
  },

  update(ear, leftEAR, rightEAR, now) {
    this.earHistory.push(ear);
    if (this.earHistory.length > 60) this.earHistory.shift();

    // Baseline calibration (open-eye resting state)
    if (!this.isCalibrated) {
      if (ear >= this.EAR_OPEN_FLOOR) {
        this.baselineEAR =
          (this.baselineEAR * this.calibrationSamples + ear) / (this.calibrationSamples + 1);
        this.calibrationSamples++;
        if (this.calibrationSamples >= 6) {
          this.isCalibrated = true;
        }
      }
      return { blinkDetected: false, blinkCount: this.blinkCount, state: this.state };
    }

    // Subtle drift tracking while eyes open
    if (this.state === 'OPEN' && ear >= this.EAR_OPEN_FLOOR) {
      this.baselineEAR = this.baselineEAR * 0.96 + ear * 0.04;
    }

    const closeThresh = Math.max(this.EAR_CLOSE_FLOOR, this.baselineEAR * this.EAR_CLOSE_RATIO);
    const openThresh = Math.max(this.EAR_OPEN_FLOOR, this.baselineEAR * this.EAR_OPEN_RATIO);

    const bothClosed = leftEAR <= closeThresh && rightEAR <= closeThresh;
    const bothOpen = ear >= openThresh;

    let blinkDetected = false;

    if (this.state === 'OPEN') {
      if (bothClosed) {
        this.state = 'CLOSED';
        this.closedStartTime = now;
      }
    } else if (this.state === 'CLOSED') {
      const closedDurationMs = (now - this.closedStartTime) * 1000.0;

      // Flag closed-eye photo attack if eyes held closed excessively long
      if (closedDurationMs > this.MAX_CLOSED_DURATION_MS) {
        this.state = 'OPEN';
        return {
          blinkDetected: false,
          blinkCount: this.blinkCount,
          state: this.state,
          spoofSuspected: true,
        };
      }

      if (bothOpen) {
        const validDuration =
          closedDurationMs >= this.MIN_BLINK_MS && closedDurationMs <= this.MAX_BLINK_MS;
        const debounceOk = (now - this.lastBlinkEndTime) * 1000.0 >= this.BLINK_DEBOUNCE_MS;

        if (validDuration && debounceOk) {
          this.blinkCount++;
          this.lastBlinkEndTime = now;
          blinkDetected = true;
        }
        this.state = 'OPEN';
      } else if (!bothClosed) {
        // Eyes beginning to open but not fully open yet
        if (closedDurationMs > this.MAX_BLINK_MS) {
          this.state = 'OPEN';
        }
      }
    }

    return {
      blinkDetected,
      blinkCount: this.blinkCount,
      state: this.state,
      closeThresh,
      openThresh,
      baselineEAR: this.baselineEAR,
      isCalibrated: this.isCalibrated,
    };
  },

  // Get EAR variance and dynamic range for anti-spoofing feedback
  getLivenessMetrics() {
    if (this.earHistory.length < 10) return { variance: 0, dynamicRange: 0 };
    const mean = this.earHistory.reduce((a, b) => a + b, 0) / this.earHistory.length;
    const variance =
      this.earHistory.reduce((sum, v) => sum + (v - mean) ** 2, 0) / this.earHistory.length;
    const minEar = Math.min(...this.earHistory);
    const maxEar = Math.max(...this.earHistory);
    return { variance, dynamicRange: maxEar - minEar };
  },
};

// Draw EAR visualization on canvas
function drawEARVisualization(canvas, video, leftEAR, rightEAR, avgEAR, blinkState, challengeType) {
  if (!canvas || !video) return;
  const w = video.videoWidth || 640;
  const h = video.videoHeight || 480;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);

  // Draw EAR bars (top-left corner)
  const barWidth = 120;
  const barHeight = 8;
  const padding = 10;
  const startX = padding;
  const startY = padding;

  // Left eye EAR bar
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillRect(startX, startY, barWidth, barHeight);
  ctx.fillStyle = leftEAR < (blinkState.closeThresh || 0.18) ? '#ef4444' : '#22c55e';
  ctx.fillRect(startX, startY, barWidth * Math.min(leftEAR / 0.4, 1), barHeight);
  ctx.fillStyle = '#fff';
  ctx.font = '11px monospace';
  ctx.fillText(`L: ${leftEAR.toFixed(3)}`, startX + barWidth + 5, startY + barHeight - 1);

  // Right eye EAR bar
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillRect(startX, startY + barHeight + 4, barWidth, barHeight);
  ctx.fillStyle = rightEAR < (blinkState.closeThresh || 0.18) ? '#ef4444' : '#22c55e';
  ctx.fillRect(startX, startY + barHeight + 4, barWidth * Math.min(rightEAR / 0.4, 1), barHeight);
  ctx.fillStyle = '#fff';
  ctx.fillText(`R: ${rightEAR.toFixed(3)}`, startX + barWidth + 5, startY + barHeight * 2 + 3);

  // Average EAR bar
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillRect(startX, startY + (barHeight + 4) * 2, barWidth, barHeight);
  ctx.fillStyle = avgEAR < (blinkState.closeThresh || 0.18) ? '#ef4444' : '#38bdf8';
  ctx.fillRect(
    startX,
    startY + (barHeight + 4) * 2,
    barWidth * Math.min(avgEAR / 0.4, 1),
    barHeight
  );
  ctx.fillStyle = '#fff';
  ctx.fillText(
    `AVG: ${avgEAR.toFixed(3)}`,
    startX + barWidth + 5,
    startY + (barHeight + 4) * 2 + barHeight - 1
  );

  // Blink state indicator
  ctx.fillStyle = '#fff';
  ctx.font = '12px monospace';
  ctx.fillText(`State: ${blinkState.state}`, startX, startY + (barHeight + 4) * 3 + 10);
  ctx.fillText(`Blinks: ${blinkState.blinkCount}`, startX, startY + (barHeight + 4) * 3 + 24);

  // Challenge-specific guidance
  if (challengeType) {
    ctx.fillText(`Challenge: ${challengeType}`, startX, startY + (barHeight + 4) * 3 + 38);
  }
}

// ── UI Overlay & Step Checklist Helpers ───────────────────────────────────────
function getOverlayCanvas(id, parentEl) {
  let oc = document.getElementById(id);
  if (!oc && parentEl) {
    oc = document.createElement('canvas');
    oc.id = id;
    oc.style.cssText =
      'position:absolute;top:0;left:0;pointer-events:none;width:100%;height:100%;z-index:2;';
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
 * Update checklist with explicit stage labels from server
 * @param {string} prefix - Element prefix (e.g., 'login')
 * @param {number} stage - Server stage (1-5)
 * @param {string} stageLabel - Human-readable stage label
 */
function updateChecklistStepWithLabels(prefix, stage, stageLabel) {
  const stageLabels = {
    1: 'Center Face',
    2: 'Live Check',
    3: 'Blink Challenge',
    4: 'Identity Match',
    5: 'Authorized',
  };

  const label = stageLabel || stageLabels[stage] || `Stage ${stage}`;

  for (let s = 1; s <= 5; s++) {
    const item = document.getElementById(`${prefix}-step-${s}`);
    if (item) {
      if (s < stage) {
        item.className = 'bio-step completed';
      } else if (s === stage) {
        item.className = 'bio-step active';
      } else {
        item.className = 'bio-step pending';
      }

      // Update the step label if it exists
      const labelEl = item.querySelector('.step-label');
      if (labelEl && s === stage) {
        labelEl.textContent = label;
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
    chip1.classList.toggle('done', blinkCount >= 1);
    chip1.classList.toggle('active', blinkCount === 0);
    chip1.setAttribute('aria-label', blinkCount >= 1 ? 'Blink 1 complete' : 'Blink 1 pending');
    chip2.classList.toggle('done', blinkCount >= 2);
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
// (Challenge state managed via server responses)

// ==============================================================================
// 1. LOGIN BIOMETRIC SCAN (SERVER-AUTHORITATIVE)
// ==============================================================================
let _loginActive = false;
let _brightCanvas = null; // tiny offscreen canvas for brightness sampling

async function beginLoginScan() {
  _loginActive = false;
  _lastSpokenInstruction = '';
  BlinkStateMachine.reset();
  // ── Cooldown guard ─────────────────────────────────────────────────────────
  if (Date.now() < _loginCooldownUntil) {
    const remainSec = Math.ceil((_loginCooldownUntil - Date.now()) / 1000);
    setBannerStatus(
      'login',
      `Too many failed attempts. Please wait ${remainSec}s before retrying.`,
      'bad',
      true
    );
    return;
  }

  const video = document.getElementById('login-video');
  const errEl = document.getElementById('login-cam-error');
  const retryBtn = document.getElementById('login-retry-cam-btn');

  // Hide retry button at start
  if (retryBtn) retryBtn.style.display = 'none';
  // Clear error box
  if (errEl) {
    errEl.textContent = '';
    errEl.classList.remove('active');
  }

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
    const msg =
      'Camera unavailable or permission was denied. ' +
      'Grant camera permission and tap Retry, or use Assisted Mode.';
    setBannerStatus('login', msg, 'bad', true);
    if (errEl) {
      errEl.textContent = msg;
      errEl.classList.add('active');
    }
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
    setBannerStatus(
      'login',
      challenge.instruction || 'Center your face in the frame',
      'info',
      true
    );
  } catch (chalErr) {
    const offline =
      chalErr.message &&
      (chalErr.message.includes('NO_BACKEND') ||
        chalErr.message.includes('unavailable') ||
        chalErr.message.includes('fetch'));
    const msg = offline
      ? 'Biometric server is offline. Tap Retry or use Assisted Mode.'
      : `Unable to start verification: ${chalErr.message}`;
    setBannerStatus('login', msg, 'bad', true);
    if (errEl) {
      errEl.textContent = msg;
      errEl.classList.add('active');
    }
    if (retryBtn) retryBtn.style.display = '';
    CameraManager.stop(video);
    return;
  }

  // 4. Offscreen canvas for frame capture (640×480 JPEG)
  const offCanvas = document.createElement('canvas');
  offCanvas.width = 640;
  offCanvas.height = 480;
  const offCtx = offCanvas.getContext('2d');

  _loginActive = true;
  updateChecklistStep('login', 1);

  let framesProcessed = 0;
  let consecutiveNetworkErrors = 0;
  let faceRecognizedAnnounced = false;
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
      setBannerStatus(
        'login',
        'Authentication timed out — please blink naturally and retry.',
        'bad',
        true
      );
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

    // Client-side face detection & EAR calculation for real-time feedback.
    // Throttled to every 2nd frame — this is overlay coaching only; the server
    // performs the authoritative evaluation, so there is no need to run the
    // neural models on every single frame.
    let clientEAR = null;
    let clientLeftEAR = null;
    let clientRightEAR = null;
    let clientBlinkState = null;
    let quality = { ok: false, reason: 'NO_FACE' };
    let detections = [];

    if (window._bioModelsLoaded && typeof faceapi !== 'undefined' && framesProcessed % 2 === 0) {
      try {
        detections = await faceapi.detectAllFaces(video, getDetectOptions()).withFaceLandmarks();

        quality = FaceQualityGate.validate(detections, video);

        if (quality.ok && quality.det && quality.det.landmarks) {
          const landmarks = quality.det.landmarks.positions;

          // Extract eye points and calculate EAR
          const leftEyePoints = extractEyePoints(landmarks, LEFT_EYE_INDICES);
          const rightEyePoints = extractEyePoints(landmarks, RIGHT_EYE_INDICES);

          clientLeftEAR = calculateEAR(leftEyePoints);
          clientRightEAR = calculateEAR(rightEyePoints);
          clientEAR = (clientLeftEAR + clientRightEAR) / 2.0;

          // Update client-side blink state machine
          const now = Date.now();
          clientBlinkState = BlinkStateMachine.update(
            clientEAR,
            clientLeftEAR,
            clientRightEAR,
            now
          );
        }

        // Draw face ring overlay
        drawFaceRing(overlayCanvas, video, quality, false);

        // Debug EAR visualization — hidden in the customer flow (enable with ?debug=ear)
        if (EAR_DEBUG_ENABLED) {
          let earVizCanvas = document.getElementById('login-ear-viz-canvas');
          if (!earVizCanvas) {
            earVizCanvas = document.createElement('canvas');
            earVizCanvas.id = 'login-ear-viz-canvas';
            earVizCanvas.style.cssText =
              'position:absolute;top:0;left:0;pointer-events:none;width:100%;height:100%;z-index:3;';
            if (video.parentElement) {
              video.parentElement.style.position = 'relative';
              video.parentElement.appendChild(earVizCanvas);
            }
          }
          if (earVizCanvas && clientBlinkState && challenge) {
            drawEARVisualization(
              earVizCanvas,
              video,
              clientLeftEAR,
              clientRightEAR,
              clientEAR,
              clientBlinkState,
              challenge.challengeType
            );
          }
        }

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
        // Use server's stage (1-5) for the 5-stage checklist
        const stage = serverRes.stage || serverRes.current_step || 1;
        const stageLabel = serverRes.stage_label || '';

        // Update checklist with proper stage labels
        updateChecklistStepWithLabels('login', stage, stageLabel);

        // Blink count from server (authoritative)
        if (typeof serverRes.blink_count === 'number') {
          updateBlinkDots('login', serverRes.blink_count);
        }

        if (serverRes.instruction) {
          const stateClass = serverRes.quality_ok ? 'info' : 'warning';
          setBannerStatus('login', serverRes.instruction, stateClass, true);
        }

        // ── EARLY FACE RECOGNITION FEEDBACK (server-side, preliminary) ────────
        // The server matched the live face against enrolled templates while the
        // user is still in frame — announced once, before the blink challenge.
        // The final authoritative match still happens at verify-challenge.
        if (serverRes.faceRecognized && !faceRecognizedAnnounced) {
          faceRecognizedAnnounced = true;
          setBannerStatus(
            'login',
            `Face recognized — now complete the blink challenge${serverRes.recognizedName ? `, ${serverRes.recognizedName}` : ''}.`,
            'ok',
            true
          );
        }

        // ── STAGE 4: IDENTITY MATCH (server says liveness done, ready for face match) ─────
        if (serverRes.stage === 4 || (serverRes.live && !serverRes.face_descriptor)) {
          _loginActive = false;
          updateChecklistStepWithLabels('login', 4, 'Identity Match');
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

            updateChecklistStepWithLabels('login', 5, 'Authorized');
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
            setBannerStatus(
              'login',
              'We could not confidently verify you. Please try again.',
              'bad',
              true
            );
            if (retryBtn) retryBtn.style.display = '';
          }
          return;
        }

        // ── STAGE 5: AUTHORIZED (server confirms everything) ──────────────────────
        if (serverRes.stage === 5 || (serverRes.live && serverRes.face_descriptor)) {
          _loginActive = false;
          updateChecklistStepWithLabels('login', 5, 'Authorized');
          updateBlinkDots('login', 2);
          setBannerStatus('login', '✅ Identity verified — entering portal…', 'ok', true);

          // If server already returned biometricToken (some flows), use it directly
          if (serverRes.biometricToken) {
            try {
              const authRes = await window.iCashApi.loginBiometric(serverRes.biometricToken);
              if (authRes.ok && authRes.user) {
                window.currentUser = authRes.user;
                if (typeof currentUser !== 'undefined') currentUser = authRes.user;
                sessionStorage.setItem('icash_session_active', 'true');
                enterDashboard();
              }
            } catch (e) {
              // Fall through to verifyChallenge
            }
          } else {
            const verifyPayload = {
              challengeId: challenge.challengeId,
              nonce: challenge.nonce,
            };
            if (targetUser && targetUser.id) verifyPayload.userId = targetUser.id;

            const verifyRes = await window.iCashApi.verifyChallenge(verifyPayload);
            if (verifyRes && verifyRes.ok && verifyRes.biometricToken) {
              const authRes = await window.iCashApi.loginBiometric(verifyRes.biometricToken);
              if (authRes.ok && authRes.user) {
                window.currentUser = authRes.user;
                if (typeof currentUser !== 'undefined') currentUser = authRes.user;
                sessionStorage.setItem('icash_session_active', 'true');
                enterDashboard();
              }
            }
          }
          CameraManager.stop(video);
          _loginAttempts = 0;
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
          setBannerStatus(
            'login',
            'Presentation attack detected. Please use your live face.',
            'bad',
            true
          );
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
        setBannerStatus(
          'login',
          'Network connection lost. Check your connection and tap Retry.',
          'bad',
          true
        );
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
  BlinkStateMachine.reset();
  const video = document.getElementById('login-video');
  CameraManager.stop(video);
  const oc = document.getElementById('login-overlay-canvas');
  if (oc) oc.getContext('2d').clearRect(0, 0, oc.width, oc.height);
  const earViz = document.getElementById('login-ear-viz-canvas');
  if (earViz) earViz.getContext('2d').clearRect(0, 0, earViz.width, earViz.height);
}

function captureLoginFace() {
  setBannerStatus(
    'login',
    'Automatic secure scan is active. Keep your face in frame and follow the blink prompt.',
    'info',
    true
  );
}

// ==============================================================================
// 2. TRANSACTION BIOMETRIC GATE (SERVER-AUTHORITATIVE)
// ==============================================================================
let _gateActive = false;

async function launchBiometricGate(title, lead) {
  document.getElementById('verify-title').textContent = title || 'Authorize Transaction';
  document.getElementById('verify-lead').textContent =
    lead || 'Please complete server biometric verification';
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

            // Face+biometric path authorized this transaction — record the
            // method for the audit trail before executing.
            if (pendingVerificationAction) pendingVerificationAction.verifyMethod = 'FACE';
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
          setBannerStatus(
            'reg',
            `Capturing face sample ${descriptors.length}/${ENROLL_SAMPLES}…`,
            'info'
          );
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
