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

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n: number | string) => String(n).padStart(2, "0");

export interface MibSlip { sentAt: string | null; fromName: string | null; fromAccount: string | null }

// OCR text of an MIB (other bank, via Favara) receipt → {sentAt, fromName, fromAccount}, or null if it isn't one.
// Copied from BMLPayments/testshop/parse.js (keep in sync). Two layouts: "Favara request transfer"
// (Created Date 2026-10-27 10:38:37, From <account> <name>) and "Transaction receipt" (Oct 27, 2026 at 12:39 PM,
// the sender's name next to the receiver's, no account). `receiver` is our account holder's name as printed.
export function parseMibSlip(text: unknown, receiver = "Eshan Shafeeq"): MibSlip | null {
  const t = String(text ?? "").replace(/\r/g, "");
  if (!/islamic\s*bank|favara/i.test(t)) return null;
  let sentAt: string | null = null;
  const iso = t.match(/(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}(?::\d{2})?)/);
  const us = t.match(/\b([A-Z][a-z]{2})[a-z]*\.?\s+(\d{1,2}),\s*(\d{4})\s+at\s+(\d{1,2}):(\d{2})\s*([AP]M)/i);
  if (iso) sentAt = `${iso[1]}T${iso[2]}`;
  else if (us && MONTHS[us[1].toLowerCase()]) {
    const h = (Number(us[4]) % 12) + (us[6].toUpperCase() === "PM" ? 12 : 0);
    sentAt = `${us[3]}-${pad(MONTHS[us[1].toLowerCase()])}-${pad(us[2])}T${pad(h)}:${us[5]}`;
  }
  // MIB accounts are 17 digits starting with 9; the receiver's BML account starts with 7.
  const fromAccount = t.match(/\b9\d{16}\b/)?.[0] ?? null;
  let fromName: string | null = null;
  if (fromAccount) fromName = t.slice(t.indexOf(fromAccount) + fromAccount.length).match(/^\s*([A-Za-z][A-Za-z .'-]+)/)?.[1].trim() ?? null;
  else {
    const esc = receiver.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // "Quick transfer": the transaction number, then the sender's line, then the receiver's.
    // Green receipt: sender and receiver on one line. Never a field label ("From", "To", …).
    fromName = [
      t.match(new RegExp(`^\\d{6,12}[ \\t]*\\n\\s*([A-Za-z][A-Za-z .'-]*?)[ \\t]*\\n\\s*${esc}[ \\t]*$`, "im"))?.[1],
      t.match(new RegExp(`^[ \\t]*([A-Za-z][A-Za-z .'-]*?)[ \\t]*(?:→|->|>)?[ \\t]*${esc}[ \\t]*$`, "im"))?.[1],
    ].map((n) => n?.trim()).find((n) => n && !/^(from|to|bank|remarks|transaction.*|status|success(ful)?)$/i.test(n)) ?? null;
  }
  return { sentAt, fromName, fromAccount };
}
