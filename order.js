/*
==================================================
KIRANA BAKEHOUSE
DELIVERY ORDERING
==================================================

The customer checks their address here, picks a
delivery date, and is sent to the Stripe Payment
Link for their delivery zone. Loaves, quantities,
tip, contact details and payment are all handled
on Stripe's page.
==================================================
*/

import { DELIVERY_SERVICE, PRODUCTS } from "./macros.js";
import {
  describeDeliveryDays,
  describeDeliveryFee,
  formatMoney,
  getDeliveryDates
} from "./delivery-rules.js";
import { checkDeliveryArea } from "./delivery-area.js";

const STORAGE_KEY = "kirana-delivery-order";
const ADDRESS_CHECK_DELAY_MS = 1200;
const MIN_ADDRESS_LENGTH = 8;

const form = document.getElementById("order-form");
const addressField = document.getElementById("delivery-address");
const dateField = document.getElementById("delivery-date");
const button = document.getElementById("checkout-button");

/*
  The result of the last delivery-area check:
  { key, status: "checking" | "valid" | "invalid" | "error", zone, distanceMiles, message }
*/
let addressCheck = null;
let addressCheckTimer;


/*
==================================================
MENU
==================================================
*/

function renderProducts() {

  const grid =
    document.getElementById("product-grid");

  grid.innerHTML = "";

  Object.values(PRODUCTS).forEach(product => {

    const card =
      document.createElement("article");

    card.className =
      "product-card";

    card.innerHTML = `

      <img
        src="${product.image}"
        alt="${product.name}"
        class="product-image"
        loading="lazy"
      />

      <div class="product-info">

        <h2 class="product-name">
          ${product.name}
        </h2>

        <p class="product-description">
          ${product.description}
        </p>

        <div class="product-price">
          ${formatMoney(product.price)}
        </div>

      </div>

    `;

    grid.appendChild(card);

  });

}


/*
==================================================
DELIVERY ADDRESS CHECK
==================================================
*/

function getAddress() {
  return addressField.value.trim().replace(/\s+/g, " ");
}

function isAddressComplete(address) {
  return address.length >= MIN_ADDRESS_LENGTH && /\d/.test(address);
}

function scheduleAddressCheck() {

  clearTimeout(addressCheckTimer);

  const address = getAddress();

  if (addressCheck && addressCheck.key !== address.toLowerCase()) {
    addressCheck = null;
    showAddressStatus("", "");
  }

  if (isAddressComplete(address)) {
    addressCheckTimer = setTimeout(checkAddress, ADDRESS_CHECK_DELAY_MS);
  }

}

/*
  Resolves to the check result for the address
  currently in the box. Re-uses the last result
  if the address hasn't changed.
*/
async function checkAddress() {

  clearTimeout(addressCheckTimer);

  const address = getAddress();
  const key = address.toLowerCase();

  if (addressCheck?.key === key && addressCheck.status !== "error") {
    return addressCheck.promise;
  }

  const check = { key, status: "checking" };
  addressCheck = check;
  showAddressStatus("checking", "Checking your address…");

  check.promise = (async () => {

    try {

      const { distanceMiles, zone } =
        await checkDeliveryArea(address);

      check.distanceMiles = distanceMiles;

      if (zone) {
        check.status = "valid";
        check.zone = zone;
        check.message = `We deliver to you! About ${distanceMiles} miles away. ${describeDeliveryFee(zone)}`;
      } else {
        check.status = "invalid";
        check.message = `Sorry, this address is about ${distanceMiles} miles away, outside our ${DELIVERY_SERVICE.maxMiles}-mile delivery area.`;
      }

    } catch (error) {

      check.status = "error";
      check.message = error.message;

    }

    // Ignore the result if the address was edited while we were checking.
    if (addressCheck === check) {
      showAddressStatus(check.status, check.message);
    }

    return check;

  })();

  return check.promise;

}

function showAddressStatus(status, message) {

  const element =
    document.getElementById("address-status");

  element.className =
    `address-status ${status}`;

  element.textContent =
    message;

}


/*
==================================================
DELIVERY DATES AND FEES
==================================================
*/

function renderDeliveryInfo() {

  getDeliveryDates().forEach(({ value, label }) => {

    const option =
      document.createElement("option");

    option.value =
      value;

    option.textContent =
      label;

    dateField.appendChild(option);

  });

  document.querySelectorAll(".delivery-days").forEach(element => {
    element.textContent = describeDeliveryDays();
  });

  document.getElementById("delivery-radius").textContent =
    DELIVERY_SERVICE.maxMiles;

  // e.g. "Free under 1 mile, $3.00 up to 2 miles, …"
  const fees = DELIVERY_SERVICE.zones.map(({ maxMiles, feeCents }, index) => {
    const fee = feeCents === 0 ? "Free" : formatMoney(feeCents);
    const miles = `${maxMiles} mile${maxMiles === 1 ? "" : "s"}`;
    return index === 0 ? `${fee} under ${miles}` : `${fee} up to ${miles}`;
  });

  document.getElementById("delivery-fees").textContent =
    `Delivery: ${fees.join(", ")}.`;

}


/*
==================================================
REMEMBER THE ADDRESS AND DATE

So they are still filled in if the customer
comes back from Stripe or refreshes the page.
==================================================
*/

function saveOrder() {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ address: addressField.value, deliveryDate: dateField.value }));
  } catch {
    // Storage can be unavailable (e.g. private browsing). Nothing to do.
  }
}

function restoreOrder() {

  let saved;

  try {
    saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY));
  } catch {
    return;
  }

  if (!saved) return;

  if (typeof saved.address === "string") {
    addressField.value = saved.address;
  }

  // Only restore a delivery date that is still available.
  if ([...dateField.options].some(option => option.value === saved.deliveryDate)) {
    dateField.value = saved.deliveryDate;
  }

}


/*
==================================================
MESSAGES
==================================================
*/

function showError(message, focusElement) {

  const element =
    document.getElementById("checkout-error");

  element.textContent =
    message;

  element.style.display =
    "block";

  if (focusElement) {
    focusElement.focus();
    focusElement.scrollIntoView({ behavior: "smooth", block: "center" });
  }

}

function hideError() {
  document.getElementById("checkout-error").style.display = "none";
}


/*
==================================================
GO TO STRIPE
==================================================
*/

async function checkout(event) {

  event.preventDefault();

  hideError();

  if (!isAddressComplete(getAddress())) {
    showError("Please enter your full delivery address, including the street number.", addressField);
    return;
  }

  if (!dateField.value) {
    showError("Please select a delivery date.", dateField);
    return;
  }

  button.disabled =
    true;

  button.textContent =
    "Checking your address…";

  try {

    const check =
      await checkAddress();

    if (check.status !== "valid") {
      throw Object.assign(new Error(check.message), { field: addressField });
    }

    if (!check.zone.paymentLinkUrl) {
      throw new Error("Online ordering isn't set up yet. Please email us at hellokiranabakehouse@gmail.com to place your order.");
    }

    /*
      The zone, distance and delivery date are
      attached to the Stripe payment so the order
      can be checked against the address the
      customer gives Stripe. Stripe only allows
      letters, numbers, dashes and underscores.
    */

    const reference = [
      `ZONE${DELIVERY_SERVICE.zones.indexOf(check.zone) + 1}`,
      `${String(check.distanceMiles).replace(".", "")}MI`,
      dateField.value.replaceAll("-", "")
    ].join("-");

    const paymentUrl =
      new URL(check.zone.paymentLinkUrl);

    paymentUrl.searchParams.set("client_reference_id", reference);

    button.textContent =
      "Opening secure ordering…";

    window.location.href =
      paymentUrl.toString();

  }

  catch (error) {

    console.error(
      "Checkout error:",
      error
    );

    showError(
      error.message || "Something went wrong. Please try again.",
      error.field
    );

    resetCheckoutButton();

  }

}

function resetCheckoutButton() {

  button.disabled =
    false;

  button.textContent =
    "Choose Your Loaves & Pay";

}


/*
==================================================
INITIALIZE
==================================================
*/

renderProducts();

renderDeliveryInfo();

restoreOrder();

if (isAddressComplete(getAddress())) {
  checkAddress();
}

addressField.addEventListener("input", () => {
  hideError();
  saveOrder();
  scheduleAddressCheck();
});

addressField.addEventListener("change", () => {
  if (isAddressComplete(getAddress())) checkAddress();
});

dateField.addEventListener("change", () => {
  hideError();
  saveOrder();
});

form.addEventListener(
  "submit",
  checkout
);

// If the customer comes back from Stripe with the Back button, the browser
// may show this page exactly as it was left, with the button still disabled.
window.addEventListener("pageshow", event => {
  if (event.persisted) resetCheckoutButton();
});
