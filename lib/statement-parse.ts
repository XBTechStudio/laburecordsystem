// Reads one day of a PG / agent "Bill" statement page: its totals and every line.
// Plain functions with no app imports, so they can be tried out on a saved page.

export type LineKind = "IN" | "OUT";
export type StatementLine = { k: LineKind; t: string; name: string; amount: number };
export type ParsedStatement = {
  /** The day the page really shows. Pages fall back to their latest day when asked for one they don't have. */
  day: string | null;
  totalIn: number | null;
  shouldPay: number | null;
  totalOut: number | null;
  remaining: number | null;
  lines: StatementLine[];
};

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function text(html: string) {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
      e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITIES[e.toLowerCase()] ?? m),
    )
    .replace(/\s+/g, " ")
    .trim();
}

function num(html: string | undefined) {
  if (html == null) return null;
  const s = text(html).replace(/[^\d.-]/g, "");
  const x = Number(s);
  return s && Number.isFinite(x) ? x : null;
}

/** "0:05:39" or "00:05" → "00:05:39" / "00:05:00". */
function clock(s: string) {
  const [h, m, sec = "00"] = s.split(":");
  return `${h.padStart(2, "0")}:${m}:${sec}`;
}

export function parseStatement(html: string): ParsedStatement {
  const day = html.match(/<option[^>]*value="(\d{4}-\d{2}-\d{2})"[^>]*\bselected\b/i)?.[1] ?? null;
  const stats = new Map<string, string>();
  for (const m of html.matchAll(/<div[^>]*class="k"[^>]*>([\s\S]*?)<\/div>\s*<div[^>]*class="v"[^>]*>([\s\S]*?)<\/div>/gi)) stats.set(text(m[1]).toLowerCase(), m[2]);

  // Each list is a heading followed by a table: <h2>Deposit <span class="n">95</span></h2><table>…</table>
  const lines: StatementLine[] = [];
  for (const section of html.split(/<h2[^>]*>/i).slice(1)) {
    const title = text(section.split(/<span|<\/h2>/i)[0]).toLowerCase();
    const k: LineKind | null = /^(deposit|pay ?in|in\b|receive)/.test(title) ? "IN" : /^(pay|withdraw|out\b)/.test(title) ? "OUT" : null;
    if (!k) continue;
    const table = section.split(/<\/table>/i)[0];
    for (const row of table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => c[1]);
      if (cells.length < 3) continue;
      const t = text(cells[0]);
      const amount = num(cells[cells.length - 1]);
      if (!/^\d{1,2}:\d{2}(:\d{2})?$/.test(t) || amount == null) continue;
      lines.push({ k, t: clock(t), name: text(cells[1]), amount });
    }
  }

  return {
    day,
    totalIn: num(stats.get("total deposit")),
    shouldPay: num(stats.get("should be pay")),
    totalOut: num(stats.get("already pay")),
    remaining: num(stats.get("remaining")),
    lines,
  };
}
