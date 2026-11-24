import { test } from "node:test";
import assert from "node:assert/strict";
import { calculateServiceFee } from "../../delivery-rules.js";
import { SERVICE_FEE } from "../../macros.js";

test("the service fee is 3% plus 30¢ of loaves and delivery after discount", () => {
  assert.equal(calculateServiceFee(SERVICE_FEE, 1600), 78);
  assert.equal(calculateServiceFee(SERVICE_FEE, 3200 + 300), 135);
  // Rounded to the cent.
  assert.equal(calculateServiceFee(SERVICE_FEE, 1650), 80);
});

test("no service fee when there's nothing to pay, or when it's turned off", () => {
  assert.equal(calculateServiceFee(SERVICE_FEE, 0), 0);
  assert.equal(calculateServiceFee(SERVICE_FEE, -50), 0);
  assert.equal(calculateServiceFee({ ...SERVICE_FEE, percent: 0, flatCents: 0 }, 1600), 0);
  assert.equal(calculateServiceFee({ ...SERVICE_FEE, percent: 0 }, 1600), 30);
});

test("the note says what the fee is and what it's for", () => {
  assert.match(SERVICE_FEE.note, /3% \+ 30¢/);
  assert.match(SERVICE_FEE.note, /payment processing/);
});
