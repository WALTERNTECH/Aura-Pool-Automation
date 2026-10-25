import { useCallback, useEffect, useRef, useState } from "react";
import { call } from "./api";

/** Loads a GET endpoint; optionally refreshes in the background (not counted as activity). */
export function useApi<T = any>(path: string | null, opts: { refreshMs?: number } = {}) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const seq = useRef(0);
  const load = useCallback(
    async (background = false) => {
      if (!path) return;
      const n = ++seq.current;
      try {
        const d = await call<T>(path, { background });
        if (n === seq.current) {
          setData(d);
          setError(null);
        }
      } catch (e) {
        if (n === seq.current && !background) setError(e);
      } finally {
        if (n === seq.current) setLoading(false);
      }
    },
    [path],
  );
  useEffect(() => {
    setLoading(Boolean(path));
    setError(null);
    void load();
  }, [load, path]);
  useEffect(() => {
    if (!opts.refreshMs || !path) return;
    const id = setInterval(() => document.visibilityState === "visible" && void load(true), opts.refreshMs);
    return () => clearInterval(id);
  }, [opts.refreshMs, path, load]);
  return { data, error, loading: loading && !data, reload: () => load(false), setData };
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

/** Keeps a piece of list state (filters, page) in the URL so a refresh or a shared link keeps it. */
export function useQueryState<T extends Record<string, string>>(defaults: T): [T, (patch: Partial<T>) => void] {
  const read = () => {
    const p = new URLSearchParams(location.search);
    const out = { ...defaults };
    for (const k of Object.keys(defaults)) {
      const v = p.get(k);
      if (v != null) (out as Record<string, string>)[k] = v;
    }
    return out;
  };
  const [state, setState] = useState<T>(read);
  const update = useCallback((patch: Partial<T>) => {
    setState((s) => {
      const next = { ...s, ...patch };
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(next)) if (v && v !== (defaults as Record<string, string>)[k]) p.set(k, v);
      const q = p.toString();
      history.replaceState(null, "", `${location.pathname}${q ? `?${q}` : ""}`);
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return [state, update];
}
