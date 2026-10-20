// "/" — pick buns, a day, and details; the server re-prices everything.
import { $, api, html, mvr, raw, render, store } from "./lib.ts";
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
          <label>Where should we deliver?</label>
          <p class="hint">Tap the map to put a pin on your home. Drag the pin to move it. The blue dot is where you are now.</p>
          <div id="map" class="map" aria-label="Map: tap to put your delivery pin"></div>
          <div class="hint" id="pin-status">${saved?.pin ? "Pin from your last order. Move it if you're somewhere else." : "No pin yet."}</div>

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
  }).catch(() => render($("#map"), html`<div class="notice bad">The map didn't load. Please check your internet and refresh the page.</div>`));
  $("#f").addEventListener("change", (e) => {
    if ((e.target as HTMLInputElement).name === "delivery_date") refreshDay();
    if ((e.target as HTMLInputElement).name === "fulfilment") refreshFulfilment();
  });
  refreshDay();
  $("#go").onclick = () => $("#submit").scrollIntoView({ behavior: "smooth", block: "center" });
  $<HTMLFormElement>("#f").onsubmit = submit;
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
}

function update() {
  let buns = 0, laari = 0;
  for (const p of products) {
    const n = qty.get(p.id) ?? 0;
    buns += n;
    laari += Math.round(Number(p.price_mvr) * 100) * n;
  }
  $("#sum").textContent = buns ? `${buns} bun${buns > 1 ? "s" : ""} · ${mvr(laari / 100)}` : "No buns yet";
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
  if (fulfilment() === "delivery" && !pin) {
    $("#map").scrollIntoView({ behavior: "smooth", block: "center" });
    return showError("Please tap the map to show us where to deliver.");
  }

  const btn = $<HTMLButtonElement>("#submit");
  btn.disabled = true;
  btn.textContent = "Placing your order…";
  try {
    const r = await api<{ status_token: string }>("/create-order", {
      body: { name: get("name"), phone: get("phone"), fulfilment: fulfilment(), ...(fulfilment() === "delivery" && pin ? { lat: pin.lat, lng: pin.lng, address: get("address") || null } : {}), notes: get("notes") || null, delivery_date: date.date, items },
    });
    store("alinabun.customer", { name: get("name"), phone: get("phone"), address: get("address"), pin });
    location.href = `/order/?t=${encodeURIComponent(r.status_token)}`;
  } catch (err) {
    showError((err as Error).message);
    btn.disabled = false;
    btn.textContent = "Place order";
  }
}

load();
