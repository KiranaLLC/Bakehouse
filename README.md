# Kirana Bakehouse website

The public website (`index.html` and friends) plus online delivery ordering
with Stripe (`order.html` → Stripe Checkout → `success.html`).

## How ordering works

1. On `order.html` the customer picks their loaves, enters their name, phone
   and address, and picks a delivery date.
2. As soon as the address is complete, the page asks the server whether it is
   inside the delivery area and shows the delivery fee and total.
3. **Continue to Payment** sends the order to `server.js`, which re-checks
   everything (prices, quantities, delivery date, delivery area and fee — the
   browser is never trusted for these) and creates a Stripe Checkout session.
4. The customer enters their email and card on Stripe, then lands on
   `success.html`, which shows their order summary.

Each paid order appears in the [Stripe Dashboard → Payments](https://dashboard.stripe.com/payments)
with the delivery date, name, phone, address and delivery instructions under
**Metadata**, and the address under **Shipping**.

## What to edit

All in `macros.js`:

| What | Where |
| --- | --- |
| Menu items, prices (in cents), descriptions, photos, max per order | `PRODUCTS` |
| Delivery days, how many days ahead customers must order, how far ahead they can book | `DELIVERY` |
| Kitchen address, delivery radius, fee per distance zone, free-delivery threshold | `DELIVERY_SERVICE` |

Product photos for the order page are in `img/menu/` (resized to load quickly
on phones — keep new ones around 800px and under ~200 KB).

## Running it locally

Needs [Node.js](https://nodejs.org) 20 or newer.

```bash
npm install
cp .env.example .env      # then put your Stripe *test* secret key in .env
npm start                 # http://localhost:3000/order.html
```

Use Stripe's test card `4242 4242 4242 4242`, any future expiry date and any
CVC to place a test order.

## Going live

GitHub Pages can only host plain files, so it can't run `server.js` (which
holds the Stripe secret key). The simplest setup is to host the whole site on
one Node host such as [Render](https://render.com) or [Railway](https://railway.app):

1. Create a new **Web Service** from this repository.
   Build command: `npm install`. Start command: `npm start`.
2. Add the environment variables from `.env.example`:
   `STRIPE_SECRET_KEY` (your live `sk_live_…` key) and
   `SITE_URL=https://www.kiranabakehouse.com`.
3. Point the `www.kiranabakehouse.com` domain at the new service (instead of
   GitHub Pages) by following the host's custom-domain instructions.

Pick a plan that doesn't "sleep" when idle, or the first customer after a quiet
period will wait ~30–60 seconds for checkout to start.

**Keeping the pages on GitHub Pages instead:** deploy the server as above, then
set `origin` in `API` in `macros.js` to the server's address, set
`SITE_URL=https://www.kiranabakehouse.com` and
`ALLOWED_ORIGINS=https://www.kiranabakehouse.com` on the server.

### Stripe settings worth turning on

- In Stripe's **customer email** settings, turn on receipts for successful
  payments so customers get a receipt (the success page tells them to expect one).
- In your Stripe **notification/communication preferences**, turn on emails for
  successful payments so you hear about every new order.
