// "/order/?t=<status token>" — the customer's receipt and payment page.
import { compressImage, readText, uploadTo } from "./image.ts";
import { $, api, copyBtn, html, igLink, mvr, raw, type Raw, render } from "./lib.ts";
import { parseSlip, type Slip } from "./parse.ts";
import { qrPngUrl, qrSvg } from "./qr.ts";

interface View {
  public_id: string;
  status: "awaiting_payment" | "awaiting_bank" | "paid" | "delivered" | "cancelled" | "rejected";
  customer_name: string;
  phone: string;
  delivery_label: string;
  address: string | null;
  map_url: string | null;
  notes: string | null;
  items: { product_name: string; qty: number; unit_price: string }[];
  total_mvr: string;
  message: string | null;
  payment_reference: string | null;
  checking_by_hand: boolean;
  on_hold: boolean;
  bank: { bank: string; account_name: string; account_number: string } | null;
  qr: string | null;
  paid_amount: string | null;
  overpaid_mvr: string | null;
  fulfilment: "delivery" | "pickup";
  pickup_place: string | null;
  instagram: string;
  pay_by: string | null;    // unpaid orders are cancelled after this
  late_upload: boolean;     // cancelled for not paying in time; a slip can still be sent
}

const token = new URLSearchParams(location.search).get("t") ?? "";
const app = $("#app");
let view: View;
let poll: number | undefined;
let pollUntil = 0;

// The slip being sent: uploaded path + what OCR read. Survives re-renders.
const slip: { path: string | null; preview: string | null; ocr: Slip | null; reading: boolean; uploading: boolean; error: string | null } =
  { path: null, preview: null, ocr: null, reading: false, uploading: false, error: null };

async function load(quiet = false) {
  try {
    view = await api<View>(`/order-status?t=${encodeURIComponent(token)}`);
    paint();
  } catch (e) {
    if (!quiet) render(app, html`<div class="notice bad">${(e as Error).message}</div>`);
  }
}

function headline(v: View): Raw {
  switch (v.status) {
    case "awaiting_payment": return html`<div class="notice warn"><b>Waiting for your payment</b></div>`;
    case "awaiting_bank":
      return v.checking_by_hand
        ? html`<div class="notice warn"><b>We're checking your payment by hand.</b> We'll update this page soon. No need to pay again.</div>`
        : html`<div class="notice warn"><b>We're checking your payment with the bank.</b> This usually takes up to 5 minutes. This page updates by itself.</div>`;
    case "paid": return html`<div class="notice ok"><b>Paid, see you on ${v.delivery_label}!</b></div>`;
    case "delivered": return html`<div class="notice ok"><b>Delivered.</b> Enjoy your buns!</div>`;
    case "cancelled": return html`<div class="notice bad"><b>This order was cancelled.</b></div>`;
    case "rejected": return html`<div class="notice bad"><b>This order was not accepted.</b></div>`;
  }
}

function paint() {
  const v = view;
  const waiting = v.status === "awaiting_payment" || v.status === "awaiting_bank";
  render(app, html`
    <div class="card" style="text-align:center">
      <div class="muted small">Your order ID</div>
      <div class="order-id">${v.public_id}</div>
      ${copyBtn(v.public_id, "Copy order ID")}
      <p class="small muted" style="margin:var(--space-3) 0 0">Send us this order ID if you have any questions.</p>
    </div>

    ${headline(v)}
    ${v.message ? html`<div class="notice bad">${v.message}</div>` : ""}
    ${v.overpaid_mvr ? html`<div class="notice info">You sent ${mvr(v.paid_amount!)} and your order is ${mvr(v.total_mvr)}.
      We'll message you about the extra ${mvr(v.overpaid_mvr)}.</div>` : ""}

    ${v.pay_by ? html`<div class="notice warn small">Please pay by <b>${new Date(v.pay_by).toLocaleTimeString("en-GB", { timeZone: "Indian/Maldives", hour: "2-digit", minute: "2-digit" })}</b>.
      After that the order is cancelled and the buns go back on sale.</div>` : ""}
    ${v.status === "awaiting_payment" && !v.on_hold ? payBlock(v) : ""}
    ${v.late_upload ? html`<div class="card"><p><b>Already paid?</b> Upload the screenshot and we'll check it.</p>${uploadBlock(v)}</div>` : ""}
    ${v.on_hold ? html`
      <div class="card">
        <p><b>Please don't send the full amount again.</b> Message us first and we'll sort it out together.</p>
        <details><summary>Upload a different screenshot</summary>${uploadBlock(v)}</details>
      </div>` : ""}
    ${v.status === "awaiting_bank" ? html`
      <div class="card">
        <div class="kv"><span>Payment reference</span><b>${v.payment_reference}</b></div>
        <button class="secondary" id="check" style="width:100%;margin-top:var(--space-3)">Check again</button>
        <details style="margin-top:var(--space-4)"><summary>Uploaded the wrong screenshot?</summary>${uploadBlock(v)}</details>
      </div>` : ""}

    <div class="card">
      <h2>Your order</h2>
      <table class="items">
        ${v.items.map((i) => html`<tr><td>${i.qty} × ${i.product_name}</td><td>${mvr(Number(i.unit_price) * i.qty)}</td></tr>`)}
        <tr class="total"><td>Total</td><td>${mvr(v.total_mvr)}</td></tr>
      </table>
      <p style="margin-top:var(--space-4)"><b>${v.fulfilment === "pickup" ? "Pickup" : "Delivery"}:</b> ${v.delivery_label}<br>
        <b>${v.fulfilment === "pickup" ? "For" : "To"}:</b> ${v.customer_name}, ${v.phone}
        ${v.map_url ? html`<br><a href="${v.map_url}" target="_blank" rel="noopener">📍 Your delivery pin</a>` : ""}
        ${v.address ? html`<br>${v.address}` : ""}</p>
      ${v.pickup_place ? html`<div class="notice info small">${v.pickup_place}</div>` : ""}
      ${v.notes ? html`<p class="small muted">Notes: ${v.notes}</p>` : ""}
    </div>

    <div class="card small">
      <p><b>Bookmark this page</b> to check your order later.</p>
      ${copyBtn(location.href, "Copy link to this page")}
      <p style="margin:var(--space-4) 0 0">Questions${waiting ? " or want to cancel" : ""}? Message us on Instagram
        <a href="${igLink(v.instagram)}" target="_blank" rel="noopener">@${v.instagram}</a> with your order ID <b>${v.public_id}</b>.</p>
    </div>
  `);
  wire();
  if (v.status === "awaiting_bank" && !v.checking_by_hand) startPolling();
  else stopPolling();
}

function payBlock(v: View): Raw {
  const b = v.bank!;
  return html`
    <div class="card">
      <h2>How to pay</h2>
      <ol class="steps">
        <li>
          <p>Transfer <b>${mvr(v.total_mvr)}</b> to this account:</p>
          <div class="kv"><span>Amount</span><b>${v.total_mvr}</b>${copyBtn(v.total_mvr)}</div>
          <div class="kv"><span>Bank</span><b>${b.bank}</b></div>
          <div class="kv"><span>Account name</span><b>${b.account_name}</b>${copyBtn(b.account_name)}</div>
          <div class="kv"><span>Account number</span><b>${b.account_number}</b>${copyBtn(b.account_number)}</div>
          ${v.qr ? html`
            <div class="paymv-pay">
              <p style="margin:0"><b>Or scan this with the BML app.</b> The account and amount fill in by themselves.</p>
              <div class="paymv">${raw(qrSvg(v.qr))}</div>
              <a class="btn secondary-btn" href="${qrPngUrl(v.qr)}" download="alina-bun-${v.public_id}.png">Save QR code</a>
              <p class="hint">On this phone? Save it, then in the BML app choose to scan a QR code from your photos.</p>
            </div>` : ""}
        </li>
        <li><p>Take a screenshot of the payment confirmation.</p></li>
        <li><p>Upload the screenshot here.</p>${uploadBlock(v)}</li>
      </ol>
    </div>`;
}

function uploadBlock(v: View): Raw {
  const ocr = slip.ocr;
  const warnings: string[] = [];
  if (ocr?.amount && Number(ocr.amount) !== Number(v.total_mvr)) {
    warnings.push(`Your screenshot seems to show ${mvr(ocr.amount)}, but your order is ${mvr(v.total_mvr)}.`);
  }
  const ours = v.bank?.account_number;
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
      <div class="row" style="margin-top:var(--space-3)">
        ${slip.preview ? html`<img class="slip-preview" src="${slip.preview}" alt="Your screenshot">` : ""}
        <div class="grow">
          <label for="ref" style="margin-top:0">Reference number</label>
          <input id="ref" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="BLAZ…"
            value="${ocr?.reference ?? (document.querySelector<HTMLInputElement>("#ref")?.value ?? "")}">
          <div class="hint">${slip.reading ? "Reading your screenshot…" : raw("On your screenshot, next to <b>Reference</b>. It starts with BLAZ.")}</div>
        </div>
      </div>
      ${warnings.map((w) => html`<div class="notice warn small" style="margin-top:var(--space-3)">${w} You can still send it; we check every payment with the bank.</div>`)}
      <div id="send-err"></div>
      <button class="primary" id="send" style="margin-top:var(--space-4)">Send payment</button>` : ""}
  `;
}

function wire() {
  const file = $<HTMLInputElement>("#file");
  if (file) file.onchange = () => file.files?.[0] && pick(file.files[0]);
  const send = $<HTMLButtonElement>("#send");
  if (send) send.onclick = submit;
  const check = $<HTMLButtonElement>("#check");
  if (check) {
    check.onclick = async () => {
      check.disabled = true;
      check.textContent = "Checking…";
      try {
        view = await api<View>("/check-payment", { body: { t: token } });
        pollUntil = Date.now() + 10 * 60_000;
        paint();
      } catch (e) {
        check.disabled = false;
        check.textContent = (e as Error).message;
      }
    };
  }
}

async function pick(file: File) {
  if (!file.type.startsWith("image/")) {
    Object.assign(slip, { error: "Please choose a photo or screenshot." });
    return paint();
  }
  if (slip.preview) URL.revokeObjectURL(slip.preview);
  Object.assign(slip, { path: null, ocr: null, error: null, uploading: true, reading: true, preview: URL.createObjectURL(file) });
  paint();
  const blob = await compressImage(file);
  // Upload and OCR run side by side; the customer can type the reference while OCR works.
  readText(blob).then((t) => (slip.ocr = parseSlip(t))).catch(() => {}).finally(() => {
    slip.reading = false;
    // Don't overwrite what the customer has typed in the meantime.
    const typed = document.querySelector<HTMLInputElement>("#ref")?.value.trim();
    if (typed && slip.ocr) slip.ocr.reference = typed;
    paint();
  });
  try {
    const type = blob.type || "image/jpeg";
    const { path, upload_url } = await api<{ path: string; upload_url: string }>("/slip-upload-url", {
      body: { t: token, content_type: type, size: blob.size },
    });
    await uploadTo(upload_url, blob.type ? blob : new Blob([blob], { type }));
    slip.path = path;
  } catch (e) {
    slip.error = (e as Error).message;
  }
  slip.uploading = false;
  paint();
}

async function submit() {
  const reference = $<HTMLInputElement>("#ref").value.replace(/\s+/g, "").toUpperCase();
  const err = (m: string) => render($("#send-err"), html`<div class="notice bad" style="margin-top:var(--space-3)">${m}</div>`);
  if (!/^BLAZ\d{12}$/.test(reference)) return err("Please check the reference number. It starts with BLAZ followed by 12 numbers.");
  const btn = $<HTMLButtonElement>("#send");
  btn.disabled = true;
  btn.textContent = "Sending…";
  try {
    view = await api<View>("/submit-payment", { body: { t: token, path: slip.path, reference } });
    Object.assign(slip, { path: null, ocr: null, preview: null, error: null });
    pollUntil = Date.now() + 10 * 60_000;
    paint();
    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch (e) {
    err((e as Error).message);
    btn.disabled = false;
    btn.textContent = "Send payment";
  }
}

// While the bank sync runs (every ~5 min), re-read the order every 20 s for up to 10 minutes.
function startPolling() {
  if (!pollUntil) pollUntil = Date.now() + 10 * 60_000;
  if (poll || Date.now() > pollUntil) return;
  poll = setInterval(() => {
    if (Date.now() > pollUntil || document.hidden) return;
    // Don't repaint under someone choosing a new slip.
    if (!slip.path && !slip.uploading) load(true);
  }, 20_000);
}
function stopPolling() {
  clearInterval(poll);
  poll = undefined;
}

if (!token) render(app, html`<div class="notice bad">This link is missing its order code. Please open the link you got when you ordered.</div>`);
else load();
