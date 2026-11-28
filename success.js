import { API, CONTACT, DELIVERY } from "./macros.js";
import { formatMoney } from "./delivery-rules.js";

const STORAGE_KEY = "kirana-delivery-order";
const LAST_ORDER_KEY = "kirana-last-order";
const summary = document.getElementById("order-summary");
const sessionId = new URLSearchParams(window.location.search).get("session_id");

/*
  The order went through. Remember it in this browser so the order page can
  welcome the customer back next time, and offer a link to reorder it.
*/
try {
  const order = JSON.parse(sessionStorage.getItem(STORAGE_KEY));
  sessionStorage.removeItem(STORAGE_KEY);
  // Paid, so there's no unfinished payment to release next time.
  sessionStorage.removeItem("kirana-pending-session");

  if (sessionId && order) {
    const { deliveryDate, ...values } = order.values || {};
    localStorage.setItem(LAST_ORDER_KEY, JSON.stringify({ savedAt: Date.now(), cart: order.cart, tip: order.tip, values }));
    showReorderLink(order.cart);
  }
} catch {
  // Storage can be unavailable (e.g. private browsing). Nothing to do.
}

function showReorderLink(cart) {
  const items = Object.entries(cart || {}).filter(([, quantity]) => quantity > 0).map(([productId, quantity]) => `${productId}:${quantity}`);
  if (items.length === 0) return;

  // Built by hand so the link stays readable (":" and "," are safe in a query string).
  const url = new URL(`order.html?reorder=${items.join(",")}`, window.location.href);

  const link = document.getElementById("reorder-link");
  link.href = url.toString();
  link.textContent = url.toString();

  const copyButton = document.getElementById("copy-reorder-link");
  copyButton.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(url.toString());
      copyButton.textContent = "Copied!";
    } catch {
      copyButton.textContent = "Press and hold the link to copy it";
    }
  });

  document.getElementById("reorder").hidden = false;
}

document.querySelectorAll(".delivery-window").forEach(element => {
  element.textContent = DELIVERY.windowLabel;
});

if (sessionId) loadOrderSummary();

async function loadOrderSummary() {
  try {
    const response = await fetch(`${API.origin}${API.orderSummary}?session_id=${encodeURIComponent(sessionId)}`);
    if (!response.ok) return;
    renderOrderSummary(await response.json());
  } catch {
    // The confirmation text above still applies; the summary is a bonus.
  }
}

/*
  How to reach us: always shown. Pickup orders also get a "can't find us?"
  line, since that's when people need it fast.
*/
function link(href, text) {
  const a = document.createElement("a");
  a.href = href;
  a.textContent = text;
  return a;
}

function showContact() {
  const instagram = link(`https://www.instagram.com/${CONTACT.instagram}/`, `@${CONTACT.instagram}`);
  instagram.target = "_blank";
  instagram.rel = "noopener noreferrer";
  document.getElementById("help-contact").replaceChildren(
    "Email ", link(`mailto:${CONTACT.email}`, CONTACT.email),
    ", or DM us on Instagram ", instagram, "."
  );
}

function showPickupHelp() {
  const line = document.getElementById("help-pickup");
  if (CONTACT.pickupPhone) {
    const digits = CONTACT.pickupPhone.replace(/[^\d+]/g, "");
    const phone = link(`tel:${digits}`, CONTACT.pickupPhone);
    phone.style.whiteSpace = "nowrap";
    line.replaceChildren("Can't find us at pickup? Call or text ", phone, ".");
  } else {
    line.textContent = `Can't find us at pickup? DM @${CONTACT.instagram} on Instagram; we check it during pickup.`;
  }
  line.hidden = false;
}

showContact();

function renderOrderSummary(order) {
  const heading = document.createElement("h2");
  heading.textContent = "Order summary";

  const rows = order.items.map(item => row(`${item.name} × ${item.quantity}`, formatMoney(item.amountTotal)));
  if (order.amountDiscount > 0) {
    rows.push(row(`Discount${order.discountCode ? ` (${order.discountCode})` : ""}`, `−${formatMoney(order.amountDiscount)}`));
  }
  if (order.amountGiftCard > 0) {
    rows.push(row("Gift card", `−${formatMoney(order.amountGiftCard)}`));
  }

  const total = row("Total paid", formatMoney(order.amountTotal));
  total.classList.add("summary-total");

  const cards = giftCardList(order.giftCards || []);

  // Just gift cards: nothing to bake or deliver.
  if (order.kind === "gift_cards") {
    document.getElementById("success-note").textContent =
      "Thank you for sharing Kirana Bakehouse!";
    const email = document.createElement("p");
    email.className = "summary-delivery";
    if (order.email) email.append(strong("Email: "), order.email);
    summary.replaceChildren(heading, ...rows, total, ...(order.email ? [email] : []), ...cards);
    summary.hidden = false;
    return;
  }

  const pickup = order.fulfillment === "pickup";
  const delivery = document.createElement("p");
  delivery.className = "summary-delivery";
  delivery.append(
    strong(pickup ? "Pickup: " : "Delivery: "), order.deliveryDate, document.createElement("br"),
    strong(pickup ? "Where: " : "To: "), pickup ? order.address : `${order.name}, ${order.address}`
  );

  if (pickup) {
    showPickupHelp();
    document.getElementById("success-note").textContent =
      "Your sourdough will be baked fresh that morning and waiting for you at pickup. We look forward to seeing you!";
  }
  if (order.email) {
    delivery.append(document.createElement("br"), strong("Email: "), order.email);
  }

  summary.replaceChildren(heading, ...rows, total, delivery, ...cards);
  summary.hidden = false;
}

/*
  Gift cards bought in this order: each code, and
  whether we emailed it to someone or it's the
  buyer's to pass on.
*/
function giftCardList(cards) {
  if (!cards.length) return [];
  const title = document.createElement("h3");
  title.className = "gift-codes-title";
  title.textContent = cards.length === 1 ? "Your gift card" : "Your gift cards";
  const list = document.createElement("ul");
  list.className = "gift-codes";
  for (const card of cards) {
    const item = document.createElement("li");
    const code = document.createElement("code");
    code.textContent = card.code;
    const note = document.createElement("span");
    note.textContent = `${formatMoney(card.amountCents)}${card.recipientName ? ` for ${card.recipientName}` : ""}. ` +
      (card.recipientEmail
        ? (card.emailed ? `Emailed to ${card.recipientEmail}.` : `We'll email it to ${card.recipientEmail}.`)
        : "Pass the code on, or use it yourself.");
    item.append(code, note);
    list.append(item);
  }
  const hint = document.createElement("p");
  hint.className = "gift-codes-hint";
  hint.textContent = "We've also emailed you every code. Gift cards can only be used for orders on our website.";
  return [title, list, hint];
}

function row(label, value) {
  const element = document.createElement("div");
  element.className = "summary-row";
  const labelElement = document.createElement("span");
  labelElement.textContent = label;
  const valueElement = document.createElement("span");
  valueElement.textContent = value;
  element.append(labelElement, valueElement);
  return element;
}

function strong(text) {
  const element = document.createElement("strong");
  element.textContent = text;
  return element;
}
