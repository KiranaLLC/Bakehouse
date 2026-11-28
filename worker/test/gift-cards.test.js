import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeD1 } from "./fake-d1.js";
import {
  checkGiftCard, createGiftCard, findGiftCard, holdGiftCard, markGiftUseUsed, newGiftCode,
  normalizeGiftCode, planGiftCard, releaseGiftUse, settleGiftForSession, attachGiftUse
} from "../src/gift-cards.js";

test("gift codes are easy to read and forgiving to type", () => {
  const code = newGiftCode();
  assert.match(code, /^KIRANA-[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);
  assert.equal(normalizeGiftCode("kirana 7qkm x2pd"), "KIRANA-7QKM-X2PD");
  assert.equal(normalizeGiftCode(" 7QKM-X2PD "), "KIRANA-7QKM-X2PD");
  assert.equal(normalizeGiftCode("nope"), null);
});

test("a gift card covers loaves and delivery first, then the tip, and the fee is on what's left", () => {
  // $32 of loaves, $3 tip, $50 card: everything covered, no fee.
  assert.deepEqual(planGiftCard(5000, { baseCents: 3200, tipCents: 300 }), { giftCents: 3500, serviceFee: 0, totalCents: 0 });
  // $25 card on $32 of loaves: $7 left, fee 3% + 30¢ on it, tip paid by card.
  assert.deepEqual(planGiftCard(2500, { baseCents: 3200, tipCents: 300 }), { giftCents: 2500, serviceFee: 51, totalCents: 700 + 51 + 300 });
  // No card.
  assert.deepEqual(planGiftCard(0, { baseCents: 1600, tipCents: 0 }), { giftCents: 0, serviceFee: 78, totalCents: 1678 });
});

test("a gift card never leaves less than Stripe's 50¢ to pay", () => {
  // $15.90 card on a $16 loaf would leave 10¢ + 30¢ fee = 40¢: it leaves 50¢ or more instead.
  const plan = planGiftCard(1590, { baseCents: 1600, tipCents: 0 });
  assert.ok(plan.totalCents >= 50, JSON.stringify(plan));
  assert.equal(plan.totalCents, 1600 - plan.giftCents + plan.serviceFee);
  // With a tip, the tip makes up the difference first.
  const withTip = planGiftCard(1620, { baseCents: 1600, tipCents: 40 });
  assert.ok(withTip.totalCents >= 50 && withTip.giftCents <= 1620, JSON.stringify(withTip));
  // Enough on the card for everything: nothing to pay at all.
  assert.equal(planGiftCard(1640, { baseCents: 1600, tipCents: 40 }).totalCents, 0);
});

test("holding, using and releasing a balance", async () => {
  const env = { DB: createFakeD1() };
  const card = await createGiftCard(env, { amountCents: 5000, source: "issued", recipientName: "Ana" });
  assert.equal((await checkGiftCard(env, card.code.toLowerCase())).balanceCents, 5000);

  const first = await holdGiftCard(env, card, 3000);
  assert.equal((await findGiftCard(env, card.code)).balanceCents, 2000);
  // Can't spend more than what's left while the first payment is open.
  await assert.rejects(holdGiftCard(env, card, 2500), /balance just changed/);

  // Customer left: it goes back, once.
  assert.equal(await releaseGiftUse(env, first), true);
  assert.equal(await releaseGiftUse(env, first), false);
  assert.equal((await findGiftCard(env, card.code)).balanceCents, 5000);

  // Paid: it stays spent, and can't be released after.
  const second = await holdGiftCard(env, card, 5000);
  await attachGiftUse(env, second, "cs_paid");
  await settleGiftForSession(env, { id: "cs_paid", status: "complete", payment_status: "no_payment_required", metadata: { gift_use_id: String(second) } });
  assert.equal(await releaseGiftUse(env, second), false);
  await assert.rejects(checkGiftCard(env, card.code), /used up/);
  assert.equal(await markGiftUseUsed(env, second), false);
});

test("a bought card is made once, however many times it's asked for", async () => {
  const env = { DB: createFakeD1() };
  const one = await createGiftCard(env, { amountCents: 2500, source: "purchase", stripeSessionId: "cs_buy" });
  const two = await createGiftCard(env, { amountCents: 2500, source: "purchase", stripeSessionId: "cs_buy" });
  assert.equal(one.code, two.code);
  await assert.rejects(findGiftCard(env, "KIRANA-2222-2222"), /couldn't find/);
});
