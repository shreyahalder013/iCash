/**
 * iCash FaceLiveness Component
 * Client-side blink liveness using MediaPipe FaceLandmarker (WASM)
 * Real 128D face embeddings via face-api.js FaceNet model
 * Server-authoritative enrollment & verification
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
  // Template key removed - we now use server-side encrypted storage
  modelLoadTimeoutMs: 20000,
  embeddingModelTimeoutMs: 15000,
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

// 468-point MediaPipe landmark indices for iris/eye regions
const IRIS_IDX = [468, 469, 470, 471, 472, 473, 474, 475, 476, 477]; // MediaPipe iris landmarks

export class FaceLiveness {
  constructor(options = {}) {
    this.mode = options.mode || 'login';
    this.targetUser = options.targetUser || null;
    this.dom = options.dom || {};
    this.onSuccess = options.onSuccess || (() => {});
    this.onCancel = options.onCancel || (() => {});
    this.onFallback = options.onFallback || (() => {});
    
    this.landmarker = null;
    this.faceApiNets = null; // { tinyFaceDetector, faceLandmark68Net, faceRecognitionNet }
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
    this._warnedNoFrames = false;
    this._warnedTimestamp = false;
    this._modelLoadAbortController = null;
    this._embeddings = []; // Collected 128D embeddings during blink challenge
    this._bestEmbedding = null; // Best quality embedding for enrollment/verification
    
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
    this._warnedNoFrames = false;
    this._warnedTimestamp = false;
    this._embeddings = [];
    this._bestEmbedding = null;
    console.log('[FaceLiveness] Initializing...');
    this._injectStyles();
    this._buildStepsAndGrid();
    this._bindEvents();
    console.log('[FaceLiveness] Starting camera before model initialization...');
    await this._startCamera();
    // Await video metadata and first playable frame before creating landmarker
    await this._awaitVideoReady();
    this._say('Camera ready. Position your face in the guide.');
    console.log('[FaceLiveness] Loading MediaPipe FaceLandmarker model...');
    await this._loadModel();
    console.log('[FaceLiveness] Loading face-api.js FaceNet embedding model...');
    await this._loadEmbeddingModel();
    console.log('[FaceLiveness] Camera started, fetching challenge...');
    await this._fetchChallenge();
    console.log('[FaceLiveness] Starting main loop...');
    this._run();
    return this;
  }

  _awaitVideoReady() {
    const video = this.video;
    if (!video) return Promise.reject(new Error('NO_VIDEO_ELEMENT'));
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('VIDEO_READY_TIMEOUT'));
      }, 15000);
      const cleanup = () => {
        clearTimeout(timeout);
        video.removeEventListener('loadedmetadata', onReady);
        video.removeEventListener('canplay', onReady);
        video.removeEventListener('playing', onReady);
        video.removeEventListener('error', onError);
      };
      const onReady = () => {
        if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0 && !video.paused && !video.ended) {
          cleanup();
          console.log('[FaceLiveness] Video ready:', video.videoWidth, 'x', video.videoHeight, 'readyState', video.readyState);
          resolve();
        }
      };
      const onError = () => {
        cleanup();
        reject(new Error('VIDEO_ERROR'));
      };
      video.addEventListener('loadedmetadata', onReady);
      video.addEventListener('canplay', onReady);
      video.addEventListener('playing', onReady);
      video.addEventListener('error', onError);
      // Also check current state in case events already fired
      onReady();
    });
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
    this._modelLoadAbortController = new AbortController();
    
    // Timeout for model loading
    const modelLoadPromise = (async () => {
      try {
        vision = await import('/mediapipe/vision_bundle.mjs');
        console.log('[FaceLiveness] MediaPipe vision bundle loaded from local app assets');
      } catch (localError) {
        console.warn('[FaceLiveness] Local vision bundle unavailable, trying CDN...');
        try {
          vision = await import(
            'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs'
          );
          console.warn('[FaceLiveness] CDN vision bundle loaded');
        } catch (remoteError) {
          throw new Error('The face verification engine could not be loaded. Check your internet connection and tap Retry.');
        }
      }
    })();

    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('MODEL_LOAD_TIMEOUT')), CFG.modelLoadTimeoutMs)
    );

    try {
      await Promise.race([modelLoadPromise, timeoutPromise]);
    } catch (error) {
      if (error.message === 'MODEL_LOAD_TIMEOUT') {
        throw new Error('Face model took too long to load. Check your connection and tap Retry.');
      }
      throw error;
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
    } catch (gpuError) {
      console.warn('[FaceLiveness] GPU delegate failed, falling back to CPU:', gpuError.message);
      try {
        this.landmarker = await make('CPU');
        console.log('[FaceLiveness] FaceLandmarker model loaded with CPU delegate');
      } catch (cpuError) {
        throw new Error('Failed to create FaceLandmarker with both GPU and CPU delegates');
      }
    }
    return this.landmarker;
  }

  async _loadEmbeddingModel() {
    // Load face-api.js models for 128D FaceNet embeddings
    // Models are already loaded by biometric.js's ensureBioModels(), but we ensure they're ready
    if (window._bioModelsLoaded && typeof faceapi !== 'undefined') {
      console.log('[FaceLiveness] face-api.js models already loaded');
      return;
    }

    console.log('[FaceLiveness] Waiting for face-api.js models...');
    const startTime = Date.now();
    
    while (!window._bioModelsLoaded || typeof faceapi === 'undefined') {
      if (Date.now() - startTime > CFG.embeddingModelTimeoutMs) {
        throw new Error('Face recognition model failed to load. Tap Retry to try again.');
      }
      await new Promise(r => setTimeout(r, 100));
    }
    
    console.log('[FaceLiveness] face-api.js FaceNet embedding model ready');
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
      // Registration mode - get liveness challenge (no face match needed for new user)
      const res = await fetch('/api/liveness/challenge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({})
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        // Fallback to local challenge if server unavailable during registration
        console.warn('[FaceLiveness] Server challenge unavailable, using local challenge');
        this.challenge = {
          challengeId: 'local-' + crypto.randomUUID(),
          nonce: crypto.randomUUID(),
          challengeType: 'BLINK_TWICE',
          requiredBlinks: 2,
          expiresAt: new Date(Date.now() + 30000).toISOString()
        };
      } else {
        this.challenge = data;
      }
      this.S.need = this.challenge.requiredBlinks || 2;
      this._say(this.challenge.instruction || 'Center your face in the guide');
    }
  }
  
  _run() {
    console.log('[FaceLiveness] Starting run loop, runId:', this.runId + 1);
    const my = ++this.runId;
    this._resetState();
    this._say('Position your face in the guide.');
    this.isRunning = true;
    // Reset timestamp state on every fresh run
    this._lastTs = 0;
    this._lastVideoTime = -1;
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
      need: this.challenge?.requiredBlinks || 2,
      descs: [],
      t0: 0,
      lastTs: -1,
      c: 0
    };
    this._embeddings = [];
    this._bestEmbedding = null;
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
    if (this.videoFrameRequestId !== null && this.video?.cancelVideoFrameCallback) {
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
    if (this.video) {
      this.video.srcObject = null;
    }
    if (this._modelLoadAbortController) {
      this._modelLoadAbortController.abort();
      this._modelLoadAbortController = null;
    }
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
    
    // Frame readiness guard: skip if video not ready
    const videoReady =
      video &&
      video.readyState >= 2 &&
      video.videoWidth > 0 &&
      video.videoHeight > 0 &&
      !video.paused &&
      !video.ended;
    if (!videoReady) {
      if (!this._warnedNoFrames) {
        console.warn('[FaceLiveness] Video not ready, skipping frame');
        this._warnedNoFrames = true;
      }
      this._scheduleFrame(my);
      return;
    }
    this._warnedNoFrames = false;

    // Skip if video time hasn't advanced (no new frame)
    if (
      !Number.isFinite(video.currentTime) ||
      video.currentTime === this._lastVideoTime
    ) {
      this._scheduleFrame(my);
      return;
    }

    // Strictly increasing timestamps
    if (now <= this._lastTs) {
      if (!this._warnedTimestamp) {
        console.warn('[FaceLiveness] Non-monotonic timestamp, skipping frame');
        this._warnedTimestamp = true;
      }
      this._scheduleFrame(my);
      return;
    }
    this._warnedTimestamp = false;

    this._lastVideoTime = video.currentTime;
    this._lastTs = now;

    let r;
    try {
      r = this.landmarker.detectForVideo(this.video, now);
    } catch (error) {
      if (!this.detectionErrorLogged) {
        this.detectionErrorLogged = true;
        console.error('[FaceLiveness] Detection failed:', error);
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
  
  async _step(lm, bs, now) {
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
      this._embeddings = [];
      this._bestEmbedding = null;
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
          
          // Capture face embedding on each valid blink (eyes open frame after blink)
          // This gives us multiple embeddings across slight pose variations
          try {
            const embedding = await this._captureEmbedding();
            if (embedding) {
              this._embeddings.push(embedding);
              // Keep best quality embedding (most frontal)
              if (!this._bestEmbedding || this._embeddingQuality(embedding) > this._embeddingQuality(this._bestEmbedding)) {
                this._bestEmbedding = embedding;
              }
            }
          } catch (e) {
            console.warn('[FaceLiveness] Embedding capture failed:', e.message);
          }
          
          if (this.S.blinks >= this.S.need) {
            this.S.phase = 4;
            this._setStep(4);
            this._say('Matching identity...');
            this._setStat('id', 'wait', 'Checking');
            
            // After blink challenge complete, proceed to server verification/enrollment
            await this._completeServerFlow();
          }
        }
      }
      if (now - this.S.t0 > CFG.challengeTimeoutMs) {
        this._setStat('blink', 'bad', 'Timed out');
        this._fail('Blink not detected in time. Face the camera in good light and tap Try Again.');
      }
      return;
    }
  }

  async _captureEmbedding() {
    if (!this.video || typeof faceapi === 'undefined') return null;
    
    try {
      // Use face-api.js to get 128D FaceNet embedding
      const detection = await faceapi
        .detectSingleFace(this.video, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.3 }))
        .withFaceLandmarks()
        .withFaceDescriptor();
      
      if (!detection || !detection.descriptor) return null;
      
      // Return as plain array for JSON serialization
      return Array.from(detection.descriptor);
    } catch (e) {
      console.warn('[FaceLiveness] face-api.js detection failed:', e.message);
      return null;
    }
  }

  _embeddingQuality(embedding) {
    // Quality heuristic: prefer embeddings captured when face is well-centered
    // For now, just return a constant - in practice could use face size, pose, etc.
    return 1.0;
  }

  async _completeServerFlow() {
    if (!this.challenge || this._embeddings.length === 0) {
      this._fail('Insufficient biometric data captured. Please try again.');
      return;
    }

    // For registration: submit registration form with captured descriptors
    // For login: verify challenge with server
    if (this.mode === 'register') {
      await this._completeRegistration();
    } else {
      await this._completeLogin();
    }
  }

  async _completeRegistration() {
    this._setStat('id', 'wait', 'Registering...');
    this._say('Creating your account...');

    try {
      // Use all collected embeddings as descriptors (multiple samples for robustness)
      const descriptors = this._embeddings.length > 0 ? this._embeddings : [this._bestEmbedding].filter(Boolean);
      
      if (descriptors.length === 0) {
        throw new Error('No valid face descriptors captured. Please try again.');
      }

      // Get pending registration payload from script.js
      const regPayload = window._pendingRegPayload;
      if (!regPayload) {
        throw new Error('Registration data not found. Please start over.');
      }

      // Submit registration with biometric descriptors (array of 128-element arrays, max 10)
      const registerRes = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          ...regPayload,
          descriptors: descriptors
        })
      });

      const data = await registerRes.json().catch(() => ({}));

      if (!registerRes.ok || !data.ok || !data.user) {
        throw new Error(data.message || 'Registration failed.');
      }

      console.log('[FaceLiveness] Registration succeeded, user created:', data.user.id);
      this._setStat('id', 'ok', 'Enrolled');
      this._finish({ mode: 'register', blinks: this.S.blinks, matchDistance: 0, at: Date.now() }, data.user);

    } catch (err) {
      console.error('[FaceLiveness] Registration error:', err);
      this._setStat('id', 'bad', 'Failed');
      this._fail(err.message || 'Registration failed. Please try again.');
    }
  }

  async _completeLogin() {
    this._setStat('id', 'wait', 'Verifying...');
    this._say('Verifying with server...');

    try {
      // Use the best quality embedding for verification
      if (!this._bestEmbedding) {
        throw new Error('No valid face embedding captured. Please try again.');
      }

      const verifyPayload = {
        challengeId: this.challenge.challengeId,
        nonce: this.challenge.nonce,
        descriptor: this._bestEmbedding,
        blinks: this.S.blinks,
        durationMs: performance.now() - this.S.t0,
        mode: this.mode
      };

      console.log('[FaceLiveness] Sending verification to server...', { 
        challengeId: this.challenge.challengeId, 
        blinks: this.S.blinks,
        embeddingLength: this._bestEmbedding.length 
      });

      const verifyRes = await fetch('/api/liveness/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(verifyPayload)
      });

      const data = await verifyRes.json().catch(() => ({}));

      if (!verifyRes.ok || !data.ok || !data.biometricToken) {
        throw new Error(data.message || 'Identity verification failed.');
      }

      console.log('[FaceLiveness] Server verification succeeded, got biometricToken');

      // Use biometricToken to login
      const authRes = await fetch('/api/auth/login-biometric', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ biometricToken: data.biometricToken })
      });

      const authData = await authRes.json().catch(() => ({}));

      if (!authRes.ok || !authData.ok || !authData.user) {
        throw new Error(authData.message || 'Failed to establish session');
      }

      this._setStat('id', 'ok', 'Matched');
      this._finish({ mode: 'login', blinks: this.S.blinks, matchDistance: data.distance || 0, at: Date.now() }, authData.user);

    } catch (err) {
      console.error('[FaceLiveness] Login error:', err);
      this._setStat('id', 'bad', 'Failed');
      this._fail(err.message || 'Login failed. Please try again.');
    }
  }

  _finish(detail, user) {
    this._setStep(6);
    if (this.faceGuide) this.faceGuide.classList.add('good');
    this._say(this.mode === 'register' ? 'Face registered' : 'Authorized');
    detail.user = user;
    this._stop();
    this.onSuccess(detail);
    this.faceGuide?.dispatchEvent(new CustomEvent('liveness:success', { detail }));
  }
  
  destroy() {
    this._stop();
    this.isInitializing = false;
    this.initPromise = null;
    this.challenge = null;
    this.firstFrameLogged = false;
    this.detectionErrorLogged = false;
    this._warnedNoFrames = false;
    this._warnedTimestamp = false;
    this._lastTs = 0;
    this._lastVideoTime = -1;
    this._embeddings = [];
    this._bestEmbedding = null;
  }
}

// Export for both ESM and global
if (typeof window !== 'undefined') {
  window.FaceLiveness = FaceLiveness;
}