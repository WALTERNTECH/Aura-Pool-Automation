// Light (white with grain) unless the owner picks Dark, or Match phone and the phone is dark.
export type Theme = "system" | "light" | "dark";

export function applyTheme(t: Theme) {
  const root = document.documentElement;
  if (t === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", t);
  try {
    localStorage.setItem("aura:theme", t);
  } catch {
    /* ignore */
  }
  const dark = t === "dark" || (t === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute("content", dark ? "#151716" : "#fbfbf9"));
}

export function initialTheme() {
  let t: Theme = "light";
  try {
    t = (localStorage.getItem("aura:theme") as Theme | null) ?? "light";
  } catch {
    /* ignore */
  }
  applyTheme(t);
}
