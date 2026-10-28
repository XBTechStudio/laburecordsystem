"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useT } from "@/components/i18n";

export type Col = {
  key: string;
  label: string;
  type: "text" | "amount" | "int" | "select" | "datetime" | "date" | "player" | "combo";
  required?: boolean;
  options?: { value: string; label: string }[];
  /** Pasted/typed words that mean an option value, e.g. { d: "DEPOSIT", 充值: "DEPOSIT" }. */
  aliases?: Record<string, string>;
  placeholder?: string;
  width?: string;
  /** For "combo": which list from loadLists feeds the suggestions. */
  list?: string;
};

type Row = Record<string, string>;
export type BatchResult = { ok: boolean; message: string; errors?: { i: number; msg: string }[] };

const blank = (cols: Col[]): Row => Object.fromEntries(cols.map((c) => [c.key, c.type === "select" && c.required ? (c.options?.[0]?.value ?? "") : ""]));
const isEmpty = (r: Row, cols: Col[]) => cols.every((c) => !r[c.key] || (c.type === "select" && c.required));
const num = (v: string) => Number(v.replace(/[^\d.-]/g, ""));

function pad2(x: number) {
  return String(x).padStart(2, "0");
}
function nowLocal() {
  const d = new Date(Date.now() + 8 * 3600_000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

export function BatchEntry({
  kind,
  cols,
  brands,
  brandId: initialBrand,
  save,
  loadLists,
  totals,
  note,
}: {
  kind: string;
  cols: Col[];
  brands: { id: number; name: string; currency: string }[];
  brandId: number | null;
  save: (kind: string, brandId: number, rows: Row[], defaultDate: string) => Promise<BatchResult>;
  loadLists: (kind: string, brandId: number) => Promise<Record<string, string[]>>;
  /** Columns summed in the footer; `split` sums separately per value of another column. */
  totals?: { col: string; label: string; split?: { by: string; values: Record<string, string> } }[];
  note?: string;
}) {
  const router = useRouter();
  const t = useT();
  const [brandId, setBrandId] = useState<number | null>(initialBrand);
  const [rows, setRows] = useState<Row[]>(() => Array.from({ length: 6 }, () => blank(cols)));
  const [defaultDate, setDefaultDate] = useState(nowLocal);
  const [lists, setLists] = useState<Record<string, string[]>>({});
  const [result, setResult] = useState<BatchResult | null>(null);
  const [pending, start] = useTransition();
  const table = useRef<HTMLTableElement>(null);
  const brand = brands.find((b) => b.id === brandId);

  useEffect(() => {
    if (!brandId) return;
    let live = true;
    loadLists(kind, brandId).then((l) => live && setLists(l));
    return () => {
      live = false;
    };
  }, [brandId, kind, loadLists]);

  const players = useMemo(() => new Set((lists.players ?? []).map((p) => p.toLowerCase())), [lists]);

  const cellError = (r: Row, c: Col): string | null => {
    const v = (r[c.key] ?? "").trim();
    if (!v) return c.required && c.type !== "datetime" && c.type !== "date" ? t("Required") : null;
    if ((c.type === "amount" || c.type === "int") && !(num(v) >= 0)) return t("Not a number");
    if (c.type === "select" && !c.options?.some((o) => o.value === v)) return t("Pick from the list");
    return null;
  };
  const filled = rows.map((r, i) => ({ r, i })).filter(({ r }) => !isEmpty(r, cols));
  const invalid = filled.filter(({ r }) => cols.some((c) => cellError(r, c)));
  const serverErr = new Map((result?.errors ?? []).map((e) => [e.i, e.msg]));

  const setCell = (i: number, key: string, v: string) => {
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, [key]: v } : r)));
    if (result) setResult(null);
  };

  const normalise = (c: Col, raw: string) => {
    const v = raw.trim();
    if (c.type === "select") {
      const lower = v.toLowerCase();
      const hit = c.options?.find((o) => o.value.toLowerCase() === lower || o.label.toLowerCase() === lower);
      if (hit) return hit.value;
      const alias = Object.entries(c.aliases ?? {}).find(([k]) => k.toLowerCase() === lower);
      return alias ? alias[1] : v;
    }
    if (c.type === "amount") return v.replace(/[^\d.,-]/g, "").replace(/,/g, "");
    if (c.type === "datetime") {
      const m = v.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/) ?? v.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})(?:[ T](\d{1,2}):(\d{2}))?/);
      if (!m) return v;
      const [y, mo, d] = m[1].length === 4 ? [m[1], m[2], m[3]] : [m[3], m[2], m[1]];
      return `${y}-${pad2(+mo)}-${pad2(+d)}T${pad2(+(m[4] ?? 0))}:${m[5] ?? "00"}`;
    }
    if (c.type === "date") {
      const m = v.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/) ?? v.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
      if (!m) return v;
      const [y, mo, d] = m[1].length === 4 ? [m[1], m[2], m[3]] : [m[3], m[2], m[1]];
      return `${y}-${pad2(+mo)}-${pad2(+d)}`;
    }
    return v;
  };

  /** Pasting several cells from Excel fills the grid from the cell you pasted into. */
  const onPaste = (i: number, ci: number) => (e: React.ClipboardEvent) => {
    const text = e.clipboardData.getData("text/plain");
    if (!text.includes("\t") && !text.includes("\n")) return;
    e.preventDefault();
    const lines = text.replace(/\r/g, "").replace(/\n$/, "").split("\n");
    setRows((rs) => {
      const next = [...rs];
      lines.forEach((line, li) => {
        const at = i + li;
        while (next.length <= at) next.push(blank(cols));
        const row = { ...next[at] };
        line.split("\t").forEach((cell, k) => {
          const c = cols[ci + k];
          if (c) row[c.key] = normalise(c, cell);
        });
        next[at] = row;
      });
      return next;
    });
    setResult(null);
  };

  const focusCell = (i: number, ci: number) => {
    const el = table.current?.querySelector<HTMLElement>(`[data-cell="${i}-${ci}"]`);
    el?.focus();
  };
  const onKey = (i: number, ci: number) => (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (i === rows.length - 1) setRows((rs) => [...rs, blank(cols)]);
      setTimeout(() => focusCell(i + 1, ci));
    }
  };

  const submit = () => {
    if (!brandId) return setResult({ ok: false, message: t("Choose which brand these entries are for.") });
    if (!filled.length) return setResult({ ok: false, message: t("Nothing to save yet — fill in at least one row.") });
    if (invalid.length) return setResult({ ok: false, message: t("{n} rows need fixing (marked in red).", { n: invalid.length }) });
    start(async () => {
      const payload = filled.map(({ r }) => r);
      const res = await save(kind, brandId, payload, defaultDate);
      if (res.ok) {
        setRows(Array.from({ length: 6 }, () => blank(cols)));
        setResult(res);
        loadLists(kind, brandId).then(setLists);
        router.refresh();
      } else {
        // Map errors back from "position among filled rows" to grid row index.
        setResult({ ...res, errors: res.errors?.map((e) => ({ i: filled[e.i]?.i ?? e.i, msg: e.msg })) });
      }
    });
  };

  const sums = (totals ?? []).flatMap((t) => {
    if (!t.split) return [{ label: t.label, v: filled.reduce((a, { r }) => a + (num(r[t.col] ?? "") || 0), 0), n: filled.length }];
    return Object.entries(t.split.values).map(([val, label]) => {
      const part = filled.filter(({ r }) => r[t.split!.by] === val);
      return { label, v: part.reduce((a, { r }) => a + (num(r[t.col] ?? "") || 0), 0), n: part.length };
    });
  });
  const hasTime = cols.some((c) => c.type === "datetime" || c.type === "date");

  return (
    <div className="card">
      <div className="flex flex-wrap items-end gap-3 border-b border-line p-4">
        <label className="block">
          <span className="label">{t("Brand")}</span>
          <select
            className="input w-48"
            value={brandId ?? ""}
            onChange={(e) => {
              setBrandId(Number(e.target.value) || null);
              setResult(null);
            }}
          >
            <option value="">{t("Choose brand…")}</option>
            {brands.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
        {hasTime && (
          <label className="block">
            <span className="label">{t("Default date")}</span>
            <input type="date" className="input w-44" value={defaultDate} onChange={(e) => setDefaultDate(e.target.value)} />
          </label>
        )}
        <p className="min-w-60 flex-1 text-xs text-ink-2">
          {note ?? t("Type or paste rows straight from Excel.")} {t("Press Enter to go to the next row.")}
          {hasTime && " " + t("Rows without a date use the default date.")} {t("Empty rows are ignored.")}
        </p>
      </div>

      <div className="overflow-x-auto">
        <table ref={table} className="w-full text-sm">
          <thead>
            <tr className="bg-surface-2/60 text-left text-xs text-ink-2">
              <th className="w-10 px-2 py-2 text-center font-normal">#</th>
              {cols.map((c) => (
                <th key={c.key} className="px-1 py-2 font-medium whitespace-nowrap" style={{ minWidth: c.width ?? "8rem" }}>
                  {c.label}
                  {c.required && <span className="text-critical-ink"> *</span>}
                </th>
              ))}
              <th className="w-8" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const empty = isEmpty(r, cols);
              const rowErr = serverErr.get(i);
              return (
                <tr key={i} className={`border-t border-line ${rowErr ? "bg-critical-soft/60" : ""}`}>
                  <td className="px-2 text-center text-xs text-muted">{i + 1}</td>
                  {cols.map((c, ci) => {
                    const err = empty ? null : cellError(r, c);
                    const cls = `h-8 w-full rounded-md border bg-transparent px-2 text-sm outline-none focus:border-brand focus:bg-surface ${
                      err ? "border-critical bg-critical-soft/40" : "border-transparent hover:border-line"
                    }`;
                    const common = {
                      "data-cell": `${i}-${ci}`,
                      value: r[c.key] ?? "",
                      onPaste: onPaste(i, ci),
                      onKeyDown: onKey(i, ci),
                      title: err ?? undefined,
                      "aria-label": `${c.label} ${i + 1}`,
                    };
                    let input;
                    if (c.type === "select") {
                      input = (
                        <select {...common} className={cls} onChange={(e) => setCell(i, c.key, e.target.value)}>
                          {!c.required && <option value="">–</option>}
                          {c.options?.map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                      );
                    } else {
                      const listId = c.type === "player" ? `dl-players` : c.type === "combo" ? `dl-${c.list}` : undefined;
                      input = (
                        <input
                          {...common}
                          className={`${cls} ${c.type === "amount" || c.type === "int" ? "text-right tabular-nums" : ""}`}
                          type={c.type === "datetime" ? "datetime-local" : c.type === "date" ? "date" : "text"}
                          inputMode={c.type === "amount" ? "decimal" : c.type === "int" ? "numeric" : undefined}
                          list={listId}
                          placeholder={c.placeholder}
                          onChange={(e) => setCell(i, c.key, e.target.value)}
                        />
                      );
                    }
                    const isNewPlayer = c.type === "player" && r[c.key]?.trim() && brandId && lists.players && !players.has(r[c.key].trim().toLowerCase());
                    return (
                      <td key={c.key} className="relative px-1 py-1">
                        {input}
                        {isNewPlayer && (
                          <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 rounded bg-warning-soft px-1 text-[10px] font-medium text-warning-ink">
                            {t("new")}
                          </span>
                        )}
                      </td>
                    );
                  })}
                  <td className="px-1 text-center">
                    {!empty && (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm text-muted"
                        aria-label={t("Clear row {n}", { n: i + 1 })}
                        onClick={() => setRows((rs) => rs.map((x, j) => (j === i ? blank(cols) : x)))}
                      >
                        ✕
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <datalist id="dl-players">
        {(lists.players ?? []).slice(0, 5000).map((p) => (
          <option key={p} value={p} />
        ))}
      </datalist>
      {cols
        .filter((c) => c.type === "combo")
        .map((c) => (
          <datalist key={c.key} id={`dl-${c.list}`}>
            {(lists[c.list!] ?? []).map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
        ))}

      {result && !result.ok && result.errors?.length ? (
        <ul className="mx-4 mt-3 space-y-0.5 rounded-lg bg-critical-soft px-3 py-2 text-sm text-critical-ink">
          {result.errors.slice(0, 8).map((e) => (
            <li key={e.i}>
              {t("Row {n}", { n: e.i + 1 })}: {e.msg}
            </li>
          ))}
          {result.errors.length > 8 && <li>{t("…and {n} more", { n: result.errors.length - 8 })}</li>}
        </ul>
      ) : null}

      <div className="flex flex-wrap items-center gap-3 p-4">
        <button type="button" className="btn btn-sm" onClick={() => setRows((rs) => [...rs, ...Array.from({ length: 5 }, () => blank(cols))])}>
          + {t("5 rows")}
        </button>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-ink-2">
          <span>{t("{n} rows", { n: filled.length })}</span>
          {sums.map((s) => (
            <span key={s.label} className="tabular-nums">
              {s.label}: <b className="text-ink">{s.v.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b>
              {brand && <span className="text-muted"> {brand.currency}</span>}
              {s.n !== filled.length && <span className="text-muted"> ({s.n})</span>}
            </span>
          ))}
          {invalid.length > 0 && <span className="text-critical-ink">{t("{n} to fix", { n: invalid.length })}</span>}
        </div>
        <div className="ml-auto flex items-center gap-3">
          {result && (
            <span className={`text-sm ${result.ok ? "text-good-ink" : "text-critical-ink"}`} role="status">
              {result.ok ? "✓ " : ""}
              {result.message}
            </span>
          )}
          <button type="button" className="btn btn-primary" disabled={pending} onClick={submit}>
            {pending ? t("Saving…") : filled.length ? t("Save {n} rows", { n: filled.length }) : t("Save")}
          </button>
        </div>
      </div>
    </div>
  );
}
