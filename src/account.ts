// "/account/" — sign up with a phone number, proven by sending a code to our WhatsApp (wa-codes/ reads it).
import { $, api, copyBtn, html, loadError, render, store } from "./lib.ts";
import { notifyFor } from "./push.ts";
import { track } from "./track.ts";

export const SESSION_KEY = "alinabun.session";
const SIGNUP_KEY = "alinabun.signup"; // the try in progress, so coming back from WhatsApp (or a reload) carries on
interface Session { session: string; phone: string; name: string }
interface Signup { ticket: string; code: string; message: string; whatsapp_url: string; whatsapp_phone: string; phone: string; until: number }

const app = $("#app");
let timer = 0;

async function show() {
  clearTimeout(timer);
  const s = store<Session>(SESSION_KEY);
  if (s) {
    try {
      const me = await api<{ phone: string; name: string; cod: boolean; credit: { limit_mvr: string; owed_mvr: string } | null }>("/account/me", { body: { session: s.session } });
      return render(app, html`<div class="card"><h2>Your account</h2>
        <p>Signed in as <strong>${me.name}</strong>, ${me.phone}. Your phone number is verified.</p>
        ${me.cod ? html`<p>💵 You can pay cash on delivery: choose it on the order form, for orders on this number.</p>` : ""}
        ${me.credit ? html`<p>📒 You can order on credit and pay later, up to MVR ${me.credit.limit_mvr}. You owe <b>MVR ${me.credit.owed_mvr}</b>.</p>` : ""}
        <p><a class="btn" href="/">Order buns</a></p>
        <button type="button" class="secondary" id="out">Sign out</button></div>`), $("#out").onclick = signOut, notifyFor({ session: s.session });
    } catch (e) {
      if ((e as { status?: number }).status !== 401) return render(app, loadError(e));
      store(SESSION_KEY, null); // signed out elsewhere
    }
  }
  const p = store<Signup>(SIGNUP_KEY);
  if (p && p.until > Date.now()) return waiting(p);
  form();
}

function form(msg = "") {
  notifyFor(null);
  const d = store<{ name: string; phone: string }[]>("alinabun.details")?.[0];
  render(app, html`<form class="card" id="f"><h2>Create your account</h2>
    <p class="muted">We check your phone number with one WhatsApp message: no password.</p>
    ${msg ? html`<div class="notice warn">${msg}</div>` : ""}
    <label for="name">Your name</label><input id="name" name="name" autocomplete="name" maxlength="80" required value="${d?.name ?? ""}">
    <label for="phone">Your WhatsApp number</label><input id="phone" name="phone" type="tel" autocomplete="tel" inputmode="tel" placeholder="7712345" required value="${d?.phone ?? ""}">
    <div id="err" role="alert"></div>
    <button class="primary" style="margin-top:var(--space-4)">Continue</button></form>`);
  $<HTMLFormElement>("#f").onsubmit = async (e) => {
    e.preventDefault();
    const btn = $<HTMLButtonElement>("#f button");
    btn.disabled = true;
    try {
      const phone = $<HTMLInputElement>("#phone").value;
      const r = await api<Omit<Signup, "phone" | "until"> & { minutes: number }>("/account/start", { body: { name: $<HTMLInputElement>("#name").value, phone } });
      track("signup", { t: "start" });
      const p = { ...r, phone, until: Date.now() + r.minutes * 60_000 };
      store(SIGNUP_KEY, p);
      waiting(p);
    } catch (e) {
      render($("#err"), html`<div class="notice bad" style="margin-top:var(--space-3)">${(e as Error).message}</div>`);
      btn.disabled = false;
    }
  };
}

function waiting(p: Signup) {
  render(app, html`<div class="card"><h2>Send us your code on WhatsApp</h2>
    <p>Tap the button: WhatsApp opens with your code typed in. Just press send, from the WhatsApp on <strong>${p.phone}</strong>.</p>
    <p><a class="btn" href="${p.whatsapp_url}" target="_blank" rel="noopener" data-track="signup_whatsapp">Open WhatsApp</a></p>
    <p class="hint">Or send this message to ${p.whatsapp_phone}: <strong>${p.message}</strong> ${copyBtn(p.message)}</p>
    <p class="muted" id="state" aria-live="polite">Waiting for your message…</p>
    <button type="button" class="secondary" id="again">Use another number</button></div>`);
  $("#again").onclick = () => (store(SIGNUP_KEY, null), clearTimeout(timer), form());
  check(p);
}

async function check(p: Signup) {
  clearTimeout(timer);
  try {
    const r = await api<{ state: string } & Partial<Session>>("/account/check", { body: { ticket: p.ticket } });
    if (r.state === "verified") {
      store(SESSION_KEY, { session: r.session, phone: r.phone, name: r.name });
      store(SIGNUP_KEY, null);
      track("signup", { t: "done" });
      return show();
    }
    if (r.state !== "waiting" || p.until < Date.now()) {
      store(SIGNUP_KEY, null);
      return form("Your code has expired. Please start again and send the new code within 15 minutes.");
    }
  } catch {
    // offline for a moment: keep trying
  }
  timer = setTimeout(() => check(p), 3000);
}

async function signOut() {
  const s = store<Session>(SESSION_KEY);
  store(SESSION_KEY, null);
  if (s) await api("/account/sign-out", { body: { session: s.session } }).catch(() => {});
  form();
}

// Back from WhatsApp: check at once instead of waiting for the next tick.
document.addEventListener("visibilitychange", () => {
  const p = store<Signup>(SIGNUP_KEY);
  if (document.visibilityState === "visible" && p && !store(SESSION_KEY)) check(p);
});
show();
