/*
==================================================
GIFT CARDS PAGE (gift.html)

Pick an amount, say who it's for, pay on Stripe's
page. Back here afterwards (?session_id=…), the
page shows the code and whether it was emailed.
The worker makes the card and sends the email
(worker/src/gift-purchase.js).
==================================================
*/

import { API, GIFT_CARDS, SERVICE_FEE } from "./macros.js";
import { calculateServiceFee } from "./delivery-rules.js";

const SAVED_KEY = "kirana-gift-form";

const $ = id => document.getElementById(id);
const money = cents => `$${(cents / 100).toFixed(2)}`;
const wholeDollars = cents => `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`;

const state = {
  amountCents: GIFT_CARDS.amounts[1] ?? GIFT_CARDS.amounts[0],
  other: false
};

/*
==================================================
AMOUNTS
==================================================
*/

function renderAmounts() {
  const group = $("amounts");
  group.replaceChildren(...GIFT_CARDS.amounts.map(cents => amountButton(wholeDollars(cents), () => {
    state.other = false;
    state.amountCents = cents;
  }, () => !state.other && state.amountCents === cents)), amountButton("Other", () => {
    state.other = true;
    state.amountCents = otherAmountCents();
    setTimeout(() => $("other-amount-input").focus(), 0);
  }, () => state.other));
  $("other-amount").hidden = !state.other;
}

function amountButton(label, choose, isChosen) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "amount";
  button.textContent = label;
  button.setAttribute("aria-pressed", String(isChosen()));
  button.addEventListener("click", () => {
    choose();
    renderAmounts();
    update();
  });
  return button;
}

function otherAmountCents() {
  const dollars = Number($("other-amount-input").value);
  return Number.isFinite(dollars) && dollars > 0 ? Math.round(dollars) * 100 : 0;
}

/*
==================================================
TOTALS AND PREVIEW
==================================================
*/

function update() {
  const amount = state.amountCents;
  const fee = calculateServiceFee(SERVICE_FEE, amount);
  $("total-card").textContent = amount ? wholeDollars(amount) : "–";
  $("total-fee-label").textContent = SERVICE_FEE.label;
  $("total-fee").textContent = money(fee);
  $("total-all").textContent = money(amount + fee);

  $("preview-amount").textContent = amount ? wholeDollars(amount) : "$–";
  const to = $("recipient-name").value.trim();
  $("preview-to").textContent = to ? `For ${to}` : "For someone special";
  const message = $("message").value.trim();
  $("preview-message").hidden = !message;
  $("preview-message").textContent = message ? `“${message}”` : "";
  const from = $("from-name").value.trim();
  $("preview-from").hidden = !from;
  $("preview-from").textContent = from ? `– ${from}` : "";

  const left = GIFT_CARDS.messageMaxLength - $("message").value.length;
  $("message-count").textContent = `${left} characters left`;

  save();
}

/*
==================================================
REMEMBERING THE FORM

So coming back from Stripe (or cancelling) doesn't
lose what was typed. Cleared after paying.
==================================================
*/

function save() {
  try {
    sessionStorage.setItem(SAVED_KEY, JSON.stringify({
      amountCents: state.amountCents,
      other: state.other,
      otherDollars: $("other-amount-input").value,
      recipientName: $("recipient-name").value,
      recipientEmail: $("recipient-email").value,
      fromName: $("from-name").value,
      message: $("message").value
    }));
  } catch {
    // Private browsing: nothing to remember.
  }
}

function restore() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(SAVED_KEY) || "null");
    if (!saved) return;
    state.other = Boolean(saved.other);
    state.amountCents = Number(saved.amountCents) || state.amountCents;
    $("other-amount-input").value = saved.otherDollars || "";
    $("recipient-name").value = saved.recipientName || "";
    $("recipient-email").value = saved.recipientEmail || "";
    $("from-name").value = saved.fromName || "";
    $("message").value = saved.message || "";
  } catch {
    // Nothing usable saved.
  }
}

/*
==================================================
PAYING
==================================================
*/

function showError(message) {
  $("gift-error").textContent = message;
  $("gift-error").hidden = !message;
}

async function submit(event) {
  event.preventDefault();
  showError("");

  const amountCents = state.other ? otherAmountCents() : state.amountCents;
  if (!amountCents || amountCents < GIFT_CARDS.minCents || amountCents > GIFT_CARDS.maxCents) {
    showError(`Choose an amount from ${wholeDollars(GIFT_CARDS.minCents)} to ${wholeDollars(GIFT_CARDS.maxCents)}.`);
    return;
  }
  const fields = [["recipient-name", "Add their name."], ["recipient-email", "Add their email address."], ["from-name", "Add your name."]];
  for (const [id, message] of fields) {
    const input = $(id);
    if (!input.value.trim() || !input.checkValidity()) {
      showError(id === "recipient-email" && input.value.trim() ? "That email address doesn't look right." : message);
      input.focus();
      return;
    }
  }

  if (!API.isConfigured) {
    showError("Gift cards aren't available yet. Please check back soon.");
    return;
  }

  const button = $("gift-submit");
  button.disabled = true;
  button.textContent = "Opening secure payment…";

  try {
    const response = await fetch(`${API.origin}${API.buyGiftCard}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        amountCents,
        recipientName: $("recipient-name").value,
        recipientEmail: $("recipient-email").value,
        fromName: $("from-name").value,
        message: $("message").value
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.url) throw new Error(data.error || "Something went wrong. Please try again.");
    window.location.href = data.url;
  } catch (error) {
    const offline = error instanceof TypeError;
    showError(offline ? "We couldn't reach our payment system. Please check your connection and try again." : error.message);
    button.disabled = false;
    button.textContent = "Continue to payment";
  }
}

/*
==================================================
AFTER PAYING
==================================================
*/

async function showThanks(sessionId) {
  $("gift-buy").hidden = true;
  const thanks = $("gift-thanks");
  thanks.hidden = false;
  thanks.innerHTML = "<p>Finishing up your gift card…</p>";

  let data;
  try {
    const response = await fetch(`${API.origin}${API.giftCardPurchase}?session_id=${encodeURIComponent(sessionId)}`);
    data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "We couldn't find that gift card.");
  } catch (error) {
    thanks.replaceChildren(
      heading("Thank you!"),
      paragraph(`${error instanceof TypeError ? "We couldn't load your gift card just now." : error.message} If you were charged, don't worry: email us or DM @kiranabakehouse and we'll sort it out.`),
      againLink()
    );
    return;
  }

  try { sessionStorage.removeItem(SAVED_KEY); } catch { /* fine */ }

  const art = document.createElement("div");
  art.className = "card-art";
  art.innerHTML = `
    <div class="flakes" aria-hidden="true">❄ ✦ ❄ ✦ ❄</div>
    <div class="brand">Kirana Bakehouse</div>
    <div class="kind">GIFT CARD</div>
    <div class="amount-big"></div>
    <div class="to"></div>`;
  art.querySelector(".amount-big").textContent = wholeDollars(data.amountCents);
  art.querySelector(".to").textContent = `For ${data.recipientName}`;

  const code = document.createElement("div");
  code.className = "gift-code";
  const codeText = document.createElement("code");
  codeText.textContent = data.code;
  const copy = document.createElement("button");
  copy.type = "button";
  copy.textContent = "Copy code";
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(data.code);
      copy.textContent = "Copied!";
    } catch {
      copy.textContent = "Select and copy the code";
    }
  });
  code.append(codeText, copy);

  thanks.replaceChildren(
    heading("Gift sent!"),
    art,
    paragraph(data.emailed
      ? `We've emailed the gift card to ${data.recipientName} at ${data.recipientEmail}, and sent you a copy. Here's the code too, just in case:`
      : `Your gift card for ${data.recipientName} is ready. Here's the code: pass it on to them, or copy it into a message of your own.`),
    code,
    paragraph("Stripe sends your receipt by email."),
    againLink()
  );
}

function heading(text) {
  const h2 = document.createElement("h2");
  h2.textContent = text;
  return h2;
}

function paragraph(text) {
  const p = document.createElement("p");
  p.textContent = text;
  return p;
}

function againLink() {
  const link = document.createElement("a");
  link.href = "gift.html";
  link.className = "again";
  link.textContent = "Send another gift card";
  return link;
}

/*
==================================================
START
==================================================
*/

const params = new URLSearchParams(window.location.search);

$("other-amount-input").min = String(GIFT_CARDS.minCents / 100);
$("other-amount-input").max = String(GIFT_CARDS.maxCents / 100);
$("other-amount-input").placeholder = `${GIFT_CARDS.minCents / 100}–${GIFT_CARDS.maxCents / 100}`;
$("message").maxLength = GIFT_CARDS.messageMaxLength;
$("fee-note").textContent = `A payment processing fee of ${SERVICE_FEE.percent}% + ${SERVICE_FEE.flatCents}¢ is added to cover card fees.`;

restore();
renderAmounts();
update();

$("other-amount-input").addEventListener("input", () => {
  state.amountCents = otherAmountCents();
  update();
});
for (const id of ["recipient-name", "recipient-email", "from-name", "message"]) {
  $(id).addEventListener("input", update);
}
$("gift-form").addEventListener("submit", submit);

if (params.get("session_id")) {
  showThanks(params.get("session_id"));
} else if (params.has("cancelled")) {
  $("gift-notice").textContent = "Payment cancelled. Nothing was charged, and your details are still here.";
  $("gift-notice").hidden = false;
}
