/*
==================================================
KIRANA BAKEHOUSE
ORDERING
==================================================

One page for both delivery and pickup. The menu,
cart, tip and discount code come from shop.js;
this file adds the choice between delivery and
pickup and the details each one needs.
==================================================
*/

import { API, DELIVERY, DELIVERY_SERVICE, PICKUP } from "./macros.js?v=3";
import {
  calculateDeliveryFee,
  calculateSubtotal,
  describeDeliveryDays,
  formatMoney,
  getDeliveryDates
} from "./delivery-rules.js?v=3";
import { createShop } from "./shop.js?v=3";

const STORAGE_KEY = "kirana-order";
const ADDRESS_CHECK_DELAY_MS = 800;
const PICKUP_REFRESH_SECONDS = 60;

const form = document.getElementById("order-form");
const button = document.getElementById("checkout-button");
const fields = {
  name: document.getElementById("customer-name"),
  phone: document.getElementById("customer-phone"),
  line1: document.getElementById("address-line1"),
  line2: document.getElementById("address-line2"),
  city: document.getElementById("address-city"),
  postalCode: document.getElementById("address-zip"),
  notes: document.getElementById("delivery-notes"),
  deliveryDate: document.getElementById("delivery-date"),
  slot: document.getElementById("pickup-slot")
};
const ADDRESS_FIELDS = ["line1", "city", "postalCode"];
const SAVED_FIELDS = Object.keys(fields);

// "delivery", "pickup" or null until the customer chooses.
let mode = null;

/*
  The result of the last delivery-area check:
  { key, status: "checking" | "valid" | "invalid" | "error", zone, message }
*/
let addressCheck = null;
let addressCheckTimer;

// Pickup days from the worker, and the one the customer picked.
let pickupDays = [];
let selectedPickupDay = null;
let savedPickupDayId = null;

let shop;

shop = createShop({
  storageKey: STORAGE_KEY,
  getFee: () => mode === "delivery" ? getDeliveryFeeLine() : null,
  getValues: () => ({
    mode,
    pickupDayId: selectedPickupDay?.id ?? savedPickupDayId,
    ...Object.fromEntries(SAVED_FIELDS.map(name => [name, fields[name].value]))
  }),
  setValues: values => {
    SAVED_FIELDS.forEach(name => {
      const value = values[name];
      if (typeof value !== "string") return;
      // Dates and slots are only restored if they're still on offer.
      if (name === "deliveryDate") { selectDeliveryDate(value); return; }
      if (name === "slot") { fields.slot.dataset.wanted = value; return; }
      fields[name].value = value;
    });
    if (values.pickupDayId !== undefined && values.pickupDayId !== null) savedPickupDayId = values.pickupDayId;
    if (values.mode === "delivery" || values.mode === "pickup") selectMode(values.mode);
  },
  onChange: updateLoafWarning
});


/*
==================================================
DELIVERY OR PICKUP
==================================================
*/

function selectMode(newMode) {

  mode = newMode;

  document.querySelectorAll(".mode-option").forEach(option => {
    option.setAttribute("aria-pressed", String(option.dataset.mode === mode));
  });

  document.getElementById("contact-details").hidden = !mode;
  document.getElementById("delivery-details").hidden = mode !== "delivery";
  document.getElementById("pickup-details").hidden = mode !== "pickup";
  document.getElementById("cart-fee-line").hidden = mode !== "delivery";
  document.getElementById("delivery-notes-field").hidden = mode !== "delivery";
  document.getElementById("hold-note").hidden = mode !== "pickup";

  if (mode === "pickup" && pickupDays.length === 0) loadPickupDays();

  shop.hideError();
  shop.updateTotals();

}

function describeModes() {

  document.getElementById("delivery-mode-summary").textContent =
    `${describeDeliveryDays()}, ${DELIVERY.windowLabel}, within ${DELIVERY_SERVICE.maxMiles} miles of Menlo Park`;

  const open = pickupDays.filter(day => day.status === "open");
  const summary = document.getElementById("pickup-mode-summary");

  if (!API.isConfigured) {
    summary.textContent = "Pickup days are announced here";
  } else if (open.length === 0) {
    summary.textContent = "No pickups scheduled right now";
  } else {
    summary.textContent = `Next: ${open[0].pickupDateLabel}, ${open[0].name}`;
  }

}


/*
==================================================
DELIVERY FEE

Depends on the address (distance zone) and the
subtotal (free over a certain amount).
==================================================
*/

function getDeliveryFeeLine() {

  if (addressCheck?.status === "valid") {
    const cents = calculateDeliveryFee(addressCheck.zone, calculateSubtotal(shop.getCartItems()));
    return { cents, label: cents === 0 ? "Free" : formatMoney(cents) };
  }

  return { cents: 0, label: addressCheck?.status === "checking" ? "Checking…" : "Enter your address" };

}


/*
==================================================
DELIVERY ADDRESS CHECK
==================================================
*/

function getAddress() {
  return {
    line1: fields.line1.value.trim(),
    line2: fields.line2.value.trim(),
    city: fields.city.value.trim(),
    postalCode: fields.postalCode.value.trim()
  };
}

function addressKey({ line1, city, postalCode }) {
  return [line1, city, postalCode].join("|").toLowerCase();
}

function isAddressComplete({ line1, city, postalCode }) {
  return Boolean(line1 && city && /^\d{5}(-\d{4})?$/.test(postalCode));
}

function scheduleAddressCheck() {

  clearTimeout(addressCheckTimer);

  const address = getAddress();

  if (addressCheck && addressCheck.key !== addressKey(address)) {
    addressCheck = null;
    showAddressStatus("", "");
    shop.updateTotals();
  }

  if (isAddressComplete(address)) {
    addressCheckTimer = setTimeout(checkAddress, ADDRESS_CHECK_DELAY_MS);
  }

}

/*
  Resolves to the check result for the address
  currently in the form. Re-uses the last result
  if the address hasn't changed.
*/
async function checkAddress() {

  clearTimeout(addressCheckTimer);

  const address = getAddress();
  const key = addressKey(address);

  if (addressCheck?.key === key && addressCheck.status !== "error") {
    return addressCheck.promise;
  }

  const check = { key, status: "checking" };
  addressCheck = check;
  showAddressStatus("checking", "Checking your address…");
  shop.updateTotals();

  check.promise = (async () => {

    try {

      const data = await shop.postJson(API.checkDelivery, { address });

      if (data.deliverable) {
        check.status = "valid";
        check.zone = { feeCents: data.feeCents, freeOverCents: data.freeOverCents };
        check.message = data.freeOverCents > 0
          ? `We deliver to you! About ${data.distanceMiles} miles away — delivery is free on orders over ${formatMoney(data.freeOverCents)}.`
          : `We deliver to you! About ${data.distanceMiles} miles away — delivery is free.`;
      } else {
        check.status = "invalid";
        check.message = `Sorry, this address is about ${data.distanceMiles} miles away, outside our ${DELIVERY_SERVICE.maxMiles}-mile delivery area.`;
      }

    } catch (error) {

      check.status = "error";
      check.message = error.message;

    }

    // Ignore the result if the address was edited while we were checking.
    if (addressCheck === check) {
      showAddressStatus(check.status, check.message);
      shop.updateTotals();
    }

    return check;

  })();

  return check.promise;

}

function showAddressStatus(status, message) {
  const element = document.getElementById("address-status");
  element.className = `address-status ${status}`;
  element.textContent = message;
}


/*
==================================================
DELIVERY DATES
==================================================
*/

function renderDeliveryDates() {

  const pills = document.getElementById("delivery-dates");

  getDeliveryDates().forEach(({ value, label }) => {
    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "pill";
    pill.dataset.value = value;
    pill.textContent = label;
    pill.setAttribute("aria-pressed", "false");
    pill.addEventListener("click", () => {
      selectDeliveryDate(value);
      shop.hideError();
      shop.saveOrder();
    });
    pills.appendChild(pill);
  });

  document.querySelectorAll(".delivery-days").forEach(element => {
    element.textContent = describeDeliveryDays();
  });

  document.querySelectorAll(".delivery-window").forEach(element => {
    element.textContent = DELIVERY.windowLabel;
  });

  document.getElementById("delivery-radius").textContent = DELIVERY_SERVICE.maxMiles;

}

function selectDeliveryDate(value) {
  const pills = [...document.querySelectorAll("#delivery-dates .pill")];
  if (!pills.some(pill => pill.dataset.value === value)) value = "";
  fields.deliveryDate.value = value;
  pills.forEach(pill => pill.setAttribute("aria-pressed", String(pill.dataset.value === value)));
}


/*
==================================================
PICKUP DAYS
==================================================
*/

async function loadPickupDays() {

  if (!API.isConfigured) {
    showPickupDays([]);
    return;
  }

  try {
    const response = await fetch(`${API.origin}${API.pickupDays}`);
    const data = await response.json();
    showPickupDays(data.days || []);
  } catch {
    showPickupDays([]);
    document.getElementById("no-pickup-days").textContent = "We couldn't load the pickup schedule. Please refresh the page to try again.";
  }

}

function showPickupDays(days) {

  pickupDays = days;

  const wanted = selectedPickupDay?.id ?? savedPickupDayId;
  selectedPickupDay =
    days.find(day => day.id === wanted && day.status === "open") ||
    (days.length === 1 && days[0].status === "open" ? days[0] : null);

  const list = document.getElementById("pickup-days");
  list.innerHTML = "";
  document.getElementById("no-pickup-days").hidden = days.length > 0;

  days.forEach(day => {

    const card = document.createElement("button");
    card.type = "button";
    card.className = "pickup-day";
    card.disabled = day.status !== "open";
    card.setAttribute("aria-pressed", String(day === selectedPickupDay));

    const title = document.createElement("strong");
    title.textContent = `${day.pickupDateLabel}, ${day.windowLabel}`;

    const where = document.createElement("span");
    where.className = "pickup-day-meta";
    where.textContent = `${day.name} · ${day.address}`;

    card.append(title, where);

    if (day.notes) {
      const notes = document.createElement("span");
      notes.className = "pickup-day-meta";
      notes.textContent = day.notes;
      card.appendChild(notes);
    }

    const status = document.createElement("span");
    status.className = "pickup-day-status";
    status.textContent = day.status === "sold_out" ? "Sold out" : day.status === "closed" ? "Ordering closed" : day.remaining === 1 ? "1 loaf left" : `${day.remaining} loaves left`;
    status.title = `Order by ${day.closesAtLabel}`;
    card.appendChild(status);

    card.addEventListener("click", () => {
      selectedPickupDay = day;
      showPickupDays(pickupDays);
      shop.hideError();
      shop.saveOrder();
    });

    list.appendChild(card);

  });

  document.getElementById("pickup-slot-field").hidden = !selectedPickupDay;
  if (selectedPickupDay) renderSlots(selectedPickupDay);

  describeModes();
  updateLoafWarning();

}

function renderSlots(day) {

  const pills = document.getElementById("pickup-slots");
  const wanted = fields.slot.value || fields.slot.dataset.wanted || "";

  pills.innerHTML = "";
  fields.slot.value = day.slots.some(slot => slot.value === wanted && slot.available) ? wanted : "";
  delete fields.slot.dataset.wanted;

  day.slots.forEach(slot => {
    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "pill";
    pill.textContent = slot.label;
    pill.disabled = !slot.available;
    pill.title = slot.available ? "" : "This time is full";
    pill.setAttribute("aria-pressed", String(slot.value === fields.slot.value));
    pill.addEventListener("click", () => {
      fields.slot.value = slot.value;
      pills.querySelectorAll(".pill").forEach(other => other.setAttribute("aria-pressed", String(other === pill)));
      shop.hideError();
      shop.saveOrder();
    });
    pills.appendChild(pill);
  });

}

/*
  The cart can't hold more loaves than the pickup
  day has left (the worker checks again at checkout).
*/
function updateLoafWarning() {

  const warning = document.getElementById("loaf-warning");
  const loaves = shop ? shop.getLoafCount() : 0;

  let message = "";

  if (mode === "pickup" && selectedPickupDay && loaves > selectedPickupDay.remaining) {
    message = `Only ${selectedPickupDay.remaining} ${selectedPickupDay.remaining === 1 ? "loaf is" : "loaves are"} left for this pickup — please reduce your order.`;
  }

  warning.textContent = message;
  warning.hidden = !message;

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

  // Details are filled in straight away; the loaves wait for a click.
  shop.applySavedOrder(last, { details: true });

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
    SAVED_FIELDS.forEach(name => { fields[name].value = ""; });
    addressCheck = null;
    showAddressStatus("", "");
    shop.updateTotals();
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

  if (shop.getCartItems().length === 0) {
    return { message: "Your cart is empty. Add some sourdough above to get started.", field: document.getElementById("product-grid") };
  }

  if (!mode) {
    return { message: "Please choose delivery or pickup.", field: document.querySelector(".mode-option") };
  }

  const required = [];

  if (mode === "delivery") {
    required.push(
      ["line1", "Please enter your street address."],
      ["city", "Please enter your city."],
      ["postalCode", "Please enter a valid 5-digit ZIP code."]
    );
  }

  required.push(
    ["name", "Please enter your name."],
    ["phone", `Please enter your phone number so we can reach you on ${mode} day.`]
  );

  for (const [name, message] of required) {
    if (!fields[name].value.trim() || !fields[name].checkValidity()) {
      fields[name].setAttribute("aria-invalid", "true");
      return { message, field: fields[name] };
    }
  }

  const phoneDigits = fields.phone.value.replace(/\D/g, "");

  if (phoneDigits.length < 10 || phoneDigits.length > 15) {
    fields.phone.setAttribute("aria-invalid", "true");
    return { message: "Please enter a valid phone number, including area code.", field: fields.phone };
  }

  if (mode === "delivery" && !fields.deliveryDate.value) {
    return { message: "Please choose a delivery date.", field: document.getElementById("delivery-dates") };
  }

  if (mode === "pickup") {
    if (!selectedPickupDay) {
      return { message: "Please choose a pickup day.", field: document.getElementById("pickup-days") };
    }
    if (shop.getLoafCount() > selectedPickupDay.remaining) {
      return { message: `Only ${selectedPickupDay.remaining} loaves are left for this pickup — please reduce your order.`, field: document.getElementById("product-grid") };
    }
    if (!fields.slot.value) {
      return { message: "Please choose a pickup time.", field: document.getElementById("pickup-slots") };
    }
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
  button.textContent = mode === "pickup" ? "Holding your loaves..." : "Preparing secure checkout...";

  try {

    const common = {
      items: shop.getCartItems(),
      customer: { name: fields.name.value, phone: fields.phone.value },
      tipCents: shop.getTipCents(),
      discountCode: shop.getDiscount()?.code
    };

    let data;

    if (mode === "delivery") {

      const check = await checkAddress();

      if (check.status !== "valid") {
        throw Object.assign(new Error(check.message), { field: fields.line1 });
      }

      data = await shop.postJson(API.createCheckoutSession, {
        ...common,
        deliveryDate: fields.deliveryDate.value,
        address: getAddress(),
        notes: fields.notes.value
      });

    } else {

      data = await shop.postJson(API.createPickupCheckoutSession, {
        ...common,
        pickupDayId: selectedPickupDay.id,
        slot: fields.slot.value
      });

    }

    // Off to Stripe.
    window.location.href = data.url;

  } catch (error) {

    console.error("Checkout error:", error);
    shop.showError(error.message || "Something went wrong. Please try again.", error.field);
    resetCheckoutButton();
    // Pickup availability may have changed under us; show the latest numbers.
    if (mode === "pickup") await loadPickupDays();

  }

}

function resetCheckoutButton() {
  button.disabled = false;
  button.textContent = "Continue to Payment";
}


/*
==================================================
INITIALIZE
==================================================
*/

renderDeliveryDates();
describeModes();
document.getElementById("hold-minutes").textContent = PICKUP.holdMinutes;

const params = new URLSearchParams(window.location.search);
const lastOrder = shop.loadLastOrder();

if (params.has("cancelled")) {
  shop.restoreOrder();
  shop.showNotice("Your payment was cancelled and you haven't been charged. Your order is saved below whenever you're ready.");
} else if (params.has("reorder")) {
  if (lastOrder) shop.applySavedOrder(lastOrder, { details: true });
  shop.applyReorderLink(params.get("reorder"));
} else if (sessionStorage.getItem(STORAGE_KEY)) {
  shop.restoreOrder();
} else if (lastOrder) {
  showWelcomeBack(lastOrder);
}

// Links like order.html?mode=pickup pre-select delivery or pickup.
if (["delivery", "pickup"].includes(params.get("mode"))) {
  selectMode(params.get("mode"));
}

if (params.has("cancelled") || params.has("reorder") || params.has("mode")) {
  history.replaceState(null, "", window.location.pathname);
}

shop.updateCart();
loadPickupDays();

if (isAddressComplete(getAddress())) {
  checkAddress();
}

// Keep the pickup loaf counts fresh while the page is open.
setInterval(() => { if (!document.hidden && mode === "pickup") loadPickupDays(); }, PICKUP_REFRESH_SECONDS * 1000);
document.addEventListener("visibilitychange", () => { if (!document.hidden && mode === "pickup") loadPickupDays(); });

document.querySelectorAll(".mode-option").forEach(option => {
  option.addEventListener("click", () => {
    selectMode(option.dataset.mode);
    shop.saveOrder();
  });
});

ADDRESS_FIELDS.forEach(name => {
  fields[name].addEventListener("input", scheduleAddressCheck);
  fields[name].addEventListener("change", () => isAddressComplete(getAddress()) && checkAddress());
});

Object.values(fields).forEach(field => {
  field.addEventListener("input", () => {
    field.removeAttribute("aria-invalid");
    shop.hideError();
    shop.saveOrder();
  });
});

form.addEventListener("submit", checkout);

// If the customer comes back from Stripe with the Back button, the browser
// may show this page exactly as it was left, with the button still disabled.
window.addEventListener("pageshow", event => {
  if (event.persisted) {
    resetCheckoutButton();
    loadPickupDays();
  }
});
