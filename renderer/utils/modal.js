// Acessibilidade para modais baseados em <div> overlay (aberto/fechado por classe CSS).
// Adiciona role="dialog", aria-modal, aria-labelledby, focus trap, Esc e restauração do foco.
// O observer fica preso ao próprio elemento (descartado junto com ele); é idempotente.
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
let uidCounter = 0;

function defaultIsOpen(el) {
  if (el.classList.contains('open')) return true;
  if (el.classList.contains('hidden')) return false;
  // Overlays sem classe de estado (ex.: proj-modal-overlay) só abrem com 'open'
  return !/^proj-/.test(el.className);
}

export function enhanceModalOverlay(overlay, { isOpen = defaultIsOpen } = {}) {
  if (!overlay || overlay.dataset.a11yModal === '1') return;
  overlay.dataset.a11yModal = '1';

  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  if (!overlay.hasAttribute('aria-labelledby') && !overlay.hasAttribute('aria-label')) {
    const heading = overlay.querySelector('h1, h2, h3, h4');
    if (heading) {
      if (!heading.id) heading.id = `bds-modal-title-${++uidCounter}`;
      overlay.setAttribute('aria-labelledby', heading.id);
    }
  }

  let lastFocus = null;
  let wasOpen = isOpen(overlay);

  const focusables = () => Array.from(overlay.querySelectorAll(FOCUSABLE))
    .filter((n) => n.getClientRects().length > 0);

  const closeViaButton = () => {
    const btn = overlay.querySelector('[class*="close-btn"], [id*="Close"], [id*="Cancel"], [id*="close"], [id*="cancel"]');
    if (btn) btn.click();
  };

  overlay.addEventListener('keydown', (e) => {
    if (!isOpen(overlay)) return;
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeViaButton();
      return;
    }
    if (e.key !== 'Tab') return;
    const items = focusables();
    if (!items.length) { e.preventDefault(); return; }
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === first || !overlay.contains(document.activeElement))) {
      e.preventDefault(); last.focus();
    } else if (!e.shiftKey && (document.activeElement === last || !overlay.contains(document.activeElement))) {
      e.preventDefault(); first.focus();
    }
  });

  const observer = new MutationObserver(() => {
    const open = isOpen(overlay);
    if (open === wasOpen) return;
    wasOpen = open;
    if (open) {
      lastFocus = document.activeElement;
      const target = focusables()[0] || overlay;
      if (target === overlay) overlay.setAttribute('tabindex', '-1');
      setTimeout(() => target.focus(), 0);
    } else if (lastFocus && document.contains(lastFocus)) {
      try { lastFocus.focus(); } catch (_) { /* noop */ }
      lastFocus = null;
    }
  });
  observer.observe(overlay, { attributes: true, attributeFilter: ['class'] });
}

export function enhanceModals(root, selector) {
  (root || document).querySelectorAll(selector).forEach((el) => enhanceModalOverlay(el));
}
