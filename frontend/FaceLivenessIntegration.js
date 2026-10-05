/**
 * FaceLiveness Integration
 * Bridges existing biometric.js DOM with new FaceLiveness component
 */

import { FaceLiveness } from './FaceLiveness.js';

let faceLivenessInstance = null;

// Initialize FaceLiveness for login screen
export async function initLoginLiveness(targetUser) {
  if (faceLivenessInstance) {
    faceLivenessInstance.destroy();
  }
  
  const video = document.getElementById('login-video');
  const overlayCanvas = document.getElementById('login-overlay-canvas');
  const faceGuide = document.getElementById('face-guide')?.querySelector('.face-guide-frame');
  const msg = document.getElementById('login-banner-text') || document.getElementById('login-instruction-text');
  const errBox = document.getElementById('login-cam-error') || document.getElementById('login-err');
  const stepsContainer = document.getElementById('login-steps');
  const gridContainer = document.getElementById('login-status-grid');
  const retryBtn = document.getElementById('login-retry-btn') || document.getElementById('login-retry-cam-btn');
  const cancelBtn = document.getElementById('login-cancel-btn');
  const fallbackBtn = document.getElementById('login-fallback-btn');
  const tabLogin = document.getElementById('login-tab-login');
  const tabReg = document.getElementById('login-tab-reg');
  
  // Status elements
  const statusEls = {
    cam: document.getElementById('status-camera') || document.getElementById('login-status-camera'),
    face: document.getElementById('status-face') || document.getElementById('login-status-face'),
    eyes: document.getElementById('status-eyes') || document.getElementById('login-status-eyes'),
    live: document.getElementById('status-liveness') || document.getElementById('login-status-liveness'),
    blink: document.getElementById('status-blink') || document.getElementById('login-status-blink'),
    id: document.getElementById('status-identity') || document.getElementById('login-status-identity'),
  };
  
  if (!video) {
    console.warn('[FaceLiveness] Login video element not found');
    return null;
  }
  
  // Ensure steps and grid containers exist
  if (!stepsContainer) {
    console.warn('[FaceLiveness] Steps container not found');
  }
  if (!gridContainer) {
    console.warn('[FaceLiveness] Grid container not found');
  }
  
  faceLivenessInstance = new FaceLiveness({
    mode: 'login',
    targetUser,
    dom: {
      video,
      overlayCanvas,
      faceGuide,
      msg,
      errBox,
      stepsContainer,
      gridContainer,
      retryBtn,
      cancelBtn,
      fallbackBtn,
      tabLogin,
      tabReg,
      statusEls,
    },
    onSuccess: (detail) => {
      console.log('[FaceLiveness] Login success:', detail);
      // Trigger existing success handler
      if (window.handleLivenessSuccess) {
        window.handleLivenessSuccess(detail);
      }
      // Also dispatch event for existing listeners
      window.dispatchEvent(new CustomEvent('liveness:success', { detail }));
    },
    onCancel: () => {
      console.log('[FaceLiveness] Login cancelled');
      if (window.handleLivenessCancel) {
        window.handleLivenessCancel();
      }
      window.dispatchEvent(new Event('liveness:cancel'));
    },
    onFallback: () => {
      console.log('[FaceLiveness] Login fallback to PIN');
      if (window.handleLivenessFallback) {
        window.handleLivenessFallback();
      }
      window.dispatchEvent(new Event('liveness:fallback'));
    }
  });
  
  try {
    await faceLivenessInstance.init();
    return faceLivenessInstance;
  } catch (e) {
    console.error('[FaceLiveness] Init failed:', e);
    return null;
  }
}

// Initialize FaceLiveness for register screen
export async function initRegisterLiveness() {
  if (faceLivenessInstance) {
    faceLivenessInstance.destroy();
  }
  
  const video = document.getElementById('reg-video') || document.getElementById('register-video');
  const overlayCanvas = document.getElementById('reg-overlay-canvas') || document.getElementById('register-overlay-canvas');
  const faceGuide = document.getElementById('reg-face-guide')?.querySelector('.face-guide-frame') || 
                    document.getElementById('register-face-guide')?.querySelector('.face-guide-frame');
  const msg = document.getElementById('reg-banner-text') || document.getElementById('reg-instruction-text') ||
              document.getElementById('register-banner-text');
  const errBox = document.getElementById('reg-cam-error') || document.getElementById('reg-err') || 
                 document.getElementById('register-cam-error');
  const stepsContainer = document.getElementById('reg-steps') || document.getElementById('register-steps');
  const gridContainer = document.getElementById('reg-status-grid') || document.getElementById('register-status-grid');
  const retryBtn = document.getElementById('reg-retry-btn') || document.getElementById('register-retry-btn');
  const cancelBtn = document.getElementById('reg-cancel-btn') || document.getElementById('register-cancel-btn');
  const fallbackBtn = document.getElementById('reg-fallback-btn') || document.getElementById('register-fallback-btn');
  const tabLogin = document.getElementById('reg-tab-login') || document.getElementById('register-tab-login');
  const tabReg = document.getElementById('reg-tab-reg') || document.getElementById('register-tab-reg');
  
  const statusEls = {
    cam: document.getElementById('reg-status-camera') || document.getElementById('register-status-camera'),
    face: document.getElementById('reg-status-face') || document.getElementById('register-status-face'),
    eyes: document.getElementById('reg-status-eyes') || document.getElementById('register-status-eyes'),
    live: document.getElementById('reg-status-liveness') || document.getElementById('register-status-liveness'),
    blink: document.getElementById('reg-status-blink') || document.getElementById('register-status-blink'),
    id: document.getElementById('reg-status-identity') || document.getElementById('register-status-identity'),
  };
  
  if (!video) {
    console.warn('[FaceLiveness] Register video element not found');
    return null;
  }
  
  faceLivenessInstance = new FaceLiveness({
    mode: 'register',
    dom: {
      video,
      overlayCanvas,
      faceGuide,
      msg,
      errBox,
      stepsContainer,
      gridContainer,
      retryBtn,
      cancelBtn,
      fallbackBtn,
      tabLogin,
      tabReg,
      statusEls,
    },
    onSuccess: (detail) => {
      console.log('[FaceLiveness] Register success:', detail);
      if (window.handleRegisterLivenessSuccess) {
        window.handleRegisterLivenessSuccess(detail);
      }
      window.dispatchEvent(new CustomEvent('liveness:success', { detail }));
    },
    onCancel: () => {
      console.log('[FaceLiveness] Register cancelled');
      if (window.handleRegisterLivenessCancel) {
        window.handleRegisterLivenessCancel();
      }
      window.dispatchEvent(new Event('liveness:cancel'));
    },
    onFallback: () => {
      console.log('[FaceLiveness] Register fallback');
      if (window.handleRegisterLivenessFallback) {
        window.handleRegisterLivenessFallback();
      }
      window.dispatchEvent(new Event('liveness:fallback'));
    }
  });
  
  try {
    await faceLivenessInstance.init();
    return faceLivenessInstance;
  } catch (e) {
    console.error('[FaceLiveness] Register init failed:', e);
    return null;
  }
}

// Cleanup function
export function teardownFaceLiveness() {
  if (faceLivenessInstance) {
    faceLivenessInstance.destroy();
    faceLivenessInstance = null;
  }
}

// Export for global access
if (typeof window !== 'undefined') {
  window.initLoginLiveness = initLoginLiveness;
  window.initRegisterLiveness = initRegisterLiveness;
  window.teardownFaceLiveness = teardownFaceLiveness;
}