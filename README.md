# Kirana Bakehouse website

The public website, including online delivery ordering. It's plain HTML,
CSS and JavaScript with no server, so it can stay on GitHub Pages.

## How ordering works

1. On `order.html` the customer picks their loaves, enters their address and
   picks a delivery date.
2. The page checks the address is inside the delivery area (using the free
   OpenStreetMap address lookup) and shows the delivery fee and total.
3. **Continue to Payment** opens your Stripe Payment Link with the total
   already filled in. The customer enters their name, delivery address, phone
   and card on Stripe.
4. After paying they land on `success.html`, which shows their order summary.

### Seeing what was ordered

Each payment carries an **order reference** that describes the order, for example:

```
20261015-HW2-MA1-D450-T4450
```

| Part | Meaning |
| --- | --- |
| `20261015` | Delivery date (2026-10-15) |
| `HW2`, `MA1` | Product code + quantity (2 House White, 1 Margherita). Codes are in `macros.js`. |
| `D450` | Delivery fee in cents ($4.50) |
| `T4450` | Expected total in cents ($44.50) |

In the Stripe Dashboard, open the payment and look for the **client reference
ID** (it's on the Checkout Session; if you don't see it on the payment page,
it's always in the `checkout.session.completed` event under
Developers → Events). The customer's name, address and phone are on the
same payment.

**Check that the amount paid matches the `T` total.** Stripe's "customers
choose what to pay" box is editable, so a customer could change the amount
before paying. Setting a minimum on the Payment Link (below) limits this.

## One-time Stripe setup

1. In the Stripe Dashboard go to **Payment Links → New**.
2. Choose **Customers choose what to pay** (it may be under the product/price type).
   Name it e.g. "Kirana Bakehouse delivery order", currency USD.
   Set a **minimum** of at least your cheapest loaf (e.g. $12).
3. Under options, turn on:
   - **Collect customers' addresses → Shipping address**, limited to the US
   - **Require customers to provide a phone number**
   - Optional: add a custom text field "Delivery instructions" (not required)
4. Under **After payment**, choose **Don't show confirmation page** and redirect
   customers to `https://www.kiranabakehouse.com/success.html`.
5. Create the link, copy its URL (`https://buy.stripe.com/...`) and paste it
   into `paymentLinkUrl` in `macros.js`.
6. Make a test payment with the test-mode link first (test card
   `4242 4242 4242 4242`, any future date, any CVC), then switch to the live link.

Also worth turning on in Stripe: customer email receipts for successful
payments, and an email to you for each successful payment.

## What to edit

All in `macros.js`:

| What | Where |
| --- | --- |
| Menu items, prices (in cents), descriptions, photos, max per order, order codes | `PRODUCTS` |
| Delivery days, how many days ahead customers must order, how far ahead they can book | `DELIVERY` |
| Your Stripe Payment Link | `STRIPE` |
| Kitchen address, delivery radius, fee per distance zone, free-delivery threshold | `DELIVERY_SERVICE` |

Product photos for the order page are in `img/menu/` (resized to load quickly
on phones — keep new ones around 800px wide and under ~200 KB).

## Previewing locally

The pages use JavaScript modules, so open them through a local web server
rather than by double-clicking, e.g. `python3 -m http.server` and then
http://localhost:8000/order.html.
