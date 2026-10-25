import { en } from "../i18n/en";

// t("home.hello", { name }) — dotted keys into the dictionary, {placeholders}, and
// "one|many" plurals chosen by params.n. Kiswahili is loaded only when chosen, and falls
// back to English key by key.

export type Lang = "en" | "sw";
let sw: Record<string, unknown> | null = null;
let lang: Lang = ((): Lang => {
  try {
    const v = localStorage.getItem("aura:lang");
    if (v === "sw" || v === "en") return v;
  } catch {
    /* storage blocked */
  }
  return navigator.language?.toLowerCase().startsWith("sw") ? "sw" : "en";
})();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((f) => f());

async function loadSw() {
  if (sw) return;
  sw = (await import("../i18n/sw")).sw as Record<string, unknown>;
  notify();
}
if (lang === "sw") void loadSw();

export function getLang() {
  return lang;
}
/** Changes when the language changes or its dictionary finishes loading. */
export function langVersion() {
  return `${lang}:${sw ? 1 : 0}`;
}
export function setLang(l: Lang) {
  lang = l;
  try {
    localStorage.setItem("aura:lang", l);
  } catch {
    /* ignore */
  }
  document.documentElement.lang = l;
  if (l === "sw") void loadSw();
  notify();
}
export function onLang(f: () => void) {
  listeners.add(f);
  return () => {
    listeners.delete(f);
  };
}

function lookup(dict: unknown, key: string): unknown {
  return key.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), dict);
}

export function t(key: string, params: Record<string, string | number> = {}): string {
  let v = lang === "sw" && sw ? lookup(sw, key) : undefined;
  if (typeof v !== "string") v = lookup(en, key);
  if (typeof v !== "string") return key;
  let s = v;
  if (s.includes("|")) {
    const [one, many] = s.split("|");
    s = Number(params.n) === 1 ? one : many;
  }
  return s.replace(/\{(\w+)\}/g, (_, k) => (params[k] != null ? String(params[k]) : `{${k}}`));
}

export function tList(key: string): string[] {
  const v = (lang === "sw" && sw ? lookup(sw, key) : undefined) ?? lookup(en, key);
  return Array.isArray(v) ? (v as string[]) : [];
}
