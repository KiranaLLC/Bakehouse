/*
==================================================
NEW-ORDER EMAILS
==================================================

Stripe calls POST /api/stripe/webhook when a
payment completes. After checking the call really
came from Stripe (STRIPE_WEBHOOK_SECRET), the
worker emails the bakery the full order through
Resend (RESEND_API_KEY): loaves, delivery date,
address, notes, tip, discount and the customer's
contact details.

Setup is in README.md ("Order emails").
==================================================
*/

const RESEND_API = "https://api.resend.com/emails";
const WEBHOOK_TOLERANCE_SECONDS = 300;

export async function handleStripeWebhook(request, env, fetchSession) {

  if (!env.STRIPE_WEBHOOK_SECRET) {
    return { received: false, error: "STRIPE_WEBHOOK_SECRET is not set" };
  }

  const payload = await request.text();
  const valid = await verifyWebhookSignature(payload, request.headers.get("stripe-signature"), env.STRIPE_WEBHOOK_SECRET);

  if (!valid) {
    throw Object.assign(new Error("Invalid Stripe webhook signature"), { status: 400, publicMessage: "Invalid signature." });
  }

  const event = JSON.parse(payload);

  if (event.type !== "checkout.session.completed") {
    return { received: true, ignored: event.type };
  }

  // Fetch the session again with its line items, so the email can list the loaves.
  const session = await fetchSession(event.data.object.id);

  if (session.payment_status !== "paid") {
    return { received: true, ignored: `payment_status ${session.payment_status}` };
  }

  await sendOrderEmail(session, env);
  return { received: true, emailed: true };

}

/*
==================================================
THE EMAIL
==================================================
*/

export async function sendOrderEmail(session, env) {

  if (!env.RESEND_API_KEY) {
    console.error("RESEND_API_KEY is not set; order email not sent");
    return;
  }

  const order = describeOrder(session);
  const subject = `New order: ${order.summary} — ${order.when}`;

  const response = await fetch(RESEND_API, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: env.ORDER_EMAIL_FROM,
      to: env.ORDER_EMAIL_TO.split(",").map(address => address.trim()).filter(Boolean),
      reply_to: order.email || undefined,
      subject,
      text: order.text,
      html: order.html
    })
  });

  if (!response.ok) {
    const details = await response.text().catch(() => "");
    throw new Error(`Resend rejected the order email (${response.status}): ${details}`);
  }

}

export function describeOrder(session) {

  const metadata = session.metadata || {};
  const details = session.customer_details || {};
  const items = (session.line_items?.data || []).map(item => ({
    name: item.description,
    quantity: item.quantity,
    amount: item.amount_subtotal ?? item.amount_total ?? 0
  }));

  const loaves = items.filter(item => !/^Tip for your baker$|^Local delivery$/.test(item.name));
  const loafCount = loaves.reduce((total, item) => total + item.quantity, 0);
  const summary = `${loafCount} ${loafCount === 1 ? "loaf" : "loaves"} for ${metadata.customer_name || details.name || "a customer"}`;
  const when = metadata.delivery_date_label || "date not set";
  const email = details.email || "";

  const rows = [
    ["Deliver on", when],
    ["Address", metadata.delivery_address || ""],
    ["Name", metadata.customer_name || details.name || ""],
    ["Phone", metadata.customer_phone || details.phone || ""],
    ["Email", email],
    ["Instructions", metadata.delivery_notes || ""],
    ["Distance", metadata.delivery_distance_miles ? `${metadata.delivery_distance_miles} miles` : ""],
    ["Tip", formatMoney(Number(metadata.tip_cents) || 0)],
    ["Discount", metadata.discount_code ? `${metadata.discount_code} (−${formatMoney(Number(metadata.discount_cents) || 0)})` : ""],
    ["Total paid", formatMoney(session.amount_total || 0)],
    ["Stripe payment", session.payment_intent || session.id || ""]
  ].filter(([, value]) => value);

  const text = [
    `Order: ${summary}`,
    "",
    ...items.map(item => `  ${item.quantity} × ${item.name}  ${formatMoney(item.amount)}`),
    "",
    ...rows.map(([label, value]) => `${label}: ${value}`)
  ].join("\n");

  const html = `
    <div style="font-family: -apple-system, Helvetica, Arial, sans-serif; color: #1c1c1c; max-width: 560px">
      <h2 style="margin: 0 0 16px">New order: ${escapeHtml(summary)}</h2>
      <table style="border-collapse: collapse; width: 100%; margin-bottom: 20px">
        ${items.map(item => `<tr><td style="padding: 6px 0; border-bottom: 1px solid #eee">${item.quantity} × ${escapeHtml(item.name)}</td><td style="padding: 6px 0; border-bottom: 1px solid #eee; text-align: right">${formatMoney(item.amount)}</td></tr>`).join("")}
      </table>
      <table style="border-collapse: collapse">
        ${rows.map(([label, value]) => `<tr><td style="padding: 4px 16px 4px 0; color: #666; vertical-align: top; white-space: nowrap">${escapeHtml(label)}</td><td style="padding: 4px 0">${escapeHtml(value)}</td></tr>`).join("")}
      </table>
    </div>`;

  return { summary, when, email, text, html };

}

function formatMoney(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}

/*
==================================================
STRIPE SIGNATURE CHECK

Stripe signs each webhook call with the endpoint's
signing secret (whsec_…). Anything unsigned, or
signed more than 5 minutes ago, is rejected.
==================================================
*/

export async function verifyWebhookSignature(payload, signatureHeader, secret) {

  const parts = Object.fromEntries((signatureHeader || "").split(",").map(part => part.split("=")));
  const timestamp = Number(parts.t);
  const signatures = (signatureHeader || "").split(",").filter(part => part.startsWith("v1=")).map(part => part.slice(3));

  if (!Number.isFinite(timestamp) || signatures.length === 0) return false;
  if (Math.abs(Date.now() / 1000 - timestamp) > WEBHOOK_TOLERANCE_SECONDS) return false;

  const expected = await hmacHex(secret, `${timestamp}.${payload}`);
  return signatures.some(signature => signature.length === expected.length && timingSafeEqual(signature, expected));

}

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(signature)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a, b) {
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}
