/**
 * iCash Voice Banking Subsystem (Phase 15)
 *
 * Implements conversational voice navigation and commands via Web Speech API:
 *   - "Show balance" -> Speaks and displays current balance
 *   - "Show transactions" -> Switches to transaction ledger
 *   - "Show accounts" -> Switches to accounts portfolio
 *   - "Transfer money" -> Initiates transfer draft
 *   - "Pay bills" -> Opens payments
 *   - "Deposit money" -> Opens deposit modal
 *   - "Withdraw money" -> Opens withdrawal modal
 *   - "Help" -> Opens customer support
 *   - "Logout" -> Safely logs out
 *
 * CRITICAL SECURITY INVARIANT:
 *   Voice commands NEVER independently authorize financial transactions.
 *   Transfers follow:
 *     VOICE COMMAND -> DRAFT TRANSACTION -> AUDIO READBACK -> USER CONFIRMS -> SECURE PIN/BIOMETRIC AUTHORIZATION -> EXECUTE.
 */

(function () {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition || null;

  const VoiceBanking = {
    recognition: null,
    isListening: false,
    activeDraft: null,

    init() {
      if (!SpeechRecognition) {
        console.warn('[iCash Voice] Web Speech Recognition is not supported by this browser.');
        this.updateMicBtn(false);
      }

      // Keyboard activation for voice command chips (role="button", tabindex=0)
      document.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const chip = e.target.closest ? e.target.closest('.voice-cmd-chip') : null;
        if (!chip) return;
        e.preventDefault();
        const onclick = chip.getAttribute('onclick');
        const match = onclick && onclick.match(/handleCommand\('([^']+)'\)/);
        if (match) {
          this.handleCommand(match[1]);
        } else {
          chip.click();
        }
      });

      this.recognition = new SpeechRecognition();
      this.recognition.continuous = false;
      this.recognition.interimResults = false;
      this.recognition.lang = 'en-IN'; // Indian English

      this.recognition.onstart = () => {
        this.isListening = true;
        this.updateMicBtn(true);
        this.showVoiceOverlay('Listening... Speak a command (e.g. "Show balance", "Transfer money", "Help")');
      };

      this.recognition.onresult = (event) => {
        const transcript = event.results[0][0].transcript.trim().toLowerCase();
        console.log('[iCash Voice] Transcript:', transcript);
        this.handleCommand(transcript);
      };

      this.recognition.onerror = (event) => {
        console.warn('[iCash Voice] Recognition error:', event.error);
        this.isListening = false;
        this.updateMicBtn(false);
        this.showVoiceOverlay(`Didn't catch that (${event.error}). Tap mic to try again.`);
        setTimeout(() => this.hideVoiceOverlay(), 3000);
      };

      this.recognition.onend = () => {
        this.isListening = false;
        this.updateMicBtn(false);
      };
    },

    toggleListening() {
      if (!this.recognition) {
        if (window.iCashAccessibility) {
          window.iCashAccessibility.announce('Voice recognition is not supported in this browser. Please use keyboard or touch.');
        }
        return;
      }

      if (this.isListening) {
        this.recognition.stop();
      } else {
        try {
          this.recognition.start();
        } catch (e) {
          console.warn('[iCash Voice] Start notice:', e);
        }
      }
    },

    start() {
      this.toggleListening();
    },

    stopListening() {
      if (this.isListening && this.recognition) this.recognition.stop();
    },

    updateMicBtn(active) {
      const btn = document.getElementById('voice-banking-mic-btn');
      if (btn) {
        btn.classList.toggle('listening', active);
        btn.setAttribute('aria-pressed', String(active));
      }
    },

    showVoiceOverlay(text) {
      // Primary: update the in-modal feedback box
      const modalFeedback = document.getElementById('voice-mode-feedback');
      const modalStatus = document.getElementById('voice-mode-status');
      if (modalFeedback) {
        modalFeedback.textContent = text;
        modalFeedback.style.display = 'block';
      }
      if (modalStatus) {
        modalStatus.textContent = text;
      }

      // Fallback floating toast (when modal is closed)
      let el = document.getElementById('voice-banking-banner');
      if (!el) {
        el = document.createElement('div');
        el.id = 'voice-banking-banner';
        el.style.cssText = [
          'position:fixed;bottom:24px;right:24px;z-index:9999;',
          'background:rgba(15,23,42,0.94);border:1.5px solid #38bdf8;',
          'padding:14px 20px;border-radius:14px;color:#f8fafc;',
          'font-family:var(--font-body);font-size:13.5px;max-width:340px;',
          'box-shadow:0 10px 30px rgba(0,0,0,0.5);display:flex;align-items:center;gap:12px;',
          'transition:all 0.3s ease;',
        ].join('');
        document.body.appendChild(el);
      }
      el.replaceChildren();
      const icon = document.createElement('span');
      icon.style.fontSize = '18px';
      icon.textContent = '\uD83C\uDF99\uFE0F';
      const message = document.createElement('span');
      message.textContent = text;
      el.append(icon, message);
      el.style.display = 'flex';
    },

    hideVoiceOverlay() {
      const el = document.getElementById('voice-banking-banner');
      if (el) el.style.display = 'none';
    },

    /**
     * Resolve the authenticated user's primary account from REAL banking data.
     * SECURITY INVARIANT: the assistant NEVER invents account information.
     * Falls back to a live API fetch when the dashboard cache is empty.
     * Returns null when no verified data is available.
     */
    async resolvePrimaryAccount() {
      let accounts = window.currentAccounts || [];
      if (!accounts.length && window.iCashApi) {
        try {
          const res = await window.iCashApi.getAccounts();
          if (res && res.ok && Array.isArray(res.accounts)) {
            accounts = res.accounts;
            window.currentAccounts = accounts;
          }
        } catch (_) {}
      }
      return accounts.length ? accounts[0] : null;
    },

    /**
     * Parse a spoken amount into a number.
     * Supports digits ("2000", "2,000"), "k" shorthand ("2k"),
     * and common English word numbers ("two thousand", "five hundred").
     * Returns null when no amount can be confidently parsed.
     */
    parseSpokenAmount(cmd) {
      if (!cmd) return null;

      // 1. Digits: "2000", "2,000", "2.5", "2k"
      const digitMatch = cmd.match(/(\d+(?:[.,]\d+)?)\s*(k|thousand|lakhs?|lakh)?/);
      if (digitMatch) {
        let value = parseFloat(digitMatch[1].replace(/,/g, ''));
        if (isNaN(value) || value <= 0) return null;
        const unit = digitMatch[2];
        if (unit === 'k' || unit === 'thousand') value *= 1000;
        else if (unit === 'lakh' || unit === 'lakhs') value *= 100000;
        return Math.round(value * 100) / 100;
      }

      // 2. English word numbers: "two thousand", "five hundred"
      const WORD_NUMBERS = {
        one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
        eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
        eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
        seventy: 70, eighty: 80, ninety: 90, hundred: 100, thousand: 1000,
      };
      const words = cmd.split(/\s+/);
      let total = 0;
      let current = 0;
      let found = false;
      for (const w of words) {
        const val = WORD_NUMBERS[w];
        if (val === undefined) {
          if (found) break;
          continue;
        }
        found = true;
        if (val === 100 || val === 1000) {
          current = (current || 1) * val;
          if (val === 1000) {
            total += current;
            current = 0;
          }
        } else {
          current += val;
        }
      }
      if (!found) return null;
      const result = total + current;
      return result > 0 ? result : null;
    },

    async handleCommand(cmd) {
      this.showVoiceOverlay(`Heard: "${cmd}"`);
      // Auto-hide the floating banner; later updates reset the timer via showVoiceOverlay
      clearTimeout(this._overlayHideTimer);
      this._overlayHideTimer = setTimeout(() => this.hideVoiceOverlay(), 8000);

      const speak = (msg) => {
        // Show what the system understood/decided visually as well as aloud
        this.showVoiceOverlay(msg);
        if (window.iCashAccessibility) {
          window.iCashAccessibility.announce(msg);
        }
      };

      // 1. Balance — ALWAYS uses real authenticated banking data, never invented figures
      if (cmd.includes('balance') || cmd.includes('how much money') || cmd.includes('how much do i have') || cmd.includes("what's my balance") || cmd.includes('account balance') || cmd.includes('my money')) {
        if (typeof switchView === 'function') switchView('dashboard');
        speak('Reading your account balance…');
        try {
          const primaryAcc = await this.resolvePrimaryAccount();
          if (!primaryAcc || primaryAcc.balance === undefined || primaryAcc.balance === null) {
            // NEVER invent a balance — direct the user to the visual display
            speak("I couldn't read your balance right now. Please check the balance card on your dashboard.");
            return;
          }
          const bal = Number(primaryAcc.balance).toLocaleString('en-IN');
          const bank = primaryAcc.bankName ? ` in your ${primaryAcc.bankName} account` : '';
          speak(`Your current balance is ₹${bal} rupees${bank}.`);
        } catch (_) {
          speak("I couldn't read your balance right now. Please check the balance card on your dashboard.");
        }
        return;
      }

      // 2. Transactions
      if (cmd.includes('transaction') || cmd.includes('statement') || cmd.includes('history') || cmd.includes('passbook') || cmd.includes('spend recently') || cmd.includes('spent recently')) {
        if (typeof switchView === 'function') switchView('transactions');
        speak('Opening your transaction ledger.');
        return;
      }

      // 3. Accounts
      if (cmd.includes('account') || cmd.includes('cards') || cmd.includes('portfolio')) {
        if (typeof switchView === 'function') switchView('accounts');
        speak('Opening your account portfolio.');
        return;
      }

      // 4. Transfer Money (Follows strict draft -> readback -> confirm invariant)
      if (cmd.includes('transfer') || cmd.includes('send money') || cmd.includes('pay person')) {
        if (typeof switchView === 'function') switchView('transfers');

        // Check if amount or recipient mentioned in speech, e.g. "transfer 5000 to rahul"
        const amount = this.parseSpokenAmount(cmd) || 5000;
        let recipient = 'Beneficiary';
        if (cmd.includes('to ')) {
          recipient = cmd.split('to ')[1].split(' ')[0].trim();
          recipient = recipient.charAt(0).toUpperCase() + recipient.slice(1);
        }

        // Fill form fields
        const amtInput = document.getElementById('transfer-amount');
        const recipInput = document.getElementById('transfer-dest-name');
        if (amtInput) amtInput.value = amount;
        if (recipInput) recipInput.value = recipient;

        // Trigger accessible confirmation modal (visual equivalent of the voice readback)
        if (window.iCashAccessibility && typeof window.iCashAccessibility.confirmAccessibleTransaction === 'function') {
          window.iCashAccessibility.confirmAccessibleTransaction({
            type: 'Transfer',
            amount,
            recipientName: recipient,
            onConfirm: () => {
              if (typeof initiateTransferWorkflow === 'function') {
                initiateTransferWorkflow();
              } else if (typeof openModal === 'function') {
                openModal('verify');
              }
            },
          });
        } else {
          speak(`Draft transfer of ₹${amount} created for ${recipient}. Please review and confirm — you will need to complete biometric verification.`);
        }
        return;
      }

      // 5. Go back (close an open modal, otherwise return to the dashboard)
      if (cmd.includes('go back') || cmd === 'back' || cmd.includes('previous screen')) {
        const openModalEl = document.querySelector('.modal-backdrop.active');
        if (openModalEl) {
          openModalEl.classList.remove('active');
          speak('Closed.');
        } else if (
          typeof switchView === 'function' &&
          document.getElementById('screen-dashboard') &&
          document.getElementById('screen-dashboard').classList.contains('active')
        ) {
          if (document.getElementById('view-dashboard') && !document.getElementById('view-dashboard').classList.contains('active')) {
            switchView('dashboard');
            speak('Returning to your dashboard.');
          } else {
            speak('You are already on the dashboard.');
          }
        } else {
          speak('Nothing to go back to.');
        }
        return;
      }

      // 6. Pay bills
      if (cmd.includes('bill') || cmd.includes('pay bill') || cmd.includes('utility')) {
        if (typeof switchView === 'function') switchView('payments');
        speak('Opening bill payments and merchant services.');
        return;
      }

      // 7. Deposit
      if (cmd.includes('deposit') || cmd.includes('add money')) {
        if (typeof openModal === 'function') openModal('deposit');
        speak('Opening instant deposit portal.');
        return;
      }

      // 8. Withdraw — voice NEVER executes; a draft is prepared and read back for confirmation
      if (cmd.includes('withdraw') || cmd.includes('cash withdrawal')) {
        const amount = this.parseSpokenAmount(cmd);
        const openWithdrawalDraft = () => {
          const input = document.getElementById('withdraw-amt');
          if (input && amount) input.value = amount;
          if (typeof openModal === 'function') openModal('withdraw');
          speak(amount
            ? `You requested a withdrawal of ₹${Number(amount).toLocaleString('en-IN')}. The draft is ready. Review it and select Proceed to Biometric Authorization.`
            : 'Cash withdrawal draft is ready. Enter an amount, then select Proceed to Biometric Authorization.');
        };
        if (amount && window.iCashAccessibility?.confirmAccessibleTransaction) {
          window.iCashAccessibility.confirmAccessibleTransaction({
            type: 'Withdrawal', amount, recipientName: 'your primary account', onConfirm: openWithdrawalDraft,
          });
        } else {
          openWithdrawalDraft();
        }
        return;
      }

      // 9. Help & Grievances
      if (cmd.includes('help') || cmd.includes('support') || cmd.includes('complaint') || cmd.includes('assistance')) {
        if (typeof switchView === 'function') switchView('support');
        speak('Opening customer support and grievance redressal portal.');
        return;
      }

      // 10. Logout
      if (cmd.includes('logout') || cmd.includes('log out') || cmd.includes('sign out') || cmd.includes('exit')) {
        speak('Logging you out safely.');
        if (typeof logout === 'function') logout();
        return;
      }

      speak(`Command not recognized: "${cmd}". You can say: Check my balance, Show recent transactions, Withdraw 2000 rupees, Transfer money, Go back, or Logout.`);
    },
  };

  // Keep one canonical API and a compatibility alias for existing controls.
  window.iCashVoice = VoiceBanking;
  window.iCashVoiceBanking = VoiceBanking;
  document.addEventListener('DOMContentLoaded', () => {
    VoiceBanking.init();
    // Initialize voice control button labels (mute state, speed) from persisted settings
    if (window.iCashAccessibility) window.iCashAccessibility.updateVoiceControlsUI();
  });
})();
