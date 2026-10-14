// OCR text of a BML transfer slip → fields to pre-fill the form. Nothing here is trusted:
// the ledger decides by matching the reference and the ORDER amount against bank records.
// Copied from BMLPayments/testshop/parse.js (keep in sync).

// Letters OCR commonly reads in place of digits.
const DIGITISH: Record<string, string> = {
  O: "0", o: "0", D: "0", Q: "0", I: "1", l: "1", i: "1", "|": "1", S: "5", s: "5", B: "8", Z: "2", z: "2", G: "6", g: "9",
};

export interface Slip { reference: string | null; amount: string | null; date: string | null; toAccount: string | null }

export function parseSlip(text: unknown): Slip {
  const t = String(text ?? "").replace(/\r/g, "");

  // "BLAZ" (sometimes read as 8LAZ / BLA2) + 12 digits, possibly split by spaces or misread.
  let reference = null;
  const ref = t.match(/[B8]\s*L\s*A\s*[Z2]\s*([0-9OoDQIli|SsBZzGg ]{12,24})/);
  if (ref) {
    const digits = [...ref[1].replace(/\s+/g, "")].map((c) => DIGITISH[c] ?? c).join("").slice(0, 12);
    if (/^\d{12}$/.test(digits)) reference = "BLAZ" + digits;
  }

  // The "Amount  MVR 120.00" row; fall back to the big number above "MVR".
  const money = /(\d{1,3}(?:,\d{3})+|\d+)[.,](\d{2})\b/;
  const amountLine = t.split("\n").find((l) => /amount/i.test(l) && money.test(l));
  const am = (amountLine ?? t).match(money);
  const amount = am ? `${am[1].replace(/,/g, "")}.${am[2]}` : null;

  const dm = t.match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})/);
  const date = dm ? `${dm[3]}-${dm[2]}-${dm[1]} ${dm[4]}:${dm[5]}` : null;

  // BML account numbers are 13 digits starting with 7; the one after "To" is the receiver.
  const toPart = t.slice(Math.max(0, t.search(/\bTo\b/)));
  const toAccount = toPart.match(/\b7\d{12}\b/)?.[0] ?? null;

  return { reference, amount, date, toAccount };
}
