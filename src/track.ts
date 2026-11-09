// Our own analytics: what visitors see and do, sent to the store function (POST /e) for the admin Visitors tab.
// Anonymous: a random id for this phone (ab_v) and one for the visit (ab_s, ends after 30 minutes without activity),
// as cookies on .alinabun.com, so alinabun.com, links.alinabun.com and the store count one visit together: from the
// box's QR code to an order. Never anything typed. Phones that have opened the admin page (ab_staff) aren't counted.
// Events go in small batches: a few seconds after the page opens, then at most every 30 s, and when the page is left.
// links.alinabun.com (index.html) and alinabun.com (assets/site.js) carry the same tracker in plain JS.
import { FUNCTIONS_URL } from "./lib.ts";

type Props = Record<string, unknown>;
const ENDPOINT = `${FUNCTIONS_URL}/e`;
const DOMAIN = location.hostname.endsWith("alinabun.com") ? "; domain=alinabun.com; secure" : "";
const cookie = (k: string) => document.cookie.match(new RegExp(`(?:^|; )${k}=([^;]+)`))?.[1];
const setCookie = (k: string, v: string, secs: number) => (document.cookie = `${k}=${v}; max-age=${secs}; path=/; samesite=lax${DOMAIN}`);
const uuid = () => crypto.randomUUID?.() ??
  "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) => (+c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (+c / 4)))).toString(16));

const off = !!cookie("ab_staff");
const fresh = !cookie("ab_v");
const visitor = cookie("ab_v") ?? uuid();
let visit = "", cookies = true, landing = true, timer = 0, sent = false, errors = 0;
let shown = Date.now(), deepest = 0;
const queue: { n: string; p: string; t: number; x: Props }[] = [];

/** The visit this event belongs to; a new one on the first page, or after 30 minutes without activity. */
function current() {
  const v = cookies ? cookie("ab_s") : visit;
  if (v) return void (visit = v);
  flush(); // anything queued belongs to the visit that ended
  visit = uuid();
  const q = new URLSearchParams(location.search);
  let ref = "";
  try {
    if (landing) ref = ((u) => u.host + u.pathname)(new URL(document.referrer)).slice(0, 150); // never its query string
  } catch { /* no referrer */ }
  queue.push({
    n: "visit", p: location.pathname, t: Date.now(),
    x: { ref, q: landing ? q.get("s") || q.get("utm_source") || "" : "", lang: navigator.language, new: fresh && landing },
  });
}

export function track(n: string, x: Props = {}) {
  if (off) return;
  try { // counting must never get in the way of ordering
    current();
    landing = false;
    queue.push({ n, p: location.pathname, t: Date.now(), x });
    setCookie("ab_v", visitor, 400 * 86400);
    setCookie("ab_s", visit, 1800);
    if (cookies && cookie("ab_s") !== visit) cookies = false; // cookies blocked: this page keeps its visit in memory
    if (!timer) timer = setTimeout(flush, sent ? 30_000 : 4_000);
  } catch { /* lost, never in the way */ }
}

/** Send what's queued now (also before leaving the page). */
export function flush() {
  clearTimeout(timer);
  timer = 0;
  if (!queue.length) return;
  sent = true;
  const now = Date.now();
  const body = JSON.stringify({ visitor, visit, events: queue.splice(0, 50).map(({ t, ...e }) => ({ ...e, a: now - t })) });
  try {
    if (!navigator.sendBeacon(ENDPOINT, body)) throw new Error("not queued");
  } catch {
    fetch(ENDPOINT, { method: "POST", body, keepalive: true, mode: "no-cors" }).catch(() => {});
  }
  if (queue.length) flush();
}

if (!off) {
  const depth = () => (deepest = Math.max(deepest, scrollY + innerHeight));
  addEventListener("scroll", depth, { passive: true });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      shown = Date.now();
      if (cookies && !cookie("ab_s")) track("page"); // back to a tab left open: a new visit
      return;
    }
    if (!cookies || cookie("ab_s")) { // not after the visit has ended
      depth();
      track("leave", { ms: Date.now() - shown, y: Math.min(100, Math.round((deepest / document.documentElement.scrollHeight) * 100)) });
    }
    flush();
  });
  addEventListener("pagehide", flush);
  // Taps on anything marked data-track, and on links to other sites.
  document.addEventListener("click", (e) => {
    const el = (e.target as Element).closest?.<HTMLElement>("[data-track], a[href]");
    const t = el?.dataset.track || (el instanceof HTMLAnchorElement && el.host !== location.host ? el.host : "");
    if (t) track("click", { t });
  }, true);
  const err = (m: unknown) => errors++ < 5 && track("error", { m: String(m).slice(0, 200) });
  addEventListener("error", (e) => err(e.message));
  addEventListener("unhandledrejection", (e) => err(e.reason?.message ?? e.reason));
  track("page");
}
