import { DELIVERY_SERVICE } from "./macros.js";
import { describeDeliveryFee } from "./delivery-rules.js";
import { checkDeliveryArea } from "./delivery-area.js";

const form = document.getElementById("delivery-check-form");
const addressInput = document.getElementById("delivery-address");
const result = document.getElementById("delivery-result");
const submitButton = form.querySelector("button");

form.addEventListener("submit", async event => {
  event.preventDefault();
  const address = addressInput.value.trim();
  if (!address) return;
  submitButton.disabled = true;
  submitButton.textContent = "Checking…";
  result.className = "delivery-result";
  result.textContent = "";
  try {
    const { distanceMiles, zone } = await checkDeliveryArea(address);
    if (!zone) return showResult("invalid", "Sorry, we don't deliver there yet.", `This address is outside our ${DELIVERY_SERVICE.maxMiles}-mile delivery area. It is about ${distanceMiles} miles from our kitchen.`);
    showResult("valid", "Good news — we deliver to this address!", `It is about ${distanceMiles} miles away. ${describeDeliveryFee(zone)}`);
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
