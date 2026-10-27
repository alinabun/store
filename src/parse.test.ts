// deno test src/
import assert from "node:assert/strict";
import { parseMibSlip, parseSlip } from "./parse.ts";

// Roughly what Tesseract returns for a BML slip.
const SLIP = `Thank you. Transfer transaction is successful.
120.00
MVR
Status SUCCESS
Message Thank you. Transfer transaction is
successful.
Reference BLAZ974352781671
Transaction date 13/10/2026 17:57
From AROOSHA I.RASHEED
To ESHAN SHAFEEQ
7730000565406
Amount MVR 120.00
Bank of Maldives`;

Deno.test("clean slip", () => {
  assert.deepEqual(parseSlip(SLIP), {
    reference: "BLAZ974352781671", amount: "120.00", date: "2026-10-13 17:57", toAccount: "7730000565406",
  });
});

Deno.test("typical OCR mistakes in the reference", () => {
  assert.equal(parseSlip("Reference 8LAZ 9743 5278 l67I").reference, "BLAZ974352781671");
  assert.equal(parseSlip("Reference BLA2974352O81671").reference, "BLAZ974352081671");
});

Deno.test("amounts with thousands separators, and fallback without an Amount row", () => {
  assert.equal(parseSlip("Amount MVR 1,250.50").amount, "1250.50");
  assert.equal(parseSlip("Thank you\n120.00\nMVR").amount, "120.00");
});

Deno.test("nothing recognisable", () => {
  assert.deepEqual(parseSlip("a cat photo"), { reference: null, amount: null, date: null, toAccount: null });
  assert.equal(parseSlip("Reference BLAZ12345").reference, null); // too short
});

// The two MIB receipt layouts as Tesseract reads them (made-up sender, same shape as real receipts).
const MIB_REQUEST = `NM\n\nId#\n\nFrom\n\nTo\n\nBank\nCreated Date\n\nStatus Date\n\nES\n\n800000001\n\n90100000000000456\nMariyam Hassan\n\n7730000565406\nESHAN SHAFEEQ\n\nBML\n2026-10-27 10:38:37\n\n2026-10-27 10:38:37\n\n@) MALDIVES ISLAMIC BANK`;
const MIB_RECEIPT = `TRANSACTION RECEIPT\ni\n\nSUCCESSFUL\n\n>\n\nAisha N. Eshan Shafeeq\n\nTOTAL AMOUNT\n\n800000002\n7730000565406\n\nBank of Maldives PLC\nOct 27, 2026 at 12:32 PM\n\ncheck01\n\n(@) MALDIVES ISLAMIC BANK`;

Deno.test("MIB receipts", () => {
  assert.deepEqual(parseMibSlip(MIB_REQUEST), { sentAt: "2026-10-27T10:38:37", fromName: "Mariyam Hassan", fromAccount: "90100000000000456" });
  assert.deepEqual(parseMibSlip(MIB_RECEIPT), { sentAt: "2026-10-27T12:32", fromName: "Aisha N.", fromAccount: null });
  assert.equal(parseMibSlip(MIB_RECEIPT, "ESHAN SHAFEEQ")?.fromName, "Aisha N.", "receiver name in any case");
  assert.equal(parseMibSlip("Oct 27, 2026 at 12:05 AM islamic bank")?.sentAt, "2026-10-27T00:05");
  assert.equal(parseMibSlip(SLIP), null); // a BML slip
  assert.equal(parseSlip(MIB_RECEIPT).toAccount, "7730000565406");
});
