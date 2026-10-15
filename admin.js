/*
==================================================
KIRANA BAKEHOUSE
PICKUP DAYS ADMIN

Private page for scheduling pickup days and
seeing their orders. Everything goes through the
worker, which checks the password on every call.
==================================================
*/

import { API, PICKUP } from "./macros.js";
import { formatMoney } from "./delivery-rules.js";

const PASSWORD_KEY = "kirana-admin-password";

const elements = {
  login: document.getElementById("login"),
  dashboard: document.getElementById("dashboard"),
  message: document.getElementById("message"),
  formCard: document.getElementById("drop-form-card"),
  form: document.getElementById("drop-form"),
  ordersCard: document.getElementById("orders-card")
};

let password = "";
let drops = [];

try {
  password = sessionStorage.getItem(PASSWORD_KEY) || "";
} catch {
  // Fine, they'll log in.
}

/*
==================================================
WORKER REQUESTS
==================================================
*/

async function request(method, path, body) {

  let response;

  try {
    response = await fetch(`${API.origin}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${password}` },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch {
    throw new Error("Couldn't reach the worker. Check your connection and try again.");
  }

  const data = await response.json().catch(() => ({}));

  if (response.status === 401) {
    logOut();
    throw new Error(data.error || "Please log in again.");
  }

  if (!response.ok) {
    throw new Error(data.error || "Something went wrong.");
  }

  return data;

}

function showMessage(text, ok = false) {
  elements.message.textContent = text;
  elements.message.className = `admin-message${ok ? " ok" : ""}`;
  elements.message.hidden = !text;
  if (text) elements.message.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

/*
==================================================
LOGIN
==================================================
*/

async function logIn(event) {

  event.preventDefault();

  const error = document.getElementById("login-error");
  error.hidden = true;
  password = document.getElementById("password").value;

  try {
    await request("POST", API.adminLogin, {});
    try { sessionStorage.setItem(PASSWORD_KEY, password); } catch { /* ignore */ }
    elements.login.hidden = true;
    elements.dashboard.hidden = false;
    await loadDrops();
  } catch (requestError) {
    password = "";
    error.textContent = requestError.message;
    error.hidden = false;
  }

}

function logOut() {
  password = "";
  try { sessionStorage.removeItem(PASSWORD_KEY); } catch { /* ignore */ }
  elements.dashboard.hidden = true;
  elements.login.hidden = false;
  document.getElementById("password").value = "";
}

/*
==================================================
DROPS LIST
==================================================
*/

async function loadDrops() {

  try {
    const data = await request("GET", API.adminPickupDays);
    drops = data.days;
    renderDrops();
  } catch (error) {
    showMessage(error.message);
  }

}

function renderDrops() {

  const today = new Date().toISOString().slice(0, 10);
  const upcoming = drops.filter(drop => drop.pickupDate >= today).sort((a, b) => a.pickupDate.localeCompare(b.pickupDate));
  const past = drops.filter(drop => drop.pickupDate < today);

  renderDropList(document.getElementById("upcoming-drops"), upcoming, "No upcoming pickup days. Click \"+ New pickup day\" to schedule one.");
  renderDropList(document.getElementById("past-drops"), past, "No past pickup days yet.");

}

function renderDropList(container, list, emptyText) {

  container.innerHTML = "";

  if (list.length === 0) {
    const empty = document.createElement("p");
    empty.className = "admin-meta";
    empty.textContent = emptyText;
    container.appendChild(empty);
    return;
  }

  list.forEach(drop => {

    const card = document.createElement("article");
    card.className = "admin-card";

    const isPast = drop.pickupDate < new Date().toISOString().slice(0, 10);
    const statusLabel = isPast ? "past" : drop.skipped ? "closed" : drop.status.replace("_", "-");
    const statusText = isPast ? "Done" : drop.skipped ? "Skipped" : { open: "Taking orders", "sold-out": "Sold out", closed: "Closed" }[statusLabel];

    card.innerHTML = `
      <h3></h3>
      <p class="admin-meta"></p>
      <p class="admin-meta"></p>
      <p class="admin-meta"></p>
      <div class="admin-stats">
        <span>${drop.loavesSold} / ${drop.totalLoaves} loaves sold</span>
        <span>${drop.ordersPaid} ${drop.ordersPaid === 1 ? "order" : "orders"}</span>
        ${drop.loavesHeld > 0 ? `<span>${drop.loavesHeld} on hold (paying now)</span>` : ""}
        <span>${drop.remaining} left</span>
      </div>
      <div class="admin-actions">
        <button type="button" class="admin-button" data-action="orders">Orders</button>
        <button type="button" class="admin-button" data-action="edit">Edit</button>
        <button type="button" class="admin-button danger" data-action="delete" ${drop.scheduled ? "hidden" : ""} ${drop.ordersPaid > 0 ? "disabled title=\"Pickup days with paid orders can't be deleted\"" : ""}>${drop.ruleKey ? "Reset to schedule" : "Delete"}</button>
      </div>
    `;

    const [name, when, address, timing] = card.querySelectorAll("h3, .admin-meta");
    name.textContent = drop.name;
    name.insertAdjacentHTML("beforeend", `<span class="badge ${statusLabel}">${statusText}</span>`);
    when.textContent = `${drop.pickupDateLabel}, ${drop.windowLabel} · ${drop.slotMinutes}-minute slots${drop.maxOrdersPerSlot ? `, max ${drop.maxOrdersPerSlot} ${drop.maxOrdersPerSlot === 1 ? "order" : "orders"} per slot` : ""}`;
    address.textContent = drop.address;
    timing.textContent = `Ordering closes ${drop.closesAtLabel}${drop.ruleKey ? " · from the weekly schedule" : " · one-off pickup"}`;

    card.querySelector('[data-action="orders"]').addEventListener("click", () => showOrders(drop));
    card.querySelector('[data-action="edit"]').addEventListener("click", () => editDrop(drop));
    card.querySelector('[data-action="delete"]').addEventListener("click", () => deleteDrop(drop));

    container.appendChild(card);

  });

}

/*
==================================================
DROP FORM
==================================================
*/

const formFields = {
  id: document.getElementById("drop-id"),
  name: document.getElementById("drop-name"),
  address: document.getElementById("drop-address"),
  pickupDate: document.getElementById("drop-date"),
  totalLoaves: document.getElementById("drop-loaves"),
  windowStart: document.getElementById("drop-start"),
  windowEnd: document.getElementById("drop-end"),
  slotMinutes: document.getElementById("drop-slot"),
  maxOrdersPerSlot: document.getElementById("drop-max-slot"),
  closesAtLocal: document.getElementById("drop-closes"),
  notes: document.getElementById("drop-notes")
};

function newDrop() {

  const last = drops[0];

  formFields.id.value = "";
  formFields.name.value = last?.name || "";
  formFields.address.value = last?.address || "";
  formFields.pickupDate.value = "";
  formFields.totalLoaves.value = last?.totalLoaves || "";
  formFields.windowStart.value = last?.windowStart || "10:00";
  formFields.windowEnd.value = last?.windowEnd || "12:00";
  formFields.slotMinutes.value = last?.slotMinutes || PICKUP.defaultSlotMinutes;
  formFields.maxOrdersPerSlot.value = last?.maxOrdersPerSlot || "";
  formFields.closesAtLocal.value = "";
  formFields.notes.value = "";

  document.getElementById("drop-form-title").textContent = "New pickup day";
  elements.ordersCard.hidden = true;
  elements.formCard.hidden = false;
  formFields.name.focus();

}

function editDrop(drop) {

  formFields.id.value = String(drop.id);
  formFields.name.value = drop.name;
  formFields.address.value = drop.address;
  formFields.pickupDate.value = drop.pickupDate;
  formFields.totalLoaves.value = drop.totalLoaves;
  formFields.windowStart.value = drop.windowStart;
  formFields.windowEnd.value = drop.windowEnd;
  formFields.slotMinutes.value = drop.slotMinutes;
  formFields.maxOrdersPerSlot.value = drop.maxOrdersPerSlot || "";
  formFields.closesAtLocal.value = drop.closesAtLocal;
  formFields.notes.value = drop.notes;

  document.getElementById("drop-form-title").textContent = `Edit: ${drop.name}`;
  elements.ordersCard.hidden = true;
  elements.formCard.hidden = false;
  elements.formCard.scrollIntoView({ behavior: "smooth" });

}

// Suggest closing orders the evening before pickup.
function suggestClosingTime() {
  if (!formFields.pickupDate.value || formFields.closesAtLocal.value) return;
  const dayBefore = new Date(`${formFields.pickupDate.value}T12:00:00`);
  dayBefore.setDate(dayBefore.getDate() - 1);
  formFields.closesAtLocal.value = `${dayBefore.toISOString().slice(0, 10)}T23:59`;
}

async function saveDrop(event) {

  event.preventDefault();

  const body = {
    id: formFields.id.value ? (/^\d+$/.test(formFields.id.value) ? Number(formFields.id.value) : formFields.id.value) : undefined,
    name: formFields.name.value,
    address: formFields.address.value,
    pickupDate: formFields.pickupDate.value,
    totalLoaves: Number(formFields.totalLoaves.value),
    windowStart: formFields.windowStart.value,
    windowEnd: formFields.windowEnd.value,
    slotMinutes: Number(formFields.slotMinutes.value),
    maxOrdersPerSlot: formFields.maxOrdersPerSlot.value ? Number(formFields.maxOrdersPerSlot.value) : null,
    closesAtLocal: formFields.closesAtLocal.value,
    notes: formFields.notes.value
  };

  const button = document.getElementById("save-drop");
  button.disabled = true;

  try {
    await request("POST", API.adminPickupDays, body);
    elements.formCard.hidden = true;
    showMessage(`Saved "${body.name}".`, true);
    await loadDrops();
  } catch (error) {
    showMessage(error.message);
  } finally {
    button.disabled = false;
  }

}

async function deleteDrop(drop) {

  if (!confirm(drop.ruleKey ? `Reset the ${drop.pickupDateLabel} pickup to the weekly schedule?` : `Delete the ${drop.pickupDateLabel} pickup at ${drop.name}?`)) return;

  try {
    await request("DELETE", `${API.adminPickupDays}?id=${drop.id}`);
    showMessage(`Deleted "${drop.name}".`, true);
    await loadDrops();
  } catch (error) {
    showMessage(error.message);
  }

}

/*
==================================================
ORDERS
==================================================
*/

let currentOrders = null;

async function showOrders(drop) {

  try {

    const data = await request("GET", `${API.adminOrders}?day=${drop.id}`);
    currentOrders = data;

    document.getElementById("orders-title").textContent = `${drop.name} — ${drop.pickupDateLabel}`;
    document.getElementById("orders-summary").textContent =
      `${data.day.totalLoaves - data.day.remaining} of ${data.day.totalLoaves} loaves spoken for · ${data.orders.filter(order => order.status === "paid").length} paid orders`;

    const totals = document.getElementById("loaf-totals");
    totals.innerHTML = "";
    Object.entries(data.loafTotals).sort().forEach(([name, quantity]) => {
      const chip = document.createElement("span");
      chip.textContent = `${quantity} × ${name}`;
      totals.appendChild(chip);
    });

    const body = document.getElementById("orders-body");
    body.innerHTML = "";

    if (data.orders.length === 0) {
      body.innerHTML = '<tr><td colspan="4">No orders yet.</td></tr>';
    }

    data.orders.forEach(order => {
      const row = document.createElement("tr");
      row.className = order.status;
      const cells = [
        order.slotLabel,
        `${order.name}\n${order.phone}${order.email ? `\n${order.email}` : ""}`,
        order.items.map(item => `${item.quantity} × ${item.name}`).join("\n"),
        order.status === "paid" ? `${formatMoney(order.amountTotal || 0)}${order.discountCode ? ` (${order.discountCode})` : ""}` : "Paying now…"
      ];
      cells.forEach(text => {
        const cell = document.createElement("td");
        cell.style.whiteSpace = "pre-line";
        cell.textContent = text;
        row.appendChild(cell);
      });
      body.appendChild(row);
    });

    elements.formCard.hidden = true;
    elements.ordersCard.hidden = false;
    elements.ordersCard.scrollIntoView({ behavior: "smooth" });

  } catch (error) {
    showMessage(error.message);
  }

}

async function copyOrders() {

  if (!currentOrders) return;

  const lines = [
    `${currentOrders.day.name} — ${currentOrders.day.pickupDateLabel}`,
    "",
    "Bake list:",
    ...Object.entries(currentOrders.loafTotals).sort().map(([name, quantity]) => `  ${quantity} × ${name}`),
    "",
    "Orders:",
    ...currentOrders.orders.filter(order => order.status === "paid").map(order =>
      `  ${order.slotLabel}  ${order.name} (${order.phone})  ${order.items.map(item => `${item.quantity} × ${item.name}`).join(", ")}`)
  ];

  const button = document.getElementById("copy-orders");

  try {
    await navigator.clipboard.writeText(lines.join("\n"));
    button.textContent = "Copied!";
  } catch {
    button.textContent = "Couldn't copy";
  }

  setTimeout(() => { button.textContent = "Copy bake list"; }, 2000);

}

/*
==================================================
INITIALIZE
==================================================
*/

document.getElementById("login-form").addEventListener("submit", logIn);
document.getElementById("logout").addEventListener("click", logOut);
document.getElementById("new-drop").addEventListener("click", newDrop);
document.getElementById("refresh").addEventListener("click", loadDrops);
document.getElementById("cancel-drop").addEventListener("click", () => { elements.formCard.hidden = true; });
document.getElementById("close-orders").addEventListener("click", () => { elements.ordersCard.hidden = true; });
document.getElementById("copy-orders").addEventListener("click", copyOrders);
formFields.pickupDate.addEventListener("change", suggestClosingTime);
elements.form.addEventListener("submit", saveDrop);

if (!API.isConfigured) {
  document.getElementById("login-error").textContent = "The worker address isn't set in macros.js yet.";
  document.getElementById("login-error").hidden = false;
} else if (password) {
  request("POST", API.adminLogin, {})
    .then(() => { elements.login.hidden = true; elements.dashboard.hidden = false; return loadDrops(); })
    .catch(() => logOut());
}
