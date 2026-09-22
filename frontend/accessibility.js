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
 *      - Reduced animations support
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
 */

(function () {
  const STORAGE_KEYS = {
    ACCESSIBLE: 'icash_accessible_mode',
    SENIOR: 'icash_senior_mode',
    HIGH_CONTRAST: 'icash_high_contrast',
    LARGE_TEXT: 'icash_large_text',
    VOICE_GUIDE: 'icash_voice_guidance',
  };

  const AccessibilityManager = {
    isAccessible: false,
    isSenior: false,
    isHighContrast: false,
    isLargeText: false,
    voiceGuidance: true,
    speechSynth: typeof window !== 'undefined' && 'speechSynthesis' in window ? window.speechSynthesis : null,

    init() {
      try {
        this.isAccessible = localStorage.getItem(STORAGE_KEYS.ACCESSIBLE) === 'true';
        this.isSenior = localStorage.getItem(STORAGE_KEYS.SENIOR) === 'true';
        this.isHighContrast = localStorage.getItem(STORAGE_KEYS.HIGH_CONTRAST) === 'true';
        this.isLargeText = localStorage.getItem(STORAGE_KEYS.LARGE_TEXT) === 'true';
        this.voiceGuidance = localStorage.getItem(STORAGE_KEYS.VOICE_GUIDE) !== 'false'; // default true
      } catch (_) {}

      this.applyStyles();
      this.ensureAnnouncer();
      this.bindKeypadEvents();
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

      if (this.voiceGuidance && this.speechSynth) {
        this.speak(message);
      }
    },

    speak(text) {
      if (!this.speechSynth || !this.voiceGuidance) return;
      try {
        this.speechSynth.cancel(); // cancel prior speech
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.rate = this.isSenior ? 0.90 : 1.0; // slightly slower for senior mode
        utterance.pitch = 1.0;
        utterance.lang = 'en-IN'; // Indian English preferred
        this.speechSynth.speak(utterance);
      } catch (e) {
        console.warn('[iCash Speech] Speak error:', e);
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

    toggleVoiceGuidance(force) {
      this.voiceGuidance = force !== undefined ? Boolean(force) : !this.voiceGuidance;
      localStorage.setItem(STORAGE_KEYS.VOICE_GUIDE, String(this.voiceGuidance));
      if (this.voiceGuidance) {
        this.speak('Voice guidance activated.');
      } else if (this.speechSynth) {
        this.speechSynth.cancel();
      }
      this.updateTogglesUI();
    },

    applyStyles() {
      const body = document.body;
      if (!body) return;

      body.classList.toggle('accessible-mode', this.isAccessible);
      body.classList.toggle('senior-mode', this.isSenior);
      body.classList.toggle('high-contrast', this.isHighContrast || this.isAccessible);
      body.classList.toggle('large-text', this.isLargeText || this.isAccessible || this.isSenior);

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
      const actionBtn = document.getElementById('btn-acc-confirm-proceed');

      if (amtEl) amtEl.textContent = `₹${Number(amount).toLocaleString('en-IN')}`;
      if (recipEl) recipEl.textContent = recipientName || 'Authorized Beneficiary';
      if (acctEl) acctEl.textContent = recipientAccount || 'Primary digital account';
      if (actionBtn) {
        actionBtn.textContent = `Confirm ₹${Number(amount).toLocaleString('en-IN')} ${type}`;
        actionBtn.onclick = () => {
          modal.classList.remove('active');
          if (typeof onConfirm === 'function') onConfirm();
        };
      }

      modal.classList.add('active');

      const speechMessage = `Please confirm: ${type} of ${Number(amount).toLocaleString('en-IN')} rupees for ${recipientName || 'the selected recipient'}. Press Confirm to continue.`;
      this.announce(speechMessage, 'assertive');
    },

    closeAccessibleConfirm() {
      const modal = document.getElementById('modal-accessible-confirm');
      if (modal) modal.classList.remove('active');
      this.announce('Transaction cancelled.');
    },
  };

  window.iCashAccessibility = AccessibilityManager;
  document.addEventListener('DOMContentLoaded', () => AccessibilityManager.init());
})();
