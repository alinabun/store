// "/" — pick buns, a day, and details; the server re-prices everything.
import { $, api, forgetOrder, html, mvr, raw, rememberOrder, render, savedOrders, store } from "./lib.ts";
import { type Pin, pinPicker } from "./map.ts";

interface Product { id: string; name: string; description: string | null; price_mvr: string; image_url: string | null }
interface DeliveryDate {
  date: string; label: string; kind: "preorder" | "extras"; available: boolean; closed: boolean; left: number;
  products: Record<string, number>; // buns of each kind still available that day
  delivery_open: boolean;
}

const MAX_PER_LINE = 50, MAX_BUNS = 100;
const app = $("#app");
const qty = new Map<string, number>();
let products: Product[] = [];
let dates: DeliveryDate[] = [];
let pin: Pin | null = null;
let pickupPlace = "";
let fee = 0; // laari; delivery fee for the current pin
interface Vessel { id: number; name: string; operator: string | null; vessel_type: string | null; location: string | null }
let boat: Vessel | null = null;
let cutoff = "8 pm"; // from the server's cutoff hour
// deno-lint-ignore no-explicit-any
let leaflet: any = null;

async function load() {
  try {
    let r;
    [{ products }, r] = await Promise.all([api("/catalog"), api("/delivery-dates")]);
    ({ dates, pickup_place: pickupPlace } = r);
    const hr = Number(r.cutoff_hour);
    cutoff = `${hr % 12 || 12} ${hr < 12 ? "am" : "pm"}`;
    $("#intro").textContent = `Pre-order by ${cutoff} the day before. After that, you can still order our extra buns while they last.`;
  } catch (e) {
    render(app, html`<div class="notice bad">${(e as Error).message}</div><button onclick="location.reload()">Try again</button>`);
    return;
  }
  const saved = store<{ name: string; phone: string; address: string; pin?: Pin }>("alinabun.customer");
  const firstOpen = dates.find((d) => d.available)?.date;
  pin = saved?.pin ?? null;
  render(app, html`
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
      </div>

      <div class="products">
      ${products.map((p, i) => html`
        <div class="product">
          ${p.image_url ? html`<img src="${p.image_url}" alt="${p.name} bun" ${i < 2 ? "" : raw('loading="lazy"')} width="450" height="800">` : html`<div class="ph"></div>`}
          <div class="product-row">
          <div class="product-body">
            <h3>${p.name}</h3>
            ${p.description ? html`<p class="small muted">${p.description}</p>` : ""}
            <div class="muted small">${mvr(p.price_mvr)} <span class="left" id="left-${p.id}"></span></div>
          </div>
          <div class="qty">
            <button type="button" class="round" data-step="-1" data-id="${p.id}" aria-label="One less ${p.name}">−</button>
            <output id="q-${p.id}" aria-live="polite">0</output>
            <button type="button" class="round" data-step="1" data-id="${p.id}" aria-label="One more ${p.name}">+</button>
          </div>
          </div>
        </div>`)}
      </div>

      <div class="card">
        <label for="name">Your name</label>
        <input id="name" name="name" autocomplete="name" maxlength="80" value="${saved?.name ?? ""}" required>

        <label for="phone">Phone number</label>
        <input id="phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="7xx xxxx" value="${saved?.phone ?? ""}" required>
        <div class="hint">A Maldives mobile number, so we can call you about your order.</div>

        <label>Delivery or pickup?</label>
        <div class="dates" role="radiogroup" aria-label="Delivery or pickup">
          <label><input type="radio" name="fulfilment" value="delivery" checked><span>Delivery<small id="delivery-full"></small></span></label>
          <label><input type="radio" name="fulfilment" value="pickup"><span>Pickup</span></label>
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
          <label id="pin-label">Where should we deliver?</label>
          <p class="hint" id="pin-hint">We deliver in Malé, Hulhulé and Hulhumalé. Tap the map to put a pin on your home. Drag the pin to move it. The blue dot is where you are now.</p>
          <div id="map" class="map" aria-label="Map: tap to put your delivery pin"></div>
          <div class="hint" id="pin-status">${saved?.pin ? "Pin from your last order. Move it if you're somewhere else." : "No pin yet."}</div>
          <div class="hint" id="fee-status"></div>

          <label for="address">Directions <span class="muted">(optional)</span></label>
          <textarea id="address" name="address" maxlength="500" placeholder="House name, floor, door colour, what's nearby">${saved?.address ?? ""}</textarea>
        </div>
        <div id="pickup-box" hidden><div class="notice info" style="margin-top:var(--space-3)">${pickupPlace}</div></div>

        <label for="notes">Notes <span class="muted">(optional)</span></label>
        <textarea id="notes" name="notes" maxlength="500" placeholder="Anything we should know?"></textarea>
      </div>

      <div id="err" role="alert"></div>
      <button class="primary" id="submit">Place order</button>
      <p class="hint" style="text-align:center">Next, you'll see how to pay by bank transfer.</p>
    </form>
    <div class="bar"><div class="wrap"><span id="sum">No buns yet</span><button type="button" class="secondary" id="go">Order ↓</button></div></div>
  `);

  $("#f").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-step]");
    if (!b) return;
    const id = b.dataset.id!;
    const total = [...qty.values()].reduce((a, n) => a + n, 0);
    const step = Number(b.dataset.step);
    const max = Math.min(MAX_PER_LINE, day()?.products[id] ?? 0);
    const next = Math.max(0, Math.min(max, (qty.get(id) ?? 0) + step));
    if (step > 0 && total >= MAX_BUNS) return showError(`The most you can order at once is ${MAX_BUNS} buns.`);
    qty.set(id, next);
    $(`#q-${id}`).textContent = String(next);
    update();
  });
  leaflet = pinPicker($("#map"), saved?.pin ?? null, (p) => {
    pin = { lat: p.lat, lng: p.lng };
    $("#pin-status").textContent = "📍 Pin placed. We'll call you when we're close.";
    showError("");
    quoteFee();
  }).catch(() => render($("#map"), html`<div class="notice bad">The map didn't load. Please check your internet and refresh the page.</div>`));
  $("#f").addEventListener("change", (e) => {
    if ((e.target as HTMLInputElement).name === "delivery_date") refreshDay();
    if ((e.target as HTMLInputElement).name === "fulfilment") refreshFulfilment();
    if ((e.target as HTMLInputElement).name === "deliver_to") refreshDeliverTo();
  });
  refreshDay();
  applyChange();
  wireBoatSearch();
  showSavedOrders();
  if (pin) quoteFee();
  $("#go").onclick = () => $("#submit").scrollIntoView({ behavior: "smooth", block: "center" });
  $<HTMLFormElement>("#f").onsubmit = submit;
}

/** After "Change order": the cancelled order's day, buns, delivery choice and notes, as far as they're still available. */
function applyChange() {
  const c = store<{ date: string; items: { product_id: string; qty: number }[]; fulfilment: string; notes: string | null }>("alinabun.change");
  if (!c) return;
  store("alinabun.change", null);
  const dateRadio = document.querySelector<HTMLInputElement>(`input[name=delivery_date][value="${c.date}"]`);
  if (dateRadio && !dateRadio.disabled) dateRadio.checked = true;
  const fRadio = document.querySelector<HTMLInputElement>(`input[name=fulfilment][value="${c.fulfilment}"]`);
  if (fRadio && !fRadio.disabled) fRadio.checked = true;
  refreshDay();
  for (const i of c.items) {
    const n = Math.min(i.qty, MAX_PER_LINE, day()?.products[i.product_id] ?? 0);
    if (!products.some((p) => p.id === i.product_id) || !n) continue;
    qty.set(i.product_id, n);
    $(`#q-${i.product_id}`).textContent = String(n);
  }
  if (c.notes) $<HTMLTextAreaElement>("#notes").value = c.notes;
  update();
  render($("#mine"), html`<div class="notice info">Your last order was cancelled and filled in here. Change what you need, then place it again.</div>`);
}

/** Orders from this phone that are still open, so a closed browser tab doesn't lose them. */
async function showSavedOrders() {
  const LABEL: Record<string, string> = { awaiting_payment: "Waiting for your payment", awaiting_bank: "Checking your payment", paid: "Paid" };
  const open: { t: string; id: string; label: string; day: string }[] = [];
  for (const o of savedOrders()) {
    try {
      const v = await api<{ status: string; delivery_label: string }>(`/order-status?t=${encodeURIComponent(o.t)}`);
      if (LABEL[v.status]) open.push({ ...o, label: LABEL[v.status], day: v.delivery_label });
      else forgetOrder(o.t); // delivered, cancelled or rejected: nothing to come back to
    } catch (e) {
      if ((e as Error).message.includes("couldn't find")) forgetOrder(o.t); // other errors (offline): keep it
    }
  }
  if (!open.length || $("#mine").childElementCount) return;
  render($("#mine"), html`<div class="card">
    <h2>Your order${open.length > 1 ? "s" : ""}</h2>
    ${open.map((o) => html`<p class="row between" style="margin:var(--space-2) 0"><span><b>${o.id}</b> · ${o.day}<br><span class="small muted">${o.label}</span></span>
      <a class="btn secondary-btn" href="/order/?t=${encodeURIComponent(o.t)}">View</a></p>`)}
  </div>`);
}

const day = () => dates.find((d) => d.date === document.querySelector<HTMLInputElement>("input[name=delivery_date]:checked")?.value);

/** Show what's left for the chosen day, and trim quantities that no longer fit. */
function refreshDay() {
  const d = day();
  $("#day-hint").textContent = !d ? "Sorry, nothing is available right now. Please check back later."
    : d.kind === "extras" ? `${d.label}: these are our extra buns, while they last.`
    : `Pre-order for ${d.label}. Orders close at ${cutoff} the day before.`;
  for (const p of products) {
    const n = Math.min(MAX_PER_LINE, d?.products[p.id] ?? 0);
    if ((qty.get(p.id) ?? 0) > n) {
      qty.set(p.id, n);
      $(`#q-${p.id}`).textContent = String(n);
    }
    $(`#left-${p.id}`).textContent = n === 0 ? "· Sold out" : d?.kind === "extras" || n <= 10 ? `· ${n} left` : "";
  }
  // Deliveries are capped per day; when full, only pickup is offered.
  const radio = document.querySelector<HTMLInputElement>("input[name=fulfilment][value=delivery]")!;
  radio.disabled = !!d && !d.delivery_open;
  $("#delivery-full").textContent = radio.disabled ? "Full that day" : "";
  if (radio.disabled) document.querySelector<HTMLInputElement>("input[name=fulfilment][value=pickup]")!.checked = true;
  refreshFulfilment();
  update();
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
          boat = vessels.find((v) => v.id === Number(b.dataset.vessel)) ?? null;
          render($("#boat-results"), html``);
          q.value = "";
          render($("#boat-picked"), html`<div class="notice ok small">⛴ <b>${boat!.name}</b> ${boat!.vessel_type ? `· ${boat!.vessel_type}` : ""}
            <button type="button" class="copy" id="boat-change">Change</button></div>`);
          $("#boat-change").onclick = () => { boat = null; render($("#boat-picked"), html``); q.focus(); };
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
  $("#sum").textContent = buns ? `${buns} bun${buns > 1 ? "s" : ""} · ${mvr((laari + withFee) / 100)}${withFee ? " incl. delivery" : ""}` : "No buns yet";
  showError("");
}

function showError(msg: string) {
  render($("#err"), msg ? html`<div class="notice bad">${msg}</div>` : html``);
  if (msg) $("#err").scrollIntoView({ behavior: "smooth", block: "center" });
}

async function submit(e: SubmitEvent) {
  e.preventDefault();
  const f = new FormData(e.target as HTMLFormElement);
  const items = [...qty].filter(([, n]) => n > 0).map(([product_id, qty]) => ({ product_id, qty }));
  const get = (k: string) => String(f.get(k) ?? "").trim();
  const date = dates.find((d) => d.date === get("delivery_date"));
  if (!items.length) return showError("Please choose at least one bun.");
  if (!date) return showError("Please pick a delivery day.");
  const buns = items.reduce((a, i) => a + i.qty, 0);
  if (buns > date.left) return showError(`Only ${date.left} buns are left for ${date.label}. Please order fewer or pick another day.`);
  const over = items.find((i) => i.qty > (date.products[i.product_id] ?? 0));
  if (over) return showError(`Only ${date.products[over.product_id] ?? 0} ${products.find((p) => p.id === over.product_id)?.name} left for ${date.label}.`);
  if (!get("name")) return showError("Please fill in your name.");
  if (!get("phone")) return showError("Please fill in your phone number.");
  const toBoat = fulfilment() === "delivery" && deliverTo() === "boat";
  if (toBoat && !boat) return showError("Please search for your boat and pick it from the list.");
  if (toBoat && !$<HTMLInputElement>("#boat-time").value) return showError("Please say what time the boat will be there.");
  if (fulfilment() === "delivery" && !pin) {
    $("#map").scrollIntoView({ behavior: "smooth", block: "center" });
    return showError("Please tap the map to show us where to deliver.");
  }

  const btn = $<HTMLButtonElement>("#submit");
  btn.disabled = true;
  btn.textContent = "Placing your order…";
  try {
    const r = await api<{ status_token: string; public_id: string }>("/create-order", {
      body: { name: get("name"), phone: get("phone"), fulfilment: fulfilment(), ...(fulfilment() === "delivery" && pin ? { lat: pin.lat, lng: pin.lng, address: get("address") || null } : {}),
        ...(toBoat ? { vessel_id: boat!.id, boat_time: $<HTMLInputElement>("#boat-time").value } : {}), notes: get("notes") || null, delivery_date: date.date, items },
    });
    store("alinabun.customer", { name: get("name"), phone: get("phone"), address: get("address"), pin });
    rememberOrder(r.status_token, r.public_id);
    location.href = `/order/?t=${encodeURIComponent(r.status_token)}`;
  } catch (err) {
    showError((err as Error).message);
    btn.disabled = false;
    btn.textContent = "Place order";
  }
}

load();
