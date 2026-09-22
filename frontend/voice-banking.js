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
        return;
      }

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

    handleCommand(cmd) {
      this.showVoiceOverlay(`Command: "${cmd}"`);
      setTimeout(() => this.hideVoiceOverlay(), 4000);

      const speak = (msg) => {
        if (window.iCashAccessibility) {
          window.iCashAccessibility.announce(msg);
        }
      };

      // 1. Balance
      if (cmd.includes('balance') || cmd.includes('how much money') || cmd.includes('account balance')) {
        if (typeof switchView === 'function') switchView('dashboard');
        const primaryAcc = (window.currentAccounts && window.currentAccounts[0]) || null;
        const bal = primaryAcc ? Number(primaryAcc.balance).toLocaleString('en-IN') : '25,000';
        speak(`Your primary account balance is ₹${bal} rupees.`);
        return;
      }

      // 2. Transactions
      if (cmd.includes('transaction') || cmd.includes('statement') || cmd.includes('history') || cmd.includes('passbook')) {
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
        const amtMatch = cmd.match(/(\d+[\d,]*)/);
        const amount = amtMatch ? parseInt(amtMatch[1].replace(/,/g, ''), 10) : 5000;
        let recipient = 'Beneficiary';
        if (cmd.includes('to ')) {
          recipient = cmd.split('to ')[1].split(' ')[0].trim();
          recipient = recipient.charAt(0).toUpperCase() + recipient.slice(1);
        }

        // Fill form fields
        const amtInput = document.getElementById('tx-amount');
        const recipInput = document.getElementById('tx-recipient');
        if (amtInput) amtInput.value = amount;
        if (recipInput) recipInput.value = recipient;

        // Trigger accessible confirmation modal
        if (window.iCashAccessibility && typeof window.iCashAccessibility.confirmAccessibleTransaction === 'function') {
          window.iCashAccessibility.confirmAccessibleTransaction({
            type: 'Transfer',
            amount,
            recipientName: recipient,
            onConfirm: () => {
              if (typeof promptBiometricVerify === 'function') {
                promptBiometricVerify('transfer');
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

      // 5. Pay bills
      if (cmd.includes('bill') || cmd.includes('pay bill') || cmd.includes('utility')) {
        if (typeof switchView === 'function') switchView('payments');
        speak('Opening bill payments and merchant services.');
        return;
      }

      // 6. Deposit
      if (cmd.includes('deposit') || cmd.includes('add money')) {
        if (typeof openModal === 'function') openModal('deposit');
        speak('Opening instant deposit portal.');
        return;
      }

      // 7. Withdraw
      if (cmd.includes('withdraw') || cmd.includes('cash withdrawal')) {
        const amtMatch = cmd.match(/(\d+[\d,]*)/);
        const amount = amtMatch ? parseInt(amtMatch[1].replace(/,/g, ''), 10) : null;
        const openWithdrawalDraft = () => {
          const input = document.getElementById('withdraw-amt');
          if (input && amount) input.value = amount;
          if (typeof openModal === 'function') openModal('withdraw');
          speak(amount
            ? `Withdrawal draft for ${amount.toLocaleString('en-IN')} rupees is ready. Review it and select Proceed to Biometric Authorization.`
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

      // 8. Help & Grievances
      if (cmd.includes('help') || cmd.includes('support') || cmd.includes('complaint') || cmd.includes('assistance')) {
        if (typeof switchView === 'function') switchView('support');
        speak('Opening customer support and grievance redressal portal.');
        return;
      }

      // 9. Logout
      if (cmd.includes('logout') || cmd.includes('sign out') || cmd.includes('exit')) {
        speak('Logging you out safely.');
        if (typeof logout === 'function') logout();
        return;
      }

      speak(`Command not recognized: "${cmd}". You can say: Show balance, Transfer money, Show transactions, Help, or Logout.`);
    },
  };

  // Keep one canonical API and a compatibility alias for existing controls.
  window.iCashVoice = VoiceBanking;
  window.iCashVoiceBanking = VoiceBanking;
  document.addEventListener('DOMContentLoaded', () => VoiceBanking.init());
})();
