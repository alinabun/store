// deno test src/
import assert from "node:assert/strict";
import { parseSlip } from "./parse.ts";

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
