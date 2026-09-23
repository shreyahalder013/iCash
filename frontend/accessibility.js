/**
 * iCash Accessibility & Senior-Friendly Subsystem (Phases 13, 14, 16)
 *
 * Implements first-class accessibility:
 *   1. Accessible Banking Mode:
 *      - High Contrast Mode (WCAG AAA compliant)
 *      - Scalable Large Typography (125% - 150%)
 *      - Large Touch Target buttons (>= 48px)
 *      - High-visibility keyboard focus indicators (:focus-visible)
 *      - ARIA Live screen-reader announcements (polite & assertive)
 *      - Reduced animations support (manual toggle + prefers-reduced-motion)
 *      - Persistent Help and Back buttons
 *      - Multi-modal voice guidance via Web Speech API
 *
 *   2. Senior Citizen Mode:
 *      - Simplified layout with fewer simultaneous choices
 *      - Plain-language transaction summaries ("Continue with ₹5,000 transfer to Rahul Sharma")
 *      - Interactive Large Numeric Touch Keypad for PIN
 *      - Audio readback of important transaction details
 *      - Prominent Help & Home buttons (no icon-only critical actions)
 *
 *   3. Voice Guided Authentication & PIN Fallback:
 *      - Audio guidance for visually impaired users
 *      - Direct PIN authentication path without requiring eye blinks
 *
 *   4. Voice Feedback Controls (used by the Assisted / Voice Mode panel):
 *      - muteVoice / unmuteVoice / repeatLast / stopSpeaking / setVoiceSpeed
 *      - Every voice interaction keeps a visual text equivalent.
 */

(function () {
  const STORAGE_KEYS = {
    ACCESSIBLE: 'icash_accessible_mode',
    SENIOR: 'icash_senior_mode',
    HIGH_CONTRAST: 'icash_high_contrast',
    LARGE_TEXT: 'icash_large_text',
    VOICE_GUIDE: 'icash_voice_guidance',
    REDUCE_MOTION: 'icash_reduce_motion',
    VOICE_SPEED: 'icash_voice_speed',
  };

  const AccessibilityManager = {
    isAccessible: false,
    isSenior: false,
    isHighContrast: false,
    isLargeText: false,
    isReducedMotion: false,
    voiceGuidance: true,
    voiceSpeed: 1.0,
    lastSpokenMessage: '',
    speechSynth: typeof window !== 'undefined' && 'speechSynthesis' in window ? window.speechSynthesis : null,

    init() {
      try {
        this.isAccessible = localStorage.getItem(STORAGE_KEYS.ACCESSIBLE) === 'true';
        this.isSenior = localStorage.getItem(STORAGE_KEYS.SENIOR) === 'true';
        this.isHighContrast = localStorage.getItem(STORAGE_KEYS.HIGH_CONTRAST) === 'true';
        this.isLargeText = localStorage.getItem(STORAGE_KEYS.LARGE_TEXT) === 'true';
        this.isReducedMotion = localStorage.getItem(STORAGE_KEYS.REDUCE_MOTION) === 'true';
        this.voiceGuidance = localStorage.getItem(STORAGE_KEYS.VOICE_GUIDE) !== 'false'; // default true
        const speed = parseFloat(localStorage.getItem(STORAGE_KEYS.VOICE_SPEED));
        if (!isNaN(speed) && speed >= 0.5 && speed <= 2) this.voiceSpeed = speed;
      } catch (_) {}

      // Respect the OS-level reduced-motion preference unless the user chose otherwise
      try {
        if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches && localStorage.getItem(STORAGE_KEYS.REDUCE_MOTION) === null) {
          this.isReducedMotion = true;
        }
      } catch (_) {}

      this.applyStyles();
      this.ensureAnnouncer();
      this.bindKeypadEvents();
      this.bindAccessibilityModalSync();
      console.log('[iCash Accessibility] Initialized. Accessible:', this.isAccessible, 'Senior:', this.isSenior);
    },

    ensureAnnouncer() {
      let announcer = document.getElementById('aria-live-announcer');
      if (!announcer && typeof document !== 'undefined') {
        announcer = document.createElement('div');
        announcer.id = 'aria-live-announcer';
        announcer.className = 'sr-only';
        announcer.setAttribute('aria-live', 'polite');
        announcer.setAttribute('aria-atomic', 'true');
        announcer.style.cssText = 'position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden;';
        document.body?.appendChild(announcer);
      }
    },

    announce(message, priority = 'polite') {
      if (!message) return;
      const announcer = document.getElementById('aria-live-announcer') || this.ensureAnnouncer();
      if (announcer) {
        announcer.setAttribute('aria-live', priority);
        announcer.textContent = '';
        setTimeout(() => {
          announcer.textContent = message;
        }, 50);
      }

      // Always keep the visual text equivalent up to date, even when muted
      this.lastSpokenMessage = message;

      if (this.voiceGuidance && this.speechSynth) {
        this.speak(message);
      }
    },

    speak(text) {
      if (!this.speechSynth || !this.voiceGuidance) return;
      if (!text) return;
      this.lastSpokenMessage = text;
      try {
        this.speechSynth.cancel(); // cancel prior speech
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.rate = this.isSenior ? Math.min(this.voiceSpeed, 0.95) : this.voiceSpeed;
        utterance.pitch = 1.0;
        utterance.lang = 'en-IN'; // Indian English preferred
        this.speechSynth.speak(utterance);
      } catch (e) {
        console.warn('[iCash Speech] Speak error:', e);
      }
    },

    // ── Voice Feedback Controls (Assisted / Voice Mode panel) ────────────────
    /** Mute voice feedback (speech stops; visual text equivalents remain). */
    muteVoice() {
      this.voiceGuidance = false;
      try {
        localStorage.setItem(STORAGE_KEYS.VOICE_GUIDE, 'false');
      } catch (_) {}
      if (this.speechSynth) this.speechSynth.cancel();
      this.updateTogglesUI();
      this.updateVoiceControlsUI();
      this.announceVisualOnly('Voice feedback muted.');
    },

    /** Unmute voice feedback. */
    unmuteVoice() {
      this.voiceGuidance = true;
      try {
        localStorage.setItem(STORAGE_KEYS.VOICE_GUIDE, 'true');
      } catch (_) {}
      this.updateTogglesUI();
      this.updateVoiceControlsUI();
      this.announce('Voice feedback on.');
    },

    /** Stop the current utterance immediately (does not change mute state). */
    stopSpeaking() {
      if (this.speechSynth) this.speechSynth.cancel();
    },

    /** Repeat the last announced message aloud. */
    repeatLast() {
      if (!this.lastSpokenMessage) {
        this.announce('Nothing to repeat yet.');
        return;
      }
      if (!this.voiceGuidance) this.unmuteVoice();
      // Speak directly (bypasses announce dedupe) without overwriting lastSpokenMessage
      const message = this.lastSpokenMessage;
      if (this.speechSynth) {
        try {
          this.speechSynth.cancel();
          const utterance = new SpeechSynthesisUtterance(message);
          utterance.rate = this.isSenior ? Math.min(this.voiceSpeed, 0.95) : this.voiceSpeed;
          utterance.pitch = 1.0;
          utterance.lang = 'en-IN';
          this.speechSynth.speak(utterance);
        } catch (e) {
          console.warn('[iCash Speech] Repeat error:', e);
        }
      }
    },

    /**
     * Cycle voice speed: 0.85x → 1.0x → 1.2x → 0.85x …
     * Returns the new rate so callers can display it.
     */
    setVoiceSpeed(rate) {
      if (typeof rate === 'number' && rate >= 0.5 && rate <= 2) {
        this.voiceSpeed = rate;
      } else {
        this.voiceSpeed = Math.abs(this.voiceSpeed - 0.85) < 0.01 ? 1.0 : Math.abs(this.voiceSpeed - 1.0) < 0.01 ? 1.2 : 0.85;
      }
      try {
        localStorage.setItem(STORAGE_KEYS.VOICE_SPEED, String(this.voiceSpeed));
      } catch (_) {}
      this.updateVoiceControlsUI();
      this.announce(`Voice speed set to ${this.voiceSpeed.toFixed(2)} times.`);
      return this.voiceSpeed;
    },

    /** Announce without speaking (used right after muting). */
    announceVisualOnly(message) {
      const announcer = document.getElementById('aria-live-announcer') || this.ensureAnnouncer();
      if (announcer) {
        announcer.textContent = '';
        setTimeout(() => {
          announcer.textContent = message;
        }, 50);
      }
      this.lastSpokenMessage = message;
      const statusEl = document.getElementById('voice-mode-status');
      if (statusEl && !statusEl.textContent) statusEl.textContent = message;
    },

    /** Keep the Assisted / Voice Mode panel controls in sync with state. */
    updateVoiceControlsUI() {
      const muteBtn = document.getElementById('voice-mute-btn');
      if (muteBtn) {
        const muted = !this.voiceGuidance;
        muteBtn.setAttribute('aria-pressed', String(muted));
        muteBtn.textContent = muted ? '\u{1F534} Muted' : '\u{1F50A} Mute';
      }
      const speedBtn = document.getElementById('voice-speed-btn');
      if (speedBtn) {
        speedBtn.textContent = `\u23F1 Speed ${this.voiceSpeed.toFixed(2)}\u00D7`;
      }
      const onOffBtn = document.getElementById('voice-mode-toggle-btn');
      if (onOffBtn) {
        onOffBtn.setAttribute('aria-pressed', String(this.voiceGuidance));
        onOffBtn.textContent = this.voiceGuidance ? '\uD83D\uDD18 Assisted Mode ON' : '\u26AA Assisted Mode OFF';
        onOffBtn.classList.toggle('active', this.voiceGuidance);
      }
    },

    toggleAccessibleMode(force) {
      this.isAccessible = force !== undefined ? Boolean(force) : !this.isAccessible;
      localStorage.setItem(STORAGE_KEYS.ACCESSIBLE, String(this.isAccessible));
      if (this.isAccessible) {
        this.isHighContrast = true;
        this.isLargeText = true;
      }
      this.applyStyles();
      this.announce(this.isAccessible ? 'Accessible banking mode enabled.' : 'Accessible banking mode disabled.');
      this.updateTogglesUI();
    },

    toggleSeniorMode(force) {
      this.isSenior = force !== undefined ? Boolean(force) : !this.isSenior;
      localStorage.setItem(STORAGE_KEYS.SENIOR, String(this.isSenior));
      if (this.isSenior) {
        this.isLargeText = true;
        this.voiceGuidance = true;
      }
      this.applyStyles();
      this.announce(this.isSenior ? 'Senior citizen assisted banking mode enabled.' : 'Senior mode disabled.');
      this.updateTogglesUI();
    },

    toggleHighContrast(force) {
      this.isHighContrast = force !== undefined ? Boolean(force) : !this.isHighContrast;
      localStorage.setItem(STORAGE_KEYS.HIGH_CONTRAST, String(this.isHighContrast));
      this.applyStyles();
      this.announce(this.isHighContrast ? 'High contrast theme enabled.' : 'Standard contrast enabled.');
    },

    toggleLargeText(force) {
      this.isLargeText = force !== undefined ? Boolean(force) : !this.isLargeText;
      localStorage.setItem(STORAGE_KEYS.LARGE_TEXT, String(this.isLargeText));
      this.applyStyles();
      this.announce(this.isLargeText ? 'Large typography enabled.' : 'Standard text size restored.');
    },

    toggleReduceMotion(force) {
      this.isReducedMotion = force !== undefined ? Boolean(force) : !this.isReducedMotion;
      localStorage.setItem(STORAGE_KEYS.REDUCE_MOTION, String(this.isReducedMotion));
      this.applyStyles();
      this.announce(this.isReducedMotion ? 'Reduced motion enabled.' : 'Animations restored.');
      // Let the Three.js background engine pause itself when reduced motion is on
      try {
        window.dispatchEvent(new CustomEvent('icash:reduced-motion', { detail: { reduced: this.isReducedMotion } }));
      } catch (_) {}
    },

    toggleVoiceGuidance(force) {
      this.voiceGuidance = force !== undefined ? Boolean(force) : !this.voiceGuidance;
      localStorage.setItem(STORAGE_KEYS.VOICE_GUIDE, String(this.voiceGuidance));
      if (this.voiceGuidance) {
        this.speak('Voice guidance activated.');
      } else if (this.speechSynth) {
        this.speechSynth.cancel();
      }
      this.updateTogglesUI();
      this.updateVoiceControlsUI();
    },

    applyStyles() {
      const body = document.body;
      if (!body) return;

      body.classList.toggle('accessible-mode', this.isAccessible);
      body.classList.toggle('senior-mode', this.isSenior);
      body.classList.toggle('high-contrast', this.isHighContrast || this.isAccessible);
      body.classList.toggle('large-text', this.isLargeText || this.isAccessible || this.isSenior);
      body.classList.toggle('reduced-motion', this.isReducedMotion);

      // Adjust CSS variables dynamically
      const root = document.documentElement;
      if (this.isAccessible || this.isHighContrast) {
        root.style.setProperty('--contrast-border', '#38bdf8');
        root.style.setProperty('--contrast-text', '#ffffff');
      } else {
        root.style.removeProperty('--contrast-border');
        root.style.removeProperty('--contrast-text');
      }

      this.updateTogglesUI();
    },

    updateTogglesUI() {
      const accBtn = document.getElementById('toggle-accessible-btn');
      if (accBtn) {
        accBtn.setAttribute('aria-pressed', String(this.isAccessible));
        accBtn.classList.toggle('active', this.isAccessible);
      }
      const senBtn = document.getElementById('toggle-senior-btn');
      if (senBtn) {
        senBtn.setAttribute('aria-pressed', String(this.isSenior));
        senBtn.classList.toggle('active', this.isSenior);
      }
      const voiceBtn = document.getElementById('toggle-voice-btn');
      if (voiceBtn) {
        voiceBtn.setAttribute('aria-pressed', String(this.voiceGuidance));
        voiceBtn.classList.toggle('active', this.voiceGuidance);
      }
      // Keep the Accessibility Options modal checkboxes in sync with live state
      const hc = document.getElementById('acc-high-contrast');
      if (hc) hc.checked = this.isHighContrast || this.isAccessible;
      const lt = document.getElementById('acc-large-text');
      if (lt) lt.checked = this.isLargeText || this.isAccessible || this.isSenior;
      const rm = document.getElementById('acc-reduce-motion');
      if (rm) rm.checked = this.isReducedMotion;
      const vg = document.getElementById('acc-voice-guidance');
      if (vg) vg.checked = this.voiceGuidance;
    },

    /**
     * Sync the Accessibility Options modal checkboxes with live state
     * whenever the modal is shown (MutationObserver on the backdrop).
     */
    bindAccessibilityModalSync() {
      if (typeof MutationObserver === 'undefined') return;
      const modal = document.getElementById('modal-accessibility-info');
      if (!modal) return;
      const observer = new MutationObserver(() => {
        if (modal.classList.contains('active')) this.updateTogglesUI();
      });
      observer.observe(modal, { attributes: true, attributeFilter: ['class'] });
    },

    // ── Interactive Large Numeric Touch Keypad for Seniors (Phase 16) ──────────
    currentKeypadTarget: null,

    attachKeypad(inputId) {
      this.currentKeypadTarget = document.getElementById(inputId);
      const modal = document.getElementById('modal-senior-keypad');
      if (modal) modal.classList.add('active');
      this.announce('Large touch numeric keypad opened. Enter 4-digit PIN.');
    },

    keypadPress(val) {
      if (!this.currentKeypadTarget) return;
      if (val === 'CLEAR') {
        this.currentKeypadTarget.value = '';
        this.announce('Cleared');
      } else if (val === 'BACK') {
        this.currentKeypadTarget.value = this.currentKeypadTarget.value.slice(0, -1);
        this.announce('Deleted');
      } else {
        if (this.currentKeypadTarget.value.length < 4) {
          this.currentKeypadTarget.value += val;
          this.announce(`Digit ${val} entered. ${this.currentKeypadTarget.value.length} of 4 digits.`);
        }
      }

      // Trigger input event
      this.currentKeypadTarget.dispatchEvent(new Event('input', { bubbles: true }));

      // Auto-submit when 4 digits reached
      if (this.currentKeypadTarget.value.length === 4) {
        setTimeout(() => {
          this.closeKeypad();
          const form = this.currentKeypadTarget.closest('form');
          if (form) {
            form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
          }
        }, 300);
      }
    },

    closeKeypad() {
      const modal = document.getElementById('modal-senior-keypad');
      if (modal) modal.classList.remove('active');
    },

    bindKeypadEvents() {
      // Delegate touch keypad buttons
      document.addEventListener('click', (e) => {
        const btn = e.target.closest('.senior-keypad-btn');
        if (btn) {
          const val = btn.getAttribute('data-val');
          if (val) this.keypadPress(val);
        }
      });
    },

    // ── Accessible Transaction Confirmation Modal (Phase 18) ──────────────────
    confirmAccessibleTransaction({ type = 'Transfer', amount, recipientName, recipientAccount, onConfirm }) {
      const modal = document.getElementById('modal-accessible-confirm');
      if (!modal) {
        if (typeof onConfirm === 'function') onConfirm();
        return;
      }

      const amtEl = document.getElementById('acc-confirm-amount');
      const recipEl = document.getElementById('acc-confirm-recipient');
      const acctEl = document.getElementById('acc-confirm-source');
      const typeEl = document.getElementById('acc-confirm-type-label');
      const actionBtn = document.getElementById('btn-acc-confirm-proceed');

      if (amtEl) amtEl.textContent = `₹${Number(amount).toLocaleString('en-IN')}`;
      if (recipEl) recipEl.textContent = recipientName || 'Authorized Beneficiary';
      if (acctEl) acctEl.textContent = recipientAccount || 'Primary digital account';
      if (typeEl) typeEl.textContent = type;
      if (actionBtn) {
        actionBtn.textContent = `Confirm ₹${Number(amount).toLocaleString('en-IN')} ${type}`;
        actionBtn.onclick = () => {
          modal.classList.remove('active');
          if (typeof onConfirm === 'function') onConfirm();
        };
        // Keyboard users land on Confirm; Enter/Space activates, Tab reaches Cancel
        setTimeout(() => {
          try { actionBtn.focus(); } catch (_) {}
        }, 80);
      }

      modal.classList.add('active');

      const speechMessage = `You requested a ${type.toLowerCase()} of ${Number(amount).toLocaleString('en-IN')} rupees for ${recipientName || 'the selected recipient'}. Please confirm to continue, or press Cancel.`;
      this.announce(speechMessage, 'assertive');
    },

    closeAccessibleConfirm() {
      const modal = document.getElementById('modal-accessible-confirm');
      if (modal) modal.classList.remove('active');
      this.announce('Transaction cancelled.');
    },
  };

  window.iCashAccessibility = AccessibilityManager;

  // Global wrappers — the Accessibility Options modal and menus invoke these
  // directly (e.g. onchange="toggleHighContrast(this.checked)").
  window.toggleAccessibleMode = (force) => AccessibilityManager.toggleAccessibleMode(force);
  window.toggleSeniorMode = (force) => AccessibilityManager.toggleSeniorMode(force);
  window.toggleHighContrast = (force) => AccessibilityManager.toggleHighContrast(force);
  window.toggleLargeText = (force) => AccessibilityManager.toggleLargeText(force);
  window.toggleReduceMotion = (force) => AccessibilityManager.toggleReduceMotion(force);
  window.toggleVoiceGuidance = (force) => AccessibilityManager.toggleVoiceGuidance(force);
  window.muteVoice = () => AccessibilityManager.muteVoice();
  window.unmuteVoice = () => AccessibilityManager.unmuteVoice();
  window.toggleMuteVoice = () => (AccessibilityManager.voiceGuidance ? AccessibilityManager.muteVoice() : AccessibilityManager.unmuteVoice());
  window.repeatLast = () => AccessibilityManager.repeatLast();
  window.stopSpeaking = () => AccessibilityManager.stopSpeaking();
  window.setVoiceSpeed = (rate) => AccessibilityManager.setVoiceSpeed(rate);

  document.addEventListener('DOMContentLoaded', () => AccessibilityManager.init());
})();
