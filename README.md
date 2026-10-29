# Kirana Bakehouse website

The public website plus online delivery ordering with Stripe. The pages are
plain HTML, CSS and JavaScript hosted on GitHub Pages. One small piece of
server code, a **Cloudflare Worker** in `worker/`, checks delivery addresses
and starts Stripe payments, because the Stripe secret key can't live in
public web pages.

## How ordering works

1. On `order.html` the customer picks their loaves, chooses a tip, enters
   their name, phone and address, and picks a delivery date.
2. As soon as the address is complete, the page asks the worker whether it
   is inside the delivery area and shows the delivery fee and total.
3. **Continue to Payment** sends the order to the worker, which re-checks
   everything (prices, quantities, delivery date, delivery area, fee and tip;
   the browser is never trusted for these) and creates a Stripe Checkout
   session for the exact total.
4. The customer enters their email and card on Stripe, then lands on
   `success.html`, which shows their order summary.

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

### Daily capacity

Each delivery day takes at most `DELIVERY.dailyLoafLimit` loaves (10) across
all orders, set in `macros.js`. The order page shows how many loaves are left
on each date, and the worker refuses a checkout that doesn't fit.

There's no separate database: the worker counts loaves from Stripe Checkout
Sessions. Paid orders count, and so do customers who are on the Stripe payment
page right now. Their loaves are held for about 30 minutes, until that payment
page expires. A customer who goes back to change their order releases their
own hold. To change the limit, edit `dailyLoafLimit` and deploy the worker
again (see below).

Two customers paying for the very last loaves at the same moment could both
get through, so a day can occasionally go a loaf or two over.

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

If `worker/`, `macros.js` or `delivery-rules.js` change (for example new
prices or delivery zones), run `npx wrangler deploy` from the `worker` folder
again so the worker picks up the new values. The website itself updates
whenever `main` is pushed to GitHub, as before.

## What to edit

All in `macros.js`:

| What | Where |
| --- | --- |
| Menu items, prices (in cents), descriptions, ingredients, photos, max per order | `PRODUCTS` (and `BASE_INGREDIENTS` for what every loaf shares) |
| Delivery days, closed dates (holidays), delivery window, how many days ahead customers must order, how far ahead they can book, loaves per day | `DELIVERY` |
| Tip percentages offered, maximum tip | `TIP` |
| Kitchen address, delivery radius, fee per distance zone, free-delivery threshold | `DELIVERY_SERVICE` |
| The worker's address | `WORKER_URL` |

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

To run the worker's tests (no Stripe account or network needed):

```bash
cd worker && npm test
```

On localhost the order page always uses the worker from Terminal 2, never the
live one, so local test orders go to your Stripe test account. If Terminal 2
isn't running, the order page says it can't reach the ordering system; the
other pages work as normal.
