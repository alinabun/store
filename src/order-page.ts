// "/order/?t=<status token>" — the customer's receipt and payment page.
import { $, api, copyBtn, loadError, html, igLink, mvr, raw, type Raw, rememberOrder, render, store } from "./lib.ts";
import { busy, payBlock, type Payee, uploadBlock, wirePay } from "./pay.ts";
import { notifyFor } from "./push.ts";
import { track } from "./track.ts";

interface View {
  public_id: string;
  status: "awaiting_payment" | "awaiting_bank" | "paid" | "delivered" | "cancelled" | "rejected";
  customer_name: string;
  phone: string;
  delivery_date: string;
  delivery_label: string;
  address: string | null;
  map_url: string | null;
  notes: string | null;
  items: { product_id: string; product_name: string; qty: number; unit_price: string; gift_no: number }[];
  total_mvr: string;
  currency: "MVR" | "USD";
  total_usd: string | null;  // USD orders: what the customer pays, into the USD account
  message: string | null;
  payment_reference: string | null;
  checking_by_hand: boolean;
  on_hold: boolean;
  cod?: boolean; // cash on delivery: no pay steps
  credit?: boolean; // on the account's credit: no pay steps, they pay what they owe later
  out_for_delivery?: boolean; // on its way (the Pack board's Out for delivery)
  tracker?: Tracker | null; // where it is, from when the bakery starts it (store rules.ts tracker)
  viber?: string | null; // viber:// link to the bakery
  bank: { bank: string; account_name: string; account_number: string } | null;
  qr: string | null;
  paid_amount: string | null;
  overpaid_mvr: string | null; // in the order's currency
  fulfilment: "delivery" | "pickup";
  time_label: string | null;
  bake?: string;
  bake_label?: string;
  pickup_place: string | null;
  pickup_phone: string | null;
  pickup_map_url: string | null;
  instagram: string;
  delivery_fee_mvr: string;
  boat: { name: string; time: string | null } | null;
  pay_by: string | null;    // unpaid orders are cancelled after this
  late_upload: boolean;     // cancelled for not paying in time; a slip can still be sent
  can_cancel: boolean;      // unpaid and no slip sent: the customer can change or cancel
}

interface Tracker {
  steps: string[]; step: number; starts_label: string | null;
  eta: { from: string; to: string; at: string } | null; late: boolean;
}

// The tracker's step icons (24×24, drawn with currentColor): receipt, a steaming bowl, a scooter or a bag, a tick.
const ICON: Record<string, string> = {
  placed: `<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6M9 16h3"/>`,
  preparing: `<path d="M3 12h18a9 9 0 0 1-18 0z"/><path d="M8 8c0-1.5 1-1.5 1-3M12 8c0-1.5 1-1.5 1-3M16 8c0-1.5 1-1.5 1-3"/>`,
  delivery: `<circle cx="5.5" cy="17.5" r="3.5"/><circle cx="18.5" cy="17.5" r="3.5"/><circle cx="15" cy="5" r="1"/><path d="M12 17.5V14l-3-3 4-3 2 3h2"/>`,
  pickup: `<path d="M5 8h14l-1 13H6z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>`,
  done: `<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>`,
};
const svg = (name: string) => raw(`<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`);
const IG_ICON = `<rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r=".8" fill="currentColor"/>`;
const VIBER_ICON = `<path d="M12 3c5 0 8 2.5 8 7.5S17 18 12 18c-.8 0-1.6-.1-2.3-.2L6 21v-3.8C4.4 15.9 4 14 4 10.5 4 5.5 7 3 12 3z"/><path d="M9.5 8.5c.3 2.3 1.7 3.7 4 4l1-1 1.5 1-.5 1.2c-3.3.2-6.4-2.9-6.2-6.2l1.2-.5 1 1.5z"/>`;

function trackerCard(v: View): Raw {
  const t = v.tracker!;
  const pickup = v.fulfilment === "pickup";
  const title = t.step === 4 ? (pickup ? "Picked up. Enjoy your buns!" : "Delivered. Enjoy your buns!")
    : t.starts_label ? `We'll start your order at ${t.starts_label}`
    : t.eta ? `Estimated delivery ${t.eta.from} to ${t.eta.to}`
    : t.late ? "Running a little late: it'll be on its way soon"
    : pickup && t.step === 3 ? "Your order is ready for pickup"
    : pickup ? `We're getting your order ready${v.time_label ? ` for ${v.time_label}` : ""}`
    : "We're working on your order";
  const sub = t.step === 4 ? "" : t.starts_label ? "We'll show the delivery time here then." : t.steps[t.step - 1];
  const icons = ["placed", "preparing", pickup ? "pickup" : "delivery", "done"];
  const contact = (href: string, label: string, icon: string, track: string) =>
    html`<a class="trk-btn" href="${href}" target="_blank" rel="noopener" aria-label="${label}" data-track="${track}">${raw(`<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icon}</svg>`)}</a>`;
  return html`
    <div class="trk" aria-live="polite">
      <div class="trk-head"><b>${title}</b>${sub ? html`<div>${sub}</div>` : ""}</div>
      <ol class="trk-steps">
        ${t.steps.map((label, i) => html`<li class="${i < t.step ? "on" : ""}${i === t.step - 1 && t.step < 4 ? " now" : ""}" title="${label}">
          ${svg(icons[i])}<span class="sr">${label}${i < t.step ? " (done)" : ""}</span></li>`)}
      </ol>
      <div class="trk-who">
        <img src="/favicon.svg" alt="" width="44" height="44">
        <div class="grow"><b>Alina Bun</b><div class="small">Message us</div></div>
        ${contact(igLink(v.instagram), "Message us on Instagram", IG_ICON, "contact_ig")}
        ${v.viber ? contact(v.viber, "Message us on Viber", VIBER_ICON, "contact_viber") : ""}
      </div>
    </div>`;
}

const token = new URLSearchParams(location.search).get("t") ?? "";
const app = $("#app");
let view: View;
let poll: number | undefined;
let pollUntil = 0;

/** This order, for the shared pay and upload steps (pay.ts). */
const payee = (): Payee => ({
  id: view.public_id, amount: due(view), currency: view.currency, qr: view.qr, bank: view.bank, what: "your order",
  uploadUrl: (content_type, size) => api("/slip-upload-url", { body: { t: token, content_type, size } }),
  send: async (pay) => {
    view = await api<View>("/submit-payment", { body: { t: token, ...pay } });
    pollUntil = Date.now() + 10 * 60_000;
  },
  repaint: paint,
});

async function load(quiet = false) {
  try {
    view = await api<View>(`/order-status?t=${encodeURIComponent(token)}`);
    rememberOrder(token, view.public_id);
    if (!quiet) track("order_view", { o: view.public_id, status: view.status });
    paint();
  } catch (e) {
    if (!quiet) track("order_view", { failed: (e as Error).message });
    if (!quiet) render(app, loadError(e));
  }
}

function headline(v: View): Raw {
  switch (v.status) {
    case "awaiting_payment":
      if (v.out_for_delivery) return html`<div class="notice ok"><b>🛵 Out for delivery!</b> Your buns are on their way.${v.cod ? html` Please have ${money(v, v.total_mvr)} in cash ready.` : ""}</div>`;
      if (v.credit) return html`<div class="notice ok"><b>Order placed on your account's credit.</b> See you on ${v.delivery_label}! You pay what you owe later.</div>`;
      return v.cod
        ? html`<div class="notice ok"><b>Order placed! 💵 Please have ${money(v, v.total_mvr)} in cash ready</b> when your buns ${v.fulfilment === "pickup" ? "are picked up" : "arrive"} on ${v.delivery_label}.</div>`
        : html`<div class="notice warn"><b>Waiting for your payment</b></div>`;
    case "awaiting_bank":
      return v.checking_by_hand
        ? html`<div class="notice warn"><b>We're checking your payment by hand.</b> We'll update this page soon. No need to pay again.</div>`
        : html`<div class="notice warn"><b>We're checking your payment with the bank.</b> This usually takes up to 5 minutes. This page updates by itself.</div>`;
    case "paid":
      if (v.out_for_delivery) return html`<div class="notice ok"><b>🛵 Out for delivery!</b> Your buns are on their way.</div>`;
      return v.credit ? html`<div class="notice ok"><b>On your account's credit.</b> See you on ${v.delivery_label}!</div>`
        : html`<div class="notice ok"><b>Paid, see you on ${v.delivery_label}!</b></div>`;
    case "delivered": return html`<div class="notice ok"><b>Delivered.</b> Enjoy your buns!</div>`;
    case "cancelled": return html`<div class="notice bad"><b>This order was cancelled.</b> <a href="/">Order again</a></div>`;
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

    ${v.tracker ? trackerCard(v) : headline(v)}
    ${v.tracker && v.cod && v.status === "awaiting_payment" ? html`<div class="notice warn"><b>💵 Please have ${money(v, v.total_mvr)} in cash ready.</b></div>` : ""}
    ${v.message ? html`<div class="notice bad">${v.message}</div>` : ""}
    ${v.overpaid_mvr ? html`<div class="notice info">You sent ${money(v, v.paid_amount!)} and your order is ${money(v, due(v))}.
      We'll message you about the extra ${money(v, v.overpaid_mvr)}.</div>` : ""}

    ${v.pay_by ? html`<div class="notice warn small">Please pay by <b>${new Date(v.pay_by).toLocaleTimeString("en-GB", { timeZone: "Indian/Maldives", hour: "2-digit", minute: "2-digit" })}</b>.
      After that the order is cancelled and the buns go back on sale.</div>` : ""}
    ${v.status === "awaiting_payment" && !v.on_hold && !v.cod && !v.credit ? payBlock(payee()) : ""}
    ${v.can_cancel ? html`
      <div class="card">
        <p style="margin-top:0"><b>Need to change something?</b> You can change or cancel this order ${v.cod || v.credit ? "before we bring it" : "until you send your payment"}.</p>
        <div class="row"><button class="secondary" id="change">Change order</button><button class="secondary" id="cancel">Cancel order</button></div>
        <div id="cancel-err"></div>
      </div>` : ""}
    ${v.late_upload ? html`<div class="card"><p><b>Already paid?</b> Upload the screenshot and we'll check it.</p>${uploadBlock(payee())}</div>` : ""}
    ${v.on_hold ? html`
      <div class="card">
        <p><b>Please don't send the full amount again.</b> Message us first and we'll sort it out together.</p>
        <details><summary>Upload a different screenshot</summary>${uploadBlock(payee())}</details>
      </div>` : ""}
    ${v.status === "awaiting_bank" ? html`
      <div class="card">
        <div class="kv"><span>Payment</span><b>${v.payment_reference}</b></div>
        <button class="secondary" id="check" style="width:100%;margin-top:var(--space-3)">Check again</button>
        <details style="margin-top:var(--space-4)"><summary>Uploaded the wrong screenshot?</summary>${uploadBlock(payee())}</details>
      </div>` : ""}

    <div class="card">
      <h2>Your order</h2>
      <table class="items">
        ${v.items.map((i) => html`<tr><td>${i.qty} × ${i.product_name}</td><td>${i.gift_no ? "🎁 Free" : mvr(Number(i.unit_price) * i.qty)}</td></tr>`)}
        ${Number(v.delivery_fee_mvr) > 0 ? html`<tr><td>Delivery</td><td>${mvr(v.delivery_fee_mvr)}</td></tr>` : ""}
        <tr class="total"><td>Total</td><td>${mvr(v.total_mvr)}</td></tr>
        ${v.currency === "USD" ? html`<tr class="total"><td>You pay in USD</td><td>USD ${v.total_usd}</td></tr>` : ""}
      </table>
      <p style="margin-top:var(--space-4)"><b>${v.fulfilment === "pickup" ? "Pickup" : "Delivery"}:</b> ${v.delivery_label}${v.time_label ? ` · ${v.time_label}` : ""}${v.bake_label ? ` · ${v.bake_label}` : ""}<br>
        <b>${v.fulfilment === "pickup" ? "For" : "To"}:</b> ${v.customer_name}, ${v.phone}
        ${v.boat ? html`<br>⛴ To the boat <b>${v.boat.name}</b>${v.boat.time ? ` at ${v.boat.time}` : ""}` : ""}
        ${v.map_url ? html`<br><a href="${v.map_url}" target="_blank" rel="noopener">📍 Your delivery pin</a>` : ""}
        ${v.address ? html`<br>${v.address}` : ""}</p>
      ${v.pickup_place || v.pickup_map_url || v.pickup_phone ? html`<div class="notice info small">${v.pickup_place ?? ""}
        ${v.pickup_map_url ? html`<br><a href="${v.pickup_map_url}" target="_blank" rel="noopener">📍 Open in Google Maps</a>` : ""}
        ${v.pickup_phone ? html`<br>Call us when you come: <a href="tel:${v.pickup_phone}">${v.pickup_phone}</a>` : ""}</div>` : ""}
      ${v.notes ? html`<p class="small muted">Notes: ${v.notes}</p>` : ""}
    </div>

    <div class="card small">
      <p><b>Bookmark this page</b> to check your order later. It's also saved on this phone: open store.alinabun.com to find it again.</p>
      ${copyBtn(location.href, "Copy link to this page")}
      <p style="margin:var(--space-4) 0 0">Questions${waiting && !v.can_cancel ? " or want to cancel" : ""}? Message us on Instagram
        <a href="${igLink(v.instagram)}" target="_blank" rel="noopener">@${v.instagram}</a> with your order ID <b>${v.public_id}</b>.</p>
    </div>
  `);
  wire();
  if (v.status === "awaiting_bank" && !v.checking_by_hand) startPolling();
  else if (v.tracker && v.tracker.step < 4) startPolling(30_000, true); // follow the tracker while it moves
  else stopPolling();
}

/** What the customer pays, in the order's currency. */
const due = (v: View) => v.currency === "USD" ? v.total_usd! : v.total_mvr;
const money = (v: View, amount: string | number) => v.currency === "USD" ? `USD ${Number(amount).toFixed(2)}` : mvr(amount);

function wire() {
  wirePay(payee());
  const cancel = $<HTMLButtonElement>("#cancel"), change = $<HTMLButtonElement>("#change");
  if (cancel) cancel.onclick = () => cancelOrder(false);
  if (change) change.onclick = () => cancelOrder(true);
  const check = $<HTMLButtonElement>("#check");
  if (check) {
    check.onclick = async () => {
      check.disabled = true;
      check.textContent = "Checking…";
      track("check");
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

/** Cancel; for "change", the order form opens with the same buns, day and details filled in. */
async function cancelOrder(change: boolean) {
  const v = view;
  if (!confirm(change
    ? `Change your order? We'll cancel ${v.public_id} and take you back to the order form with your choices filled in.`
    : `Cancel order ${v.public_id}? Your buns go back on sale.`)) return;
  for (const b of ["#cancel", "#change"]) $<HTMLButtonElement>(b).disabled = true;
  try {
    view = await api<View>("/cancel-order", { body: { t: token } });
    track("cancel", { o: v.public_id, change });
    if (change) {
      store("alinabun.change", { date: v.delivery_date, items: v.items.filter((i) => !i.gift_no).map((i) => ({ product_id: i.product_id, qty: i.qty })), fulfilment: v.fulfilment, notes: v.notes, currency: v.currency, bake: v.bake });
      location.href = "/";
      return;
    }
    paint();
    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch (e) {
    render($("#cancel-err"), html`<div class="notice bad" style="margin-top:var(--space-3)">${(e as Error).message}</div>`);
    for (const b of ["#cancel", "#change"]) $<HTMLButtonElement>(b).disabled = false;
  }
}

// While the bank sync runs (every ~5 min), re-read the order every 20 s for up to 10 minutes.
function startPolling(every = 20_000, always = false) {
  if (!pollUntil) pollUntil = Date.now() + 10 * 60_000;
  if (poll || (!always && Date.now() > pollUntil)) return;
  poll = setInterval(() => {
    if ((!always && Date.now() > pollUntil) || document.hidden) return;
    // Don't repaint under someone choosing a new slip.
    if (!busy()) load(true);
  }, every);
}
function stopPolling() {
  clearInterval(poll);
  poll = undefined;
}

if (!token) render(app, html`<div class="notice bad">This link is missing its order code. Please open the link you got when you ordered.</div>`);
else load(), notifyFor({ t: token });
