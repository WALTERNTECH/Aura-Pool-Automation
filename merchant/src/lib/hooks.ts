import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ApiError, call, readCache, writeCache } from "./api";
import { getLang, langVersion, onLang } from "./i18n";

/** Loads a GET endpoint; keeps the last good answer for offline; refreshes on an interval while visible. */
export function useApi<T>(path: string | null, opts: { refreshMs?: number } = {}) {
  const cached = path ? readCache<T>(path) : null;
  const [data, setData] = useState<T | null>(cached?.data ?? null);
  const [savedAt, setSavedAt] = useState<number | null>(cached?.savedAt ?? null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const [stale, setStale] = useState(false);
  const live = useRef(true);
  const seq = useRef(0);

  const load = useCallback(async () => {
    if (!path) return;
    const n = ++seq.current;
    try {
      const d = await call<T>(path);
      if (!live.current || n !== seq.current) return;
      setData(d);
      setError(null);
      setStale(false);
      setSavedAt(Date.now());
      writeCache(path, d);
    } catch (e) {
      if (!live.current || n !== seq.current) return;
      const offline = e instanceof ApiError && (e.code === "network" || e.code === "api_unreachable");
      if (offline && readCache(path)) setStale(true);
      else setError(e);
    } finally {
      if (live.current && n === seq.current) setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    live.current = true;
    const c = path ? readCache<T>(path) : null;
    setData(c?.data ?? null);
    setSavedAt(c?.savedAt ?? null);
    setLoading(Boolean(path));
    setError(null);
    void load();
    return () => {
      live.current = false;
    };
  }, [path, load]);

  useEffect(() => {
    if (!opts.refreshMs || !path) return;
    const id = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, opts.refreshMs);
    const onVis = () => document.visibilityState === "visible" && void load();
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("online", onVis);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("online", onVis);
    };
  }, [opts.refreshMs, path, load]);

  return { data, setData, error, loading: loading && !data, stale, savedAt, reload: load };
}

function subscribeOnline(cb: () => void) {
  window.addEventListener("online", cb);
  window.addEventListener("offline", cb);
  return () => {
    window.removeEventListener("online", cb);
    window.removeEventListener("offline", cb);
  };
}
export function useOnline() {
  return useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);
}

/** Re-renders when the language changes. */
export function useLang() {
  useSyncExternalStore(onLang, langVersion, langVersion);
  return getLang();
}

/** Pull down at the top of the page to reload. */
export function usePullToRefresh(onRefresh: () => Promise<unknown> | void) {
  const [pull, setPull] = useState(0);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let startY = 0;
    let active = false;
    let dist = 0;
    const down = (e: TouchEvent) => {
      if (window.scrollY > 0 || busy) return;
      startY = e.touches[0].clientY;
      active = true;
      dist = 0;
    };
    const move = (e: TouchEvent) => {
      if (!active) return;
      dist = Math.max(0, Math.min(110, (e.touches[0].clientY - startY) * 0.5));
      setPull(dist);
    };
    const up = async () => {
      if (!active) return;
      active = false;
      if (dist > 60) {
        setBusy(true);
        setPull(56);
        try {
          await onRefresh();
        } finally {
          setBusy(false);
          setPull(0);
        }
      } else setPull(0);
    };
    window.addEventListener("touchstart", down, { passive: true });
    window.addEventListener("touchmove", move, { passive: true });
    window.addEventListener("touchend", up);
    return () => {
      window.removeEventListener("touchstart", down);
      window.removeEventListener("touchmove", move);
      window.removeEventListener("touchend", up);
    };
  }, [onRefresh, busy]);
  return { pull, busy };
}

export function useInterval(fn: () => void, ms: number | null) {
  const saved = useRef(fn);
  saved.current = fn;
  useEffect(() => {
    if (ms == null) return;
    const id = setInterval(() => saved.current(), ms);
    return () => clearInterval(id);
  }, [ms]);
}
