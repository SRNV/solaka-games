import { useState } from 'react';

const PSEUDO_KEY = 'gamepad_pseudo';
const GUEST_CTR_KEY = 'gamepad_guest_ctr';

function generateGuestPseudo(): string {
  const n = (parseInt(localStorage.getItem(GUEST_CTR_KEY) ?? '0', 10) || 0) + 1;
  localStorage.setItem(GUEST_CTR_KEY, String(n));
  return `guest-${n}`;
}

function loadOrCreatePseudo(): string {
  try {
    const stored = localStorage.getItem(PSEUDO_KEY);
    if (stored) return stored;
    const generated = generateGuestPseudo();
    localStorage.setItem(PSEUDO_KEY, generated);
    return generated;
  } catch {
    return generateGuestPseudo();
  }
}

export function usePseudo() {
  const [pseudo, setPseudoState] = useState<string>(loadOrCreatePseudo);

  function setPseudo(name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      localStorage.setItem(PSEUDO_KEY, trimmed);
    } catch { /* ignore */ }
    setPseudoState(trimmed);
  }

  return { pseudo, setPseudo };
}
