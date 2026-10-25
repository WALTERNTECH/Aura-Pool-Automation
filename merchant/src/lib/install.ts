// The install prompt. Chrome and Edge fire beforeinstallprompt, which we keep and replay when
// the owner taps Install. Safari on iPhone has no prompt, so we show the Share → Add to Home
// Screen steps instead. Captured at startup, before React mounts, so the event isn't missed.

type BIP = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };
let deferred: BIP | null = null;
const listeners = new Set<() => void>();

export function captureInstall() {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e as BIP;
    listeners.forEach((f) => f());
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    try {
      localStorage.setItem("aura:installed", "1");
    } catch {
      /* ignore */
    }
    listeners.forEach((f) => f());
  });
}

export const onInstallChange = (f: () => void) => {
  listeners.add(f);
  return () => {
    listeners.delete(f);
  };
};

export function isStandalone() {
  return matchMedia("(display-mode: standalone)").matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
}

export function isIos() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

export function canPrompt() {
  return Boolean(deferred);
}

export async function promptInstall(): Promise<boolean> {
  if (!deferred) return false;
  await deferred.prompt();
  const choice = await deferred.userChoice;
  deferred = null;
  listeners.forEach((f) => f());
  return choice.outcome === "accepted";
}

const SNOOZE = 3 * 86_400_000;
export function snoozed() {
  try {
    const v = Number(localStorage.getItem("aura:install-snooze") ?? 0);
    return Date.now() - v < SNOOZE;
  } catch {
    return false;
  }
}
export function snooze() {
  try {
    localStorage.setItem("aura:install-snooze", String(Date.now()));
  } catch {
    /* ignore */
  }
}
