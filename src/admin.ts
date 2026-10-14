// "/admin/" — managers. Supabase Auth email + password (no sign-up); every call carries the JWT
// and the store function checks it against store.managers.
import { uploadTo } from "./image.ts";
import { $, api, copyBtn, html, mvr, type Raw, render, store } from "./lib.ts";

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
      ${[["orders", "Orders"], ["production", "Production"], ["days", "Days"], ["customers", "Customers"], ["products", "Products"]].map(([k, l]) =>
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
    switch (p.get("tab")) {
      case "production": return await production(p.get("date") ?? "");
      case "days": return await days();
      case "customers": return await customers(p.get("sort") ?? "buns");
      case "products": return await products();
      default: return await orders(p);
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
          <td>${chip(o.status)} ${o.needs_review ? html`<span class="chip review">review</span>` : ""}</td>
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
  app.querySelectorAll<HTMLElement>("tr[data-id]").forEach((tr) => (tr.onclick = () => go({ order: tr.dataset.id! })));
  $("#prev")?.addEventListener("click", () => go({ ...filters, page: String(page - 1) }));
  $("#next")?.addEventListener("click", () => go({ ...filters, page: String(page + 1) }));
}

async function orderDetail(id: string) {
  const o = await call(`/admin/order?id=${encodeURIComponent(id)}`);
  shell("orders", html`
    <button class="secondary" id="back">← Orders</button>
    <h1 style="margin-top:var(--space-4)">${o.public_id} ${chip(o.status)}</h1>
    ${o.needs_review ? html`<div class="notice bad"><b>Needs review:</b> ${o.review_reason}</div>` : ""}
    ${o.customer_message ? html`<div class="notice info small">Customer sees: ${o.customer_message}</div>` : ""}
    <div class="card">
      <h2>Actions</h2>
      <div class="actions">${o.actions.length ? o.actions.map((a: string) => html`<button data-action="${a}" class="${a === "cancel" || a === "reject_order" ? "secondary" : ""}">${ACTION_LABELS[a]}</button>`) : html`<span class="muted">None</span>`}</div>
      <div id="act-err"></div>
    </div>
    <div class="card">
      <h2>Customer</h2>
      <p>${o.customer_name} · <a href="tel:${o.phone}">${o.phone}</a>${o.address ? html`<br>${o.address}` : ""}</p>
      ${o.map_url ? html`<p><a class="btn" href="${o.map_url}" target="_blank" rel="noopener">📍 Open pin in Google Maps</a></p>` : ""}
      ${o.notes ? html`<p class="muted">Notes: ${o.notes}</p>` : ""}
      <p class="small">Delivery <b>${o.delivery_date}</b> · ${copyBtn(o.status_url, "Copy customer's order link")}</p>
    </div>
    <div class="card">
      <h2>Items</h2>
      <table class="items">
        ${o.items.map((i: Record<string, string>) => html`<tr><td>${i.qty} × ${i.product_name}</td><td>${mvr(Number(i.unit_price) * Number(i.qty))}</td></tr>`)}
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
  const r = await call(`/admin/production?date=${date}`);
  // deno-lint-ignore no-explicit-any
  const sum = (k: string) => r.products.reduce((a: number, p: any) => a + p[k], 0);
  shell("production", html`
    <div class="filters"><label>Delivery date<input type="date" id="d" value="${date}"></label></div>
    <h2>${r.label}</h2>
    <table class="list">
      <tr><th>Bun</th><th>Paid</th><th>Checking</th><th>Not paid yet</th></tr>
      ${r.products.map((p: Record<string, string>) => html`<tr><td>${p.product_name}</td><td><b>${p.paid}</b></td><td>${p.checking}</td><td class="muted">${p.unpaid}</td></tr>`)}
      <tr><td><b>Total</b></td><td><b>${sum("paid")}</b></td><td>${sum("checking")}</td><td class="muted">${sum("unpaid")}</td></tr>
    </table>
    <p class="small muted" style="margin-top:var(--space-3)">Paid = paid or delivered. Checking = waiting for the bank. Cancelled and rejected orders are left out.</p>`);
  $<HTMLInputElement>("#d").onchange = (e) => go({ tab: "production", date: (e.target as HTMLInputElement).value });
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const dayNames = (w: number[]) => w.length ? w.map((d) => WEEKDAYS[d]).join(", ") : "none";

async function days() {
  type Day = { date: string; label: string; off: "weekly" | "one_time" | null; booked: number };
  const r = await call("/admin/days");
  const [now, ...later] = r.weekly as { from: string; label: string; weekdays: number[] }[];
  const editing = (later.at(-1) ?? now).weekdays;
  shell("days", html`
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
    <p class="muted">Customers can order up to 7 days ahead. Make a one-time off day for any day below.
      Orders already placed for a day you close stay; cancel them from Orders if needed.</p>
    <table class="list">
      <tr><th>Day</th><th>Booked</th><th></th></tr>
      ${r.days.map((d: Day) => html`
        <tr><td><b>${d.label}</b> ${d.off === "weekly" ? html`<span class="chip">weekly off</span>` : d.off ? html`<span class="chip cancelled">off day</span>` : ""}</td>
          <td>${d.booked ? `${d.booked} bun${d.booked > 1 ? "s" : ""}` : html`<span class="muted">–</span>`}</td>
          <td style="text-align:right">${d.off === "weekly" ? "" : html`<button class="${d.off ? "" : "secondary"}" data-day="${d.date}" data-off="${String(!d.off)}">${d.off ? "Open again" : "Make off day"}</button>`}</td></tr>`)}
    </table>
    <div id="day-err"></div>`);
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

async function products() {
  const r = await call("/admin/products");
  // deno-lint-ignore no-explicit-any
  const form = (p: any) => html`
    <form class="card" data-product="${p.id ?? ""}">
      <div class="row">
        ${p.image_url ? html`<img src="${p.image_url}" alt="" style="width:72px;height:72px;object-fit:cover;border-radius:9px">` : ""}
        <h3 class="grow">${p.name ?? "New product"}</h3>
      </div>
      <div class="filters">
        <label>ID<input name="id" value="${p.id ?? ""}" ${p.id ? "readonly" : ""} placeholder="e.g. cinnamon" pattern="[a-z0-9-]+"></label>
        <label>Name<input name="name" value="${p.name ?? ""}"></label>
        <label>Price (MVR)<input name="price_mvr" inputmode="decimal" value="${p.price_mvr ?? ""}"></label>
        <label>Order on page<input name="sort_order" type="number" value="${p.sort_order ?? 100}"></label>
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
      sort_order: Number(d.get("sort_order")), active: d.get("active") === "on", ...(image_path ? { image_path } : {}),
    });
    msg("Saved.", true);
    setTimeout(products, 600);
  } catch (err) {
    msg((err as Error).message);
  }
}

route();
