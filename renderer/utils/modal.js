// Acessibilidade para modais baseados em <div> overlay (aberto/fechado por classe CSS).
// Adiciona role="dialog", aria-modal, aria-labelledby, focus trap, Esc e restauração do foco.
// O Esc clica no botão de fechar do diálogo (o primeiro do DOM que casa com o seletor de closeViaButton): uma trava de "ocupado" vai no clique desse botão.
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
    const doc = overlay.ownerDocument;
    if (e.shiftKey && (doc.activeElement === first || !overlay.contains(doc.activeElement))) {
      e.preventDefault(); last.focus();
    } else if (!e.shiftKey && (doc.activeElement === last || !overlay.contains(doc.activeElement))) {
      e.preventDefault(); first.focus();
    }
  });

  // O documento dono do overlay (não o global): o observador roda numa microtarefa, que pode chegar depois de a
  // tela ter sido descartada (ex.: nos testes), e nunca deve depender de `document`.
  const observer = new MutationObserver(() => {
    const doc = overlay.ownerDocument;
    if (!doc) return;
    const open = isOpen(overlay);
    if (open === wasOpen) return;
    wasOpen = open;
    if (open) {
      lastFocus = doc.activeElement;
      // [data-autofocus] marca o campo que recebe o foco ao abrir (senão seria o botão de fechar, o primeiro do diálogo)
      const target = focusables().find((n) => n.hasAttribute('data-autofocus')) || focusables()[0] || overlay;
      if (target === overlay) overlay.setAttribute('tabindex', '-1');
      setTimeout(() => { try { target.focus(); } catch (_) { /* tela descartada */ } }, 0);
    } else if (lastFocus && doc.contains(lastFocus)) {
      try { lastFocus.focus(); } catch (_) { /* noop */ }
      lastFocus = null;
    }
  });
  observer.observe(overlay, { attributes: true, attributeFilter: ['class'] });
}

export function enhanceModals(root, selector) {
  (root || document).querySelectorAll(selector).forEach((el) => enhanceModalOverlay(el));
}
