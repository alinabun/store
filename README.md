# store.alinabun.com

The Alina Bun online store. Customers order buns, pay by BML transfer, and upload the slip.
The payment is confirmed automatically by claiming the slip's reference on the **BML Payments ledger**.

| | |
|---|---|
| **Live** | https://store.alinabun.com |
| **This repo** | the static website only (Vite + TypeScript, no framework) → GitHub Pages |
| **Backend** | Supabase project `vosokllmaifbcdfbfvdt`, schema `store`, edge function `store`. The code lives next to the Telegram bot in the private `alinabun` folder (`supabase/functions/store`, `supabase/migrations/2026101400000*_store*.sql`) and deploys with its `bin/sb deploy`. |

## Pages

```
index.html          /            order form
order/index.html    /order/?t=   the customer's receipt + payment page (t = secret status token)
admin/index.html    /admin/      managers (Supabase Auth email + password)
public/CNAME        store.alinabun.com
src/                page scripts, styles (brand tokens copied from alinabun-site), slip OCR parser
```

Real static pages with query params, so a refresh never 404s on Pages.
The browser never touches tables: everything goes through the `store` function.

## How an order flows

1. `/` → `create-order`. The customer drops a pin on the map (street or satellite; their own location shows as a
   blue dot) and may add directions. The server re-prices from `store.products`, checks the 20:00 Malé cutoff, the
   7-day booking window, off days and what's left (locked per date): before the cutoff the day before, a pre-order
   (max 50 buns per day and 50 per flavour, both editable); after it, and on the day, only the extras baked beyond
   the orders, and returns the order ID (`AB-7K4Q`) and the status token.
2. `/order/?t=…` shows the bank details and a PayMV QR for the total (scan with the BML app, or save it and scan
   from photos). The customer transfers, uploads a screenshot (compressed to 1600 px in
   the browser), and OCR (Tesseract, loaded only then) fills in the BML reference. The customer checks it and sends.
3. The server claims the reference on the ledger for **our own order total**, then posts the slip to the
   slips Telegram group, captioned with the order ID. The ledger's answer:

| Ledger says | Order becomes | Customer sees |
|---|---|---|
| 201 / 200 claimed | **paid** | "Paid, see you on Thu 16 Oct!" |
| 422 not received yet | **awaiting_bank**, retried every minute by pg_cron. After 30 min: flagged for review | "We're checking your payment with the bank…" (the page refreshes itself; "Check again" button) |
| 409 already used | back to **awaiting_payment** | "This payment reference has already been used…" (can upload again) |
| 422 underpaid | back to **awaiting_payment**, flagged | "We received MVR 100.00, but your order is MVR 120.00. Please message us…" Pay steps hidden so nobody pays twice. |
| claimed, but more than the total | **paid**, flagged "Overpaid MVR 30.00" | "We'll message you about the extra MVR 30.00." |

Slips stay in the private `slips` bucket for 24 hours, then an hourly job deletes them. The Telegram post is the
permanent copy: search the order ID in the slips group.

## Manager area (`/admin/`)

- **Orders**: filter by status, delivery date, "needs review"; search by order ID or phone. `/admin/?order=AB-7K4Q`
  opens one order (the Telegram caption links there).
- **Order actions**:
  - **Mark paid (manual)**: for underpaid top-ups, other banks, cash. Enter the BML references to lock (each must already be in the bank records; a part-payment is locked at the amount the bank shows), or none for non-BML money. A note is required.
  - **Check bank again**
  - **Mark delivered**
  - **Cancel** (reason shown to the customer)
  - **Reject order** (fake orders)
  - **Clear review flag** (after you've refunded an overpayment, etc.)
- **Production**: per bun for a day: the baking plan (editable here, or with /plan in the Telegram bot; both write
  the same plan), baked so far (bot /batch), pre-orders, extras sold, extras left, and paid / checking / not paid.
  Also the pre-order limit per day. The per-flavour limit is on each product.
- **Days**: weekly off days (Fri + Sat to start; a change starts 8 days out, after the days customers can already
  book) and one-time off days for any of the next 14 days. Orders already placed for a day you close stay; cancel them if needed.
- Each order shows **📍 Open pin in Google Maps**; the slips Telegram caption has the same link.
- **Invoices**: invoices for buns placed in shops. Pick the shop and invoice date, enter buns sold and free (tasting)
  per bun, the shop price and the shop's profit per bun sold (default MVR 5). The shop owes (price − profit) × sold.
  Print or save as PDF, then mark paid (or void with a reason). Unpaid invoices show a PayMV QR code: the shop scans it
  in any Maldives bank app with the account and amount filled in, then sends you the payslip.
- **Customers**: phone, name, paid orders, buns bought, last order. Managers only.
- **Products**: name, price, description, on sale, order, photo (public `products` bucket).

### Add a manager

1. Supabase dashboard → **Authentication → Users → Add user** → email + password, tick **Auto Confirm User**.
2. In the `alinabun` folder:
   ```bash
   bin/sb db query --linked "insert into store.managers (user_id, email, name) select id, email, 'Alina' from auth.users where email = 'alina@example.com'"
   ```
3. Recommended: **Authentication → Sign In / Providers → turn off "Allow new users to sign up"**. Anyone not in
   `store.managers` gets 403 anyway.

Remove a manager: `delete from store.managers where email = '…'`.

## Setup

### Website

```bash
npm install
npm run dev        # http://localhost:5173 (needs .env.local, see below)
npm run build      # tsc + vite → dist/
npm test           # slip parser tests (Deno)
```

`.env.production` holds the two public build values: `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`. The anon key
is only used for manager sign-in; every table is closed to it. Get it from Supabase → **Project Settings → API Keys
→ anon**. For local dev, put the same keys (or a local backend) in `.env.local` (gitignored).

### Deploy (Pages)

Push to `main`. `.github/workflows/pages.yml` builds and deploys `dist/` (it includes `CNAME`).
One-time: repo **Settings → Pages → Source: GitHub Actions**, custom domain `store.alinabun.com`, **Enforce HTTPS**.
DNS: `CNAME store → alinabun.github.io` (already set).

### Backend (in the `alinabun` folder)

`.env` needs, in addition to the bot's values:

| Key | What |
|---|---|
| `BAKERY_SERVICE_KEY` | the ledger key for the `bakery` service (BMLPayments: `bin/sb service add bakery`). Server-side only. |
| `SLIPS_CHAT_ID` | the slips Telegram group: add the bot, send `/whoami` there |
| `ALLOWED_ORIGINS` | optional, default `https://store.alinabun.com,http://localhost:5173` |

Then `bin/sb deploy`. That pushes secrets, runs migrations, deploys `telegram-bot` and `store`, and gives pg_cron the
store URL (Vault `alinabun_store_url`).

Bank details, cutoff hour and daily capacity live in `store.app_config` (change them without a deploy):

```bash
bin/sb db query --linked "update store.app_config set value = '250' where key = 'daily_capacity_buns'"
```

### Testing payments

Never test with a real customer's reference: a claim is permanent. Pay yourself small amounts, e.g. set a test
product's price to 0.10 MVR, or test against the ledger's `test` service.

Backend tests (real Postgres, ledger/Telegram/Storage faked):

```bash
cd supabase/functions/store
deno task check
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:54329/postgres deno task test
```
