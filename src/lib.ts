// Shared helpers for all three pages.
import "./style.css";

export const FUNCTIONS_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/store`;
/** Instagram DM link for a handle (the handle comes from the server's settings). */
export const igLink = (handle: string) => `https://ig.me/m/${encodeURIComponent(handle)}`;

/** Calls the store function. Throws Error(message) with a human-readable message. */
// deno-lint-ignore no-explicit-any
export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; token?: string } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(FUNCTIONS_URL + path, {
      method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
      headers: {
        ...(opts.body === undefined ? {} : { "content-type": "application/json" }),
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  } catch {
    throw new Error("We can't reach the shop right now. Please check your internet and try again.");
  }
  const json = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(json?.error ?? "Something went wrong. Please try again."), { status: res.status });
  return json as T;
}

/** Escaped HTML template. Nest with raw(). */
export class Raw {
  constructor(public s: string) {}
}
export const raw = (s: string) => new Raw(s);
const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (v: unknown): string =>
  v instanceof Raw ? v.s : Array.isArray(v) ? v.map(esc).join("") : v == null || v === false ? "" : String(v).replace(/[&<>"']/g, (c) => ESC[c]);
export function html(strings: TemplateStringsArray, ...values: unknown[]): Raw {
  return raw(strings.reduce((out, s, i) => out + s + (i < values.length ? esc(values[i]) : ""), ""));
}

export const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
export function render(el: Element, content: Raw) {
  el.innerHTML = content.s;
}

export const mvr = (amount: string | number) => `MVR ${Number(amount).toFixed(2)}`;

/** Any element with data-copy="text" copies that text when clicked. */
document.addEventListener("click", async (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-copy]");
  if (!btn) return;
  const text = btn.dataset.copy!;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const t = Object.assign(document.createElement("textarea"), { value: text });
    document.body.append(t);
    t.select();
    document.execCommand("copy");
    t.remove();
  }
  const label = btn.textContent;
  btn.textContent = "Copied ✓";
  setTimeout(() => (btn.textContent = label), 1500);
});

export const copyBtn = (text: string, label = "Copy") => html`<button type="button" class="copy" data-copy="${text}">${label}</button>`;

export function store<T>(key: string, value?: T): T | null {
  try {
    if (value !== undefined) localStorage.setItem(key, JSON.stringify(value));
    else return JSON.parse(localStorage.getItem(key) ?? "null");
  } catch {
    // private mode or storage blocked: pre-fill is only a convenience
  }
  return null;
}

/** Orders placed or opened on this phone, newest first, so a closed tab (e.g. Instagram's browser) isn't a lost order. */
export interface SavedOrder { t: string; id: string }
const ORDERS_KEY = "alinabun.orders";
export const savedOrders = () => store<SavedOrder[]>(ORDERS_KEY) ?? [];
export function rememberOrder(t: string, id: string) {
  store(ORDERS_KEY, [{ t, id }, ...savedOrders().filter((o) => o.t !== t)].slice(0, 5));
}
export const forgetOrder = (t: string) => store(ORDERS_KEY, savedOrders().filter((o) => o.t !== t));
