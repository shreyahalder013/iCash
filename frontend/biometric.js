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

// Show the debug diagnostics panel with ?debug=bio
const BIO_DEBUG_ENABLED =
  typeof location !== 'undefined' &&
  (new URLSearchParams(location.search).get('debug') === 'bio' ||
    new URLSearchParams(location.search).get('debug') === 'ear');

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

    console.log('[CameraManager] Requesting camera with constraints:', constraints);
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
      console.log(
        '[CameraManager] getUserMedia succeeded, stream:',
        stream.id,
        'tracks:',
        stream.getTracks().length
      );
      stream
        .getTracks()
        .forEach((t, i) =>
          console.log(
            `[CameraManager] Track ${i}: kind=${t.kind} label="${t.label}" readyState=${t.readyState}`
          )
        );
    } catch (e) {
      console.warn(
        '[CameraManager] Primary constraints failed:',
        e.name,
        e.message,
        '- trying fallback'
      );
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        console.log(
          '[CameraManager] Fallback getUserMedia succeeded, stream:',
          stream.id,
          'tracks:',
          stream.getTracks().length
        );
      } catch (e2) {
        console.error('[CameraManager] Both getUserMedia attempts failed:', e2.name, e2.message);
        throw e2;
      }
    }

    videoEl.srcObject = stream;
    console.log('[CameraManager] srcObject assigned to video element');
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
        console.error('[CameraManager] Video element error event');
        cleanup();
        reject(new Error('VIDEO_ERROR'));
      };

      // If metadata already loaded, check canplay/playing
      if (videoEl.readyState >= 1) {
        // HAVE_METADATA
        videoEl.oncanplay = () => {
          console.log('[CameraManager] canplay event');
          // Wait for playing event to ensure frames are flowing
          videoEl.onplaying = () => {
            cleanup();
            // Verify actual dimensions
            if (videoEl.videoWidth > 0 && videoEl.videoHeight > 0) {
              console.log(
                '[CameraManager] Video playing:',
                videoEl.videoWidth,
                'x',
                videoEl.videoHeight
              );
              resolve();
            } else {
              console.error('[CameraManager] playing but no dimensions');
              reject(new Error('NO_VIDEO_DIMENSIONS'));
            }
          };
        };
      } else {
        videoEl.onloadedmetadata = () => {
          console.log(
            '[CameraManager] loadedmetadata:',
            videoEl.videoWidth,
            'x',
            videoEl.videoHeight
          );
          videoEl.oncanplay = () => {
            console.log('[CameraManager] canplay event');
            videoEl.onplaying = () => {
              cleanup();
              if (videoEl.videoWidth > 0 && videoEl.videoHeight > 0) {
                console.log(
                  '[CameraManager] Video playing:',
                  videoEl.videoWidth,
                  'x',
                  videoEl.videoHeight
                );
                resolve();
              } else {
                console.error('[CameraManager] playing but no dimensions');
                reject(new Error('NO_VIDEO_DIMENSIONS'));
              }
            };
          };
        };
      }

      // Start playback - don't await inside Promise executor
      const playPromise = videoEl.play();
      if (playPromise !== undefined) {
        playPromise.catch((e) => {
          console.warn(
            '[CameraManager] play() rejected (may recover via onplaying):',
            e.name,
            e.message
          );
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

// ── Liveness Steps Component (6-stage, server-evidence-driven) ────────────────
// A stage may ONLY show ✓ when the underlying condition has genuinely passed:
//   Stages 1-4 advance exclusively from the server liveness engine's stage.
//   Stage 5 (Identity Match) is marked done ONLY after verify-challenge
//   returns a biometricToken from a real server-side face match.
//   Stage 6 (Authorized) is marked done ONLY after the backend has actually
//   established the authenticated session (login-biometric success).
const LIVENESS_STEP_LABELS = {
  1: 'Center Face',
  2: 'Eyes Detected',
  3: 'Live Check',
  4: 'Blink Challenge',
  5: 'Identity Match',
  6: 'Authorized',
};

/**
 * Sets a single liveness step to pending | active | done | error.
 * pending → outlined circle ○, active → pulsing dot ●, done → check ✓,
 * error → cross ✗. Status is never color-only (icon + ARIA state change too).
 */
function setLivenessStepStatus(prefix, step, status, detail) {
  // HTML uses 'login-ps-N' / 'reg-ps-N' id pattern
  const el = document.getElementById(`${prefix}-ps-${step}`);
  if (!el) return;
  el.dataset.status = status;
  el.classList.remove('is-pending', 'is-active', 'is-done', 'is-error');
  el.classList.add(`is-${status}`);

  // Update the SVG indicator inside .step-indicator
  const indicator = el.querySelector('.step-indicator');
  if (indicator) {
    if (status === 'done') {
      indicator.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
    } else if (status === 'error') {
      indicator.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;
    } else if (status === 'active') {
      indicator.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="5" fill="currentColor"></circle></svg>`;
    } else {
      indicator.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle></svg>`;
    }
  }

  // Update detail text in .step-detail (below the label)
  const detailEl = el.querySelector('.step-detail');
  if (detailEl && detail) detailEl.textContent = detail;

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
}

/** Resets all six steps to pending and restores default detail text. */
const LIVENESS_STEP_DEFAULTS = {
  1: 'Position your face inside the guide',
  2: 'Keep both eyes visible',
  3: 'Stay still for calibration',
  4: 'Blink when prompted',
  5: 'Matching enrolled identity',
  6: 'Establishing secure session',
};
function resetLivenessSteps(prefix) {
  for (let s = 1; s <= 6; s++) {
    setLivenessStepStatus(prefix, s, 'pending');
    // Also restore the detail text to its default
    const detailEl = document.getElementById(`${prefix}-ps-${s}-detail`);
    if (detailEl && LIVENESS_STEP_DEFAULTS[s]) detailEl.textContent = LIVENESS_STEP_DEFAULTS[s];
  }
}

/**
 * Marks the server-driven liveness stage (1-4 only — identity/authorized are
 * gated on real verification results, never on the engine's stage alone).
 * Stages below the reported stage have genuinely passed on the server
 * (face found → landmarks localized → baseline calibrated → blinks counted).
 */
const LIVENESS_STAGE_DONE_LABELS = {
  1: 'Face centered ✓',
  2: 'Eyes detected ✓',
  3: 'Live check passed ✓',
  4: 'Blink challenge complete ✓',
};
const LIVENESS_STAGE_ACTIVE_DETAILS = {
  1: 'Position your face inside the guide',
  2: 'Keep both eyes visible and open',
  3: 'Stay still — checking live interaction',
  4: 'Blink when prompted',
};
function markServerLivenessStage(prefix, serverStage, blinkCount, requiredBlinks) {
  const capped = Math.min(Math.max(Number(serverStage) || 1, 1), 4);
  for (let s = 1; s <= 4; s++) {
    if (s < capped) {
      setLivenessStepStatus(prefix, s, 'done', LIVENESS_STAGE_DONE_LABELS[s]);
    } else if (s === capped) {
      const activeDetail =
        s === 4 && typeof blinkCount === 'number' && requiredBlinks
          ? `Blinks detected: ${blinkCount} / ${requiredBlinks}`
          : LIVENESS_STAGE_ACTIVE_DETAILS[s];
      setLivenessStepStatus(prefix, s, 'active', activeDetail);
    } else {
      setLivenessStepStatus(prefix, s, 'pending');
    }
  }
}

/** Marks a step done explicitly (only after real verification results). */
function markLivenessStepDone(prefix, step, detail) {
  setLivenessStepStatus(prefix, step, 'done', detail);
}

let _lastSpokenInstruction = '';

function setBannerStatus(prefix, text, stateClass = 'info', speak = true) {
  const banner = document.getElementById(`${prefix}-instruction-banner`);
  const textEl = document.getElementById(`${prefix}-instruction-text`);
  if (textEl) textEl.textContent = text;
  // Correct class: 'instruction-banner' (not 'scan-instruction-banner')
  if (banner) banner.className = `instruction-banner ${stateClass}`;

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

function drawFaceRing(canvas, video, quality, isLive = false, isMirrored = true) {
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

  // If display is mirrored, flip X coordinates for drawing
  const drawX = isMirrored ? w - box.x - box.width : box.x;

  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  ctx.strokeRect(drawX, box.y, box.width, box.height);

  // Corner brackets (mirrored if needed)
  const s = 14;
  const corners = isMirrored
    ? [
        [w - box.x, box.y, -1, 1],
        [w - (box.x + box.width), box.y, 1, 1],
        [w - box.x, box.y + box.height, -1, -1],
        [w - (box.x + box.width), box.y + box.height, 1, -1],
      ]
    : [
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
let _loginOverlayTimer = null; // overlay/feedback loop timer (never blocks streaming)
let _brightCanvas = null; // tiny offscreen canvas for brightness sampling
let _loginLivenessSessionId = null; // for cleanup on cancel/timeout

/**
 * Classifies a frame-submission failure into a fatal (scan must stop) or
 * transient (retry silently) condition, with a specific user message.
 * These are real backend error codes — never a generic "presentation attack".
 */
function classifyFrameError(err) {
  const code = (err && err.data && err.data.error) || '';
  const status = err && err.status;

  if (code === 'BiometricServiceUnavailable' || status === 503) {
    return {
      fatal: true,
      message:
        'Biometric verification is temporarily unavailable. Please tap Try Again in a moment.',
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

// Phase 7/14: background tabs throttle timers to ~1-3s, which corrupts the
// temporal blink measurement (a 3s sample gap makes every eye closure look
// multi-second) and wastes network frames. While the tab is hidden the loops
// skip processing, and the blink state machine is reset on return so the
// paused span can never be counted as a blink or trigger a false spoof flag.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  if (_loginActive) {
    BlinkStateMachine.reset();
    setBannerStatus('login', 'Resuming — please blink naturally when prompted.', 'info', true);
  }
});

async function legacyBeginLoginScan() {
  _loginActive = false;
  if (_loginOverlayTimer) {
    clearTimeout(_loginOverlayTimer);
    _loginOverlayTimer = null;
  }
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

  resetLivenessSteps('login');
  setBannerStatus('login', 'Initializing secure camera…', 'info', false);

  // Brightness probe canvas (80×60 is enough for mean luminance)
  if (!_brightCanvas) {
    _brightCanvas = document.createElement('canvas');
    _brightCanvas.width = 80;
    _brightCanvas.height = 60;
  }

  const parent = video ? video.parentElement : null;
  const overlayCanvas = getOverlayCanvas('login-overlay-canvas', parent, video);

  // 1. Pre-load face-api models in background (for overlay only — server does the real work)
  ensureBioModels().catch(() => {});

  // 2. Start Camera
  try {
    await CameraManager.start(video, errEl);
  } catch (camErr) {
    const msg =
      'Camera could not be accessed. ' +
      'Grant camera permission and tap Retry, or use the Aadhaar & PIN sign-in below.';
    setBannerStatus('login', msg, 'bad', true);
    if (errEl) {
      errEl.textContent = cameraErrorMessage(camErr);
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
    const challengeRes = await window.iCashApi.livenessChallenge({
      userIdHint: targetUser ? targetUser.id : undefined,
    });
    if (!challengeRes || !challengeRes.ok || !challengeRes.challengeId) {
      throw new Error((challengeRes && challengeRes.message) || 'Challenge generation failed');
    }
    challenge = challengeRes;
    _loginLivenessSessionId = challenge.livenessSessionId || null;
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
        chalErr.message.includes('Unable to connect') ||
        chalErr.message.includes('Unable to reach'));
    const msg = offline
      ? 'The biometric service could not be reached. Tap Retry, or use the Aadhaar & PIN sign-in below.'
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

  // 4. Offscreen canvas for frame capture (use actual video dimensions)
  const { width: videoWidth, height: videoHeight } = CameraManager.getVideoDimensions(video);
  const offCanvas = document.createElement('canvas');
  offCanvas.width = videoWidth;
  offCanvas.height = videoHeight;
  const offCtx = offCanvas.getContext('2d');

  _loginActive = true;
  setLivenessStepStatus('login', 1, 'active', 'Position your face inside the guide');

  let framesProcessed = 0;
  let consecutiveNetworkErrors = 0;
  let faceRecognizedAnnounced = false;
  let livenessHandoffStarted = false;
  const MAX_FRAMES = 350; // ~60 seconds at streaming cadence (matches challenge TTL)
  const MAX_NET_ERRORS = 8; // give up if network stays broken
  const STREAM_INTERVAL_MS = 150; // steady ~6-7 fps sampling for the server

  // Shared coaching state written by the (non-blocking) overlay loop and read
  // by the streaming loop — the client-side neural detection NEVER delays a
  // frame submission, so the server always receives evenly-timed samples.
  const scanState = {
    clientFaceOkStreak: 0, // consecutive overlay ticks with a well-framed face
    clientFaceLastReason: 'NO_FACE',
    serverStage: 1,
    serverRequiredBlinks: 1, // updated from server responses
    lastBrightnessWarn: 0,
  };

  // Initialize status panel
  const _initStatus = (id, text, cls) => {
    const el = document.getElementById(id);
    if (el) {
      el.textContent = text;
      el.className = `status-value ${cls}`;
    }
  };
  _initStatus('status-camera', 'Starting…', 'waiting');
  _initStatus('status-face', 'Not detected', '');
  _initStatus('status-eyes', 'Not detected', '');
  _initStatus('status-liveness', 'Waiting', 'waiting');
  _initStatus('status-blink', 'Waiting', 'waiting');
  _initStatus('status-identity', 'Not checked', '');

  // ── OVERLAY LOOP (client-side feedback only, never authoritative) ─────────
  // Runs face-api landmark detection ~3x per second purely for the face ring,
  // EAR debug overlay, brightness coaching and eye-visibility hints. It shares
  // state with the streaming loop but NEVER blocks or delays it — this is what
  // keeps the server's temporal blink measurement accurate.
  let _overlayFpsCount = 0;
  let _overlayFpsLastTime = Date.now();
  let _overlayFps = 0;

  const overlayTick = async () => {
    if (!_loginActive) return;

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

        // ── Update FPS counter ────────────────────────────────────────────────
        _overlayFpsCount++;
        const now = Date.now();
        if (now - _overlayFpsLastTime >= 1000) {
          _overlayFps = _overlayFpsCount;
          _overlayFpsCount = 0;
          _overlayFpsLastTime = now;
        }

        // ── Update face guide DOM class ───────────────────────────────────────
        const faceGuideFrame =
          document.getElementById('face-guide') &&
          document.getElementById('face-guide').querySelector('.face-guide-frame');
        if (faceGuideFrame) {
          faceGuideFrame.classList.remove('centered', 'too-far', 'too-close', 'off-center');
          if (quality.ok) {
            faceGuideFrame.classList.add('centered');
          } else if (quality.reason === 'TOO_FAR') {
            faceGuideFrame.classList.add('too-far');
          } else if (quality.reason === 'TOO_CLOSE') {
            faceGuideFrame.classList.add('too-close');
          } else if (quality.reason === 'NOT_CENTERED' || quality.reason === 'PARTIAL') {
            faceGuideFrame.classList.add('off-center');
          }
        }

        // ── Update status panel ───────────────────────────────────────────────
        const stCamera = document.getElementById('status-camera');
        if (stCamera) {
          stCamera.textContent = 'Ready';
          stCamera.className = 'status-value ready';
        }

        const stFace = document.getElementById('status-face');
        if (stFace) {
          if (quality.ok) {
            stFace.textContent = 'Detected';
            stFace.className = 'status-value detected';
          } else if (quality.reason === 'MULTI_FACE') {
            stFace.textContent = 'Multiple faces';
            stFace.className = 'status-value error';
          } else {
            stFace.textContent = 'Not detected';
            stFace.className = 'status-value';
          }
        }

        if (quality.ok) {
          scanState.clientFaceOkStreak++;

          if (quality.det && quality.det.landmarks) {
            const landmarks = quality.det.landmarks.positions;
            const leftEyePoints = extractEyePoints(landmarks, LEFT_EYE_INDICES);
            const rightEyePoints = extractEyePoints(landmarks, RIGHT_EYE_INDICES);
            const leftEAR = calculateEAR(leftEyePoints);
            const rightEAR = calculateEAR(rightEyePoints);
            const avgEAR = (leftEAR + rightEAR) / 2.0;

            // ── Update eyes status ────────────────────────────────────────────
            const EAR_OPEN_MIN = 0.15;
            const eyesOk = leftEAR > EAR_OPEN_MIN && rightEAR > EAR_OPEN_MIN;
            const stEyes = document.getElementById('status-eyes');
            if (stEyes) {
              if (eyesOk) {
                stEyes.textContent = 'Detected';
                stEyes.className = 'status-value detected';
              } else {
                stEyes.textContent = 'Not visible';
                stEyes.className = 'status-value';
              }
            }

            // Client-side blink state machine (real-time feedback only; the
            // server's state machine is the authoritative liveness gate).
            const blinkState = BlinkStateMachine.update(avgEAR, leftEAR, rightEAR, Date.now());

            // ── Update blink status ───────────────────────────────────────────
            const stBlink = document.getElementById('status-blink');
            if (stBlink) {
              const reqBlinks = scanState.serverRequiredBlinks || 1;
              const clientBlinks = blinkState.blinkCount;
              if (scanState.serverStage >= 5) {
                stBlink.textContent = 'Complete';
                stBlink.className = 'status-value complete';
              } else if (scanState.serverStage === 4 || blinkState.isCalibrated) {
                stBlink.textContent = `${clientBlinks} / ${reqBlinks}`;
                stBlink.className =
                  clientBlinks >= reqBlinks ? 'status-value complete' : 'status-value in-progress';
              } else {
                stBlink.textContent = 'Waiting';
                stBlink.className = 'status-value waiting';
              }
            }

            // ── Update liveness status ────────────────────────────────────────
            const stLiveness = document.getElementById('status-liveness');
            if (stLiveness) {
              if (scanState.serverStage >= 5) {
                stLiveness.textContent = 'Confirmed';
                stLiveness.className = 'status-value confirmed';
              } else if (scanState.serverStage >= 3) {
                stLiveness.textContent = 'In progress';
                stLiveness.className = 'status-value in-progress';
              } else {
                stLiveness.textContent = 'Waiting';
                stLiveness.className = 'status-value waiting';
              }
            }

            // ── Debug panel updates ───────────────────────────────────────────
            const debugPanel = document.getElementById('login-debug-panel');
            if (debugPanel && (EAR_DEBUG_ENABLED || BIO_DEBUG_ENABLED)) {
              // Show panel in debug mode
              if (debugPanel.hidden) debugPanel.hidden = false;
              const det = quality.det;
              const box = det && det.detection && det.detection.box;
              const conf = det && det.detection && det.detection.score;
              const faceCentered = box
                ? Math.abs((box.x + box.width / 2) / (video.videoWidth || 640) - 0.5) <= 0.3 &&
                  Math.abs((box.y + box.height / 2) / (video.videoHeight || 480) - 0.5) <= 0.3
                : false;
              const setDbg = (id, val) => {
                const el = document.getElementById(id);
                if (el) el.textContent = val;
              };
              setDbg('dbg-camera', 'READY');
              setDbg('dbg-resolution', `${video.videoWidth}x${video.videoHeight}`);
              setDbg('dbg-faces', detections.length.toString());
              setDbg('dbg-face-conf', conf ? conf.toFixed(3) : '—');
              setDbg('dbg-face-centered', faceCentered ? 'YES' : quality.reason || 'NO');
              setDbg('dbg-left-eye', leftEAR > EAR_OPEN_MIN ? 'DETECTED' : 'CLOSED/HIDDEN');
              setDbg('dbg-right-eye', rightEAR > EAR_OPEN_MIN ? 'DETECTED' : 'CLOSED/HIDDEN');
              setDbg('dbg-avg-ear', avgEAR.toFixed(3));
              setDbg('dbg-blink-state', blinkState.state);
              setDbg('dbg-blink-count', blinkState.blinkCount.toString());
              setDbg(
                'dbg-baseline',
                blinkState.baselineEAR ? blinkState.baselineEAR.toFixed(3) : '—'
              );
              setDbg('dbg-fps', _overlayFps.toString());
            }

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
              if (earVizCanvas) {
                drawEARVisualization(
                  earVizCanvas,
                  video,
                  leftEAR,
                  rightEAR,
                  avgEAR,
                  blinkState,
                  challenge.challengeType
                );
              }
            }
          } else {
            // Face detected but no landmarks — still update eyes as not visible
            const stEyes = document.getElementById('status-eyes');
            if (stEyes) {
              stEyes.textContent = 'Not visible';
              stEyes.className = 'status-value';
            }
          }
        } else {
          scanState.clientFaceOkStreak = 0;
          // No face — clear eye/blink status
          const stEyes = document.getElementById('status-eyes');
          if (stEyes) {
            stEyes.textContent = 'Not detected';
            stEyes.className = 'status-value';
          }
        }

        // Draw the face ring overlay (mirrored to match the mirrored preview)
        drawFaceRing(overlayCanvas, video, quality, scanState.serverStage >= 5, true);
      } catch (_) {
        // Detection hiccups must never affect the streaming loop
      }
    } else if (!window._bioModelsLoaded) {
      // Models still loading — update camera status but leave others pending
      const stCamera = document.getElementById('status-camera');
      if (stCamera) {
        stCamera.textContent = 'Loading models…';
        stCamera.className = 'status-value waiting';
      }
    }

    // Brightness coaching (~once per second)
    if (!document.hidden && Date.now() - scanState.lastBrightnessWarn > 1000) {
      const brightness = FaceQualityGate.sampleBrightness(video, _brightCanvas);
      if (brightness < 35) {
        scanState.lastBrightnessWarn = Date.now();
        setBannerStatus('login', 'Move to a brighter area — it is too dark', 'warning', true);
      } else if (brightness > 220) {
        scanState.lastBrightnessWarn = Date.now();
        setBannerStatus('login', 'Reduce glare — too much light behind you', 'warning', true);
      }
    }

    _loginOverlayTimer = setTimeout(overlayTick, 300);
  };

  // ── STREAM LOOP (server-authoritative liveness evidence) ──────────────────
  // Submits one frame per tick at a steady cadence. The ONLY awaits in this
  // loop are the frame POST and its response handling.
  const streamLoop = async () => {
    if (!_loginActive) return;

    // Skip processing while the tab is hidden (throttled timers corrupt timing)
    if (document.hidden) {
      setTimeout(streamLoop, 400);
      return;
    }

    framesProcessed++;
    if (framesProcessed > MAX_FRAMES) {
      _loginActive = false;
      registerLoginFailure();
      setBannerStatus('login', 'The liveness check timed out. Please try again.', 'bad', true);
      setLivenessStepStatus('login', scanState.serverStage, 'error');
      if (retryBtn) retryBtn.style.display = '';
      CameraManager.stop(video);
      return;
    }

    // Capture JPEG frame using actual video dimensions
    const { width: videoWidth, height: videoHeight } = CameraManager.getVideoDimensions(video);
    // Resize offCanvas if video dimensions changed
    if (offCanvas.width !== videoWidth || offCanvas.height !== videoHeight) {
      offCanvas.width = videoWidth;
      offCanvas.height = videoHeight;
    }
    offCtx.drawImage(video, 0, 0, videoWidth, videoHeight);
    const frameB64 = offCanvas.toDataURL('image/jpeg', 0.82);

    // Differential eye-visibility coaching: the client clearly sees a centered
    // face but the server's landmark engine is not progressing — the most
    // common cause is occluded/partially visible eyes or lighting the server
    // engine cannot resolve. Never framed as a presentation attack.
    if (scanState.clientFaceOkStreak >= 8 && scanState.serverStage < 2) {
      setBannerStatus(
        'login',
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

      consecutiveNetworkErrors = 0; // reset on success

      if (!_loginActive) return;

      if (serverRes && serverRes.ok) {
        const stage = serverRes.stage || serverRes.current_step || 1;
        scanState.serverStage = stage;
        if (serverRes.required_blinks) scanState.serverRequiredBlinks = serverRes.required_blinks;

        // Stages 1-4 advance ONLY from genuine server evidence
        // (face → landmarks → calibration → counted blinks). Stages 5/6 are
        // gated on real verification results further below.
        if (stage <= 4) {
          markServerLivenessStage('login', stage, serverRes.blink_count, serverRes.required_blinks);
          // Update step detail text for blink challenge (stage 4)
          if (
            stage === 4 &&
            typeof serverRes.blink_count === 'number' &&
            serverRes.required_blinks
          ) {
            const blinkDetailEl = document.getElementById('login-ps-4-detail');
            if (blinkDetailEl)
              blinkDetailEl.textContent = `Blinks detected: ${serverRes.blink_count} / ${serverRes.required_blinks}`;
          }
        } else if (stage === 5) {
          // Blink challenge complete on the server; the engine is extracting
          // the identity descriptor from an open-eye frame. Mark 1-4 done and
          // show Identity Match as IN PROGRESS (never ✓ before verify runs).
          const bl = serverRes.blink_count;
          const rb = serverRes.required_blinks;
          const blinkDoneText =
            typeof bl === 'number' && typeof rb === 'number'
              ? `Blink challenge complete (${bl}/${rb}) ✓`
              : 'Blink challenge complete ✓';
          for (let s2 = 1; s2 <= 4; s2++) {
            setLivenessStepStatus(
              'login',
              s2,
              'done',
              s2 === 4 ? blinkDoneText : LIVENESS_STAGE_DONE_LABELS[s2]
            );
          }
          setLivenessStepStatus(
            'login',
            5,
            'active',
            'Comparing your face with enrolled identity…'
          );
        }

        if (serverRes.instruction) {
          const stateClass = serverRes.quality_ok ? 'info' : 'warning';
          setBannerStatus('login', serverRes.instruction, stateClass, true);
        }

        // ── EARLY FACE RECOGNITION FEEDBACK (server-side, preliminary) ────────
        if (serverRes.faceRecognized && !faceRecognizedAnnounced) {
          faceRecognizedAnnounced = true;
          setBannerStatus(
            'login',
            `Face recognized — now complete the blink challenge${serverRes.recognizedName ? `, ${serverRes.recognizedName}` : ''}.`,
            'ok',
            true
          );
        }

        // ── LIVENESS COMPLETE → run the real identity match & session ─────────
        // The engine reports live=true (stage 6) only when the blink challenge
        // passed AND the server-side face descriptor was extracted from an
        // open-eye, good-quality frame. Stage 5 alone means "blinks done,
        // descriptor pending" — keep streaming until the engine is live.
        if (!livenessHandoffStarted && (serverRes.live || stage >= 6)) {
          livenessHandoffStarted = true;
          _loginActive = false; // stop streaming immediately
          await completeLoginIdentityAndSession({
            challenge,
            targetUser,
            video,
            retryBtn,
            blinkCount: serverRes.blink_count,
            requiredBlinks: serverRes.required_blinks,
          });
          return;
        }

        // ── SPOOF DETECTED (server-authoritative, only after real evidence) ────
        if (serverRes.spoof_detected) {
          _loginActive = false;
          registerLoginFailure();
          // Message reflects the actual reason the server flagged the attempt —
          // never used as a generic fallback error.
          const spoofMessages = {
            eyes_closed_too_long:
              'Eyes stayed closed too long. Keep your eyes open and blink naturally, then try again.',
            low_texture_blur:
              'The camera view is unclear. Ensure your face is well-lit, in focus, and unobstructed, then try again.',
            flat_chrominance_screen:
              'The presentation could not be verified. Please use your live face — screens or printed photos are rejected.',
          };
          setBannerStatus(
            'login',
            spoofMessages[serverRes.spoof_reason] ||
              'Live presence could not be verified. Please try again with your live face.',
            'bad',
            true
          );
          setLivenessStepStatus('login', 4, 'error', 'Blink Challenge');
          if (retryBtn) retryBtn.style.display = '';
          CameraManager.stop(video);
          return;
        }
      }
    } catch (netErr) {
      consecutiveNetworkErrors++;
      const cls = classifyFrameError(netErr);
      if (cls.fatal) {
        _loginActive = false;
        setBannerStatus('login', cls.message, 'bad', true);
        if (retryBtn) retryBtn.style.display = '';
        CameraManager.stop(video);
        return;
      }
      console.warn('[iCash Bio] Frame network error:', netErr.message);
      if (consecutiveNetworkErrors >= MAX_NET_ERRORS) {
        _loginActive = false;
        setBannerStatus(
          'login',
          'Network connection lost. Check your connection and tap Try Again.',
          'bad',
          true
        );
        if (retryBtn) retryBtn.style.display = '';
        CameraManager.stop(video);
        return;
      }
    }

    // Schedule next frame — steady cadence, independent of overlay detection
    setTimeout(streamLoop, STREAM_INTERVAL_MS);
  };

  overlayTick();
  streamLoop();
}

/** Counts a failed login attempt and applies the retry cooldown when due. */
function registerLoginFailure() {
  _loginAttempts++;
  if (_loginAttempts >= LOGIN_MAX_ATTEMPTS) {
    _loginCooldownUntil = Date.now() + LOGIN_COOLDOWN_MS;
    _loginAttempts = 0;
  }
}

/**
 * Runs AFTER the server liveness engine confirms the full blink challenge:
 *   1. verify-challenge  → server-side face match against enrolled templates
 *      (only on success is stage 5 "Identity Match" marked done)
 *   2. login-biometric   → backend establishes the real authenticated session
 *      (only on success is stage 6 "Authorized" marked done)
 * There is no timer, no auto-pass: every ✓ reflects a real server result.
 */
async function completeLoginIdentityAndSession({
  challenge,
  targetUser,
  video,
  retryBtn,
  blinkCount,
  requiredBlinks,
}) {
  const blinkLabel =
    typeof blinkCount === 'number' && typeof requiredBlinks === 'number'
      ? `Blink challenge complete (${Math.min(blinkCount, requiredBlinks)}/${requiredBlinks}) ✓`
      : 'Blink challenge complete ✓';

  // Blink challenge genuinely passed on the server → mark stages 1-4 done.
  for (let s = 1; s <= 4; s++) {
    setLivenessStepStatus('login', s, 'done', s === 4 ? blinkLabel : LIVENESS_STAGE_DONE_LABELS[s]);
  }
  setLivenessStepStatus('login', 5, 'active', 'Comparing your face with enrolled identity…');
  setBannerStatus('login', 'Liveness verified — matching your identity…', 'ok', true);

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

    // Server-side face match succeeded → stage 5 is genuinely done.
    setLivenessStepStatus('login', 5, 'done', 'Identity matched');
    setLivenessStepStatus('login', 6, 'active', 'Establishing session…');
    setBannerStatus('login', 'Identity verified — signing you in…', 'ok', true);
    CameraManager.stop(video);
    _loginAttempts = 0; // reset on success

    // Update identity status panel
    const stIdentity = document.getElementById('status-identity');
    if (stIdentity) {
      stIdentity.textContent = 'Matched';
      stIdentity.className = 'status-value matched';
    }

    const authRes = await window.iCashApi.loginBiometric(verifyRes.biometricToken);
    if (!(authRes && authRes.ok && authRes.user)) {
      throw new Error((authRes && authRes.message) || 'Failed to establish session');
    }

    // Backend session established → stage 6 is genuinely done. Only now is
    // the user routed to the dashboard.
    window.currentUser = authRes.user;
    if (typeof currentUser !== 'undefined') currentUser = authRes.user;
    markLivenessStepDone('login', 6, 'Authentication successful');
    enterDashboard();
  } catch (verifyErr) {
    console.error('[iCash Bio] Verify error:', verifyErr);
    registerLoginFailure();
    setLivenessStepStatus('login', 5, 'error', 'Identity Match');
    setBannerStatus(
      'login',
      (verifyErr && verifyErr.message) || 'We could not confidently verify you. Please try again.',
      'bad',
      true
    );
    if (retryBtn) retryBtn.style.display = '';
  }
}

function cancelLoginScan() {
  teardownLoginScan();
  goTo('screen-welcome');
}

function legacyTeardownLoginScan() {
  _loginActive = false;
  if (_loginOverlayTimer) {
    clearTimeout(_loginOverlayTimer);
    _loginOverlayTimer = null;
  }
  BlinkStateMachine.reset();
  const video = document.getElementById('login-video');
  CameraManager.stop(video);
  const oc = document.getElementById('login-overlay-canvas');
  if (oc) oc.getContext('2d').clearRect(0, 0, oc.width, oc.height);
  const earViz = document.getElementById('login-ear-viz-canvas');
  if (earViz) earViz.getContext('2d').clearRect(0, 0, earViz.width, earViz.height);
  // Clean up server liveness session
  if (_loginLivenessSessionId) {
    window.iCashApi.liveness.reset(_loginLivenessSessionId).catch(() => {});
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

  // Issue server challenge (new liveness endpoint)
  let challenge;
  try {
    challenge = await window.iCashApi.livenessChallenge({
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

async function legacyBeginRegisterScan() {
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

  // Request fresh cryptographic challenge from server (new liveness endpoint)
  let challenge;
  try {
    setBannerStatus('reg', 'Connecting to biometric server…', 'info', false);
    const challengeRes = await window.iCashApi.livenessChallenge({});
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

function legacyTeardownRegisterScan() {
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

/* ============================================================
 * NEW: FaceLiveness Integration Wrappers
 * Replaces old liveness_server-based beginLoginScan/beginRegisterScan
 * with client-side MediaPipe FaceLandmarker (WASM) + /api/liveness API
 * ============================================================ */

// New wrapper for login scan using FaceLivenessIntegration
async function beginLoginScan() {
  if (window.teardownFaceLiveness) window.teardownFaceLiveness();
  if (window.initLoginLiveness) {
    const targetUser = window._loginTargetUser || null;
    await window.initLoginLiveness(targetUser);
  } else {
    console.warn('[FaceLiveness] Integration not loaded, falling back to legacy');
    await legacyBeginLoginScan();
  }
}

// New wrapper for register scan using FaceLivenessIntegration
async function beginRegisterScan() {
  if (window.teardownFaceLiveness) window.teardownFaceLiveness();
  if (window.initRegisterLiveness) {
    await window.initRegisterLiveness();
  } else {
    console.warn('[FaceLiveness] Integration not loaded, falling back to legacy');
    await legacyBeginRegisterScan();
  }
}

// New teardown function for FaceLiveness
function teardownLoginScan() {
  if (window.teardownFaceLiveness) window.teardownFaceLiveness();
  legacyTeardownLoginScan();
}

function teardownRegisterScan() {
  if (window.teardownFaceLiveness) window.teardownFaceLiveness();
  legacyTeardownRegisterScan();
}

// Backward compatibility: handleLivenessSuccess/fallback/cancel for existing callers
window.handleLivenessSuccess = function (detail) {
  // This will be called by FaceLivenessIntegration onSuccess
  // The existing completeLoginIdentityAndSession logic handles the rest
  console.log('[FaceLiveness] Login success callback:', detail);
};

window.handleLivenessFallback = function () {
  console.log('[FaceLiveness] Fallback to PIN');
  // Navigate to PIN login screen
  goTo('screen-pin-login');
};

window.handleLivenessCancel = function () {
  console.log('[FaceLiveness] Cancelled');
  // Clean up and return to welcome
  teardownLoginScan();
  goTo('screen-welcome');
};

window.handleRegisterLivenessSuccess = function (detail) {
  console.log('[FaceLiveness] Register success callback:', detail);
  // The existing completeRegisterIdentityAndSession logic handles the rest
};

window.handleRegisterLivenessFallback = function () {
  console.log('[FaceLiveness] Register fallback');
  goTo('screen-register-form');
};

window.handleRegisterLivenessCancel = function () {
  console.log('[FaceLiveness] Register cancelled');
  teardownRegisterScan();
  goTo('screen-register-form');
};
