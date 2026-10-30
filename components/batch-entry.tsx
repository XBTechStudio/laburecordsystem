"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useT } from "@/components/i18n";

export type Col = {
  key: string;
  label: string;
  /** pick = type a short code or the start of a name, e.g. "01" → the PG / bank with code 01. */
  type: "text" | "amount" | "int" | "select" | "datetime" | "date" | "player" | "combo" | "pick";
  required?: boolean;
  options?: { value: string; label: string; code?: string | null }[];
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

/** The option a typed text means: its code, its full name, or the only name that starts with it. */
function resolvePick(c: Col, text: string) {
  const v = text.trim().toLowerCase();
  if (!v) return null;
  const opts = c.options ?? [];
  const hit = opts.find((o) => o.code?.toLowerCase() === v) ?? opts.find((o) => o.label.toLowerCase() === v);
  if (hit) return hit;
  const starts = opts.filter((o) => o.label.toLowerCase().startsWith(v));
  return starts.length === 1 ? starts[0] : null;
}

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
  carryBrand = false,
  title,
  fixed,
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
  /** A brand picked on a row fills the empty rows below, and new rows take the brand of the row above. Off = every row starts empty. */
  carryBrand?: boolean;
  /** Heading of the form, e.g. "Deposits" when the page has several. */
  title?: string;
  /** Values sent with every row, e.g. { type: "DEPOSIT" } for a deposits-only form. */
  fixed?: Row;
}) {
  const router = useRouter();
  const t = useT();
  // With more than one brand, every row picks its own brand (first column).
  const perRow = brands.length > 1;
  const single = brands.length === 1 ? brands[0].id : null;
  const brandCol: Col = { key: "brand", label: t("Brand"), type: "select", required: true, width: "9rem", options: brands.map((b) => ({ value: String(b.id), label: b.name })) };
  const allCols = perRow ? [brandCol, ...cols] : cols;
  const fresh = (brand: number | null): Row => ({ ...blank(cols), brand: carryBrand && brand ? String(brand) : "" });
  const firstBrand = carryBrand ? (initialBrand ?? single) : single;
  const [rows, setRows] = useState<Row[]>(() => Array.from({ length: 6 }, () => fresh(firstBrand)));
  const [defaultDate, setDefaultDate] = useState(nowLocal);
  const [lists, setLists] = useState<Record<number, Record<string, string[]>>>({});
  const [result, setResult] = useState<BatchResult | null>(null);
  const [pending, start] = useTransition();
  const table = useRef<HTMLTableElement>(null);
  const rowBrand = (r: Row) => Number(r.brand) || single;
  const lastBrand = (rs: Row[]) => rowBrand(rs[rs.length - 1] ?? {}) ?? firstBrand;

  const usedBrands = useMemo(() => [...new Set(rows.map(rowBrand).filter((b): b is number => !!b))], [rows]); // eslint-disable-line react-hooks/exhaustive-deps
  const missing = usedBrands.filter((b) => !lists[b]).join(",");
  useEffect(() => {
    if (!missing) return;
    let live = true;
    for (const b of missing.split(",").map(Number)) loadLists(kind, b).then((l) => live && setLists((x) => ({ ...x, [b]: l })));
    return () => {
      live = false;
    };
  }, [missing, kind, loadLists]);

  const players = useMemo(() => Object.fromEntries(Object.entries(lists).map(([b, l]) => [b, new Set((l.players ?? []).map((p) => p.toLowerCase()))])), [lists]) as Record<
    number,
    Set<string>
  >;

  const cellError = (r: Row, c: Col): string | null => {
    const v = (r[c.key] ?? "").trim();
    if (!v) return c.required && c.type !== "datetime" && c.type !== "date" ? t("Required") : null;
    if ((c.type === "amount" || c.type === "int") && !(num(v) >= 0)) return t("Not a number");
    if (c.type === "select" && !c.options?.some((o) => o.value === v)) return t("Pick from the list");
    if (c.type === "pick" && !resolvePick(c, v)) return t("No PG / bank with this code or name");
    return null;
  };
  const filled = rows.map((r, i) => ({ r, i })).filter(({ r }) => !isEmpty(r, cols));
  const invalid = filled.filter(({ r }) => allCols.some((c) => cellError(r, c)));
  const serverErr = new Map((result?.errors ?? []).map((e) => [e.i, e.msg]));

  const setCell = (i: number, key: string, v: string) => {
    setRows((rs) => rs.map((r, j) => (j === i || (carryBrand && key === "brand" && j > i && isEmpty(r, cols)) ? { ...r, [key]: v } : r)));
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
    if (c.type === "pick") return resolvePick(c, v)?.label ?? v;
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
        while (next.length <= at) next.push(fresh(lastBrand(next)));
        const row = { ...next[at] };
        line.split("\t").forEach((cell, k) => {
          const c = allCols[ci + k];
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
      if (i === rows.length - 1) setRows((rs) => [...rs, fresh(lastBrand(rs))]);
      setTimeout(() => focusCell(i + 1, ci));
    }
  };

  // A pick column sends the option's value, not the text shown.
  const pickValue = (key: string, v: string) => {
    const c = allCols.find((x) => x.key === key);
    return c?.type === "pick" ? (resolvePick(c, v)?.value ?? "") : v;
  };

  const submit = () => {
    if (!filled.length) return setResult({ ok: false, message: t("Nothing to save yet — fill in at least one row.") });
    if (filled.some(({ r }) => !rowBrand(r))) return setResult({ ok: false, message: t("Choose which brand these entries are for.") });
    if (invalid.length) return setResult({ ok: false, message: t("{n} rows need fixing (marked in red).", { n: invalid.length }) });
    start(async () => {
      // One save per brand, in the order the brands first appear. A failing brand stops there; the brands before it are saved.
      const groups = new Map<number, typeof filled>();
      for (const f of filled) groups.set(rowBrand(f.r)!, [...(groups.get(rowBrand(f.r)!) ?? []), f]);
      const saved = new Set<number>();
      const messages: string[] = [];
      for (const [b, part] of groups) {
        const res = await save(kind, b, part.map(({ r }) => ({ ...Object.fromEntries(Object.entries(r).filter(([k]) => k !== "brand").map(([k, v]) => [k, pickValue(k, v)])), ...fixed })), defaultDate);
        if (!res.ok) {
          setRows((rs) => keep(rs, saved));
          // Map errors back from "position within this brand's rows" to grid row index (after the saved rows are gone).
          const left = filled.filter(({ i }) => !saved.has(i));
          const at = (gi: number) => left.findIndex((f) => f.i === gi);
          setResult({
            ...res,
            message: [...messages, (groups.size > 1 ? `${brands.find((x) => x.id === b)?.name}: ` : "") + res.message].join(" "),
            errors: res.errors?.map((e) => ({ i: at(part[e.i]?.i ?? -1), msg: e.msg })),
          });
          if (saved.size) router.refresh();
          return;
        }
        part.forEach(({ i }) => saved.add(i));
        messages.push((groups.size > 1 ? `${brands.find((x) => x.id === b)?.name}: ` : "") + res.message);
        loadLists(kind, b).then((l) => setLists((x) => ({ ...x, [b]: l })));
      }
      setRows((rs) => keep(rs, saved));
      setResult({ ok: true, message: messages.join(" ") });
      router.refresh();
    });
  };
  /** Drops saved rows and empty rows, keeping unsaved ones on top, padded back to 6 rows. */
  const keep = (rs: Row[], saved: Set<number>) => {
    const left = rs.filter((r, i) => !saved.has(i) && !isEmpty(r, cols));
    const b = lastBrand(rs);
    return [...left, ...Array.from({ length: Math.max(6 - left.length, 1) }, () => fresh(b))];
  };

  const sums = (totals ?? []).flatMap((t) => {
    if (!t.split) return [{ label: t.label, v: filled.reduce((a, { r }) => a + (num(r[t.col] ?? "") || 0), 0), n: filled.length }];
    return Object.entries(t.split.values).map(([val, label]) => {
      const part = filled.filter(({ r }) => r[t.split!.by] === val);
      return { label, v: part.reduce((a, { r }) => a + (num(r[t.col] ?? "") || 0), 0), n: part.length };
    });
  });
  const hasTime = cols.some((c) => c.type === "datetime" || c.type === "date");
  const curs = [...new Set(filled.map(({ r }) => brands.find((b) => b.id === rowBrand(r))?.currency).filter(Boolean))];
  const currency = curs.length === 1 ? curs[0] : null;

  return (
    <div className="card">
      <div className="flex flex-wrap items-end gap-3 border-b border-line p-4">
        {title && <h2 className="w-full text-base font-semibold">{title}</h2>}
        {hasTime && (
          <label className="block">
            <span className="label">{t("Default date")}</span>
            <input type="date" className="input w-44" value={defaultDate} onChange={(e) => setDefaultDate(e.target.value)} />
          </label>
        )}
        <p className="min-w-60 flex-1 text-xs text-ink-2">
          {note ?? t("Type or paste rows straight from Excel.")} {t("Press Enter to go to the next row.")}
          {hasTime && " " + t("Rows without a time: today = the time you save, another date = 12:00.")} {t("Empty rows are ignored.")}
        </p>
      </div>

      <div className="overflow-x-auto">
        <table ref={table} className="w-full text-sm">
          <thead>
            <tr className="bg-surface-2/60 text-left text-xs text-ink-2">
              <th className="w-10 px-2 py-2 text-center font-normal">#</th>
              {allCols.map((c) => (
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
              const rb = rowBrand(r);
              return (
                <tr key={i} className={`border-t border-line ${rowErr ? "bg-critical-soft/60" : ""}`}>
                  <td className="px-2 text-center text-xs text-muted">{i + 1}</td>
                  {allCols.map((c, ci) => {
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
                          {(!c.required || (c === brandCol && !r.brand)) && <option value="">{c === brandCol ? t("Choose brand…") : "–"}</option>}
                          {c.options?.map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                      );
                    } else {
                      const listId = c.type === "player" ? `dl-players-${rb}` : c.type === "combo" ? `dl-${c.list}-${rb}` : c.type === "pick" ? `dl-pick-${c.key}` : undefined;
                      input = (
                        <input
                          {...common}
                          className={`${cls} ${c.type === "amount" || c.type === "int" ? "text-right tabular-nums" : ""}`}
                          type={c.type === "datetime" ? "datetime-local" : c.type === "date" ? "date" : "text"}
                          inputMode={c.type === "amount" ? "decimal" : c.type === "int" ? "numeric" : undefined}
                          list={listId}
                          placeholder={c.placeholder}
                          onChange={(e) => setCell(i, c.key, e.target.value)}
                          onBlur={c.type === "pick" ? (e) => setCell(i, c.key, normalise(c, e.target.value)) : undefined}
                        />
                      );
                    }
                    const isNewPlayer = c.type === "player" && r[c.key]?.trim() && rb && players[rb] && !players[rb].has(r[c.key].trim().toLowerCase());
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
                        onClick={() => setRows((rs) => rs.map((x, j) => (j === i ? fresh(rowBrand(x)) : x)))}
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

      {cols
        .filter((c) => c.type === "pick")
        .map((c) => (
          <datalist key={c.key} id={`dl-pick-${c.key}`}>
            {c.options?.map((o) => (
              <option key={o.value} value={o.label}>
                {o.code ?? ""}
              </option>
            ))}
          </datalist>
        ))}
      {usedBrands.map((b) => (
        <div key={b} hidden>
          <datalist id={`dl-players-${b}`}>
            {(lists[b]?.players ?? []).slice(0, 5000).map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
          {cols
            .filter((c) => c.type === "combo")
            .map((c) => (
              <datalist key={c.key} id={`dl-${c.list}-${b}`}>
                {(lists[b]?.[c.list!] ?? []).map((p) => (
                  <option key={p} value={p} />
                ))}
              </datalist>
            ))}
        </div>
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
        <button type="button" className="btn btn-sm" onClick={() => setRows((rs) => [...rs, ...Array.from({ length: 5 }, () => fresh(lastBrand(rs)))])}>
          + {t("5 rows")}
        </button>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-ink-2">
          <span>{t("{n} rows", { n: filled.length })}</span>
          {sums.map((s) => (
            <span key={s.label} className="tabular-nums">
              {s.label}: <b className="text-ink">{s.v.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b>
              {currency && <span className="text-muted"> {currency}</span>}
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
