// The store as an app (PWA): the service worker (public/sw.js), "Install the app", and notifications (web push)
// for the customer this phone belongs to: signed in (session) or whose order page it is (t).
import { $, api, html, render } from "./lib.ts";
import { track } from "./track.ts";

const reg = "serviceWorker" in navigator ? navigator.serviceWorker.register("/sw.js").catch(() => null) : Promise.resolve(null);
const standalone = matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
// iPads say "Macintosh" but have a touch screen; an Android phone is never one.
const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (!/Android/.test(navigator.userAgent) && navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
// Android and computers: Chrome offers installing; we keep its prompt for our own button.
let installPrompt: (Event & { prompt(): Promise<void> }) | null = null;
addEventListener("beforeinstallprompt", (e) => (e.preventDefault(), installPrompt = e as typeof installPrompt, mount()));

const ua = navigator.userAgent;
const android = /Android/.test(ua);
// iPhone browsers other than Safari: Instagram/Facebook's built-in browser can't add to the Home Screen at all.
const inApp = /Instagram|FBAN|FBAV|FB_IAB|Line\//.test(ua);
const iosOther = ios && !inApp && /CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
const samsung = /SamsungBrowser/.test(ua);
const mac = /Macintosh/.test(ua) && !ios;
const safari = /Safari/.test(ua) && !/Chrome|Chromium|Edg|OPR/.test(ua);

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
  const install = installCard();
  const r = await reg;
  if (!r || !("PushManager" in window)) {
    // iPhone: notifications only work in the app added to the Home Screen (iOS 16.4+), so the install card says so.
    return render(el, install), wireInstall();
  }
  const { public_key } = await api<{ public_key: string | null }>("/push/key").catch(() => ({ public_key: null }));
  if (!public_key) return render(el, install), wireInstall();
  const sub = await r.pushManager.getSubscription();
  if (sub) api("/push/subscribe", { body: { subscription: sub.toJSON(), ...owner } }).catch(() => {}); // keep it linked to this customer
  render(el, html`<div class="card small"><h2>🔔 Notifications</h2>
    ${Notification.permission === "denied" ? html`<p>Notifications are blocked for this site. You can allow them in your phone's settings.</p>`
      : sub ? html`<p>On: we'll let you know about your orders on this phone.</p><button type="button" class="secondary" id="push-off">Turn off</button>`
      : html`<p>Get a message on this phone when your buns are on the way.</p><button type="button" class="primary" id="push-on">Turn on notifications</button>`}
    <div id="push-err"></div></div>${install}`);
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

// The Share icon as Safari draws it: a box with an arrow up.
const SHARE = html`<svg class="inline-ico" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-label="Share"><path d="M12 3v12M8 7l4-4 4 4"/><path d="M6 11H5v10h14V11h-1"/></svg>`;

/** "Get the app": Chrome's own install button where there is one, otherwise the steps for this phone or computer. */
function installCard() {
  if (standalone) return html``;
  const head = html`<h2>📲 Get the Alina Bun app</h2>
    <p>Alina Bun on your ${android || ios ? "Home Screen" : "computer"}, one tap away${ios ? ". On iPhone, that's also how you get notifications" : ""}.</p>`;
  if (installPrompt) return html`<div class="card small">${head}<button type="button" class="secondary" id="install">Install the app</button></div>`;
  const steps = (items: unknown[]) => html`<ol class="install-steps">${items.map((i) => html`<li>${i}</li>`)}</ol>`;
  let how;
  if (inApp) {
    how = html`<p>This page is open inside ${/Instagram/.test(ua) ? "Instagram" : "another app"}, which can't install apps. First open it in your browser:</p>
      ${steps([html`Tap <b>•••</b> at the top right.`, html`Tap <b>Open in external browser</b> (or <b>Open in Safari</b> / <b>Open in Chrome</b>).`, "Then follow the steps there."])}`;
  } else if (ios) {
    how = steps([
      iosOther ? html`Tap the <b>Share</b> button ${SHARE} next to the address bar.`
        : html`Tap the <b>Share</b> button ${SHARE} ${/iPad/.test(ua) || !/iPhone/.test(ua) ? "at the top" : "at the bottom of Safari (tap the address bar first if you don't see it)"}.`,
      html`Scroll down and tap <b>Add to Home Screen</b>.`,
      html`Tap <b>Add</b> at the top right.`,
      html`Open <b>Alina Bun</b> from your Home Screen${"PushManager" in window ? "" : ", and turn on notifications there"}.`,
    ]);
  } else if (android) {
    how = steps(samsung
      ? [html`Tap the menu <b>≡</b> at the bottom right.`, html`Tap <b>Add page to</b>, then <b>Home screen</b>.`, html`Tap <b>Add</b>.`]
      : [html`Tap the menu <b>⋮</b> at the top right of Chrome.`, html`Tap <b>Add to Home screen</b> (or <b>Install app</b>).`, html`Tap <b>Install</b>.`]);
  } else if (mac && safari) {
    how = steps([html`In the menu bar, click <b>File</b>.`, html`Click <b>Add to Dock</b>, then <b>Add</b>.`]);
  } else {
    how = steps([html`In Chrome or Edge, click the install icon at the right end of the address bar. Don't see it? Open the browser's menu and choose <b>Install</b>.`, html`Click <b>Install</b>.`]);
  }
  return html`<div class="card small">${head}${how}</div>`;
}

function wireInstall() {
  $("#install")?.addEventListener("click", async () => {
    await installPrompt?.prompt();
    installPrompt = null;
    track("click", { t: "install" });
    mount();
  });
}
