// "/admin/" — managers. Supabase Auth email + password (no sign-up); every call carries the JWT
// and the store function checks it against store.managers.
import { uploadTo } from "./image.ts";
import { $, api, copyBtn, html, mvr, raw, type Raw, render, store } from "./lib.ts";
import { type Pin, pinPicker } from "./map.ts";
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
      ${[["orders", "Orders"], ["pack", "Pack"], ["sales", "Sales"], ["visitors", "Visitors"], ["production", "Production"], ["days", "Days"], ["invoices", "Invoices"], ["customers", "Customers"], ["products", "Products"]].map(([k, l]) =>
        html`<button class="${tab === k ? "on" : ""}" data-tab="${k}">${l}</button>`)}
      <button class="secondary" id="out" style="margin-left:auto">Sign out</button>
    </nav>
    <div id="view">${body}</div>`);
  app.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((b) => (b.onclick = () => go({ tab: b.dataset.tab! })));
  $("#out").onclick = () => signOut();
}

async function route() {
  if (!session) return showLogin();
  // This phone is ours: the tracker on our three sites leaves out phones with this cookie (track.ts).
  document.cookie = `ab_staff=1; max-age=${400 * 86400}; path=/; samesite=lax${location.hostname.endsWith("alinabun.com") ? "; domain=alinabun.com; secure" : ""}`;
  const p = params();
  try {
    if (p.get("order")) return await orderDetail(p.get("order")!);
    if (p.get("invoice")) return await invoiceView(p.get("invoice")!);
    switch (p.get("tab")) {
      case "pack": return await pack(p.get("date") || maleToday());
      case "sales":
        switch (p.get("view")) {
          case "profit": return await profit();
          case "costs": return await costs();
          case "expenses": return await expenses(p.get("from") ?? "", p.get("to") ?? "");
          case "stock": return await stock(p.get("date") ?? "");
          case "demand": return await demand();
          case "customers": return await customerStats();
          default: return await sales(p.get("date") ?? "");
        }
      case "visitors": return await visitors(p.get("from") ?? "", p.get("to") ?? "");
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
const maleToday = () => new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 10);

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
          <td>${o.delivery_date}${o.bake_label ? html`<div class="small muted">${o.bake_label}</div>` : ""}</td>
          <td>${mvr(o.total_mvr)}<div class="small muted">${o.currency === "USD" ? `pays USD ${o.total_usd} · ` : ""}${o.total_buns} buns</div></td>
          <td>${chip(o.status)} ${o.fulfilment === "pickup" ? html`<span class="chip">pickup</span>` : ""} ${o.entered_by ? html`<span class="chip">by us</span>` : ""} ${o.cod ? html`<span class="chip">💵 cash</span>` : ""} ${o.needs_review ? html`<span class="chip review">review</span>` : ""} ${String(o.on_telegram) === "false" ? html`<span class="chip review">not on Telegram</span>` : ""}</td>
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

// ── Pack: the day's orders as a kanban board. One lane per batch; columns New, Packing, Ready, Delivered; cards are orders. ──

type PackItem = { name: string; qty: number; free: boolean };
type PackOrder = {
  public_id: string; customer_name: string; phone: string; paid: boolean;
  stage: "new" | "packing" | "ready" | "delivered";
  payment: "paid" | "free" | "checking" | "unpaid" | "cash" | null; // null for cancelled ones
  cash_mvr: string | null; // cash on delivery: collect this
  cancelled: boolean; archived: boolean;
  bake: string; bake_label: string;
  fulfilment: "delivery" | "pickup"; time: string | null; time_label: string;
  area: "Malé" | "Hulhumalé" | "Other" | "Boat" | "Pickup"; boat: string | null;
  address: string | null; notes: string | null; items: PackItem[];
};
const LANES: [string, string, string][] = [["10:00", "☀️", "10 AM batch"], ["16:00", "🌇", "4 PM batch"]];
const STAGES: [PackOrder["stage"], string][] = [["new", "New"], ["packing", "Packing"], ["ready", "Ready"], ["delivered", "Delivered"]];
const PAY: Record<NonNullable<PackOrder["payment"]>, [string, string]> = {
  paid: ["✓ Paid", "ok"], free: ["🎁 Free", "free"], checking: ["Checking", "warn"], unpaid: ["Unpaid", "bad"], cash: ["💵 Cash", "warn"],
};
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const bunCount = (os: PackOrder[]) => os.reduce((n, o) => n + o.items.reduce((a, i) => a + i.qty, 0), 0);
function bunTotals(os: PackOrder[]) {
  const total = new Map<string, { qty: number; free: number }>(); // first seen keeps the shop's bun order
  for (const i of os.flatMap((o) => o.items)) {
    const t = total.get(i.name) ?? { qty: 0, free: 0 };
    total.set(i.name, { qty: t.qty + i.qty, free: t.free + (i.free ? i.qty : 0) });
  }
  return total;
}

let reloadPack: (() => void) | null = null;
// Two phones stay in step: the board reloads quietly when its tab is shown again.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && document.getElementById("board")) reloadPack?.();
});

async function pack(date: string) {
  const day = (n: number) => new Date(Date.parse(maleToday()) + n * 86400_000).toISOString().slice(0, 10);
  shell("pack", html`
    <div class="row" style="flex-wrap:wrap;margin-bottom:var(--space-4)">
      <input type="date" id="d" value="${date}" style="max-width:180px" aria-label="Delivery date">
      ${[[-1, "Yesterday"], [0, "Today"], [1, "Tomorrow"]].map(([n, l]) =>
        html`<button class="${day(n as number) === date ? "" : "secondary"}" data-day="${day(n as number)}">${l}</button>`)}
    </div>
    <div id="board"></div>`);
  $<HTMLInputElement>("#d").onchange = (e) => go({ tab: "pack", date: (e.target as HTMLInputElement).value });
  app.querySelectorAll<HTMLButtonElement>("[data-day]").forEach((b) => (b.onclick = () => go({ tab: "pack", date: b.dataset.day! })));

  const board = $("#board");
  let orders: PackOrder[] | null = null; // null until the first load works
  let problems: string[] = []; // failures of the last move or archive, one line each
  const selected = new Set<string>();
  const live = () => (orders ?? []).filter((o) => !o.archived);
  const cardsIn = (bake: string, stage: string) => live().filter((o) => o.bake === bake && o.stage === stage);

  async function load() {
    try {
      orders = (await call<{ orders: PackOrder[] }>(`/admin/pack?date=${date}`)).orders;
      const on = new Set(live().map((o) => o.public_id));
      for (const id of selected) if (!on.has(id)) selected.delete(id); // keep the selection for cards still here
    } catch (e) {
      problems = [(e as Error).message];
    }
    draw();
  }
  async function doAct(path: string, body: unknown) {
    problems = [];
    try {
      const r = await call<{ ok: boolean; failed: { error: string }[] }>(path, body);
      problems = r.failed.map((f) => f.error);
    } catch (e) {
      problems = [(e as Error).message];
    }
    await load();
  }
  async function move(ids: string[], stage: string) {
    const todo = ids.filter((id) => orders?.find((o) => o.public_id === id)?.stage !== stage);
    if (!todo.length) return;
    if (stage === "delivered" && !confirm(`Mark ${plural(todo.length, "order")} delivered? Customers who ordered in Telegram get a message. This can't be undone.`)) return;
    await doAct("/admin/pack-move", { ids: todo, stage });
  }
  const archive = (ids: string[], archived = true) => doAct("/admin/pack-archive", { ids, archived });
  function pick(id: string) {
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
    draw();
  }

  function draw() {
    const notice = problems.length ? html`<div class="notice bad">${problems.map((p) => html`<div>${p}</div>`)}</div>` : "";
    if (!orders) {
      render(board, html`${notice}`);
      return;
    }
    const all = orders, lv = live();
    const picked = lv.filter((o) => selected.has(o.public_id));
    const dayCards = lv.filter((o) => !o.cancelled);
    const one = picked.length === 1 ? picked[0] : null;

    const card = (o: PackOrder) => {
      const sel = selected.has(o.public_id), done = o.stage === "delivered";
      const [label, tone] = o.cancelled ? ["Cancelled, unpack", "bad"]
        : o.payment === "cash" ? [`💵 Collect ${mvr(o.cash_mvr!)}`, "warn"] : PAY[o.payment ?? "unpaid"];
      const where = o.fulfilment === "pickup" ? (done ? "Picked up" : `Pickup ${o.time_label}`)
        : o.boat ? `Boat ${o.time_label} · ${o.boat}` : `${o.time_label} · ${o.area}`;
      const items = o.items.filter((i) => i.qty > 0).map((i) => `${i.name} ${i.qty}${i.free ? " free" : ""}`).join(", ");
      return html`<div class="pk-card${sel ? " on" : ""}${o.cancelled ? " cancelled" : ""}" role="button" tabindex="0"
          aria-pressed="${sel ? "true" : "false"}" draggable="${done || o.cancelled ? "false" : "true"}" data-id="${o.public_id}">
        <div class="pk-top"><b class="pk-name">${o.customer_name}</b><span class="pay ${tone}">${label}</span></div>
        <div class="small">${where}</div>
        <div class="small muted">${plural(bunCount([o]), "bun")}${items ? ` · ${items}` : ""}</div>
        <div class="small muted">${o.public_id}</div>
        ${o.cancelled ? html`<button class="pk-link" data-unpack="${o.public_id}">Unpacked ✓</button>` : ""}
      </div>`;
    };
    const column = (bake: string, stage: string, label: string, cards: PackOrder[]) => html`
      <div class="pk-col" data-bake="${bake}" data-stage="${stage}">
        <div class="pk-colhead"><b>${label}</b> <span class="pk-count">${cards.length}</span>
          <span class="pk-acts">
            <button class="pk-link" data-selall="${bake}|${stage}">Select all</button>
            ${stage === "delivered" && cards.length ? html`<button class="pk-link" data-archall="${bake}">Archive all</button>` : ""}
          </span></div>
        ${cards.length ? cards.map(card) : html`<p class="small muted pk-empty">Nothing here</p>`}
      </div>`;

    render(board, html`
      ${notice}
      ${all.length ? html`
      ${LANES.map(([bake, icon, name]) => {
        const os = lv.filter((o) => o.bake === bake);
        return html`<section class="pk-lane">
          <h2 class="pk-lane-head">${icon} ${name} <span class="small muted">· ${plural(os.length, "order")} · ${plural(bunCount(os), "bun")}</span></h2>
          ${os.length ? html`<div class="pk-cols">${STAGES.map(([stage, label]) => column(bake, stage, label, os.filter((o) => o.stage === stage)))}</div>`
            : html`<p class="muted">No orders</p>`}
        </section>`;
      })}
      <details class="pk-arch-list"><summary>Archived (${all.length - lv.length})</summary>
        ${all.filter((o) => o.archived).map((o) => html`<div class="pk-arch-row">
          <span class="grow small"><b>${o.public_id}</b> ${o.customer_name} · ${o.bake_label} · ${o.cancelled ? "Cancelled" : "Delivered"}</span>
          <button class="secondary pk-put" data-put-back="${o.public_id}">Put back</button></div>`)}
      </details>
      <section class="pk-panel" aria-label="Selection">
        <div class="pk-panel-top">
          <b>${picked.length ? `${plural(picked.length, "order")} selected · ${plural(bunCount(picked), "bun")}`
            : `Whole day · ${plural(dayCards.length, "order")} · ${plural(bunCount(dayCards), "bun")}`}</b>
          ${picked.length ? html`<button class="pk-link" data-clear>Clear</button>` : ""}
        </div>
        <div class="pk-chips">${[...bunTotals(picked.length ? picked : dayCards)].map(([name, t]) =>
          html`<span class="pk-chip">${name} <b>${t.qty}</b>${t.free ? html` <span class="muted">(${t.free} free)</span>` : ""}</span>`)}</div>
        ${one ? html`<div class="small pk-detail">
          <div><a href="tel:${one.phone.replace(/\s+/g, "")}">${one.phone}</a>${one.boat ? ` · Boat ${one.boat}` : ""}</div>
          ${one.address ? html`<div>${one.address}</div>` : ""}
          ${one.notes ? html`<div><i>${one.notes}</i></div>` : ""}
          <div><a href="?order=${one.public_id}">Open order</a></div>
        </div>` : ""}
        ${picked.length ? html`<div class="pk-moves">
          ${STAGES.map(([stage, label]) => html`<button class="${stage === "delivered" ? "deliver" : "secondary"}" data-move="${stage}">${label}</button>`)}
          <button class="archive" data-archive-sel>Archive</button>
        </div>` : ""}
      </section>` : html`<p class="muted">No orders for this day.</p>`}`);
  }

  const press = (b: HTMLElement) => {
    const d = b.dataset;
    if (d.unpack) return archive([d.unpack]);
    if (d.putBack) return archive([d.putBack], false);
    if (d.selall !== undefined) {
      const [bake, stage] = d.selall.split("|");
      for (const o of cardsIn(bake, stage)) selected.add(o.public_id);
      return draw();
    }
    if (d.archall) {
      const ids = cardsIn(d.archall, "delivered").map((o) => o.public_id);
      if (ids.length && confirm(`Archive ${plural(ids.length, "delivered order")}? You can put them back from the list below.`)) return archive(ids);
      return;
    }
    if (d.clear !== undefined) {
      selected.clear();
      return draw();
    }
    if (d.move) return move([...selected], d.move);
    if (d.archiveSel !== undefined) return archive([...selected]);
  };
  board.onclick = (e) => {
    const t = e.target as HTMLElement;
    const b = t.closest<HTMLElement>("button");
    if (b) press(b);
    else {
      const c = t.closest<HTMLElement>(".pk-card");
      if (c) pick(c.dataset.id!);
    }
  };
  board.onkeydown = (e) => {
    const c = e.target as HTMLElement;
    if (!c.classList.contains("pk-card") || (e.key !== "Enter" && e.key !== " ")) return;
    e.preventDefault();
    pick(c.dataset.id!);
    board.querySelector<HTMLElement>(`.pk-card[data-id="${c.dataset.id}"]`)?.focus(); // redrawn, so focus the card again
  };
  // Drag and drop (computers). Phones use the buttons.
  // A card stays in its batch: it can only be dropped in its own row's columns.
  let dragBake = "";
  const colOf = (e: DragEvent) => {
    const col = (e.target as HTMLElement).closest<HTMLElement>(".pk-col");
    return col?.dataset.bake === dragBake ? col : null;
  };
  board.ondragstart = (e) => {
    const c = (e.target as HTMLElement).closest<HTMLElement>(".pk-card");
    if (!c?.draggable) return;
    dragBake = orders?.find((o) => o.public_id === c.dataset.id)?.bake ?? "";
    e.dataTransfer!.setData("text/plain", c.dataset.id!);
    e.dataTransfer!.effectAllowed = "move";
  };
  board.ondragover = (e) => {
    const col = colOf(e);
    board.querySelectorAll(".pk-col").forEach((c) => c.classList.toggle("over", c === col));
    if (!col) return;
    e.preventDefault();
  };
  board.ondragleave = (e) => {
    const col = colOf(e);
    if (col && !col.contains(e.relatedTarget as Node)) col.classList.remove("over");
  };
  board.ondrop = (e) => {
    board.querySelectorAll(".pk-col.over").forEach((c) => c.classList.remove("over"));
    const col = colOf(e);
    if (!col) return;
    e.preventDefault();
    const id = e.dataTransfer!.getData("text/plain");
    void move(selected.has(id) ? [...selected] : [id], col.dataset.stage!); // a selected card moves the whole selection
  };

  reloadPack = () => void load();
  await load();
}

/** An order taken by a manager (DM, phone, in person) or a giveaway. It holds buns like a customer order but never expires. */
async function newOrder() {
  type Time = { value: string; label: string };
  type Bake = { bake: string; label: string; available: boolean; products: Record<string, number>; delivery_times: Time[]; pickup_times: Time[] };
  type Day = { date: string; label: string; kind: string; available: boolean; closed: boolean; bakes: Bake[] };
  const [{ products }, dd] = await Promise.all([api("/catalog"), api("/delivery-dates")]);
  const days = (dd.dates as Day[]).filter((d) => d.available);
  shell("orders", html`
    <button class="secondary" id="back">← Orders</button>
    <form class="card" id="no" style="margin-top:var(--space-4)">
      <h1>New order</h1>
      <div class="filters">
        <label class="suggest">Customer's name<input name="name" required maxlength="80" autocomplete="off"></label>
        <label class="suggest">Phone<input name="phone" type="tel" required placeholder="7xx xxxx" autocomplete="off"></label>
        <label>Day<select name="delivery_date">${days.map((d) => html`<option value="${d.date}">${d.label}${d.kind === "extras" ? " (extras)" : ""}</option>`)}</select></label>
        <label>Batch<select name="bake"></select></label>
      </div>
      <div class="scroll"><table class="list" style="margin-top:var(--space-4)">
        <tr><th>Bun</th><th>Price</th><th>Left</th><th>How many</th></tr>
        ${(products as { id: string; name: string; price_mvr: string }[]).map((p) => html`<tr data-p="${p.id}"><td>${p.name}</td><td>${mvr(p.price_mvr)}</td>
          <td class="left muted"></td><td><input name="qty" type="number" min="0" max="50" step="1" value="0" style="max-width:80px"></td></tr>`)}
      </table></div>
      <div class="filters" style="margin-top:var(--space-4)">
        <label>Delivery or pickup<select name="fulfilment"><option value="delivery">Delivery</option><option value="pickup">Pickup</option></select></label>
        <label>Time<select name="time"></select></label>
        <label class="deliv">Delivery fee (MVR)<input name="fee" inputmode="decimal" value="${dd.delivery_fee_male_mvr}"></label>
      </div>
      <p class="hint deliv">Malé is ${mvr(dd.delivery_fee_male_mvr)}, outside Malé ${mvr(dd.delivery_fee_outside_male_mvr)}.</p>
      <label class="deliv">Where to deliver<textarea name="address" maxlength="500" placeholder="House, street, island; or the boat and time"></textarea></label>
      <label>Notes <span class="muted">(optional)</span><textarea name="notes" maxlength="500"></textarea></label>
      <label class="row" style="margin-top:var(--space-4)" id="cod-row"><input type="checkbox" name="cod" style="width:auto"> 💵 Cash on delivery (collect when delivering)</label>
      <label class="row" style="margin-top:var(--space-2)"><input type="checkbox" name="free" style="width:auto"> Give away (free, no payment)</label>
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
    const bakes = day?.bakes ?? [], open = bakes.filter((b) => b.available), wasBake = f.bake.value;
    render(f.bake, html`${bakes.map((b) => html`<option value="${b.bake}" ${b.available ? "" : "disabled"}>${b.label}${b.available ? "" : " (sold out)"}</option>`)}`);
    f.bake.value = (open.find((b) => b.bake === wasBake) ?? open[0])?.bake ?? "";
    const batch = bakes.find((b) => b.bake === f.bake.value);
    render($("#no-err"), !days.length ? html`<div class="notice bad">No day is open for orders right now.</div>`
      : !open.length ? html`<div class="notice bad">No batch is open on this day.</div>` : html``);
    for (const tr of rows()) tr.querySelector(".left")!.textContent = String(batch?.products[tr.dataset.p!] ?? 0);
    const free = f.free.checked, deliv = f.fulfilment.value === "delivery";
    const times = (deliv ? batch?.delivery_times : batch?.pickup_times) ?? [], was = f.time.value;
    render(f.time, html`<option value="">No set time</option>${times.map((t) => html`<option value="${t.value}">${t.label}</option>`)}`);
    f.time.value = times.some((t) => t.value === was) ? was : "";
    $("#why").hidden = !free;
    $("#cod-row").hidden = free;
    f.querySelectorAll<HTMLElement>(".deliv").forEach((el) => (el.hidden = !deliv));
    const price = new Map((products as { id: string; price_mvr: string }[]).map((p) => [p.id, laari(p.price_mvr)]));
    const buns = items().reduce((a, i) => a + i.qty, 0);
    const total = free ? 0 : items().reduce((a, i) => a + (price.get(i.product_id) ?? 0) * i.qty, 0) + (deliv && buns ? laari(f.fee.value || "0") : 0);
    render($("#sum"), html`${buns} buns · <b>${free ? "Free (giveaway)" : mvr(total / 100)}</b>${free ? "" : f.cod.checked ? " · 💵 collected in cash on delivery" : " · waits for payment until you mark it paid"}`);
  };
  f.addEventListener("input", refresh);
  f.addEventListener("change", refresh);
  refresh();
  customerSuggestions(f);
  f.onsubmit = async (e) => {
    e.preventDefault();
    const btn = f.querySelector<HTMLButtonElement>("button.primary")!;
    btn.disabled = true;
    try {
      const deliv = f.fulfilment.value === "delivery";
      const r = await call("/admin/create-order", {
        name: (f.elements.namedItem("name") as HTMLInputElement).value, phone: f.phone.value, delivery_date: f.delivery_date.value, bake: f.bake.value, items: items(), fulfilment: f.fulfilment.value, time: f.time.value || null,
        ...(deliv ? { address: f.address.value || null, delivery_fee_mvr: f.fee.value } : {}),
        notes: f.notes.value || null, ...(f.free.checked ? { free: true, free_reason: f.free_reason.value } : f.cod.checked ? { cod: true } : {}),
      });
      go({ order: r.public_id });
    } catch (err) {
      render($("#no-err"), html`<div class="notice bad">${(err as Error).message}</div>`);
      btn.disabled = false;
    }
  };
}

/** Past customers while typing a name or phone. The list floats over the form and fills nothing unless one is picked;
 *  Enter only picks one after the arrow keys moved to it, so typing a new customer works as if it weren't there. */
function customerSuggestions(f: HTMLFormElement) {
  for (const input of [f.elements.namedItem("name"), f.phone] as HTMLInputElement[]) {
    const list = document.createElement("div");
    list.className = "sug";
    list.hidden = true;
    list.setAttribute("role", "listbox");
    input.after(list);
    let timer: number | undefined, seq = 0, active = -1;
    const close = () => { list.hidden = true; active = -1; seq++; };
    const options = () => [...list.querySelectorAll<HTMLElement>("button")];
    const pick = (b: HTMLElement) => {
      (f.elements.namedItem("name") as HTMLInputElement).value = b.dataset.name!;
      f.phone.value = b.dataset.phone!;
      close();
    };
    input.addEventListener("input", () => {
      clearTimeout(timer);
      const term = input.value.trim(), mine = ++seq;
      active = -1;
      if (term.length < 2) return void (list.hidden = true);
      timer = setTimeout(async () => {
        const { customers } = await call(`/admin/customer-search?q=${encodeURIComponent(term)}`).catch(() => ({ customers: [] }));
        if (mine !== seq) return; // typed on, or left the field
        render(list, html`${customers.map((c: { name: string; phone: string }) => html`<button type="button" tabindex="-1" role="option" data-name="${c.name}" data-phone="${c.phone}"><b>${c.name}</b> <span class="muted">${c.phone}</span></button>`)}`);
        list.hidden = !customers.length;
      }, 200);
    });
    input.addEventListener("keydown", (e) => {
      if (list.hidden) return;
      const opts = options();
      if (e.key === "Escape") close();
      else if (e.key === "Enter" && active >= 0) {
        e.preventDefault();
        pick(opts[active]);
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        active = (active + (e.key === "ArrowDown" ? 1 : opts.length - (active < 0 ? 0 : 1))) % opts.length;
        opts.forEach((b, i) => b.classList.toggle("on", i === active));
      }
    });
    input.addEventListener("blur", close);
    // mousedown, not click: picking mustn't blur the field first and close the list.
    list.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const b = (e.target as HTMLElement).closest<HTMLElement>("button");
      if (b) pick(b);
    });
  }
}

async function orderDetail(id: string) {
  const o = await call(`/admin/order?id=${encodeURIComponent(id)}`);
  shell("orders", html`
    <button class="secondary" id="back">← Orders</button>
    <h1 style="margin-top:var(--space-4)">${o.public_id} ${chip(o.status)}</h1>
    ${o.needs_review ? html`<div class="notice bad"><b>Needs review:</b> ${o.review_reason}</div>` : ""}
    ${o.on_telegram === false ? html`<div class="notice bad small"><b>The slip isn't in the Telegram group yet.</b> Trying again every minute. Last error: ${o.telegram_error ?? "–"}</div>` : ""}
    ${o.customer_message ? html`<div class="notice info small">Customer sees: ${o.customer_message}</div>` : ""}
    ${o.cod ? html`<div class="notice warn"><b>💵 Cash on delivery: collect ${mvr(o.total_mvr)}.</b>${o.status === "awaiting_payment"
      ? " The buns are held; it doesn't expire. Moving it to Delivered on the Pack tab records the cash as paid." : ""}</div>` : ""}
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
      <p class="small">${o.fulfilment === "pickup" ? "Pickup" : "Delivery"} <b>${o.delivery_date}</b>${o.time_label ? html` at <b>${o.time_label}</b>` : ""}${o.bake_label ? ` · ${o.bake_label}` : ""} · ${copyBtn(o.status_url, "Copy customer's order link")}</p>
    </div>
    <div class="card">
      <h2>🔔 Notifications</h2>
      ${o.push_devices ? html`<form id="notify-form">
        <p class="small">On for ${o.push_devices} phone${o.push_devices > 1 ? "s" : ""}. Tapping it opens their order page.</p>
        <textarea name="message" maxlength="200" required placeholder="e.g. Your buns are on the way!"></textarea>
        <div class="row" style="margin-top:var(--space-2)"><button>Send notification</button></div></form><div id="notify-err"></div>`
        : html`<p class="muted small">This customer hasn't turned on notifications.</p>`}
    </div>
    <div class="card">
      <h2>Items</h2>
      <table class="items">
        ${o.items.map((i: Record<string, string>) => html`<tr><td>${i.qty} × ${i.product_name}</td><td>${Number(i.gift_no) ? "🎁 Free" : mvr(Number(i.unit_price) * Number(i.qty))}</td></tr>`)}
        ${Number(o.delivery_fee_mvr) > 0 ? html`<tr><td>Delivery</td><td>${mvr(o.delivery_fee_mvr)}</td></tr>` : ""}
        <tr class="total"><td>Total</td><td>${mvr(o.total_mvr)}</td></tr>
        ${o.currency === "USD" ? html`<tr class="total"><td>Customer pays in USD</td><td>USD ${o.total_usd}</td></tr>` : ""}
      </table>
      ${o.free_left ? html`<details style="margin-top:var(--space-3)"><summary>Add free buns</summary>
        <form id="free" class="filters" style="margin-top:var(--space-2)">
          <label>Bun<select name="product_id">${o.free_left.map((b: { id: string; name: string; left: number }) => html`<option value="${b.id}" ${b.left ? "" : "disabled"}>${b.name} (${b.left} left)</option>`)}</select></label>
          <label>How many<input name="qty" type="number" min="1" max="50" step="1" value="1" required></label>
          <label>Who or what for?<input name="reason" maxlength="300" required placeholder="e.g. birthday gift"></label>
          <div class="row"><button>Add free</button></div>
        </form>
        <p class="hint">They come out of what's left for that day. The order's total stays the same.</p>
        <div id="free-err"></div></details>` : ""}
    </div>
    <div class="card">
      <h2>Payment</h2>
      <div class="kv"><span>Reference</span><b>${o.payment_reference ?? "—"}</b></div>
      <div class="kv"><span>Bank received</span><b>${o.paid_amount ? (o.currency === "USD" ? `USD ${o.paid_amount}` : mvr(o.paid_amount)) : "—"}</b></div>
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
  const nf = document.querySelector<HTMLFormElement>("#notify-form");
  if (nf) nf.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await call("/admin/notify", { id: o.public_id, message: nf.message.value });
      await orderDetail(o.public_id);
    } catch (err) {
      render($("#notify-err"), html`<div class="notice bad">${(err as Error).message}</div>`);
    }
  };
  const free = document.querySelector<HTMLFormElement>("#free");
  if (free) free.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await call("/admin/add-free", { id: o.public_id, product_id: free.product_id.value, qty: Number(free.qty.value), reason: free.reason.value });
      await orderDetail(o.public_id);
    } catch (err) {
      render($("#free-err"), html`<div class="notice bad">${(err as Error).message}</div>`);
    }
  };
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
    product_id: string; product_name: string; linked: boolean; planned: number | null; baked: number; leftover: number;
    paid: number; checking: number; unpaid: number; preorders: number; extras: number;
  };
  const isToday = date === maleToday();
  const [r, lo] = await Promise.all([call(`/admin/production?date=${date}`), isToday ? call("/admin/leftovers") : null]);
  type Bake = { bake: string; label: string; products: Row[] };
  const bakes = r.bakes as Bake[];
  const sum = (rows: Row[], k: keyof Row) => rows.reduce((a, p) => a + Number(p[k] ?? 0), 0);
  // Buns customers can still order as extras: what's baked (or planned, whichever is higher) and leftovers put on sale, minus all orders.
  const left = (p: Row) => Math.max(0, Math.max(p.planned ?? 0, p.baked) + p.leftover - p.preorders - p.extras);
  const icon = (bake: string) => bake === "10:00" ? "☀️ " : bake === "16:00" ? "🌇 " : "";
  const section = (b: Bake) => {
    const rows = b.products, leftover = sum(rows, "leftover");
    return html`<section style="margin-top:var(--space-5)">
      <h3>${icon(b.bake)}${b.label}</h3>
      <form class="bake-plan" data-bake="${b.bake}"><div class="scroll"><table class="list">
        <tr><th>Bun</th><th>Baking</th><th>Baked</th>${leftover ? html`<th>Leftovers</th>` : ""}<th>Pre-orders</th><th>Extras sold</th><th>Extras left</th><th>Paid</th><th>Checking</th><th>Not paid</th></tr>
        ${rows.map((p) => html`<tr>
          <td>${p.product_name}</td>
          <td>${p.linked ? html`<input name="${p.product_id}" type="number" min="0" step="1" value="${p.planned ?? ""}" placeholder="–" style="max-width:80px">` : html`<span class="muted small">not in bot</span>`}</td>
          <td>${p.baked || html`<span class="muted">–</span>`}</td>${leftover ? html`<td>${p.leftover}</td>` : ""}
          <td>${p.preorders}</td><td>${p.extras}</td><td><b>${left(p)}</b></td>
          <td>${p.paid}</td><td>${p.checking}</td><td class="muted">${p.unpaid}</td></tr>`)}
        <tr><td><b>Total</b></td><td>${sum(rows, "planned")}</td><td>${sum(rows, "baked")}</td>${leftover ? html`<td>${leftover}</td>` : ""}<td>${sum(rows, "preorders")}</td><td>${sum(rows, "extras")}</td>
          <td><b>${rows.reduce((a, p) => a + left(p), 0)}</b></td><td>${sum(rows, "paid")}</td><td>${sum(rows, "checking")}</td><td class="muted">${sum(rows, "unpaid")}</td></tr>
      </table></div>
      <div class="row" style="margin-top:var(--space-3);flex-wrap:wrap">
        <button>Save baking plan</button>
        <span class="small muted grow">Same plan as the Telegram bot's /plan; Baked comes from /batch. Extras left = the higher of the two, minus all orders.</span>
      </div></form>
      <div data-msg="${b.bake}"></div>
      <form class="bake-more" data-bake="${b.bake}" style="margin-top:var(--space-4)">
        <h3>Add buns just made</h3>
        <p class="small muted">How many more came out? They go on top of what's there now, so customers can order them straight away.</p>
        <div class="row" style="flex-wrap:wrap">
          ${rows.filter((p) => p.linked).map((p) => html`<label>${p.product_name}<input name="${p.product_id}" type="number" min="1" step="1" placeholder="0" style="max-width:80px"></label>`)}
          <button>Add</button>
        </div>
      </form>
    </section>`;
  };
  shell("production", html`
    <div class="filters">
      <label>Day<input type="date" id="d" value="${date}"></label>
    </div>
    ${lo ? leftoversCard(lo) : ""}
    <h2>${r.label}</h2>
    <p>Deliveries: <b>${r.deliveries} of ${r.settings.delivery_max_orders}</b> · Pre-orders: <b>${bakes.reduce((a, b) => a + sum(b.products, "preorders"), 0)} of ${r.settings.preorder_max_buns}</b> buns
      <span class="muted small">(limits are in Days → Ordering settings)</span></p>
    ${bakes.map(section)}
    <div id="prod-msg"></div>
    <p class="small muted" style="margin-top:var(--space-3)">Paid = paid or delivered. Checking = waiting for the bank. Cancelled and rejected orders are left out.</p>`);
  // Saved messages show under the batch they're about; the leftovers and day messages at the bottom.
  const msg = (m: string, ok = false, bake = "") => render(bake ? app.querySelector<HTMLElement>(`[data-msg="${bake}"]`)! : $("#prod-msg"), html`<div class="notice ${ok ? "ok" : "bad"} small" style="margin-top:var(--space-3)">${m}</div>`);
  $<HTMLInputElement>("#d").onchange = (e) => go({ tab: "production", date: (e.target as HTMLInputElement).value });
  const leftForm = $<HTMLFormElement>("#leftovers");
  if (leftForm) {
    leftForm.onsubmit = async (e) => {
      e.preventDefault();
      const lines = [...leftForm.querySelectorAll<HTMLInputElement>("input[type=number]")].map((i) => ({ product_id: i.name, available: Number(i.value) }));
      const given = lo.buns.reduce((a: number, b: { product_id: string; left: number }) => a + b.left - (lines.find((l) => l.product_id === b.product_id)?.available ?? 0), 0);
      if (given && !confirm(`${given} ${given === 1 ? "bun" : "buns"} not put on sale will count as given away. Continue?`)) return;
      try {
        await call("/admin/leftovers", { lines });
        await production(date);
        msg("Leftovers are on sale today.", true);
      } catch (err) {
        msg((err as Error).message);
      }
    };
  }
  const openToday = $("#open-today");
  if (openToday) {
    openToday.onclick = async () => {
      try {
        await call("/admin/day", { date, off: false });
        await production(date);
      } catch (err) {
        msg((err as Error).message);
      }
    };
  }
  for (const b of bakes) {
    const plan = app.querySelector<HTMLFormElement>(`form.bake-plan[data-bake="${b.bake}"]`)!;
    plan.onsubmit = async (e) => {
      e.preventDefault();
      const lines = [...plan.querySelectorAll<HTMLInputElement>("input[type=number]")]
        .filter((i) => i.value !== "").map((i) => ({ product_id: i.name, qty: Number(i.value) }));
      if (!lines.length) return msg("Enter how many of each bun you're baking.", false, b.bake);
      const short = b.products.find((p) => lines.some((l) => l.product_id === p.product_id && l.qty < p.preorders));
      if (short && !confirm(`${short.product_name}: that's fewer than the ${short.preorders} pre-ordered. Save anyway?`)) return;
      try {
        await call("/admin/plan", { date, bake: b.bake, lines });
        await production(date);
        msg(`${b.label} plan saved.`, true, b.bake);
      } catch (err) {
        msg((err as Error).message, false, b.bake);
      }
    };
    const more = app.querySelector<HTMLFormElement>(`form.bake-more[data-bake="${b.bake}"]`)!;
    more.onsubmit = async (e) => {
      e.preventDefault();
      // On top of the higher of planned and baked: that's what the stock is counted from.
      const lines = [...more.querySelectorAll<HTMLInputElement>("input[type=number]")]
        .filter((i) => Number(i.value) > 0).map((i) => {
          const p = b.products.find((x) => x.product_id === i.name)!;
          return { product_id: i.name, qty: Math.max(p.planned ?? 0, p.baked) + Math.floor(Number(i.value)) };
        });
      if (!lines.length) return msg("Enter how many more of a bun you made.", false, b.bake);
      try {
        await call("/admin/plan", { date, bake: b.bake, lines });
        await production(date);
        msg(`Added to the ${b.label}. Customers can order them now.`, true, b.bake);
      } catch (err) {
        msg((err as Error).message, false, b.bake);
      }
    };
  }
}

/** Today only: the last baking day's leftovers, counted like the Sales tab, to put on sale again at the same price. */
// deno-lint-ignore no-explicit-any
function leftoversCard(lo: any) {
  const closed = lo.closed ? html`<div class="notice warn small">Today is an off day, so customers can't order.
    <button type="button" class="copy" id="open-today">Open today</button></div>` : "";
  if (lo.done.length) {
    const given = lo.done.reduce((a: number, d: { given: number }) => a + d.given, 0);
    return html`<div class="card"><h3>Leftovers on sale today</h3>${closed}
      <p class="small">${lo.done.map((d: { name: string; available: number }) => `${d.available} ${d.name}`).join(", ")}${given ? ` · ${given} given away` : ""}</p></div>`;
  }
  if (!lo.buns.length) return closed ? html`<div class="card">${closed}</div>` : "";
  return html`<form class="card" id="leftovers">
    <h3>Left over from ${lo.from_label}</h3>
    <p class="small muted">How many of each are still good to sell today? They go on sale at the normal price. Any you don't put on sale count as given away.</p>
    ${closed}
    <div class="row" style="flex-wrap:wrap">
      ${lo.buns.map((b: { product_id: string; name: string; left: number }) => html`<label>${b.name} <span class="muted small">(${b.left} left)</span>
        <input name="${b.product_id}" type="number" min="0" max="${b.left}" step="1" value="${b.left}" required style="max-width:90px"></label>`)}
    </div>
    <button style="margin-top:var(--space-3)">Put on sale today</button>
  </form>`;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const dayNames = (w: number[]) => w.length ? w.map((d) => WEEKDAYS[d]).join(", ") : "none";

async function days() {
  type Day = { date: string; label: string; off: "weekly" | "one_time" | null; opened: boolean; booked: number };
  const r = await call("/admin/days");
  const [now, ...later] = r.weekly as { from: string; label: string; weekdays: number[] }[];
  const editing = (later.at(-1) ?? now).weekdays;
  const st = r.settings;
  const clock = (t: string) => { const [h, m] = t.split(":").map(Number); return `${h % 12 || 12}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "AM" : "PM"}`; };
  shell("days", html`
    <div class="card">
      <h2>Pause delivery</h2>
      ${st.delivery_paused_until ? html`
        <p>Delivery is paused until <b>${clock(st.delivery_paused_until)}</b> today. Customers can still order: delivery times start after ${clock(st.delivery_paused_until)}, and pickup is as usual.</p>
        <div class="row"><button id="pause-off">Resume delivery now</button><span id="pause-msg" class="small"></span></div>`
      : st.pause_times.length ? html`
        <p class="hint">For a few hours today, e.g. when no one can deliver. Customers can still order: they see delivery times from when the pause ends, and pickup as usual. It ends by itself.</p>
        <div class="row" style="flex-wrap:wrap"><label class="row" style="margin:0">Until <select id="pause-until" style="width:auto">${st.pause_times.map((t: string) => html`<option value="${t}">${clock(t)}</option>`)}</select></label>
          <button id="pause-on">Pause delivery</button><span id="pause-msg" class="small"></span></div>`
      : html`<p class="hint">Delivery can be paused for a few hours during the day.</p>`}
    </div>
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
        <label>USD rate (MVR per USD; blank = no USD)<input name="usd_rate" inputmode="decimal" placeholder="e.g. 15.42" value="${st.usd_rate ?? ""}"></label>
      </div>
      <p class="hint">With a USD rate, customers can choose to pay in USD: the order total ÷ the rate, rounded up to the next 0.50, into the USD account. Changing it doesn't change orders already placed.</p>
      <label>Pickup address (shown to customers who pick up)<textarea name="pickup_place" maxlength="300">${st.pickup_place}</textarea></label>
      <label>Phone they call when they come<input name="pickup_phone" type="tel" value="${st.pickup_phone}"></label>
      <label>WhatsApp number for signup codes (open in WhatsApp Web with the codes extension)<input name="whatsapp_phone" type="tel" value="${st.whatsapp_phone ?? ""}"></label>
      <label>Pickup location on the map</label>
      <p class="hint">Tap the map to put the pin. Customers get a link that opens it in Google Maps.</p>
      <div id="pickup-map" class="map" aria-label="Map: tap to put the pickup pin"></div>
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
  const pause = async (until: string | null) => {
    try {
      await call("/admin/config", { delivery_paused_until: until });
      await days();
    } catch (e) {
      $("#pause-msg").textContent = (e as Error).message;
    }
  };
  if (st.delivery_paused_until) $("#pause-off").onclick = () => pause(null);
  else if (st.pause_times.length) $("#pause-on").onclick = () => pause($<HTMLSelectElement>("#pause-until").value);
  let pickupPin: Pin | undefined;
  pinPicker($("#pickup-map"), st.pickup_pin, (p) => (pickupPin = { lat: p.lat, lng: p.lng }))
    .catch(() => render($("#pickup-map"), html`<div class="notice bad">The map didn't load. Please refresh the page.</div>`));
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
        usd_rate: (f.elements.namedItem("usd_rate") as HTMLInputElement).value,
        pickup_place: (f.elements.namedItem("pickup_place") as HTMLTextAreaElement).value,
        pickup_phone: (f.elements.namedItem("pickup_phone") as HTMLInputElement).value,
        ...((f.elements.namedItem("whatsapp_phone") as HTMLInputElement).value ? { whatsapp_phone: (f.elements.namedItem("whatsapp_phone") as HTMLInputElement).value } : {}),
        ...(pickupPin ? { pickup_pin: pickupPin } : {}),
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

// ── Invoices: normal (a customer pays the prices on it) or shop (sale or return, the shop keeps its margin) ──

const laari = (s: string) => Math.round(Number(s) * 100);
const INV_CHIP: Record<string, string> = { unpaid: "awaiting_bank", paid: "paid", void: "cancelled" };

async function invoices() {
  const r = await call("/admin/invoices");
  shell("invoices", html`
    <div class="row between" style="margin-bottom:var(--space-4)">
      <p class="muted" style="margin:0">Invoices with a QR code to pay. Shop invoices: the shop pays for what it sold, minus its profit per bun.</p>
      <button id="new-inv">New invoice</button>
    </div>
    <div class="scroll"><table class="list">
      <tr><th>Invoice</th><th>Date</th><th>To</th><th>Amount due</th><th>Status</th></tr>
      ${r.invoices.map((i: Record<string, string>) => html`
        <tr data-inv="${i.number}"><td><b>${i.number}</b></td><td>${i.invoice_date}</td><td>${i.shop_name}${i.kind === "shop" ? html` <span class="muted small">(shop)</span>` : ""}</td>
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
      <h1>New invoice</h1>
      <div class="row" style="flex-wrap:wrap;gap:var(--space-4)">
        <label style="display:flex;gap:var(--space-2);align-items:center;margin:0;white-space:nowrap"><input type="radio" name="kind" value="normal" checked style="width:auto"> Normal</label>
        <label style="display:flex;gap:var(--space-2);align-items:center;margin:0;white-space:nowrap"><input type="radio" name="kind" value="shop" style="width:auto"> Shop (sale or return)</label>
      </div>
      <div class="filters">
        <label><span id="to-label">Bill to</span><input name="shop_name" list="shops" required maxlength="100" placeholder="Customer or company"></label>
        <label>Invoice date<input name="invoice_date" type="date" required value="${today}"></label>
        <label id="margin-field">Shop's profit per bun sold (MVR)<input name="margin" inputmode="decimal" value="5"></label>
      </div>
      <datalist id="shops">${(shops as string[]).map((s) => html`<option value="${s}">`)}</datalist>
      <div class="scroll"><table class="list" style="margin-top:var(--space-4)">
        <tr><th>Bun</th><th>Price (MVR)</th><th id="sold-head">Paid</th><th>Free</th></tr>
        ${list.map((p) => html`<tr data-p="${p.id}"><td>${p.name}</td>
          <td><input name="price" inputmode="decimal" value="${p.price_mvr}" style="max-width:90px"></td>
          <td><input name="sold" type="number" min="0" step="1" value="0" style="max-width:80px"></td>
          <td><input name="free" type="number" min="0" step="1" value="0" style="max-width:80px"></td></tr>`)}
      </table></div>
      <p class="hint">Free = listed on the invoice at no charge.</p>
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
  const shop = () => f.kind.value === "shop";
  const sum = () => {
    $("#margin-field").style.display = shop() ? "" : "none";
    $("#to-label").textContent = shop() ? "Shop" : "Bill to";
    $("#sold-head").textContent = shop() ? "Sold" : "Paid";
    const m = shop() ? laari(f.margin.value || "0") : 0;
    let sold = 0, free = 0, sales = 0, due = 0;
    for (const l of read()) {
      sold += l.sold; free += l.free;
      sales += laari(l.unit_price) * l.sold; due += (laari(l.unit_price) - m) * l.sold;
    }
    render($("#sum"), !shop() ? html`${sold} paid, ${free} free · <b>Total ${mvr(sales / 100)}</b>` : html`${sold} sold, ${free} free · Sales ${mvr(sales / 100)} · Shop keeps ${mvr((sales - due) / 100)} · <b>Shop pays us ${mvr(due / 100)}</b>`);
  };
  f.addEventListener("input", sum);
  sum();
  f.onsubmit = async (e) => {
    e.preventDefault();
    const btn = f.querySelector<HTMLButtonElement>("button.primary")!;
    btn.disabled = true;
    try {
      const r = await call("/admin/invoice", {
        kind: f.kind.value, shop_name: f.shop_name.value, invoice_date: f.invoice_date.value, shop_margin_mvr: f.margin.value,
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
      ${v.kind === "normal" ? html`<div class="scroll"><table class="list">
        <tr><th>Bun</th><th>Qty</th><th>Price</th><th style="text-align:right">Amount</th></tr>
        ${v.lines.filter((l: { sold: number }) => l.sold).map((l: { product_name: string; sold: number; unit_price: string }) => html`<tr>
          <td>${l.product_name}</td><td>${l.sold}</td><td>${mvr(l.unit_price)}</td><td style="text-align:right">${mvr(laari(l.unit_price) * l.sold / 100)}</td></tr>`)}
        ${v.lines.filter((l: { free: number }) => l.free).map((l: { product_name: string; free: number }) => html`<tr>
          <td>${l.product_name} <span class="muted">(free)</span></td><td>${l.free}</td><td>–</td><td style="text-align:right">${mvr(0)}</td></tr>`)}
      </table></div>
      <table class="items" style="margin-top:var(--space-4);max-width:340px;margin-left:auto">
        <tr><td>Buns</td><td>${v.totals.sold}</td></tr>
        ${v.totals.free ? html`<tr><td>Free buns</td><td>${v.totals.free}</td></tr>` : ""}
        <tr class="total"><td>Amount due</td><td>${mvr(v.totals.due)}</td></tr>
      </table>` : html`<div class="scroll"><table class="list">
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
      </table>`}
      ${v.notes ? html`<p style="margin-top:var(--space-4)">${v.notes}</p>` : ""}
      <div class="row" style="margin-top:var(--space-5);align-items:center;flex-wrap:wrap">
        ${v.qr ? html`<div class="paymv">${raw(qrSvg(v.qr))}<div class="small">Scan with the BML app to pay ${mvr(v.totals.due)}</div></div>` : ""}
        <p class="small grow" style="margin:0"><b>Please pay by bank transfer</b><br>
          ${v.qr ? "Scan the QR code with the BML app, or transfer to:" : ""}<br>
          ${v.bank.bank} · ${v.bank.account_name} · ${v.bank.account_number}</p>
      </div>
    </div>`);
  $("#back").onclick = () => go({ tab: "invoices" });
  $("#print").onclick = () => {
    // The saved PDF is named after the page title.
    const t = document.title;
    document.title = `Alina Bun ${v.number} ${v.shop_name}`;
    print();
    document.title = t;
  };
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
  const [r, p] = await Promise.all([call(`/admin/customers?sort=${sort}`), call("/admin/push")]);
  shell("customers", html`
    <details class="card"><summary><b>🔔 Notifications on: ${p.customers.length}</b></summary>
      <div class="scroll"><table class="list">
        <tr><th>Name</th><th>Phone</th><th>Phones</th><th>Since</th><th>Latest order</th></tr>
        ${p.customers.map((c: { name: string | null; phone: string; devices: string[]; verified: boolean; since: string; last_order: string | null }) => html`<tr>
          <td>${c.name ?? "—"}${c.verified ? " ✓" : ""}</td><td>${c.phone}</td><td>${c.devices.join(", ")}</td><td>${when(c.since)}</td>
          <td>${c.last_order ? html`<a href="?order=${c.last_order}">${c.last_order}</a>` : "—"}</td></tr>`)}
      </table></div>
      <p class="hint">✓ = account verified on WhatsApp. To send one, open their order and use Send notification.</p></details>
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
const tile = (label: string, value: unknown, sub: unknown = "", delta: unknown = "") =>
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
  // MVR orders only: USD money isn't in revenue.
  const orderAvg = (x: Sales) => (x.orders - x.usd_orders ? (x.revenue - x.shop_revenue) / (x.orders - x.usd_orders) : 0);
  const usd = (x: Sales) => x.revenue_usd ? `+ USD ${x.revenue_usd.toFixed(2)}` : "";
  const sub = (...parts: string[]) => parts.filter(Boolean).join(" · ");
  const mix: [string, number][] = [["Website", m.web], ["Instagram and phone (entered by managers)", m.manager], ["Shops", m.shop]];
  salesShell("", html`
    <div class="filters">
      <label>Day<input type="date" id="d" value="${r.day}" max="${r.today}"></label>
      ${isToday ? "" : html`<button class="secondary" id="today" type="button">Today</button>`}
    </div>

    <h2>${r.label}${isToday ? " · today" : ""}</h2>
    <p class="small muted">Arrows compare with ${dayName(lw.day)}, a week before. Orders count on their delivery day.</p>
    <div class="kpis">
      ${tile("Buns sold", num(t.sold), t.given ? `+ ${t.given} given away` : "", change(t.sold, lw.sold))}
      ${tile("Revenue", money(t.revenue), sub(t.fees ? `incl. ${money(t.fees)} delivery` : "", usd(t)), change(t.revenue, lw.revenue))}
      ${tile("Orders", num(t.orders), t.orders ? `avg ${money(orderAvg(t))}` : "", change(t.orders, lw.orders))}
      ${tile("Left over", t.made ? num(t.left) : "–", t.made ? (t.left ? `${pct(t.left, t.made)}% of ${t.made} made` : `all ${t.made} made went out`) : "nothing planned or baked")}
      ${t.unpaid || t.unpaid_mvr || t.unpaid_usd ? tile("Not paid yet", money(t.unpaid_mvr), sub(`${t.unpaid} buns`, t.unpaid_usd ? `+ USD ${t.unpaid_usd.toFixed(2)}` : "")) : ""}
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
      ${tile("Revenue", money(m.revenue), sub(m.fees ? `incl. ${money(m.fees)} delivery` : "", usd(m)), change(m.revenue, pm.revenue))}
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
        <p class="small">Not paid yet: <b>${money(m.unpaid_mvr)}</b>${m.unpaid_usd ? html` + <b>USD ${m.unpaid_usd.toFixed(2)}</b>` : ""} <span class="muted">(${m.unpaid} buns: orders waiting for payment or the bank, unpaid shop invoices)</span></p>
        <p class="small">Didn't go through: <b>${m.lost_orders}</b> ${m.lost_orders === 1 ? "order" : "orders"}, ${m.lost_buns} buns
          <span class="muted">(${m.expired} not paid in time, ${m.lost_orders - m.expired} cancelled or rejected)</span></p>
      </div>
    </div>

    <div class="card">
      <h3>Month by month</h3>
      <div class="scroll"><table class="list">
        <tr><th>Month</th><th>Buns sold</th><th>Revenue</th><th style="width:30%"></th><th>Orders</th><th>Left over</th></tr>
        ${r.months.map((x: Sales) => html`<tr data-id="${x.month}" class="${x.month === r.month ? "on" : ""}"><td>${monthName(x.month, "short")}</td><td><b>${num(x.sold)}</b></td>
          <td>${money(x.revenue)}${x.revenue_usd ? html`<div class="small muted">+ USD ${x.revenue_usd.toFixed(2)}</div>` : ""}</td><td><div class="hbar">${x.revenue ? html`<i class="v-sold" style="width:${(x.revenue / monthMax) * 100}%"></i>` : ""}</div></td>
          <td>${num(x.orders)}</td><td>${x.made ? `${num(x.left)} (${pct(x.left, x.made)}%)` : "–"}</td></tr>`)}
      </table></div>
      <p class="small muted" style="margin-top:var(--space-2)">This month so far. Tap a month to open it.</p>
    </div>
    <p class="small muted">Sold = paid orders and paid shop invoices (shops by invoice day, after their share). Made = the higher of the
      baking plan and what the bot logged as baked. Buns sold some other way show up as left over.
      Revenue is MVR; orders paid in USD are shown apart (+ USD), never converted, and their buns count as sold.</p>`);

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

// ── Sales: inner tabs ──

const SALES_VIEWS: [string, string][] = [["", "Overview"], ["profit", "Profit"], ["costs", "Costs"], ["expenses", "Expenses"], ["stock", "Stock"], ["demand", "Demand"], ["customers", "Customers"]];
/** The Sales tab's inner tabs, on top of every Sales view. */
function salesShell(view: string, body: Raw) {
  shell("sales", html`<nav class="subtabs">${SALES_VIEWS.map(([k, l]) => html`<button class="${view === k ? "on" : ""}" data-view="${k}">${l}</button>`)}</nav>${body}`);
  app.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((b) => (b.onclick = () => go({ tab: "sales", view: b.dataset.view! })));
}

const CATEGORY_LABELS: Record<string, string> = {
  ingredients: "Ingredients", packaging: "Packaging", equipment: "Equipment", transport: "Transport",
  utilities: "Utilities", rent: "Rent", wages: "Wages", other: "Other",
};
const CATEGORIES = Object.keys(CATEGORY_LABELS);
type Unit = "g" | "ml" | "pc";
interface Cat { category: string; amount: number }

/** 250 g, 1.8 kg, 500 ml, 8 L, 30 pieces. */
function qty(n: number, unit: Unit): string {
  const sign = n < 0 ? "-" : "";
  const a = Math.abs(n);
  const trim = (x: number) => x.toFixed(1).replace(/\.0$/, "");
  if (unit === "pc") return `${sign}${trim(a)}`;
  return a >= 1000 ? `${sign}${trim(a / 1000)} ${unit === "g" ? "kg" : "L"}` : `${sign}${trim(a)} ${unit}`;
}
/** A price per unit, written like `per` in the API: per kg or per L, or each. */
const perUnit = (price: number, unit: Unit) => (unit === "pc" ? `${money(price)} each` : `${money(price * 1000)} / ${unit === "g" ? "kg" : "L"}`);

/** One bar per category against the total. */
function catBars(list: Cat[], total: number) {
  if (!list.length) return html`<p class="muted">Nothing yet.</p>`;
  return list.map((c: Cat) => barRow(CATEGORY_LABELS[c.category] ?? c.category, html`<b>${money(c.amount)}</b> · ${pct(c.amount, total)}%`, c.amount, total));
}

/** A row with data-id opens the hidden row right under it on click, Enter or Space. */
function toggleRows() {
  app.querySelectorAll<HTMLTableRowElement>("tr[data-id]").forEach((tr) => {
    tr.tabIndex = 0;
    const flip = () => {
      const d = tr.nextElementSibling as HTMLElement | null;
      if (d) d.hidden = !d.hidden;
    };
    tr.onclick = (e) => {
      if (!(e.target as Element).closest("select, button, input")) flip();
    };
    tr.onkeydown = (e) => {
      if (e.target !== tr || (e.key !== "Enter" && e.key !== " ")) return;
      e.preventDefault();
      flip();
    };
  });
}

// Profit

interface Period {
  from: string; to: string; label: string; sales: number; fees: number; usd: number; spent: number;
  by_category: Cat[]; profit: number; made: number; sold: number; food_used: number; food_bought: number;
}

function periodTable(list: Period[], first: string) {
  return html`<div class="scroll"><table class="list">
    <tr><th>${first}</th><th>Sales</th><th>Delivery</th><th>Spent</th><th>Profit</th><th>Buns sold</th><th>Food used</th><th>Food bought</th></tr>
    ${list.map((x: Period) => html`<tr><td>${x.label}</td><td>${money(x.sales)}</td><td>${money(x.fees)}</td><td>${money(x.spent)}</td>
      <td><b class="${x.profit < 0 ? "neg" : ""}">${money(x.profit)}</b></td><td>${num(x.sold)}</td><td>${money(x.food_used)}</td><td>${money(x.food_bought)}</td></tr>`)}
  </table></div>`;
}

async function profit() {
  const r: { since: string | null; weeks: Period[]; months: Period[] } = await call("/admin/profit");
  const w = r.weeks[0];
  if (!r.since || !w) return salesShell("profit", html`<div class="notice info">No expenses logged yet. Post receipts and notes in the expenses chat on Telegram.</div>`);
  const pw: Partial<Period> = r.weeks[1] ?? {};
  const m0 = r.months[0];
  const inMoney = w.sales + w.fees, inPrev = (pw.sales ?? 0) + (pw.fees ?? 0);
  salesShell("profit", html`
    <h2>This week · ${w.label}</h2>
    <div class="kpis">
      ${tile("Money in", money(inMoney), w.fees ? `incl. ${money(w.fees)} delivery fees` : "", change(inMoney, inPrev))}
      ${tile("Spent", money(w.spent), w.by_category[0] ? CATEGORY_LABELS[w.by_category[0].category] ?? w.by_category[0].category : "", change(w.spent, pw.spent ?? 0, false))}
      ${tile("Profit", html`<span class="${w.profit < 0 ? "neg" : ""}">${money(w.profit)}</span>`, "", change(w.profit, pw.profit ?? 0))}
      ${tile("Buns sold", num(w.sold), `${w.made} made`, change(w.sold, pw.sold ?? 0))}
      ${tile("Food per bun", money(w.made ? w.food_used / w.made : 0), "at today's prices", change(w.made ? w.food_used / w.made : 0, pw.made ? (pw.food_used ?? 0) / pw.made : 0, false))}
    </div>
    <div class="card"><h3>Week by week</h3>${periodTable(r.weeks, "Week")}</div>
    <div class="card"><h3>Month by month</h3>${periodTable(r.months, "Month")}</div>
    ${m0 ? html`<div class="card"><h3>Where the money went · ${m0.label}</h3>${catBars(m0.by_category, m0.spent)}</div>` : ""}
    <p class="small muted">Sales are paid orders without delivery fees, plus paid shop invoices. Spent is everything posted
      in the expenses chat, on the day it was posted. Food used is what the buns made should have used, from the recipes at
      today's prices: food bought above it is stock on the shelf, or waste. USD payments are left out.</p>`);
}

// Costs

type Ingredient = {
  id: string; name: string; unit: Unit; price: number | null; per: string; source: "receipt" | "estimate" | null;
  last: { date: string; shop: string | null; qty: number; amount: number } | null;
  history: { date: string; shop: string | null; qty: number; amount: number; price: number }[];
  used_in: string[];
};
type Product = {
  product_id: string; name: string; price: number; cost: number; margin: number; margin_pct: number;
  parts: { recipe_id: string; name: string; yield: number; cost: number }[]; missing: string[];
};

async function costs() {
  const r: { products: Product[]; no_recipe: string[]; ingredients: Ingredient[] } = await call("/admin/costs");
  salesShell("costs", html`
    <div class="card">
      <h3>Cost per bun</h3>
      ${r.products.length ? html`<div class="scroll"><table class="list">
        <tr><th>Bun</th><th>Price</th><th>Ingredients</th><th>You keep</th><th style="width:30%">Margin</th></tr>
        ${r.products.map((p: Product, i: number) => html`<tr data-id="p${i}"><td>${p.name}</td><td>${money(p.price)}</td><td>${money(p.cost)}</td>
          <td class="${p.margin < 0 ? "neg" : ""}">${money(p.margin)}</td>
          <td><b>${p.margin_pct}%</b><div class="hbar"><i class="v-sold" style="width:${Math.max(0, Math.min(100, p.margin_pct))}%"></i></div></td></tr>
          <tr hidden><td colspan="5">
            ${p.parts.map((x: Product["parts"][number]) => html`<div class="small">${x.name} · 1/${x.yield} of a batch · ${money(x.cost)}</div>`)}
            ${p.missing.length ? html`<div class="small"><span class="chip awaiting_bank">no price yet</span> ${p.missing.join(", ")}</div>` : ""}
          </td></tr>`)}
      </table></div>` : html`<p class="muted">No buns with recipes yet.</p>`}
      ${r.no_recipe.length ? html`<p class="small muted">No recipe yet: ${r.no_recipe.join(", ")}</p>` : ""}
    </div>
    <div class="card">
      <h3>Ingredient prices</h3>
      <div class="scroll"><table class="list">
        <tr><th>Ingredient</th><th>Price</th><th>From</th><th>Last bought</th><th>Used in</th></tr>
        ${r.ingredients.map((g: Ingredient, i: number) => html`<tr data-id="i${i}"><td>${g.name}</td><td>${g.per}</td>
          <td>${g.source === "receipt" ? html`<span class="chip paid">receipt</span>` : g.source === "estimate" ? html`<span class="chip awaiting_bank">estimate</span>` : "–"}</td>
          <td>${g.last ? [dayName(g.last.date), g.last.shop, `${qty(g.last.qty, g.unit)} for ${money(g.last.amount)}`].filter(Boolean).join(" · ") : "–"}</td>
          <td>${g.used_in.join(", ") || "–"}</td></tr>
          <tr hidden><td colspan="5">${g.history.length ? g.history.map((h: Ingredient["history"][number]) => html`<div class="small">${[dayName(h.date), h.shop, qty(h.qty, g.unit), money(h.amount), perUnit(h.price, g.unit)].filter(Boolean).join(" · ")}</div>`) : html`<div class="small muted">No purchases yet.</div>`}</td></tr>`)}
      </table></div>
      <p class="small muted" style="margin-top:var(--space-3)">Prices come from the latest receipt with that ingredient: photos the Mac reads every night, and typed notes.
        Estimates are web prices from November, used until a receipt comes in.</p>
    </div>`);
  toggleRows();
}

// Expenses

interface Item { name: string; qty: number; amount: number; ingredient: string | null; category: string }
interface Receipt {
  id: number; date: string; amount: number | null; amount_from: "note" | "reply" | "photo" | null; shop: string | null;
  photo: boolean; read: "read" | "not_read" | "waiting"; photo_total: number | null; check: boolean;
  category: string; category_set: boolean; note: string | null; items: Item[];
}
const AMOUNT_FROM: Record<string, string> = { note: "typed", reply: "from a reply", photo: "read off the photo" };

async function expenses(from: string, to: string) {
  const qs = new URLSearchParams(Object.entries({ from, to }).filter(([, v]) => v));
  const r: { from: string; to: string; total: number; unknown: number; categories: Cat[]; receipts: Receipt[] } = await call(`/admin/expenses?${qs}`);
  const checks = r.receipts.filter((x: Receipt) => x.check).length;
  const what = (x: Receipt) => x.shop ?? x.items[0]?.name ?? (x.note ? (x.note.length > 40 ? `${x.note.slice(0, 40)}…` : x.note) : "Photo");
  const readCell = (x: Receipt) => x.read === "read" ? "read" : x.read === "not_read" ? html`<span class="chip review">couldn't read</span>` : html`<span class="small muted">tonight</span>`;
  salesShell("expenses", html`
    <div class="filters">
      <label>From<input type="date" id="from" value="${r.from}" max="${maleToday()}"></label>
      <label>To<input type="date" id="to" value="${r.to}" max="${maleToday()}"></label>
      <button class="secondary" id="month" type="button">This month</button>
    </div>
    <div class="kpis">
      ${tile("Spent", money(r.total), `${r.receipts.length} receipts`)}
      ${r.unknown ? tile("No amount yet", num(r.unknown), "reply with the amount in the chat") : ""}
      ${checks ? tile("To check", num(checks), "photo and amount differ") : ""}
    </div>
    <div class="card">
      <h3>By category</h3>
      ${catBars(r.categories, r.total)}
    </div>
    <div class="card">
      <h3>Receipts</h3>
      ${r.receipts.length ? html`<div class="scroll"><table class="list">
        <tr><th>Day</th><th>What</th><th>Amount</th><th>Category</th><th>Read</th></tr>
        ${r.receipts.map((x: Receipt) => html`<tr${x.items.length ? html` data-id="${x.id}"` : ""}><td>${dayName(x.date)}</td><td>${what(x)}</td>
          <td>${x.amount === null ? html`<span class="chip review">no amount</span>` : money(x.amount)}
            ${x.amount_from ? html`<div class="small muted">${AMOUNT_FROM[x.amount_from]}</div>` : ""}
            ${x.check ? html`<div><span class="chip awaiting_bank">photo says ${money(x.photo_total ?? 0)}</span></div>` : ""}</td>
          <td><select data-cat="${x.id}" aria-label="Category">${CATEGORIES.map((c: string) => html`<option value="${c}"${c === x.category ? " selected" : ""}>${CATEGORY_LABELS[c]}</option>`)}</select>
            ${x.category_set ? "" : html`<div class="small muted">guessed</div>`}</td>
          <td>${readCell(x)}</td></tr>
          ${x.items.length ? html`<tr hidden><td colspan="5"><table class="items">
            ${x.items.map((it: Item) => html`<tr><td>${it.name}${it.qty !== 1 ? ` × ${it.qty}` : ""}</td><td>${money(it.amount)}</td>
              <td class="small muted">${it.ingredient ?? ""}</td><td class="small muted">${CATEGORY_LABELS[it.category] ?? it.category}</td></tr>`)}
          </table></td></tr>` : ""}`)}
      </table></div>` : html`<p class="muted">No receipts in these days.</p>`}
    </div>
    <p class="small muted">To change an amount, reply to the bot's message about that receipt in the expenses chat. A category you pick
      here wins over the guess from its items.</p>`);

  const fromEl = $<HTMLInputElement>("#from"), toEl = $<HTMLInputElement>("#to");
  fromEl.onchange = toEl.onchange = () => go({ tab: "sales", view: "expenses", from: fromEl.value, to: toEl.value });
  $("#month").onclick = () => go({ tab: "sales", view: "expenses" });
  toggleRows();
  app.querySelectorAll<HTMLSelectElement>("select[data-cat]").forEach((s) => {
    s.onchange = async () => {
      try {
        await call("/admin/receipt-category", { id: Number(s.dataset.cat), category: s.value });
        await expenses(r.from, r.to);
      } catch (e) {
        const n = document.createElement("div");
        n.className = "notice bad";
        n.textContent = (e as Error).message;
        $("#view").prepend(n);
      }
    };
  });
}

// Stock

async function stock(date: string) {
  const r: {
    since: string | null; date: string; planned: number; average: number; to_buy: number;
    ingredients: (Ingredient & { bought: number; used: number; left: number; per_day: number; days_left: number | null; need: number; buy: number; pack: number | null; packs: number; cost: number | null })[];
  } = await call(`/admin/stock${date ? `?date=${date}` : ""}`);
  const buys = r.ingredients.filter((g) => g.buy > 0);
  salesShell("stock", html`
    <div class="filters">
      <label>Date<input type="date" id="date" value="${r.date}"></label>
      <button class="secondary" id="tmr" type="button">Tomorrow</button>
    </div>
    ${r.since ? "" : html`<div class="notice info">No expenses logged yet, so there's no stock to count.</div>`}
    <div class="kpis">
      ${tile("Planned", r.planned ? num(r.planned) : "No plan", r.planned ? `for ${dayName(r.date)}` : `an average day is ${r.average} buns`)}
      ${tile("To buy", money(r.to_buy))}
      ${tile("Counting since", r.since ? dayName(r.since) : "–")}
    </div>
    <div class="card">
      <h3>Shopping list for ${dayName(r.date)}</h3>
      ${buys.length ? html`<div class="scroll"><table class="list">
        <tr><th>Ingredient</th><th>Need</th><th>Have</th><th>Buy</th><th>Cost</th></tr>
        ${buys.map((g) => html`<tr><td>${g.name}</td><td>${qty(g.need, g.unit)}</td><td>${qty(Math.max(g.left, 0), g.unit)}</td>
          <td><b>${qty(g.buy, g.unit)}</b>${g.packs && g.pack ? html` <small class="muted">${g.packs} × ${qty(g.pack, g.unit)}</small>` : ""}</td>
          <td>${g.cost === null ? "–" : money(g.cost)}</td></tr>`)}
      </table></div>` : html`<p class="muted">Nothing to buy for this plan.</p>`}
    </div>
    <div class="card">
      <h3>Stock</h3>
      <div class="scroll"><table class="list">
        <tr><th>Ingredient</th><th>Bought</th><th>Used</th><th>Left</th><th>Per baking day</th><th>Days left</th></tr>
        ${r.ingredients.map((g) => html`<tr><td>${g.name}</td><td>${qty(g.bought, g.unit)}</td><td>${qty(g.used, g.unit)}</td>
          <td>${g.left < 0 ? html`<span class="muted">–</span> <small class="muted">from older stock</small>` : qty(g.left, g.unit)}</td>
          <td>${qty(g.per_day, g.unit)}</td>
          <td>${g.days_left === null ? html`<span class="muted">–</span>` : g.days_left < 3 ? html`<span class="chip awaiting_bank">${g.days_left} days</span>` : `${g.days_left} days`}</td></tr>`)}
      </table></div>
    </div>
    ${r.since ? html`<p class="small muted">Bought adds up receipt lines since ${dayName(r.since)}. Used is buns made (the baking plan) × the recipes. Stock from before that isn't known, so Left can be below zero.</p>` : ""}`);

  $<HTMLInputElement>("#date").onchange = (e) => go({ tab: "sales", view: "stock", date: (e.target as HTMLInputElement).value });
  $("#tmr").onclick = () => go({ tab: "sales", view: "stock" });
}

// Demand

interface Weekday { weekday: number; name: string; days: number; avg: number; sold_out: number; buns: { product_id: string; avg: number }[] }
interface Forecast { date: string; name: string; closed: boolean; total: number; buns: { product_id: string; name: string; qty: number }[] }

async function demand() {
  const r: {
    weekdays: Weekday[]; mix: { product_id: string; name: string; sold: number; pct: number }[]; forecast: Forecast[];
    sold_out_days: number; baking_days: number; lost: { orders: number; buns: number; expired: number }; preorder_pct: number;
  } = await call("/admin/demand");
  const best = r.weekdays.reduce((a: Weekday, b: Weekday) => (b.avg > a.avg ? b : a));
  const wdMax = Math.max(1, ...r.weekdays.map((w: Weekday) => w.avg));
  const mixMax = Math.max(1, ...r.mix.map((m) => m.sold));
  const cols = Math.max(1, r.mix.length);
  salesShell("demand", html`
    <div class="kpis">
      ${tile("Sold out", `${r.sold_out_days} of ${r.baking_days} days`, "everything made went out")}
      ${tile("Pre-orders", `${r.preorder_pct}%`, "of buns, ordered before the cutoff")}
      ${tile("Didn't go through", `${num(r.lost.orders)} ${r.lost.orders === 1 ? "order" : "orders"}`, `${r.lost.buns} buns · ${r.lost.expired} not paid in time`)}
      ${tile("Best day", best.name, `${best.avg} buns on average`)}
    </div>
    <div class="card">
      <h3>Next 7 days</h3>
      <div class="scroll"><table class="list">
        <tr><th>Day</th>${r.mix.map((m) => html`<th>${m.name}</th>`)}<th>Total</th></tr>
        ${r.forecast.map((f: Forecast) => html`<tr><td>${dayName(f.date)}</td>
          ${f.closed ? html`<td colspan="${cols}" class="muted">closed</td>` : r.mix.map((m) => html`<td>${f.buns.find((b) => b.product_id === m.product_id)?.qty || "–"}</td>`)}
          <td>${f.closed ? "–" : f.total}</td></tr>`)}
      </table></div>
      <p class="small muted">The average sold on the same weekday over the last 4 weeks. When buns sell out, real demand is higher, so treat these as the least to bake.</p>
    </div>
    <div class="grid2">
      <div class="card">
        <h3>Weekdays</h3>
        ${r.weekdays.map((w: Weekday) => html`<div class="hrow">
          <span>${w.name}</span>
          <div class="hbar">${w.avg ? html`<i class="v-sold" style="width:${(w.avg / wdMax) * 100}%"></i>` : ""}</div>
          <span class="small"><b>${w.avg}</b> <span class="muted">${w.days} days · sold out ${w.sold_out}</span></span>
        </div>`)}
      </div>
      <div class="card">
        <h3>Flavours</h3>
        ${r.mix.length ? r.mix.map((m) => barRow(m.name, html`${num(m.sold)} sold · ${m.pct}%`, m.sold, mixMax)) : html`<p class="muted">No buns sold yet.</p>`}
      </div>
    </div>`);
}

// Customers

interface Week { from: string; label: string; new: number; returning: number }

async function customerStats() {
  const r: {
    from: string; customers: number; returning: number; returning_pct: number; by_orders: { orders: string; customers: number }[];
    weeks: Week[]; sizes: { buns: string; orders: number }[]; median_buns: number; avg_buns: number; pickup_pct: number;
    fees: number; transport: number;
  } = await call("/admin/customer-stats");
  const wkMax = Math.max(1, ...r.weeks.map((w: Week) => w.new + w.returning));
  const ordMax = Math.max(1, ...r.by_orders.map((b) => b.customers));
  const sizeMax = Math.max(1, ...r.sizes.map((b) => b.orders));
  salesShell("customers", html`
    <div class="kpis">
      ${tile("Customers", num(r.customers), `since ${dayName(r.from)}`)}
      ${tile("Came back", num(r.returning), `${r.returning_pct}% ordered again`)}
      ${tile("Typical order", `${r.median_buns} buns`, `average ${r.avg_buns}`)}
      ${tile("Pickup", `${r.pickup_pct}%`, "of orders")}
      ${tile("Delivery", money(r.fees), `in fees · ${money(r.transport)} spent on transport`)}
    </div>
    <div class="card">
      <h3>New and returning, week by week</h3>
      ${r.weeks.map((w: Week) => html`<div class="bunrow">
        <div class="row between"><span>${w.label}</span><span class="small">${w.new} new · ${w.returning} came back</span></div>
        <div class="hbar">${w.new ? html`<i class="v-sold" style="width:${(w.new / wkMax) * 100}%"></i>` : ""}${w.returning ? html`<i class="v-other" style="width:${(w.returning / wkMax) * 100}%"></i>` : ""}</div>
      </div>`)}
    </div>
    <div class="grid2">
      <div class="card">
        <h3>Orders per customer</h3>
        ${r.by_orders.map((b) => barRow(`${b.orders} ${b.orders === "1" ? "order" : "orders"}`, num(b.customers), b.customers, ordMax))}
      </div>
      <div class="card">
        <h3>Buns per order</h3>
        ${r.sizes.map((b) => barRow(`${b.buns} ${b.buns === "1" ? "bun" : "buns"}`, num(b.orders), b.orders, sizeMax))}
      </div>
    </div>`);
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

// ── Visitors ──

// deno-lint-ignore no-explicit-any
type Visitors = any; // GET /admin/visitors (store function, rules.ts visitorsReport)
const addDay = (d: string, n: number) => new Date(Date.parse(d) + n * 86_400_000).toISOString().slice(0, 10);
const duration = (s: number) => s < 60 ? `${s} s` : `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ""}`;
const visitsText = (n: number) => `${num(n)} ${n === 1 ? "visit" : "visits"}`;
/** A label, a number and a bar against `max`, with a line underneath. */
const barRow = (label: unknown, value: unknown, part: number, max: number, sub: unknown = "") => html`<div class="bunrow">
  <div class="row between"><span>${label}</span><span>${value}</span></div>
  <div class="hbar">${part ? html`<i class="v-sold" style="width:${(part / Math.max(1, max)) * 100}%"></i>` : ""}</div>
  ${sub ? html`<div class="small muted">${sub}</div>` : ""}</div>`;

async function visitors(from: string, to: string) {
  const r: Visitors = await call(`/admin/visitors?${new URLSearchParams({ from, to })}`);
  tipBox.hidden = true;
  const t = r.totals, pv = r.prev;
  const days = r.days.length;
  const title = days === 1 ? (r.to === r.today ? "Today" : dayName(r.to)) : `${dayName(r.from)} – ${dayName(r.to)}`;
  const ranges: [string, string, string][] = [
    ["Today", r.today, r.today], ["Yesterday", addDay(r.today, -1), addDay(r.today, -1)],
    ["7 days", addDay(r.today, -6), r.today], ["30 days", addDay(r.today, -29), r.today],
  ];
  const stuck = r.stuck.filter((x: Visitors) => x.visits);
  const maxSource = Math.max(1, ...r.sources.map((x: Visitors) => x.visits));
  const first = r.funnel[0].visits;
  const hour = (h: number) => `${h % 12 || 12} ${h < 12 ? "am" : "pm"}`;
  const stale = r.buffer.oldest && Date.now() - Date.parse(r.buffer.oldest) > 2 * 86_400_000;
  const taps = (x: Visitors, none: string) => x.taps.length
    ? x.taps.map((tap: Visitors) => barRow(tap.label, html`<b>${tap.visits}</b> · ${pct(tap.visits, x.visits)}%`, tap.visits, x.visits))
    : html`<p class="muted small">${none}</p>`;
  shell("visitors", html`
    <div class="filters">
      <label>From<input type="date" id="from" value="${r.from}" max="${r.to}"></label>
      <label>To<input type="date" id="to" value="${r.to}" min="${r.from}" max="${r.today}"></label>
    </div>
    <div class="row" style="flex-wrap:wrap;gap:var(--space-2);margin:calc(-1 * var(--space-2)) 0 var(--space-4)">
      ${ranges.map(([label, f, to]) => html`<button type="button" class="${f === r.from && to === r.to ? "" : "secondary"}" data-from="${f}" data-to="${to}">${label}</button>`)}
    </div>
    ${stale ? html`<div class="notice warn">The Mac hasn't copied the visitors' raw data since ${when(r.buffer.oldest)}. Is it on, with the drive plugged in?
      The numbers here are fine; Supabase just keeps more until it runs (analytics/README.md).</div>` : ""}

    <h2>${title}</h2>
    <p class="small muted">Arrows compare with the ${days === 1 ? "day" : `${days} days`} before. Phones that have opened this admin page aren't counted.</p>
    <div class="kpis">
      ${tile("Visits", num(t.visits), `${num(t.visitors)} ${t.visitors === 1 ? "phone" : "phones"}, ${num(t.new_visitors)} new`, change(t.visits, pv.visits))}
      ${tile("Opened the store", num(t.store), t.visits ? `${pct(t.store, t.visits)}% of visits` : "", change(t.store, pv.store))}
      ${tile("Ordered", num(t.ordered), t.store ? `${pct(t.ordered, t.store)}% of store visits · ${t.paid} paid` : "", change(t.ordered, pv.ordered))}
      ${tile("Saw no stock", num(t.no_stock), `${num(t.no_stock_left)} left without ordering`)}
      ${tile("Something stopped them", num(t.stopped), `${num(t.stopped_left)} left without ordering`)}
    </div>

    ${days > 1 ? html`<div class="card">
      <h3>Visits each day</h3>
      ${columns(r.days.map((d: Visitors, i: number) => ({
        value: d.visits, tip: `${dayName(d.day)}\n${visitsText(d.visits)} · ${d.store} opened the store · ${d.ordered} ordered`,
        label: String(Number(d.day.slice(8))), tick: days <= 14 || i % 7 === 0 || i === days - 1,
      })), "Visits each day")}
      <details><summary class="small">As a table</summary><div class="scroll"><table class="list">
        <tr><th>Day</th><th>Visits</th><th>Opened the store</th><th>Ordered</th></tr>
        ${r.days.map((d: Visitors) => html`<tr><td>${dayName(d.day)}</td><td><b>${d.visits}</b></td><td>${d.store}</td><td>${d.ordered}</td></tr>`)}
      </table></div></details>
    </div>` : ""}

    <div class="grid2">
      <div class="card">
        <h3>Where they came from</h3>
        ${r.sources.length ? r.sources.map((x: Visitors) => barRow(html`<b>${x.label}</b>`, html`<b>${x.visits}</b> · ${pct(x.visits, t.visits)}%`, x.visits, maxSource,
          `${x.store} opened the store · ${x.ordered} ordered${x.paid ? ` · ${x.paid} paid` : ""}${x.hosts.length ? ` · ${x.hosts.map((h: Visitors) => `${h.m} (${h.count})`).join(", ")}` : ""}`))
          : html`<p class="muted">No visits yet.</p>`}
        <p class="small muted" style="margin-top:var(--space-3)">Box QR code: links.alinabun.com opened with no app or website before it, which is what a phone camera does.</p>
      </div>
      <div class="card">
        <h3>On the store</h3>
        ${r.funnel.map((f: Visitors) => barRow(f.label, html`<b>${f.visits}</b> · ${pct(f.visits, first)}%`, f.visits, first))}
        ${r.store_secs !== null ? html`<p class="small muted" style="margin-top:var(--space-3)">Half the visits that opened the store stayed longer than ${duration(r.store_secs)}.</p>` : ""}
        ${r.store_taps.taps.length ? html`<h3 style="margin-top:var(--space-4)">Paying</h3>${taps(r.store_taps, "")}` : ""}
      </div>
      <div class="card">
        <h3>What stopped them</h3>
        <p class="small muted">Visits that ran into each, and how many of those didn't order, then or later.</p>
        ${stuck.length ? stuck.map((x: Visitors) => html`<div class="bunrow">
          <div class="row between"><span>${x.label}</span><span><b>${x.visits}</b> · ${x.left} left</span></div>
          ${x.messages.length ? html`<details class="small"><summary>What the page said</summary>
            ${x.messages.map((m: Visitors) => html`<div>${m.m} <span class="muted">× ${m.count}</span></div>`)}</details>` : ""}
        </div>`) : html`<p class="muted">Nothing stopped anyone.</p>`}
      </div>
      <div class="card">
        <h3>Buns they wanted but couldn't get</h3>
        <p class="small muted">Tapped + on a bun that was sold out, or wanted more than were left.</p>
        ${r.wanted.length ? r.wanted.map((w: Visitors) => html`<div class="bunrow">
          <div class="row between"><b>${w.name}</b><span><b>${w.visits}</b> ${w.visits === 1 ? "visit" : "visits"} · ${w.left} left</span></div>
          ${w.dates.length ? html`<div class="small muted">For ${w.dates.map(dayName).join(", ")}</div>` : ""}
        </div>`) : html`<p class="muted">Nobody ran out of a bun they wanted.</p>`}
        ${r.pins.length ? html`<h3 style="margin-top:var(--space-4)">Pins outside our delivery area</h3>
          <p class="small muted">Where people wanted delivery that we don't cover, to about 1 km.</p>
          ${r.pins.map((x: Visitors) => html`<div class="small"><a href="https://www.google.com/maps?q=${x.m.replace(" ", "")}" target="_blank" rel="noopener">${x.m}</a> × ${x.count}</div>`)}` : ""}
      </div>
      <div class="card">
        <h3>links.alinabun.com</h3>
        <p class="small">${visitsText(r.links.visits)}${r.links.visits ? ` · ${r.links.clips} watched a kitchen clip, ${r.links.all_clips} all five` : ""}</p>
        ${taps(r.links, "No taps yet.")}
      </div>
      <div class="card">
        <h3>alinabun.com</h3>
        <p class="small">${visitsText(r.main.visits)}</p>
        ${taps(r.main, "No taps yet.")}
      </div>
      <div class="card">
        <h3>Phones</h3>
        ${r.phones.map((x: Visitors) => barRow(x.label, html`<b>${x.visits}</b> · ${x.ordered} ordered`, x.visits, t.visits))}
        <h3 style="margin-top:var(--space-4)">Opened in</h3>
        ${r.browsers.map((x: Visitors) => barRow(x.label, html`<b>${x.visits}</b> · ${x.ordered} ordered`, x.visits, t.visits))}
      </div>
    </div>

    <div class="card">
      <h3>Busiest hours</h3>
      <p class="small muted">Visits by the hour they started, Malé time.</p>
      ${columns(r.hours.map((n: number, h: number) => ({ value: n, tip: `${hour(h)}–${hour((h + 1) % 24)}\n${visitsText(n)}`, label: hour(h), tick: h % 3 === 0 })), "Visits by hour")}
    </div>

    <div class="card">
      <h3>Problems on the pages</h3>
      ${r.errors.length ? r.errors.map((x: Visitors) => html`<div class="small">${x.m} <span class="muted">× ${x.count}</span></div>`) : html`<p class="muted small">No errors.</p>`}
    </div>
    <p class="small muted">${r.traced} of the ${r.web_orders} website orders placed in these days came from visits we saw; the rest came from phones that
      block our counter. Supabase keeps one small row per visit; the Mac keeps everything (${num(r.buffer.events)} events waiting for its next daily copy).</p>`);

  const open = (f: string, to: string) => go({ tab: "visitors", from: f, to });
  $<HTMLInputElement>("#from").onchange = (e) => open((e.target as HTMLInputElement).value, r.to);
  $<HTMLInputElement>("#to").onchange = (e) => open(r.from, (e.target as HTMLInputElement).value);
  app.querySelectorAll<HTMLButtonElement>("[data-from]").forEach((b) => (b.onclick = () => open(b.dataset.from!, b.dataset.to!)));
}

/** One series of columns (visits per day or per hour), each with a tooltip. */
function columns(points: { value: number; tip: string; label: string; tick: boolean }[], label: string) {
  const W = Math.round(Math.max(280, Math.min(940, app.clientWidth - 34))), H = 170, L = 30, T = 8, B = 24;
  const ph = H - T - B, band = (W - L) / points.length, bw = Math.max(3, Math.min(18, band - 4));
  const peak = Math.max(1, ...points.map((p) => p.value));
  const step = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000].find((s) => peak / s <= 4) ?? 2000;
  const max = Math.ceil(peak / step) * step;
  const py = (v: number) => T + ph - (v / max) * ph;
  const f = (x: number) => x.toFixed(1);
  const marks: Raw[] = [];
  for (let v = 0; v <= max; v += step) {
    marks.push(html`<line x1="${L}" x2="${W}" y1="${f(py(v))}" y2="${f(py(v))}" class="${v ? "grid" : "axis"}"/><text x="${L - 6}" y="${f(py(v) + 4)}" class="tick" text-anchor="end">${v}</text>`);
  }
  points.forEach((p, i) => {
    const x = L + i * band, bx = x + (band - bw) / 2, top = py(p.value), bottom = py(0);
    const rr = Math.min(4, bottom - top, bw / 2); // round only the top end
    if (p.value) marks.push(html`<path class="v-sold" d="M${f(bx)},${f(bottom)}V${f(top + rr)}Q${f(bx)},${f(top)} ${f(bx + rr)},${f(top)}H${f(bx + bw - rr)}Q${f(bx + bw)},${f(top)} ${f(bx + bw)},${f(top + rr)}V${f(bottom)}Z"/>`);
    marks.push(html`<rect x="${f(x)}" y="${T}" width="${f(band)}" height="${ph}" class="hit" data-tip="${p.tip}" tabindex="0" aria-label="${p.tip.replace(/\n/g, ", ")}"/>`);
    if (p.tick) marks.push(html`<text x="${f(x + band / 2)}" y="${H - 6}" class="tick" text-anchor="middle">${p.label}</text>`);
  });
  return html`<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${label}">${marks}</svg>`;
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
