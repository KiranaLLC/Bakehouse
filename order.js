/*
==================================================
KIRANA BAKEHOUSE
DELIVERY ORDERING SYSTEM
==================================================
*/

import { API, DELIVERY, MONEY, PRODUCTS } from "./macros.js";


/*
==================================================
CART
==================================================
*/

const cart = {};

Object.keys(PRODUCTS).forEach(productId => {
  cart[productId] = 0;
});


/*
==================================================
MONEY
==================================================
*/

function formatMoney(cents) {

  return new Intl.NumberFormat(
    MONEY.locale,
    {
      style: "currency",
      currency: MONEY.currency
    }
  ).format(cents / MONEY.centsPerDollar);

}


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

          <div class="product-price">
            ${formatMoney(product.price)}
          </div>

          <div class="quantity-row">

            <button
              type="button"
              data-action="minus"
              data-product="${id}"
              aria-label="Remove ${product.name}"
            >
              −
            </button>

            <span
              id="quantity-${id}"
              class="quantity"
            >
              0
            </span>

            <button
              type="button"
              data-action="plus"
              data-product="${id}"
              aria-label="Add ${product.name}"
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

  const action =
    button.dataset.action;

  if (action === "plus") {
    addToCart(productId);
  }

  if (action === "minus") {
    removeFromCart(productId);
  }

}


/*
==================================================
ADD TO CART
==================================================
*/

function addToCart(productId) {

  const product =
    PRODUCTS[productId];

  if (!product) return;

  if (
    cart[productId] >=
    product.maxQuantity
  ) {
    return;
  }

  cart[productId]++;

  updateCart();

}


/*
==================================================
REMOVE FROM CART
==================================================
*/

function removeFromCart(productId) {

  if (
    !cart[productId] ||
    cart[productId] <= 0
  ) {
    return;
  }

  cart[productId]--;

  updateCart();

}


/*
==================================================
UPDATE CART
==================================================
*/

function updateCart() {

  const cartElement =
    document.getElementById("cart-items");

  let total = 0;
  let itemCount = 0;

  cartElement.innerHTML = "";

  Object.entries(cart).forEach(
    ([productId, quantity]) => {

      if (quantity <= 0) return;

      const product =
        PRODUCTS[productId];

      const itemTotal =
        product.price * quantity;

      total += itemTotal;
      itemCount += quantity;

      const item =
        document.createElement("div");

      item.className =
        "cart-item";

      item.innerHTML = `

        <span>
          ${product.name} × ${quantity}
        </span>

        <span>
          ${formatMoney(itemTotal)}
        </span>

      `;

      cartElement.appendChild(item);

    }
  );

  if (itemCount === 0) {

    cartElement.innerHTML = `

      <p class="empty-cart">
        Your cart is empty.
      </p>

    `;

  }

  document.getElementById(
    "cart-total"
  ).textContent =
    formatMoney(total);

  Object.keys(PRODUCTS).forEach(
    productId => {

      const quantityElement =
        document.getElementById(
          `quantity-${productId}`
        );

      if (quantityElement) {

        quantityElement.textContent =
          cart[productId];

      }

    }
  );

  updateCheckoutButton();

}


/*
==================================================
CHECKOUT BUTTON
==================================================
*/

function updateCheckoutButton() {

  const button =
    document.getElementById(
      "checkout-button"
    );

  const deliveryDate =
    document.getElementById(
      "delivery-date"
    ).value;

  const itemCount =
    Object.values(cart)
      .reduce(
        (total, quantity) =>
          total + quantity,
        0
      );

  button.disabled =
    itemCount === 0 ||
    !deliveryDate;

}


/*
==================================================
DELIVERY DATES
==================================================

DELIVERY:
Tuesday
Wednesday
Thursday
Friday
Saturday

NO DELIVERY:
Sunday
Monday

We show the next 15 available
delivery dates.
==================================================
*/

function generateDeliveryDates() {

  const select =
    document.getElementById(
      "delivery-date"
    );

  const today =
    new Date();

  for (
    let i = 0;
    i < DELIVERY.clientDatesToScan;
    i++
  ) {

    const date =
      new Date(today);

    date.setDate(
      today.getDate() + i + DELIVERY.firstAvailableOffsetDays
    );

    const day =
      date.getDay();

    /*
      Sunday = 0
      Monday = 1
      Tuesday = 2
      Wednesday = 3
      Thursday = 4
      Friday = 5
      Saturday = 6
    */

    /*
      Skip Sunday and Monday.
    */

    if (
      DELIVERY.unavailableDays.includes(day)
    ) {
      continue;
    }

    const year =
      date.getFullYear();

    const month =
      String(
        date.getMonth() + 1
      ).padStart(2, "0");

    const dayNumber =
      String(
        date.getDate()
      ).padStart(2, "0");

    const value =
      `${year}-${month}-${dayNumber}`;

    const label =
      date.toLocaleDateString(
        DELIVERY.locale,
        {
          weekday: "long",
          month: "long",
          day: "numeric"
        }
      );

    const option =
      document.createElement("option");

    option.value =
      value;

    option.textContent =
      label;

    select.appendChild(option);

  }

  select.addEventListener(
    "change",
    updateCheckoutButton
  );

}


/*
==================================================
ERROR MESSAGE
==================================================
*/

function showError(message) {

  const element =
    document.getElementById(
      "checkout-error"
    );

  element.textContent =
    message;

  element.style.display =
    "block";

  window.scrollTo({
    top: document.body.scrollHeight,
    behavior: "smooth"
  });

}


/*
==================================================
CHECKOUT
==================================================
*/

async function checkout() {

  const deliveryDate =
    document.getElementById(
      "delivery-date"
    ).value;

  /*
  ------------------------------------------
  VALIDATE DELIVERY DATE
  ------------------------------------------
  */

  if (!deliveryDate) {

    showError(
      "Please select a delivery date."
    );

    return;

  }


  /*
  ------------------------------------------
  VALIDATE CART
  ------------------------------------------
  */

  const items =
    Object.entries(cart)

      .filter(
        ([, quantity]) =>
          quantity > 0
      )

      .map(
        ([productId, quantity]) => ({

          productId,

          quantity

        })
      );


  if (
    items.length === 0
  ) {

    showError(
      "Your cart is empty."
    );

    return;

  }


  /*
  ------------------------------------------
  BUTTON
  ------------------------------------------
  */

  const button =
    document.getElementById(
      "checkout-button"
    );

  button.disabled =
    true;

  button.textContent =
    "Preparing secure checkout...";


  /*
  ------------------------------------------
  SEND ORDER TO SERVER
  ------------------------------------------
  */

  try {

    const response =
      await fetch(
        API.createCheckoutSession,
        {

          method: "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify({

              items,

              deliveryDate

            })

        }
      );


    const data =
      await response.json();


    if (!response.ok) {

      throw new Error(
        data.error ||
        "Unable to create checkout."
      );

    }


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
      error.message ||
      "Something went wrong. Please try again."
    );

    button.disabled =
      false;

    button.textContent =
      "Proceed to Secure Checkout";

    updateCheckoutButton();

  }

}


/*
==================================================
INITIALIZE
==================================================
*/

renderProducts();

generateDeliveryDates();

updateCart();


document
  .getElementById("checkout-button")
  .addEventListener(
    "click",
    checkout
  );
