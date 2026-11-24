import { test } from "node:test";
import assert from "node:assert/strict";
import { surchargeCents, surchargeNotice, surchargeParams, surchargeVersion } from "../src/surcharge.js";
import { SURCHARGE } from "../../macros.js";

test("the card surcharge is off until it's switched on", () => {
  assert.equal(SURCHARGE.enabled, false);
  assert.deepEqual(surchargeParams(SURCHARGE), {});
  assert.deepEqual(surchargeVersion(SURCHARGE), {});
  assert.equal(surchargeNotice(SURCHARGE), "");
});

test("switched on, sessions ask Stripe for the surcharge on the preview API", () => {
  const on = { ...SURCHARGE, enabled: true };
  assert.deepEqual(surchargeParams(on), { automatic_surcharge: { enabled: true, calculation_basis: "total_after_tax" } });
  assert.deepEqual(surchargeVersion(on), { version: SURCHARGE.apiVersion });
  assert.match(surchargeNotice(on), /up to 3%.*debit cards don't/);
});

test("the surcharge paid is read from the session", () => {
  assert.equal(surchargeCents({ amount_total: 3348, amount_subtotal: 3200, total_details: { amount_surcharge: 148 } }), 148);
  // Older API versions: whatever the total has on top of items, discount and tax.
  assert.equal(surchargeCents({ amount_total: 3048, amount_subtotal: 3200, total_details: { amount_discount: 300, amount_tax: 0 } }), 148);
  assert.equal(surchargeCents({ amount_total: 2900, amount_subtotal: 3200, total_details: { amount_discount: 300 } }), 0);
  assert.equal(surchargeCents({}), 0);
});
