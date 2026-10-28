"use client";

import { useEffect, useRef, useState } from "react";
import { useT } from "@/components/i18n";
import { sym } from "@/lib/format";

type Point = { day: string; dep: number; wd: number };

const fmtShort = (v: number) => {
  const a = Math.abs(v);
  if (a >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (a >= 1000) return `${Math.round(v / 1000)}K`;
  return String(Math.round(v));
};

/** Daily deposits and withdrawals, with a crosshair tooltip. */
export function TrendChart({ data, currency }: { data: Point[]; currency: string }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(600);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);

  const money = (v: number) => `${sym(currency)} ${Math.round(v).toLocaleString("en-MY")}`;
  const h = 240;
  const pad = { l: 44, r: 92, t: 10, b: 24 };
  const iw = Math.max(w - pad.l - pad.r, 10);
  const ih = h - pad.t - pad.b;
  const max = Math.max(...data.map((d) => Math.max(d.dep, d.wd)), 1);
  const step = Math.pow(10, Math.floor(Math.log10(max)));
  const top = Math.ceil(max / step) * step;
  const x = (i: number) => pad.l + (data.length > 1 ? (i / (data.length - 1)) * iw : iw / 2);
  const y = (v: number) => pad.t + ih - (v / top) * ih;
  const path = (k: "dep" | "wd") => data.map((d, i) => `${i ? "L" : "M"}${x(i)},${y(d[k])}`).join("");
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * top);
  const every = Math.ceil(data.length / Math.max(Math.floor(iw / 56), 1));
  const last = data.length - 1;
  const hd = hover != null ? data[hover] : null;

  return (
    <div>
      <div className="mb-2 flex gap-4 text-xs text-ink-2">
        <span className="flex items-center gap-1.5">
          <span className="h-0.5 w-4 rounded bg-[var(--series-1)]" />
          {t("Deposits")}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-0.5 w-4 rounded bg-[var(--series-2)]" />
          {t("Withdrawals")}
        </span>
      </div>
      <div ref={ref} className="relative">
        <svg
          width={w}
          height={h}
          className="block touch-none"
          onPointerLeave={() => setHover(null)}
          onPointerMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            const i = Math.round(((e.clientX - r.left - pad.l) / iw) * last);
            setHover(Math.min(Math.max(i, 0), last));
          }}
        >
          {ticks.map((v) => (
            <g key={v}>
              <line x1={pad.l} x2={pad.l + iw} y1={y(v)} y2={y(v)} stroke={v === 0 ? "var(--axis)" : "var(--grid)"} />
              <text x={pad.l - 8} y={y(v)} dy="0.32em" textAnchor="end" className="fill-[var(--muted)] text-[11px] tabular-nums">
                {fmtShort(v)}
              </text>
            </g>
          ))}
          {data.map((d, i) =>
            i % every === 0 || i === last ? (
              <text key={d.day} x={x(i)} y={h - 6} textAnchor="middle" className="fill-[var(--muted)] text-[11px] tabular-nums">
                {d.day.slice(5).replace("-", "/")}
              </text>
            ) : null,
          )}
          <path d={path("wd")} fill="none" stroke="var(--series-2)" strokeWidth={2} strokeLinejoin="round" />
          <path d={path("dep")} fill="none" stroke="var(--series-1)" strokeWidth={2} strokeLinejoin="round" />
          {last >= 0 && (
            <>
              <text x={x(last) + 6} y={Math.min(y(data[last].dep), y(data[last].wd) - 14)} dy="0.32em" className="fill-[var(--ink-2)] text-[11px]">
                {t("Deposits")}
              </text>
              <text x={x(last) + 6} y={Math.max(y(data[last].wd), y(data[last].dep) + 14)} dy="0.32em" className="fill-[var(--ink-2)] text-[11px]">
                {t("Withdrawals")}
              </text>
            </>
          )}
          {hd && hover != null && (
            <g>
              <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + ih} stroke="var(--axis)" />
              <circle cx={x(hover)} cy={y(hd.dep)} r={4.5} fill="var(--series-1)" stroke="var(--surface)" strokeWidth={2} />
              <circle cx={x(hover)} cy={y(hd.wd)} r={4.5} fill="var(--series-2)" stroke="var(--surface)" strokeWidth={2} />
            </g>
          )}
        </svg>
        {hd && hover != null && (
          <div className="pointer-events-none absolute top-2 z-10 w-48 rounded-lg border border-line bg-surface p-2.5 text-xs shadow-lg" style={{ left: Math.min(Math.max(x(hover) + 12, 0), w - 196) }}>
            <div className="mb-1 font-medium">{hd.day}</div>
            {[
              [t("Deposits"), hd.dep, "var(--series-1)"],
              [t("Withdrawals"), hd.wd, "var(--series-2)"],
            ].map(([l, v, c]) => (
              <div key={String(l)} className="flex items-center gap-1.5 py-0.5">
                <span className="h-2 w-2 rounded-full" style={{ background: String(c) }} />
                <span className="text-ink-2">{l}</span>
                <span className="ml-auto font-medium tabular-nums">{money(Number(v))}</span>
              </div>
            ))}
            <div className="mt-1 flex border-t border-line pt-1">
              <span className="text-ink-2">{t("Win/Loss")}</span>
              <span className="ml-auto font-medium tabular-nums">{money(hd.dep - hd.wd)}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
