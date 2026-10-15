/*
==================================================
KIRANA BAKEHOUSE
PICKUP ORDERING
==================================================

Pickups are "drops": each one has a date, an
address, a pickup window and a total number of
loaves. The menu, cart, tip and discount code
come from shop.js; this file adds the drop,
the loaf count and the pickup time.
==================================================
*/

import { API, PICKUP } from "./macros.js";
import { createShop } from "./shop.js";

const STORAGE_KEY = "kirana-pickup-order";
const REFRESH_SECONDS = 60;

const form = document.getElementById("order-form");
const fields = {
  name: document.getElementById("customer-name"),
  phone: document.getElementById("customer-phone"),
  slot: document.getElementById("pickup-slot")
};
const button = document.getElementById("checkout-button");

let drops = [];
let selectedDrop = null;
let savedDropId = null;
let countdownTimer;

let shop;

shop = createShop({
  storageKey: STORAGE_KEY,
  getValues: () => ({ name: fields.name.value, phone: fields.phone.value, slot: fields.slot.value, dropId: selectedDrop?.id ?? savedDropId }),
  setValues: values => {
    if (typeof values.name === "string") fields.name.value = values.name;
    if (typeof values.phone === "string") fields.phone.value = values.phone;
    if (Number.isInteger(values.dropId)) savedDropId = values.dropId;
    if (typeof values.slot === "string") fields.slot.dataset.wanted = values.slot;
  },
  onChange: updateLoafWarning
});


/*
==================================================
DROPS
==================================================
*/

async function loadDrops() {

  if (!API.isConfigured) {
    showDrops([]);
    return;
  }

  try {
    const response = await fetch(`${API.origin}${API.pickupDrops}`);
    const data = await response.json();
    showDrops(data.drops || []);
  } catch {
    document.getElementById("no-drops").hidden = false;
    document.querySelector("#no-drops .drop-when").textContent = "We couldn't load the pickup schedule. Please refresh the page to try again.";
  }

}

function showDrops(list) {

  drops = list;

  const wanted = selectedDrop?.id ?? savedDropId;
  selectedDrop =
    drops.find(drop => drop.id === wanted) ||
    drops.find(drop => drop.status === "open") ||
    drops[0] ||
    null;

  document.getElementById("no-drops").hidden = drops.length > 0;
  document.getElementById("drop-section").hidden = drops.length === 0;

  const listElement = document.getElementById("drop-list");
  listElement.hidden = drops.length < 2;
  listElement.innerHTML = "";

  drops.forEach(drop => {
    const option = document.createElement("button");
    option.type = "button";
    option.textContent = `${drop.pickupDateLabel} · ${drop.name}`;
    option.setAttribute("aria-pressed", String(drop === selectedDrop));
    option.addEventListener("click", () => {
      selectedDrop = drop;
      showDrops(drops);
      shop.saveOrder();
    });
    listElement.appendChild(option);
  });

  renderSelectedDrop();

}

function renderSelectedDrop() {

  clearInterval(countdownTimer);

  if (!selectedDrop) return;

  const drop = selectedDrop;

  document.getElementById("drop-name").textContent = drop.name;
  document.getElementById("drop-when").textContent = `${drop.pickupDateLabel}, ${drop.windowLabel}`;
  document.getElementById("drop-address").textContent = drop.address;
  document.getElementById("drop-notes").textContent = drop.notes;
  document.getElementById("drop-notes").hidden = !drop.notes;

  const status = document.getElementById("drop-status");
  status.className = `drop-status ${drop.status.replace("_", "-")}`;

  if (drop.status === "upcoming") {
    status.textContent = `Orders open ${drop.opensAtLabel}`;
    startCountdown(drop);
  } else if (drop.status === "sold_out") {
    status.textContent = "Sold out";
  } else if (drop.status === "closed") {
    status.textContent = "Ordering has closed";
  } else {
    status.textContent = drop.remaining === 1 ? "1 loaf left" : `${drop.remaining} loaves left`;
  }

  document.getElementById("pickup-note").textContent =
    `Pick up at ${drop.address} on ${drop.pickupDateLabel}. Orders close ${drop.closesAtLabel}.`;

  renderSlots(drop);
  updateLoafWarning();

}

function startCountdown(drop) {

  const status = document.getElementById("drop-status");
  const opensAt = new Date(drop.opensAt).getTime();

  const tick = () => {
    const seconds = Math.max(0, Math.round((opensAt - Date.now()) / 1000));
    if (seconds === 0) {
      clearInterval(countdownTimer);
      loadDrops();
      return;
    }
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const parts = days > 0 ? [`${days}d`, `${hours}h`, `${minutes}m`] : hours > 0 ? [`${hours}h`, `${minutes}m`] : [`${minutes}m`, `${seconds % 60}s`];
    status.textContent = `Orders open ${drop.opensAtLabel} — in ${parts.join(" ")}`;
  };

  tick();
  countdownTimer = setInterval(tick, 1000);

}

function renderSlots(drop) {

  const select = fields.slot;
  const wanted = select.value || select.dataset.wanted || "";

  select.innerHTML = '<option value="">Select a pickup time</option>';

  drop.slots.forEach(slot => {
    const option = document.createElement("option");
    option.value = slot.value;
    option.textContent = slot.available ? slot.label : `${slot.label} (full)`;
    option.disabled = !slot.available;
    select.appendChild(option);
  });

  if (drop.slots.some(slot => slot.value === wanted && slot.available)) {
    select.value = wanted;
  }

  delete select.dataset.wanted;

}

/*
  The cart can't hold more loaves than the drop
  has left (the worker checks again at checkout).
*/
function updateLoafWarning() {

  const warning = document.getElementById("loaf-warning");
  const loaves = shop ? shop.getLoafCount() : 0;

  let message = "";

  if (!selectedDrop) {
    message = "";
  } else if (selectedDrop.status === "upcoming") {
    message = `Ordering for this pickup opens ${selectedDrop.opensAtLabel}. You can browse the menu now and come back then.`;
  } else if (selectedDrop.status === "sold_out") {
    message = "This pickup has sold out. Check back for the next drop, or order delivery.";
  } else if (selectedDrop.status === "closed") {
    message = "Ordering for this pickup has closed.";
  } else if (loaves > selectedDrop.remaining) {
    message = `Only ${selectedDrop.remaining} ${selectedDrop.remaining === 1 ? "loaf is" : "loaves are"} left for this pickup — please reduce your order.`;
  }

  warning.textContent = message;
  warning.hidden = !message;
  button.disabled = Boolean(message) || !selectedDrop;

}


/*
==================================================
RETURNING CUSTOMERS
==================================================
*/

function showWelcomeBack(last) {

  const section = document.getElementById("welcome-back");
  const firstName = (last.values?.name || "").trim().split(" ")[0];
  const summary = shop.describeOrder(last.cart);

  if (typeof last.values?.name === "string") fields.name.value = last.values.name;
  if (typeof last.values?.phone === "string") fields.phone.value = last.values.phone;

  document.getElementById("welcome-back-text").textContent =
    `Welcome back${firstName ? `, ${firstName}` : ""}! Your details are filled in below.` +
    (summary ? ` Last time you ordered ${summary}.` : "");

  document.getElementById("reorder-button").hidden = !summary;

  document.getElementById("reorder-button").addEventListener("click", () => {
    shop.applySavedOrder(last, { cart: true, tip: true });
    shop.updateCart();
    shop.saveOrder();
    section.hidden = true;
    document.getElementById("checkout").scrollIntoView({ behavior: "smooth" });
  });

  document.getElementById("forget-button").addEventListener("click", () => {
    shop.forgetLastOrder();
    fields.name.value = "";
    fields.phone.value = "";
    shop.saveOrder();
    section.hidden = true;
  });

  section.hidden = false;

}


/*
==================================================
VALIDATION
==================================================
*/

function validateForm() {

  Object.values(fields).forEach(field => field.removeAttribute("aria-invalid"));

  if (!selectedDrop || selectedDrop.status !== "open") {
    return { message: "This pickup isn't taking orders right now." };
  }

  if (shop.getCartItems().length === 0) {
    return { message: "Your cart is empty. Add some sourdough above to get started.", field: document.getElementById("product-grid") };
  }

  if (shop.getLoafCount() > selectedDrop.remaining) {
    return { message: `Only ${selectedDrop.remaining} loaves are left for this pickup — please reduce your order.`, field: document.getElementById("product-grid") };
  }

  if (!fields.name.value.trim()) {
    fields.name.setAttribute("aria-invalid", "true");
    return { message: "Please enter your name.", field: fields.name };
  }

  const phoneDigits = fields.phone.value.replace(/\D/g, "");

  if (phoneDigits.length < 10 || phoneDigits.length > 15) {
    fields.phone.setAttribute("aria-invalid", "true");
    return { message: "Please enter a valid phone number, including area code.", field: fields.phone };
  }

  if (!fields.slot.value) {
    return { message: "Please select a pickup time.", field: fields.slot };
  }

  return null;

}


/*
==================================================
CHECKOUT
==================================================
*/

async function checkout(event) {

  event.preventDefault();

  shop.hideError();

  const invalid = validateForm();

  if (invalid) {
    shop.showError(invalid.message, invalid.field);
    return;
  }

  if (!API.isConfigured) {
    shop.showError("Online ordering isn't set up yet. Please email us at hellokiranabakehouse@gmail.com to place your order.");
    return;
  }

  button.disabled = true;
  button.textContent = "Holding your loaves...";

  try {

    const data = await shop.postJson(API.createPickupCheckoutSession, {
      dropId: selectedDrop.id,
      slot: fields.slot.value,
      items: shop.getCartItems(),
      customer: { name: fields.name.value, phone: fields.phone.value },
      tipCents: shop.getTipCents(),
      discountCode: shop.getDiscount()?.code
    });

    // Off to Stripe.
    window.location.href = data.url;

  } catch (error) {

    console.error("Checkout error:", error);
    shop.showError(error.message || "Something went wrong. Please try again.", error.field);
    button.textContent = "Continue to Payment";
    // Availability may have changed under us; show the latest numbers.
    await loadDrops();

  }

}


/*
==================================================
INITIALIZE
==================================================
*/

document.getElementById("hold-minutes").textContent = PICKUP.holdMinutes;

const params = new URLSearchParams(window.location.search);
const lastOrder = shop.loadLastOrder();

if (params.has("cancelled")) {
  shop.restoreOrder();
  shop.showNotice("Your payment was cancelled and you haven't been charged. Your order is saved below whenever you're ready.");
} else if (params.has("reorder")) {
  if (lastOrder) showWelcomeBack(lastOrder);
  document.getElementById("welcome-back").hidden = true;
  shop.applyReorderLink(params.get("reorder"));
} else if (sessionStorage.getItem(STORAGE_KEY)) {
  shop.restoreOrder();
} else if (lastOrder) {
  showWelcomeBack(lastOrder);
}

if (params.has("cancelled") || params.has("reorder")) {
  history.replaceState(null, "", window.location.pathname);
}

shop.updateCart();

loadDrops();

// Keep the loaf count fresh while the page is open.
setInterval(() => { if (!document.hidden) loadDrops(); }, REFRESH_SECONDS * 1000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) loadDrops(); });

Object.values(fields).forEach(field => {
  field.addEventListener("input", () => {
    field.removeAttribute("aria-invalid");
    shop.hideError();
    shop.saveOrder();
  });
});

fields.slot.addEventListener("change", () => {
  shop.hideError();
  shop.saveOrder();
});

form.addEventListener("submit", checkout);

// If the customer comes back from Stripe with the Back button, the browser
// may show this page exactly as it was left, with the button still disabled.
window.addEventListener("pageshow", event => {
  if (event.persisted) {
    button.textContent = "Continue to Payment";
    loadDrops();
  }
});
