// "/" — pick buns, a day, and details; the server re-prices everything.
import { $, api, html, mvr, render, store } from "./lib.ts";

interface Product { id: string; name: string; description: string | null; price_mvr: string; image_url: string | null }
interface DeliveryDate { date: string; label: string; available: boolean; left: number }

const MAX_PER_LINE = 50, MAX_BUNS = 100;
const app = $("#app");
const qty = new Map<string, number>();
let products: Product[] = [];
let dates: DeliveryDate[] = [];

async function load() {
  try {
    [{ products }, { dates }] = await Promise.all([api("/catalog"), api("/delivery-dates")]);
  } catch (e) {
    render(app, html`<div class="notice bad">${(e as Error).message}</div><button onclick="location.reload()">Try again</button>`);
    return;
  }
  const saved = store<{ name: string; phone: string; address: string }>("alinabun.customer");
  const firstOpen = dates.find((d) => d.available)?.date;
  render(app, html`
    <form id="f" novalidate>
      ${products.map((p) => html`
        <div class="card product">
          ${p.image_url ? html`<img src="${p.image_url}" alt="" loading="lazy" width="72" height="72">` : html`<div class="ph"></div>`}
          <div class="grow">
            <h3>${p.name}</h3>
            ${p.description ? html`<p class="small muted">${p.description}</p>` : ""}
            <div class="muted small">${mvr(p.price_mvr)}</div>
          </div>
          <div class="qty">
            <button type="button" class="round" data-step="-1" data-id="${p.id}" aria-label="One less ${p.name}">−</button>
            <output id="q-${p.id}" aria-live="polite">0</output>
            <button type="button" class="round" data-step="1" data-id="${p.id}" aria-label="One more ${p.name}">+</button>
          </div>
        </div>`)}

      <div class="card">
        <h2>Delivery day</h2>
        <div class="dates" role="radiogroup" aria-label="Delivery day">
          ${dates.map((d) => html`
            <label><input type="radio" name="delivery_date" value="${d.date}" ${d.available ? "" : "disabled"} ${d.date === firstOpen ? "checked" : ""}>
              <span>${d.label}${d.available ? "" : html`<small>Sold out</small>`}</span></label>`)}
        </div>

        <label for="name">Your name</label>
        <input id="name" name="name" autocomplete="name" maxlength="80" value="${saved?.name ?? ""}" required>

        <label for="phone">Phone number</label>
        <input id="phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="7xx xxxx" value="${saved?.phone ?? ""}" required>
        <div class="hint">A Maldives mobile number, so we can call you about the delivery.</div>

        <label for="address">Delivery address</label>
        <textarea id="address" name="address" autocomplete="street-address" maxlength="500" placeholder="House name, road, floor" required>${saved?.address ?? ""}</textarea>

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
    const next = Math.max(0, Math.min(MAX_PER_LINE, (qty.get(id) ?? 0) + step));
    if (step > 0 && total >= MAX_BUNS) return showError(`The most you can order at once is ${MAX_BUNS} buns.`);
    qty.set(id, next);
    $(`#q-${id}`).textContent = String(next);
    update();
  });
  $("#go").onclick = () => $("#submit").scrollIntoView({ behavior: "smooth", block: "center" });
  $<HTMLFormElement>("#f").onsubmit = submit;
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
  if (!get("name")) return showError("Please fill in your name.");
  if (!get("phone")) return showError("Please fill in your phone number.");
  if (get("address").length < 5) return showError("Please fill in your delivery address.");

  const btn = $<HTMLButtonElement>("#submit");
  btn.disabled = true;
  btn.textContent = "Placing your order…";
  try {
    const r = await api<{ status_token: string }>("/create-order", {
      body: { name: get("name"), phone: get("phone"), address: get("address"), notes: get("notes") || null, delivery_date: date.date, items },
    });
    store("alinabun.customer", { name: get("name"), phone: get("phone"), address: get("address") });
    location.href = `/order/?t=${encodeURIComponent(r.status_token)}`;
  } catch (err) {
    showError((err as Error).message);
    btn.disabled = false;
    btn.textContent = "Place order";
  }
}

load();
