// "/account/" — sign up with a phone number, proven by sending a code to our WhatsApp (wa-codes/ reads it).
import { $, api, copyBtn, html, loadError, mvr, render, store } from "./lib.ts";
import { busy, payBlock, type Payee, wirePay } from "./pay.ts";
import { notifyFor } from "./push.ts";
import { track } from "./track.ts";

export const SESSION_KEY = "alinabun.session";
const SIGNUP_KEY = "alinabun.signup"; // the try in progress, so coming back from WhatsApp (or a reload) carries on
interface Session { session: string; phone: string; name: string }
interface Signup { ticket: string; code: string; message: string; whatsapp_url: string; whatsapp_phone: string; phone: string; until: number }

interface Credit {
  limit_mvr: string | null; owed_mvr: string;
  pay: { amount: string; bank: Payee["bank"]; qr: string | null } | null; // null while a payment is being checked
  last_payment: { public_id: string; status: "awaiting_bank" | "paid" | "failed"; amount_mvr: string; received_mvr: string | null; checking_by_hand: boolean; message: string | null } | null;
}
interface Me { phone: string; name: string; cod: boolean; credit: Credit | null }

const app = $("#app");
let timer = 0;
let me: Me;
let poll = 0;

async function show() {
  clearTimeout(timer);
  const s = store<Session>(SESSION_KEY);
  if (s) {
    try {
      me = await api<Me>("/account/me", { body: { session: s.session } });
      paintAccount(s);
      notifyFor({ session: s.session });
      return;
    } catch (e) {
      if ((e as { status?: number }).status !== 401) return render(app, loadError(e));
      store(SESSION_KEY, null); // signed out elsewhere
    }
  }
  const p = store<Signup>(SIGNUP_KEY);
  if (p && p.until > Date.now()) return waiting(p);
  form();
}

/** The credit customer's own payment of what they owe: the order page's pay steps (pay.ts), for this amount. */
const payee = (s: Session): Payee | null => me.credit?.pay ? {
  id: "credit", amount: me.credit.pay.amount, currency: "MVR", qr: me.credit.pay.qr, bank: me.credit.pay.bank, what: "what you owe",
  uploadUrl: (content_type, size) => api("/account/credit-slip-url", { body: { session: s.session, content_type, size } }),
  send: async (pay) => {
    me.credit = (await api<{ credit: Credit }>("/account/pay-credit", { body: { session: s.session, ...pay } })).credit;
  },
  repaint: () => paintAccount(s),
} : null;

function lastPayment(c: Credit) {
  const p = c.last_payment;
  if (!p) return "";
  if (p.status === "awaiting_bank") {
    return p.checking_by_hand
      ? html`<div class="notice warn"><b>We're checking your payment of ${mvr(p.amount_mvr)} by hand.</b> No need to pay again.</div>`
      : html`<div class="notice warn"><b>We're checking your payment with the bank.</b> This usually takes up to 5 minutes. This page updates by itself.</div>`;
  }
  if (p.status === "paid") return html`<div class="notice ok"><b>Thank you! We received ${mvr(p.received_mvr ?? p.amount_mvr)}.</b></div>`;
  return html`<div class="notice bad">${p.message ?? "We couldn't use that payment."}</div>`;
}

function paintAccount(s: Session) {
  const c = me.credit, p = payee(s);
  render(app, html`<div class="card"><h2>Your account</h2>
      <p>Signed in as <strong>${me.name}</strong>, ${me.phone}. Your phone number is verified.</p>
      ${me.cod ? html`<p>💵 You can pay cash on delivery: choose it on the order form, for orders on this number.</p>` : ""}
      ${c?.limit_mvr ? html`<p>📒 You can order on credit and pay later, up to ${mvr(c.limit_mvr)}.</p>` : ""}
      <p><a class="btn" href="/">Order buns</a></p>
      <button type="button" class="secondary" id="out">Sign out</button></div>
    ${c ? html`<div class="card"><h2>📒 Your credit</h2>
      <p style="font-size:1.25em;margin:0">You owe <b>${mvr(c.owed_mvr)}</b></p>
      ${c.limit_mvr ? html`<p class="muted small">Your credit limit is ${mvr(c.limit_mvr)}.</p>` : ""}
      ${lastPayment(c)}</div>` : ""}
    ${p ? payBlock(p) : ""}`);
  $("#out").onclick = signOut;
  if (p) wirePay(p);
  // While the bank check runs, look again every 20 seconds (not under someone choosing a screenshot).
  clearInterval(poll);
  if (c?.last_payment?.status === "awaiting_bank" && !c.last_payment.checking_by_hand) {
    poll = setInterval(async () => {
      if (document.hidden || busy()) return;
      try {
        me = await api<Me>("/account/me", { body: { session: s.session } });
        paintAccount(s);
      } catch { /* offline for a moment */ }
    }, 20_000);
  }
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
  clearInterval(poll);
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
