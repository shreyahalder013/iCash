/**
 * iCash Assist Menu Controller (⋮)
 *
 * A single, reusable, accessible overflow-menu implementation used by the
 * biometric scan screen and the dashboard top bar:
 *   - Opens/closes smoothly with a subtle animation.
 *   - Closes on outside click, Escape, or focus leaving the menu.
 *   - Full keyboard support: ArrowUp/ArrowDown navigate items,
 *     Home/End jump, Tab closes, Enter/Space activate.
 *   - Correct ARIA semantics: role="menu"/"menuitem", aria-expanded,
 *     aria-controls, aria-labels.
 *   - Works on desktop, tablet, and mobile (touch targets >= 42px).
 */
(function () {
  const entries = []; // { root, trigger, panel, items, open }

  function closeEntry(entry, opts) {
    const options = opts || {};
    if (!entry || !entry.open) return;
    entry.open = false;
    entry.panel.classList.remove('open');
    entry.panel.hidden = true;
    entry.trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onDocumentPointerDown, true);
    document.removeEventListener('keydown', onDocumentKeydown, true);
    if (options.returnFocus !== false) {
      try {
        entry.trigger.focus();
      } catch (_) {}
    }
  }

  function closeAllMenus(opts) {
    entries.forEach((entry) => closeEntry(entry, opts));
  }

  function openEntry(entry) {
    if (!entry || entry.open) return;
    // Close any other open menu first (only one menu open at a time)
    entries.forEach((other) => {
      if (other !== entry) closeEntry(other, { returnFocus: false });
    });
    entry.open = true;
    entry.panel.hidden = false;
    // rAF ensures the transition applies after display change
    requestAnimationFrame(() => entry.panel.classList.add('open'));
    entry.trigger.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', onDocumentPointerDown, true);
    document.addEventListener('keydown', onDocumentKeydown, true);
    // Move focus to the first item for keyboard/screen-reader users
    const first = entry.items[0];
    if (first) {
      try {
        first.focus();
      } catch (_) {}
    }
  }

  function toggleEntry(entry) {
    if (!entry) return;
    if (entry.open) closeEntry(entry);
    else openEntry(entry);
  }

  function entryFromEventTarget(target) {
    const root = target && target.closest ? target.closest('.assist-overflow') : null;
    if (!root) return null;
    return entries.find((e) => e.root === root) || null;
  }

  function onDocumentPointerDown(e) {
    const entry = entryFromEventTarget(e.target);
    if (!entry) {
      closeAllMenus({ returnFocus: false });
      return;
    }
    // Clicks on the trigger are handled by the trigger's own listener;
    // clicks inside the panel (items) keep the menu open until activated.
    if (!entry.panel.contains(e.target) && !entry.trigger.contains(e.target)) {
      closeEntry(entry, { returnFocus: false });
    }
  }

  function onDocumentKeydown(e) {
    const active = document.activeElement;
    const entry = (active && entryFromEventTarget(active)) || entries.find((en) => en.open);
    if (!entry || !entry.open) {
      closeAllMenus({ returnFocus: false });
      return;
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      closeEntry(entry); // returns focus to the trigger
      return;
    }

    const currentIndex = entry.items.indexOf(active);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      const next = entry.items[(currentIndex + dir + entry.items.length) % entry.items.length];
      if (next) next.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      if (entry.items[0]) entry.items[0].focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      if (entry.items[entry.items.length - 1]) entry.items[entry.items.length - 1].focus();
    } else if (e.key === 'Tab') {
      // Tab moves focus out of the menu — close it (standard menu behavior)
      closeEntry(entry, { returnFocus: false });
    }
  }

  function initEntry(root) {
    if (!root || root.dataset.assistInit === 'true') return;
    const trigger = root.querySelector('.assist-menu-trigger');
    const panel = root.querySelector('.assist-menu');
    if (!trigger || !panel) return;

    root.dataset.assistInit = 'true';
    // Remove any legacy inline onclick from the trigger to avoid double-toggle
    trigger.removeAttribute('onclick');

    const entry = { root, trigger, panel, items: [], open: false };
    entries.push(entry);

    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleEntry(entry);
    });

    // Collect menu items (refreshed lazily so dynamically-added items work)
    const collectItems = () => {
      entry.items = Array.from(panel.querySelectorAll('[role="menuitem"]')).filter(
        (el) => !el.disabled && el.offsetParent !== null
      );
    };
    collectItems();

    // Item activation via keyboard (click works natively via inline onclick)
    panel.addEventListener('keydown', (e) => {
      collectItems();
      if (e.key === 'Enter' || e.key === ' ') {
        const item = entry.items.includes(document.activeElement) ? document.activeElement : null;
        if (item) {
          e.preventDefault();
          closeAllMenus({ returnFocus: false });
          item.click();
        }
      }
    });

    panel.addEventListener('click', () => {
      // Any item click closes the menu (inline handlers run first)
      closeEntry(entry, { returnFocus: false });
    });
  }

  function init() {
    document.querySelectorAll('.assist-overflow').forEach(initEntry);
  }

  // Re-scan for menus added later (e.g. screens rendered dynamically)
  if (typeof MutationObserver !== 'undefined') {
    const observer = new MutationObserver(() => {
      document.querySelectorAll('.assist-overflow:not([data-assist-init="true"])').forEach(initEntry);
    });
    document.addEventListener('DOMContentLoaded', () => {
      observer.observe(document.body, { childList: true, subtree: true });
    });
  }

  document.addEventListener('DOMContentLoaded', init);

  // Public API — global `toggleAssistMenu(force)` is kept for existing inline handlers:
  //   toggleAssistMenu(false)  → close every open menu
  //   toggleAssistMenu()       → toggle the menu containing the focused element
  window.toggleAssistMenu = function (force) {
    if (force === false) {
      closeAllMenus({ returnFocus: false });
      return;
    }
    const entry = (document.activeElement && entryFromEventTarget(document.activeElement)) || entries.find((e) => e.open);
    toggleEntry(entry);
  };
  window.closeAssistMenu = function () {
    closeAllMenus({ returnFocus: false });
  };
  window.iCashAssistMenu = { toggle: window.toggleAssistMenu, close: window.closeAssistMenu };
})();
