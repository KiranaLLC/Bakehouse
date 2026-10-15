/*
==================================================
VALIDATION

Nothing sent by the browser is trusted: every
order is checked here before Stripe sees it.
==================================================
*/

import { PRODUCTS, TIP } from "../../macros.js";

export class OrderValidationError extends Error {}
export class AddressNotFoundError extends Error {}
export class AdminAuthError extends Error {}

export function parseItems(items) {

  if (!Array.isArray(items) || items.length === 0) {
    throw new OrderValidationError("Your cart is empty.");
  }

  // Combine repeated products so the per-product limit can't be bypassed.
  const quantities = new Map();

  for (const item of items) {
    const productId = item?.productId;
    const product = Object.hasOwn(PRODUCTS, productId) ? PRODUCTS[productId] : null;
    const quantity = Number(item?.quantity);

    if (!product) {
      throw new OrderValidationError("Invalid product.");
    }

    if (!Number.isInteger(quantity) || quantity < 1) {
      throw new OrderValidationError("Invalid quantity.");
    }

    const total = (quantities.get(productId) || 0) + quantity;

    if (total > product.maxQuantity) {
      throw new OrderValidationError(`${product.name} has a maximum quantity of ${product.maxQuantity}.`);
    }

    quantities.set(productId, total);
  }

  return [...quantities].map(([productId, quantity]) => ({ productId, quantity }));

}

export function parseCustomer(customer, reason = "on delivery day") {

  const name = cleanText(customer?.name, 100);
  const phone = cleanText(customer?.phone, 30);

  if (!name) throw new OrderValidationError("Please enter your name.");

  const digits = phone.replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 15) {
    throw new OrderValidationError(`Please enter a valid phone number so we can reach you ${reason}.`);
  }

  return { name, phone };

}

export function parseTip(tipCents) {

  if (tipCents === undefined || tipCents === null || tipCents === 0) return 0;

  if (!Number.isInteger(tipCents) || tipCents < 0 || tipCents > TIP.maxCents) {
    throw new OrderValidationError("Please enter a valid tip amount.");
  }

  return tipCents;

}

/*
  Discount codes are a Cloudflare secret so they
  stay out of the public repository:
    npx wrangler secret put DISCOUNT_CODES
  with a value like  BREADUCATION=20,FRIENDS=10
  (code = percent off). Codes aren't case-sensitive.
*/
export function findDiscount(code, env) {

  const wanted = cleanText(code, 40).toUpperCase();

  for (const entry of (env.DISCOUNT_CODES || "").split(",")) {
    const [name, percent] = entry.split("=").map(part => part.trim());
    const value = Number(percent);
    if (name && name.toUpperCase() === wanted && Number.isInteger(value) && value > 0 && value <= 100) {
      return { code: name.toUpperCase(), percent: value };
    }
  }

  throw new OrderValidationError("That discount code isn't valid.");

}

export function cleanText(value, maxLength) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, maxLength) : "";
}

/*
  The admin page sends the password as
  "Authorization: Bearer <password>".
*/
export function requireAdmin(request, env) {

  if (!env.ADMIN_PASSWORD) {
    throw Object.assign(new Error("ADMIN_PASSWORD is not set"), { publicMessage: "The admin password isn't set yet. Run: npx wrangler secret put ADMIN_PASSWORD" });
  }

  const header = request.headers.get("Authorization") || "";
  const password = header.startsWith("Bearer ") ? header.slice(7) : "";

  if (!password || !timingSafeEqual(password, env.ADMIN_PASSWORD)) {
    throw new AdminAuthError("Wrong password.");
  }

}

function timingSafeEqual(a, b) {
  let difference = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) difference |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return difference === 0;
}
