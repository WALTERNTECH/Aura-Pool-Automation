import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { call, qs } from "../lib/api";
import { useInterval } from "../lib/hooks";
import { Empty, ErrorBox, Loading } from "./ui";

// Server-side paginated tables: the API does the filtering, sorting and paging; this shows the
// page, lets the operator hide columns, and links the same filter to a CSV export.

export type Col<T> = { key: string; label: string; render: (row: T) => ReactNode; sort?: string; right?: boolean; hidden?: boolean; width?: number };

type Page<T> = { items: T[]; total: number; page: number; pageSize: number };

export function DataTable<T extends Record<string, any>>({
  path,
  params,
  columns,
  rowLink,
  exportPath,
  toolbar,
  pageSize = 50,
  refreshMs,
  empty = "Nothing here.",
  storageKey,
  onData,
}: {
  path: string;
  params: Record<string, string | number | boolean | null | undefined>;
  columns: Col<T>[];
  rowLink?: (row: T) => string;
  exportPath?: string;
  toolbar?: ReactNode;
  pageSize?: number;
  refreshMs?: number;
  empty?: ReactNode;
  storageKey?: string;
  onData?: (d: Page<T> & Record<string, unknown>) => void;
}) {
  const nav = useNavigate();
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" } | null>(null);
  const [data, setData] = useState<(Page<T> & Record<string, unknown>) | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [cols, setCols] = useState<Set<string>>(() => {
    try {
      const v = storageKey && localStorage.getItem(`cols:${storageKey}`);
      if (v) return new Set(JSON.parse(v));
    } catch {
      /* ignore */
    }
    return new Set(columns.filter((c) => !c.hidden).map((c) => c.key));
  });
  const [pick, setPick] = useState(false);
  const paramKey = JSON.stringify(params);
  useEffect(() => setPage(1), [paramKey]);

  const query = useMemo(() => qs({ ...params, page, pageSize, ...(sort ? { sort: sort.key, dir: sort.dir } : {}) }), [paramKey, page, pageSize, sort]); // eslint-disable-line react-hooks/exhaustive-deps
  const load = async (background = false) => {
    try {
      const d = await call<Page<T> & Record<string, unknown>>(`${path}${query}`, { background });
      setData(d);
      setError(null);
      onData?.(d);
    } catch (e) {
      if (!background) setError(e);
    }
  };
  useEffect(() => {
    void load();
  }, [path, query]); // eslint-disable-line react-hooks/exhaustive-deps
  useInterval(() => void load(true), refreshMs ?? null);

  const shown = columns.filter((c) => cols.has(c.key));
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const exportHref = exportPath ? `/v1/a${exportPath}${qs({ ...params })}` : null;

  return (
    <section className="card flush">
      <div className="tablebar">
        {toolbar}
        <span className="grow" />
        <div style={{ position: "relative" }}>
          <button className="btn sm" onClick={() => setPick((p) => !p)} aria-expanded={pick}>
            Columns
          </button>
          {pick ? (
            <div className="card" style={{ position: "absolute", right: 0, top: 36, zIndex: 20, minWidth: 200, padding: 10 }}>
              {columns.map((c) => (
                <label key={c.key} className="check" style={{ padding: "3px 0" }}>
                  <input
                    type="checkbox"
                    checked={cols.has(c.key)}
                    onChange={(e) => {
                      const n = new Set(cols);
                      e.target.checked ? n.add(c.key) : n.delete(c.key);
                      setCols(n);
                      try {
                        if (storageKey) localStorage.setItem(`cols:${storageKey}`, JSON.stringify([...n]));
                      } catch {
                        /* ignore */
                      }
                    }}
                  />
                  {c.label}
                </label>
              ))}
            </div>
          ) : null}
        </div>
        {exportHref ? (
          <a className="btn sm" href={exportHref} download>
            Export CSV
          </a>
        ) : null}
      </div>
      {error ? (
        <div style={{ padding: 12 }}>
          <ErrorBox error={error} />
        </div>
      ) : null}
      {!data && !error ? (
        <div style={{ padding: 12 }}>
          <Loading h={160} />
        </div>
      ) : null}
      {data ? (
        data.items.length ? (
          <div className="tablewrap">
            <table className="data">
              <thead>
                <tr>
                  {shown.map((c) => (
                    <th key={c.key} className={c.right ? "r" : ""} style={c.width ? { width: c.width } : undefined}>
                      {c.sort ? (
                        <button onClick={() => setSort((s) => (s && s.key === c.sort ? { key: c.sort!, dir: s.dir === "asc" ? "desc" : "asc" } : { key: c.sort!, dir: "desc" }))}>
                          {c.label} {sort?.key === c.sort ? (sort.dir === "asc" ? "↑" : "↓") : ""}
                        </button>
                      ) : (
                        c.label
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.items.map((row, i) => (
                  <tr key={(row.id as string) ?? i} className={rowLink ? "click" : ""} onClick={rowLink ? (e) => (e.target as HTMLElement).closest("a,button") || nav(rowLink(row)) : undefined}>
                    {shown.map((c) => (
                      <td key={c.key} className={c.right ? "r" : ""}>
                        {c.render(row)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>{empty}</Empty>
        )
      ) : null}
      {data && data.total > data.pageSize ? (
        <div className="pager">
          <span>
            {(data.page - 1) * data.pageSize + 1}–{Math.min(data.total, data.page * data.pageSize)} of {data.total.toLocaleString("en-KE")}
          </span>
          <div className="row">
            <button className="btn sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
              Previous
            </button>
            <span>
              Page {page} of {pages}
            </span>
            <button className="btn sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>
              Next
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

/** A plain client-side table for short lists already loaded. */
export function SimpleTable<T extends Record<string, any>>({ rows, columns, rowLink, empty = "Nothing here." }: { rows: T[]; columns: Col<T>[]; rowLink?: (row: T) => string; empty?: ReactNode }) {
  const nav = useNavigate();
  if (!rows.length) return <Empty>{empty}</Empty>;
  return (
    <div className="tablewrap">
      <table className="data">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} className={c.right ? "r" : ""}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={(row.id as string) ?? i} className={rowLink ? "click" : ""} onClick={rowLink ? (e) => (e.target as HTMLElement).closest("a,button") || nav(rowLink(row)) : undefined}>
              {columns.map((c) => (
                <td key={c.key} className={c.right ? "r" : ""}>
                  {c.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
