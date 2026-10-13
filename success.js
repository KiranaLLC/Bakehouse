import { API, DELIVERY } from "./macros.js";
import { formatMoney } from "./delivery-rules.js";

const STORAGE_KEY = "kirana-delivery-order";
const summary = document.getElementById("order-summary");
const sessionId = new URLSearchParams(window.location.search).get("session_id");

// The order went through, so the saved cart on the order page is no longer needed.
try {
  sessionStorage.removeItem(STORAGE_KEY);
} catch {
  // Storage can be unavailable (e.g. private browsing). Nothing to do.
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
