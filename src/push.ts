// The store as an app (PWA): the service worker (public/sw.js), "Install the app", and notifications (web push)
// for the customer this phone belongs to: signed in (session) or whose order page it is (t).
import { $, api, html, render } from "./lib.ts";
import { track } from "./track.ts";

const reg = "serviceWorker" in navigator ? navigator.serviceWorker.register("/sw.js").catch(() => null) : Promise.resolve(null);
const standalone = matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
// Android and computers: Chrome offers installing; we keep its prompt for our own button.
let installPrompt: (Event & { prompt(): Promise<void> }) | null = null;
addEventListener("beforeinstallprompt", (e) => (e.preventDefault(), installPrompt = e as typeof installPrompt, mount()));

let owner: { t: string } | { session: string } | null = null;
let busy = false;

/** Shows the notifications card in #notify for this customer; null hides it (signed out). */
export function notifyFor(o: typeof owner) {
  owner = o;
  mount();
}

const b64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function mount() {
  const el = document.querySelector<HTMLElement>("#notify");
  if (!el || busy) return;
  if (!owner) return render(el, html``);
  const install = installPrompt && !standalone ? html`<button type="button" class="secondary" id="install">📲 Install the Alina Bun app</button>` : "";
  const r = await reg;
  if (!r || !("PushManager" in window)) {
    // iPhone: notifications only work in the app added to the Home Screen (iOS 16.4+).
    return render(el, ios && !standalone ? html`<div class="card small"><h2>🔔 Get notified about your order</h2>
      <p>On iPhone, add the store to your Home Screen first: in Safari tap <b>Share</b> <span aria-hidden="true">⬆︎</span>, then <b>Add to Home Screen</b>. Open Alina Bun from there and turn on notifications.</p></div>`
      : install ? html`<div class="card small">${install}</div>` : html``), wireInstall();
  }
  const { public_key } = await api<{ public_key: string | null }>("/push/key").catch(() => ({ public_key: null }));
  if (!public_key) return render(el, install ? html`<div class="card small">${install}</div>` : html``), wireInstall();
  const sub = await r.pushManager.getSubscription();
  if (sub) api("/push/subscribe", { body: { subscription: sub.toJSON(), ...owner } }).catch(() => {}); // keep it linked to this customer
  render(el, html`<div class="card small"><h2>🔔 Notifications</h2>
    ${Notification.permission === "denied" ? html`<p>Notifications are blocked for this site. You can allow them in your phone's settings.</p>`
      : sub ? html`<p>On: we'll let you know about your orders on this phone.</p><button type="button" class="secondary" id="push-off">Turn off</button>`
      : html`<p>Get a message on this phone when your buns are on the way.</p><button type="button" class="primary" id="push-on">Turn on notifications</button>`}
    ${install}<div id="push-err"></div></div>`);
  wireInstall();
  $("#push-on")?.addEventListener("click", () => run(async () => {
    if (await Notification.requestPermission() !== "granted") return;
    const s = await r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(public_key) });
    await api("/push/subscribe", { body: { subscription: s.toJSON(), ...owner } });
    track("click", { t: "push_on" });
  }));
  $("#push-off")?.addEventListener("click", () => run(async () => {
    const s = await r.pushManager.getSubscription();
    if (s) await api("/push/unsubscribe", { body: { endpoint: s.endpoint } }), await s.unsubscribe();
  }));
}

async function run(fn: () => Promise<void>) {
  busy = true;
  try {
    await fn();
  } catch (e) {
    render($("#push-err"), html`<div class="notice bad" style="margin-top:var(--space-3)">${(e as Error).message}</div>`);
    busy = false;
    return;
  }
  busy = false;
  mount();
}

function wireInstall() {
  $("#install")?.addEventListener("click", async () => {
    await installPrompt?.prompt();
    installPrompt = null;
    track("click", { t: "install" });
    mount();
  });
}
