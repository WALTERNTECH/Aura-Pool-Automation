import { useEffect, useId, useRef, useState, type ReactNode } from "react";

// Dashboard charts. They draw at the container's real width (no stretched text) and show a
// tooltip on hover or tap.

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/** Rounds a maximum up to a readable axis top (1, 2, 2.5, 5 × 10ⁿ). */
function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (v <= m * p) return m * p;
  return 10 * p;
}

export type BarDatum = { key: string; label: string; value: number; line?: number; tip: ReactNode; highlight?: boolean };

/** Bars with an optional line on the same scale (e.g. collected and the platform's share). */
export function BarChart({ data, height = 220, format, ariaLabel }: { data: BarDatum[]; height?: number; format: (v: number) => string; ariaLabel: string }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const padL = 46;
  const padB = 24;
  const padT = 10;
  const innerW = Math.max(0, w - padL - 4);
  const innerH = height - padB - padT;
  const top = niceMax(Math.max(0, ...data.map((d) => Math.max(d.value, d.line ?? 0))));
  const slot = data.length ? innerW / data.length : 0;
  const bw = Math.max(4, Math.min(30, slot * 0.62));
  const y = (v: number) => padT + innerH - (v / top) * innerH;
  const x = (i: number) => padL + slot * i + slot / 2;
  // Gridlines at 0, half and top, minus any whose label would repeat (small counts: 0, 1).
  const ticks = [0, 0.5, 1].map((f) => top * f).filter((t, i, all) => all.findLastIndex((u) => format(u) === format(t)) === i);
  const every = slot < 26 ? Math.ceil(26 / Math.max(1, slot)) : 1;
  const hasLine = data.some((d) => d.line != null);
  const line = hasLine ? data.map((d, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(d.line ?? 0).toFixed(1)}`).join(" ") : "";
  const h = hover != null ? data[hover] : null;

  return (
    <div className="chart-box" ref={ref} onMouseLeave={() => setHover(null)}>
      {w ? (
        <svg className="chart" width={w} height={height} role="img" aria-label={ariaLabel}>
          {ticks.map((t) => (
            <g key={t}>
              <line className="grid" x1={padL} x2={w - 4} y1={y(t)} y2={y(t)} />
              <text className="axis" x={padL - 8} y={y(t) + 3} textAnchor="end">
                {format(t)}
              </text>
            </g>
          ))}
          {data.map((d, i) => {
            const bh = Math.max(d.value ? 2 : 0, innerH - (y(d.value) - padT));
            return (
              <g key={d.key}>
                <rect className={`bar${d.highlight ? " hot" : ""}${hover != null && hover !== i ? " dim" : ""}`} x={x(i) - bw / 2} y={padT + innerH - bh} width={bw} height={bh} rx={Math.min(5, bw / 3)} />
                {i % every === 0 || i === data.length - 1 ? (
                  <text className="axis" x={x(i)} y={height - 6} textAnchor="middle">
                    {d.label}
                  </text>
                ) : null}
                <rect x={padL + slot * i} y={padT} width={slot} height={innerH} fill="transparent" onMouseEnter={() => setHover(i)} onClick={() => setHover(hover === i ? null : i)} />
              </g>
            );
          })}
          {hasLine ? <path className="line2" d={line} /> : null}
          {h && hover != null ? <line className="cursor" x1={x(hover)} x2={x(hover)} y1={padT} y2={padT + innerH} /> : null}
        </svg>
      ) : (
        <div style={{ height }} />
      )}
      {h && hover != null ? (
        <div className="chart-tip" style={{ left: Math.min(Math.max(x(hover), 70), w - 70) }}>
          {h.tip}
        </div>
      ) : null}
    </div>
  );
}

/** A small filled line for a KPI card. */
export function Spark({ values, height = 44 }: { values: number[]; height?: number }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const gid = `sf${useId().replace(/:/g, "")}`;
  const max = Math.max(1, ...values);
  const n = values.length;
  const pts = values.map((v, i) => [n > 1 ? (i / (n - 1)) * (w - 4) + 2 : w / 2, height - 3 - (v / max) * (height - 8)] as const);
  const d = pts.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`).join(" ");
  return (
    <div className="spark" ref={ref} aria-hidden="true">
      {w && n ? (
        <svg className="chart" width={w} height={height}>
          <defs>
            <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor="var(--accent)" stopOpacity="0.18" />
              <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path fill={`url(#${gid})`} d={`${d} L${pts[n - 1][0].toFixed(1)},${height} L${pts[0][0].toFixed(1)},${height} Z`} />
          <path className="line" d={d} />
          <circle cx={pts[n - 1][0]} cy={pts[n - 1][1]} r={3} fill="var(--accent)" />
        </svg>
      ) : null}
    </div>
  );
}
