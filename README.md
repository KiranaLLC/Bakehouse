# Kirana Bakehouse website

The public website, including online delivery ordering through Stripe. It's
plain HTML, CSS and JavaScript with no server, so it stays on GitHub Pages.

## How ordering works

1. On `order.html` the customer sees the menu, enters their address and picks
   a delivery date.
2. The page checks the address is inside the delivery area (using the free
   OpenStreetMap address lookup) and tells them their delivery fee.
3. **Choose Your Loaves & Pay** sends them to the Stripe Payment Link for
   their delivery zone. On Stripe's page they pick loaves and quantities, add
   a tip, and enter their name, delivery address, phone and card. The
   delivery charge for their zone is already included and can't be changed.
4. After paying they land on `success.html`.

Each order appears in the Stripe Dashboard under **Payments** with its line
items ("2 × House White, 1 × Margherita"), the delivery charge, tip, and the
customer's name, address and phone.

### Checking the delivery zone and date

The order page attaches a reference to each payment, for example
`ZONE3-25MI-20261015`: zone 3 (2–3 miles), about 2.5 miles from the kitchen,
delivery on 2026-10-15. It's the payment's **client reference ID** (on the
Checkout Session; if it isn't shown on the payment page, it's in the
`checkout.session.completed` event under Developers → Events).

If the address the customer gave Stripe doesn't match the zone, the delivery
charge was wrong — worth a quick look before baking. Adding a required
"Delivery date" text field to each link (below) also shows the date directly
on the payment.

## One-time Stripe setup

You need four Payment Links, one per delivery zone. They are identical except
for the delivery charge. Build the first one fully, then use **Duplicate** on
it for the other three and change only the delivery charge.

### 1. Products (once)

In **Product catalog**, add each loaf from `macros.js` with its photo, name,
description and price. Also add a product called **Tip for your baker** at
$1.00 (customers choose how many dollars to tip).

### 2. First Payment Link (zone 1: under 1 mile, free delivery)

1. **Payment Links → New**, choose **Products or subscriptions**.
2. Add all nine loaves. For each, turn on **Let customers adjust quantity**
   with a minimum of 0 and a maximum of 6 (the `maxQuantity` in `macros.js`).
   Add **Tip for your baker** with an adjustable quantity of 0 to 50.
3. Under **Options**:
   - **Collect customers' addresses → Shipping address**, limited to the US
   - **Require customers to provide a phone number**
   - **Add custom fields**: a required text field **Delivery date** (customers
     type the date the order page showed them), and optionally a text field
     **Delivery instructions**
   - **Shipping rates**: add a rate named **Local delivery (under 1 mile)** at
     $0.00. (Stripe applies a single shipping rate automatically.)
4. Under **After payment**, choose **Don't show confirmation page** and
   redirect to `https://www.kiranabakehouse.com/success.html`.
5. Create the link and copy its URL (`https://buy.stripe.com/...`).

### 3. The other three links

Duplicate the first link three times, changing only the shipping rate:

| Zone | Distance | Shipping rate |
| --- | --- | --- |
| 2 | 1–2 miles | **Local delivery (1–2 miles)** $3.00 |
| 3 | 2–3 miles | **Local delivery (2–3 miles)** $4.50 |
| 4 | 3–4 miles | **Local delivery (3–4 miles)** $6.00 |

The amounts must match `feeCents` in `macros.js` (in cents), since the order
page tells the customer the fee before sending them to Stripe.

### 4. Paste the links into the website

In `macros.js`, put each link's URL into the matching zone's `paymentLinkUrl`
under `DELIVERY_SERVICE.zones`. Until a zone has a link, customers in that
zone are asked to email instead.

### 5. Test, then go live

Build the links in **test mode** first and make a test order with card
`4242 4242 4242 4242` (any future date, any CVC). Then create the live links
the same way and paste those in.

Also worth turning on in Stripe: customer email receipts for successful
payments, and an email to you for each successful payment.

## What to edit

All in `macros.js`:

| What | Where |
| --- | --- |
| Menu items, prices (in cents), descriptions, photos, max per order | `PRODUCTS` (prices must match the products in Stripe) |
| Delivery days, how many days ahead customers must order, how far ahead they can book | `DELIVERY` |
| Kitchen address, delivery radius, zones, fee per zone, Stripe link per zone | `DELIVERY_SERVICE` |

Product photos for the order page are in `img/menu/` (resized to load quickly
on phones — keep new ones around 800px wide and under ~200 KB).

## Previewing locally

The pages use JavaScript modules, so open them through a local web server
rather than by double-clicking, e.g. `python3 -m http.server 8000` and then
http://localhost:8000/order.html.
