import { API, MONEY } from "./macros.js";

const form = document.getElementById("delivery-check-form");
const addressInput = document.getElementById("delivery-address");
const result = document.getElementById("delivery-result");
const submitButton = form.querySelector("button");
const money = cents => new Intl.NumberFormat(MONEY.locale, { style: "currency", currency: MONEY.currency }).format(cents / MONEY.centsPerDollar);

form.addEventListener("submit", async event => {
  event.preventDefault();
  submitButton.disabled = true;
  submitButton.textContent = "Checking…";
  result.className = "delivery-result";
  result.textContent = "";
  try {
    const response = await fetch(`${API.origin}${API.checkDelivery}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: addressInput.value }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Unable to check this address.");
    if (!data.deliverable) return showResult("invalid", "Sorry, we don't deliver there yet.", `${data.message} It is about ${data.distanceMiles} miles from our kitchen.`);
    const feeMessage = data.freeOverCents === 0 ? "Delivery is free." : `${money(data.feeCents)} delivery, free for orders over ${money(data.freeOverCents)}.`;
    showResult("valid", "Good news — we deliver to this address!", `It is about ${data.distanceMiles} miles away. ${feeMessage}`);
  } catch (error) {
    showResult("error", "We couldn't check that address.", error.message);
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "Check delivery area";
  }
});

function showResult(status, heading, message) {
  result.className = `delivery-result ${status}`;
  const title = document.createElement("h2");
  title.textContent = heading;
  const text = document.createElement("p");
  text.textContent = message;
  result.replaceChildren(title, text);
}
