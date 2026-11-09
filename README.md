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

### Orders page

Your private orders page runs as its own small worker, `kirana-orders`,
separate from the public checkout worker. Its address is
**https://kirana-orders.vanya-weng.workers.dev**. Nothing on the
website links to it. Bookmark it on your phone. It has two views:

- **Orders**: every paid delivery order not yet delivered, grouped by
  delivery date, with the customer's address (tap for directions), phone
  (tap to call), email and delivery notes. Orders whose date has passed but
  that were never marked delivered stay at the top, marked "Past date".
- **Prep**: how many of each loaf to bake for each delivery date.

**Invoices** you create in Stripe (e.g. for catering) appear too, marked
"Invoice": paid ones, and sent ones not yet paid (also marked "Unpaid").
Drafts and voided invoices don't. To put an invoice under its delivery day,
add metadata to it in Stripe with the key `delivery_date` and a value like
`2026-12-16`; otherwise it's listed under "No delivery date set". Each
invoice line counts as loaves in the prep view, except lines mentioning
delivery, shipping, tips, fees or discounts.

Each order has two separate buttons:

- **Email \<name\>** opens a ready-written "your order has been delivered"
  email to the customer in your Mail app; press Send. It doesn't change the
  order.
- **Mark delivered** saves the order as delivered in Stripe, and it drops
  off the page. Tapped the wrong one? **Undo** puts it back. The email
  button stays available until you leave the page.

Two locks keep it private:

1. **Cloudflare Access**: Cloudflare emails a one-time code to your address
   before the page even loads. Anyone else is stopped by Cloudflare and
   never reaches the page.
2. **Your password**: then the page itself asks for your password.

Each device remembers you, so you won't be asked every time: the password
for 30 days, the Access code for as long as the Access settings say.

#### One-time setup

From the `worker` folder:

```bash
npx wrangler secret put STRIPE_SECRET_KEY --config wrangler.orders.toml   # same live key as the checkout worker
npx wrangler secret put ADMIN_PASSWORD --config wrangler.orders.toml      # a long password you don't use anywhere else
npm run deploy:orders
```

Then turn on Cloudflare Access:

1. In the Cloudflare dashboard, go to **Workers & Pages** → **kirana-orders**
   → **Settings** → **Domains & Routes**.
2. Next to `workers.dev`, click **Enable Cloudflare Access**.
3. Click **Manage Cloudflare Access** and make sure the allowed email is
   only hellokiranabakehouse@gmail.com. Remove any other address.
4. Open the orders page in a private window to check: you should get a
   Cloudflare screen asking for your email before anything else.

To sign out every device, set a new password the same way and run
`npm run deploy:orders` again.

Orders come straight from Stripe, so there's nothing else to keep in sync.
"Delivered" is saved on the order's payment in Stripe as `delivered_at`.

### Pickup drops

Pickup works like Hotplate: you schedule **drops** (a pickup day, a pickup
window, a location, how many loaves, and when ordering opens and closes), and
customers order and pay for a drop on the order page. Pickup has its own loaf
limit per drop, separate from delivery's daily limit.

**Customers** see a Delivery / Pickup choice at checkout. Pickup asks only for
a name and phone, then shows the next drops as cards:

- *Order by …* when a drop is open,
- *Opens … in 2d 4h* (a live countdown) before it opens,
- *Sold out* when every loaf is taken, or *Can't fit your order* when the cart
  is bigger than what's left.

Below the drops, customers can join the **notify list** to hear about the
next drop. A link to `order.html?pickup` opens the order page on pickup.

**You** manage drops on the orders page, in the **Drops** tab:

- **New drop** (defaults: Verve Coffee Roasters, 2–3 pm, 20 loaves, ordering
  closes at 8 pm the Wednesday before pickup; change them in `PICKUP.defaults` in
  `macros.js`). All times are Pacific.
- Each drop shows whether it's open, how many loaves are booked, and buttons
  to **Edit** or **Cancel** it.
- **Email notify list** opens one email to everyone on the list (as BCC)
  announcing the drop, with a link to order.
- **Remind customers** opens one email (BCC) to everyone who ordered from
  that drop.
- **Show list** shows the notify list, with **Remove** and **Copy all
  emails**.

Pickup orders appear on the **Orders** tab marked *Pickup* (with **Mark picked
up** and an **Email** "your order is ready" draft) and count in **Prep**.

#### One-time setup

Drops and the notify list live in a small Cloudflare D1 database (free). Until
it exists, the order page simply doesn't offer pickup.

From the `worker` folder:

```bash
npx wrangler d1 create kirana-pickup
```

It prints a `database_id`. In **both** `wrangler.toml` and
`wrangler.orders.toml`, paste that id into the `[[d1_databases]]` block at the
bottom and remove the `#` at the start of those four lines. Then:

```bash
npx wrangler d1 execute kirana-pickup --remote --file=schema.sql
npx wrangler deploy
npm run deploy:orders
```

When you're ready to stop using Hotplate, point the home page's pickup links
(`index.html`) at `order.html?pickup`.

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

After changing `order.js`, `success.js`, `macros.js` or `delivery-rules.js`,
bump the `?v=` number in `order.html` and `success.html` (it appears in the
`importmap` and the `<script>` tag) so browsers load the new scripts instead
of a cached copy.

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

To preview the orders page, set `ADMIN_PASSWORD` in `worker/.dev.vars`,
run `npm run dev:orders` in a third terminal (in the `worker` folder) and open
http://localhost:8788/admin. Access isn't involved locally, only the
password.

On localhost the order page always uses the worker from Terminal 2, never the
live one, so local test orders go to your Stripe test account. If Terminal 2
isn't running, the order page says it can't reach the ordering system; the
other pages work as normal.
