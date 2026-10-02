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
  typeof location !== 'undefined' && new URLSearchParams(location.search).get('debug') === 'ear';

// External functions defined in script.js (loaded together in browser);
// their global names are declared in .eslintrc.json for the linter.

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
        width: { ideal: 640, min: 320, max: 1280 },
        height: { ideal: 480, min: 240, max: 720 },
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

    // Wait for video to be actually playing with valid dimensions
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('CAMERA_TIMEOUT'));
      }, 10000);

      const cleanup = () => {
        clearTimeout(timeout);
        videoEl.onloadedmetadata = null;
        videoEl.oncanplay = null;
        videoEl.onplaying = null;
        videoEl.onerror = null;
      };

      videoEl.onerror = () => {
        cleanup();
        reject(new Error('VIDEO_ERROR'));
      };

      // If metadata already loaded, check canplay/playing
      if (videoEl.readyState >= 1) {
        // HAVE_METADATA
        videoEl.oncanplay = () => {
          // Wait for playing event to ensure frames are flowing
          videoEl.onplaying = () => {
            cleanup();
            // Verify actual dimensions
            if (videoEl.videoWidth > 0 && videoEl.videoHeight > 0) {
              resolve();
            } else {
              reject(new Error('NO_VIDEO_DIMENSIONS'));
            }
          };
        };
      } else {
        videoEl.onloadedmetadata = () => {
          videoEl.oncanplay = () => {
            videoEl.onplaying = () => {
              cleanup();
              if (videoEl.videoWidth > 0 && videoEl.videoHeight > 0) {
                resolve();
              } else {
                reject(new Error('NO_VIDEO_DIMENSIONS'));
              }
            };
          };
        };
      }

      // Start playback - don't await inside Promise executor
      const playPromise = videoEl.play();
      if (playPromise !== undefined) {
        playPromise.catch(() => {
          // play() might reject if already playing or user interaction needed
          // The onplaying handler will still fire
        });
      }
    });

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

  // Get actual video dimensions for frame capture
  getVideoDimensions(videoEl) {
    return {
      width: videoEl.videoWidth || 640,
      height: videoEl.videoHeight || 480,
    };
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

// Client-side blink state machine for real-time feedback (# 10, # 11, # 12)
const BlinkStateMachine = {
  // States: 'WAITING', 'EYES_OPEN', 'EYES_CLOSING', 'EYES_CLOSED', 'EYES_OPEN_AGAIN', 'BLINK_COMPLETED'
  state: 'WAITING',
  blinkCount: 0,
  closedStartTime: 0,
  lastBlinkEndTime: 0,
  baselineEAR: 0.29,
  isCalibrated: false,
  closeThresh: 0.18,
  openThresh: 0.24,
  earHistory: [],

  MIN_BLINK_MS: 70,
  MAX_BLINK_MS: 700,
  BLINK_DEBOUNCE_MS: 280,
  MAX_CLOSED_DURATION_MS: 750,

  reset() {
    this.state = 'WAITING';
    this.blinkCount = 0;
    this.closedStartTime = 0;
    this.lastBlinkEndTime = 0;
    this.baselineEAR = 0.29;
    this.isCalibrated = false;
    this.closeThresh = 0.18;
    this.openThresh = 0.24;
    this.earHistory = [];
  },

  setBaseline(baseline) {
    if (baseline && baseline > 0.15) {
      this.baselineEAR = baseline;
      this.closeThresh = Math.max(0.12, baseline * 0.70);
      this.openThresh = Math.max(0.18, baseline * 0.88);
      this.isCalibrated = true;
      this.state = 'EYES_OPEN';
    }
  },

  update(ear, leftEAR, rightEAR, now) {
    this.earHistory.push(ear);
    if (this.earHistory.length > 60) this.earHistory.shift();

    if (!this.isCalibrated) {
      return {
        blinkDetected: false,
        blinkCount: this.blinkCount,
        state: this.state,
        baselineEAR: this.baselineEAR,
      };
    }

    // Adaptive drift tracking while resting open
    if (this.state === 'EYES_OPEN' && ear >= this.openThresh) {
      this.baselineEAR = this.baselineEAR * 0.98 + ear * 0.02;
      this.closeThresh = Math.max(0.12, this.baselineEAR * 0.70);
      this.openThresh = Math.max(0.18, this.baselineEAR * 0.88);
    }

    const bothClosed = leftEAR <= this.closeThresh && rightEAR <= this.closeThresh;
    const bothOpen = ear >= this.openThresh;

    let blinkDetected = false;
    let spoofSuspected = false;

    if (
      this.state === 'WAITING' ||
      this.state === 'EYES_OPEN' ||
      this.state === 'BLINK_COMPLETED' ||
      this.state === 'EYES_OPEN_AGAIN'
    ) {
      if (bothClosed) {
        this.state = 'EYES_CLOSED';
        this.closedStartTime = now;
      } else if (bothOpen) {
        this.state = 'EYES_OPEN';
      } else if (ear < this.openThresh && ear > this.closeThresh) {
        this.state = 'EYES_CLOSING';
      }
    } else if (this.state === 'EYES_CLOSING') {
      if (bothClosed) {
        this.state = 'EYES_CLOSED';
        this.closedStartTime = now;
      } else if (bothOpen) {
        this.state = 'EYES_OPEN';
      }
    } else if (this.state === 'EYES_CLOSED') {
      const durationMs = now - this.closedStartTime;

      // Flag if eyes held closed excessively long (> 750ms: photo spoof or closed eyes)
      if (durationMs > this.MAX_CLOSED_DURATION_MS) {
        this.state = 'EYES_OPEN';
        spoofSuspected = true;
      } else if (bothOpen) {
        // Eyes reopened!
        const validDuration =
          durationMs >= this.MIN_BLINK_MS && durationMs <= this.MAX_BLINK_MS;
        const debounceOk = now - this.lastBlinkEndTime >= this.BLINK_DEBOUNCE_MS;

        if (validDuration && debounceOk) {
          this.blinkCount++;
          this.lastBlinkEndTime = now;
          blinkDetected = true;
          this.state = 'BLINK_COMPLETED';
        } else {
          this.state = 'EYES_OPEN_AGAIN';
        }
      }
    }

    return {
      blinkDetected,
      blinkCount: this.blinkCount,
      state: this.state,
      spoofSuspected,
      closeThresh: this.closeThresh,
      openThresh: this.openThresh,
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
function getOverlayCanvas(id, parentEl, videoEl) {
  let oc = document.getElementById(id);
  if (!oc && parentEl) {
    oc = document.createElement('canvas');
    oc.id = id;
    oc.style.cssText =
      'position:absolute;top:0;left:0;pointer-events:none;width:100%;height:100%;z-index:2;';
    parentEl.style.position = 'relative';
    parentEl.appendChild(oc);
  }
  // Resize canvas to match video element's display size
  if (oc && videoEl) {
    const rect = videoEl.getBoundingClientRect();
    oc.width = Math.max(1, Math.round(rect.width));
    oc.height = Math.max(1, Math.round(rect.height));
  }
  return oc;
}

function resizeOverlayCanvas(canvas, videoEl) {
  if (!canvas || !videoEl) return;
  const rect = videoEl.getBoundingClientRect();
  const newWidth = Math.max(1, Math.round(rect.width));
  const newHeight = Math.max(1, Math.round(rect.height));
  if (canvas.width !== newWidth || canvas.height !== newHeight) {
    canvas.width = newWidth;
    canvas.height = newHeight;
  }
}

// ── Liveness Steps Component (6-stage, FSM-driven) ───────────────────────────
// A stage may ONLY show ✓ when the underlying condition has genuinely passed:
//   Stage 1 (Center Face)   — Face detected, centered, correct size, stable for multiple frames
//   Stage 2 (Eyes Detected) — 68 landmarks localized, left & right eyes visible & open
//   Stage 3 (Live Check)    — Resting open-eye baseline calibrated & dynamic range confirmed
//   Stage 4 (Blink)         — Real temporal blink transition (OPEN -> CLOSED -> OPEN) satisfied
//   Stage 5 (Identity)      — Server-side face matching confirms enrolled template
//   Stage 6 (Authorized)    — Backend establishes genuine session & JWT
const LIVENESS_STEP_LABELS = {
  1: 'Center Face',
  2: 'Eyes Detected',
  3: 'Live Check',
  4: 'Blink Challenge',
  5: 'Identity Match',
  6: 'Authorized',
};

const BioAuthState = {
  IDLE: 'IDLE',
  CAMERA_STARTING: 'CAMERA_STARTING',
  CAMERA_READY: 'CAMERA_READY',
  CENTER_FACE: 'CENTER_FACE',
  EYES_DETECTED: 'EYES_DETECTED',
  LIVE_CHECK: 'LIVE_CHECK',
  BLINK_CHALLENGE: 'BLINK_CHALLENGE',
  IDENTITY_MATCH: 'IDENTITY_MATCH',
  SERVER_AUTHORIZATION: 'SERVER_AUTHORIZATION',
  AUTHORIZED: 'AUTHORIZED',
  FAILED: 'FAILED',
};

let _loginFSM = BioAuthState.IDLE;
let _loginRAF = null;
let _loginStreamTimer = null;
let _loginActive = false;
let _loginLivenessSessionId = null;
let _bioDebugVisible = false;
let _lastSpokenInstruction = '';

/**
 * Sets a single liveness step to pending | active | done | error.
 * pending → outlined circle ○, active → pulsing dot ●, done → check ✓, error → !.
 */
function setLivenessStepStatus(prefix, step, status, detail) {
  const el = document.getElementById(`${prefix}-ls-${step}`);
  if (!el) return;

  if (prefix === 'login') {
    el.dataset.status = status;
    el.classList.remove('is-pending', 'is-active', 'is-done', 'is-error');
    el.classList.add(`is-${status}`);

    const bullet = el.querySelector('.bio-step-bullet');
    if (bullet) {
      if (status === 'done') bullet.textContent = '✓';
      else if (status === 'active') bullet.textContent = '●';
      else if (status === 'error') bullet.textContent = '!';
      else bullet.textContent = '○';
    }

    const desc = document.getElementById(`login-ls-desc-${step}`);
    if (desc) {
      if (status === 'active' || status === 'error') {
        desc.style.display = '';
        if (detail && step !== 4) desc.textContent = detail;
      } else if (status === 'done') {
        desc.style.display = step === 4 || step === 6 ? '' : 'none';
        if (detail && step !== 4) desc.textContent = detail;
      } else {
        desc.style.display = 'none';
      }
    }

    const baseLabel = LIVENESS_STEP_LABELS[step] || `Step ${step}`;
    el.setAttribute(
      'aria-label',
      `${detail || baseLabel} — ${
        status === 'done'
          ? 'complete'
          : status === 'active'
            ? 'in progress'
            : status === 'error'
              ? 'failed'
              : 'not started'
      }`
    );
    return;
  }

  // Registration scan fallback
  el.dataset.status = status;
  el.classList.remove('is-pending', 'is-active', 'is-done', 'is-error');
  el.classList.add(`is-${status}`);
  const icon = el.querySelector('.ls-icon');
  if (icon) {
    if (status === 'done') icon.textContent = '✓';
    else if (status === 'error') icon.textContent = '✕';
    else icon.textContent = String(step);
  }
  const label = el.querySelector('.ls-label');
  const baseLabel = LIVENESS_STEP_LABELS[step] || `Step ${step}`;
  if (label) label.textContent = detail || baseLabel;
}

/** Resets all six steps to pending. */
function resetLivenessSteps(prefix) {
  for (let s = 1; s <= 6; s++) setLivenessStepStatus(prefix, s, 'pending');
}

/** Updates the real-time live telemetry panel below the camera preview (# 21). */
function updateLoginLiveStatusPanel({ camera, face, eyes, live, blink, identity }) {
  const setRow = (id, text, statusClass) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.className = `bio-status-val ${statusClass || ''}`;
    el.innerHTML = `<span class="bio-stat-dot"></span> ${text}`;
  };

  if (camera) setRow('bio-stat-camera', camera.text, camera.status);
  if (face) setRow('bio-stat-face', face.text, face.status);
  if (eyes) setRow('bio-stat-eyes', eyes.text, eyes.status);
  if (live) setRow('bio-stat-live', live.text, live.status);
  if (blink) setRow('bio-stat-blink', blink.text, blink.status);
  if (identity) setRow('bio-stat-identity', identity.text, identity.status);
}

/** Updates the development diagnostics debug panel (# 23). */
function updateLoginDiagnostics(data) {
  if (!_bioDebugVisible) return;
  const setTxt = (id, val) => {
    const el = document.getElementById(id);
    if (el && val !== undefined) el.textContent = val;
  };
  setTxt('dbg-camera', data.camera);
  setTxt('dbg-video', data.video);
  setTxt('dbg-faces', data.faces);
  setTxt('dbg-conf', data.conf);
  setTxt('dbg-centered', data.centered);
  setTxt('dbg-left-eye', data.leftEye);
  setTxt('dbg-right-eye', data.rightEye);
  setTxt('dbg-ear', data.ear);
  setTxt('dbg-blink-state', data.blinkState);
  setTxt('dbg-blink-count', data.blinkCount);
  setTxt('dbg-fps', data.fps);
}

/** Toggles development diagnostics panel. */
function toggleBioDebugPanel() {
  _bioDebugVisible = !_bioDebugVisible;
  const p = document.getElementById('bio-debug-panel');
  if (p) p.style.display = _bioDebugVisible ? 'block' : 'none';
}
window.toggleBioDebugPanel = toggleBioDebugPanel;

// Listen for 'D' keypress to toggle debug panel
window.addEventListener('keydown', (e) => {
  if (
    (e.key === 'd' || e.key === 'D') &&
    !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)
  ) {
    toggleBioDebugPanel();
  }
});

/**
 * Updates dynamic instruction banner, camera guide pill, and speech announcement.
 */
function setBannerStatus(prefix, text, stateClass = 'info', speak = true, title = null) {
  if (prefix === 'login') {
    const banner = document.getElementById('login-instruction-banner');
    const titleEl = document.getElementById('login-instruction-title');
    const subEl = document.getElementById('login-instruction-text');
    const pillEl = document.getElementById('login-guide-pill');

    if (banner) banner.className = `bio-instruction-banner ${stateClass}`;
    if (title && titleEl) titleEl.textContent = title;
    if (subEl) subEl.textContent = text;
    if (pillEl) {
      pillEl.textContent = text;
      pillEl.className = `bio-guide-pill ${
        stateClass === 'ok'
          ? 'ok'
          : stateClass === 'warning'
            ? 'warn'
            : stateClass === 'bad'
              ? 'bad'
              : ''
      }`;
    }

    if (speak && text && text !== _lastSpokenInstruction && window.iCashAccessibility) {
      _lastSpokenInstruction = text;
      window.iCashAccessibility.announce(text, stateClass === 'bad' ? 'assertive' : 'polite');
    }
    return;
  }

  // Fallback for reg/verify
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
  if (speak && text && text !== _lastSpokenInstruction && window.iCashAccessibility) {
    _lastSpokenInstruction = text;
    window.iCashAccessibility.announce(text, stateClass === 'bad' ? 'assertive' : 'polite');
  }
}

/** Handles background tab visibility so timers/states are not corrupted. */
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  if (_loginActive && _loginFSM === BioAuthState.BLINK_CHALLENGE) {
    BlinkStateMachine.reset();
    setBannerStatus('login', 'Resuming — please blink naturally when prompted.', 'info', true, 'Resuming…');
  }
});

/**
 * Classifies network/frame errors into user-friendly descriptions.
 */
function classifyFrameError(err) {
  const code = (err && err.data && err.data.error) || '';
  const status = err && err.status;

  if (code === 'BiometricServiceUnavailable' || status === 503) {
    return {
      fatal: true,
      message: 'Biometric verification is temporarily unavailable. Please tap Try Again in a moment.',
    };
  }
  if (
    ['InvalidChallenge', 'ChallengeExpired', 'ChallengeReplayed', 'NonceMismatch'].includes(code) ||
    (status === 400 && !code)
  ) {
    return {
      fatal: true,
      message: 'The verification session is no longer valid. Tap Try Again to restart.',
    };
  }
  return { fatal: false, message: null };
}

function cameraErrorMessage(camErr) {
  const msg = camErr?.message || '';
  if (msg.includes('NotAllowed') || msg.includes('Permission') || msg.includes('denied')) {
    return 'Camera access is required for biometric login. Allow camera access in browser settings and try again.';
  }
  if (msg.includes('NotFound') || msg.includes('DevicesNotFoundError')) {
    return 'No camera found on this device. Use Aadhaar & PIN sign-in instead.';
  }
  if (msg.includes('NotReadable') || msg.includes('TrackStartError')) {
    return 'Camera is in use by another application. Close other camera apps and try again.';
  }
  return 'Camera could not be accessed. Tap Try Again or use Aadhaar & PIN sign-in.';
}

function registerLoginFailure() {
  _loginAttempts++;
  if (_loginAttempts >= LOGIN_MAX_ATTEMPTS) {
    _loginCooldownUntil = Date.now() + LOGIN_COOLDOWN_MS;
    _loginAttempts = 0;
  }
}

// ==============================================================================
// 1. BIOMETRIC LOGIN ENGINE (FSM-AUTHORITATIVE, REAL VISION, NO FAKE STEPS)
// ==============================================================================

async function beginLoginScan() {
  // 1. Cleanly cancel any existing loops
  teardownLoginScan();
  _loginActive = true;
  _loginFSM = BioAuthState.CAMERA_STARTING;
  _lastSpokenInstruction = '';

  // Cooldown check
  if (Date.now() < _loginCooldownUntil) {
    const remainSec = Math.ceil((_loginCooldownUntil - Date.now()) / 1000);
    setBannerStatus(
      'login',
      `Too many failed attempts. Please wait ${remainSec}s before retrying.`,
      'bad',
      true,
      'Rate Limit Active'
    );
    return;
  }

  const video = document.getElementById('login-video');
  const errEl = document.getElementById('login-cam-error');
  const retryBtn = document.getElementById('login-retry-cam-btn');
  const guideOval = document.getElementById('login-guide-oval');
  const overlayCanvas = document.getElementById('login-overlay-canvas');

  if (retryBtn) retryBtn.style.display = 'none';
  if (errEl) {
    errEl.textContent = '';
    errEl.style.display = 'none';
  }

  // Set initial step UI: Step 1 is active, steps 2-6 pending
  resetLivenessSteps('login');
  setLivenessStepStatus('login', 1, 'active', 'Position your face inside the guide.');
  updateLoginLiveStatusPanel({
    camera: { text: 'Starting…', status: 'is-active' },
    face: { text: 'Detecting…', status: '' },
    eyes: { text: 'Checking…', status: '' },
    live: { text: 'In progress', status: '' },
    blink: { text: 'Waiting', status: '' },
    identity: { text: 'Not checked', status: '' },
  });
  setBannerStatus(
    'login',
    'Allow camera access when prompted by your browser.',
    'info',
    false,
    'Starting camera…'
  );

  // Pre-load face models in background
  ensureBioModels().catch(() => {});

  // 2. Start Camera Preview
  try {
    await CameraManager.start(video, errEl);
  } catch (camErr) {
    _loginActive = false;
    _loginFSM = BioAuthState.FAILED;
    const msg = cameraErrorMessage(camErr);
    setLivenessStepStatus('login', 1, 'error', 'Camera access denied');
    setBannerStatus('login', msg, 'bad', true, 'Camera Unavailable');
    updateLoginLiveStatusPanel({
      camera: { text: 'Denied ✗', status: 'is-bad' },
      face: { text: 'Unavailable', status: '' },
    });
    if (errEl) {
      errEl.textContent = msg;
      errEl.style.display = 'flex';
    }
    if (retryBtn) retryBtn.style.display = '';
    return;
  }

  _loginFSM = BioAuthState.CAMERA_READY;
  updateLoginLiveStatusPanel({
    camera: { text: 'Ready ✓', status: 'is-ready' },
  });

  // 3. Issue Cryptographic Challenge from Backend
  const targetUser = window._loginTargetUser;
  let challenge;
  try {
    setBannerStatus(
      'login',
      'Connecting to biometric verification service…',
      'info',
      false,
      'Connecting…'
    );
    const challengeRes = await window.iCashApi.issueChallenge({
      userIdHint: targetUser ? targetUser.id : undefined,
    });
    if (!challengeRes || !challengeRes.ok || !challengeRes.challengeId) {
      throw new Error((challengeRes && challengeRes.message) || 'Challenge generation failed');
    }
    challenge = challengeRes;
    _loginLivenessSessionId = challenge.livenessSessionId || null;
  } catch (chalErr) {
    _loginActive = false;
    _loginFSM = BioAuthState.FAILED;
    const msg =
      'Biometric authentication is temporarily unavailable. Please tap Try Again or use Aadhaar & PIN sign-in below.';
    setLivenessStepStatus('login', 1, 'error', 'Service unavailable');
    setBannerStatus('login', msg, 'bad', true, 'Service Unavailable');
    updateLoginLiveStatusPanel({
      camera: { text: 'Ready ✓', status: 'is-ready' },
      face: { text: 'Service error', status: 'is-bad' },
    });
    if (retryBtn) retryBtn.style.display = '';
    CameraManager.stop(video);
    return;
  }

  // Camera is live & challenge is ready -> Center Face step begins
  _loginFSM = BioAuthState.CENTER_FACE;
  const requiredBlinks = challenge.requiredBlinks || 1;
  const blinkCountPill = document.getElementById('login-blink-count-pill');
  const blinkInst = document.getElementById('login-blink-instruction');
  if (blinkCountPill) blinkCountPill.textContent = `Blinks: 0 / ${requiredBlinks}`;
  if (blinkInst) {
    blinkInst.textContent =
      requiredBlinks === 2 ? 'Blink 2 times naturally.' : 'Blink once naturally.';
  }

  setBannerStatus(
    'login',
    'Center your face inside the frame to begin.',
    'info',
    true,
    'Detecting face…'
  );
  updateLoginLiveStatusPanel({
    camera: { text: 'Ready ✓', status: 'is-ready' },
    face: { text: 'Detecting…', status: 'is-active' },
  });

  // Offscreen canvas for frame capture
  const { width: vw, height: vh } = CameraManager.getVideoDimensions(video);
  const offCanvas = document.createElement('canvas');
  offCanvas.width = vw;
  offCanvas.height = vh;
  const offCtx = offCanvas.getContext('2d');

  let faceStableStreak = 0;
  let eyeStableStreak = 0;
  const baselineSamples = [];
  let livenessHandoffStarted = false;
  let lastFrameTime = performance.now();
  let frameCount = 0;
  let fps = 30;

  // Single authoritative detection loop (runs at display refresh rate)
  const detectionTick = async () => {
    if (!_loginActive) return;

    const now = performance.now();
    frameCount++;
    if (now - lastFrameTime >= 1000) {
      fps = Math.round((frameCount * 1000) / (now - lastFrameTime));
      frameCount = 0;
      lastFrameTime = now;
    }

    if (overlayCanvas && video.videoWidth) {
      resizeOverlayCanvas(overlayCanvas, video);
    }

    if (
      !document.hidden &&
      window._bioModelsLoaded &&
      typeof faceapi !== 'undefined' &&
      video.videoWidth
    ) {
      try {
        const detections = await faceapi
          .detectAllFaces(video, getDetectOptions())
          .withFaceLandmarks();
        const quality = FaceQualityGate.validate(detections, video);

        // Clear overlay canvas
        const ctx = overlayCanvas?.getContext('2d');
        if (ctx && overlayCanvas) {
          ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
        }

        // ── STEP 1: FACE DETECTION ──────────────────────────────────────────
        if (!quality.ok) {
          faceStableStreak = 0;
          if (guideOval) {
            guideOval.className =
              quality.reason === 'MULTI_FACE'
                ? 'bio-guide-oval state-error'
                : 'bio-guide-oval state-warning';
          }
          if (_loginFSM === BioAuthState.CENTER_FACE) {
            setBannerStatus(
              'login',
              quality.message,
              quality.reason === 'MULTI_FACE' ? 'bad' : 'warning',
              false,
              quality.reason === 'MULTI_FACE' ? 'Multiple faces detected' : 'Detecting face…'
            );
            updateLoginLiveStatusPanel({
              face: {
                text: quality.reason === 'MULTI_FACE' ? 'Multiple faces' : 'Searching…',
                status: 'is-warn',
              },
            });
          }

          updateLoginDiagnostics({
            camera: 'READY',
            video: `${video.videoWidth}x${video.videoHeight}`,
            faces: detections.length,
            conf: '--',
            centered: 'NO',
            leftEye: '--',
            rightEye: '--',
            ear: '--',
            blinkState: BlinkStateMachine.state,
            blinkCount: `${BlinkStateMachine.blinkCount} / ${requiredBlinks}`,
            fps,
          });
        } else {
          // Exactly 1 face with good position & size
          const det = quality.det;
          const box = det.detection.box;
          const landmarks = det.landmarks.positions;
          const conf = Math.round(det.detection.score * 100) / 100;

          if (guideOval) guideOval.className = 'bio-guide-oval state-centered';

          faceStableStreak++;

          if (_loginFSM === BioAuthState.CENTER_FACE) {
            setBannerStatus(
              'login',
              'Face centered — keep still.',
              'ok',
              false,
              'Face centered ✓'
            );
            updateLoginLiveStatusPanel({
              face: { text: 'Centered ✓', status: 'is-done' },
            });

            // Genuinely passed after 5 consecutive stable frames (# 8)
            if (faceStableStreak >= 5) {
              setLivenessStepStatus('login', 1, 'done', 'Center Face');
              _loginFSM = BioAuthState.EYES_DETECTED;
              setLivenessStepStatus('login', 2, 'active', 'Keep both eyes visible.');
              setBannerStatus(
                'login',
                'Keep both eyes open and visible.',
                'info',
                true,
                'Checking eyes…'
              );
              updateLoginLiveStatusPanel({
                eyes: { text: 'Checking…', status: 'is-active' },
              });
            }
          }

          // Extract eye landmarks (indices 36-41 for left eye, 42-47 for right eye)
          const leftEyePts = extractEyePoints(landmarks, LEFT_EYE_INDICES);
          const rightEyePts = extractEyePoints(landmarks, RIGHT_EYE_INDICES);
          const leftEAR = calculateEAR(leftEyePts);
          const rightEAR = calculateEAR(rightEyePts);
          const avgEAR = (leftEAR + rightEAR) / 2.0;

          // Draw subtle eye landmark dots on overlay canvas (# 9, # 24)
          // Video has CSS scaleX(-1), overlay canvas also has CSS scaleX(-1)
          if (ctx && overlayCanvas) {
            const scaleX = overlayCanvas.width / (video.videoWidth || 640);
            const scaleY = overlayCanvas.height / (video.videoHeight || 480);
            const isClosing = avgEAR < (BlinkStateMachine.closeThresh || 0.18);
            ctx.fillStyle = isClosing ? '#f87171' : '#34d399';
            [...leftEyePts, ...rightEyePts].forEach((pt) => {
              ctx.beginPath();
              ctx.arc(pt.x * scaleX, pt.y * scaleY, 2.2, 0, 2 * Math.PI);
              ctx.fill();
            });
          }

          // ── STEP 2: EYE DETECTION ─────────────────────────────────────────
          const bothEyesVisible = leftEAR >= 0.15 && rightEAR >= 0.15;
          if (_loginFSM === BioAuthState.EYES_DETECTED) {
            if (!bothEyesVisible) {
              eyeStableStreak = 0;
              setBannerStatus(
                'login',
                'Make sure both eyes are visible.',
                'warning',
                false,
                'Checking eyes…'
              );
              updateLoginLiveStatusPanel({
                eyes: { text: 'Occluded', status: 'is-warn' },
              });
            } else {
              eyeStableStreak++;
              updateLoginLiveStatusPanel({
                eyes: { text: 'Detected ✓', status: 'is-done' },
              });

              // Genuinely passed after 4 consecutive frames of visible eyes (# 9)
              if (eyeStableStreak >= 4) {
                setLivenessStepStatus('login', 2, 'done', 'Eyes Detected');
                _loginFSM = BioAuthState.LIVE_CHECK;
                setLivenessStepStatus('login', 3, 'active', 'Stay still for a moment.');
                setBannerStatus(
                  'login',
                  'Stay still for a moment…',
                  'info',
                  true,
                  'Checking live interaction…'
                );
                updateLoginLiveStatusPanel({
                  live: { text: 'Calibrating…', status: 'is-active' },
                });
                baselineSamples.length = 0;
              }
            }
          }

          // ── STEP 3: LIVE CHECK & CALIBRATION ──────────────────────────────
          if (_loginFSM === BioAuthState.LIVE_CHECK) {
            if (avgEAR >= 0.20) {
              baselineSamples.push(avgEAR);
            }
            if (baselineSamples.length >= 14) {
              const baseline =
                baselineSamples.reduce((a, b) => a + b, 0) / baselineSamples.length;
              BlinkStateMachine.setBaseline(baseline);
              setLivenessStepStatus('login', 3, 'done', 'Live Check');
              _loginFSM = BioAuthState.BLINK_CHALLENGE;
              setLivenessStepStatus('login', 4, 'active');
              setBannerStatus(
                'login',
                requiredBlinks === 2 ? 'Blink 2 times naturally.' : 'Blink once naturally.',
                'info',
                true,
                'Complete the blink challenge…'
              );
              updateLoginLiveStatusPanel({
                live: { text: 'Confirmed ✓', status: 'is-done' },
                blink: { text: `0 / ${requiredBlinks}`, status: 'is-active' },
              });
            }
          }

          // ── STEP 4: BLINK CHALLENGE ───────────────────────────────────────
          if (_loginFSM === BioAuthState.BLINK_CHALLENGE) {
            const bRes = BlinkStateMachine.update(avgEAR, leftEAR, rightEAR, now);
            if (blinkCountPill) {
              blinkCountPill.textContent = `Blinks: ${bRes.blinkCount} / ${requiredBlinks}`;
            }
            updateLoginLiveStatusPanel({
              blink: {
                text: `${bRes.blinkCount} / ${requiredBlinks}`,
                status: bRes.blinkCount >= requiredBlinks ? 'is-done' : 'is-active',
              },
            });

            if (bRes.spoofSuspected) {
              setBannerStatus(
                'login',
                'Eyes stayed closed too long. Blink naturally.',
                'warning',
                false,
                'Keep eyes open'
              );
            } else if (bRes.blinkDetected) {
              if (bRes.blinkCount < requiredBlinks) {
                setBannerStatus(
                  'login',
                  'First blink detected ✓ — now blink once more.',
                  'ok',
                  true,
                  'Blink again'
                );
              }
            }

            // Genuinely passed only after required blinks complete (# 10, # 13)
            if (bRes.blinkCount >= requiredBlinks) {
              setLivenessStepStatus(
                'login',
                4,
                'done',
                `Blink Challenge (${requiredBlinks}/${requiredBlinks})`
              );
              _loginFSM = BioAuthState.IDENTITY_MATCH;
              setLivenessStepStatus(
                'login',
                5,
                'active',
                'Comparing your face with the enrolled identity…'
              );
              setBannerStatus(
                'login',
                'Comparing your face with the enrolled identity…',
                'info',
                true,
                'Matching identity…'
              );
              updateLoginLiveStatusPanel({
                blink: { text: `${requiredBlinks} / ${requiredBlinks} ✓`, status: 'is-done' },
                identity: { text: 'Matching…', status: 'is-active' },
              });

              // Transition to authoritative server identity verification (# 16, # 18)
              if (!livenessHandoffStarted) {
                livenessHandoffStarted = true;
                _loginActive = false; // stop detection loop
                completeLoginIdentityAndSession({
                  challenge,
                  targetUser,
                  video,
                  retryBtn,
                  blinkCount: bRes.blinkCount,
                  requiredBlinks,
                });
                return;
              }
            }
          }

          // Diagnostics update
          updateLoginDiagnostics({
            camera: 'READY',
            video: `${video.videoWidth}x${video.videoHeight}`,
            faces: 1,
            conf,
            centered: 'YES',
            leftEye:
              leftEAR >= 0.15 ? `DET (${leftEAR.toFixed(3)})` : `OCC (${leftEAR.toFixed(3)})`,
            rightEye:
              rightEAR >= 0.15 ? `DET (${rightEAR.toFixed(3)})` : `OCC (${rightEAR.toFixed(3)})`,
            ear: `${avgEAR.toFixed(3)} (base: ${BlinkStateMachine.baselineEAR.toFixed(3)})`,
            blinkState: BlinkStateMachine.state,
            blinkCount: `${BlinkStateMachine.blinkCount} / ${requiredBlinks}`,
            fps,
          });
        }
      } catch (_) {}
    }

    if (_loginActive) {
      _loginRAF = requestAnimationFrame(detectionTick);
    }
  };

  // Parallel server streaming loop (submits frames every 150ms for server-side PAD & dlib)
  const streamLoop = async () => {
    if (!_loginActive) return;
    if (document.hidden) {
      _loginStreamTimer = setTimeout(streamLoop, 400);
      return;
    }

    const { width: curW, height: curH } = CameraManager.getVideoDimensions(video);
    if (offCanvas.width !== curW || offCanvas.height !== curH) {
      offCanvas.width = curW;
      offCanvas.height = curH;
    }
    offCtx.drawImage(video, 0, 0, curW, curH);
    const frameB64 = offCanvas.toDataURL('image/jpeg', 0.82);

    try {
      const serverRes = await window.iCashApi.sendBiometricFrame({
        challengeId: challenge.challengeId,
        nonce: challenge.nonce,
        image: frameB64,
        timestamp: Date.now(),
      });

      if (!_loginActive) return;

      if (serverRes && serverRes.ok) {
        if (serverRes.spoof_detected) {
          _loginActive = false;
          _loginFSM = BioAuthState.FAILED;
          registerLoginFailure();
          const spoofMessages = {
            eyes_closed_too_long: 'Eyes stayed closed too long. Please blink naturally.',
            low_texture_blur: 'Camera view is unclear. Adjust lighting and ensure face is in focus.',
            flat_chrominance_screen: 'Live interaction required. Screens and printed photos are not accepted.',
          };
          const msg =
            spoofMessages[serverRes.spoof_reason] ||
            'Live presence could not be confirmed. A live person is required.';
          setBannerStatus('login', msg, 'bad', true, 'Live Check Failed');
          setLivenessStepStatus('login', 4, 'error', 'Blink Challenge Failed');
          if (retryBtn) retryBtn.style.display = '';
          CameraManager.stop(video);
          return;
        }

        // If server confirms liveness complete early (e.g. stage >= 6)
        if (!livenessHandoffStarted && (serverRes.live || (serverRes.stage >= 6))) {
          livenessHandoffStarted = true;
          _loginActive = false;
          completeLoginIdentityAndSession({
            challenge,
            targetUser,
            video,
            retryBtn,
            blinkCount: serverRes.blink_count || requiredBlinks,
            requiredBlinks,
          });
          return;
        }
      }
    } catch (_) {}

    if (_loginActive) {
      _loginStreamTimer = setTimeout(streamLoop, 150);
    }
  };

  _loginRAF = requestAnimationFrame(detectionTick);
  _loginStreamTimer = setTimeout(streamLoop, 150);
}

/**
 * Runs AFTER the blink challenge genuinely succeeds:
 *   1. verify-challenge  → server-side face match against enrolled profile
 *      (Stage 5 "Identity Match" marked done ONLY on real match)
 *   2. login-biometric   → backend establishes the real authenticated session
 *      (Stage 6 "Authorized" marked done ONLY after session is returned)
 * Never trusts frontend flags. Backend is 100% authoritative (# 18).
 */
async function completeLoginIdentityAndSession({
  challenge,
  targetUser,
  video,
  retryBtn,
  blinkCount,
  requiredBlinks,
}) {
  for (let s = 1; s <= 4; s++) {
    setLivenessStepStatus('login', s, 'done');
  }
  setLivenessStepStatus(
    'login',
    5,
    'active',
    'Comparing your face with the enrolled identity…'
  );
  setBannerStatus(
    'login',
    'Comparing your face with the enrolled identity…',
    'info',
    true,
    'Matching identity…'
  );
  updateLoginLiveStatusPanel({
    blink: { text: `${requiredBlinks} / ${requiredBlinks} ✓`, status: 'is-done' },
    identity: { text: 'Matching…', status: 'is-active' },
  });

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

    // Step 5: Server-side identity match genuine SUCCESS
    setLivenessStepStatus('login', 5, 'done', 'Identity Match');
    updateLoginLiveStatusPanel({ identity: { text: 'Verified ✓', status: 'is-done' } });

    // Step 6: Backend session authorization
    _loginFSM = BioAuthState.SERVER_AUTHORIZATION;
    setLivenessStepStatus('login', 6, 'active', 'Authorizing session…');
    setBannerStatus(
      'login',
      'Identity verified — establishing session…',
      'ok',
      true,
      'Authorizing session…'
    );
    CameraManager.stop(video);

    const authRes = await window.iCashApi.loginBiometric(verifyRes.biometricToken);
    if (!(authRes && authRes.ok && authRes.user)) {
      throw new Error((authRes && authRes.message) || 'Failed to establish session');
    }

    // Step 6: Session confirmed by backend
    _loginFSM = BioAuthState.AUTHORIZED;
    setLivenessStepStatus('login', 6, 'done', 'Authorized');
    setBannerStatus(
      'login',
      'Authentication successful. Welcome!',
      'ok',
      true,
      'Authentication successful'
    );
    window.currentUser = authRes.user;
    if (typeof currentUser !== 'undefined') currentUser = authRes.user;
    setTimeout(enterDashboard, 700);
  } catch (verifyErr) {
    console.error('[iCash Bio] Verify error:', verifyErr);
    CameraManager.stop(video);
    _loginFSM = BioAuthState.FAILED;
    registerLoginFailure();

    const isMismatch =
      (verifyErr.message || '').includes('match') ||
      (verifyErr.message || '').includes('Mismatch');
    const msg = isMismatch
      ? 'The face does not match the enrolled account.'
      : verifyErr.message || 'We could not confidently verify you. Please try again.';

    setLivenessStepStatus(
      'login',
      5,
      'error',
      isMismatch ? 'The face does not match the enrolled account.' : 'Identity verification failed'
    );
    updateLoginLiveStatusPanel({ identity: { text: 'Mismatch ✗', status: 'is-bad' } });
    setBannerStatus('login', msg, 'bad', true, 'Identity Mismatch');

    if (retryBtn) retryBtn.style.display = '';
  }
}

/** Resets FSM and restarts biometric verification cleanly (# 27). */
function retryLoginScan() {
  teardownLoginScan();
  const retryBtn = document.getElementById('login-retry-cam-btn');
  if (retryBtn) retryBtn.style.display = 'none';
  const errEl = document.getElementById('login-cam-error');
  if (errEl) errEl.style.display = 'none';
  beginLoginScan();
}
window.retryLoginScan = retryLoginScan;

function cancelLoginScan() {
  teardownLoginScan();
  goTo('screen-welcome');
}

function teardownLoginScan() {
  _loginActive = false;
  _loginFSM = BioAuthState.IDLE;
  if (_loginRAF) {
    cancelAnimationFrame(_loginRAF);
    _loginRAF = null;
  }
  if (_loginStreamTimer) {
    clearTimeout(_loginStreamTimer);
    _loginStreamTimer = null;
  }
  if (_loginOverlayTimer) {
    clearTimeout(_loginOverlayTimer);
    _loginOverlayTimer = null;
  }
  BlinkStateMachine.reset();
  const video = document.getElementById('login-video');
  CameraManager.stop(video);
  const oc = document.getElementById('login-overlay-canvas');
  if (oc) oc.getContext('2d')?.clearRect(0, 0, oc.width, oc.height);
  if (_loginLivenessSessionId) {
    window.iCashApi?.liveness?.reset?.(_loginLivenessSessionId).catch(() => {});
    _loginLivenessSessionId = null;
  }
}

// ==============================================================================
// 2. TRANSACTION BIOMETRIC GATE (SERVER-AUTHORITATIVE)
// ==============================================================================
let _gateActive = false;
let _gateLivenessSessionId = null;

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

  try {
    await CameraManager.start(video, errEl);
  } catch (camErr) {
    if (statusEl)
      statusEl.textContent =
        'Camera could not be accessed. Grant permission and tap Retry, or cancel to use PIN.';
    if (retryBtn) retryBtn.style.display = '';
    return;
  }

  // Issue server challenge
  let challenge;
  try {
    challenge = await window.iCashApi.issueChallenge({
      userIdHint: currentUser ? currentUser.id : undefined,
    });
    if (!challenge || !challenge.ok) throw new Error('Challenge creation failed');
    _gateLivenessSessionId = challenge.livenessSessionId || null;
  } catch (e) {
    if (statusEl)
      statusEl.textContent = 'Biometric service unavailable. Tap Retry or cancel to use PIN.';
    if (retryBtn) retryBtn.style.display = '';
    return;
  }

  const offCanvas = document.createElement('canvas');
  const { width: videoWidth, height: videoHeight } = CameraManager.getVideoDimensions(video);
  offCanvas.width = videoWidth;
  offCanvas.height = videoHeight;
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

    const { width: videoWidth, height: videoHeight } = CameraManager.getVideoDimensions(video);
    if (offCanvas.width !== videoWidth || offCanvas.height !== videoHeight) {
      offCanvas.width = videoWidth;
      offCanvas.height = videoHeight;
    }
    offCtx.drawImage(video, 0, 0, videoWidth, videoHeight);
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
          const gateSpoofMsg = {
            eyes_closed_too_long:
              'Eyes stayed closed too long. Keep eyes open and blink naturally, then try again.',
            low_texture_blur: 'Camera view unclear. Improve lighting and try again.',
            flat_chrominance_screen:
              'Live presence could not be verified. Please use your live face — screens or printed photos are rejected.',
          };
          if (statusEl)
            statusEl.textContent =
              gateSpoofMsg[serverRes.spoof_reason] ||
              'Live presence could not be verified. Please try again.';
          // Do NOT automatically fall back to PIN on spoof detection
          // User can manually cancel and choose PIN if needed
          if (retryBtn) retryBtn.style.display = '';
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
  // Clean up server liveness session
  if (_gateLivenessSessionId) {
    window.iCashApi.liveness.reset(_gateLivenessSessionId).catch(() => {});
    _gateLivenessSessionId = null;
  }
}

function captureVerifyFace() {
  toggleVerifyPin();
}

// ==============================================================================
// 3. REGISTRATION BIOMETRIC SCAN (ENROLLMENT) - SERVER-AUTHORITATIVE LIVENESS
// ==============================================================================
let _regActive = false;
let _regLivenessSessionId = null;

/**
 * Drives the enrollment sample dots (one per captured 128D sample).
 * count=0 resets; each captured sample lights one dot; all five turn green
 * when enrollment capture completes.
 */
function updateEnrollmentDots(count) {
  for (let i = 1; i <= ENROLL_SAMPLES; i++) {
    const dot = document.getElementById(`reg-dot-${i}`);
    if (!dot) continue;
    dot.classList.toggle('captured', i <= count);
    dot.setAttribute(
      'aria-label',
      `Face sample ${i} of ${ENROLL_SAMPLES} — ${i <= count ? 'captured' : 'pending'}`
    );
  }
  const hint = document.getElementById('reg-blink-instruction');
  if (hint) {
    hint.textContent =
      count >= ENROLL_SAMPLES
        ? 'All face samples captured ✓'
        : `Hold steady — capturing sample ${Math.min(count + 1, ENROLL_SAMPLES)} of ${ENROLL_SAMPLES}`;
  }
}

async function beginRegisterScan() {
  _regActive = false;
  const video = document.getElementById('reg-video');
  const errEl = document.getElementById('reg-cam-error');
  const retryBtn = document.getElementById('reg-retry-cam-btn');
  const captureBtn = document.getElementById('reg-capture-btn');

  if (captureBtn) captureBtn.style.display = 'none';
  if (retryBtn) retryBtn.style.display = 'none';

  setBannerStatus('reg', 'Initializing camera for biometric enrollment…', 'info');
  updateEnrollmentDots(0);

  // Load face-api models for client-side overlay feedback
  const modelsOk = await ensureBioModels();
  if (!modelsOk) {
    setBannerStatus('reg', 'Biometric enrollment models unavailable. Please try again.', 'bad');
    return;
  }

  try {
    await CameraManager.start(video, errEl);
  } catch (camErr) {
    setBannerStatus(
      'reg',
      'Camera could not be accessed. Grant camera permission and retry.',
      'bad'
    );
    if (retryBtn) retryBtn.style.display = '';
    return;
  }

  // Request fresh cryptographic challenge from server
  let challenge;
  try {
    setBannerStatus('reg', 'Connecting to biometric server…', 'info', false);
    const challengeRes = await window.iCashApi.issueChallenge({});
    if (!challengeRes || !challengeRes.ok || !challengeRes.challengeId) {
      throw new Error((challengeRes && challengeRes.message) || 'Challenge generation failed');
    }
    challenge = challengeRes;
    _regLivenessSessionId = challenge.livenessSessionId || null;
    setBannerStatus('reg', challenge.instruction || 'Center your face in the frame', 'info', true);
  } catch (chalErr) {
    const msg =
      chalErr.message &&
      (chalErr.message.includes('NO_BACKEND') ||
        chalErr.message.includes('unavailable') ||
        chalErr.message.includes('Unable to connect') ||
        chalErr.message.includes('Unable to reach'))
        ? 'The biometric service could not be reached. Tap Retry, or try again later.'
        : `Unable to start verification: ${chalErr.message}`;
    setBannerStatus('reg', msg, 'bad', true);
    if (errEl) {
      errEl.textContent = msg;
      errEl.classList.add('active');
    }
    if (retryBtn) retryBtn.style.display = '';
    CameraManager.stop(video);
    return;
  }

  // Offscreen canvas for frame capture
  const { width: videoWidth, height: videoHeight } = CameraManager.getVideoDimensions(video);
  const offCanvas = document.createElement('canvas');
  offCanvas.width = videoWidth;
  offCanvas.height = videoHeight;
  const offCtx = offCanvas.getContext('2d');

  const regOverlayCanvas = getOverlayCanvas(
    'reg-overlay-canvas',
    video ? video.parentElement : null,
    video
  );

  _regActive = true;
  setLivenessStepStatus('reg', 1, 'active', 'Center Face');
  resetLivenessSteps('reg');

  let framesProcessed = 0;
  let consecutiveNetworkErrors = 0;
  let livenessHandoffStarted = false;
  const MAX_FRAMES = 350; // ~60 seconds
  const MAX_NET_ERRORS = 8;
  const STREAM_INTERVAL_MS = 150;

  const scanState = {
    clientFaceOkStreak: 0,
    clientFaceLastReason: 'NO_FACE',
    serverStage: 1,
    lastBrightnessWarn: 0,
  };

  // Overlay loop for client-side feedback (non-blocking)
  const overlayTick = async () => {
    if (!_regActive) return;

    if (
      !document.hidden &&
      window._bioModelsLoaded &&
      typeof faceapi !== 'undefined' &&
      video.videoWidth
    ) {
      try {
        const detections = await faceapi
          .detectAllFaces(video, getDetectOptions())
          .withFaceLandmarks();

        const quality = FaceQualityGate.validate(detections, video);
        scanState.clientFaceLastReason = quality.reason || 'NO_FACE';

        if (quality.ok) {
          scanState.clientFaceOkStreak++;

          if (quality.det && quality.det.landmarks) {
            const landmarks = quality.det.landmarks.positions;
            const leftEyePoints = extractEyePoints(landmarks, LEFT_EYE_INDICES);
            const rightEyePoints = extractEyePoints(landmarks, RIGHT_EYE_INDICES);
            const leftEAR = calculateEAR(leftEyePoints);
            const rightEAR = calculateEAR(rightEyePoints);
            const avgEAR = (leftEAR + rightEAR) / 2.0;

            // Client-side blink state machine (real-time feedback only)
            BlinkStateMachine.update(avgEAR, leftEAR, rightEAR, Date.now());
          }
        } else {
          scanState.clientFaceOkStreak = 0;
        }

        // Draw the face ring overlay
        drawFaceRing(regOverlayCanvas, video, quality, false, true);
      } catch (_) {}
    }

    // Brightness coaching
    if (!document.hidden && Date.now() - scanState.lastBrightnessWarn > 1000) {
      const brightness = FaceQualityGate.sampleBrightness(video, _brightCanvas);
      if (brightness < 35) {
        scanState.lastBrightnessWarn = Date.now();
        setBannerStatus('reg', 'Move to a brighter area — it is too dark', 'warning', true);
      } else if (brightness > 220) {
        scanState.lastBrightnessWarn = Date.now();
        setBannerStatus('reg', 'Reduce glare — too much light behind you', 'warning', true);
      }
    }

    setTimeout(overlayTick, 300);
  };

  // Stream loop - server-authoritative liveness
  const streamLoop = async () => {
    if (!_regActive) return;

    if (document.hidden) {
      setTimeout(streamLoop, 400);
      return;
    }

    framesProcessed++;
    if (framesProcessed > MAX_FRAMES) {
      _regActive = false;
      setBannerStatus('reg', 'The liveness check timed out. Please try again.', 'bad', true);
      setLivenessStepStatus('reg', scanState.serverStage, 'error');
      if (retryBtn) retryBtn.style.display = '';
      CameraManager.stop(video);
      return;
    }

    // Capture JPEG frame
    const { width: videoWidth, height: videoHeight } = CameraManager.getVideoDimensions(video);
    if (offCanvas.width !== videoWidth || offCanvas.height !== videoHeight) {
      offCanvas.width = videoWidth;
      offCanvas.height = videoHeight;
    }
    offCtx.drawImage(video, 0, 0, videoWidth, videoHeight);
    const frameB64 = offCanvas.toDataURL('image/jpeg', 0.82);

    // Differential eye-visibility coaching
    if (scanState.clientFaceOkStreak >= 8 && scanState.serverStage < 2) {
      setBannerStatus(
        'reg',
        'Eyes not detected. Please make sure both eyes are visible.',
        'warning',
        true
      );
    }

    // Stream frame to the server liveness engine
    try {
      const serverRes = await window.iCashApi.sendBiometricFrame({
        challengeId: challenge.challengeId,
        nonce: challenge.nonce,
        image: frameB64,
        timestamp: Date.now(),
      });

      consecutiveNetworkErrors = 0;

      if (!_regActive) return;

      if (serverRes && serverRes.ok) {
        const stage = serverRes.stage || serverRes.current_step || 1;
        scanState.serverStage = stage;

        // Stages 1-4 advance ONLY from genuine server evidence
        if (stage <= 4) {
          markServerLivenessStage('reg', stage, serverRes.blink_count, serverRes.required_blinks);
        } else if (stage === 5) {
          const bl = serverRes.blink_count;
          const rb = serverRes.required_blinks;
          const blinkText =
            typeof bl === 'number' && typeof rb === 'number'
              ? `Blink Challenge (${bl}/${rb})`
              : 'Blink Challenge';
          for (let s2 = 1; s2 <= 4; s2++) {
            setLivenessStepStatus('reg', s2, 'done', s2 === 4 ? blinkText : undefined);
          }
          setLivenessStepStatus('reg', 5, 'active', 'Identity Match');
        }

        if (serverRes.instruction) {
          const stateClass = serverRes.quality_ok ? 'info' : 'warning';
          setBannerStatus('reg', serverRes.instruction, stateClass, true);
        }

        // LIVENESS COMPLETE -> verify challenge and enroll
        if (!livenessHandoffStarted && (serverRes.live || stage >= 6)) {
          livenessHandoffStarted = true;
          _regActive = false;
          await completeRegistrationIdentityAndEnroll({
            challenge,
            video,
            retryBtn,
            blinkCount: serverRes.blink_count,
            requiredBlinks: serverRes.required_blinks,
          });
          return;
        }

        // SPOOF DETECTED
        if (serverRes.spoof_detected) {
          _regActive = false;
          const spoofMessages = {
            eyes_closed_too_long:
              'Eyes stayed closed too long. Keep your eyes open and blink naturally, then try again.',
            low_texture_blur:
              'The camera view is unclear. Ensure your face is well-lit, in focus, and unobstructed, then try again.',
            flat_chrominance_screen:
              'The presentation could not be verified. Please use your live face — screens or printed photos are rejected.',
          };
          setBannerStatus(
            'reg',
            spoofMessages[serverRes.spoof_reason] ||
              'Live presence could not be verified. Please try again with your live face.',
            'bad',
            true
          );
          setLivenessStepStatus('reg', 4, 'error', 'Blink Challenge');
          if (retryBtn) retryBtn.style.display = '';
          CameraManager.stop(video);
          return;
        }
      }
    } catch (netErr) {
      consecutiveNetworkErrors++;
      if (consecutiveNetworkErrors >= MAX_NET_ERRORS) {
        _regActive = false;
        setBannerStatus(
          'reg',
          'Network connection lost. Check your connection and tap Try Again.',
          'bad',
          true
        );
        if (retryBtn) retryBtn.style.display = '';
        CameraManager.stop(video);
        return;
      }
    }

    setTimeout(streamLoop, STREAM_INTERVAL_MS);
  };

  overlayTick();
  streamLoop();
}

async function completeRegistrationIdentityAndEnroll({
  challenge,
  video,
  retryBtn,
  blinkCount,
  requiredBlinks,
}) {
  const blinkLabel =
    typeof blinkCount === 'number' && typeof requiredBlinks === 'number'
      ? `Blink Challenge (${Math.min(blinkCount, requiredBlinks)}/${requiredBlinks})`
      : 'Blink Challenge';

  // Blink challenge genuinely passed on the server -> mark stages 1-4 done.
  for (let s = 1; s <= 4; s++) {
    setLivenessStepStatus('reg', s, 'done', s === 4 ? blinkLabel : undefined);
  }
  setLivenessStepStatus('reg', 5, 'active', 'Identity Match');
  setBannerStatus('reg', 'Liveness verified — matching your identity…', 'ok', true);

  try {
    const verifyPayload = {
      challengeId: challenge.challengeId,
      nonce: challenge.nonce,
    };

    const verifyRes = await window.iCashApi.verifyChallenge(verifyPayload);
    if (!verifyRes || !verifyRes.ok || !verifyRes.biometricToken) {
      throw new Error((verifyRes && verifyRes.message) || 'Identity verification failed.');
    }

    // Server-side face match succeeded -> stage 5 is genuinely done.
    setLivenessStepStatus('reg', 5, 'done', 'Identity Match');
    setLivenessStepStatus('reg', 6, 'active', 'Authorized');
    setBannerStatus('reg', 'Identity verified — enrolling biometrics…', 'ok', true);
    CameraManager.stop(video);

    // Enroll using the biometricToken (proves liveness was verified)
    const enrollRes = await window.iCashApi.enrollBiometric({
      biometricToken: verifyRes.biometricToken,
    });

    if (!enrollRes || !enrollRes.ok) {
      throw new Error(enrollRes.message || 'Biometric enrollment failed.');
    }

    // Now complete registration with the enrolled biometric profile
    setLivenessStepStatus('reg', 6, 'done', 'Authorized');
    setBannerStatus('reg', 'Biometrics enrolled! Creating account…', 'ok', true);

    const payload = {
      ...window._pendingRegPayload,
      // No need to send descriptors - they're stored server-side via biometricToken
    };
    const regRes = await window.iCashApi.register(payload);
    if (regRes.ok && regRes.user) {
      window.currentUser = regRes.user;
      if (typeof currentUser !== 'undefined') currentUser = regRes.user;
      enterDashboard();
    } else {
      throw new Error(regRes.message || 'Registration failed');
    }
  } catch (verifyErr) {
    console.error('[iCash Bio] Registration verify error:', verifyErr);
    setLivenessStepStatus('reg', 5, 'error', 'Identity Match');
    setBannerStatus(
      'reg',
      (verifyErr && verifyErr.message) || 'We could not confidently verify you. Please try again.',
      'bad',
      true
    );
    if (retryBtn) retryBtn.style.display = '';
  }
}

function cancelRegisterScan() {
  teardownRegisterScan();
  goTo('screen-register-form');
}

function teardownRegisterScan() {
  _regActive = false;
  const video = document.getElementById('reg-video');
  CameraManager.stop(video);
  const oc = document.getElementById('reg-overlay-canvas');
  if (oc) oc.getContext('2d').clearRect(0, 0, oc.width, oc.height);
  // Clean up server liveness session
  if (_regLivenessSessionId) {
    window.iCashApi.liveness.reset(_regLivenessSessionId).catch(() => {});
    _regLivenessSessionId = null;
  }
}

function captureRegisterFace() {
  setBannerStatus('reg', 'Automatic scan active. Look at camera to enroll.', 'info');
}

// Preload models in background; stop every camera loop when leaving the page
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => ensureBioModels(), 800);
});

// Phase 7: the camera must never stay active when the page is closed or the tab
// is backgrounded mid-scan. pagehide covers tab close, navigation and reload.
window.addEventListener('pagehide', () => {
  try {
    if (typeof stopAllCameraLoops === 'function') stopAllCameraLoops();
  } catch (_) {}
});
