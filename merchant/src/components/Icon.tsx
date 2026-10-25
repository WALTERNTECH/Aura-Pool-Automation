// A small stroke icon set drawn for this app (24 px grid, 1.8 stroke), so no icon library ships.
const P: Record<string, string> = {
  home: "M3.5 10.5 12 4l8.5 6.5V20a1 1 0 0 1-1 1h-5v-6h-5v6h-5a1 1 0 0 1-1-1z",
  payments: "M3 6.5h18v11H3zM3 10h18M7 14.5h4",
  money: "M3 7h15a3 3 0 0 1 3 3v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 7l11-3.5V7M16.5 13.5h.01",
  stats: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  table: "M3 8h18v8H3zM6 16v4M18 16v4M7.5 12h.01M16.5 12h.01",
  bell: "M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15zM10 20.5a2.2 2.2 0 0 0 4 0",
  right: "m9 6 6 6-6 6",
  left: "m15 6-6 6 6 6",
  check: "m5 12.5 4.2 4.2L19 7",
  x: "M6 6l12 12M18 6 6 18",
  alert: "M12 4 2.5 20h19zM12 10v4.5M12 17.5h.01",
  info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 8h.01",
  wifi: "M2 9a15 15 0 0 1 20 0M5.5 12.5a10 10 0 0 1 13 0M9 16a5 5 0 0 1 6 0M12 19.5h.01",
  wifiOff: "M2 9a15 15 0 0 1 5-3M22 9a15 15 0 0 0-9-3.9M5.5 12.5a10 10 0 0 1 4-2.2M18.5 12.5a10 10 0 0 0-2.4-1.6M9 16a5 5 0 0 1 6 0M12 19.5h.01M3 3l18 18",
  download: "M12 3v12M7 10l5 5 5-5M4 20h16",
  lock: "M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3",
  finger: "M7 11a5 5 0 0 1 10 0v2M12 11v3a7 7 0 0 1-1.5 4.5M9.5 11.5V14a9 9 0 0 1-1.6 5M14.5 12v2.5a10 10 0 0 1-.8 4M4.5 9.5a8 8 0 0 1 15 0M19.5 13.5v.5",
  phone: "M5 3.5h4l1.5 4-2.5 1.5a11 11 0 0 0 5 5L14.5 11.5l4 1.5v4a2 2 0 0 1-2.2 2A16 16 0 0 1 3 5.7 2 2 0 0 1 5 3.5z",
  chat: "M4 5h16v11H9l-5 4z",
  help: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17h.01",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.5 20a7.5 7.5 0 0 1 15 0",
  users: "M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 19.5a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 6.5M18 13.5a6.5 6.5 0 0 1 3.5 6",
  settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 13.5l1.6 1.2-2 3.4-1.9-.7a7.6 7.6 0 0 1-2 1.2L14.8 21h-4l-.3-2.4a7.6 7.6 0 0 1-2-1.2l-1.9.7-2-3.4 1.6-1.2a7.4 7.4 0 0 1 0-2.4L4.6 9.9l2-3.4 1.9.7a7.6 7.6 0 0 1 2-1.2L10.8 3h4l.3 2.4a7.6 7.6 0 0 1 2 1.2l1.9-.7 2 3.4-1.6 1.2a7.4 7.4 0 0 1 0 2.4z",
  logout: "M14 4h5a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-5M10 16l-4-4 4-4M6 12h10",
  refresh: "M20 11a8 8 0 0 0-14.6-4.5L3 9M3 4v5h5M4 13a8 8 0 0 0 14.6 4.5L21 15M21 20v-5h-5",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7.5V12l3 2",
  plus: "M12 5v14M5 12h14",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4",
  share: "M12 3v12M8 7l4-4 4 4M5 12v7a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-7",
  print: "M7 9V3h10v6M7 17H4v-7h16v7h-3M7 14h10v7H7z",
  unlock: "M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 6.8-1.2",
  tool: "M14.5 6.5a4 4 0 0 0 5 5L12 19a2.1 2.1 0 0 1-3-3l7.5-7.5zM14.5 6.5 17 4",
  shield: "M12 3 4.5 6v6c0 4.5 3.2 7.8 7.5 9 4.3-1.2 7.5-4.5 7.5-9V6z",
  doc: "M7 3h7l4 4v14H7zM14 3v4h4M10 12h5M10 16h5",
  back: "M10 6 4 12l6 6M4 12h16",
  backspace: "M8 5h12a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H8l-6-7zM12 9.5l5 5M17 9.5l-5 5",
  install: "M12 3v10M8 9l4 4 4-4M5 15v4a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-4",
  calendar: "M4 6h16v14H4zM4 10h16M8 3v4M16 3v4",
  trophy: "M8 4h8v5a4 4 0 0 1-8 0zM8 6H4.5a3 3 0 0 0 3.5 4M16 6h3.5a3 3 0 0 1-3.5 4M12 13v4M8.5 20h7M10 17h4",
};

export function Icon({ name, className, title }: { name: keyof typeof P | string; className?: string; title?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden={title ? undefined : true} role={title ? "img" : undefined}>
      {title ? <title>{title}</title> : null}
      <path d={P[name] ?? P.info} />
    </svg>
  );
}

/** The mark: a cue ball inside its aura. */
export function Logo({ size = 34 }: { size?: number }) {
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true">
      <rect width="64" height="64" rx="16" fill="#111412" />
      <circle cx="32" cy="32" r="19" fill="none" stroke="#2f8c5f" strokeWidth="3" />
      <circle cx="32" cy="32" r="12" fill="#fbfbf9" />
      <circle cx="28" cy="28" r="3.2" fill="#d9ddd8" />
    </svg>
  );
}
