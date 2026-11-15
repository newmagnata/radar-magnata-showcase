import { useState } from "react";

export interface Series {
  key: string;
  label: string;
  color: string;
}

interface ChartProps<T> {
  rows: T[];
  xKey: keyof T & string;
  series: Series[];
  format: (value: number) => string;
  ariaLabel: string;
}

const WIDTH = 720;
const HEIGHT = 240;
const PAD = { top: 12, right: 8, bottom: 26, left: 58 };

function niceMax(value: number): number {
  if (value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 2.5, 5, 10].find((s) => s * power >= value) ?? 10;
  return step * power;
}

const label = (day: string) => day.slice(8) ? `${day.slice(8, 10)}/${day.slice(5, 7)}` : day;

/** Colunas sobre um único eixo, com tooltip ao passar o mouse ou tocar. */
export function BarChart<T extends object>({ rows, xKey, series, format, ariaLabel }: ChartProps<T>) {
  const [active, setActive] = useState<number | null>(null);
  const value = (row: T, key: string) => Number((row as Record<string, unknown>)[key] ?? 0);
  const max = niceMax(Math.max(0, ...rows.flatMap((row) => series.map((s) => value(row, s.key)))));
  const plotWidth = WIDTH - PAD.left - PAD.right;
  const plotHeight = HEIGHT - PAD.top - PAD.bottom;
  const band = plotWidth / Math.max(rows.length, 1);
  const barWidth = Math.max(2, Math.min(18, (band - 4) / series.length - 2));
  const y = (v: number) => PAD.top + plotHeight - (v / max) * plotHeight;
  const labelEvery = Math.ceil(rows.length / 8);
  const current = active === null ? null : rows[active];
  const tooltipLeft = active === null ? 0 : ((PAD.left + band * (active + 0.5)) / WIDTH) * 100;

  return (
    <div className="chart" onMouseLeave={() => setActive(null)}>
      {series.length > 1 && (
        <div className="legend">
          {series.map((s) => (
            <span key={s.key}><i style={{ background: s.color }} />{s.label}</span>
          ))}
        </div>
      )}
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={ariaLabel}>
        {[0, 0.5, 1].map((ratio) => (
          <g key={ratio}>
            <line x1={PAD.left} x2={WIDTH - PAD.right} y1={y(max * ratio)} y2={y(max * ratio)} className="grid" />
            <text x={PAD.left - 8} y={y(max * ratio) + 4} textAnchor="end" className="axis">{format(max * ratio)}</text>
          </g>
        ))}
        {rows.map((row, index) => {
          const x = PAD.left + band * index + band / 2;
          const total = series.length * barWidth + (series.length - 1) * 2;
          return (
            <g key={index}>
              {active === index && <rect x={x - band / 2} y={PAD.top} width={band} height={plotHeight} className="hover-band" />}
              {series.map((s, position) => {
                const v = value(row, s.key);
                const top = y(v);
                const left = x - total / 2 + position * (barWidth + 2);
                const r = Math.min(4, barWidth / 2);
                const base = PAD.top + plotHeight;
                return v > 0 ? (
                  <path
                    key={s.key}
                    fill={s.color}
                    d={`M${left},${base}V${Math.min(top + r, base)}Q${left},${top} ${left + r},${top}H${left + barWidth - r}Q${left + barWidth},${top} ${left + barWidth},${Math.min(top + r, base)}V${base}Z`}
                  />
                ) : null;
              })}
              {index % labelEvery === 0 && (
                <text x={x} y={HEIGHT - 8} textAnchor="middle" className="axis">{label(String(row[xKey]))}</text>
              )}
              <rect
                x={x - band / 2}
                y={0}
                width={band}
                height={HEIGHT}
                fill="transparent"
                onMouseEnter={() => setActive(index)}
                onClick={() => setActive(index)}
              />
            </g>
          );
        })}
      </svg>
      {current && (
        <div className="tooltip" style={{ left: `${Math.min(82, Math.max(14, tooltipLeft))}%` }}>
          <strong>{label(String(current[xKey]))}</strong>
          {series.map((s) => (
            <span key={s.key}><i style={{ background: s.color }} />{s.label}: {format(value(current, s.key))}</span>
          ))}
        </div>
      )}
    </div>
  );
}
