import { API, DELIVERY } from "./macros.js";
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

function renderOrderSummary(order) {
  const heading = document.createElement("h2");
  heading.textContent = "Order summary";

  const rows = order.items.map(item => row(`${item.name} × ${item.quantity}`, formatMoney(item.amountTotal)));
  if (order.amountDiscount > 0) {
    rows.push(row(`Discount${order.discountCode ? ` (${order.discountCode})` : ""}`, `−${formatMoney(order.amountDiscount)}`));
  }

  const total = row("Total paid", formatMoney(order.amountTotal));
  total.classList.add("summary-total");

  const delivery = document.createElement("p");
  delivery.className = "summary-delivery";
  delivery.append(
    strong("Delivery: "), order.deliveryDate, document.createElement("br"),
    strong("To: "), `${order.name}, ${order.address}`
  );
  if (order.email) {
    delivery.append(document.createElement("br"), strong("Email: "), order.email);
  }

  summary.replaceChildren(heading, ...rows, total, delivery);
  summary.hidden = false;
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
