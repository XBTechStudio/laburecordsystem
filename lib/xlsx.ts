import "server-only";

import * as XLSX from "xlsx";

/** Builds an .xlsx download from rows of plain values. Numbers stay numbers so Excel can sum them. */
export function xlsxResponse(filename: string, sheets: { name: string; rows: (string | number | null)[][]; widths?: number[] }[]) {
  const wb = XLSX.utils.book_new();
  for (const s of sheets) {
    const ws = XLSX.utils.aoa_to_sheet(s.rows);
    ws["!cols"] = (s.widths ?? s.rows[0]?.map(() => 16) ?? []).map((w) => ({ wch: w }));
    XLSX.utils.book_append_sheet(wb, ws, s.name.slice(0, 31));
  }
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename.replace(/[^\w.-]+/g, "_")}"`,
      "Cache-Control": "no-store",
    },
  });
}

export const round2 = (v: number) => Math.round(v * 100) / 100;
