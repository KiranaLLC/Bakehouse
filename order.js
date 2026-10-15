/*
==================================================
KIRANA BAKEHOUSE
DELIVERY ORDERING
==================================================

The menu, cart, tip and discount code come from
shop.js. This file adds what's specific to
delivery: the address check, delivery fee,
delivery details and delivery dates.
==================================================
*/

import { API, DELIVERY, DELIVERY_SERVICE } from "./macros.js";
import {
  calculateDeliveryFee,
  calculateSubtotal,
  describeDeliveryDays,
  formatMoney,
  getDeliveryDates
} from "./delivery-rules.js";
import { createShop } from "./shop.js";

const STORAGE_KEY = "kirana-delivery-order";
const ADDRESS_CHECK_DELAY_MS = 800;

const form = document.getElementById("order-form");
const fields = {
  name: document.getElementById("customer-name"),
  phone: document.getElementById("customer-phone"),
  line1: document.getElementById("address-line1"),
  line2: document.getElementById("address-line2"),
  city: document.getElementById("address-city"),
  postalCode: document.getElementById("address-zip"),
  notes: document.getElementById("delivery-notes"),
  deliveryDate: document.getElementById("delivery-date")
};
const ADDRESS_FIELDS = ["line1", "city", "postalCode"];
const SAVED_FIELDS = Object.keys(fields);

/*
  The result of the last delivery-area check:
  { key, status: "checking" | "valid" | "invalid" | "error", zone, message }
*/
let addressCheck = null;
let addressCheckTimer;

const shop = createShop({
  storageKey: STORAGE_KEY,
  getFee: getDeliveryFeeLine,
  getValues: () => Object.fromEntries(SAVED_FIELDS.map(name => [name, fields[name].value])),
  setValues: values => {
    SAVED_FIELDS.forEach(name => {
      const value = values[name];
      if (typeof value !== "string") return;
      // Only restore a delivery date that is still available.
      if (name === "deliveryDate" && ![...fields.deliveryDate.options].some(option => option.value === value)) return;
      fields[name].value = value;
    });
  }
});


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

  getDeliveryDates().forEach(({ value, label }) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    fields.deliveryDate.appendChild(option);
  });

  document.querySelectorAll(".delivery-days").forEach(element => {
    element.textContent = describeDeliveryDays();
  });

  document.querySelectorAll(".delivery-window").forEach(element => {
    element.textContent = DELIVERY.windowLabel;
  });

  document.getElementById("delivery-radius").textContent = DELIVERY_SERVICE.maxMiles;

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
    `Welcome back${firstName ? `, ${firstName}` : ""}! Your delivery details are filled in below.` +
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

  const required = [
    ["name", "Please enter your name."],
    ["phone", "Please enter your phone number so we can reach you on delivery day."],
    ["line1", "Please enter your street address."],
    ["city", "Please enter your city."],
    ["postalCode", "Please enter a valid 5-digit ZIP code."]
  ];

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

  if (!fields.deliveryDate.value) {
    return { message: "Please select a delivery date.", field: fields.deliveryDate };
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

  const button = document.getElementById("checkout-button");

  button.disabled = true;
  button.textContent = "Preparing secure checkout...";

  try {

    const check = await checkAddress();

    if (check.status !== "valid") {
      throw Object.assign(new Error(check.message), { field: fields.line1 });
    }

    const data = await shop.postJson(API.createCheckoutSession, {
      items: shop.getCartItems(),
      deliveryDate: fields.deliveryDate.value,
      customer: { name: fields.name.value, phone: fields.phone.value },
      address: getAddress(),
      notes: fields.notes.value,
      tipCents: shop.getTipCents(),
      discountCode: shop.getDiscount()?.code
    });

    // Off to Stripe.
    window.location.href = data.url;

  } catch (error) {

    console.error("Checkout error:", error);
    shop.showError(error.message || "Something went wrong. Please try again.", error.field);
    button.disabled = false;
    button.textContent = "Continue to Payment";

  }

}


/*
==================================================
INITIALIZE
==================================================
*/

renderDeliveryDates();

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

if (params.has("cancelled") || params.has("reorder")) {
  history.replaceState(null, "", window.location.pathname);
}

shop.updateCart();

if (isAddressComplete(getAddress())) {
  checkAddress();
}

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

fields.deliveryDate.addEventListener("change", () => {
  shop.hideError();
  shop.saveOrder();
});

form.addEventListener("submit", checkout);
