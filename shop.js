/*
==================================================
KIRANA BAKEHOUSE
SHARED SHOP

The menu, cart, tip and discount code, used by
both the delivery page (order.js) and the pickup
page (pickup.js). It works on these elements:

  #product-grid, #cart-items, #tip-options,
  #tip-custom, #tip-amount, #discount-entry,
  #discount-code, #discount-apply, #discount-status,
  #cart-subtotal, #cart-fee (optional), #cart-tip,
  #cart-discount-line, #cart-discount-label,
  #cart-discount, #cart-total, #checkout-error,
  #checkout-notice
==================================================
*/

import { API, BASE_INGREDIENTS, PRODUCTS, TIP } from "./macros.js?v=4";
import { calculateDiscount, calculateSubtotal, formatMoney } from "./delivery-rules.js?v=4";

const LAST_ORDER_KEY = "kirana-last-order";
const REMEMBER_DAYS = 90;

/*
  options:
    storageKey   sessionStorage key for the order in progress
    getFee       () => { cents, label } | null — the delivery fee line, if any
    getValues    () => object of form values to save with the order
    setValues    (values) => void — restore saved form values
    onChange     () => void — called whenever the cart, tip or discount changes
*/
export function createShop(options) {

  const cart = {};

  Object.keys(PRODUCTS).forEach(productId => {
    cart[productId] = 0;
  });

  // The tip: a percentage of the subtotal, or a custom amount in cents.
  const tip = { percent: 0, customCents: null };

  // The applied discount code, e.g. { code: "BREADUCATION", percent: 20 }.
  let discount = null;

  const shop = {
    cart,
    getCartItems,
    getLoafCount,
    getTipCents,
    getDiscount: () => discount,
    updateCart,
    updateTotals,
    saveOrder,
    restoreOrder,
    applySavedOrder,
    describeOrder,
    loadLastOrder,
    forgetLastOrder,
    applyReorderLink,
    showError,
    hideError,
    showNotice,
    postJson
  };

  /*
  ==================================================
  MENU
  ==================================================
  */

  function renderProducts() {

    const grid = document.getElementById("product-grid");

    grid.innerHTML = "";

    Object.entries(PRODUCTS).forEach(([id, product]) => {

      const card = document.createElement("article");
      card.className = "product-card";

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

          <div class="product-actions">

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

        </div>

      `;

      grid.appendChild(card);

    });

    grid.addEventListener("click", handleProductClick);

  }

  function handleProductClick(event) {

    const button = event.target.closest("button");
    if (!button) return;

    const productId = button.dataset.product;
    const product = PRODUCTS[productId];
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
  CART
  ==================================================
  */

  function getCartItems() {
    return Object.entries(cart)
      .filter(([, quantity]) => quantity > 0)
      .map(([productId, quantity]) => ({ productId, quantity }));
  }

  function getLoafCount() {
    return Object.values(cart).reduce((total, quantity) => total + quantity, 0);
  }

  function updateCart() {

    const cartElement = document.getElementById("cart-items");
    const items = getCartItems();

    cartElement.innerHTML = "";

    items.forEach(({ productId, quantity }) => {

      const product = PRODUCTS[productId];
      const item = document.createElement("div");
      item.className = "cart-item";

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

  The worker recalculates everything before
  creating the Stripe checkout; this is only
  what the customer sees.
  ==================================================
  */

  function updateTotals() {

    const subtotal = calculateSubtotal(getCartItems());
    const fee = options.getFee ? options.getFee() : null;
    const feeCents = fee?.cents || 0;
    const feeElement = document.getElementById("cart-fee");

    if (feeElement && fee) {
      feeElement.textContent = fee.label;
    }

    const tipCents = getTipCents(subtotal);
    const discountCents = discount ? calculateDiscount(discount.percent, subtotal, feeCents) : 0;

    document.getElementById("cart-subtotal").textContent = formatMoney(subtotal);
    document.getElementById("cart-tip").textContent = formatMoney(tipCents);
    document.getElementById("cart-discount-line").hidden = !discount;

    if (discount) {
      document.getElementById("cart-discount-label").textContent = `Discount (${discount.code}, ${discount.percent}% off)`;
      document.getElementById("cart-discount").textContent = `−${formatMoney(discountCents)}`;
    }

    document.getElementById("cart-total").textContent = formatMoney(subtotal + feeCents + tipCents - discountCents);

    if (options.onChange) options.onChange();

  }

  /*
  ==================================================
  TIP
  ==================================================
  */

  function getTipCents(subtotal = calculateSubtotal(getCartItems())) {
    if (tip.customCents !== null) return tip.customCents;
    return Math.round(subtotal * tip.percent / 100);
  }

  function renderTipOptions() {

    const optionsElement = document.getElementById("tip-options");

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
      optionsElement.appendChild(option);
    });

    optionsElement.addEventListener("click", event => {
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

    document.getElementById("tip-custom").hidden = value !== "custom";

    updateTotals();

  }

  /*
  ==================================================
  DISCOUNT CODE

  The worker checks the code (codes are kept
  private there) and applies it again at checkout.
  Discounts cover the loaves and delivery, not
  the tip.
  ==================================================
  */

  async function applyDiscountCode() {

    const input = document.getElementById("discount-code");
    const button = document.getElementById("discount-apply");
    const code = input.value.trim();

    if (!code) return;

    if (!API.isConfigured) {
      showDiscountStatus("error", "Discount codes aren't available yet.");
      return;
    }

    button.disabled = true;
    showDiscountStatus("", "Checking…");

    try {
      discount = await postJson(API.checkDiscount, { code });
      input.value = "";
      showAppliedDiscount();
      updateTotals();
      saveOrder();
    } catch (error) {
      showDiscountStatus("error", error.message);
    } finally {
      button.disabled = false;
    }

  }

  function showAppliedDiscount() {

    const hasFee = Boolean(options.getFee && options.getFee());
    showDiscountStatus("applied", `✓ ${discount.code} applied: ${discount.percent}% off your loaves${hasFee ? " and delivery" : ""}.`);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Remove";
    remove.addEventListener("click", removeDiscount);
    document.getElementById("discount-status").appendChild(remove);

    document.getElementById("discount-entry").hidden = true;

  }

  function removeDiscount() {
    discount = null;
    document.getElementById("discount-entry").hidden = false;
    showDiscountStatus("", "");
    updateTotals();
    saveOrder();
  }

  function showDiscountStatus(status, message) {
    const element = document.getElementById("discount-status");
    element.className = `discount-status ${status}`;
    element.textContent = message;
  }

  /*
  ==================================================
  SAVE ORDER IN PROGRESS

  Keeps the cart and form filled in if the
  customer goes back from Stripe Checkout or
  refreshes the page.
  ==================================================
  */

  function saveOrder() {
    try {
      sessionStorage.setItem(options.storageKey, JSON.stringify({ cart, values: options.getValues(), tip, discount }));
    } catch {
      // Storage can be unavailable (e.g. private browsing). Nothing to do.
    }
  }

  function restoreOrder() {

    let saved;

    try {
      saved = JSON.parse(sessionStorage.getItem(options.storageKey));
    } catch {
      return;
    }

    if (!saved) return;

    applySavedOrder(saved, { cart: true, tip: true, details: true });

    // The worker re-checks the code at checkout, so a stale one is caught there.
    if (typeof saved.discount?.code === "string" && Number.isInteger(saved.discount.percent)) {
      discount = { code: saved.discount.code, percent: saved.discount.percent };
      showAppliedDiscount();
    }

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

    if (parts.details && saved.values) {
      options.setValues(saved.values);
    }

  }

  /*
  ==================================================
  RETURNING CUSTOMERS

  The thank-you page saves each completed order in
  the browser for REMEMBER_DAYS days, so the next
  visit can fill in the details and offer a
  one-click reorder.
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

  function describeOrder(savedCart = cart) {
    return Object.entries(savedCart || {})
      .filter(([productId, quantity]) => Object.hasOwn(PRODUCTS, productId) && quantity > 0)
      .map(([productId, quantity]) => `${quantity} × ${PRODUCTS[productId].name}`)
      .join(", ");
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
    showNotice(`Your previous order (${describeOrder()}) is in the cart. Change anything you like, then continue below.`);
    return true;

  }

  /*
  ==================================================
  MESSAGES
  ==================================================
  */

  function showError(message, focusElement) {

    const element = document.getElementById("checkout-error");

    element.textContent = message;
    element.style.display = "block";

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
  WORKER REQUESTS
  ==================================================
  */

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

    const data = await response.json().catch(() => ({}));

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
  renderTipOptions();
  selectTip("0");

  document.getElementById("discount-apply").addEventListener("click", applyDiscountCode);

  document.getElementById("discount-code").addEventListener("keydown", event => {
    if (event.key === "Enter") {
      event.preventDefault();
      applyDiscountCode();
    }
  });

  return shop;

}
