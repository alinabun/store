// "/" — pick buns, a day, a batch and details; the server re-prices everything.
import { $, api, forgetOrder, loadError, html, mvr, raw, rememberOrder, render, savedOrders, store } from "./lib.ts";
import { type Pin, pinPicker } from "./map.ts";
import { notifyFor } from "./push.ts";
import { flush, track } from "./track.ts";

interface Product { id: string; name: string; description: string | null; price_mvr: string; image_url: string | null; thumb_url?: string | null }
interface TimeOption { value: string; label: string }
/** One of a day's two batches (10 AM, 4 PM). Its stock and times are the ones that count. */
interface Bake {
  bake: string; label: string; ready: string; ready_now: boolean; ready_label: string;
  available: boolean; left: number;
  products: Record<string, number>; // buns of each kind still left in this batch
  delivery_times: TimeOption[]; pickup_times: TimeOption[];
}
interface DeliveryDate {
  date: string; label: string; kind: "preorder" | "extras"; available: boolean; closed: boolean; left: number;
  products: Record<string, number>; // buns of each kind still available that day
  delivery_open: boolean;
  bakes: Bake[];
}
interface Vessel { id: number; name: string; operator: string | null; vessel_type: string | null; location: string | null }

const MAX_PER_LINE = 50, MAX_BUNS = 100;
const app = $("#app");
const qty = new Map<string, number>();
let products: Product[] = [];
let dates: DeliveryDate[] = [];
let today = ""; // Malé date, from the server
let pin: Pin | null = null;
let pickupPlace = "", pickupPhone = "", pickupMap: string | null = null;
let fee = 0; // laari; delivery fee for the current pin
let boat: Vessel | null = null;
let cutoff = "6 pm"; // from the server's cutoff hour
let minDelivery = 0; // buns; delivery needs at least this many (from the server)
let usdRate = 0; // MVR per USD in hundredths (from the server); 0 = no USD option
let pausedUntil: string | null = null; // "1 PM" while delivery is paused today (admin Days tab)
const signedIn = store<{ session: string }>("alinabun.session");
// The signed-in account: cash on delivery and credit, when a manager turned them on for it.
let acct: { phone: string; cod: boolean; credit: { limit_mvr: string; owed_mvr: string } | null } | null = null;
// deno-lint-ignore no-explicit-any
let leaflet: any = null;

async function load() {
  try {
    let r;
    let me;
    [{ products }, r, me] = await Promise.all([api("/catalog"), api("/delivery-dates"),
      signedIn ? api<NonNullable<typeof acct>>("/account/me", { body: { session: signedIn.session } }).catch(() => null) : null]);
    acct = me?.cod || me?.credit ? me : null;
    ({ dates, today_date: today, pickup_place: pickupPlace, pickup_phone: pickupPhone, pickup_map_url: pickupMap } = r);
    minDelivery = Number(r.delivery_min_buns ?? 0);
    pausedUntil = r.delivery_paused_until ?? null;
    usdRate = r.usd_rate ? Math.round(Number(r.usd_rate) * 100) : 0;
    const hr = Number(r.cutoff_hour);
    cutoff = `${hr % 12 || 12} ${hr < 12 ? "am" : "pm"}`;
    $("#intro").textContent = `We bake twice a day: the 10 AM batch and the 4 PM batch. Pre-order by ${cutoff} the day before; after that, order our extra buns while they last.`;
    // What this visitor saw on sale: the Visitors tab counts who came when buns were gone.
    track("menu", {
      today: r.today, open: dates.some((d) => d.available),
      days: dates.map((d) => ({ date: d.date, kind: d.kind, state: d.closed ? "closed" : d.available ? "open" : "sold_out", left: d.left, del: d.delivery_open, buns: d.products })),
    });
  } catch (e) {
    track("menu", { failed: (e as Error).message });
    render(app, loadError(e));
    return;
  }
  const saved = savedDetails();
  const firstOpen = dates.find((d) => d.available)?.date;
  render(app, html`
    ${pausedUntil ? html`<div class="notice warn">🛵 Delivery is paused until <b>${pausedUntil}</b> today. Today's deliveries go out after ${pausedUntil}.</div>` : ""}
    <div id="mine"></div>
    <form id="f" novalidate>
      <div class="card">
        <h2>Which day?</h2>
        <div class="dates" role="radiogroup" aria-label="Delivery day">
          ${dates.map((d) => html`
            <label><input type="radio" name="delivery_date" value="${d.date}" ${d.available ? "" : "disabled"} ${d.date === firstOpen ? "checked" : ""}>
              <span>${d.label}${!d.available ? html`<small>${d.closed ? "Closed" : "Sold out"}</small>` : d.kind === "extras" ? html`<small>Extras</small>` : ""}</span></label>`)}
        </div>
        <p class="hint" id="day-hint"></p>

        <h2 class="sub">Which batch?</h2>
        <div class="bakes" role="radiogroup" aria-label="Batch" id="bakes"></div>
        <div class="notice info bake-hint" id="bake-hint" hidden></div>
      </div>

      <div class="card menu-card">
        <h2>Choose your buns</h2>
        <p class="hint">Prices per bun.${minDelivery ? ` Delivery from ${minDelivery} ${minDelivery === 1 ? "bun" : "buns"}.` : ""}</p>
        <div class="menu">
        ${products.map((p, i) => html`
          <div class="bun" id="row-${p.id}">
            <div class="bun-photo">${p.thumb_url || p.image_url
              ? html`<img src="${p.thumb_url || p.image_url}" alt="${p.name} bun" width="72" height="72" decoding="async" ${i < 2 ? "" : raw('loading="lazy"')}>`
              : html`<span class="bun-ph" aria-hidden="true">🥯</span>`}</div>
            <div class="bun-body">
              <h3>${p.name}</h3>
              ${p.description ? html`<p class="bun-desc">${p.description}</p>` : ""}
              <div class="bun-meta"><b>MVR ${Number(p.price_mvr) % 1 ? Number(p.price_mvr).toFixed(2) : Number(p.price_mvr)}</b><span class="stock" id="left-${p.id}" hidden></span></div>
            </div>
            <div class="stepper">
              <button type="button" data-step="-1" data-id="${p.id}" aria-label="One less ${p.name}">−</button>
              <output id="q-${p.id}" aria-live="polite">0</output>
              <button type="button" data-step="1" data-id="${p.id}" aria-label="One more ${p.name}">+</button>
            </div>
          </div>`)}
        </div>
      </div>

      <div class="card">
        <div class="row between saved-row">
          <div class="grow" id="saved-box"></div>
          <button type="button" class="secondary" id="clear">Clear form</button>
        </div>
        <label for="name">Your name</label>
        <input id="name" name="name" autocomplete="name" maxlength="80" required>

        <label for="phone">Phone number</label>
        <input id="phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="7xx xxxx" required>
        <div class="hint">A Maldives mobile number, so we can call you about your order.</div>

        <label>Delivery or pickup?</label>
        <div class="dates" role="radiogroup" aria-label="Delivery or pickup">
          <label><input type="radio" name="fulfilment" value="delivery" checked><span>Delivery<small id="delivery-full"></small></span></label>
          <label><input type="radio" name="fulfilment" value="pickup"><span>Pickup<small id="pickup-closed"></small></span></label>
        </div>

        <div id="delivery-box">
          <div class="dates" role="radiogroup" aria-label="Deliver to" style="margin-top:var(--space-3)">
            <label><input type="radio" name="deliver_to" value="address" checked><span>To an address</span></label>
            <label><input type="radio" name="deliver_to" value="boat"><span>To a boat</span></label>
          </div>
          <div id="boat-box" hidden>
            <label for="boat-q">Which boat?</label>
            <input id="boat-q" type="search" autocomplete="off" placeholder="Type the boat's name" aria-describedby="boat-hint">
            <div class="hint" id="boat-hint">From the FollowMe boat list. Can't find it? Choose "To an address" and put the pin where the boat will be.</div>
            <div id="boat-results" class="boat-results" role="listbox"></div>
            <div id="boat-picked"></div>
            <label for="boat-time">What time will the boat be there?</label>
            <input id="boat-time" type="time">
          </div>
          <div id="delivery-time-box">
            <label for="delivery-time">Deliver after</label>
            <select id="delivery-time" aria-describedby="delivery-time-hint"></select>
            <div class="hint" id="delivery-time-hint">We deliver every order ourselves, between Malé and Hulhumalé, so your buns come after the time you pick, not exactly at it.</div>
          </div>
          <label id="pin-label">Where should we deliver?</label>
          <p class="hint" id="pin-hint">We deliver in Malé, Hulhulé and Hulhumalé. Tap the map to put a pin on your home. Drag the pin to move it. The blue dot is where you are now.</p>
          <div id="map" class="map" aria-label="Map: tap to put your delivery pin"></div>
          <div class="hint" id="pin-status">No pin yet.</div>
          <div class="hint" id="fee-status"></div>

          <label for="address">Directions <span class="muted">(optional)</span></label>
          <textarea id="address" name="address" maxlength="500" placeholder="House name, floor, door colour, what's nearby"></textarea>
        </div>
        <div id="pickup-box" hidden>
          <div class="notice info" style="margin-top:var(--space-3)">${pickupPlace}
            ${pickupMap ? html`<br><a href="${pickupMap}" target="_blank" rel="noopener">📍 Open in Google Maps</a>` : ""}
            ${pickupPhone ? html`<br>Call us when you come: <a href="tel:${pickupPhone}">${pickupPhone}</a>` : ""}</div>
          <label for="pickup-time">What time will you come?</label>
          <select id="pickup-time"></select>
        </div>

        <label for="notes">Notes <span class="muted">(optional)</span></label>
        <textarea id="notes" name="notes" maxlength="500" placeholder="Anything we should know?"></textarea>
      </div>

      ${acct ? html`
      <div class="card">
        <h2>How will you pay?</h2>
        <div class="dates" role="radiogroup" aria-label="How will you pay?">
          <label><input type="radio" name="payment" value="bank" checked><span>Bank transfer</span></label>
          ${acct.cod ? html`<label><input type="radio" name="payment" value="cod"><span>💵 Cash on delivery</span></label>` : ""}
          ${acct.credit ? html`<label><input type="radio" name="payment" value="credit"><span>📒 On credit (pay later)</span></label>` : ""}
        </div>
        <p class="hint" id="cod-hint" hidden>Cash on delivery is for orders on your account's number, ${acct.phone}. Please have the cash ready when you get your buns.</p>
        ${acct.credit ? html`<p class="hint" id="credit-hint" hidden>For orders on your account's number, ${acct.phone}. You owe MVR ${acct.credit.owed_mvr}; your credit limit is MVR ${acct.credit.limit_mvr}.</p>` : ""}
      </div>` : ""}

      ${usdRate ? html`
      <div class="card" id="cur-card">
        <h2>Pay in</h2>
        <div class="dates" role="radiogroup" aria-label="Pay in">
          <label><input type="radio" name="currency" value="MVR" checked><span>MVR</span></label>
          <label><input type="radio" name="currency" value="USD"><span>USD</span></label>
        </div>
        <p class="hint" id="usd-hint" hidden>Prices are in MVR. In USD it's the total at ${usdRate / 100} MVR per USD, rounded up to the next 0.50. Please pay from a BML USD account.</p>
      </div>` : ""}

      <div id="err" role="alert"></div>
      <button class="primary" id="submit">Place order</button>
      <p class="hint" style="text-align:center" id="next-hint">Next, you'll see how to pay by bank transfer.</p>
    </form>
    <div class="bar"><div class="wrap"><span id="sum">No buns yet</span><button type="button" class="secondary" id="go">Order ↓</button></div></div>
  `);

  $("#f").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-step]");
    if (!b) return;
    const id = b.dataset.id!;
    const total = [...qty.values()].reduce((a, n) => a + n, 0);
    const step = Number(b.dataset.step);
    const bk = batch(), left = bk?.products[id] ?? 0, max = Math.min(MAX_PER_LINE, left), have = qty.get(id) ?? 0;
    const next = Math.max(0, Math.min(max, have + step));
    if (step > 0 && have >= left && left < MAX_PER_LINE) once(`want:${id}:${day()?.date}:${bk?.bake}`, "blocked", { why: left ? "too_many" : "sold_out", bun: id, date: day()?.date, bake: bk?.bake, left });
    if (step > 0 && next > have) once(`add:${id}`, "add", { bun: id, date: day()?.date, bake: bk?.bake });
    if (step > 0 && total >= MAX_BUNS) return showError(`The most you can order at once is ${MAX_BUNS} buns.`);
    setCount(id, next);
    update();
  });
  leaflet = pinPicker($("#map"), saved[0]?.pin ?? null, (p) => {
    pin = { lat: p.lat, lng: p.lng };
    $("#pin-status").textContent = "📍 Pin placed. We'll call you when we're close.";
    showError("");
    quoteFee();
  }).catch(() => render($("#map"), html`<div class="notice bad">The map didn't load. Please check your internet and refresh the page.</div>`));
  // A tap on a day, batch or option that can't be chosen: what they wanted and couldn't have.
  $("#f").addEventListener("click", (e) => {
    const off = (e.target as Element).closest("label")?.querySelector<HTMLInputElement>("input:disabled");
    if (off?.name === "delivery_date") {
      once(`day:${off.value}`, "blocked", { why: dates.find((d) => d.date === off.value)?.closed ? "day_closed" : "day_sold_out", date: off.value });
    }
    if (off?.name === "bake") once(`bake:${off.value}:${day()?.date}`, "blocked", { why: "batch_unavailable", date: day()?.date, bake: off.value });
    if (off?.name === "fulfilment") once(`f:${off.value}:${day()?.date}`, "blocked", { why: off.value === "delivery" ? "delivery_full" : "pickup_closed", date: day()?.date });
  });
  $("#name").closest(".card")!.addEventListener("focusin", () => track("start"), { once: true });
  $("#f").addEventListener("change", (e) => {
    const name = (e.target as HTMLInputElement).name;
    if (name === "delivery_date") { refreshDay(); track("day", { date: day()?.date, bake: batch()?.bake }); }
    if (name === "bake") { refreshBake(); track("day", { date: day()?.date, bake: batch()?.bake }); }
    if (name === "fulfilment") refreshFulfilment();
    if (name === "deliver_to") refreshDeliverTo();
    if (name === "currency" || name === "payment") update();
  });
  refreshDay();
  showSavedDetails();
  if (saved[0]) applyDetails(saved[0]);
  applyChange();
  wireBoatSearch();
  showSavedOrders();
  $("#clear").onclick = clearForm;
  $("#go").onclick = () => $("#submit").scrollIntoView({ behavior: "smooth", block: "center" });
  $<HTMLFormElement>("#f").onsubmit = submit;
}

/** Track something once per page (a bun tapped ten times is one want). */
const told = new Set<string>();
function once(key: string, name: string, props: Record<string, unknown>) {
  if (told.has(key)) return;
  told.add(key);
  track(name, props);
}

// ── Details saved on this phone (never on the server: a phone number must not reveal anyone's address) ──

interface Details { name: string; phone: string; fulfilment: string; deliverTo: string; address: string; pin: Pin | null; boat: Vessel | null }
const MAX_SAVED = 5;

function savedDetails(): Details[] {
  const list = store<Details[]>("alinabun.details");
  if (list) return list;
  const old = store<{ name: string; phone: string; address: string; pin?: Pin }>("alinabun.customer"); // saved before this list existed
  return old ? [{ ...old, pin: old.pin ?? null, fulfilment: "delivery", deliverTo: "address", boat: null }] : [];
}

const detailsLabel = (d: Details) =>
  `${d.name} · ${d.fulfilment === "pickup" ? "Pickup" : d.boat ? `⛴ ${d.boat.name}` : d.address || "Map pin"}`;

function showSavedDetails(selected = 0) {
  const list = savedDetails();
  render($("#saved-box"), list.length ? html`
    <label for="saved">Your saved details</label>
    <select id="saved">
      ${list.map((d, i) => html`<option value="${i}" ${i === selected ? "selected" : ""}>${detailsLabel(d)}</option>`)}
      <option value="" ${selected < 0 ? "selected" : ""}>New details</option>
    </select>
    <button type="button" class="link small" id="forget" ${selected < 0 ? "hidden" : ""}>Remove these from this phone</button>` : html``);
  if (!list.length) return;
  const pick = $<HTMLSelectElement>("#saved");
  pick.onchange = () => {
    $("#forget").hidden = !pick.value;
    applyDetails(pick.value ? list[Number(pick.value)] : null);
  };
  $("#forget").onclick = () => {
    store("alinabun.details", list.filter((_, i) => i !== Number(pick.value)));
    store("alinabun.customer", null);
    showSavedDetails(-1);
    applyDetails(null);
  };
}

/** Fill in who and where (never the buns, day, batch or times); null empties them. */
function applyDetails(d: Details | null) {
  $<HTMLInputElement>("#name").value = d?.name ?? "";
  $<HTMLInputElement>("#phone").value = d?.phone ?? "";
  $<HTMLTextAreaElement>("#address").value = d?.address ?? "";
  $<HTMLInputElement>("#boat-time").value = "";
  const radio = (name: string, value: string) => {
    const r = document.querySelector<HTMLInputElement>(`input[name=${name}][value="${value}"]`);
    if (r && !r.disabled) r.checked = true;
  };
  radio("fulfilment", d?.fulfilment ?? "delivery");
  radio("deliver_to", d?.deliverTo ?? "address");
  setBoat(d?.boat ?? null);
  pin = d?.pin ?? null;
  leaflet?.then((m: { setPin: (p: Pin | null) => void }) => m?.setPin(pin));
  fee = 0;
  $("#fee-status").textContent = "";
  $("#pin-status").textContent = pin ? "Pin from your last order. Move it if you're somewhere else." : "No pin yet.";
  refreshFulfilment();
  refreshDeliverTo();
  if (pin) quoteFee();
}

function clearForm() {
  for (const p of products) setCount(p.id, 0);
  $<HTMLTextAreaElement>("#notes").value = "";
  if (document.querySelector("#saved")) showSavedDetails(-1);
  applyDetails(null);
  // The batch goes back to the first one on sale; its times follow.
  const first = day()?.bakes.find((b) => b.available);
  if (first) $<HTMLInputElement>(`input[name=bake][value="${first.bake}"]`).checked = true;
  refreshBake();
  $<HTMLSelectElement>("#delivery-time").value = batch()?.delivery_times[0]?.value === "asap" ? "asap" : "";
  $<HTMLSelectElement>("#pickup-time").value = "";
  update();
}

function rememberDetails(d: Details) {
  const same = (a: Details) => JSON.stringify(a) === JSON.stringify(d);
  store("alinabun.details", [d, ...savedDetails().filter((a) => !same(a))].slice(0, MAX_SAVED));
  store("alinabun.customer", null);
}

function setBoat(v: Vessel | null) {
  boat = v;
  render($("#boat-picked"), v ? html`<div class="notice ok small">⛴ <b>${v.name}</b> ${v.vessel_type ? `· ${v.vessel_type}` : ""}
    <button type="button" class="copy" id="boat-change">Change</button></div>` : html``);
  if (v) $("#boat-change").onclick = () => { setBoat(null); $("#boat-q").focus(); };
}

/** Sets a bun's count and its row's look (highlighted when it's above 0). */
function setCount(id: string, n: number) {
  qty.set(id, n);
  $(`#q-${id}`).textContent = String(n);
  $(`#row-${id}`).classList.toggle("on", n > 0);
}

/** After "Change order": the cancelled order's day, batch, buns, delivery choice and notes, as far as they're still available. */
function applyChange() {
  const c = store<{ date: string; bake?: string; items: { product_id: string; qty: number }[]; fulfilment: string; notes: string | null; currency?: string }>("alinabun.change");
  if (!c) return;
  store("alinabun.change", null);
  const dateRadio = document.querySelector<HTMLInputElement>(`input[name=delivery_date][value="${c.date}"]`);
  if (dateRadio && !dateRadio.disabled) dateRadio.checked = true;
  const fRadio = document.querySelector<HTMLInputElement>(`input[name=fulfilment][value="${c.fulfilment}"]`);
  if (fRadio && !fRadio.disabled) fRadio.checked = true;
  refreshDay(); // the day's batches first; then the saved batch, if it's still on sale
  const bRadio = c.bake ? document.querySelector<HTMLInputElement>(`input[name=bake][value="${c.bake}"]`) : null;
  if (bRadio && !bRadio.disabled) {
    bRadio.checked = true;
    refreshBake();
  }
  for (const i of c.items) {
    const n = Math.min(i.qty, MAX_PER_LINE, batch()?.products[i.product_id] ?? 0);
    if (!products.some((p) => p.id === i.product_id) || !n) continue;
    setCount(i.product_id, n);
  }
  if (c.notes) $<HTMLTextAreaElement>("#notes").value = c.notes;
  const cur = document.querySelector<HTMLInputElement>(`input[name=currency][value="${c.currency}"]`);
  if (cur) cur.checked = true;
  update();
  render($("#mine"), html`<div class="notice info">Your last order was cancelled and filled in here. Change what you need, then place it again.</div>`);
}

/** Orders from this phone, so a closed browser tab doesn't lose them: the ones still to come on top, past ones behind a button. */
async function showSavedOrders() {
  const LABEL: Record<string, string> = { awaiting_payment: "Waiting for your payment", awaiting_bank: "Checking your payment", paid: "Paid", delivered: "Delivered" };
  const mine: { t: string; id: string; label: string; day: string; date: string; past: boolean }[] = [];
  for (const o of savedOrders()) {
    try {
      const v = await api<{ status: string; delivery_date: string; delivery_label: string }>(`/order-status?t=${encodeURIComponent(o.t)}`);
      // Paid orders are rarely marked delivered, so a day that has passed counts as done too.
      if (LABEL[v.status]) mine.push({ ...o, label: LABEL[v.status], day: v.delivery_label, date: v.delivery_date, past: v.status === "delivered" || v.delivery_date < today });
      else forgetOrder(o.t); // cancelled or rejected: nothing to come back to
    } catch (e) {
      if ((e as Error).message.includes("couldn't find")) forgetOrder(o.t); // other errors (offline): keep it
    }
  }
  if (!mine.length || $("#mine").childElementCount) return;
  const open = mine.filter((o) => !o.past), past = mine.filter((o) => o.past).sort((a, b) => b.date.localeCompare(a.date));
  const rows = (list: typeof mine) => list.map((o) => html`<p class="row between" style="margin:var(--space-2) 0"><span><b>${o.id}</b> · ${o.day}<br><span class="small muted">${o.label}</span></span>
    <a class="btn secondary-btn" href="/order/?t=${encodeURIComponent(o.t)}">View</a></p>`);
  render($("#mine"), html`
    ${open.length ? html`<div class="card"><h2>Your order${open.length > 1 ? "s" : ""}</h2>${rows(open)}</div>` : ""}
    ${past.length ? html`<details class="past-orders"><summary>Your past orders (${past.length})</summary><div class="card">${rows(past)}</div></details>` : ""}`);
}

const day = () => dates.find((d) => d.date === document.querySelector<HTMLInputElement>("input[name=delivery_date]:checked")?.value);
/** The chosen batch: its stock and times are the ones that count. */
const batch = () => day()?.bakes.find((b) => b.bake === document.querySelector<HTMLInputElement>("input[name=bake]:checked")?.value);

/** The stock line on a batch tab. */
const stockLine = (d: DeliveryDate | undefined, b: Bake) =>
  !b.left ? "Sold out" : d?.kind === "extras" ? `${b.left} left` : b.left <= 10 ? `Only ${b.left} left` : "Pre-order";

/** A new day: its batch tabs (keeping the chosen batch if it's still on sale), then that batch's limits and times. */
function refreshDay() {
  const d = day();
  $("#day-hint").textContent = !d ? "Sorry, nothing is available right now. Please check back later."
    : d.kind === "extras" ? `${d.label}: these are our extra buns, while they last.`
    : `Pre-order for ${d.label}. Orders close at ${cutoff} the day before.`;
  const was = document.querySelector<HTMLInputElement>("input[name=bake]:checked")?.value;
  const bakes = d?.bakes ?? [];
  const pick = bakes.find((b) => b.bake === was && b.available) ?? bakes.find((b) => b.available);
  render($("#bakes"), html`${bakes.map((b) => html`<label><input type="radio" name="bake" value="${b.bake}" ${b.available ? "" : "disabled"} ${b === pick ? "checked" : ""}>
    <span><b>${b.label}</b><small>${b.ready_label}</small><small>${stockLine(d, b)}</small></span></label>`)}`);
  refreshBake();
}

/** The chosen batch: when its buns come, what's left, and its times. */
function refreshBake() {
  const d = day(), b = batch();
  const hint = $("#bake-hint");
  render(hint, !d || !b ? html`` : b.ready_now ? html`Fresh from the ${b.label}, ready now.`
    : d.date === today ? html`This batch comes out of the oven at <b>${b.ready}</b>. Delivery and pickup start from <b>${b.ready}</b>.`
    : html`${d.label}, ${b.label}: delivery and pickup from <b>${b.ready}</b>.`);
  hint.hidden = !d || !b;
  for (const p of products) {
    const n = Math.min(MAX_PER_LINE, b?.products[p.id] ?? 0);
    if ((qty.get(p.id) ?? 0) > n) setCount(p.id, n);
    $(`#row-${p.id}`).classList.toggle("soldout", n === 0);
    const pill = $(`#left-${p.id}`);
    const text = n === 0 ? "Sold out" : d?.kind === "extras" || n <= 10 ? `${n} left` : ""; // 5 or fewer: in the warning colour
    pill.textContent = text;
    pill.className = `stock${n === 0 ? " bad" : n <= 5 ? " warn" : ""}`;
    pill.hidden = !text;
  }
  // Deliveries are capped per day; when full, only pickup is offered. Pickup follows the batch's times.
  const radio = document.querySelector<HTMLInputElement>("input[name=fulfilment][value=delivery]")!;
  const pickupRadio = document.querySelector<HTMLInputElement>("input[name=fulfilment][value=pickup]")!;
  radio.disabled = !!d && !d.delivery_open;
  pickupRadio.disabled = !!d && !b?.pickup_times.length; // after this batch's last pickup time
  $("#delivery-full").textContent = radio.disabled ? "Full that day" : "";
  $("#pickup-closed").textContent = pickupRadio.disabled ? "Closed for today" : "";
  if (radio.disabled) pickupRadio.checked = true;
  else if (pickupRadio.disabled) radio.checked = true;
  fillTimes($<HTMLSelectElement>("#delivery-time"), b?.delivery_times ?? [], "asap");
  fillTimes($<HTMLSelectElement>("#pickup-time"), b?.pickup_times ?? []);
  $<HTMLInputElement>("#boat-time").min = b?.bake ?? ""; // a boat can't come before the batch is ready
  refreshFulfilment();
  update();
}

/** The day's times, keeping the choice if it's still there. Nothing is chosen for them, except ASAP where it's offered. */
function fillTimes(el: HTMLSelectElement, times: TimeOption[], preferred = "") {
  const was = el.value;
  render(el, html`<option value="">Choose a time</option>${times.map((t) => html`<option value="${t.value}">${t.label}</option>`)}`);
  el.value = times.some((t) => t.value === was) ? was : times.some((t) => t.value === preferred) ? preferred : "";
}

const fulfilment = () => document.querySelector<HTMLInputElement>("input[name=fulfilment]:checked")?.value ?? "delivery";

function refreshFulfilment() {
  const pickup = fulfilment() === "pickup";
  $("#delivery-box").hidden = pickup;
  $("#pickup-box").hidden = !pickup;
  // The map was sized while hidden; let Leaflet measure again.
  if (!pickup) leaflet?.then((m: { invalidateSize: () => void }) => m?.invalidateSize());
  update(); // the delivery fee only applies to delivery
}

const deliverTo = () => document.querySelector<HTMLInputElement>("input[name=deliver_to]:checked")?.value ?? "address";

function refreshDeliverTo() {
  const toBoat = deliverTo() === "boat";
  $("#boat-box").hidden = !toBoat;
  $("#delivery-time-box").hidden = toBoat; // a boat has its own time
  $("#pin-label").textContent = toBoat ? "Where will the boat be?" : "Where should we deliver?";
  $("#pin-hint").textContent = toBoat
    ? "Tap the map where the boat will be (the jetty or harbour). Drag the pin to move it."
    : "We deliver in Malé, Hulhulé and Hulhumalé. Tap the map to put a pin on your home. Drag the pin to move it. The blue dot is where you are now.";
}

/** The server decides the fee (one for Malé, one for outside); show it and add it to the total. */
async function quoteFee() {
  if (!pin) return;
  try {
    const r = await api<{ fee_mvr: string; in_male: boolean }>(`/delivery-fee?lat=${pin.lat}&lng=${pin.lng}`);
    fee = Math.round(Number(r.fee_mvr) * 100);
    $("#fee-status").textContent = r.in_male ? `Delivery in Malé: ${mvr(r.fee_mvr)}.` : `Outside Malé: delivery fee ${mvr(r.fee_mvr)}.`;
  } catch (e) {
    $("#fee-status").textContent = (e as Error).message; // e.g. outside the delivery area
    // Where we don't deliver yet, to about 1 km (the server rounds it too).
    if ((e as { status?: number }).status) track("blocked", { why: "pin", m: (e as Error).message, lat: Math.round(pin.lat * 100) / 100, lng: Math.round(pin.lng * 100) / 100 });
  }
  update();
}

function wireBoatSearch() {
  const q = $<HTMLInputElement>("#boat-q");
  let timer: number | undefined;
  q.oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const term = q.value.trim();
      if (term.length < 2) return render($("#boat-results"), html``);
      try {
        const { vessels } = await api<{ vessels: Vessel[] }>(`/vessels?q=${encodeURIComponent(term)}`);
        render($("#boat-results"), vessels.length ? html`${vessels.map((v) => html`
          <button type="button" class="boat-option" data-vessel="${v.id}">
            <b>${v.name}</b><span class="small muted">${[v.vessel_type, v.operator, v.location && `now at ${v.location}`].filter(Boolean).join(" · ")}</span>
          </button>`)}` : html`<p class="hint">No boat found. Try another spelling, or choose "To an address".</p>`);
        $("#boat-results").querySelectorAll<HTMLButtonElement>("[data-vessel]").forEach((b) => (b.onclick = () => {
          setBoat(vessels.find((v) => v.id === Number(b.dataset.vessel)) ?? null);
          render($("#boat-results"), html``);
          q.value = "";
        }));
      } catch (e) {
        render($("#boat-results"), html`<p class="hint">${(e as Error).message}</p>`);
      }
    }, 250);
  };
}

function update() {
  let buns = 0, laari = 0;
  for (const p of products) {
    const n = qty.get(p.id) ?? 0;
    buns += n;
    laari += Math.round(Number(p.price_mvr) * 100) * n;
  }
  const withFee = fulfilment() === "delivery" && buns ? fee : 0;
  // Same rounding as the server (rules.ts usdTotal); the server's total is the one that counts.
  const usd = currency() === "USD" ? ` = USD ${(Math.ceil(((laari + withFee) * 2) / usdRate) / 2).toFixed(2)}` : "";
  const bk = batch();
  $("#sum").textContent = buns ? `${buns} bun${buns > 1 ? "s" : ""} · ${mvr((laari + withFee) / 100)}${withFee ? " incl. delivery" : ""}${usd}${bk ? ` · ${bk.label}` : ""}` : "No buns yet";
  const hint = document.querySelector<HTMLElement>("#usd-hint");
  if (hint) hint.hidden = currency() !== "USD";
  // Cash is always MVR.
  const curCard = document.querySelector<HTMLElement>("#cur-card");
  if (curCard) curCard.hidden = payment() !== "bank";
  const codHint = document.querySelector<HTMLElement>("#cod-hint");
  if (codHint) codHint.hidden = payment() !== "cod";
  const creditHint = document.querySelector<HTMLElement>("#credit-hint");
  if (creditHint) creditHint.hidden = payment() !== "credit";
  $("#next-hint").textContent = payment() === "cod" ? "You'll pay in cash when you get your buns."
    : payment() === "credit" ? "It goes on your account: you pay what you owe later." : "Next, you'll see how to pay by bank transfer.";
  if (fulfilment() === "delivery" && buns < minDelivery) $("#sum").textContent += ` · delivery is for ${minDelivery}+ buns`;
  showError("");
}

const payment = () => {
  const v = acct && document.querySelector<HTMLInputElement>("input[name=payment]:checked")?.value;
  return v === "cod" || v === "credit" ? v : "bank";
};
const currency = () => usdRate && payment() === "bank" && document.querySelector<HTMLInputElement>("input[name=currency]:checked")?.value === "USD" ? "USD" : "MVR";

function showError(msg: string, why = "form", code?: number) {
  if (msg) track("blocked", { why, m: msg, code });
  render($("#err"), msg ? html`<div class="notice bad">${msg}</div>` : html``);
  if (msg) $("#err").scrollIntoView({ behavior: "smooth", block: "center" });
}

async function submit(e: SubmitEvent) {
  e.preventDefault();
  const f = new FormData(e.target as HTMLFormElement);
  const items = [...qty].filter(([, n]) => n > 0).map(([product_id, qty]) => ({ product_id, qty }));
  const get = (k: string) => String(f.get(k) ?? "").trim();
  const date = dates.find((d) => d.date === get("delivery_date"));
  const bk = batch();
  if (!items.length) return showError("Please choose at least one bun.");
  if (!date) return showError("Please pick a delivery day.");
  if (!bk) return showError("Please pick a batch.");
  const buns = items.reduce((a, i) => a + i.qty, 0);
  if (buns > bk.left) return showError(`Only ${bk.left} buns are left in the ${bk.label} for ${date.label}. Please order fewer or pick another batch or day.`);
  const over = items.find((i) => i.qty > (bk.products[i.product_id] ?? 0));
  if (over) return showError(`Only ${bk.products[over.product_id] ?? 0} ${products.find((p) => p.id === over.product_id)?.name} left in the ${bk.label} for ${date.label}.`);
  if (fulfilment() === "delivery" && buns < minDelivery) {
    return showError(`Delivery is for orders of ${minDelivery} buns or more. Please add more buns, or choose pickup.`);
  }
  if (!get("name")) return showError("Please fill in your name.");
  if (!get("phone")) return showError("Please fill in your phone number.");
  const toBoat = fulfilment() === "delivery" && deliverTo() === "boat";
  if (toBoat && !boat) return showError("Please search for your boat and pick it from the list.");
  if (toBoat && !$<HTMLInputElement>("#boat-time").value) return showError("Please say what time the boat will be there.");
  if (toBoat && $<HTMLInputElement>("#boat-time").value < bk.bake) return showError(`The ${bk.label} is ready at ${bk.ready}. Please pick a later time for the boat.`);
  const time = fulfilment() === "pickup" ? $<HTMLSelectElement>("#pickup-time").value : toBoat ? "" : $<HTMLSelectElement>("#delivery-time").value;
  if (!toBoat && !time) return showError(fulfilment() === "pickup" ? "Please choose what time you'll come." : "Please choose a delivery time.");
  if (fulfilment() === "delivery" && !pin) {
    $("#map").scrollIntoView({ behavior: "smooth", block: "center" });
    return showError("Please tap the map to show us where to deliver.");
  }

  track("submit", {
    date: date.date, kind: date.kind, bake: bk.bake, buns, items: Object.fromEntries(items.map((i) => [i.product_id, i.qty])), f: fulfilment(), boat: toBoat,
    time, cur: currency(), pay: payment(), saved: !!document.querySelector<HTMLSelectElement>("#saved")?.value,
  });
  const btn = $<HTMLButtonElement>("#submit");
  btn.disabled = true;
  btn.textContent = "Placing your order…";
  try {
    const r = await api<{ status_token: string; public_id: string }>("/create-order", {
      body: { name: get("name"), phone: get("phone"), fulfilment: fulfilment(), ...(fulfilment() === "delivery" && pin ? { lat: pin.lat, lng: pin.lng, address: get("address") || null } : {}),
        ...(toBoat ? { vessel_id: boat!.id, boat_time: $<HTMLInputElement>("#boat-time").value } : { time }), notes: get("notes") || null, delivery_date: date.date, bake: bk.bake, items, currency: currency(),
        ...(payment() !== "bank" ? { payment: payment(), session: signedIn!.session } : {}) },
    });
    rememberDetails({ name: get("name"), phone: get("phone"), fulfilment: fulfilment(), deliverTo: deliverTo(), address: fulfilment() === "delivery" ? get("address") : "", pin: fulfilment() === "delivery" ? pin : null, boat: toBoat ? boat : null });
    rememberOrder(r.status_token, r.public_id);
    track("order", { o: r.public_id });
    flush();
    location.href = `/order/?t=${encodeURIComponent(r.status_token)}`;
  } catch (err) {
    showError((err as Error).message, "server", (err as { status?: number }).status);
    btn.disabled = false;
    btn.textContent = "Place order";
  }
}

load();

// Signed in: install and notifications under the form.
if (signedIn) notifyFor({ session: signedIn.session });
