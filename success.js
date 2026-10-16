import { API, DELIVERY } from "./macros.js?v=4";
import { formatMoney } from "./delivery-rules.js?v=4";

const STORAGE_KEY = "kirana-order";
const LAST_ORDER_KEY = "kirana-last-order";
const summary = document.getElementById("order-summary");
const sessionId = new URLSearchParams(window.location.search).get("session_id");

let orderType = "delivery";

/*
  The order went through. Remember it in this browser so the order page can
  welcome the customer back next time, and offer a link to reorder it.
*/
try {
  const order = JSON.parse(sessionStorage.getItem(STORAGE_KEY));
  sessionStorage.removeItem(STORAGE_KEY);

  if (sessionId && order) {
    if (order.values?.mode === "pickup") orderType = "pickup";
    const { deliveryDate, pickupDayId, ...values } = order.values || {};
    localStorage.setItem(LAST_ORDER_KEY, JSON.stringify({ savedAt: Date.now(), cart: order.cart, tip: order.tip, values }));
    showReorderLink(order.cart, orderType);
  }
} catch {
  // Storage can be unavailable (e.g. private browsing). Nothing to do.
}

showNoteFor(orderType);

function showNoteFor(type) {
  document.querySelectorAll("[data-order-type]").forEach(element => {
    element.hidden = element.dataset.orderType !== type;
  });
}

function showReorderLink(cart, type) {
  const items = Object.entries(cart || {}).filter(([, quantity]) => quantity > 0).map(([productId, quantity]) => `${productId}:${quantity}`);
  if (items.length === 0) return;

  // Built by hand so the link stays readable (":" and "," are safe in a query string).
  const url = new URL(`order.html?reorder=${items.join(",")}${type === "pickup" ? "&mode=pickup" : ""}`, window.location.href);

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
  if (order.type) showNoteFor(order.type);

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
  if (order.type === "pickup") {
    delivery.append(
      strong("Pickup: "), order.pickupWhen, document.createElement("br"),
      strong("Where: "), order.pickupAddress, document.createElement("br"),
      strong("Name: "), order.name
    );
  } else {
    delivery.append(
      strong("Delivery: "), order.deliveryDate, document.createElement("br"),
      strong("To: "), `${order.name}, ${order.address}`
    );
  }
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
