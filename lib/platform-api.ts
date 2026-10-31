import "server-only";

// Client for the brands' gaming platform "Wallet External API" (one POST endpoint, `module` picks the call).
// Every call is read-only; the platform only answers our server's IP, which the brand adds to its whitelist.

export type Creds = { apiUrl: string; merchantId: string; accessId: string; token: string };

export class PlatformError extends Error {}

export type PlatformUser = {
  id: string;
  username?: string;
  originalName?: string;
  name?: string;
  mobile?: string;
  createdDateTime?: string;
  referrerId?: string | null;
};

export type PlatformTxn = {
  id: string;
  type: string;
  status: string;
  cash: string;
  details: string;
  createdDateTime: string;
  processedDateTime?: string | null;
  endDateTime?: string | null;
  bankId: string | null;
  user?: PlatformUser;
  promotion?: { id: string; name: string };
};

export type PlatformBank = { id: string; code: string; name: string; description: string | null; accountName: string; accountNumber: string; status: string; currency: string };

/** Turns the platform's terse refusals into something staff can act on. */
function explain(msg: string) {
  if (/Invalid Access IP/i.test(msg)) return `The platform refused our server's IP (${msg.match(/\[(.*?)\]/)?.[1] ?? "?"}). Add that IP to the IP whitelist on the platform's Manage API page.`;
  if (/Invalid Access/i.test(msg)) return "The platform did not accept the Access ID / token / merchant ID, or this call isn't enabled for the key.";
  return msg;
}

export async function call<T>(c: Creds, module: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
  const body = new URLSearchParams({ module, merchantId: c.merchantId, accessId: c.accessId, accessToken: c.token });
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") body.set(k, String(v));
  let res: Response;
  try {
    res = await fetch(c.apiUrl, { method: "POST", body, signal: AbortSignal.timeout(30_000), cache: "no-store" });
  } catch (e) {
    throw new PlatformError(`Could not reach the platform: ${(e as Error).message}`);
  }
  const text = await res.text();
  let j: { status?: string; data?: unknown };
  try {
    j = JSON.parse(text);
  } catch {
    throw new PlatformError(`The platform answered ${res.status} with something that isn't JSON: ${text.slice(0, 120)}`);
  }
  if (j.status !== "SUCCESS") throw new PlatformError(explain((j.data as { message?: string })?.message ?? `status ${j.status}`));
  return j.data as T;
}

export const getBanks = (c: Creds) => call<PlatformBank[]>(c, "/banks/getBank");

export const getTransactions = (c: Creds, p: { sDate: string; eDate: string; pageIndex: number; type?: string }) =>
  call<{ transactions: PlatformTxn[]; totalCount: number; totalPage: number }>(c, "/transactions/getAllTransactions", { status: "COMPLETED", ...p });

export const getUsers = (c: Creds, p: { pageIndex?: number; id?: string; sortBy?: string; sortType?: string }) =>
  call<{ users: PlatformUser[]; totalPage?: number }>(c, "/users/getAllUsers", p);

/** { "<platform user id>": { total: { bet, winlose }, "<site>": { bet, winlose } } } */
export const getDailyBets = (c: Creds, date: string) => call<Record<string, Record<string, { bet: number | string; winlose: number | string }>> | []>(c, "/reports/dailyBetTotal", { date });

/** "YYYY-MM-DD HH:MM:SS" as the platform's clock shows it (its date filters use its own time zone). */
export function platformTime(d: Date, tz: string) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

export const platformDay = (d: Date, tz: string) => platformTime(d, tz).slice(0, 10);

/** "T10140 Youssef saadat✅" → { code: "T10140", name: "Youssef saadat" }; the platform keeps the member code as the first word. */
export function splitName(u: PlatformUser) {
  const full = (u.originalName ?? u.name ?? "").replace(/\s*\(.*?\)\s*$/, "").replace(/[\p{So}\p{Sk}️]/gu, "").trim();
  const [code, ...rest] = full.split(/\s+/);
  return { code: code || u.username || u.id, name: rest.join(" ") || null };
}

/** The referrer the platform shows in brackets after the name: "T10140 Youssef (top1facebookads)". */
export const referrerOf = (u: PlatformUser) => u.name?.match(/\(([^()]+)\)\s*$/)?.[1]?.slice(0, 80) ?? null;

/** Promotion names come with HTML in them: "<b>DAILY LUCKY BOX FREE</b>". */
export const plainText = (s: string) =>
  s
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
