// "/admin/" — managers. Supabase Auth email + password (no sign-up); every call carries the JWT
// and the store function checks it against store.managers.
import { uploadTo } from "./image.ts";
import { $, api, copyBtn, html, mvr, raw, type Raw, render, store } from "./lib.ts";
import { qrSvg } from "./qr.ts";

const AUTH_URL = `${import.meta.env.VITE_SUPABASE_URL}/auth/v1`;
const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const SESSION_KEY = "alinabun.admin.session";
const STATUSES = ["awaiting_payment", "awaiting_bank", "paid", "delivered", "cancelled", "rejected"];
const ACTION_LABELS: Record<string, string> = {
  mark_paid_manual: "Mark paid (manual)", retry_claim: "Check bank again", mark_delivered: "Mark delivered",
  cancel: "Cancel order", reject_order: "Reject order", clear_review: "Clear review flag",
};

interface Session { access_token: string; refresh_token: string; expires_at: number }
const app = $("#app");
let session = store<Session>(SESSION_KEY);

// ── Auth ──

async function auth(grant: "password" | "refresh_token", body: unknown): Promise<Session> {
  const res = await fetch(`${AUTH_URL}/token?grant_type=${grant}`, {
    method: "POST", headers: { apikey: ANON_KEY, "content-type": "application/json" }, body: JSON.stringify(body),
  }).catch(() => null);
  const json = await res?.json().catch(() => null);
  if (!res?.ok || !json?.access_token) throw new Error(json?.error_description ?? json?.msg ?? "Wrong email or password.");
  return { access_token: json.access_token, refresh_token: json.refresh_token, expires_at: json.expires_at };
}

async function token(): Promise<string> {
  if (!session) throw new Error("Signed out");
  if (session.expires_at - 60 < Date.now() / 1000) {
    try {
      session = await auth("refresh_token", { refresh_token: session.refresh_token });
      store(SESSION_KEY, session);
    } catch {
      signOut();
      throw new Error("Please sign in again.");
    }
  }
  return session.access_token;
}

// deno-lint-ignore no-explicit-any
async function call<T = any>(path: string, body?: unknown): Promise<T> {
  try {
    return await api<T>(path, { body, token: await token() });
  } catch (e) {
    if ((e as { status?: number }).status === 403) {
      signOut("This account is not a manager.");
    }
    throw e;
  }
}

function signOut(msg = "") {
  session = null;
  store(SESSION_KEY, null);
  showLogin(msg);
}

function showLogin(msg = "") {
  render(app, html`
    <form class="card" id="login" style="max-width:380px">
      <h1>Sign in</h1>
      ${msg ? html`<div class="notice bad">${msg}</div>` : ""}
      <label for="email">Email</label><input id="email" type="email" autocomplete="username" required>
      <label for="pw">Password</label><input id="pw" type="password" autocomplete="current-password" required>
      <button class="primary" style="margin-top:var(--space-4)">Sign in</button>
    </form>`);
  $<HTMLFormElement>("#login").onsubmit = async (e) => {
    e.preventDefault();
    try {
      session = await auth("password", { email: $<HTMLInputElement>("#email").value.trim(), password: $<HTMLInputElement>("#pw").value });
      store(SESSION_KEY, session);
      route();
    } catch (err) {
      showLogin((err as Error).message);
    }
  };
}

// ── Shell ──

const params = () => new URLSearchParams(location.search);
function go(q: Record<string, string>) {
  history.pushState(null, "", `?${new URLSearchParams(Object.entries(q).filter(([, v]) => v))}`);
  route();
}
addEventListener("popstate", () => route());

function shell(tab: string, body: Raw) {
  render(app, html`
    <nav class="tabs">
      ${[["orders", "Orders"], ["sales", "Sales"], ["production", "Production"], ["days", "Days"], ["invoices", "Invoices"], ["customers", "Customers"], ["products", "Products"]].map(([k, l]) =>
        html`<button class="${tab === k ? "on" : ""}" data-tab="${k}">${l}</button>`)}
      <button class="secondary" id="out" style="margin-left:auto">Sign out</button>
    </nav>
    <div id="view">${body}</div>`);
  app.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((b) => (b.onclick = () => go({ tab: b.dataset.tab! })));
  $("#out").onclick = () => signOut();
}

async function route() {
  if (!session) return showLogin();
  const p = params();
  try {
    if (p.get("order")) return await orderDetail(p.get("order")!);
    if (p.get("invoice")) return await invoiceView(p.get("invoice")!);
    switch (p.get("tab")) {
      case "sales": return await sales(p.get("date") ?? "");
      case "production": return await production(p.get("date") ?? "");
      case "days": return await days();
      case "invoices": return p.get("new") ? await newInvoice() : await invoices();
      case "customers": return await customers(p.get("sort") ?? "buns");
      case "products": return await products();
      default: return p.get("new") ? await newOrder() : await orders(p);
    }
  } catch (e) {
    if (session) shell(p.get("tab") ?? "orders", html`<div class="notice bad">${(e as Error).message}</div>`);
  }
}

const chip = (s: string) => html`<span class="chip ${s}">${s.replace(/_/g, " ")}</span>`;
const when = (t: string | null) => t ? new Date(t).toLocaleString("en-GB", { timeZone: "Indian/Maldives", dateStyle: "medium", timeStyle: "short" }) : "";
const tomorrow = () => new Date(Date.now() + (5 + 24) * 3600_000).toISOString().slice(0, 10);

// ── Orders ──

async function orders(p: URLSearchParams) {
  const page = Number(p.get("page") ?? 0);
  const q = new URLSearchParams({ status: p.get("status") ?? "", date: p.get("date") ?? "", q: p.get("q") ?? "", review: p.get("review") ?? "", page: String(page) });
  const r = await call(`/admin/orders?${q}`);
  shell("orders", html`
    <div class="row between" style="margin-bottom:var(--space-4)">
      <p class="muted" style="margin:0">Taking an order on Instagram or the phone, or giving buns away? Enter it here so the buns are held.</p>
      <button id="new-order">New order</button>
    </div>
    <form class="filters" id="filters">
      <label>Search<input name="q" placeholder="AB-7K4Q or phone" value="${p.get("q") ?? ""}"></label>
      <label>Status<select name="status"><option value="">All</option>
        ${STATUSES.map((s) => html`<option value="${s}" ${p.get("status") === s ? "selected" : ""}>${s.replace(/_/g, " ")}</option>`)}</select></label>
      <label>Delivery date<input type="date" name="date" value="${p.get("date") ?? ""}"></label>
      <label class="row"><input type="checkbox" name="review" value="1" style="width:auto" ${p.get("review") ? "checked" : ""}> Needs review</label>
      <button>Filter</button>
    </form>
    <div class="scroll"><table class="list">
      <tr><th>Order</th><th>Customer</th><th>Delivery</th><th>Total</th><th>Status</th></tr>
      ${r.orders.map((o: Record<string, string>) => html`
        <tr data-id="${o.public_id}">
          <td><b>${o.public_id}</b><div class="small muted">${when(o.created_at)}</div></td>
          <td>${o.customer_name}<div class="small muted">${o.phone}</div></td>
          <td>${o.delivery_date}</td>
          <td>${mvr(o.total_mvr)}<div class="small muted">${o.total_buns} buns</div></td>
          <td>${chip(o.status)} ${o.fulfilment === "pickup" ? html`<span class="chip">pickup</span>` : ""} ${o.entered_by ? html`<span class="chip">by us</span>` : ""} ${o.needs_review ? html`<span class="chip review">review</span>` : ""} ${String(o.on_telegram) === "false" ? html`<span class="chip review">not on Telegram</span>` : ""}</td>
        </tr>`)}
    </table></div>
    ${r.orders.length ? "" : html`<p class="muted">No orders.</p>`}
    <div class="row" style="margin-top:var(--space-4)">
      ${page > 0 ? html`<button class="secondary" id="prev">← Newer</button>` : ""}
      ${r.has_more ? html`<button class="secondary" id="next">Older →</button>` : ""}
    </div>`);
  const filters = Object.fromEntries(["q", "status", "date", "review"].map((k) => [k, p.get(k) ?? ""]));
  $<HTMLFormElement>("#filters").onsubmit = (e) => {
    e.preventDefault();
    const f = new FormData(e.target as HTMLFormElement);
    go({ tab: "orders", q: String(f.get("q") ?? ""), status: String(f.get("status") ?? ""), date: String(f.get("date") ?? ""), review: String(f.get("review") ?? "") });
  };
  $("#new-order").onclick = () => go({ tab: "orders", new: "1" });
  app.querySelectorAll<HTMLElement>("tr[data-id]").forEach((tr) => (tr.onclick = () => go({ order: tr.dataset.id! })));
  $("#prev")?.addEventListener("click", () => go({ ...filters, page: String(page - 1) }));
  $("#next")?.addEventListener("click", () => go({ ...filters, page: String(page + 1) }));
}

/** An order taken by a manager (DM, phone, in person) or a giveaway. It holds buns like a customer order but never expires. */
async function newOrder() {
  type Day = { date: string; label: string; kind: string; available: boolean; closed: boolean; products: Record<string, number> };
  const [{ products }, dd] = await Promise.all([api("/catalog"), api("/delivery-dates")]);
  const days = (dd.dates as Day[]).filter((d) => d.available);
  shell("orders", html`
    <button class="secondary" id="back">← Orders</button>
    <form class="card" id="no" style="margin-top:var(--space-4)">
      <h1>New order</h1>
      <div class="filters">
        <label>Customer's name<input name="name" required maxlength="80"></label>
        <label>Phone<input name="phone" type="tel" required placeholder="7xx xxxx"></label>
        <label>Day<select name="delivery_date">${days.map((d) => html`<option value="${d.date}">${d.label}${d.kind === "extras" ? " (extras)" : ""}</option>`)}</select></label>
      </div>
      <div class="scroll"><table class="list" style="margin-top:var(--space-4)">
        <tr><th>Bun</th><th>Price</th><th>Left</th><th>How many</th></tr>
        ${(products as { id: string; name: string; price_mvr: string }[]).map((p) => html`<tr data-p="${p.id}"><td>${p.name}</td><td>${mvr(p.price_mvr)}</td>
          <td class="left muted"></td><td><input name="qty" type="number" min="0" max="50" step="1" value="0" style="max-width:80px"></td></tr>`)}
      </table></div>
      <div class="filters" style="margin-top:var(--space-4)">
        <label>Delivery or pickup<select name="fulfilment"><option value="delivery">Delivery</option><option value="pickup">Pickup</option></select></label>
        <label class="deliv">Delivery fee (MVR)<input name="fee" inputmode="decimal" value="${dd.delivery_fee_male_mvr}"></label>
      </div>
      <p class="hint deliv">Malé is ${mvr(dd.delivery_fee_male_mvr)}, outside Malé ${mvr(dd.delivery_fee_outside_male_mvr)}.</p>
      <label class="deliv">Where to deliver<textarea name="address" maxlength="500" placeholder="House, street, island; or the boat and time"></textarea></label>
      <label>Notes <span class="muted">(optional)</span><textarea name="notes" maxlength="500"></textarea></label>
      <label class="row" style="margin-top:var(--space-4)"><input type="checkbox" name="free" style="width:auto"> Give away (free, no payment)</label>
      <label id="why" hidden>Who is it for? <span class="muted">(kept in the order's history)</span><input name="free_reason" maxlength="300" placeholder="e.g. tasting for a café"></label>
      <div class="notice info" id="sum" style="margin-top:var(--space-4)"></div>
      <div id="no-err"></div>
      <button class="primary">Create order</button>
    </form>`);
  $("#back").onclick = () => go({ tab: "orders" });
  const f = $<HTMLFormElement>("#no");
  const rows = () => [...f.querySelectorAll<HTMLTableRowElement>("tr[data-p]")];
  const items = () => rows().map((tr) => ({ product_id: tr.dataset.p!, qty: Number(tr.querySelector<HTMLInputElement>("[name=qty]")!.value || 0) })).filter((i) => i.qty > 0);
  const refresh = () => {
    const day = days.find((d) => d.date === f.delivery_date.value);
    for (const tr of rows()) tr.querySelector(".left")!.textContent = String(day?.products[tr.dataset.p!] ?? 0);
    const free = f.free.checked, deliv = f.fulfilment.value === "delivery";
    $("#why").hidden = !free;
    f.querySelectorAll<HTMLElement>(".deliv").forEach((el) => (el.hidden = !deliv));
    const price = new Map((products as { id: string; price_mvr: string }[]).map((p) => [p.id, laari(p.price_mvr)]));
    const buns = items().reduce((a, i) => a + i.qty, 0);
    const total = free ? 0 : items().reduce((a, i) => a + (price.get(i.product_id) ?? 0) * i.qty, 0) + (deliv && buns ? laari(f.fee.value || "0") : 0);
    render($("#sum"), html`${buns} buns · <b>${free ? "Free (giveaway)" : mvr(total / 100)}</b>${free ? "" : " · waits for payment until you mark it paid"}`);
  };
  f.addEventListener("input", refresh);
  f.addEventListener("change", refresh);
  refresh();
  if (!days.length) render($("#no-err"), html`<div class="notice bad">No day is open for orders right now.</div>`);
  f.onsubmit = async (e) => {
    e.preventDefault();
    const btn = f.querySelector<HTMLButtonElement>("button.primary")!;
    btn.disabled = true;
    try {
      const deliv = f.fulfilment.value === "delivery";
      const r = await call("/admin/create-order", {
        name: (f.elements.namedItem("name") as HTMLInputElement).value, phone: f.phone.value, delivery_date: f.delivery_date.value, items: items(), fulfilment: f.fulfilment.value,
        ...(deliv ? { address: f.address.value || null, delivery_fee_mvr: f.fee.value } : {}),
        notes: f.notes.value || null, ...(f.free.checked ? { free: true, free_reason: f.free_reason.value } : {}),
      });
      go({ order: r.public_id });
    } catch (err) {
      render($("#no-err"), html`<div class="notice bad">${(err as Error).message}</div>`);
      btn.disabled = false;
    }
  };
}

async function orderDetail(id: string) {
  const o = await call(`/admin/order?id=${encodeURIComponent(id)}`);
  shell("orders", html`
    <button class="secondary" id="back">← Orders</button>
    <h1 style="margin-top:var(--space-4)">${o.public_id} ${chip(o.status)}</h1>
    ${o.needs_review ? html`<div class="notice bad"><b>Needs review:</b> ${o.review_reason}</div>` : ""}
    ${o.on_telegram === false ? html`<div class="notice bad small"><b>The slip isn't in the Telegram group yet.</b> Trying again every minute. Last error: ${o.telegram_error ?? "–"}</div>` : ""}
    ${o.customer_message ? html`<div class="notice info small">Customer sees: ${o.customer_message}</div>` : ""}
    ${o.entered_by ? html`<div class="notice info small">Entered by ${o.entered_by}.${o.status === "awaiting_payment"
      ? " The buns are held until you mark it paid or cancel it; it doesn't expire. The customer can also pay with the link below." : ""}</div>` : ""}
    <div class="card">
      <h2>Actions</h2>
      <div class="actions">${o.actions.length ? o.actions.map((a: string) => html`<button data-action="${a}" class="${a === "cancel" || a === "reject_order" ? "secondary" : ""}">${ACTION_LABELS[a]}</button>`) : html`<span class="muted">None</span>`}</div>
      <div id="act-err"></div>
    </div>
    <div class="card">
      <h2>Customer</h2>
      <p>${o.customer_name} · <a href="tel:${o.phone}">${o.phone}</a>${o.address ? html`<br>${o.address}` : ""}</p>
      ${o.boat ? html`<div class="notice info"><b>⛴ Deliver to the boat ${o.boat.name}</b> at ${o.boat.time}<br>
        ${o.boat.phone ? html`<a href="tel:${o.boat.phone}">Call the boat: ${o.boat.phone}</a> · ` : ""}<a href="${o.boat.followme}" target="_blank" rel="noopener">Track on FollowMe</a></div>` : ""}
      ${o.map_url ? html`<p><a class="btn" href="${o.map_url}" target="_blank" rel="noopener">📍 Open pin in Google Maps</a></p>` : ""}
      ${o.notes ? html`<p class="muted">Notes: ${o.notes}</p>` : ""}
      <p class="small">${o.fulfilment === "pickup" ? "Pickup" : "Delivery"} <b>${o.delivery_date}</b> · ${copyBtn(o.status_url, "Copy customer's order link")}</p>
    </div>
    <div class="card">
      <h2>Items</h2>
      <table class="items">
        ${o.items.map((i: Record<string, string>) => html`<tr><td>${i.qty} × ${i.product_name}</td><td>${mvr(Number(i.unit_price) * Number(i.qty))}</td></tr>`)}
        ${Number(o.delivery_fee_mvr) > 0 ? html`<tr><td>Delivery</td><td>${mvr(o.delivery_fee_mvr)}</td></tr>` : ""}
        <tr class="total"><td>Total</td><td>${mvr(o.total_mvr)}</td></tr>
      </table>
    </div>
    <div class="card">
      <h2>Payment</h2>
      <div class="kv"><span>Reference</span><b>${o.payment_reference ?? "—"}</b></div>
      <div class="kv"><span>Bank received</span><b>${o.paid_amount ? mvr(o.paid_amount) : "—"}</b></div>
      <div class="kv"><span>Booked on</span><b>${o.paid_on ?? "—"}</b></div>
      <div class="kv"><span>Paid at</span><b>${when(o.paid_at) || "—"}</b></div>
      <div class="kv"><span>Ledger checks</span><b>${o.claim_attempts}${o.last_claim_at ? ` · last ${when(o.last_claim_at)}` : ""}</b></div>
      ${o.last_claim_response ? html`<details><summary class="small">Last ledger response</summary><pre>${JSON.stringify(o.last_claim_response, null, 2)}</pre></details>` : ""}
      ${o.slip_url ? html`<p style="margin-top:var(--space-3)"><a href="${o.slip_url}" target="_blank" rel="noopener"><img src="${o.slip_url}" alt="Payment slip" style="max-width:240px;border-radius:9px"></a></p>`
        : o.payment_reference ? html`<p class="small muted" style="margin-top:var(--space-3)">Slip files are removed after a day. Search <b>${o.public_id}</b> in the slips Telegram group.</p>` : ""}
    </div>
    <div class="card">
      <h2>History</h2>
      <ul class="timeline">
        ${o.events.map((e: Record<string, string>) => html`<li><b>${e.kind.replace(/_/g, " ")}</b> → ${e.status.replace(/_/g, " ")} · ${e.actor} · <span class="muted">${when(e.created_at)}</span>${e.note ? html`<div class="small">${e.note}</div>` : ""}</li>`)}
      </ul>
    </div>`);
  $("#back").onclick = () => history.length > 1 ? history.back() : go({});
  app.querySelectorAll<HTMLButtonElement>("[data-action]").forEach((b) => (b.onclick = () => act(o, b.dataset.action!)));
}

// deno-lint-ignore no-explicit-any
async function act(o: any, action: string) {
  const body: Record<string, unknown> = { id: o.public_id, action };
  if (action === "mark_paid_manual") {
    const refs = prompt(
      "BML references to lock to this order (comma-separated). They must already show in the bank records.\nLeave empty if the money didn't come through BML (e.g. another bank).",
      o.payment_reference ?? "",
    );
    if (refs === null) return;
    body.references = refs.split(/[\s,]+/).filter(Boolean);
  }
  if (["mark_paid_manual", "cancel", "reject_order", "clear_review"].includes(action)) {
    const hint = action === "cancel" || action === "reject_order" ? " (the customer sees this)" : "";
    const note = prompt(`${ACTION_LABELS[action]}: reason${hint}`);
    if (!note?.trim()) return;
    body.note = note.trim();
  } else if (action !== "retry_claim" && !confirm(`${ACTION_LABELS[action]} for ${o.public_id}?`)) {
    return;
  }
  try {
    await call("/admin/order-action", body);
    await orderDetail(o.public_id);
  } catch (e) {
    render($("#act-err"), html`<div class="notice bad" style="margin-top:var(--space-3)">${(e as Error).message}</div>`);
  }
}

// ── Production, customers, products ──

async function production(date: string) {
  date ||= tomorrow();
  type Row = {
    product_id: string; product_name: string; linked: boolean; planned: number | null; baked: number;
    paid: number; checking: number; unpaid: number; preorders: number; extras: number;
  };
  const r = await call(`/admin/production?date=${date}`);
  const rows = r.products as Row[];
  const sum = (k: keyof Row) => rows.reduce((a, p) => a + Number(p[k] ?? 0), 0);
  // Buns customers can still order as extras: what's baked (or planned, whichever is higher) minus all orders.
  const left = (p: Row) => Math.max(0, Math.max(p.planned ?? 0, p.baked) - p.preorders - p.extras);
  shell("production", html`
    <div class="filters">
      <label>Day<input type="date" id="d" value="${date}"></label>
    </div>
    <h2>${r.label}</h2>
    <p>Deliveries: <b>${r.deliveries} of ${r.settings.delivery_max_orders}</b> · Pre-orders: <b>${sum("preorders")} of ${r.settings.preorder_max_buns}</b> buns
      <span class="muted small">(limits are in Days → Ordering settings)</span></p>
    <form id="plan"><div class="scroll"><table class="list">
      <tr><th>Bun</th><th>Baking</th><th>Baked</th><th>Pre-orders</th><th>Extras sold</th><th>Extras left</th><th>Paid</th><th>Checking</th><th>Not paid</th></tr>
      ${rows.map((p) => html`<tr>
        <td>${p.product_name}</td>
        <td>${p.linked ? html`<input name="${p.product_id}" type="number" min="0" step="1" value="${p.planned ?? ""}" placeholder="–" style="max-width:80px">` : html`<span class="muted small">not in bot</span>`}</td>
        <td>${p.baked || html`<span class="muted">–</span>`}</td>
        <td>${p.preorders}</td><td>${p.extras}</td><td><b>${left(p)}</b></td>
        <td>${p.paid}</td><td>${p.checking}</td><td class="muted">${p.unpaid}</td></tr>`)}
      <tr><td><b>Total</b></td><td>${sum("planned")}</td><td>${sum("baked")}</td><td>${sum("preorders")}</td><td>${sum("extras")}</td>
        <td><b>${rows.reduce((a, p) => a + left(p), 0)}</b></td><td>${sum("paid")}</td><td>${sum("checking")}</td><td class="muted">${sum("unpaid")}</td></tr>
    </table></div>
    <div class="row" style="margin-top:var(--space-3);flex-wrap:wrap">
      <button>Save baking plan</button>
      <span class="small muted grow">Same plan as the Telegram bot's /plan; Baked comes from /batch. Extras left = the higher of the two, minus all orders.</span>
    </div></form>
    <form id="more" style="margin-top:var(--space-4)">
      <h3>Add buns just made</h3>
      <p class="small muted">How many more came out? They go on top of what's there now, so customers can order them straight away.</p>
      <div class="row" style="flex-wrap:wrap">
        ${rows.filter((p) => p.linked).map((p) => html`<label>${p.product_name}<input name="${p.product_id}" type="number" min="1" step="1" placeholder="0" style="max-width:80px"></label>`)}
        <button>Add</button>
      </div>
    </form>
    <div id="prod-msg"></div>
    <p class="small muted" style="margin-top:var(--space-3)">Paid = paid or delivered. Checking = waiting for the bank. Cancelled and rejected orders are left out.</p>`);
  const msg = (m: string, ok = false) => render($("#prod-msg"), html`<div class="notice ${ok ? "ok" : "bad"} small" style="margin-top:var(--space-3)">${m}</div>`);
  $<HTMLInputElement>("#d").onchange = (e) => go({ tab: "production", date: (e.target as HTMLInputElement).value });
  $<HTMLFormElement>("#plan").onsubmit = async (e) => {
    e.preventDefault();
    const lines = [...(e.target as HTMLFormElement).querySelectorAll<HTMLInputElement>("input[type=number]")]
      .filter((i) => i.value !== "").map((i) => ({ product_id: i.name, qty: Number(i.value) }));
    if (!lines.length) return msg("Enter how many of each bun you're baking.");
    const short = rows.find((p) => lines.some((l) => l.product_id === p.product_id && l.qty < p.preorders));
    if (short && !confirm(`${short.product_name}: that's fewer than the ${short.preorders} pre-ordered. Save anyway?`)) return;
    try {
      await call("/admin/plan", { date, lines });
      await production(date);
      msg("Baking plan saved. Customers can now order the extras.", true);
    } catch (err) {
      msg((err as Error).message);
    }
  };
  $<HTMLFormElement>("#more").onsubmit = async (e) => {
    e.preventDefault();
    // On top of the higher of planned and baked: that's what the stock is counted from.
    const lines = [...(e.target as HTMLFormElement).querySelectorAll<HTMLInputElement>("input[type=number]")]
      .filter((i) => Number(i.value) > 0).map((i) => {
        const p = rows.find((r) => r.product_id === i.name)!;
        return { product_id: i.name, qty: Math.max(p.planned ?? 0, p.baked) + Math.floor(Number(i.value)) };
      });
    if (!lines.length) return msg("Enter how many more of a bun you made.");
    try {
      await call("/admin/plan", { date, lines });
      await production(date);
      msg("Added. Customers can order them now.", true);
    } catch (err) {
      msg((err as Error).message);
    }
  };
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const dayNames = (w: number[]) => w.length ? w.map((d) => WEEKDAYS[d]).join(", ") : "none";

async function days() {
  type Day = { date: string; label: string; off: "weekly" | "one_time" | null; opened: boolean; booked: number };
  const r = await call("/admin/days");
  const [now, ...later] = r.weekly as { from: string; label: string; weekdays: number[] }[];
  const editing = (later.at(-1) ?? now).weekdays;
  const st = r.settings;
  shell("days", html`
    <form class="card" id="settings">
      <h2>Ordering settings</h2>
      <div class="filters">
        <label>Pre-order limit per day (buns)<input name="preorder_max_buns" type="number" min="0" step="1" value="${st.preorder_max_buns}"></label>
        <label>Deliveries per day (orders)<input name="delivery_max_orders" type="number" min="0" step="1" value="${st.delivery_max_orders}"></label>
        <label>Minutes to pay before an order is cancelled<input name="pay_within_minutes" type="number" min="5" step="1" value="${st.pay_within_minutes}"></label>
        <label>Pre-orders close at (hour, 24h, the day before)<input name="order_cutoff_hour" type="number" min="1" max="23" step="1" value="${st.order_cutoff_hour}"></label>
        <label>Instagram handle<input name="instagram" value="@${st.instagram}"></label>
        <label>Delivery fee in Malé (MVR)<input name="delivery_fee_male_mvr" inputmode="decimal" value="${st.delivery_fee_male_mvr}"></label>
        <label>Delivery fee outside Malé (MVR)<input name="delivery_fee_outside_male_mvr" inputmode="decimal" value="${st.delivery_fee_outside_male_mvr}"></label>
      </div>
      <label>Pickup details (shown to customers who pick up)<textarea name="pickup_place" maxlength="300">${st.pickup_place}</textarea></label>
      <div class="row" style="margin-top:var(--space-3)"><button>Save settings</button><span id="settings-msg" class="small"></span></div>
      <p class="hint">The pre-order limit per flavour is on each bun in Products. The bot's evening reminder is sent at the cutoff hour.</p>
    </form>
    <div class="card">
      <h2>Weekly off days</h2>
      <p>Now: <b>${dayNames(now.weekdays)}</b>
        ${later.map((w) => html`<br>From ${w.label}: <b>${dayNames(w.weekdays)}</b>`)}</p>
      <div class="row" style="flex-wrap:wrap">
        ${WEEKDAYS.map((n, i) => html`<label class="row" style="margin:0;font-weight:500"><input type="checkbox" name="wd" value="${i}" style="width:auto" ${editing.includes(i) ? "checked" : ""}> ${n}</label>`)}
        <button id="save-weekly">Save</button>
      </div>
      <p class="hint">A change starts on ${r.change_label}, after the days customers can already book.</p>
    </div>
    <p class="muted">Customers can order up to 7 days ahead. Make a one-time off day for any day below, or open a weekly off day just this once.
      Orders already placed for a day you close stay; cancel them from Orders if needed.</p>
    <table class="list">
      <tr><th>Day</th><th>Booked</th><th></th></tr>
      ${r.days.map((d: Day) => html`
        <tr><td><b>${d.label}</b> ${d.off === "weekly" ? html`<span class="chip">weekly off</span>` : d.off ? html`<span class="chip cancelled">off day</span>` : d.opened ? html`<span class="chip paid">open (normally off)</span>` : ""}</td>
          <td>${d.booked ? `${d.booked} bun${d.booked > 1 ? "s" : ""}` : html`<span class="muted">–</span>`}</td>
          <td style="text-align:right"><button class="${d.off ? "" : "secondary"}" data-day="${d.date}" data-off="${String(!d.off)}">${
            d.off === "weekly" ? "Open this day" : d.off ? "Open again" : d.opened ? "Close again" : "Make off day"}</button></td></tr>`)}
    </table>
    <div id="day-err"></div>`);
  $<HTMLFormElement>("#settings").onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target as HTMLFormElement;
    const n = (k: string) => Number((f.elements.namedItem(k) as HTMLInputElement).value);
    try {
      await call("/admin/config", {
        preorder_max_buns: n("preorder_max_buns"), delivery_max_orders: n("delivery_max_orders"), pay_within_minutes: n("pay_within_minutes"),
        order_cutoff_hour: n("order_cutoff_hour"), instagram: (f.elements.namedItem("instagram") as HTMLInputElement).value,
        delivery_fee_male_mvr: (f.elements.namedItem("delivery_fee_male_mvr") as HTMLInputElement).value,
        delivery_fee_outside_male_mvr: (f.elements.namedItem("delivery_fee_outside_male_mvr") as HTMLInputElement).value,
        pickup_place: (f.elements.namedItem("pickup_place") as HTMLTextAreaElement).value,
      });
      $("#settings-msg").textContent = "Saved.";
    } catch (err) {
      $("#settings-msg").textContent = (err as Error).message;
    }
  };
  const fail = (e: unknown) => render($("#day-err"), html`<div class="notice bad" style="margin-top:var(--space-3)">${(e as Error).message}</div>`);
  $("#save-weekly").onclick = async () => {
    const weekdays = [...app.querySelectorAll<HTMLInputElement>("input[name=wd]:checked")].map((c) => Number(c.value));
    if (!confirm(`Weekly off days from ${r.change_label}: ${dayNames(weekdays)}?`)) return;
    try {
      await call("/admin/weekly", { weekdays });
      await days();
    } catch (e) {
      fail(e);
    }
  };
  app.querySelectorAll<HTMLButtonElement>("[data-day]").forEach((b) => (b.onclick = async () => {
    const off = b.dataset.off === "true";
    const row = r.days.find((d: Day) => d.date === b.dataset.day);
    if (off && row.booked && !confirm(`${row.label} already has ${row.booked} buns ordered. Close it anyway?`)) return;
    b.disabled = true;
    try {
      await call("/admin/day", { date: b.dataset.day, off });
      await days();
    } catch (e) {
      fail(e);
      b.disabled = false;
    }
  }));
}

// ── Shop invoices ──

const laari = (s: string) => Math.round(Number(s) * 100);
const INV_CHIP: Record<string, string> = { unpaid: "awaiting_bank", paid: "paid", void: "cancelled" };

async function invoices() {
  const r = await call("/admin/invoices");
  shell("invoices", html`
    <div class="row between" style="margin-bottom:var(--space-4)">
      <p class="muted" style="margin:0">Invoices for buns placed in shops. The shop pays for what it sold, minus its profit per bun.</p>
      <button id="new-inv">New invoice</button>
    </div>
    <div class="scroll"><table class="list">
      <tr><th>Invoice</th><th>Date</th><th>Shop</th><th>Amount due</th><th>Status</th></tr>
      ${r.invoices.map((i: Record<string, string>) => html`
        <tr data-inv="${i.number}"><td><b>${i.number}</b></td><td>${i.invoice_date}</td><td>${i.shop_name}</td>
          <td>${mvr(i.due_mvr)}</td><td><span class="chip ${INV_CHIP[i.status]}">${i.status}</span></td></tr>`)}
    </table></div>
    ${r.invoices.length ? "" : html`<p class="muted">No invoices yet.</p>`}`);
  $("#new-inv").onclick = () => go({ tab: "invoices", new: "1" });
  app.querySelectorAll<HTMLElement>("tr[data-inv]").forEach((tr) => (tr.onclick = () => go({ invoice: tr.dataset.inv! })));
}

async function newInvoice() {
  const [{ products }, { shops }] = await Promise.all([call("/admin/products"), call("/admin/invoices")]);
  type P = { id: string; name: string; price_mvr: string; active: boolean };
  const list = (products as P[]).filter((p) => p.active);
  const today = new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 10);
  shell("invoices", html`
    <button class="secondary" id="back">← Invoices</button>
    <form class="card" id="inv" style="margin-top:var(--space-4)">
      <h1>New shop invoice</h1>
      <div class="filters">
        <label>Shop<input name="shop_name" list="shops" required maxlength="100" placeholder="Shop name"></label>
        <label>Invoice date<input name="invoice_date" type="date" required value="${today}"></label>
        <label>Shop's profit per bun sold (MVR)<input name="margin" inputmode="decimal" value="5"></label>
      </div>
      <datalist id="shops">${(shops as string[]).map((s) => html`<option value="${s}">`)}</datalist>
      <div class="scroll"><table class="list" style="margin-top:var(--space-4)">
        <tr><th>Bun</th><th>Price (MVR)</th><th>Sold</th><th>Free</th></tr>
        ${list.map((p) => html`<tr data-p="${p.id}"><td>${p.name}</td>
          <td><input name="price" inputmode="decimal" value="${p.price_mvr}" style="max-width:90px"></td>
          <td><input name="sold" type="number" min="0" step="1" value="0" style="max-width:80px"></td>
          <td><input name="free" type="number" min="0" step="1" value="0" style="max-width:80px"></td></tr>`)}
      </table></div>
      <p class="hint">Free = given away for tasting or testing; listed on the invoice at no charge.</p>
      <label>Notes <span class="muted">(optional, printed on the invoice)</span><textarea name="notes" maxlength="500"></textarea></label>
      <div class="notice info" id="sum" style="margin-top:var(--space-4)"></div>
      <div id="inv-err"></div>
      <button class="primary">Create invoice</button>
    </form>`);
  $("#back").onclick = () => go({ tab: "invoices" });
  const f = $<HTMLFormElement>("#inv");
  const read = () => [...f.querySelectorAll<HTMLTableRowElement>("tr[data-p]")].map((tr) => ({
    product_id: tr.dataset.p!,
    unit_price: tr.querySelector<HTMLInputElement>("[name=price]")!.value.trim(),
    sold: Number(tr.querySelector<HTMLInputElement>("[name=sold]")!.value || 0),
    free: Number(tr.querySelector<HTMLInputElement>("[name=free]")!.value || 0),
  }));
  const sum = () => {
    const m = laari(f.margin.value || "0");
    let sold = 0, free = 0, sales = 0, due = 0;
    for (const l of read()) {
      sold += l.sold; free += l.free;
      sales += laari(l.unit_price) * l.sold; due += (laari(l.unit_price) - m) * l.sold;
    }
    render($("#sum"), html`${sold} sold, ${free} free · Sales ${mvr(sales / 100)} · Shop keeps ${mvr((sales - due) / 100)} · <b>Shop pays us ${mvr(due / 100)}</b>`);
  };
  f.addEventListener("input", sum);
  sum();
  f.onsubmit = async (e) => {
    e.preventDefault();
    const btn = f.querySelector<HTMLButtonElement>("button.primary")!;
    btn.disabled = true;
    try {
      const r = await call("/admin/invoice", {
        shop_name: f.shop_name.value, invoice_date: f.invoice_date.value, shop_margin_mvr: f.margin.value,
        notes: f.notes.value || null, lines: read().filter((l) => l.sold + l.free > 0),
      });
      go({ invoice: r.number });
    } catch (err) {
      render($("#inv-err"), html`<div class="notice bad">${(err as Error).message}</div>`);
      btn.disabled = false;
    }
  };
}

async function invoiceView(number: string) {
  const v = await call(`/admin/invoice?id=${encodeURIComponent(number)}`);
  const fmtDate = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" });
  const margin = laari(v.shop_margin_mvr);
  shell("invoices", html`
    <div class="row no-print" style="flex-wrap:wrap;margin-bottom:var(--space-4)">
      <button class="secondary" id="back">← Invoices</button>
      <button id="print">Print / save as PDF</button>
      ${v.status === "unpaid" ? html`<button class="secondary" id="paid">Mark paid</button><button class="secondary" id="void">Void</button>` : ""}
    </div>
    <div id="inv-err" class="no-print"></div>
    ${v.status !== "unpaid" ? html`<div class="notice ${v.status === "paid" ? "ok" : "bad"} no-print"><b>${v.status === "paid" ? "Paid" : "Void"}</b>
      ${v.status_at ? ` · ${when(v.status_at)}` : ""}${v.status_note ? ` · ${v.status_note}` : ""}</div>` : ""}
    <div class="card invoice">
      <div class="row between" style="align-items:flex-start;flex-wrap:wrap">
        <div><h1 style="margin:0">Alina Bun</h1><div class="muted small">Instagram @${v.instagram}</div></div>
        <div style="text-align:right"><h2 style="margin:0">Invoice ${v.number}</h2><div>${fmtDate(v.invoice_date)}</div></div>
      </div>
      <p style="margin-top:var(--space-5)"><span class="muted">To</span><br><b>${v.shop_name}</b></p>
      <div class="scroll"><table class="list">
        <tr><th>Bun</th><th>Sold</th><th>Price</th><th>Shop keeps</th><th style="text-align:right">Amount</th></tr>
        ${v.lines.filter((l: { sold: number }) => l.sold).map((l: { product_name: string; sold: number; unit_price: string }) => html`<tr>
          <td>${l.product_name}</td><td>${l.sold}</td><td>${mvr(l.unit_price)}</td><td>${mvr(v.shop_margin_mvr)}</td>
          <td style="text-align:right">${mvr((laari(l.unit_price) - margin) * l.sold / 100)}</td></tr>`)}
        ${v.lines.filter((l: { free: number }) => l.free).map((l: { product_name: string; free: number }) => html`<tr>
          <td>${l.product_name} <span class="muted">(free, tasting)</span></td><td>${l.free}</td><td>–</td><td>–</td><td style="text-align:right">${mvr(0)}</td></tr>`)}
      </table></div>
      <table class="items" style="margin-top:var(--space-4);max-width:340px;margin-left:auto">
        <tr><td>Buns sold</td><td>${v.totals.sold}</td></tr>
        ${v.totals.free ? html`<tr><td>Free buns</td><td>${v.totals.free}</td></tr>` : ""}
        <tr><td>Sales</td><td>${mvr(v.totals.sales)}</td></tr>
        <tr><td>Shop's profit (${mvr(v.shop_margin_mvr)} per bun sold)</td><td>− ${mvr(v.totals.shop_share)}</td></tr>
        <tr class="total"><td>Amount due</td><td>${mvr(v.totals.due)}</td></tr>
      </table>
      ${v.notes ? html`<p style="margin-top:var(--space-4)">${v.notes}</p>` : ""}
      <div class="row" style="margin-top:var(--space-5);align-items:center;flex-wrap:wrap">
        ${v.qr ? html`<div class="paymv">${raw(qrSvg(v.qr))}<div class="small">Scan with the BML app to pay ${mvr(v.totals.due)}</div></div>` : ""}
        <p class="small grow" style="margin:0"><b>Please pay by bank transfer</b><br>
          ${v.qr ? "Scan the QR code with the BML app, or transfer to:" : ""}<br>
          ${v.bank.bank} · ${v.bank.account_name} · ${v.bank.account_number}</p>
      </div>
    </div>`);
  $("#back").onclick = () => go({ tab: "invoices" });
  $("#print").onclick = () => print();
  const act = async (action: string, note: string | null) => {
    try {
      await call("/admin/invoice-action", { id: v.number, action, note });
      await invoiceView(v.number);
    } catch (e) {
      render($("#inv-err"), html`<div class="notice bad">${(e as Error).message}</div>`);
    }
  };
  $("#paid")?.addEventListener("click", () => {
    const note = prompt(`Mark ${v.number} paid (${mvr(v.totals.due)}). Note (optional, e.g. "BML transfer" or "cash"):`);
    if (note !== null) act("mark_paid", note.trim() || null);
  });
  $("#void")?.addEventListener("click", () => {
    const note = prompt(`Void ${v.number}? Reason:`);
    if (note?.trim()) act("void", note.trim());
  });
}

async function customers(sort: string) {
  const r = await call(`/admin/customers?sort=${sort}`);
  shell("customers", html`
    <div class="filters"><label>Sort by<select id="sort">
      <option value="buns" ${sort === "buns" ? "selected" : ""}>Buns bought</option>
      <option value="recent" ${sort === "recent" ? "selected" : ""}>Last order</option></select></label></div>
    <div class="scroll"><table class="list">
      <tr><th>Phone</th><th>Name</th><th>Paid orders</th><th>Buns bought</th><th>Last paid</th></tr>
      ${r.customers.map((c: Record<string, string>) => html`<tr><td>${c.phone}</td><td>${c.name}</td><td>${c.paid_orders}</td><td><b>${c.buns_bought}</b></td><td>${when(c.last_paid_at)}</td></tr>`)}
    </table></div>`);
  $<HTMLSelectElement>("#sort").onchange = (e) => go({ tab: "customers", sort: (e.target as HTMLSelectElement).value });
}

// ── Sales ──

// deno-lint-ignore no-explicit-any
type Sales = any; // GET /admin/sales (store function, rules.ts salesReport)
interface BunStack { sold: number; given: number; unpaid: number; left: number }
const num = (x: number) => x.toLocaleString("en-GB");
const money = (x: number) => `MVR ${x.toLocaleString("en-GB", Number.isInteger(x) ? {} : { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (part: number, whole: number) => (whole ? Math.round((part / whole) * 100) : 0);
const utc = (d: string, o: Intl.DateTimeFormatOptions) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { ...o, timeZone: "UTC" });
const dayName = (d: string) => utc(d, { weekday: "short", day: "numeric", month: "short" });
const monthName = (m: string, month: "long" | "short" = "long") => utc(`${m}-01`, { month, year: "numeric" });
const span = ([a, b]: string[]) => `${Number(a.slice(8))}${a === b ? "" : `–${Number(b.slice(8))}`} ${utc(a, { month: "short" })}`;

/** ▲/▼ against an earlier period, in the good or bad colour; nothing when there's nothing to compare with. */
function change(cur: number, prev: number, upIsGood = true) {
  if (!prev) return "";
  const p = Math.round(((cur - prev) / prev) * 100);
  if (!p) return html`<small class="muted">no change</small>`;
  return html`<small class="${(p > 0) === upIsGood ? "up" : "down"}">${p > 0 ? "▲" : "▼"} ${Math.abs(p)}%</small>`;
}
const tile = (label: string, value: string, sub: unknown = "", delta: unknown = "") =>
  html`<div class="kpi"><span>${label}</span><b>${value}</b>${delta}${sub ? html`<small>${sub}</small>` : ""}</div>`;
const LEGEND = html`<div class="legend small"><span><i class="v-sold"></i>Sold</span><span><i class="v-other"></i>Given away or not paid</span><span><i class="v-left"></i>Left over</span></div>`;
const out = (b: BunStack) => b.sold + b.given + b.unpaid;
/** One bar: sold, then given away or not paid, then left over; `max` is the longest bar's made (or out). */
function stack(b: BunStack, max: number) {
  const parts: [number, string][] = [[b.sold, "v-sold"], [b.given + b.unpaid, "v-other"], [b.left, "v-left"]];
  return html`<div class="hbar">${parts.filter(([v]) => v > 0).map(([v, c]) => html`<i class="${c}" style="width:${(v / max) * 100}%"></i>`)}</div>`;
}

// One tooltip for every chart mark with data-tip, on hover and keyboard focus. Plain text, so names can't inject HTML.
const tipBox = document.body.appendChild(Object.assign(document.createElement("div"), { className: "tip", hidden: true }));
function showTip(e: Event) {
  const el = (e.target as Element).closest?.("[data-tip]");
  tipBox.hidden = !el;
  if (!el) return;
  tipBox.textContent = el.getAttribute("data-tip");
  const b = el.getBoundingClientRect();
  tipBox.style.left = `${Math.max(8, Math.min(b.left + b.width / 2 - tipBox.offsetWidth / 2, innerWidth - tipBox.offsetWidth - 8))}px`;
  tipBox.style.top = `${Math.max(8, b.top - tipBox.offsetHeight - 6)}px`;
}
document.addEventListener("pointerover", showTip);
document.addEventListener("focusin", showTip);
addEventListener("scroll", () => (tipBox.hidden = true), { passive: true });

async function sales(date: string) {
  const r: Sales = await call(`/admin/sales${date ? `?day=${date}` : ""}`);
  tipBox.hidden = true;
  const t = r.day_totals, lw = r.last_week, m = r.totals, pm = r.prev;
  const isToday = r.day === r.today;
  const dayMax = Math.max(1, ...r.day_buns.map((b: BunStack) => out(b) + b.left));
  const bunMax = Math.max(1, ...r.buns.map((b: BunStack) => out(b) + b.left));
  const weekMax = Math.max(1, ...r.weekdays.map((w: { avg: number | null }) => w.avg ?? 0));
  const monthMax = Math.max(1, ...r.months.map((x: { revenue: number }) => x.revenue));
  const orderAvg = (x: Sales) => (x.orders ? (x.revenue - x.shop_revenue) / x.orders : 0);
  const mix: [string, number][] = [["Website", m.web], ["Instagram and phone (entered by managers)", m.manager], ["Shops", m.shop]];
  shell("sales", html`
    <div class="filters">
      <label>Day<input type="date" id="d" value="${r.day}" max="${r.today}"></label>
      ${isToday ? "" : html`<button class="secondary" id="today" type="button">Today</button>`}
    </div>

    <h2>${r.label}${isToday ? " · today" : ""}</h2>
    <p class="small muted">Arrows compare with ${dayName(lw.day)}, a week before. Orders count on their delivery day.</p>
    <div class="kpis">
      ${tile("Buns sold", num(t.sold), t.given ? `+ ${t.given} given away` : "", change(t.sold, lw.sold))}
      ${tile("Revenue", money(t.revenue), t.fees ? `incl. ${money(t.fees)} delivery` : "", change(t.revenue, lw.revenue))}
      ${tile("Orders", num(t.orders), t.orders ? `avg ${money(orderAvg(t))}` : "", change(t.orders, lw.orders))}
      ${tile("Left over", t.made ? num(t.left) : "–", t.made ? (t.left ? `${pct(t.left, t.made)}% of ${t.made} made` : `all ${t.made} made went out`) : "nothing planned or baked")}
      ${t.unpaid || t.unpaid_mvr ? tile("Not paid yet", money(t.unpaid_mvr), `${t.unpaid} buns`) : ""}
    </div>
    ${r.day_buns.length ? html`<div class="scroll"><table class="list">
      <tr><th>Bun</th><th>Made</th><th>Sold</th><th>Given away</th><th>Not paid</th><th>Left</th><th>Revenue</th><th class="wide-only" style="width:30%"></th></tr>
      ${r.day_buns.map((b: Sales) => html`<tr><td>${b.name}</td><td>${b.made || "–"}</td><td><b>${b.sold}</b></td><td>${b.given}</td><td>${b.unpaid}</td>
        <td>${b.made && !b.left ? html`<span class="chip review">sold out</span>` : b.left}</td><td>${money(b.revenue)}</td><td class="wide-only">${stack(b, dayMax)}</td></tr>`)}
    </table></div><div class="wide-only">${LEGEND}</div>` : html`<p class="muted">Nothing made or sold this day.</p>`}

    <h2 style="margin-top:var(--space-6)">${monthName(r.month)}</h2>
    <p class="small muted">${span(r.range)}, arrows compare with ${span(r.prev_range)}.</p>
    <div class="kpis">
      ${tile("Buns sold", num(m.sold), m.given ? `+ ${m.given} given away` : "", change(m.sold, pm.sold))}
      ${tile("Revenue", money(m.revenue), m.fees ? `incl. ${money(m.fees)} delivery` : "", change(m.revenue, pm.revenue))}
      ${tile("Orders", num(m.orders), m.orders ? `avg ${money(orderAvg(m))}` : "", change(m.orders, pm.orders))}
      ${tile("Customers", num(m.customers), `${m.new_customers} new, ${m.customers - m.new_customers} came back`, change(m.customers, pm.customers))}
      ${tile("Left over", m.made ? num(m.left) : "–", m.made ? `${pct(m.left, m.made)}% of ${num(m.made)} made` : "", change(m.left, pm.left, false))}
    </div>

    <div class="card">
      <h3>Each day</h3>
      ${dailyChart(r)}
      ${LEGEND}
      <details><summary class="small">As a table</summary><div class="scroll"><table class="list">
        <tr><th>Day</th><th>Made</th><th>Sold</th><th>Given away</th><th>Not paid</th><th>Left</th><th>Orders</th><th>Revenue</th></tr>
        ${r.days.filter((d: Sales) => d.made || out(d) || d.orders).map((d: Sales) => html`<tr data-day="${d.day}"><td>${dayName(d.day)}</td><td>${d.made || "–"}</td>
          <td><b>${d.sold}</b></td><td>${d.given}</td><td>${d.unpaid}</td><td>${d.left}</td><td>${d.orders}</td><td>${money(d.revenue)}</td></tr>`)}
      </table></div></details>
    </div>

    <div class="grid2">
      <div class="card">
        <h3>Buns</h3>
        ${r.buns.length ? r.buns.map((b: Sales) => html`<div class="bunrow">
          <div class="row between"><b>${b.name}</b><span>${b.sold} sold · ${pct(b.sold, m.sold)}%</span></div>
          ${stack(b, bunMax)}
          <div class="small muted">${b.made ? `${b.made} made, ${b.left} left` : "no baking plan"}${b.sold_out ? ` · sold out on ${b.sold_out} ${b.sold_out === 1 ? "day" : "days"}` : ""} · ${money(b.revenue)}</div>
        </div>`) : html`<p class="muted">No buns yet this month.</p>`}
        ${r.buns.length ? LEGEND : ""}
      </div>
      <div class="card">
        <h3>Weekdays</h3>
        <p class="small muted">Average buns sold per day, on days we baked or sold.</p>
        ${r.weekdays.map((w: { weekday: number; days: number; avg: number | null }) => html`<div class="hrow">
          <span>${WEEKDAYS[w.weekday]}</span>
          <div class="hbar">${w.avg ? html`<i class="v-sold" style="width:${(w.avg / weekMax) * 100}%"></i>` : ""}</div>
          <span class="small">${w.avg === null ? html`<span class="muted">–</span>` : html`<b>${w.avg}</b> <span class="muted">· ${w.days} ${w.days === 1 ? "day" : "days"}</span>`}</span>
        </div>`)}
      </div>
      <div class="card">
        <h3>Where sales come from</h3>
        ${mix.map(([label, v]) => html`<div class="bunrow">
          <div class="row between"><span>${label}</span><span><b>${v}</b> buns · ${pct(v, m.sold)}%</span></div>
          <div class="hbar">${v ? html`<i class="v-sold" style="width:${pct(v, m.sold)}%"></i>` : ""}</div>
        </div>`)}
        <p class="small" style="margin-top:var(--space-3)">
          Delivery <b>${m.delivery}</b> · pickup <b>${m.pickup}</b> orders<br>
          Pre-orders <b>${m.preorder}</b> · same-day extras <b>${m.extra}</b> buns<br>
          Given away <b>${m.given}</b> buns
        </p>
      </div>
      <div class="card">
        <h3>Payments</h3>
        <p class="small">Not paid yet: <b>${money(m.unpaid_mvr)}</b> <span class="muted">(${m.unpaid} buns: orders waiting for payment or the bank, unpaid shop invoices)</span></p>
        <p class="small">Didn't go through: <b>${m.lost_orders}</b> ${m.lost_orders === 1 ? "order" : "orders"}, ${m.lost_buns} buns
          <span class="muted">(${m.expired} not paid in time, ${m.lost_orders - m.expired} cancelled or rejected)</span></p>
      </div>
    </div>

    <div class="card">
      <h3>Month by month</h3>
      <div class="scroll"><table class="list">
        <tr><th>Month</th><th>Buns sold</th><th>Revenue</th><th style="width:30%"></th><th>Orders</th><th>Left over</th></tr>
        ${r.months.map((x: Sales) => html`<tr data-id="${x.month}" class="${x.month === r.month ? "on" : ""}"><td>${monthName(x.month, "short")}</td><td><b>${num(x.sold)}</b></td>
          <td>${money(x.revenue)}</td><td><div class="hbar">${x.revenue ? html`<i class="v-sold" style="width:${(x.revenue / monthMax) * 100}%"></i>` : ""}</div></td>
          <td>${num(x.orders)}</td><td>${x.made ? `${num(x.left)} (${pct(x.left, x.made)}%)` : "–"}</td></tr>`)}
      </table></div>
      <p class="small muted" style="margin-top:var(--space-2)">This month so far. Tap a month to open it.</p>
    </div>
    <p class="small muted">Sold = paid orders and paid shop invoices (shops by invoice day, after their share). Made = the higher of the
      baking plan and what the bot logged as baked. Buns sold some other way show up as left over.</p>`);

  const open = (d: string) => go({ tab: "sales", date: d });
  $<HTMLInputElement>("#d").onchange = (e) => open((e.target as HTMLInputElement).value);
  if (!isToday) $("#today").onclick = () => open("");
  // A day in the chart or its table opens at the top, where that day's numbers are.
  const openDay = (d: string) => {
    open(d);
    scrollTo({ top: 0, behavior: "smooth" });
  };
  app.querySelectorAll<HTMLElement | SVGElement>("[data-day]").forEach((el) => {
    el.onclick = () => openDay(el.dataset.day!);
    el.onkeydown = (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      openDay(el.dataset.day!);
    };
  });
  // A month opens on its last day, or today for this month.
  app.querySelectorAll<HTMLElement>("tr[data-id]").forEach((tr) => {
    const [y, mo] = tr.dataset.id!.split("-").map(Number);
    const last = new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
    tr.onclick = () => open(last < r.today ? last : r.today);
  });
}

/** Columns for each day of the month: sold, given away or not paid, left over (together: what was made). */
function dailyChart(r: Sales) {
  const [y, mo] = r.month.split("-").map(Number);
  const n = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const byDay = new Map<string, Sales>(r.days.map((d: Sales) => [d.day, d]));
  // Drawn at the card's real width (inside its padding), so 11px labels stay 11px on a phone.
  const W = Math.round(Math.max(280, Math.min(940, app.clientWidth - 34))), H = 196, L = 30, T = 8, B = 24;
  const ph = H - T - B, band = (W - L) / n, bw = Math.max(3, Math.min(16, band - 4));
  const peak = Math.max(1, ...r.days.map((d: Sales) => Math.max(d.made, out(d))));
  const step = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000].find((s) => peak / s <= 4) ?? 2000;
  const max = Math.ceil(peak / step) * step;
  const py = (v: number) => T + ph - (v / max) * ph;
  const f = (x: number) => x.toFixed(1);
  const marks: Raw[] = [];
  for (let v = 0; v <= max; v += step) {
    marks.push(html`<line x1="${L}" x2="${W}" y1="${f(py(v))}" y2="${f(py(v))}" class="${v ? "grid" : "axis"}"/><text x="${L - 6}" y="${f(py(v) + 4)}" class="tick" text-anchor="end">${v}</text>`);
  }
  const sel = Number(r.day.slice(8));
  for (let i = 0; i < n; i++) {
    const day = `${r.month}-${String(i + 1).padStart(2, "0")}`, d = byDay.get(day);
    const x = L + i * band, bx = x + (band - bw) / 2;
    const off = d?.closed && !d.made && !out(d);
    if (off) marks.push(html`<rect x="${f(x + 1)}" y="${T}" width="${f(band - 2)}" height="${ph}" class="v-off"/>`);
    if (d) {
      const parts = ([[d.sold, "v-sold"], [d.given + d.unpaid, "v-other"], [d.left, "v-left"]] as [number, string][]).filter(([v]) => v > 0);
      let below = 0;
      parts.forEach(([v, cls], k) => {
        const top = py(below + v), bottom = py(below) - (k ? 2 : 0); // 2px surface gap between segments
        below += v;
        if (bottom - top < 0.5) return;
        const rr = k === parts.length - 1 ? Math.min(4, bottom - top, bw / 2) : 0; // round only the top end
        marks.push(html`<path class="${cls}" d="M${f(bx)},${f(bottom)}V${f(top + rr)}Q${f(bx)},${f(top)} ${f(bx + rr)},${f(top)}H${f(bx + bw - rr)}Q${f(bx + bw)},${f(top)} ${f(bx + bw)},${f(top + rr)}V${f(bottom)}Z"/>`);
      });
      const tip = [dayName(day), off ? "Off day" : `Sold ${d.sold} · ${money(d.revenue)}`,
        d.given || d.unpaid ? `Given away ${d.given} · not paid ${d.unpaid}` : "", d.made ? `Made ${d.made} · left ${d.left}` : ""].filter(Boolean).join("\n");
      marks.push(html`<rect x="${f(x)}" y="${T}" width="${f(band)}" height="${ph}" class="hit" data-day="${day}" data-tip="${tip}" tabindex="0" aria-label="${tip.replace(/\n/g, ", ")}"/>`);
    }
    const label = i + 1 === 1 || (i + 1) % 7 === 1 || i + 1 === sel;
    if (label && (i + 1 === sel || Math.abs(i + 1 - sel) > 1)) {
      marks.push(html`<text x="${f(x + band / 2)}" y="${H - 6}" class="tick${i + 1 === sel ? " sel" : ""}" text-anchor="middle">${i + 1}</text>`);
    }
    if (i + 1 === sel) marks.push(html`<rect x="${f(bx)}" y="${T + ph + 3}" width="${f(bw)}" height="2" class="sel"/>`);
  }
  return html`<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Buns made and sold each day of ${monthName(r.month)}">${marks}</svg>`;
}

async function products() {
  const r = await call("/admin/products");
  // deno-lint-ignore no-explicit-any
  const form = (p: any) => html`
    <form class="card" data-product="${p.id ?? ""}">
      <div class="row">
        ${p.image_url ? html`<img src="${p.image_url}" alt="" style="width:54px;height:96px;object-fit:cover;border-radius:9px">` : ""}
        <h3 class="grow">${p.name ?? "New product"}</h3>
      </div>
      <div class="filters">
        <label>ID<input name="id" value="${p.id ?? ""}" ${p.id ? "readonly" : ""} placeholder="e.g. cinnamon" pattern="[a-z0-9-]+"></label>
        <label>Name<input name="name" value="${p.name ?? ""}"></label>
        <label>Price (MVR)<input name="price_mvr" inputmode="decimal" value="${p.price_mvr ?? ""}"></label>
        <label>Order on page<input name="sort_order" type="number" value="${p.sort_order ?? 100}"></label>
        <label>Pre-order limit per day<input name="preorder_max" type="number" min="0" step="1" value="${p.preorder_max ?? 50}"></label>
      </div>
      <label>Description<input name="description" value="${p.description ?? ""}"></label>
      <div class="row" style="margin-top:var(--space-3)">
        <label class="row" style="margin:0"><input type="checkbox" name="active" style="width:auto" ${p.active !== false ? "checked" : ""}> On sale</label>
        <label style="margin:0" class="grow">Photo <input type="file" name="photo" accept="image/jpeg,image/png,image/webp"></label>
        <button>Save</button>
      </div>
      <div class="msg"></div>
    </form>`;
  shell("products", html`${r.products.map(form)}${form({})}`);
  app.querySelectorAll<HTMLFormElement>("form[data-product]").forEach((f) => (f.onsubmit = (e) => saveProduct(e, f)));
}

async function saveProduct(e: Event, f: HTMLFormElement) {
  e.preventDefault();
  const d = new FormData(f);
  const msg = (m: string, ok = false) => render(f.querySelector(".msg")!, html`<div class="notice ${ok ? "ok" : "bad"} small" style="margin-top:var(--space-3)">${m}</div>`);
  try {
    const id = String(d.get("id")).trim();
    let image_path: string | undefined;
    const photo = d.get("photo") as File | null;
    if (photo?.size) {
      const up = await call("/admin/product-image-url", { id, content_type: photo.type });
      await uploadTo(up.upload_url, photo);
      image_path = up.path;
    }
    await call("/admin/product", {
      id, name: d.get("name"), price_mvr: d.get("price_mvr"), description: d.get("description"),
      sort_order: Number(d.get("sort_order")), preorder_max: Number(d.get("preorder_max")), active: d.get("active") === "on", ...(image_path ? { image_path } : {}),
    });
    msg("Saved.", true);
    setTimeout(products, 600);
  } catch (err) {
    msg((err as Error).message);
  }
}

route();
