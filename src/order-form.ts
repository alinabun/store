// "/" — pick buns, a day, and details; the server re-prices everything.
import { $, api, forgetOrder, html, mvr, raw, rememberOrder, render, savedOrders, store } from "./lib.ts";
import { type Pin, pinPicker } from "./map.ts";

interface Product { id: string; name: string; description: string | null; price_mvr: string; image_url: string | null }
interface DeliveryDate {
  date: string; label: string; kind: "preorder" | "extras"; available: boolean; closed: boolean; left: number;
  products: Record<string, number>; // buns of each kind still available that day
  delivery_open: boolean;
  delivery_times: TimeOption[]; pickup_times: TimeOption[]; // what can still be chosen that day
}
interface TimeOption { value: string; label: string }

const MAX_PER_LINE = 50, MAX_BUNS = 100;
const app = $("#app");
const qty = new Map<string, number>();
let products: Product[] = [];
let dates: DeliveryDate[] = [];
let pin: Pin | null = null;
let pickupPlace = "", pickupPhone = "", pickupMap: string | null = null;
let fee = 0; // laari; delivery fee for the current pin
interface Vessel { id: number; name: string; operator: string | null; vessel_type: string | null; location: string | null }
let boat: Vessel | null = null;
let cutoff = "6 pm"; // from the server's cutoff hour
let minDelivery = 0; // buns; delivery needs at least this many (from the server)
// deno-lint-ignore no-explicit-any
let leaflet: any = null;

async function load() {
  try {
    let r;
    [{ products }, r] = await Promise.all([api("/catalog"), api("/delivery-dates")]);
    ({ dates, pickup_place: pickupPlace, pickup_phone: pickupPhone, pickup_map_url: pickupMap } = r);
    minDelivery = Number(r.delivery_min_buns ?? 0);
    const hr = Number(r.cutoff_hour);
    cutoff = `${hr % 12 || 12} ${hr < 12 ? "am" : "pm"}`;
    $("#intro").textContent = `Pre-order by ${cutoff} the day before. After that, you can still order our extra buns while they last.`;
  } catch (e) {
    render(app, html`<div class="notice bad">${(e as Error).message}</div><button onclick="location.reload()">Try again</button>`);
    return;
  }
  const saved = savedDetails();
  const firstOpen = dates.find((d) => d.available)?.date;
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
            <label for="delivery-time">What time?</label>
            <select id="delivery-time"></select>
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
  leaflet = pinPicker($("#map"), saved[0]?.pin ?? null, (p) => {
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
  showSavedDetails();
  if (saved[0]) applyDetails(saved[0]);
  applyChange();
  wireBoatSearch();
  showSavedOrders();
  $("#clear").onclick = clearForm;
  $("#go").onclick = () => $("#submit").scrollIntoView({ behavior: "smooth", block: "center" });
  $<HTMLFormElement>("#f").onsubmit = submit;
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

/** Fill in who and where (never the buns, day or times); null empties them. */
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
  for (const p of products) {
    qty.set(p.id, 0);
    $(`#q-${p.id}`).textContent = "0";
  }
  $<HTMLTextAreaElement>("#notes").value = "";
  if (document.querySelector("#saved")) showSavedDetails(-1);
  applyDetails(null);
  $<HTMLSelectElement>("#delivery-time").value = day()?.delivery_times[0]?.value === "asap" ? "asap" : "";
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
  const pickupRadio = document.querySelector<HTMLInputElement>("input[name=fulfilment][value=pickup]")!;
  radio.disabled = !!d && !d.delivery_open;
  pickupRadio.disabled = !!d && !d.pickup_times.length; // today, after the last pickup time
  $("#delivery-full").textContent = radio.disabled ? "Full that day" : "";
  $("#pickup-closed").textContent = pickupRadio.disabled ? "Closed for today" : "";
  if (radio.disabled) pickupRadio.checked = true;
  else if (pickupRadio.disabled) radio.checked = true;
  fillTimes($<HTMLSelectElement>("#delivery-time"), d?.delivery_times ?? [], "asap");
  fillTimes($<HTMLSelectElement>("#pickup-time"), d?.pickup_times ?? []);
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
  $("#sum").textContent = buns ? `${buns} bun${buns > 1 ? "s" : ""} · ${mvr((laari + withFee) / 100)}${withFee ? " incl. delivery" : ""}` : "No buns yet";
  if (fulfilment() === "delivery" && buns < minDelivery) $("#sum").textContent += ` · delivery is for ${minDelivery}+ buns`;
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
  if (fulfilment() === "delivery" && buns < minDelivery) {
    return showError(`Delivery is for orders of ${minDelivery} buns or more. Please add more buns, or choose pickup.`);
  }
  if (!get("name")) return showError("Please fill in your name.");
  if (!get("phone")) return showError("Please fill in your phone number.");
  const toBoat = fulfilment() === "delivery" && deliverTo() === "boat";
  if (toBoat && !boat) return showError("Please search for your boat and pick it from the list.");
  if (toBoat && !$<HTMLInputElement>("#boat-time").value) return showError("Please say what time the boat will be there.");
  const time = fulfilment() === "pickup" ? $<HTMLSelectElement>("#pickup-time").value : toBoat ? "" : $<HTMLSelectElement>("#delivery-time").value;
  if (!toBoat && !time) return showError(fulfilment() === "pickup" ? "Please choose what time you'll come." : "Please choose a delivery time.");
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
        ...(toBoat ? { vessel_id: boat!.id, boat_time: $<HTMLInputElement>("#boat-time").value } : { time }), notes: get("notes") || null, delivery_date: date.date, items },
    });
    rememberDetails({ name: get("name"), phone: get("phone"), fulfilment: fulfilment(), deliverTo: deliverTo(), address: fulfilment() === "delivery" ? get("address") : "", pin: fulfilment() === "delivery" ? pin : null, boat: toBoat ? boat : null });
    rememberOrder(r.status_token, r.public_id);
    location.href = `/order/?t=${encodeURIComponent(r.status_token)}`;
  } catch (err) {
    showError((err as Error).message);
    btn.disabled = false;
    btn.textContent = "Place order";
  }
}

load();
