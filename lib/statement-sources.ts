// Statement pages that load their data from an API instead of showing it in the HTML.
// Each reader turns one day of that API into the same ParsedStatement the HTML "Bill" pages give.
import type { ParsedStatement, StatementLine } from "@/lib/statement-parse";

const SGT = 8 * 3600_000;
const round = (x: number) => Math.round(x * 100) / 100;
const sum = (lines: StatementLine[], k: "IN" | "OUT") => round(lines.filter((l) => l.k === k).reduce((a, l) => a + l.amount, 0));
/** Day start (Singapore time) as a UTC Date. */
const dayStartUtc = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) - SGT);
/** "HH:MM:SS" in Singapore time, and the Singapore day it falls on. */
const sgt = (iso: string) => {
  const s = new Date(Date.parse(iso) + SGT).toISOString();
  return { day: s.slice(0, 10), t: s.slice(11, 19) };
};

/** Which API a statement link reads from, or null for an HTML "Bill" page. */
export function apiSource(url: string): "paybox" | "mimipay" | null {
  const u = new URL(url);
  if (/(^|\.)testhub199\.com$/i.test(u.hostname) && /\/merchant-summary\/[0-9a-f]+/i.test(u.pathname)) return "paybox";
  if (/^jzusdt\.github\.io$/i.test(u.hostname) && u.pathname.startsWith("/botWeb") && u.searchParams.get("id")) return "mimipay";
  return null;
}

async function getJson(url: string): Promise<unknown> {
  const r = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 (statement reader)" }, cache: "no-store", signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

type PayBox = {
  success?: boolean;
  payIn?: { data?: { transactionTime?: string; createdAt: string; amount: string; senderAccountName?: string; status?: string }[] };
  payOut?: { data?: { transactionTime?: string; createdAt: string; amount: string; receiverAccountName?: string; accountName?: string; status?: string }[] };
  balance?: string;
};

/** PayBox merchant summary: deposits (with the sender's name) and pay-outs for the day. */
export async function readPayBox(url: string, day: string, today: string): Promise<ParsedStatement> {
  const id = new URL(url).pathname.match(/\/merchant-summary\/([0-9a-f]+)/i)![1];
  const from = dayStartUtc(day);
  const to = new Date(from.getTime() + 86_400_000);
  const q = new URLSearchParams({ page: "1", pageSize: "5000", withdrawalPage: "1", withdrawalPageSize: "5000", createdAtFrom: from.toISOString(), createdAtTo: to.toISOString() });
  const d = (await getJson(`https://api-aibot.testhub199.com/api/merchant-summary/${id}?${q}`)) as PayBox;
  if (!d || d.success === false || !d.payIn) throw new Error("not a PayBox summary");
  // The transfer's own time, unless it falls on another day; then when PayBox recorded it.
  const time = (x: { transactionTime?: string; createdAt: string }) => {
    const a = x.transactionTime ? sgt(x.transactionTime) : null;
    return a && a.day === day ? a.t : sgt(x.createdAt).t;
  };
  const lines: StatementLine[] = [
    ...(d.payIn.data ?? []).filter((x) => !x.status || x.status === "credited").map((x) => ({ k: "IN" as const, t: time(x), name: x.senderAccountName ?? "", amount: Number(x.amount) })),
    ...(d.payOut?.data ?? []).map((x) => ({ k: "OUT" as const, t: time(x), name: x.receiverAccountName ?? x.accountName ?? "", amount: Number(x.amount) })),
  ].filter((l) => Number.isFinite(l.amount) && l.amount > 0);
  lines.sort((a, b) => a.t.localeCompare(b.t));
  return { day, totalIn: sum(lines, "IN"), shouldPay: null, totalOut: sum(lines, "OUT"), remaining: day === today && d.balance != null ? Number(d.balance) : null, lines };
}

type MimiBill = { startTime?: string; notOutBase?: number | string; bills?: { type: string; baseAmount: number; remark?: string; time: string }[] };

const b64url = (s: string) => Buffer.from(s).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

/** MiMiPay's Telegram bookkeeping bill: one bill per day; money in is positive, money paid out is negative. */
export async function readMimiPay(url: string, day: string): Promise<ParsedStatement | null> {
  const group = new URL(url).searchParams.get("id")!;
  const q = new URLSearchParams({ id: b64url(day), groupId: group, checkbox: "0", timestart: "0", timeend: `${day} 23:59` });
  let d: MimiBill | null = null;
  for (const host of ["bot.letsvpn.bet", "api.letsvpn.bet"]) {
    try {
      d = (await getJson(`https://${host}/botWeb/bill/?${q}`)) as MimiBill;
      if (d && typeof d === "object" && Array.isArray(d.bills)) break;
    } catch {
      d = null;
    }
  }
  if (!d || !Array.isArray(d.bills)) throw new Error("not a MiMiPay bill");
  // A day with no bill comes back as some other bill.
  if (d.startTime !== day) return null;
  const lines: StatementLine[] = d.bills
    .filter((b) => Number.isFinite(b.baseAmount) && b.baseAmount !== 0 && /\d{1,2}:\d{2}:\d{2}$/.test(b.time))
    .map((b) => ({ k: b.baseAmount > 0 ? ("IN" as const) : ("OUT" as const), t: b.time.slice(-8), name: b.remark ?? "", amount: round(Math.abs(b.baseAmount)) }));
  lines.sort((a, b) => a.t.localeCompare(b.t));
  const left = Number(d.notOutBase);
  return { day, totalIn: sum(lines, "IN"), shouldPay: null, totalOut: sum(lines, "OUT"), remaining: Number.isFinite(left) ? round(left) : null, lines };
}
