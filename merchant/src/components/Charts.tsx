// Lightweight SVG charts. Every chart is paired with a text summary on the page that uses it,
// for accessibility and for a phone on a slow connection.

type Datum = { label: string; value: number; alt?: number; highlight?: boolean };

const W = 320;

export function BarChart({ data, height = 150, format = (v: number) => String(v), labelEvery = 1, ariaLabel }: { data: Datum[]; height?: number; format?: (v: number) => string; labelEvery?: number; ariaLabel: string }) {
  const max = Math.max(1, ...data.map((d) => Math.max(d.value, d.alt ?? 0)));
  const pad = { t: 14, b: 20, l: 2, r: 2 };
  const ih = height - pad.t - pad.b;
  const slot = (W - pad.l - pad.r) / Math.max(1, data.length);
  const paired = data.some((d) => d.alt != null);
  const bw = Math.max(2, Math.min(28, slot * (paired ? 0.36 : 0.62)));
  const top = data.reduce((best, d, i) => (d.value > data[best].value ? i : best), 0);
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${height}`} role="img" aria-label={ariaLabel}>
      <line className="grid" x1={0} x2={W} y1={pad.t + ih} y2={pad.t + ih} />
      <line className="grid" x1={0} x2={W} y1={pad.t} y2={pad.t} strokeDasharray="2 4" />
      <text className="axis" x={W} y={pad.t - 4} textAnchor="end">
        {format(max)}
      </text>
      {data.map((d, i) => {
        const x = pad.l + i * slot + slot / 2;
        const h = (d.value / max) * ih;
        const ha = ((d.alt ?? 0) / max) * ih;
        return (
          <g key={i}>
            {paired ? <rect className="bar alt" x={x - bw - 1} y={pad.t + ih - ha} width={bw} height={Math.max(0, ha)} rx={2} /> : null}
            <rect className={`bar${d.highlight === false || (!paired && i !== top && data.length > 12) ? " dim" : ""}`} x={paired ? x + 1 : x - bw / 2} y={pad.t + ih - h} width={bw} height={Math.max(d.value ? 1.5 : 0, h)} rx={2}>
              <title>{`${d.label}: ${format(d.value)}${paired ? ` / ${format(d.alt ?? 0)}` : ""}`}</title>
            </rect>
            {i % labelEvery === 0 ? (
              <text className="axis" x={x} y={height - 6} textAnchor="middle">
                {d.label}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

export function LineChart({ data, height = 150, format = (v: number) => String(v), labelEvery = 1, ariaLabel }: { data: Datum[]; height?: number; format?: (v: number) => string; labelEvery?: number; ariaLabel: string }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  const pad = { t: 14, b: 20, l: 4, r: 4 };
  const ih = height - pad.t - pad.b;
  const step = data.length > 1 ? (W - pad.l - pad.r) / (data.length - 1) : 0;
  const pts = data.map((d, i) => [pad.l + i * step, pad.t + ih - (d.value / max) * ih] as const);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
  const area = pts.length ? `${line} L${pts[pts.length - 1][0].toFixed(1)},${pad.t + ih} L${pts[0][0].toFixed(1)},${pad.t + ih} Z` : "";
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${height}`} role="img" aria-label={ariaLabel}>
      <line className="grid" x1={0} x2={W} y1={pad.t + ih} y2={pad.t + ih} />
      <line className="grid" x1={0} x2={W} y1={pad.t} y2={pad.t} strokeDasharray="2 4" />
      <text className="axis" x={W} y={pad.t - 4} textAnchor="end">
        {format(max)}
      </text>
      {pts.length > 1 ? (
        <>
          <path className="area" d={area} />
          <path className="line" d={line} />
        </>
      ) : null}
      {pts.map((p, i) => (
        <g key={i}>
          {data.length <= 14 ? <circle cx={p[0]} cy={p[1]} r={2.6} fill="var(--accent)" /> : null}
          {i % labelEvery === 0 ? (
            <text className="axis" x={p[0]} y={height - 6} textAnchor={i === 0 ? "start" : i === data.length - 1 ? "end" : "middle"}>
              {data[i].label}
            </text>
          ) : null}
        </g>
      ))}
    </svg>
  );
}

export function HBars({ rows, format = (v: number) => String(v) }: { rows: { label: string; value: number; note?: string }[]; format?: (v: number) => string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="stack-sm">
      {rows.map((r) => (
        <div className="hbar" key={r.label}>
          <div className="spread small">
            <span className="ellipsis">{r.label}</span>
            <b className="num">{format(r.value)}</b>
          </div>
          <div className="track" aria-hidden="true">
            <div className="fill" style={{ width: `${(r.value / max) * 100}%` }} />
          </div>
          {r.note ? <span className="tiny muted">{r.note}</span> : null}
        </div>
      ))}
    </div>
  );
}
