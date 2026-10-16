# Kirana Bakehouse website

The public website plus online ordering (delivery and pickup) with Stripe.
The pages are plain HTML, CSS and JavaScript hosted on GitHub Pages. One
small piece of server code, a **Cloudflare Worker** in `worker/`, checks
delivery addresses, keeps track of pickup days and starts Stripe payments,
because the Stripe secret key can't live in public web pages.

## How ordering works

1. On `order.html` the customer picks their loaves and a tip, then chooses
   **Delivery** or **Pickup**.
   - Delivery: they enter their address first; as soon as it's complete the
     page asks the worker whether it is inside the delivery area and shows
     the fee. Then they pick a delivery date, and enter their name, phone
     and any delivery instructions.
   - Pickup: they pick a pickup date (each shows the place, the pickup
     window and how many loaves are left), then a pickup time, then their
     name and phone.
2. **Continue to Payment** sends the order to the worker, which re-checks
   everything (prices, quantities, dates, delivery area and fee, loaves
   left, tip and discount; the browser is never trusted for these) and
   creates a Stripe Checkout session for the exact total. For pickups the
   loaves are held for 30 minutes while the customer pays.
3. The customer enters their email and card on Stripe, then lands on
   `success.html`, which shows their order summary.

`order.html?mode=delivery` and `order.html?mode=pickup` pre-select one or the
other (the homepage buttons use these).

Each paid order appears in the Stripe Dashboard under **Payments** with its
line items, delivery charge and tip, and with the delivery date, name,
phone, address and delivery instructions under **Metadata** and **Shipping**.

## One-time setup

You need a free [Cloudflare](https://dash.cloudflare.com/sign-up) account,
your Stripe account, and [Node.js](https://nodejs.org) (version 20 or newer)
on your computer.

### 1. Deploy the worker

In a terminal, from the `worker` folder of this repository:

```bash
cd worker
npm install
npx wrangler login            # opens a browser window to log in to Cloudflare
npx wrangler secret put STRIPE_SECRET_KEY
```

When asked for the secret, paste your Stripe **secret key** (from
Stripe → Developers → API keys; use the `sk_test_…` key while testing and
the `sk_live_…` key when you go live). Then:

```bash
npx wrangler deploy
```

The last line printed is the worker's address, something like
`https://kirana-checkout.<your-account>.workers.dev`.

### 2. Tell the website where the worker is

In `macros.js`, replace the placeholder in `WORKER_URL` with that address.
Until you do, the order page tells customers to email instead.

### 3. Test, then go live

With the test key in place, open the order page and place an order with
Stripe's test card `4242 4242 4242 4242` (any future date, any CVC). When it
works, run `npx wrangler secret put STRIPE_SECRET_KEY` again with your live
key and `npx wrangler deploy`.

Also worth turning on in Stripe: customer email receipts for successful
payments, and an email to you for each successful payment.

### Driving distance (one-time setup)

Delivery fees are based on the **driving distance** from the kitchen, as
Google Maps would show it. The worker gets it from
[OpenRouteService](https://openrouteservice.org), which is free (a free
account allows 2,000 lookups a day). Without it, the worker falls back to
the straight-line distance, which is shorter than the road distance.

1. Sign up at https://openrouteservice.org/dev/#/signup and create an API key
   (the free "standard" plan).
2. From the `worker` folder, `npx wrangler secret put ROUTING_API_KEY` and
   paste the key.
3. `/api/status` on the worker should then show `drivingDistance: OK`.

### Pickup days (one-time setup)

Regular pickups come from the **weekly schedule** in `macros.js`
(`PICKUP.schedule`): currently Saturdays 2–3 pm at Verve Coffee Roasters,
University Ave, with 20 loaves. Every matching Saturday for the next four
weeks appears on the order page automatically. The private admin page
`admin.html` lets you change a single date (fewer loaves, a different
address), skip one (set its loaves to 0), or add a one-off pickup somewhere
else. Changed dates and all orders are stored in a small Cloudflare database
(D1, free). From the `worker` folder:

1. Create the database and copy its id into `wrangler.toml`:
   ```bash
   npx wrangler d1 create kirana-orders
   ```
   It prints a `database_id`; paste it over `REPLACE_WITH_YOUR_DATABASE_ID`
   in `wrangler.toml`.
2. Create the tables:
   ```bash
   npx wrangler d1 execute kirana-orders --remote --file=schema.sql
   ```
3. Choose a password for the admin page:
   ```bash
   npx wrangler secret put ADMIN_PASSWORD
   ```
4. Tell Stripe to report payments to the worker, so loaves are released when
   a payment is abandoned and confirmed when it completes. In the Stripe
   Dashboard go to **Developers → Webhooks → Add endpoint**, enter
   `https://<your-worker>.workers.dev/api/stripe/webhook`, and select the
   events `checkout.session.completed` and `checkout.session.expired`.
   Copy the endpoint's **signing secret** (`whsec_…`) and run:
   ```bash
   npx wrangler secret put STRIPE_WEBHOOK_SECRET
   ```
   (Without the webhook, orders are still confirmed when the customer lands
   on the thank-you page, and holds expire on their own after 30 minutes.)
5. `npx wrangler deploy`, then open `/api/status` on the worker: it should
   show `pickupDatabase: OK`, `adminPasswordSet: true` and
   `stripeWebhookSecretSet: true`.

**Changing the weekly schedule** (day, time, place, loaves): edit
`PICKUP.schedule` in `macros.js`, push to `main`, and run `npx wrangler
deploy` from the `worker` folder. Dates you've already edited on the admin
page keep their own settings.

**A one-off pickup day:** open `https://www.kiranabakehouse.com/admin.html`,
log in, click **+ New pickup day** and fill in the location name, address,
pickup date, pickup window, slot length, total loaves and the order cutoff
(Pacific time; the page suggests 11:59 pm the evening before). It appears on
the order page under **Pickup** as soon as it's saved, showing "N loaves
left" until it sells out or the cutoff passes. **Reset to schedule** on an
edited weekly date puts it back to the schedule's settings.

**On baking day:** open the pickup day's **Orders** on the admin page for the list
by pickup time (name, phone, loaves) and the bake list totals; **Copy bake
list** puts it on the clipboard. Loaves "on hold" belong to customers who are
on Stripe's payment page right now.

### Discount codes

Codes are kept as a Cloudflare secret, so they don't appear in this public
repository. From the `worker` folder:

```bash
npx wrangler secret put DISCOUNT_CODES
```

and enter the codes as `CODE=percent`, separated by commas, for example
`BREADUCATION=20` or `BREADUCATION=20,FRIENDS=10`. Codes aren't
case-sensitive. To add, change or remove a code, run the same command again
with the full new list (it replaces the old one). Discounts apply to the loaves
and delivery, not the tip. Each discounted order appears in Stripe with a
single-use coupon named after the code.

### Updating the worker later

If `worker/`, `macros.js`, `delivery-rules.js` or `pickup-rules.js` change (for example new
prices or delivery zones), run `npx wrangler deploy` from the `worker` folder
again so the worker picks up the new values. The website itself updates
whenever `main` is pushed to GitHub, as before.

## What to edit

All in `macros.js`:

| What | Where |
| --- | --- |
| Menu items, prices (in cents), descriptions, ingredients, photos, max per order | `PRODUCTS` (and `BASE_INGREDIENTS` for what every loaf shares) |
| Delivery days, closed dates (holidays), delivery window, how many days ahead customers must order, how far ahead they can book | `DELIVERY` |
| Tip percentages offered, maximum tip | `TIP` |
| Kitchen address, delivery radius, fee per distance zone, free-delivery threshold | `DELIVERY_SERVICE` |
| The worker's address | `WORKER_URL` |
| Weekly pickup schedule (day, time, place, loaves, order cutoff), hold time | `PICKUP` |

Product photos for the order page are in `img/menu/` (resized to load quickly
on phones — keep new ones around 800px wide and under ~200 KB).

## Previewing locally

Run the website and the worker side by side, in two terminals:

```bash
# Terminal 1, in the repository folder: the website
python3 -m http.server 8000

# Terminal 2, in the worker folder: the worker (needs worker/.dev.vars, see .dev.vars.example)
cd worker && npx wrangler dev
```

Then open http://localhost:8000/order.html.

Once `WORKER_URL` in `macros.js` points at your deployed worker, the local
page talks to that worker and Terminal 2 isn't needed.
