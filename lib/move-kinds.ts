// What each kind of account movement is called, and the extra line shown under it. No server imports.

import { tk, type T } from "@/lib/i18n";

export const MOVE_LABEL: Record<string, string> = {
  TRANSFER_IN: tk("Transfer in"),
  TRANSFER_OUT: tk("Transfer out"),
  TOPUP: tk("Money put in"),
  CASHOUT: tk("Money taken out"),
  FEE: tk("Bank / PG charge"),
  ADJUST: tk("Correction"),
  SETTLE_FEE: tk("Settlement fee"),
  EXCHANGE_OUT: tk("Sold to money changer"),
  EXCHANGE_IN: tk("Bought from money changer"),
  LEND_OUT: tk("Lent to operator"),
  LEND_BACK: tk("Operator paid back"),
  BORROW_IN: tk("Borrowed from operator"),
  BORROW_BACK: tk("Paid back to operator"),
};

/** Loan kinds: which way the money goes and whether it opens or settles the debt. */
export const LOAN_KINDS = ["LEND_OUT", "LEND_BACK", "BORROW_IN", "BORROW_BACK"] as const;
export type LoanKind = (typeof LOAN_KINDS)[number];
export const LOAN_SIGN: Record<LoanKind, 1 | -1> = { LEND_OUT: -1, LEND_BACK: 1, BORROW_IN: 1, BORROW_BACK: -1 };

const plain = new Intl.NumberFormat("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const rateFmt = new Intl.NumberFormat("en-MY", { maximumFractionDigits: 6 });

type MoveLike = { party: string | null; rate: { toString(): string } | null; otherAmount: { toString(): string } | null; otherCurrency: string | null; note: string | null };

/** "Ah Seng · 1,000.00 USDT @ 1.3" — who, and for exchanges what came back at which rate. */
export function moveDetail(m: MoveLike, currency: string, t: T) {
  const parts: string[] = [];
  if (m.party) parts.push(m.party);
  if (m.otherAmount != null && m.otherCurrency)
    parts.push(
      t("{amount} {cur} at {rate}", {
        amount: plain.format(Number(m.otherAmount.toString())),
        cur: m.otherCurrency,
        rate: m.rate != null ? `1 ${m.otherCurrency} = ${rateFmt.format(Number(m.rate.toString()))} ${currency}` : "–",
      }),
    );
  if (m.note) parts.push(m.note);
  return parts.join(" · ");
}
