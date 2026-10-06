/**
 * iCash FaceLiveness Component
 * Client-side blink liveness using MediaPipe FaceLandmarker (WASM)
 * 
 * Designed to work with existing DOM structure in biometric.js
 * (login-video, face-guide, status grid, etc.)
 * 
 * Options:
 *   mode: "register" | "login"
 *   targetUser: optional user object for login mode
 *   dom: {
 *     video: HTMLVideoElement,
 *     overlayCanvas: HTMLCanvasElement,
 *     faceGuide: HTMLElement,
 *     msg: HTMLElement,
 *     errBox: HTMLElement,
 *     stepsContainer: HTMLElement,
 *     gridContainer: HTMLElement,
 *     retryBtn: HTMLButtonElement,
 *     cancelBtn: HTMLButtonElement,
 *     fallbackBtn: HTMLButtonElement,
 *     tabLogin: HTMLButtonElement,
 *     tabReg: HTMLButtonElement,
 *     statusEls: { cam, face, eyes, live, blink, id }
 *   }
 *   onSuccess(detail): called when liveness succeeds
 *   onCancel(): called when user cancels
 *   onFallback(): called when user clicks fallback
 */

const CFG = {
  wasm: '/mediapipe',
  model: '/mediapipe/face_landmarker.task',
  closed: 0.55,
  open: 0.30,
  minBlinkMs: 40,
  maxBlinkMs: 700,
  stillFrames: 20,
  stillMax: 0.012,
  enrolFrames: 12,
  matchMax: 0.085,
  challengeTimeoutMs: 15000,
  templateKey: 'icash_face_template_v1'
};

const STEPS = [
  ["Center Face", "Position your face inside the guide"],
  ["Eyes Detected", "Keep both eyes visible"],
  ["Live Check", "Stay still for calibration"],
  ["Blink Challenge", "Blink when prompted"],
  ["Identity Match", "Matching enrolled identity"],
  ["Authorized", "Establishing secure session"]
];

const GRID = [
  ["CAMERA", "cam"],
  ["FACE", "face"],
  ["EYES", "eyes"],
  ["LIVENESS", "live"],
  ["BLINK", "blink"],
  ["IDENTITY", "id"]
];

function euclidean(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function score(bs, name) {
  const cat = bs.categories?.find(c => c.categoryName === name);
  return cat ? cat.score : 0;
}

const TPL_IDX = [10,152,234,454,33,133,263,362,61,291,1,168,70,300,105,334,129,358,205,425,127,356,93,323,172,397,58,288];

function descriptor(lm) {
  const iod = dist(lm[33], lm[263]) || 1;
  const o = lm[1];
  const v = [];
  for (const i of TPL_IDX) {
    v.push((lm[i].x - o.x) / iod, (lm[i].y - o.y) / iod);
  }
  return v;
}

const avg = list => list[0].map((_, i) => list.reduce((s, v) => s + v[i], 0) / list.length);
const vdist = (a, b) => Math.sqrt(a.reduce((s, x, i) => s + (x - b[i]) ** 2, 0) / a.length);

function inOval(lm) {
  const xs = lm.map(p => p.x), ys = lm.map(p => p.y);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const h = Math.max(...ys) - Math.min(...ys);
  return Math.abs(cx - .5) < .10 && Math.abs(cy - .5) < .10 && h > .38 && h < .85;
}

export class FaceLiveness {
  constructor(options = {}) {
    this.mode = options.mode || 'login';
    this.targetUser = options.targetUser || null;
    this.dom = options.dom || {};
    this.onSuccess = options.onSuccess || (() => {});
    this.onCancel = options.onCancel || (() => {});
    this.onFallback = options.onFallback || (() => {});
    
    this.landmarker = null;
    this.video = this.dom.video || null;
    this.overlayCanvas = this.dom.overlayCanvas || null;
    this.faceGuide = this.dom.faceGuide || null;
    this.msgEl = this.dom.msg || null;
    this.errBox = this.dom.errBox || null;
    this.stepsContainer = this.dom.stepsContainer || null;
    this.gridContainer = this.dom.gridContainer || null;
    this.retryBtn = this.dom.retryBtn || null;
    this.cancelBtn = this.dom.cancelBtn || null;
    this.fallbackBtn = this.dom.fallbackBtn || null;
    this.tabLogin = this.dom.tabLogin || null;
    this.tabReg = this.dom.tabReg || null;
    this.statusEls = this.dom.statusEls || {};
    
    this.landmarker = null;
    this.stream = null;
    this.runId = 0;
    this.challenge = null;
    this.firstFrameLogged = false;
    this.detectionErrorLogged = false;
    this.isInitializing = false;
    this.isRunning = false;
    this.frameRequestId = null;
    this.videoFrameRequestId = null;
    this.initPromise = null;
    this._lastTs = 0;
    this._lastVideoTime = -1;
    
    // State machine
    this.S = {
      phase: 0,
      still: [],
      noseHist: [],
      closed: false,
      closedAt: 0,
      blinks: 0,
      need: 2,
      descs: [],
      t0: 0,
      lastTs: -1,
      c: 0
    };
  }
  
  async init() {
    if (this.isInitializing && this.initPromise) return this.initPromise;
    if (this.isRunning) return this;

    this.isInitializing = true;
    this.initPromise = this._init();
    try {
      return await this.initPromise;
    } finally {
      this.isInitializing = false;
      this.initPromise = null;
    }
  }

  async _init() {
    this.firstFrameLogged = false;
    this.detectionErrorLogged = false;
    console.log('[FaceLiveness] Initializing...');
    this._injectStyles();
    this._buildStepsAndGrid();
    this._bindEvents();
    console.log('[FaceLiveness] Starting camera before model initialization...');
    await this._startCamera();
    this._say('Camera ready. Position your face in the guide.');
    console.log('[FaceLiveness] Loading model after camera is ready...');
    await this._loadModel();
    console.log('[FaceLiveness] Camera started, fetching challenge...');
    await this._fetchChallenge();
    console.log('[FaceLiveness] Starting main loop...');
    this._run();
    return this;
  }
  
  _injectStyles() {
    if (document.getElementById('face-liveness-styles')) return;
    const style = document.createElement('style');
    style.id = 'face-liveness-styles';
    style.textContent = `
      .face-liveness-step {display:flex;gap:10px;align-items:center;padding:9px 10px;border:1px solid var(--line);border-radius:8px;background:var(--panel);opacity:.45}
      .face-liveness-step i{width:20px;height:20px;border-radius:50%;border:2px solid var(--mute);flex:none}
      .face-liveness-step span{display:block;font-weight:600}.face-liveness-step small{color:var(--mute);font-size:11px}
      .face-liveness-step.active{opacity:1;border-color:var(--blue)}.face-liveness-step.active i{border-color:var(--blue);border-top-color:transparent;animation:sp 1s linear infinite}
      .face-liveness-step.done{opacity:1}.face-liveness-step.done i{background:var(--ok);border-color:var(--ok)}
      @keyframes sp{to{transform:rotate(360deg)}}
      .face-liveness-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px 14px;margin:12px 0;padding:10px;border:1px solid var(--line);border-radius:8px;background:var(--panel);font-size:11px}
      .face-liveness-grid div{display:flex;gap:6px;align-items:center}.face-liveness-grid em{color:var(--mute);font-style:normal;width:62px}
      .face-liveness-dot{width:7px;height:7px;border-radius:50%;background:var(--mute)}.face-liveness-dot.ok{background:var(--ok)}.face-liveness-dot.wait{background:var(--blue)}.face-liveness-dot.bad{background:var(--err)}
      .face-liveness-oval.good{border-color:var(--ok)}
      @media (prefers-reduced-motion:reduce){.face-liveness-step.active i{animation:none}}
    `;
    document.head.appendChild(style);
  }
  
  _buildStepsAndGrid() {
    if (!this.stepsContainer || !this.gridContainer) return;
    
    this.stepsContainer.innerHTML = STEPS.map((s, i) => 
      `<li class="face-liveness-step" data-i="${i}"><i></i><div><span>${s[0]}</span><small>${s[1]}</small></div></li>`
    ).join('');
    
    this.gridContainer.innerHTML = GRID.map(g => 
      `<div><em>${g[0]}</em><span class="face-liveness-dot" id="fl-d_${g[1]}"></span><span id="fl-t_${g[1]}">Waiting</span></div>`
    ).join('');
  }
  
  _bindEvents() {
    if (this.tabLogin) this.tabLogin.onclick = () => this._setMode('login');
    if (this.tabReg) this.tabReg.onclick = () => this._setMode('register');
    if (this.retryBtn) this.retryBtn.onclick = () => this._retry();
    if (this.cancelBtn) this.cancelBtn.onclick = () => this._cancel();
    if (this.fallbackBtn) this.fallbackBtn.onclick = () => this._fallback();
  }
  
  _setMode(mode) {
    this.mode = mode;
    if (this.tabLogin) this.tabLogin.setAttribute('aria-pressed', mode === 'login');
    if (this.tabReg) this.tabReg.setAttribute('aria-pressed', mode === 'register');
    this._stop();
    this._run();
  }
  
  _retry() {
    this.init().catch((error) => this._handleInitFailure(error));
  }
  
  _cancel() {
    this._stop();
    if (this.msgEl) this.msgEl.textContent = 'Cancelled';
    this._setStep(-1);
    this.onCancel();
  }
  
  _fallback() {
    this._stop();
    this.onFallback();
  }
  
  async _loadModel() {
    if (this.landmarker) return this.landmarker;

    let vision;
    try {
      vision = await import('/mediapipe/vision_bundle.mjs');
      console.log('[FaceLiveness] MediaPipe vision bundle loaded from local app assets');
    } catch (localError) {
      try {
        vision = await import(
          'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs'
        );
        console.warn('[FaceLiveness] Local vision bundle unavailable; CDN bundle loaded');
      } catch (remoteError) {
        const error = new Error(
          'The face verification engine could not be loaded. Check your internet connection and tap Retry.'
        );
        error.cause = remoteError;
        throw error;
      }
    }

    const { FaceLandmarker, FilesetResolver } = vision;
    const fs = await FilesetResolver.forVisionTasks(CFG.wasm);
    
    const make = delegate => FaceLandmarker.createFromOptions(fs, {
      baseOptions: { modelAssetPath: CFG.model, delegate },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: true
    });
    
    try {
      this.landmarker = await make('GPU');
      console.log('[FaceLiveness] FaceLandmarker model loaded with GPU delegate');
    } catch {
      this.landmarker = await make('CPU');
      console.log('[FaceLiveness] FaceLandmarker model loaded with CPU delegate');
    }
    return this.landmarker;
  }
  
  async _startCamera() {
    if (!window.startCamera) throw new Error('Camera helper is unavailable. Refresh and try again.');
    this.stream = await window.startCamera(this.video, this.errBox);
    const videoTracks = this.stream
      .getTracks()
      .filter((track) => track.kind === 'video');
    if (!videoTracks.length || videoTracks.some((track) => track.readyState !== 'live')) {
      this._stopCamera();
      throw new Error('CAMERA_UNAVAILABLE');
    }
    this._lastVideoTime = -1;
    videoTracks.forEach((track) => {
      track.addEventListener(
        'ended',
        () => this._handleRuntimeFailure('Camera stopped. Check the camera connection and tap Retry Camera.'),
        { once: true }
      );
    });
    this._setStat('cam', 'ok', 'Ready');
    console.log('[FaceLiveness] Shared camera started successfully');
  }
  
  _stopCamera() {
    if (window.stopCamera) window.stopCamera(this.video);
    this.stream = null;
  }
  
  async _fetchChallenge() {
    if (this.mode === 'login') {
      const res = await fetch('/api/liveness/challenge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ userIdHint: this.targetUser?.id })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        throw new Error(data.message || 'The biometric service could not be reached.');
      }
      this.challenge = data;
      this.S.need = data.requiredBlinks;
      this._say(data.instruction || 'Center your face in the guide');
    } else {
      this.challenge = {
        challengeId: 'local-' + crypto.randomUUID(),
        nonce: crypto.randomUUID(),
        challengeType: 'BLINK_TWICE',
        requiredBlinks: 2,
        expiresAt: new Date(Date.now() + 30000).toISOString()
      };
      this.S.need = 2;
      this._say('Center your face in the guide');
    }
  }
  
  _run() {
    console.log('[FaceLiveness] Starting run loop, runId:', this.runId + 1);
    const my = ++this.runId;
    this._resetState();
    this._say('Position your face in the guide.');
    this.isRunning = true;
    this._scheduleFrame(my);
  }
  
  _resetState() {
    this.S = {
      phase: 0,
      still: [],
      noseHist: [],
      closed: false,
      closedAt: 0,
      blinks: 0,
      need: this.challenge?.requiredBlinks || (1 + Math.floor(Math.random() * 2)),
      descs: [],
      t0: 0,
      lastTs: -1,
      c: 0
    };
    this._setStep(0);
    if (this.faceGuide) this.faceGuide.classList.remove('good');
    this._resetStats();
    if (this.errBox) this.errBox.hidden = true;
  }
  
  _resetStats() {
    this._setStat('cam', 'wait', 'Starting');
    this._setStat('face', '', 'Not detected');
    this._setStat('eyes', '', 'Not detected');
    this._setStat('live', 'wait', 'Waiting');
    this._setStat('blink', 'wait', 'Waiting');
    this._setStat('id', '', 'Not checked');
  }
  
  _setStat(key, state, text) {
    const dot = document.getElementById(`fl-d_${key}`);
    const txt = document.getElementById(`fl-t_${key}`);
    if (dot) dot.className = 'face-liveness-dot ' + state;
    if (txt) txt.textContent = text;
  }
  
  _setStep(n) {
    if (!this.stepsContainer) return;
    this.stepsContainer.querySelectorAll('.face-liveness-step').forEach((el, i) => {
      el.classList.toggle('done', i < n);
      el.classList.toggle('active', i === n);
    });
  }
  
  _say(text) {
    if (this.msgEl) this.msgEl.textContent = text;
  }
  
  _fail(text) {
    if (this.errBox) {
      this.errBox.textContent = text;
      this.errBox.hidden = false;
    }
    this._say('Stopped');
    this._stop();
  }
  
  _stop() {
    this.runId++;
    this.isRunning = false;
    if (this.frameRequestId !== null) {
      cancelAnimationFrame(this.frameRequestId);
      this.frameRequestId = null;
    }
    if (this.videoFrameRequestId !== null && this.video.cancelVideoFrameCallback) {
      this.video.cancelVideoFrameCallback(this.videoFrameRequestId);
      this.videoFrameRequestId = null;
    }
    this._stopCamera();
    if (this.landmarker && typeof this.landmarker.close === 'function') {
      try {
        this.landmarker.close();
      } catch (error) {
        console.warn('[FaceLiveness] Landmarker close warning:', error);
      }
    }
    this.landmarker = null;
  }

  _scheduleFrame(my) {
    if (my !== this.runId || !this.isRunning) return;
    if (typeof this.video.requestVideoFrameCallback === 'function') {
      this.videoFrameRequestId = this.video.requestVideoFrameCallback(() => {
        this.videoFrameRequestId = null;
        this._loop(my);
      });
    } else {
      this.frameRequestId = requestAnimationFrame(() => {
        this.frameRequestId = null;
        this._loop(my);
      });
    }
  }

  _loop(my) {
    if (my !== this.runId) return;
    if (!this.landmarker) return;
    
    const now = performance.now();
    const video = this.video;
    const videoReady =
      video &&
      video.readyState >= 2 &&
      video.videoWidth > 0 &&
      video.videoHeight > 0 &&
      !video.paused &&
      !video.ended;
    if (!videoReady) {
      this._scheduleFrame(my);
      return;
    }
    if (
      !Number.isFinite(video.currentTime) ||
      video.currentTime === this._lastVideoTime ||
      now <= this._lastTs
    ) {
      this._scheduleFrame(my);
      return;
    }
    this._lastVideoTime = video.currentTime;
    this._lastTs = now;
    {
      let r;
      try {
        r = this.landmarker.detectForVideo(this.video, now);
      } catch (error) {
        if (!this.detectionErrorLogged) {
          console.error('[FaceLiveness] First-frame detection failed:', error);
        }
        this._handleRuntimeFailure('Face detection failed. Tap Retry Camera.');
        return;
      }
      const lm = r.faceLandmarks?.[0];
      const bs = r.faceBlendshapes?.[0];
      
      if (!lm || !bs) {
        this._setStat('face', '', 'Not detected');
        this._setStat('eyes', '', 'Not detected');
        if (this.faceGuide) this.faceGuide.classList.remove('good');
        this.S.still = [];
        this.S.noseHist = [];
        if (this.S.phase > 0 && this.S.phase < 4) {
          this.S.phase = 0;
          this._setStep(0);
          this.S.blinks = 0;
          this._say('Face lost. Center your face in the guide');
        }
      } else {
        if (!this.firstFrameLogged) {
          this.firstFrameLogged = true;
          console.log('[FaceLiveness] First face frame detected');
        }
        this._step(lm, bs, now);
      }
    }
    this._scheduleFrame(my);
  }

  _handleInitFailure(error) {
    console.error('[FaceLiveness] Initialization failed:', error);
    this._setStat('cam', 'bad', 'Error');
    const message =
      error && error.message === 'CAMERA_UNAVAILABLE'
        ? 'Camera unavailable. Check the camera connection and tap Retry Camera.'
        : error && error.message
          ? error.message
          : 'Camera could not be started. Tap Retry Camera.';
    if (this.errBox) {
      this.errBox.textContent = message;
      this.errBox.classList.add('active');
    }
    this._stop();
    if (this.retryBtn) this.retryBtn.style.display = '';
  }

  _handleRuntimeFailure(message) {
    if (this.detectionErrorLogged) return;
    this.detectionErrorLogged = true;
    if (this.errBox) {
      this.errBox.textContent = message;
      this.errBox.classList.add('active');
    }
    this._setStat('cam', 'bad', 'Error');
    this._stop();
    if (this.retryBtn) this.retryBtn.style.display = '';
  }
  
  _step(lm, bs, now) {
    const centered = inOval(lm);
    if (this.faceGuide) this.faceGuide.classList.toggle('good', centered);
    this._setStat('face', centered ? 'ok' : 'bad', centered ? 'Detected' : 'Adjust position');
    
    const L = score(bs, 'eyeBlinkLeft');
    const R = score(bs, 'eyeBlinkRight');
    const eyesVisible = Math.max(L, R) < 0.9 || this.S.phase >= 3;
    this._setStat('eyes', eyesVisible ? 'ok' : 'bad', eyesVisible ? 'Detected' : 'Not detected');
    
    if (this.S.phase === 0) {
      if (centered) {
        this.S.phase = 1;
        this._setStep(1);
        this._say('Keep both eyes open');
      } else {
        this._say('Center your face in the guide');
      }
      return;
    }
    
    if (!centered && this.S.phase < 4) {
      this.S.phase = 0;
      this._setStep(0);
      this.S.still = [];
      this.S.blinks = 0;
      return;
    }
    
    if (this.S.phase === 1) {
      if (L < CFG.open && R < CFG.open) {
        if (++this.S.c > 12) {
          this.S.phase = 2;
          this._setStep(2);
          this._say('Hold still...');
        }
      } else {
        this.S.c = 0;
      }
      return;
    }
    
    if (this.S.phase === 2) {
      this.S.still.push({ n: lm[1], v: L + R + score(bs, 'jawOpen') + score(bs, 'mouthSmileLeft') });
      if (this.S.still.length > CFG.stillFrames) this.S.still.shift();
      if (this.S.still.length === CFG.stillFrames) {
        const xs = this.S.still.map(s => s.n.x);
        const ys = this.S.still.map(s => s.n.y);
        const drift = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
        if (drift < CFG.stillMax * 4) {
          this._setStat('live', 'ok', 'Passed');
          this.S.phase = 3;
          this._setStep(3);
          this.S.t0 = now;
          this.S.blinks = 0;
          this._setStat('blink', 'wait', 'Waiting');
          this._say(this.S.need === 1 ? 'Blink once now' : 'Blink twice now');
        } else {
          this._say('Hold still...');
        }
      }
      return;
    }
    
    if (this.S.phase === 3) {
      const avgB = (L + R) / 2;
      const bothClosed = L > CFG.closed && R > CFG.closed;
      if (!this.S.closed && bothClosed) {
        this.S.closed = true;
        this.S.closedAt = now;
      } else if (this.S.closed && avgB < CFG.open) {
        const d = now - this.S.closedAt;
        this.S.closed = false;
        if (d >= CFG.minBlinkMs && d <= CFG.maxBlinkMs) {
          this.S.blinks++;
          this._setStat('blink', 'ok', `${this.S.blinks}/${this.S.need}`);
          if (this.S.blinks >= this.S.need) {
            this.S.phase = 4;
            this._setStep(4);
            this.S.descs = [];
            this._say('Matching identity...');
            this._setStat('id', 'wait', 'Checking');
          }
        }
      }
      if (now - this.S.t0 > CFG.challengeTimeoutMs) {
        this._setStat('blink', 'bad', 'Timed out');
        this._fail('Blink not detected in time. Face the camera in good light and tap Try Again.');
      }
      return;
    }
    
    if (this.S.phase === 4) {
      if (L < CFG.open && R < CFG.open) this.S.descs.push(descriptor(lm));
      if (this.S.descs.length >= CFG.enrolFrames) {
        const d = avg(this.S.descs);
        if (this.mode === 'register') {
          localStorage.setItem(CFG.templateKey, JSON.stringify(d));
          this._setStat('id', 'ok', 'Enrolled');
          this._finish(d, 0);
        } else {
          const tpl = JSON.parse(localStorage.getItem(CFG.templateKey) || 'null');
          if (!tpl) {
            this._setStat('id', 'bad', 'No template');
            this._fail('No face registered yet. Switch to Register face first.');
            return;
          }
          const diff = vdist(d, tpl);
          console.info('match distance', diff.toFixed(4), 'threshold', CFG.matchMax);
          if (diff <= CFG.matchMax) {
            this._setStat('id', 'ok', 'Matched');
            this._finish(d, diff);
          } else {
            this._setStat('id', 'bad', 'No match');
            this._fail('Face did not match. Tap Try Again or use Aadhaar & PIN sign-in.');
          }
        }
      }
    }
  }
  
  _finish(d, score) {
    this._setStep(6);
    if (this.faceGuide) this.faceGuide.classList.add('good');
    this._say(this.mode === 'register' ? 'Face registered' : 'Authorized');
    const detail = { mode: this.mode, blinks: this.S.blinks, matchDistance: score, at: Date.now() };
    this._stop();
    this.onSuccess(detail);
    this.faceGuide?.dispatchEvent(new CustomEvent('liveness:success', { detail }));
  }
  
  destroy() {
    this._stop();
    this.isInitializing = false;
  }
}

// Export for both ESM and global
if (typeof window !== 'undefined') {
  window.FaceLiveness = FaceLiveness;
}