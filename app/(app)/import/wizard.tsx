"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useT } from "@/components/i18n";
import { tk } from "@/lib/i18n";
import type { ImportKind, ImportRow } from "./actions";
import { finishImport, importChunk, listTemplates, saveTemplate, startImport } from "./actions";

type Cell = string | number | Date | boolean | null | undefined;
type FieldDef = { key: keyof ImportRow; label: string; required?: boolean; parse: "text" | "amount" | "int" | "time" | "date" | "type" };
type Mapping = {
  headerRow: number;
  fields: Partial<Record<keyof ImportRow, string>>; // header text
  fixed: { type?: "DEPOSIT" | "WITHDRAW"; promo?: string; channel?: string };
  typeValues: Record<string, "DEPOSIT" | "WITHDRAW" | "SKIP">;
  dateFormat: "auto" | "dmy" | "mdy" | "ymd";
  /** Only rows whose value in this column is one of these are imported (e.g. Status = COMPLETED). */
  filter?: { col: string; values: string[] };
  /** Keep only the first word of the username cell, e.g. "T12829" from "T12829 Min Min Win ✔ VIP-GOLD". */
  firstWord?: boolean;
  /** The file's times are UTC; add 8 hours to get Malaysia/Singapore time. */
  utc?: boolean;
};
type Template = { id: number; name: string; mapping: Record<string, unknown>; headerSig: string };

const FIELDS: Record<ImportKind, FieldDef[]> = {
  txn: [
    { key: "username", label: tk("Player username"), required: true, parse: "text" },
    { key: "type", label: tk("Deposit / withdrawal"), required: true, parse: "type" },
    { key: "amount", label: tk("Amount"), required: true, parse: "amount" },
    { key: "time", label: tk("Date & time"), required: true, parse: "time" },
    { key: "ref", label: tk("Reference no."), parse: "text" },
    { key: "channel", label: tk("PG / bank"), parse: "text" },
    { key: "note", label: tk("Note"), parse: "text" },
    { key: "phone", label: tk("Phone (fills player)"), parse: "text" },
    { key: "name", label: tk("Name (fills player)"), parse: "text" },
  ],
  player: [
    { key: "username", label: tk("Username"), required: true, parse: "text" },
    { key: "phone", label: tk("Phone"), parse: "text" },
    { key: "name", label: tk("Name"), parse: "text" },
    { key: "note", label: tk("Note"), parse: "text" },
  ],
  claim: [
    { key: "username", label: tk("Player username"), required: true, parse: "text" },
    { key: "promo", label: tk("Promotion"), required: true, parse: "text" },
    { key: "amount", label: tk("Bonus amount"), required: true, parse: "amount" },
    { key: "time", label: tk("Date & time"), required: true, parse: "time" },
  ],
  flow: [
    { key: "channel", label: tk("PG / bank"), required: true, parse: "text" },
    { key: "date", label: tk("Date"), required: true, parse: "date" },
    { key: "inAmount", label: tk("Money in"), parse: "amount" },
    { key: "inCount", label: tk("In count"), parse: "int" },
    { key: "outAmount", label: tk("Money out"), parse: "amount" },
    { key: "outCount", label: tk("Out count"), parse: "int" },
    { key: "fee", label: tk("Fee"), parse: "amount" },
    { key: "note", label: tk("Note"), parse: "text" },
  ],
};

// Header words we recognise, in English, Chinese and Malay/Indonesian.
const GUESS: Partial<Record<keyof ImportRow, string[]>> = {
  username: ["username", "user name", "member id", "member", "login", "player", "account", "user", "会员账号", "会员", "用户名", "账号", "玩家", "pengguna", "akun"],
  type: ["transaction type", "txn type", "type", "类型", "交易类型", "jenis", "tipe"],
  amount: ["amount", "amt", "credit", "金额", "数额", "jumlah", "nominal"],
  time: ["completed date", "completed time", "completed", "processed date", "approved", "transaction date", "date time", "datetime", "date", "time", "created at", "created", "submitted date", "日期", "时间", "完成时间", "tarikh", "masa", "tanggal", "waktu"],
  date: ["date", "日期", "tarikh", "tanggal"],
  ref: ["reference", "ref", "transaction id", "txn id", "order id", "order", "单号", "订单号", "流水号", "referensi"],
  channel: ["payment gateway", "gateway", "bank", "channel", "pg", "method", "银行", "通道", "渠道", "metode"],
  note: ["remark", "remarks", "note", "notes", "备注", "catatan", "keterangan"],
  phone: ["phone", "mobile", "contact", "tel", "手机", "电话", "telepon", "hp"],
  name: ["full name", "real name", "name", "姓名", "名字", "nama"],
  promo: ["promotion", "promo", "bonus name", "campaign", "优惠", "活动", "promosi"],
  inAmount: ["money in", "in amount", "deposit amount", "credit", "in", "入款", "进款", "masuk"],
  inCount: ["in count", "deposit count", "入款笔数"],
  outAmount: ["money out", "out amount", "withdraw amount", "debit", "out", "出款", "keluar"],
  outCount: ["out count", "withdraw count", "出款笔数"],
  fee: ["fee", "fees", "charges", "charge", "手续费", "biaya"],
};

const DEP_WORDS = ["dep", "in", "credit", "top", "充", "存", "入", "setor", "masuk"];
const WD_WORDS = ["with", "wd", "out", "debit", "提", "取", "出", "tarik", "keluar"];

const pad = (x: number) => String(x).padStart(2, "0");

function cellText(c: Cell) {
  if (c == null) return "";
  if (c instanceof Date) return `${c.getFullYear()}-${pad(c.getMonth() + 1)}-${pad(c.getDate())} ${pad(c.getHours())}:${pad(c.getMinutes())}`;
  return String(c).trim();
}

function parseAmount(c: Cell) {
  if (typeof c === "number") return Math.abs(c);
  const s = cellText(c).replace(/[^\d.,-]/g, "").replace(/,(?=\d{3}\b)/g, "").replace(/,/g, ".");
  const x = Number(s);
  return s && Number.isFinite(x) ? Math.abs(x) : NaN;
}

/** Returns "YYYY-MM-DDTHH:mm" in the wall-clock time written in the file (treated as Malaysia time). */
function parseWhen(c: Cell, fmt: Mapping["dateFormat"]): string | null {
  if (c instanceof Date && !isNaN(c.getTime())) return `${c.getFullYear()}-${pad(c.getMonth() + 1)}-${pad(c.getDate())}T${pad(c.getHours())}:${pad(c.getMinutes())}`;
  if (typeof c === "number" && c > 20000 && c < 80000) {
    // Excel serial date
    const d = new Date(Math.round((c - 25569) * 86400_000));
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  }
  const s = cellText(c);
  const m = s.match(/^(\d{1,4})[-/.](\d{1,2})[-/.](\d{1,4})(?:[ T,]+(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])?)?/);
  if (!m) return null;
  const [a, b] = [Number(m[1]), Number(m[2])];
  let cc = Number(m[3]);
  let y: number, mo: number, d: number;
  if (m[1].length === 4 || fmt === "ymd") [y, mo, d] = [a, b, cc];
  else {
    if (cc < 100) cc += 2000;
    const f = fmt === "auto" ? (a > 12 ? "dmy" : b > 12 ? "mdy" : "dmy") : fmt;
    [y, mo, d] = f === "mdy" ? [cc, a, b] : [cc, b, a];
  }
  let h = Number(m[4] ?? 0);
  if (m[6]) {
    const pm = m[6].toLowerCase() === "pm";
    if (pm && h < 12) h += 12;
    if (!pm && h === 12) h = 0;
  }
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${m[5] ?? "00"}`;
}

const STATUS_HEADER = /status|state|状态|狀態/i;
const DONE_WORDS = /complet|success|approv|done|paid|成功|完成|berhasil|selesai/i;

/** Finds a status-like column and pre-ticks the values that mean the money really moved. */
function guessFilter(headers: string[], body: Cell[][]): Mapping["filter"] {
  const i = headers.findIndex((h) => STATUS_HEADER.test(h));
  if (i < 0) return undefined;
  const values = [...new Set(body.map((r) => cellText(r[i])).filter(Boolean))];
  const done = values.filter((v) => DONE_WORDS.test(v));
  return done.length && done.length < values.length ? { col: headers[i], values: done } : undefined;
}

function plus8(when: string) {
  const d = new Date(new Date(when + ":00Z").getTime() + 8 * 3600_000);
  return d.toISOString().slice(0, 16);
}

function guessType(v: string): "DEPOSIT" | "WITHDRAW" | "SKIP" {
  const s = v.toLowerCase();
  if (WD_WORDS.some((w) => s.includes(w))) return "WITHDRAW";
  if (DEP_WORDS.some((w) => s.includes(w))) return "DEPOSIT";
  return "SKIP";
}

function guessFields(kind: ImportKind, headers: string[]) {
  const out: Mapping["fields"] = {};
  const used = new Set<string>();
  for (const f of FIELDS[kind]) {
    const words = GUESS[f.key] ?? [];
    let best: { h: string; score: number } | null = null;
    for (const h of headers) {
      if (!h || used.has(h)) continue;
      const hl = h.toLowerCase();
      for (const [wi, w] of words.entries()) {
        const score = (hl === w ? 300 : hl.startsWith(w) ? 200 : hl.includes(w) ? 100 : 0) - wi;
        if (score > 0 && (!best || score > best.score)) best = { h, score };
      }
    }
    if (best) {
      out[f.key] = best.h;
      used.add(best.h);
    }
  }
  return out;
}

export function ImportWizard({ brands, initialBrand }: { brands: { id: number; name: string }[]; initialBrand: number | null }) {
  const router = useRouter();
  const t = useT();
  const [brandId, setBrandId] = useState<number | null>(initialBrand);
  const [kind, setKind] = useState<ImportKind>("txn");
  const [fileName, setFileName] = useState("");
  const [sheets, setSheets] = useState<Record<string, Cell[][]>>({});
  const [sheet, setSheet] = useState("");
  const [map, setMap] = useState<Mapping | null>(null);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [usingTemplate, setUsingTemplate] = useState<string | null>(null);
  const [saveAs, setSaveAs] = useState("");
  const [busy, setBusy] = useState<{ done: number; total: number } | null>(null);
  const [summary, setSummary] = useState<{ inserted: number; skipped: number; created: number; problems: string[]; error?: string } | null>(null);
  const [readError, setReadError] = useState<string | null>(null);

  useEffect(() => {
    listTemplates(kind).then(setTemplates);
  }, [kind]);

  const grid = sheets[sheet] ?? [];
  const headerRow = map?.headerRow ?? 0;
  const headers = (grid[headerRow] ?? []).map(cellText);
  const body = grid.slice(headerRow + 1).filter((r) => r.some((c) => cellText(c) !== ""));
  const col = (h?: string) => (h ? headers.indexOf(h) : -1);
  const headerSig = headers.filter(Boolean).join("|").toLowerCase();

  function applyDefaults(g: Cell[][], k: ImportKind, tpls: Template[]) {
    const hr = Math.max(0, g.findIndex((r) => r.filter((c) => typeof c === "string" && c.trim()).length >= 2));
    const hs = (g[hr] ?? []).map(cellText);
    const sig = hs.filter(Boolean).join("|").toLowerCase();
    const tpl = tpls.find((x) => x.headerSig === sig);
    if (tpl) {
      setMap({ ...(tpl.mapping as unknown as Mapping), headerRow: hr });
      setUsingTemplate(tpl.name);
      return;
    }
    setUsingTemplate(null);
    const rows = g.slice(hr + 1).filter((r) => r.some((c) => cellText(c) !== ""));
    setMap({ headerRow: hr, fields: guessFields(k, hs), fixed: {}, typeValues: {}, dateFormat: "auto", filter: guessFilter(hs, rows) });
  }

  async function onFile(f: File | undefined) {
    setSummary(null);
    setReadError(null);
    if (!f) return;
    try {
      const XLSX = await import("xlsx");
      const wb = XLSX.read(await f.arrayBuffer(), { cellDates: true });
      const all: Record<string, Cell[][]> = {};
      for (const n of wb.SheetNames) all[n] = XLSX.utils.sheet_to_json<Cell[]>(wb.Sheets[n], { header: 1, raw: true, defval: null });
      const first = wb.SheetNames.find((n) => all[n].length > 1) ?? wb.SheetNames[0];
      setFileName(f.name);
      setSheets(all);
      setSheet(first);
      applyDefaults(all[first], kind, templates);
    } catch {
      setReadError(t("This file couldn't be read. Please use .xlsx, .xls or .csv."));
    }
  }

  // Distinct values in the type column, so the user can say which mean deposit and which withdrawal.
  const typeCol = col(map?.fields.type);
  const typeValues = useMemo(() => {
    if (kind !== "txn" || typeCol < 0) return [];
    return [...new Set(body.map((r) => cellText(r[typeCol])).filter(Boolean))].slice(0, 30);
  }, [body, typeCol, kind]);

  const filterCol = map?.filter ? col(map.filter.col) : -1;
  const filterCounts = useMemo(() => {
    const m = new Map<string, number>();
    if (filterCol >= 0) for (const r of body) m.set(cellText(r[filterCol]), (m.get(cellText(r[filterCol])) ?? 0) + 1);
    return m;
  }, [body, filterCol]);
  const filterValues = [...filterCounts.keys()].filter(Boolean).slice(0, 30);
  const sampleUser = map && col(map.fields.username) >= 0 ? cellText(body[0]?.[col(map.fields.username)]).slice(0, 40) : "";

  const fields = FIELDS[kind];
  const typeMode: "column" | "DEPOSIT" | "WITHDRAW" = map?.fixed.type ?? "column";

  /** Turns the sheet into rows for the server, with a reason for each row that can't be used. */
  const parsed = useMemo(() => {
    if (!map) return { rows: [] as ImportRow[], problems: [] as string[], skipped: 0, filtered: 0 };
    const rows: ImportRow[] = [];
    const problems: string[] = [];
    let skipped = 0;
    let filtered = 0;
    const fcol = map.filter ? col(map.filter.col) : -1;
    body.forEach((r, i) => {
      const line = headerRow + i + 2;
      if (fcol >= 0 && !map.filter!.values.includes(cellText(r[fcol]))) {
        filtered++;
        return;
      }
      const out: ImportRow = {};
      let bad: string | null = null;
      for (const f of fields) {
        if (f.key === "type") {
          if (map.fixed.type) out.type = map.fixed.type;
          else {
            const raw = cellText(r[col(map.fields.type)]);
            const v = map.typeValues[raw] ?? guessType(raw);
            if (v === "SKIP") {
              bad = "skip";
              break;
            }
            out.type = v;
          }
          continue;
        }
        if (f.key === "promo" && map.fixed.promo) {
          out.promo = map.fixed.promo;
          continue;
        }
        if (f.key === "channel" && map.fixed.channel) {
          out.channel = map.fixed.channel;
          continue;
        }
        const ci = col(map.fields[f.key]);
        const cell = ci >= 0 ? r[ci] : null;
        const field = t(f.label);
        if (f.parse === "amount" || f.parse === "int") {
          const x = parseAmount(cell);
          if (cellText(cell) !== "" && Number.isNaN(x)) bad ??= t("{field} “{value}” isn't a number", { field, value: cellText(cell) });
          if (!Number.isNaN(x)) (out[f.key] as number) = f.parse === "int" ? Math.round(x) : x;
        } else if (f.parse === "time" || f.parse === "date") {
          const w = parseWhen(cell, map.dateFormat);
          if (cellText(cell) !== "" && !w) bad ??= t("{field} “{value}” isn't a date we understand", { field, value: cellText(cell) });
          const ww = w && map.utc ? plus8(w) : w;
          if (ww) (out[f.key] as string) = f.parse === "date" ? ww.slice(0, 10) : ww;
        } else {
          let v = cellText(cell);
          if (f.key === "username" && map.firstWord) v = v.split(/\s+/)[0] ?? "";
          if (v) (out[f.key] as string) = v;
        }
        if (f.required && out[f.key] == null && !bad) bad = t("{field} is empty", { field });
      }
      if (bad === "skip") skipped++;
      else if (bad) problems.push(`${t("Row {n}", { n: line })}: ${bad}`);
      else rows.push(out);
    });
    return { rows, problems, skipped, filtered };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, body, kind, t]);

  const missing = fields.filter(
    (f) => f.required && !(f.key === "type" && map?.fixed.type) && !(f.key === "promo" && map?.fixed.promo) && !(f.key === "channel" && map?.fixed.channel) && col(map?.fields[f.key]) < 0,
  );

  async function run() {
    if (!brandId || !map) return;
    if (saveAs.trim()) await saveTemplate(kind, saveAs, map as unknown as Record<string, unknown>, headerSig);
    const rows = parsed.rows;
    setBusy({ done: 0, total: rows.length });
    const batchId = await startImport(brandId, kind, fileName, rows.length);
    const total = { inserted: 0, skipped: parsed.skipped + parsed.filtered, created: 0, problems: [...parsed.problems] as string[], error: undefined as string | undefined };
    for (let i = 0; i < rows.length; i += 500) {
      const r = await importChunk(batchId, rows.slice(i, i + 500), i);
      if (r.error) {
        total.error = r.error;
        break;
      }
      total.inserted += r.inserted;
      total.skipped += r.skipped;
      total.created += r.created;
      total.problems.push(...r.problems);
      setBusy({ done: Math.min(i + 500, rows.length), total: rows.length });
    }
    await finishImport(batchId);
    setBusy(null);
    setSummary(total);
    setSheets({});
    setMap(null);
    setSaveAs("");
    listTemplates(kind).then(setTemplates);
    router.refresh();
  }

  const setField = (k: keyof ImportRow, h: string) => map && setMap({ ...map, fields: { ...map.fields, [k]: h || undefined } });

  return (
    <div className="card">
      <div className="grid gap-3 border-b border-line p-4 sm:grid-cols-[12rem_15rem_1fr]">
        <label className="block">
          <span className="label">1. {t("Brand")}</span>
          <select className="input" value={brandId ?? ""} onChange={(e) => setBrandId(Number(e.target.value) || null)} disabled={!!busy}>
            <option value="">{t("Choose brand…")}</option>
            {brands.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="label">2. {t("What's in the file")}</span>
          <select
            className="input"
            value={kind}
            disabled={!!busy}
            onChange={(e) => {
              const k = e.target.value as ImportKind;
              setKind(k);
              if (sheet && sheets[sheet]) applyDefaults(sheets[sheet], k, []);
            }}
          >
            <option value="txn">{t("Deposits / withdrawals")}</option>
            <option value="player">{t("Player list")}</option>
            <option value="claim">{t("Promotion claims")}</option>
            <option value="flow">{t("PG / bank statement (daily totals)")}</option>
          </select>
        </label>
        <label className="block">
          <span className="label">3. {t("File (.xlsx, .xls, .csv)")}</span>
          <input
            type="file"
            accept=".xlsx,.xls,.csv"
            disabled={!brandId || !!busy}
            className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-brand-soft file:px-3 file:py-2 file:text-sm file:font-medium file:text-brand-ink"
            onChange={(e) => {
              onFile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          {!brandId && <span className="hint block">{t("Choose the brand first.")}</span>}
        </label>
      </div>

      {readError && <div className="m-4 rounded-lg bg-critical-soft px-3 py-2 text-sm text-critical-ink">{readError}</div>}

      {summary && (
        <div className={`m-4 rounded-lg p-4 text-sm ${summary.error ? "bg-critical-soft text-critical-ink" : "bg-good-soft text-good-ink"}`}>
          <div className="font-semibold">{summary.error ? t("Import stopped: {reason}", { reason: summary.error }) : t("Import finished")}</div>
          <div className="mt-1">
            {t("{added} added · {skipped} skipped (already in the system, or marked “skip”)", { added: summary.inserted, skipped: summary.skipped })}
            {summary.created ? " · " + t("{n} new players created", { n: summary.created }) : ""}
          </div>
          {summary.problems.length > 0 && (
            <details className="mt-2 text-ink">
              <summary className="cursor-pointer">{t("{n} rows couldn't be used", { n: summary.problems.length })}</summary>
              <ul className="mt-1 max-h-48 overflow-auto text-xs">
                {summary.problems.slice(0, 300).map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {map && grid.length > 0 && (
        <div className="space-y-5 p-4">
          <div className="flex flex-wrap items-end gap-3">
            {Object.keys(sheets).length > 1 && (
              <label className="block">
                <span className="label">{t("Sheet")}</span>
                <select
                  className="input w-48"
                  value={sheet}
                  onChange={(e) => {
                    setSheet(e.target.value);
                    applyDefaults(sheets[e.target.value], kind, templates);
                  }}
                >
                  {Object.keys(sheets).map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </label>
            )}
            <label className="block">
              <span className="label">{t("Column titles are on row")}</span>
              <input
                type="number"
                min={1}
                className="input w-24"
                value={headerRow + 1}
                onChange={(e) => setMap({ ...map, headerRow: Math.max(0, Number(e.target.value) - 1), fields: guessFields(kind, (grid[Math.max(0, Number(e.target.value) - 1)] ?? []).map(cellText)) })}
              />
            </label>
            <label className="block">
              <span className="label">{t("Saved template")}</span>
              <select
                className="input w-56"
                value={usingTemplate ?? ""}
                onChange={(e) => {
                  const tpl = templates.find((x) => x.name === e.target.value);
                  if (tpl) {
                    setMap({ ...(tpl.mapping as unknown as Mapping), headerRow });
                    setUsingTemplate(tpl.name);
                  } else {
                    setUsingTemplate(null);
                    setMap({ ...map, fields: guessFields(kind, headers) });
                  }
                }}
              >
                <option value="">{t("None (auto-detect)")}</option>
                {templates.map((x) => (
                  <option key={x.id}>{x.name}</option>
                ))}
              </select>
            </label>
            <div className="text-sm text-ink-2">
              <b className="text-ink">{fileName}</b> · {t("{n} data rows", { n: body.length })}
              {usingTemplate && <span className="chip ml-2 bg-good-soft text-good-ink">{t("Template “{name}” applied", { name: usingTemplate })}</span>}
            </div>
          </div>

          <div>
            <div className="mb-2 text-sm font-medium">4. {t("Match the columns")}</div>
            <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
              {fields.map((f) => {
                const fixedOpts = f.key === "type" || (f.key === "promo" && kind === "claim") || (f.key === "channel" && kind === "flow");
                return (
                  <div key={f.key}>
                    <span className="label">
                      {t(f.label)}
                      {f.required && <span className="text-critical-ink"> *</span>}
                    </span>
                    {f.key === "type" ? (
                      <div className="flex gap-2">
                        <select
                          className="input"
                          value={typeMode}
                          onChange={(e) => setMap({ ...map, fixed: { ...map.fixed, type: e.target.value === "column" ? undefined : (e.target.value as "DEPOSIT" | "WITHDRAW") } })}
                        >
                          <option value="column">{t("From a column…")}</option>
                          <option value="DEPOSIT">{t("Every row is a deposit")}</option>
                          <option value="WITHDRAW">{t("Every row is a withdrawal")}</option>
                        </select>
                        {typeMode === "column" && <ColumnSelect headers={headers} value={map.fields.type} onChange={(h) => setField("type", h)} />}
                      </div>
                    ) : fixedOpts && map.fixed[f.key as "promo" | "channel"] !== undefined ? (
                      <div className="flex gap-2">
                        <input
                          className="input"
                          value={map.fixed[f.key as "promo" | "channel"]}
                          placeholder={f.key === "promo" ? t("Promotion name for all rows") : t("PG/bank name for all rows")}
                          onChange={(e) => setMap({ ...map, fixed: { ...map.fixed, [f.key]: e.target.value } })}
                        />
                        <button type="button" className="btn btn-sm h-9" onClick={() => setMap({ ...map, fixed: { ...map.fixed, [f.key]: undefined } })}>
                          {t("Use column")}
                        </button>
                      </div>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        <ColumnSelect headers={headers} value={map.fields[f.key]} onChange={(h) => setField(f.key, h)} />
                        {f.key === "username" && col(map.fields.username) >= 0 && (
                          <label className="flex items-center gap-2 text-xs text-ink-2">
                            <input type="checkbox" className="h-4 w-4 accent-[var(--brand)]" checked={!!map.firstWord} onChange={(e) => setMap({ ...map, firstWord: e.target.checked })} />
                            {t("Use only the first word")}
                            {sampleUser && <span className="text-muted">({sampleUser} → {sampleUser.split(/\s+/)[0]})</span>}
                          </label>
                        )}
                        {fixedOpts && (
                          <button type="button" className="btn btn-sm h-9 whitespace-nowrap" onClick={() => setMap({ ...map, fixed: { ...map.fixed, [f.key]: "" } })}>
                            {t("Same for all")}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
              {fields.some((f) => f.parse === "time" || f.parse === "date") && (
                <label className="block">
                  <span className="label">{t("Date format in the file")}</span>
                  <select className="input" value={map.dateFormat} onChange={(e) => setMap({ ...map, dateFormat: e.target.value as Mapping["dateFormat"] })}>
                    <option value="auto">{t("Detect automatically")}</option>
                    <option value="dmy">{t("Day/Month/Year")} (28/10/2026)</option>
                    <option value="mdy">{t("Month/Day/Year")} (10/28/2026)</option>
                    <option value="ymd">{t("Year-Month-Day")} (2026-10-28)</option>
                  </select>
                  <span className="mt-1.5 flex items-center gap-2 text-xs text-ink-2">
                    <input type="checkbox" className="h-4 w-4 accent-[var(--brand)]" checked={!!map.utc} onChange={(e) => setMap({ ...map, utc: e.target.checked })} />
                    {t("Times in this file are UTC (add 8 hours)")}
                  </span>
                </label>
              )}
            </div>
          </div>

          <div>
            <div className="mb-2 text-sm font-medium">{t("Only import rows where")}</div>
            <div className="flex flex-wrap items-center gap-2">
              <select
                className="input w-56"
                value={map.filter?.col ?? ""}
                onChange={(e) => {
                  const c = e.target.value;
                  if (!c) return setMap({ ...map, filter: undefined });
                  const ci = headers.indexOf(c);
                  const vals = [...new Set(body.map((r) => cellText(r[ci])).filter(Boolean))];
                  setMap({ ...map, filter: { col: c, values: vals.filter((v) => DONE_WORDS.test(v)).length ? vals.filter((v) => DONE_WORDS.test(v)) : vals } });
                }}
              >
                <option value="">{t("— import every row —")}</option>
                {headers.map((h, i) => (h ? <option key={i} value={h}>{h}</option> : null))}
              </select>
              {map.filter &&
                filterValues.map((v) => (
                  <label key={v} className="flex items-center gap-1.5 rounded-lg border border-line px-2 py-1 text-sm">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-[var(--brand)]"
                      checked={map.filter!.values.includes(v)}
                      onChange={(e) =>
                        setMap({ ...map, filter: { col: map.filter!.col, values: e.target.checked ? [...map.filter!.values, v] : map.filter!.values.filter((x) => x !== v) } })
                      }
                    />
                    {v}
                    <span className="text-xs text-muted">{filterCounts.get(v) ?? 0}</span>
                  </label>
                ))}
            </div>
            {map.filter && <p className="hint">{t("Unticked values are left out, e.g. rejected or pending transactions.")}</p>}
          </div>

          {typeMode === "column" && typeValues.length > 0 && (
            <div>
              <div className="mb-2 text-sm font-medium">{t("What the values in “{col}” mean", { col: map.fields.type ?? "" })}</div>
              <div className="flex flex-wrap gap-2">
                {typeValues.map((v) => (
                  <label key={v} className="flex items-center gap-2 rounded-lg border border-line px-2.5 py-1.5 text-sm">
                    <span className="font-medium">{v}</span>
                    <span className="text-muted">→</span>
                    <select
                      className="rounded border border-line bg-surface px-1 py-0.5 text-sm"
                      value={map.typeValues[v] ?? guessType(v)}
                      onChange={(e) => setMap({ ...map, typeValues: { ...map.typeValues, [v]: e.target.value as "DEPOSIT" | "WITHDRAW" | "SKIP" } })}
                    >
                      <option value="DEPOSIT">{t("Deposit")}</option>
                      <option value="WITHDRAW">{t("Withdrawal")}</option>
                      <option value="SKIP">{t("Skip these rows")}</option>
                    </select>
                  </label>
                ))}
              </div>
            </div>
          )}

          <div>
            <div className="mb-2 text-sm font-medium">5. {t("Check the first rows")}</div>
            {missing.length > 0 ? (
              <div className="rounded-lg bg-warning-soft px-3 py-2 text-sm text-warning-ink">
                {t("Please choose a column for: {fields}.", { fields: missing.map((m) => t(m.label)).join(", ") })}
              </div>
            ) : (
              <>
                <div className="overflow-x-auto rounded-lg border border-line">
                  <table className="tbl">
                    <thead>
                      <tr>
                        {fields.map((f) => (
                          <th key={f.key}>{t(f.label)}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {parsed.rows.slice(0, 8).map((r, i) => (
                        <tr key={i}>
                          {fields.map((f) => (
                            <td key={f.key} className={f.parse === "amount" || f.parse === "int" ? "r" : ""}>
                              {f.key === "type" ? (r.type === "DEPOSIT" ? t("Deposit") : t("Withdrawal")) : r[f.key] == null ? <span className="text-muted">–</span> : f.parse === "time" ? String(r[f.key]).replace("T", " ") : String(r[f.key])}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="mt-2 flex flex-wrap gap-x-4 text-sm">
                  <span className="text-good-ink">✓ {t("{n} rows ready", { n: parsed.rows.length })}</span>
                  {parsed.skipped + parsed.filtered > 0 && <span className="text-ink-2">{t("{n} skipped on purpose", { n: parsed.skipped + parsed.filtered })}</span>}
                  {parsed.problems.length > 0 && (
                    <details className="text-critical-ink">
                      <summary className="cursor-pointer">{t("{n} rows have problems and will be left out", { n: parsed.problems.length })}</summary>
                      <ul className="mt-1 max-h-40 overflow-auto text-xs">
                        {parsed.problems.slice(0, 200).map((p) => (
                          <li key={p}>{p}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                </div>
              </>
            )}
          </div>

          <div className="flex flex-wrap items-end gap-3 border-t border-line pt-4">
            <label className="block">
              <span className="label">{t("Save this matching for next time (optional)")}</span>
              <input className="input w-72" placeholder={t("e.g. Platform X – deposits")} value={saveAs} onChange={(e) => setSaveAs(e.target.value)} />
            </label>
            <div className="ml-auto flex items-center gap-3">
              {busy && (
                <div className="w-48">
                  <div className="h-2 overflow-hidden rounded-full bg-surface-2">
                    <div className="h-full bg-brand transition-all" style={{ width: `${(busy.done / Math.max(busy.total, 1)) * 100}%` }} />
                  </div>
                  <div className="mt-1 text-xs text-ink-2">
                    {busy.done} / {busy.total}
                  </div>
                </div>
              )}
              <button type="button" className="btn" disabled={!!busy} onClick={() => (setMap(null), setSheets({}))}>
                {t("Cancel")}
              </button>
              <button type="button" className="btn btn-primary" disabled={!!busy || missing.length > 0 || parsed.rows.length === 0} onClick={run}>
                {busy ? t("Importing…") : t("Import {n} rows", { n: parsed.rows.length })}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ColumnSelect({ headers, value, onChange }: { headers: string[]; value?: string; onChange: (h: string) => void }) {
  const t = useT();
  return (
    <select className="input" value={value ?? ""} onChange={(e) => onChange(e.target.value)}>
      <option value="">{t("— not in this file —")}</option>
      {headers.map((h, i) => (h ? <option key={i} value={h}>{h}</option> : null))}
    </select>
  );
}
