import { formatMoney } from "./delivery-rules.js";

const CART_KEY = "kirana-delivery-order";
const PLACED_ORDER_KEY = "kirana-placed-order";
const summary = document.getElementById("order-summary");

let order = null;

// The order went through, so the saved cart on the order page is no longer needed.
try {
  order = JSON.parse(sessionStorage.getItem(PLACED_ORDER_KEY));
  sessionStorage.removeItem(CART_KEY);
  sessionStorage.removeItem(PLACED_ORDER_KEY);
} catch {
  // Storage can be unavailable (e.g. private browsing). The text above still applies.
}

if (order?.items?.length) renderOrderSummary(order);

function renderOrderSummary(order) {
  const heading = document.createElement("h2");
  heading.textContent = "Order summary";

  const rows = order.items.map(item => row(`${item.name} × ${item.quantity}`, formatMoney(item.amount)));
  rows.push(row("Delivery", order.deliveryFee === 0 ? "Free" : formatMoney(order.deliveryFee)));
  const total = row("Total", formatMoney(order.total));
  total.classList.add("summary-total");

  const delivery = document.createElement("p");
  delivery.className = "summary-delivery";
  delivery.append(
    strong("Delivery date: "), order.deliveryDate, document.createElement("br"),
    strong("Order reference: "), order.code
  );

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
