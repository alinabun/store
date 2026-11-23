// Paying by bank transfer: the QR code and account, then the customer's screenshot (BML reference or MIB receipt).
// Shared by the order page (an order) and the account page (what a credit customer owes); `Payee` says which.
import { compressImage, readText, uploadTo } from "./image.ts";
import { $, copyBtn, html, mvr, raw, type Raw, render } from "./lib.ts";
import { type MibSlip, parseMibSlip, parseSlip, type Slip } from "./parse.ts";
import { qrPngUrl } from "./qr.ts";
import { track } from "./track.ts";

export interface Payee {
  id: string; // order ID or credit payment ID: the saved QR's file name
  amount: string; // what to pay, in `currency`
  currency: "MVR" | "USD";
  qr: string | null; // PayMV payload for the BML app
  bank: { bank: string; account_name: string; account_number: string } | null;
  what: string; // "your order", "what you owe": in the screenshot warnings
  uploadUrl: (contentType: string, size: number) => Promise<{ path: string; upload_url: string }>;
  /** Send the uploaded screenshot with its BML reference or MIB details. Throws with the server's message. */
  send: (pay: { path: string; reference?: string; mib?: Record<string, string> }) => Promise<void>;
  repaint: () => void;
}

// The slip being sent: uploaded path + what OCR read. Survives re-renders.
// bank: a BML slip has a BLAZ reference; an MIB receipt doesn't, so the customer confirms its time and sender instead.
export const slip: {
  path: string | null; preview: string | null; ocr: Slip | null; mib: MibSlip | null; bank: "bml" | "mib";
  reading: boolean; uploading: boolean; error: string | null;
} = { path: null, preview: null, ocr: null, mib: null, bank: "bml", reading: false, uploading: false, error: null };

/** Someone is choosing or sending a screenshot: don't repaint from a poll under them. */
export const busy = () => !!slip.path || slip.uploading;

const money = (p: Payee, amount: string | number) => p.currency === "USD" ? `USD ${Number(amount).toFixed(2)}` : mvr(amount);

export function payBlock(p: Payee): Raw {
  const b = p.bank!;
  const usd = p.currency === "USD";
  return html`
    <div class="card">
      <h2>How to pay</h2>
      <ol class="steps">
        <li>
          ${p.qr ? html`
            <p>Pay <b>${money(p, p.amount)}</b> with the BML app. This QR code fills in our ${usd ? html`<b>USD</b> ` : ""}account and the amount for you, so nothing can be mistyped.</p>
            <div class="paymv-pay">
              <img class="paymv" src="${qrPngUrl(p.qr)}" alt="QR code to pay ${money(p, p.amount)} to Alina Bun">
              <button type="button" class="secondary" id="save-qr" data-track="save_qr">Save QR code</button>
            </div>
            <ol class="qr-steps">
              <li>Tap <b>Save QR code</b> and save it to your photos. (Or press and hold the QR code and choose <b>Save to Photos</b>.)</li>
              <li>Open the <b>BML app</b> and tap the scan button in the middle at the bottom.
                <img src="/pay/bml-scan.jpg" alt="The BML app's bottom bar, with the scan button in the middle circled" width="460" height="90" loading="lazy"></li>
              <li>Tap <b>Upload</b> at the bottom right, and pick the QR code from your photos.
                <img src="/pay/bml-upload.jpg" alt="The BML app's scan screen, with Upload at the bottom right circled" width="460" height="110" loading="lazy"></li>
              <li>Check the amount is <b>${p.amount}</b>, then send.</li>
            </ol>
            <p class="hint">Paying from another phone? Just scan the QR code on this screen with its BML app.</p>
            <p style="margin-top:var(--space-4)"><b>Paying from MIB, or by hand?</b> Transfer ${money(p, p.amount)} to ${usd ? html`our <b>USD</b> account` : "this account"}:</p>`
          : html`<p>Transfer <b>${money(p, p.amount)}</b> to ${usd ? html`our <b>USD</b> account` : "this account"}:</p>`}
          <div class="kv"><span>Amount</span><b>${p.amount}</b>${copyBtn(p.amount, "Copy", "copy_amount")}</div>
          <div class="kv"><span>Bank</span><b>${b.bank}</b></div>
          <div class="kv"><span>Account name</span><b>${b.account_name}</b>${copyBtn(b.account_name, "Copy", "copy_name")}</div>
          <div class="kv"><span>Account number</span><b>${b.account_number}</b>${copyBtn(b.account_number, "Copy", "copy_account")}</div>
        </li>
        <li><p>Take a screenshot of the payment confirmation.</p></li>
        <li><p>${usd ? "Upload the screenshot here. Please pay in USD from a BML account: we check payments from other banks by hand, so they take longer."
          : "Upload the screenshot here. Paid from MIB? That works too."}</p>${uploadBlock(p)}</li>
      </ol>
    </div>`;
}

export function uploadBlock(p: Payee): Raw {
  const ocr = slip.ocr;
  const warnings: string[] = [];
  if (ocr?.currency && ocr.currency !== p.currency) {
    warnings.push(`Your screenshot seems to show a payment in ${ocr.currency}, but ${p.what} is paid in ${p.currency}${p.currency === "USD" ? " (to our USD account)" : ""}.`);
  } else if (ocr?.amount && Number(ocr.amount) !== Number(p.amount)) {
    warnings.push(`Your screenshot seems to show ${ocr.amount}, but ${p.what} is ${money(p, p.amount)}.`);
  }
  const ours = p.bank?.account_number;
  if (ocr?.toAccount && ours && ocr.toAccount !== ours) {
    warnings.push(`Your screenshot seems to show a different account (${ocr.toAccount}). Ours is ${ours}.`);
  }
  return html`
    <label class="upload">📷 ${slip.path ? "Choose a different screenshot" : "Upload screenshot"}
      <input type="file" id="file" accept="image/*">
    </label>
    ${slip.uploading ? html`<p class="muted small">Uploading…</p>` : ""}
    ${slip.error ? html`<div class="notice bad" style="margin-top:var(--space-3)">${slip.error}</div>` : ""}
    ${slip.path ? html`
      <div class="row" style="margin-top:var(--space-3);align-items:flex-start;flex-wrap:wrap">
        ${slip.preview ? html`<img class="slip-preview" src="${slip.preview}" alt="Your screenshot">` : ""}
        <div class="grow" style="min-width:min(100%, 230px)">
          ${slip.bank === "mib" ? mibFields() : html`
          <label for="ref" style="margin-top:0">Reference number</label>
          <input id="ref" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="BLAZ…"
            value="${ocr?.reference ?? (document.querySelector<HTMLInputElement>("#ref")?.value ?? "")}">
          <div class="hint">${slip.reading ? "Reading your screenshot…" : raw("On your screenshot, next to <b>Reference</b>. It starts with BLAZ.")}</div>`}
          <button type="button" class="copy" id="bank-switch" style="margin-top:var(--space-2)">${slip.bank === "mib" ? "Paid from BML instead?" : "Paid from MIB?"}</button>
        </div>
      </div>
      ${warnings.map((w) => html`<div class="notice warn small" style="margin-top:var(--space-3)">${w} You can still send it; we check every payment with the bank.</div>`)}
      <div id="send-err"></div>
      <button class="primary" id="send" style="margin-top:var(--space-4)">Send payment</button>` : ""}
  `;
}

/** MIB receipts have no BML reference: the bank is matched on when the money was sent and who sent it. */
function mibFields(): Raw {
  const m = slip.mib;
  return html`
    <p class="small" style="margin-top:0"><b>Paid from MIB.</b> Please check these match your receipt. We use them to find your payment.</p>
    <label for="mib-at" style="margin-top:0">Date and time on the receipt</label>
    <input id="mib-at" type="datetime-local" step="1" value="${m?.sentAt ?? ""}">
    <label for="mib-name">Sender's name, as on the receipt</label>
    <input id="mib-name" autocomplete="off" value="${m?.fromName ?? ""}" placeholder="e.g. Aisha N.">
    <label for="mib-acct">Sender's account <span class="muted">(if the receipt shows it)</span></label>
    <input id="mib-acct" inputmode="numeric" autocomplete="off" value="${m?.fromAccount ?? ""}" placeholder="9…">
    ${slip.reading ? html`<div class="hint">Reading your screenshot…</div>` : ""}`;
}

/** Hook up the pay and upload controls after each paint. */
export function wirePay(p: Payee) {
  // Keep what the customer types in the MIB fields across repaints.
  for (const [sel, key] of [["#mib-at", "sentAt"], ["#mib-name", "fromName"], ["#mib-acct", "fromAccount"]] as const) {
    const el = $<HTMLInputElement>(sel);
    if (el) el.oninput = () => (slip.mib = { sentAt: null, fromName: null, fromAccount: null, ...slip.mib, [key]: el.value || null });
  }
  const save = $<HTMLButtonElement>("#save-qr");
  if (save) save.onclick = () => saveQr($<HTMLImageElement>(".paymv-pay img").src, `alina-bun-${p.id}.png`);
  const sw = $<HTMLButtonElement>("#bank-switch");
  if (sw) sw.onclick = () => { slip.bank = slip.bank === "mib" ? "bml" : "mib"; p.repaint(); };
  const file = $<HTMLInputElement>("#file");
  if (file) file.onchange = () => file.files?.[0] && pick(p, file.files[0]);
  const send = $<HTMLButtonElement>("#send");
  if (send) send.onclick = () => submit(p);
}

/**
 * Save the QR picture where the BML app's Upload can find it. iPhones: the share sheet's "Save Image" puts it in
 * Photos (a download would go to Files). Elsewhere a download, which Android's photo picker shows.
 */
async function saveQr(png: string, name: string) {
  const file = new File([await (await fetch(png)).blob()], name, { type: "image/png" });
  if (/iPhone|iPad|iPod/.test(navigator.userAgent) && navigator.canShare?.({ files: [file] })) {
    try {
      return await navigator.share({ files: [file] });
    } catch (e) {
      if ((e as Error).name === "AbortError") return; // they closed the sheet
    }
  }
  Object.assign(document.createElement("a"), { href: png, download: name }).click();
}

async function pick(p: Payee, file: File) {
  if (!file.type.startsWith("image/")) {
    Object.assign(slip, { error: "Please choose a photo or screenshot." });
    return p.repaint();
  }
  if (slip.preview) URL.revokeObjectURL(slip.preview);
  Object.assign(slip, { path: null, ocr: null, mib: null, bank: "bml", error: null, uploading: true, reading: true, preview: URL.createObjectURL(file) });
  track("upload");
  p.repaint();
  const blob = await compressImage(file);
  // Upload and OCR run side by side; the customer can type the reference while OCR works.
  readText(blob).then((t) => {
    slip.ocr = parseSlip(t);
    // An MIB receipt: switch to its fields, unless the customer already typed something there.
    const mib = parseMibSlip(t, p.bank?.account_name);
    if (mib && !slip.ocr.reference) {
      slip.bank = "mib";
      slip.mib ??= mib;
    }
  }).catch(() => {}).finally(() => {
    slip.reading = false;
    // Don't overwrite what the customer has typed in the meantime.
    const typed = document.querySelector<HTMLInputElement>("#ref")?.value.trim();
    if (typed && slip.ocr) slip.ocr.reference = typed;
    p.repaint();
  });
  try {
    const type = blob.type || "image/jpeg";
    const { path, upload_url } = await p.uploadUrl(type, blob.size);
    await uploadTo(upload_url, blob.type ? blob : new Blob([blob], { type }));
    slip.path = path;
  } catch (e) {
    slip.error = (e as Error).message;
    track("blocked", { why: "upload", m: slip.error });
  }
  slip.uploading = false;
  p.repaint();
}

async function submit(p: Payee) {
  const err = (m: string, code?: number) => {
    track("blocked", { why: "pay", m, code });
    render($("#send-err"), html`<div class="notice bad" style="margin-top:var(--space-3)">${m}</div>`);
  };
  let pay: { reference?: string; mib?: Record<string, string> };
  if (slip.bank === "mib") {
    const at = $<HTMLInputElement>("#mib-at").value, name = $<HTMLInputElement>("#mib-name").value.trim();
    const acct = $<HTMLInputElement>("#mib-acct").value.replace(/\s+/g, "");
    if (!at) return err("Please enter the date and time on your receipt.");
    if (!name && !acct) return err("Please enter the sender's name as it shows on your receipt.");
    pay = { mib: { sent_at: at, ...(name ? { from_name: name } : {}), ...(acct ? { from_account: acct } : {}) } };
  } else {
    const reference = $<HTMLInputElement>("#ref").value.replace(/\s+/g, "").toUpperCase();
    if (!/^BLAZ\d{12}$/.test(reference)) return err("Please check the reference number. It starts with BLAZ followed by 12 numbers.");
    pay = { reference };
  }
  const btn = $<HTMLButtonElement>("#send");
  btn.disabled = true;
  btn.textContent = "Sending…";
  const bank = slip.bank;
  try {
    await p.send({ path: slip.path!, ...pay });
    track("send", { o: p.id, bank });
    Object.assign(slip, { path: null, ocr: null, mib: null, bank: "bml", preview: null, error: null });
    p.repaint();
    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch (e) {
    err((e as Error).message, (e as { status?: number }).status);
    btn.disabled = false;
    btn.textContent = "Send payment";
  }
}
