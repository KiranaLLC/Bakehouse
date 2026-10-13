/*
==================================================
KIRANA BAKEHOUSE
DELIVERY ORDERING SYSTEM
==================================================
*/

import { API, BASE_INGREDIENTS, DELIVERY, DELIVERY_SERVICE, PRODUCTS, TIP } from "./macros.js";
import {
  calculateDeliveryFee,
  calculateSubtotal,
  describeDeliveryDays,
  formatMoney,
  getDeliveryDates
} from "./delivery-rules.js";

const STORAGE_KEY = "kirana-delivery-order";
const LAST_ORDER_KEY = "kirana-last-order";
const REMEMBER_DAYS = 90;
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


/*
==================================================
STATE
==================================================
*/

const cart = {};

Object.keys(PRODUCTS).forEach(productId => {
  cart[productId] = 0;
});

/*
  The result of the last delivery-area check:
  { key, status: "checking" | "valid" | "invalid" | "error", zone, message }
*/
let addressCheck = null;
let addressCheckTimer;

/*
  The tip: a percentage of the subtotal, or a
  custom amount in cents when the customer picks
  "Other".
*/
const tip = { percent: 0, customCents: null };


/*
==================================================
RENDER PRODUCTS
==================================================
*/

function renderProducts() {

  const grid =
    document.getElementById("product-grid");

  grid.innerHTML = "";

  Object.entries(PRODUCTS).forEach(
    ([id, product]) => {

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

          <button
            type="button"
            class="ingredients-toggle"
            data-action="ingredients"
            data-product="${id}"
            aria-expanded="false"
            aria-controls="ingredients-${id}"
          >
            Ingredients
          </button>

          <p
            id="ingredients-${id}"
            class="ingredients"
          >
            ${[...BASE_INGREDIENTS, ...(product.ingredients || [])].join(", ")}
          </p>

          <div class="product-price">
            ${formatMoney(product.price)}
          </div>

          <div class="quantity-row">

            <button
              type="button"
              data-action="minus"
              data-product="${id}"
              aria-label="Remove one ${product.name}"
            >
              −
            </button>

            <span
              id="quantity-${id}"
              class="quantity"
              aria-live="polite"
            >
              0
            </span>

            <button
              type="button"
              data-action="plus"
              data-product="${id}"
              aria-label="Add one ${product.name}"
            >
              +
            </button>

          </div>

        </div>

      `;

      grid.appendChild(card);

    }
  );

  grid.addEventListener(
    "click",
    handleProductClick
  );

}


/*
==================================================
PRODUCT BUTTONS
==================================================
*/

function handleProductClick(event) {

  const button =
    event.target.closest("button");

  if (!button) return;

  const productId =
    button.dataset.product;

  const product =
    PRODUCTS[productId];

  if (!product) return;

  if (button.dataset.action === "ingredients") {
    const open = button.getAttribute("aria-expanded") !== "true";
    button.setAttribute("aria-expanded", String(open));
    document.getElementById(`ingredients-${productId}`).classList.toggle("open", open);
    return;
  }

  if (button.dataset.action === "plus" && cart[productId] < product.maxQuantity) {
    cart[productId]++;
  }

  if (button.dataset.action === "minus" && cart[productId] > 0) {
    cart[productId]--;
  }

  hideError();
  updateCart();
  saveOrder();

}


/*
==================================================
UPDATE CART
==================================================
*/

function getCartItems() {
  return Object.entries(cart)
    .filter(([, quantity]) => quantity > 0)
    .map(([productId, quantity]) => ({ productId, quantity }));
}

function updateCart() {

  const cartElement =
    document.getElementById("cart-items");

  const items =
    getCartItems();

  cartElement.innerHTML = "";

  items.forEach(({ productId, quantity }) => {

    const product =
      PRODUCTS[productId];

    const item =
      document.createElement("div");

    item.className =
      "cart-item";

    item.innerHTML = `

      <span>
        ${product.name} × ${quantity}
      </span>

      <span>
        ${formatMoney(product.price * quantity)}
      </span>

    `;

    cartElement.appendChild(item);

  });

  if (items.length === 0) {

    cartElement.innerHTML = `

      <p class="empty-cart">
        Your cart is empty.
      </p>

    `;

  }

  Object.entries(PRODUCTS).forEach(([productId, product]) => {
    const quantityElement = document.getElementById(`quantity-${productId}`);
    if (!quantityElement) return;

    quantityElement.textContent = cart[productId];

    const row = quantityElement.parentElement;
    row.querySelector('[data-action="minus"]').disabled = cart[productId] === 0;
    row.querySelector('[data-action="plus"]').disabled = cart[productId] >= product.maxQuantity;
  });

  updateTotals();

}


/*
==================================================
TOTALS
==================================================

The delivery fee depends on the address
(distance zone) and the subtotal (free over
a certain amount). The server recalculates
both before creating the Stripe checkout.
==================================================
*/

function updateTotals() {

  const subtotal =
    calculateSubtotal(getCartItems());

  const feeElement =
    document.getElementById("cart-delivery-fee");

  let deliveryFee = 0;

  if (addressCheck?.status === "valid") {

    deliveryFee =
      calculateDeliveryFee(addressCheck.zone, subtotal);

    feeElement.textContent =
      deliveryFee === 0 ? "Free" : formatMoney(deliveryFee);

  } else {

    feeElement.textContent =
      addressCheck?.status === "checking" ? "Checking…" : "Enter your address";

  }

  const tipCents =
    getTipCents(subtotal);

  document.getElementById("cart-subtotal").textContent =
    formatMoney(subtotal);

  document.getElementById("cart-tip").textContent =
    formatMoney(tipCents);

  document.getElementById("cart-total").textContent =
    formatMoney(subtotal + deliveryFee + tipCents);

}


/*
==================================================
TIP
==================================================
*/

function getTipCents(subtotal) {
  if (tip.customCents !== null) return tip.customCents;
  return Math.round(subtotal * tip.percent / 100);
}

function renderTipOptions() {

  const options =
    document.getElementById("tip-options");

  const labels = [
    ...TIP.presetPercents.map(percent => [String(percent), percent === 0 ? "No tip" : `${percent}%`]),
    ["custom", "Other"]
  ];

  labels.forEach(([value, label]) => {
    const option = document.createElement("button");
    option.type = "button";
    option.className = "tip-option";
    option.dataset.tip = value;
    option.textContent = label;
    options.appendChild(option);
  });

  options.addEventListener("click", event => {
    const option = event.target.closest(".tip-option");
    if (!option) return;
    selectTip(option.dataset.tip);
    if (option.dataset.tip === "custom") document.getElementById("tip-amount").focus();
    saveOrder();
  });

  document.getElementById("tip-amount").addEventListener("input", event => {
    const dollars = Number(event.target.value);
    tip.customCents = Number.isFinite(dollars) && dollars > 0 ? Math.min(Math.round(dollars * 100), TIP.maxCents) : 0;
    updateTotals();
    saveOrder();
  });

}

function selectTip(value) {

  if (value === "custom") {
    tip.customCents = tip.customCents ?? 0;
  } else {
    tip.percent = Number(value);
    tip.customCents = null;
  }

  document.querySelectorAll(".tip-option").forEach(option => {
    option.setAttribute("aria-pressed", String(option.dataset.tip === value));
  });

  document.getElementById("tip-custom").hidden =
    value !== "custom";

  updateTotals();

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
    updateTotals();
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
  updateTotals();

  check.promise = (async () => {

    try {

      const data =
        await postJson(API.checkDelivery, { address });

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
      updateTotals();
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
DELIVERY DATES
==================================================
*/

function renderDeliveryDates() {

  const select =
    fields.deliveryDate;

  getDeliveryDates().forEach(({ value, label }) => {

    const option =
      document.createElement("option");

    option.value =
      value;

    option.textContent =
      label;

    select.appendChild(option);

  });

  document.querySelectorAll(".delivery-days").forEach(element => {
    element.textContent = describeDeliveryDays();
  });

  document.querySelectorAll(".delivery-window").forEach(element => {
    element.textContent = DELIVERY.windowLabel;
  });

  document.getElementById("delivery-radius").textContent =
    DELIVERY_SERVICE.maxMiles;

}


/*
==================================================
SAVE ORDER IN PROGRESS

Keeps the cart and form filled in if the
customer goes back from Stripe Checkout or
refreshes the page.
==================================================
*/

const SAVED_FIELDS = ["name", "phone", "line1", "line2", "city", "postalCode", "notes", "deliveryDate"];

function saveOrder() {
  try {
    const values = Object.fromEntries(SAVED_FIELDS.map(name => [name, fields[name].value]));
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ cart, values, tip }));
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

  if (saved) applySavedOrder(saved, { cart: true, tip: true, details: true });

}

/*
  Fills the page from a saved order:
  { cart: { productId: quantity }, tip, values: { name, phone, … } }
*/
function applySavedOrder(saved, parts) {

  if (parts.cart) {
    Object.entries(saved.cart || {}).forEach(([productId, quantity]) => {
      if (Object.hasOwn(cart, productId) && Number.isInteger(quantity)) {
        cart[productId] = Math.min(Math.max(quantity, 0), PRODUCTS[productId].maxQuantity);
      }
    });
  }

  if (parts.tip) {
    if (Number.isInteger(saved.tip?.customCents) && saved.tip.customCents >= 0) {
      tip.customCents = Math.min(saved.tip.customCents, TIP.maxCents);
      document.getElementById("tip-amount").value = (tip.customCents / 100).toFixed(2);
      selectTip("custom");
    } else if (TIP.presetPercents.includes(saved.tip?.percent)) {
      selectTip(String(saved.tip.percent));
    }
  }

  if (parts.details) {
    SAVED_FIELDS.forEach(name => {
      const value = saved.values?.[name];
      if (typeof value !== "string") return;
      // Only restore a delivery date that is still available.
      if (name === "deliveryDate" && ![...fields.deliveryDate.options].some(option => option.value === value)) return;
      fields[name].value = value;
    });
  }

}


/*
==================================================
RETURNING CUSTOMERS

The thank-you page saves each completed order in
the browser for REMEMBER_DAYS days. On the next
visit the details are filled in and the last
order can be put in the cart with one click.
==================================================
*/

function loadLastOrder() {

  let last;

  try {
    last = JSON.parse(localStorage.getItem(LAST_ORDER_KEY));
  } catch {
    return null;
  }

  const ageDays = (Date.now() - Number(last?.savedAt)) / (24 * 60 * 60 * 1000);

  if (!last || !(ageDays >= 0 && ageDays <= REMEMBER_DAYS)) {
    forgetLastOrder();
    return null;
  }

  return last;

}

function forgetLastOrder() {
  try {
    localStorage.removeItem(LAST_ORDER_KEY);
  } catch {
    // Ignore.
  }
}

function describeOrder(savedCart) {
  return Object.entries(savedCart || {})
    .filter(([productId, quantity]) => Object.hasOwn(PRODUCTS, productId) && quantity > 0)
    .map(([productId, quantity]) => `${quantity} × ${PRODUCTS[productId].name}`)
    .join(", ");
}

function showWelcomeBack(last) {

  const section = document.getElementById("welcome-back");
  const firstName = (last.values?.name || "").trim().split(" ")[0];
  const summary = describeOrder(last.cart);

  // Details are filled in straight away; the loaves wait for a click.
  applySavedOrder(last, { details: true });

  document.getElementById("welcome-back-text").textContent =
    `Welcome back${firstName ? `, ${firstName}` : ""}! Your delivery details are filled in below.` +
    (summary ? ` Last time you ordered ${summary}.` : "");

  document.getElementById("reorder-button").hidden = !summary;

  document.getElementById("reorder-button").addEventListener("click", () => {
    applySavedOrder(last, { cart: true, tip: true });
    updateCart();
    saveOrder();
    section.hidden = true;
    document.getElementById("checkout").scrollIntoView({ behavior: "smooth" });
  });

  document.getElementById("forget-button").addEventListener("click", () => {
    forgetLastOrder();
    SAVED_FIELDS.forEach(name => { fields[name].value = ""; });
    addressCheck = null;
    showAddressStatus("", "");
    updateTotals();
    saveOrder();
    section.hidden = true;
  });

  section.hidden = false;

}

/*
  A reorder link looks like
  order.html?reorder=house_white:2,margherita:1
  and fills the cart with those loaves.
*/
function applyReorderLink(value) {

  const savedCart = {};

  value.split(",").forEach(part => {
    const [productId, quantity] = part.split(":");
    if (Object.hasOwn(PRODUCTS, productId)) savedCart[productId] = Number(quantity) || 1;
  });

  if (Object.keys(savedCart).length === 0) return false;

  applySavedOrder({ cart: savedCart }, { cart: true });
  showNotice(`Your previous order (${describeOrder(cart)}) is in the cart. Change anything you like, then continue below.`);
  return true;

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
  } else {
    element.scrollIntoView({ behavior: "smooth", block: "center" });
  }

}

function hideError() {
  document.getElementById("checkout-error").style.display = "none";
}

function showNotice(message) {
  const element = document.getElementById("checkout-notice");
  element.textContent = message;
  element.style.display = "block";
}


/*
==================================================
VALIDATION
==================================================
*/

function validateForm() {

  Object.values(fields).forEach(field => field.removeAttribute("aria-invalid"));

  if (getCartItems().length === 0) {
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

  hideError();

  const invalid =
    validateForm();

  if (invalid) {
    showError(invalid.message, invalid.field);
    return;
  }

  if (!API.isConfigured) {
    showError("Online ordering isn't set up yet. Please email us at hellokiranabakehouse@gmail.com to place your order.");
    return;
  }

  const button =
    document.getElementById("checkout-button");

  button.disabled =
    true;

  button.textContent =
    "Preparing secure checkout...";

  try {

    /*
    ------------------------------------------
    CONFIRM WE DELIVER TO THIS ADDRESS
    ------------------------------------------
    */

    const check =
      await checkAddress();

    if (check.status !== "valid") {
      throw Object.assign(new Error(check.message), { field: fields.line1 });
    }

    /*
    ------------------------------------------
    SEND ORDER TO SERVER
    ------------------------------------------
    */

    const data =
      await postJson(API.createCheckoutSession, {
        items: getCartItems(),
        deliveryDate: fields.deliveryDate.value,
        customer: { name: fields.name.value, phone: fields.phone.value },
        address: getAddress(),
        notes: fields.notes.value,
        tipCents: getTipCents(calculateSubtotal(getCartItems()))
      });

    /*
      Redirect customer to Stripe.
    */

    window.location.href =
      data.url;

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

    button.disabled =
      false;

    button.textContent =
      "Continue to Payment";

  }

}


async function postJson(path, body) {

  let response;

  try {
    response = await fetch(`${API.origin}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  } catch {
    throw new Error("We couldn't reach our ordering system. Please check your connection and try again.");
  }

  const data =
    await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || "Something went wrong. Please try again.");
  }

  return data;

}


/*
==================================================
INITIALIZE
==================================================
*/

renderProducts();

renderDeliveryDates();

renderTipOptions();

selectTip("0");

const params =
  new URLSearchParams(window.location.search);

const lastOrder =
  loadLastOrder();

if (params.has("cancelled")) {
  restoreOrder();
  showNotice("Your payment was cancelled and you haven't been charged. Your order is saved below whenever you're ready.");
} else if (params.has("reorder")) {
  if (lastOrder) applySavedOrder(lastOrder, { details: true });
  applyReorderLink(params.get("reorder"));
} else if (sessionStorage.getItem(STORAGE_KEY)) {
  restoreOrder();
} else if (lastOrder) {
  showWelcomeBack(lastOrder);
}

if (params.has("cancelled") || params.has("reorder")) {
  history.replaceState(null, "", window.location.pathname);
}

updateCart();

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
    hideError();
    saveOrder();
  });
});

fields.deliveryDate.addEventListener("change", () => {
  hideError();
  saveOrder();
});

form.addEventListener(
  "submit",
  checkout
);
