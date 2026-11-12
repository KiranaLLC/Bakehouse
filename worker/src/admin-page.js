/*
  The bakery's private orders page, served by the worker at /admin
  (see admin.js). One self-contained page: no outside scripts, fonts or
  images, so nothing else ever sees the orders.

  Written as a String.raw template, so the page's own script below avoids
  backticks and dollar-brace.
*/

export const ADMIN_PAGE = String.raw`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Orders · Kirana Bakehouse</title>
<style>
  :root {
    --cream: #f0e7c8;
    --paper: #fbf7ea;
    --terracotta: #b32000;
    --deep-brown: #4d1a00;
    --ink: #2a1a10;
    --muted: #7a6a5a;
    --line: #e2d6b5;
    --good: #2f6b2f;
    --warn: #9a5b00;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--cream);
    color: var(--ink);
    font: 16px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  header {
    background: var(--deep-brown);
    color: var(--cream);
    padding: 14px 16px;
    display: flex;
    align-items: center;
    gap: 12px;
    position: sticky;
    top: 0;
    z-index: 2;
  }
  header h1 { font-size: 1.05rem; margin: 0; flex: 1; font-weight: 600; }
  header button { background: none; border: 1px solid rgba(240,231,200,.5); color: var(--cream); border-radius: 999px; padding: 6px 12px; font: inherit; font-size: .85rem; cursor: pointer; }
  main { max-width: 720px; margin: 0 auto; padding: 16px; }
  [hidden] { display: none !important; }

  .card { background: var(--paper); border: 1px solid var(--line); border-radius: 12px; padding: 16px; margin-bottom: 12px; }

  /* Sign in */
  .signin { max-width: 360px; margin: 12vh auto 0; }
  .signin h2 { margin: 0 0 4px; color: var(--deep-brown); }
  .signin p { margin: 0 0 16px; color: var(--muted); }
  .signin input { width: 100%; padding: 12px; font: inherit; border: 1px solid var(--line); border-radius: 8px; background: white; margin-bottom: 12px; }
  .primary { width: 100%; padding: 12px; font: inherit; font-weight: 600; border: 0; border-radius: 999px; background: var(--terracotta); color: white; cursor: pointer; }
  .primary:disabled { opacity: .6; cursor: default; }
  .error { color: var(--terracotta); margin: 0 0 12px; }

  /* Tabs */
  .tabs { display: flex; gap: 8px; margin-bottom: 16px; }
  .tabs button { flex: 1; padding: 10px; font: inherit; font-weight: 600; border-radius: 999px; border: 1px solid var(--deep-brown); background: transparent; color: var(--deep-brown); cursor: pointer; }
  .tabs button[aria-selected="true"] { background: var(--deep-brown); color: var(--cream); }

  .summary { color: var(--muted); margin: 0 0 16px; }
  .empty { text-align: center; color: var(--muted); padding: 40px 16px; }

  /* Day headings */
  .day { margin: 24px 0 8px; display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
  .day:first-child { margin-top: 0; }
  .day h2 { font-size: 1.1rem; margin: 0; color: var(--deep-brown); }
  .day span { color: var(--muted); font-size: .9rem; white-space: nowrap; }
  .past-due h2 { color: var(--warn); }
  .badge { display: inline-block; font-size: .75rem; font-weight: 600; color: var(--warn); border: 1px solid currentColor; border-radius: 999px; padding: 1px 8px; margin-left: 6px; vertical-align: middle; }
  .badge.invoice { color: var(--deep-brown); }
  .badge.unpaid { color: var(--terracotta); }
  .badge.pickup { color: var(--good); }
  .badge.delivery { color: var(--terracotta); }
  .prep-part h4 .badge { margin-left: 0; }

  /* Drops */
  .drops-toolbar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 16px; }
  .drops-toolbar .primary { width: auto; padding: 10px 18px; }
  .drops-toolbar .count { color: var(--muted); font-size: .95rem; }
  .drop h3 { margin: 0 0 4px; font-size: 1.05rem; }
  .drop .where { margin: 0 0 8px; color: var(--muted); font-size: .95rem; }
  .status { display: inline-block; font-size: .78rem; font-weight: 700; border-radius: 999px; padding: 2px 10px; margin: 0 0 10px; }
  .status.open { background: #e3f0e3; color: var(--good); }
  .status.upcoming { background: #fbefd9; color: var(--warn); }
  .status.sold_out { background: #f6dcd5; color: var(--terracotta); }
  .status.closed, .status.cancelled { background: #ece6d6; color: var(--muted); }
  .meter { height: 8px; border-radius: 999px; background: var(--line); overflow: hidden; margin: 6px 0 4px; }
  .meter span { display: block; height: 100%; background: var(--deep-brown); }
  .drop-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
  .drop-actions > * { padding: 8px 14px; font: inherit; font-size: .9rem; font-weight: 600; border-radius: 999px; border: 1.5px solid var(--deep-brown); background: white; color: var(--deep-brown); text-decoration: none; cursor: pointer; }
  .drop-actions .quiet { border-color: var(--line); color: var(--muted); }
  .drop-form { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 10px 12px; }
  .drop-form label { display: block; font-size: .85rem; color: var(--muted); margin-bottom: 4px; }
  .drop-form input, .drop-form textarea { width: 100%; min-width: 0; padding: 9px 10px; font: inherit; border: 1px solid var(--line); border-radius: 8px; background: white; }
  .drop-form .wide { grid-column: 1 / -1; }
  .drop-form .buttons { grid-column: 1 / -1; display: flex; gap: 8px; }
  .drop-form .buttons .primary { width: auto; padding: 10px 20px; }
  .drop-form .check { grid-column: 1 / -1; display: flex; gap: 10px; align-items: flex-start; font-size: .95rem; color: var(--ink); margin: 2px 0 4px; }
  .drop-form .check input { width: 20px; height: 20px; flex: none; margin: 1px 0 0; accent-color: var(--terracotta); }
  .drop-form .check small { display: block; color: var(--muted); font-size: .82rem; margin-top: 2px; }
  .subscribers { list-style: none; margin: 0; padding: 0; }
  .subscribers li { display: flex; justify-content: space-between; gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--line); overflow-wrap: anywhere; }
  .subscribers li:last-child { border-bottom: 0; }

  /* Prep */
  .prep-list { list-style: none; margin: 0; padding: 0; }
  .prep-part { margin-top: 16px; padding-top: 12px; border-top: 2px solid var(--line); }
  .prep-columns { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0 18px; }
  .prep-columns .prep-part { margin-top: 0; padding-top: 0; border-top: 0; min-width: 0; }
  .prep-columns .prep-part + .prep-part { border-left: 1px solid var(--line); padding-left: 18px; }
  .prep-columns h4 { flex-wrap: wrap; padding-bottom: 8px; border-bottom: 2px solid var(--deep-brown); margin-bottom: 4px; }
  .prep-columns .prep-list li { gap: 8px; }
  .prep-columns .prep-list li span:first-child { hyphens: auto; -webkit-hyphens: auto; overflow-wrap: anywhere; }
  @media (max-width: 520px) {
    .prep-columns { gap: 0 8px; margin: 0 -6px; }
    .prep-columns .prep-part + .prep-part { padding-left: 8px; }
    .prep-columns h4, .prep-columns .prep-list li { font-size: .82rem; }
    .prep-columns .prep-list .count { font-size: .9rem; }
    .prep-columns h4 .muted { display: none; }
  }
  .prep-part.only { margin-top: 0; padding-top: 0; border-top: 0; }
  .prep-part.only .prep-list li { padding: 10px 0; font-size: 1rem; }
  .prep-part.only .prep-list .count { font-size: 1.15rem; }
  .prep-part h4 { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 0 0 4px; font-size: .95rem; }
  .prep-part h4 .muted { font-weight: 400; color: var(--muted); font-size: .85rem; }
  .prep-part .prep-list li { padding: 6px 0; font-size: .95rem; }
  .prep-part .prep-list .count { font-size: 1rem; }
  .prep-heading { margin: 0 0 4px; font-size: .95rem; color: var(--muted); font-weight: 600; }
  .prep-list li { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid var(--line); }
  .prep-list li:last-child { border-bottom: 0; }
  .prep-list .count { font-weight: 700; font-size: 1.15rem; color: var(--deep-brown); min-width: 2.5ch; text-align: right; }
  .prep-total { display: flex; justify-content: space-between; font-weight: 700; padding-top: 10px; margin-top: 4px; border-top: 2px solid var(--deep-brown); }

  /* Orders */
  .order h3 { margin: 0 0 2px; font-size: 1.05rem; }
  .order .items { margin: 0 0 10px; font-weight: 600; color: var(--deep-brown); }
  .order dl { margin: 0 0 14px; display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; font-size: .95rem; }
  .order dt { color: var(--muted); }
  .order dd { margin: 0; overflow-wrap: anywhere; }
  .order a { color: var(--terracotta); }
  .order-actions { display: flex; gap: 8px; }
  .order-actions > * { flex: 1; padding: 12px; font: inherit; font-weight: 600; text-align: center; text-decoration: none; border-radius: 999px; cursor: pointer; }
  .deliver { border: 2px solid var(--good); background: white; color: var(--good); }
  .deliver:disabled { opacity: .6; cursor: default; }
  .email { border: 2px solid var(--terracotta); background: white; color: var(--terracotta) !important; font: inherit; font-weight: 600; }
  .email.sent { border-color: var(--line); color: var(--muted) !important; }
  .sent-note { margin: 8px 0 0; font-size: .85rem; color: var(--muted); }
  .part-note { margin: -4px 0 10px; font-size: .9rem; color: var(--good); font-weight: 600; }
  .part-toggle { display: block; margin: 10px auto 0; background: none; border: 0; padding: 4px; font: inherit; font-size: .9rem; color: var(--terracotta); text-decoration: underline; cursor: pointer; }
  .part-editor { margin-top: 12px; padding: 12px; border: 1px solid var(--line); border-radius: 12px; }
  .part-editor p { margin: 0 0 8px; font-size: .9rem; color: var(--muted); }
  .part-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 6px 0; }
  .part-row label { flex: 1; }
  .part-row input { width: 64px; padding: 8px; font: inherit; text-align: center; border: 1px solid var(--line); border-radius: 8px; }
  .part-row .of { color: var(--muted); font-size: .9rem; min-width: 3.5ch; }
  .part-buttons { display: flex; gap: 8px; margin-top: 10px; }
  .part-buttons button { flex: 1; padding: 10px; font: inherit; font-weight: 600; border-radius: 999px; cursor: pointer; border: 2px solid var(--good); background: white; color: var(--good); }
  .part-buttons .cancel { border-color: var(--line); color: var(--muted); }
  .done { border-color: var(--good); }
  .done p { margin: 0 0 6px; color: var(--good); font-weight: 600; }
  .done .actions { display: flex; gap: 16px; flex-wrap: wrap; font-size: .95rem; }
  .done a { color: var(--terracotta); }
  .linkish { background: none; border: 0; padding: 0; font: inherit; color: var(--terracotta); text-decoration: underline; cursor: pointer; }
</style>
</head>
<body>

<header>
  <h1>Kirana Bakehouse · Orders</h1>
  <button id="refresh" type="button" hidden>Refresh</button>
  <button id="signout" type="button" hidden>Sign out</button>
</header>

<main>

  <form id="signin" class="card signin" hidden>
    <h2>Sign in</h2>
    <p>Bakery staff only.</p>
    <p id="signin-error" class="error" role="alert" hidden></p>
    <input id="password" type="password" autocomplete="current-password" placeholder="Password" required>
    <button class="primary" type="submit">Sign in</button>
  </form>

  <div id="app" hidden>
    <div class="tabs" role="tablist">
      <button id="tab-orders" type="button" role="tab" aria-selected="true">Orders</button>
      <button id="tab-prep" type="button" role="tab" aria-selected="false">Prep</button>
      <button id="tab-drops" type="button" role="tab" aria-selected="false">Drops</button>
    </div>
    <p id="summary" class="summary"></p>
    <p id="load-error" class="error" role="alert" hidden></p>
    <section id="orders-view"></section>
    <section id="prep-view" hidden></section>
    <section id="drops-view" hidden></section>
  </div>

  <p id="loading" class="empty">Loading…</p>

</main>

<script>
(function () {

  var state = { orders: [], delivered: {}, tab: "orders", drops: null, dropsError: "", editing: null, subscribers: null };

  // Where "a new drop is open" and reminder emails come from (they're sent to
  // customers as BCC, so nobody sees anyone else's address).
  var BAKERY_EMAIL = "hellokiranabakehouse@gmail.com";

  var $ = function (id) { return document.getElementById(id); };

  // Builds an element; strings become text (never HTML), so order details
  // typed by customers can't inject anything into the page.
  function el(tag, attrs) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (key) {
      if (key === "class") node.className = attrs[key];
      else if (key === "text") node.textContent = attrs[key];
      else if (key.indexOf("on") === 0) node.addEventListener(key.slice(2), attrs[key]);
      else node.setAttribute(key, attrs[key]);
    });
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined || child === false) continue;
      node.append(child);
    }
    return node;
  }

  function money(cents) {
    return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
  }

  function plural(count, word) {
    return count + " " + word + (count === 1 ? "" : "s");
  }

  function describeItems(items) {
    // Non-breaking spaces keep "2 × House White" on one line.
    return items.map(function (item) {
      return item.quantity + "\u00a0×\u00a0" + item.name + (item.delivered ? " (" + item.delivered + "\u00a0delivered)" : "");
    }).join(", ");
  }

  function api(method, path, body) {
    return fetch("/admin/api/" + path, {
      method: method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: "same-origin"
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (data) {
        if (response.status === 401) { showSignIn(); throw new Error("signed-out"); }
        if (!response.ok) throw new Error(data.error || "Something went wrong.");
        return data;
      });
    });
  }

  /* ---------- Signing in ---------- */

  function showSignIn(message) {
    $("loading").hidden = true;
    $("app").hidden = true;
    $("refresh").hidden = true;
    $("signout").hidden = true;
    $("signin").hidden = false;
    $("signin-error").hidden = !message;
    $("signin-error").textContent = message || "";
    $("password").focus();
  }

  $("signin").addEventListener("submit", function (event) {
    event.preventDefault();
    var button = event.target.querySelector("button");
    button.disabled = true;
    button.textContent = "Signing in…";
    fetch("/admin/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: $("password").value }),
      credentials: "same-origin"
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (data) {
        if (!response.ok) throw new Error(data.error || "Couldn't sign in.");
        $("password").value = "";
        $("signin").hidden = true;
        load();
      });
    }).catch(function (error) {
      showSignIn(error.message);
    }).then(function () {
      button.disabled = false;
      button.textContent = "Sign in";
    });
  });

  $("signout").addEventListener("click", function () {
    api("POST", "logout", {}).catch(function () {}).then(function () { showSignIn(); });
  });

  /* ---------- Loading ---------- */

  function load() {
    $("load-error").hidden = true;
    $("refresh").disabled = true;
    // Drops load alongside orders; if they fail, orders still show.
    var drops = api("GET", "drops").then(function (data) {
      state.drops = data;
      state.dropsError = "";
    }).catch(function (error) {
      if (error.message === "signed-out") throw error;
      state.dropsError = error.message;
    });
    return Promise.all([api("GET", "orders"), drops]).then(function (results) {
      var data = results[0];
      state.orders = data.orders;
      state.emailReady = Boolean(data.emailReady);
      state.contact = data.contact || {};
      state.delivered = {};
      $("loading").hidden = true;
      $("signin").hidden = true;
      $("app").hidden = false;
      $("refresh").hidden = false;
      $("signout").hidden = false;
      render();
    }).catch(function (error) {
      if (error.message === "signed-out") return;
      $("loading").hidden = true;
      $("app").hidden = false;
      $("load-error").hidden = false;
      $("load-error").textContent = "Couldn't load orders: " + error.message;
    }).then(function () {
      $("refresh").disabled = false;
    });
  }

  $("refresh").addEventListener("click", load);

  /* ---------- Tabs ---------- */

  function selectTab(tab) {
    state.tab = tab;
    $("tab-orders").setAttribute("aria-selected", String(tab === "orders"));
    $("tab-prep").setAttribute("aria-selected", String(tab === "prep"));
    $("tab-drops").setAttribute("aria-selected", String(tab === "drops"));
    $("orders-view").hidden = tab !== "orders";
    $("prep-view").hidden = tab !== "prep";
    $("drops-view").hidden = tab !== "drops";
    render();
  }

  $("tab-orders").addEventListener("click", function () { selectTab("orders"); });
  $("tab-prep").addEventListener("click", function () { selectTab("prep"); });
  $("tab-drops").addEventListener("click", function () { selectTab("drops"); });

  /* ---------- Rendering ---------- */

  function openOrders() {
    return state.orders.filter(function (order) { return !state.delivered[order.id]; });
  }

  // Groups orders by delivery date, in date order.
  function byDay(orders) {
    var days = [];
    orders.forEach(function (order) {
      var day = days.length && days[days.length - 1].date === order.deliveryDate ? days[days.length - 1] : null;
      if (!day) {
        day = { date: order.deliveryDate, label: order.deliveryLabel, pastDue: order.pastDue, orders: [] };
        days.push(day);
      }
      day.orders.push(order);
    });
    return days;
  }

  // Loaves still to go out: partly delivered loaves don't count.
  function loafCount(orders) {
    return orders.reduce(function (total, order) { return total + order.loaves - (order.loavesDelivered || 0); }, 0);
  }

  function render() {
    var open = openOrders();
    $("summary").textContent = open.length
      ? plural(open.length, "order") + " to deliver · " + plural(loafCount(open), "loaf").replace("loafs", "loaves")
      : "";
    if (state.tab === "orders") renderOrders();
    else if (state.tab === "prep") renderPrep(open);
    else renderDrops();
  }

  function dayHeading(day, count) {
    return el("div", { class: "day" + (day.pastDue ? " past-due" : "") },
      el("h2", { text: day.label }, day.pastDue ? el("span", { class: "badge", text: "Past date" }) : null),
      el("span", { text: count })
    );
  }

  function renderOrders() {
    var view = $("orders-view");
    view.replaceChildren();

    if (state.orders.length === 0) {
      view.append(el("p", { class: "empty", text: "No orders to deliver. Nice work!" }));
      return;
    }

    byDay(state.orders).forEach(function (day) {
      var open = day.orders.filter(function (order) { return !state.delivered[order.id]; });
      view.append(dayHeading(day, plural(open.length, "order") + " · " + plural(loafCount(open), "loaf").replace("loafs", "loaves")));
      day.orders.forEach(function (order) {
        view.append(state.delivered[order.id] ? deliveredCard(order) : orderCard(order));
      });
    });
  }

  function orderCard(order) {
    var details = el("dl", {},
      order.pickupWhen ? el("dt", { text: "Pickup" }) : null,
      order.pickupWhen ? el("dd", { text: order.pickupWhen }) : null,
      order.address ? el("dt", { text: order.fulfillment === "pickup" ? "Where" : "Address" }) : null,
      order.address ? el("dd", {}, el("a", { href: "https://maps.apple.com/?q=" + encodeURIComponent(order.address), target: "_blank", rel: "noopener", text: order.address })) : null,
      order.phone ? el("dt", { text: "Phone" }) : null,
      order.phone ? el("dd", {}, el("a", { href: "tel:" + order.phone.replace(/[^0-9+]/g, ""), text: order.phone })) : null,
      order.email ? el("dt", { text: "Email" }) : null,
      order.email ? el("dd", { text: order.email }) : null,
      order.notes ? el("dt", { text: "Notes" }) : null,
      order.notes ? el("dd", { text: order.notes }) : null,
      el("dt", { text: order.unpaid ? "Amount due" : "Paid" }),
      el("dd", { text: money(order.totalCents) + (order.tipCents ? " (incl. " + money(order.tipCents) + " tip)" : "") })
    );

    // Two separate actions: emailing doesn't mark the order, and marking
    // doesn't open an email.
    var button = el("button", { class: "deliver", type: "button", text: doneLabel(order) });
    button.addEventListener("click", function () { markDelivered(order, button); });

    return el("article", { class: "card order" },
      el("h3", { text: order.name || "(no name)" },
        order.kind === "invoice" ? el("span", { class: "badge invoice", text: "Invoice" + (order.invoiceNumber ? " " + order.invoiceNumber : "") }) : null,
        order.fulfillment === "pickup" ? el("span", { class: "badge pickup", text: "Pickup" }) : null,
        order.unpaid ? el("span", { class: "badge unpaid", text: "Unpaid" }) : null
      ),
      el("p", { class: "items", text: order.items.length ? describeItems(order.items) : "No loaves listed on this invoice" }),
      order.loavesDelivered ? el("p", { class: "part-note", text: "Partly " + (order.fulfillment === "pickup" ? "picked up" : "delivered") + ": " + order.loavesDelivered + " of " + order.loaves + " loaves" }) : null,
      details,
      el("div", { class: "order-actions" },
        order.email ? emailControl(order, "email") : null,
        button
      ),
      order.emailedAt ? el("p", { class: "sent-note", text: "Email sent " + shortTime(order.emailedAt) }) : null,
      order.items.length ? partControl(order) : null
    );
  }

  // "Part delivered…": how many of each loaf have gone out so far.
  function partControl(order) {
    var wrap = el("div", {});
    var verb = order.fulfillment === "pickup" ? "picked up" : "delivered";
    var toggle = el("button", { class: "part-toggle", type: "button", text: order.loavesDelivered ? "Update what\u2019s been " + verb : "Mark some loaves " + verb });
    wrap.append(toggle);

    toggle.addEventListener("click", function () {
      toggle.hidden = true;
      var inputs = order.items.map(function (item, index) {
        var field = el("input", { type: "number", id: "part-" + order.id + "-" + index, min: "0", max: String(item.quantity), value: String(item.delivered || 0), inputmode: "numeric" });
        return { item: item, field: field };
      });
      var error = el("p", { class: "error", role: "alert", hidden: "hidden" });
      var save = el("button", { type: "button", text: "Save" });
      var cancel = el("button", { class: "cancel", type: "button", text: "Cancel" });
      var editor = el("div", { class: "part-editor" },
        el("p", { text: "How many of each loaf have been " + verb + " so far? The order stays here until every loaf has." }),
        ...inputs.map(function (entry) {
          return el("div", { class: "part-row" },
            el("label", { for: entry.field.id, text: entry.item.name }),
            entry.field,
            el("span", { class: "of", text: "of " + entry.item.quantity })
          );
        }),
        error,
        el("div", { class: "part-buttons" }, cancel, save)
      );
      wrap.append(editor);

      cancel.addEventListener("click", function () { editor.remove(); toggle.hidden = false; });
      save.addEventListener("click", function () {
        var items = {};
        inputs.forEach(function (entry) { items[entry.item.name] = Number(entry.field.value || 0); });
        save.disabled = true;
        save.textContent = "Saving\u2026";
        api("POST", "orders/" + order.id + "/partial", { items: items }).then(function () {
          load();
        }).catch(function (problem) {
          if (problem.message === "signed-out") return;
          save.disabled = false;
          save.textContent = "Save";
          error.textContent = problem.message;
          error.hidden = false;
        });
      });
    });

    return wrap;
  }

  // With email set up, the button sends the email itself; otherwise it opens a draft.
  function emailControl(order, className) {
    if (!state.emailReady) return el("a", { class: className, href: deliveredEmail(order), text: "Email " + firstName(order) });
    var label = (order.emailedAt ? "Email again" : "Email " + firstName(order));
    var button = el("button", { class: className + (order.emailedAt ? " sent" : ""), type: "button", text: label });
    button.addEventListener("click", function () {
      var what = order.fulfillment === "pickup" ? "\u201cready for pickup\u201d" : "\u201cdelivered\u201d";
      if (!window.confirm("Send the " + what + " email to " + order.email + "?")) return;
      button.disabled = true;
      button.textContent = "Sending\u2026";
      api("POST", "orders/" + order.id + "/email", {}).then(function (result) {
        order.emailedAt = result.sentAt;
        render();
      }).catch(function (error) {
        if (error.message === "signed-out") return;
        button.textContent = label;
        alertInCard(button, error.message);
      });
    });
    return button;
  }

  function shortTime(iso) {
    return new Date(iso).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }

  function deliveredCard(order) {
    var undo = el("button", { class: "linkish", type: "button", text: "Undo" });
    undo.addEventListener("click", function () {
      undo.disabled = true;
      api("POST", "orders/" + order.id + "/delivered", { delivered: false }).then(function () {
        delete state.delivered[order.id];
        render();
      }).catch(function (error) {
        if (error.message !== "signed-out") alertInCard(undo, error.message);
      });
    });

    return el("article", { class: "card done" },
      el("p", { text: "✓ " + (order.name || "Order") + (order.fulfillment === "pickup" ? " picked up" : " delivered") }),
      el("div", { class: "actions" },
        order.email ? emailControl(order, "") : null,
        undo
      )
    );
  }

  function alertInCard(node, message) {
    node.disabled = false;
    node.after(el("span", { class: "error", text: " " + message }));
  }

  function renderPrep(open) {
    var view = $("prep-view");
    view.replaceChildren();

    if (open.length === 0) {
      view.append(el("p", { class: "empty", text: "Nothing to bake right now." }));
      return;
    }

    // Loaves still to go out, per loaf, for some orders.
    function countLoaves(orders) {
      var counts = {};
      orders.forEach(function (order) {
        order.items.forEach(function (item) {
          var left = item.quantity - (item.delivered || 0);
          if (left > 0) counts[item.name] = (counts[item.name] || 0) + left;
        });
      });
      return counts;
    }

    function prepList(counts) {
      var names = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a] || a.localeCompare(b); });
      return el("ul", { class: "prep-list" }, ...names.map(function (name) {
        return el("li", {}, el("span", { text: name }), el("span", { class: "count", text: String(counts[name]) }));
      }));
    }

    function loavesText(count) {
      return plural(count, "loaf").replace("loafs", "loaves");
    }

    byDay(open).forEach(function (day) {
      var delivery = day.orders.filter(function (order) { return order.fulfillment !== "pickup"; });
      var pickup = day.orders.filter(function (order) { return order.fulfillment === "pickup"; });
      var both = delivery.length && pickup.length;

      // A part of the day: its badge, how many orders, and its loaves.
      function part(label, badgeClass, orders) {
        return el("div", { class: both ? "prep-part" : "prep-part only" },
          el("h4", {},
            el("span", {}, el("span", { class: "badge " + badgeClass, text: label }), " ", el("span", { class: "muted", text: plural(orders.length, "order") })),
            el("span", { text: loavesText(loafCount(orders)) })
          ),
          prepList(countLoaves(orders))
        );
      }

      view.append(dayHeading(day, plural(day.orders.length, "order")));

      if (!both) {
        view.append(el("div", { class: "card" },
          part(delivery.length ? "Delivery" : "Pickup", delivery.length ? "delivery" : "pickup", day.orders),
          el("div", { class: "prep-total" }, el("span", { text: "Total" }), el("span", { text: loavesText(loafCount(day.orders)) }))
        ));
        return;
      }

      // Both kinds on one day: three columns side by side.
      // What to bake in all, then how it splits for packing.
      view.append(el("div", { class: "card prep-columns" },
        el("div", { class: "prep-part" },
          el("h4", {}, el("span", { text: "To bake" }), el("span", { text: loavesText(loafCount(day.orders)) })),
          prepList(countLoaves(day.orders))
        ),
        part("Delivery", "delivery", delivery),
        part("Pickup", "pickup", pickup)
      ));
    });
  }

  /* ---------- Delivering ---------- */

  // Website orders are people ("Hi Ben"); invoices are often businesses, so
  // they keep the whole name ("Hi Office Catering Co").
  function firstName(order) {
    var name = (order.name || "").trim();
    if (order.kind === "invoice") return name || "there";
    return name.split(/\s+/)[0] || "there";
  }

  function doneLabel(order) {
    return order.fulfillment === "pickup" ? "Mark picked up" : "Mark delivered";
  }

  // A ready-written email for the Mail app: "delivered", or "ready for pickup".
  function deliveredEmail(order) {
    if (order.fulfillment === "pickup") return pickupReadyEmail(order);
    var lines = [
      "Hi " + firstName(order) + ",",
      "",
      "Your Kirana Bakehouse order has just been delivered:",
      ""
    ].concat(order.items.map(function (item) { return item.quantity + " × " + item.name; })).concat([
      "",
      "We hope you enjoy it! If anything isn't right, just reply to this email.",
      "",
      "Thank you,",
      "Kirana Bakehouse"
    ]);
    return "mailto:" + encodeURIComponent(order.email) +
      "?subject=" + encodeURIComponent("Your Kirana Bakehouse order has been delivered") +
      "&body=" + encodeURIComponent(lines.join("\r\n"));
  }

  function markDelivered(order, button) {
    button.disabled = true;
    button.textContent = "Saving…";
    api("POST", "orders/" + order.id + "/delivered", { delivered: true }).then(function () {
      state.delivered[order.id] = true;
      render();
    }).catch(function (error) {
      if (error.message === "signed-out") return;
      button.disabled = false;
      button.textContent = doneLabel(order);
      button.after(el("p", { class: "error", text: error.message }));
    });
  }

  /* ---------- Pickup emails ---------- */

  function mailto(to, bcc, subject, lines) {
    return "mailto:" + encodeURIComponent(to) +
      "?" + (bcc.length ? "bcc=" + encodeURIComponent(bcc.join(",")) + "&" : "") +
      "subject=" + encodeURIComponent(subject) +
      "&body=" + encodeURIComponent(lines.join("\r\n"));
  }

  // "Can't find us?" for pickup drafts (the same line the site's own emails use).
  function findUsLines() {
    var c = state.contact || {};
    if (!c.instagram) return [];
    return ["", "Questions? Just reply to this email, or DM us on Instagram @" + c.instagram + ".",
      c.pickupPhone ? "Can't find us at pickup? Call or text " + c.pickupPhone + "." : "Can't find us at pickup? DM @" + c.instagram + " on Instagram; we check it during pickup."];
  }

  function dropFor(order) {
    return (state.drops && state.drops.drops || []).filter(function (drop) { return String(drop.id) === String(order.dropId); })[0];
  }

  function placeLines(drop, fallbackAddress) {
    if (!drop) return ["Where: " + fallbackAddress];
    return ["Where: " + drop.locationName + ", " + drop.locationAddress].concat(drop.notes ? [drop.notes] : []);
  }

  // One customer: "your order is ready for pickup".
  function pickupReadyEmail(order) {
    var drop = dropFor(order);
    var lines = [
      "Hi " + firstName(order) + ",",
      "",
      "Your Kirana Bakehouse order is ready for pickup:",
      ""
    ].concat(order.items.map(function (item) { return item.quantity + " × " + item.name; })).concat([
      "",
      "When: " + order.pickupWhen
    ]).concat(placeLines(drop, order.address)).concat(findUsLines()).concat([
      "",
      "See you soon!",
      "Kirana Bakehouse"
    ]);
    return mailto(order.email, [], "Your Kirana Bakehouse order is ready for pickup", lines);
  }

  // Everyone on the notify list: a drop is open (or opening).
  function announceEmail(drop) {
    var emails = state.drops.subscriberEmails || [];
    var opening = drop.status === "upcoming"
      ? "Ordering opens " + drop.opensLabel + " and closes " + drop.closesLabel + "."
      : "Ordering is open now and closes " + drop.closesLabel + ".";
    var lines = [
      "Hi friends,",
      "",
      "Our next pickup drop is here!",
      "",
      "When: " + drop.when
    ].concat(placeLines(drop)).concat([
      "",
      opening,
      "Order here: " + state.drops.orderPageUrl,
      "",
      "Loaves are limited, so order early. See you there!",
      "Kirana Bakehouse",
      "",
      "(Don't want these emails? Just reply and let us know.)"
    ]);
    return { href: mailto(BAKERY_EMAIL, emails, "Pickup drop: " + drop.when, lines), count: emails.length };
  }

  // Everyone who ordered from a drop: a reminder before pickup.
  function reminderEmail(drop) {
    var emails = state.orders.filter(function (order) {
      return order.fulfillment === "pickup" && String(order.dropId) === String(drop.id) && order.email && !state.delivered[order.id];
    }).map(function (order) { return order.email; });
    var unique = emails.filter(function (email, index) { return emails.indexOf(email) === index; });
    var lines = [
      "Hi there,",
      "",
      "A friendly reminder that your Kirana Bakehouse order will be ready for pickup:",
      "",
      "When: " + drop.when
    ].concat(placeLines(drop)).concat(findUsLines()).concat([
      "",
      "See you there!",
      "Kirana Bakehouse"
    ]);
    return { href: mailto(BAKERY_EMAIL, unique, "Reminder: your pickup " + drop.when, lines), count: unique.length };
  }

  /* ---------- Drops ---------- */

  var STATUS_TEXT = { open: "Open", upcoming: "Not open yet", sold_out: "Sold out", closed: "Ordering closed", cancelled: "Cancelled" };

  function renderDrops() {
    var view = $("drops-view");
    view.replaceChildren();

    if (state.dropsError) {
      view.append(el("p", { class: "error", text: "Couldn't load drops: " + state.dropsError }));
      return;
    }
    var data = state.drops;
    if (!data) return;

    if (!data.databaseReady) {
      view.append(el("div", { class: "card" },
        el("h3", { text: "Pickup drops aren't set up yet" }),
        el("p", { text: "Create the pickup database once (see the README section \"Pickup drops\"), then deploy both workers. After that you can schedule drops here." })
      ));
      return;
    }

    var newButton = el("button", { class: "primary", type: "button", text: "New drop" });
    newButton.addEventListener("click", function () { state.editing = "new"; render(); });
    var listButton = el("button", { class: "linkish", type: "button", text: state.subscribers ? "Hide list" : "Show list" });
    listButton.addEventListener("click", toggleSubscribers);

    view.append(el("div", { class: "drops-toolbar" },
      newButton,
      el("span", { class: "count", text: plural(data.subscriberCount, "person") .replace("persons", "people") + " on the notify list" }),
      listButton
    ));

    if (data.emailReady) {
      view.append(el("p", { class: "sent-note", text: "Emails go out by themselves: the new-drop email within an hour of ordering opening (and to anyone who joins the list that day), and pickup reminders from 5 pm the day before (and to anyone who orders after that). The buttons send to everyone now." }));
    }

    if (state.subscribers) view.append(subscribersCard());
    if (state.editing === "new") view.append(dropForm(null));

    var upcoming = data.drops.filter(function (drop) { return drop.pickupDate >= data.today; });
    var past = data.drops.filter(function (drop) { return drop.pickupDate < data.today; });

    if (!data.drops.length && state.editing !== "new") {
      view.append(el("p", { class: "empty", text: "No drops yet. Tap New drop to schedule your first pickup." }));
    }
    upcoming.forEach(function (drop) { view.append(state.editing === drop.id ? dropForm(drop) : dropCard(drop)); });
    if (past.length) {
      view.append(el("div", { class: "day" }, el("h2", { text: "Recent drops" })));
      past.slice().reverse().forEach(function (drop) { view.append(state.editing === drop.id ? dropForm(drop) : dropCard(drop)); });
    }
  }

  // With email set up: buttons that send now, and a note of what has gone out.
  function sendButton(drop, kind, count, label) {
    var button = el("button", { type: "button", text: label + " (" + count + ")" });
    button.addEventListener("click", function () {
      var what = kind === "announce" ? "the \u201cnew drop is open\u201d email to " + plural(count, "person").replace("persons", "people") + " on the list" : "a pickup reminder to " + plural(count, "customer");
      if (!window.confirm("Send " + what + "?")) return;
      button.disabled = true;
      button.textContent = "Sending\u2026";
      api("POST", "drops/" + drop.id + "/" + kind, {}).then(reloadDrops).catch(function (error) {
        if (error.message === "signed-out") return;
        button.textContent = label + " (" + count + ")";
        alertInCard(button, error.message);
      });
    });
    return button;
  }

  function sentLine(drop) {
    var parts = [];
    if (drop.announce === false && !drop.announced) parts.push("Opens quietly: no automatic email to the list");
    if (drop.announced) parts.push("New-drop email sent to " + plural(drop.announced.recipients, "person").replace("persons", "people") + " " + shortTime(drop.announced.sentAt));
    if (drop.reminded) parts.push("Reminder sent to " + plural(drop.reminded.recipients, "customer") + " " + shortTime(drop.reminded.sentAt));
    return parts.length ? el("p", { class: "sent-note", text: parts.join(" \u00b7 ") }) : null;
  }

  function dropCard(drop) {
    var announce = announceEmail(drop);
    var remind = reminderEmail(drop);
    var emailReady = state.drops.emailReady;
    var openOrSoon = drop.status === "open" || drop.status === "upcoming";
    var customers = emailReady ? drop.customerCount || 0 : remind.count;
    var share = drop.loafLimit ? Math.min(100, Math.round(drop.booked / drop.loafLimit * 100)) : 0;

    var edit = el("button", { class: "quiet", type: "button", text: "Edit" });
    edit.addEventListener("click", function () { state.editing = drop.id; render(); });
    var cancel = el("button", { class: "quiet", type: "button", text: drop.cancelled ? "Restore drop" : "Cancel drop" });
    cancel.addEventListener("click", function () {
      cancel.disabled = true;
      api("POST", "drops/" + drop.id + "/cancel", { cancelled: !drop.cancelled }).then(reloadDrops).catch(function (error) {
        if (error.message !== "signed-out") alertInCard(cancel, error.message);
      });
    });

    var opensLine = drop.status === "upcoming"
      ? "Ordering opens " + drop.opensLabel + " · closes " + drop.closesLabel
      : "Ordering " + (drop.status === "closed" ? "closed " : "closes ") + drop.closesLabel;

    return el("article", { class: "card drop" },
      el("span", { class: "status " + drop.status, text: STATUS_TEXT[drop.status] || drop.status }),
      el("h3", { text: drop.when }),
      el("p", { class: "where", text: drop.locationName + " · " + drop.locationAddress }),
      el("p", { class: "where", text: opensLine }),
      drop.cancelled ? null : el("div", { class: "meter", "aria-hidden": "true" }, el("span", { style: "width:" + share + "%" })),
      drop.cancelled ? null : el("p", { class: "where", text: drop.booked + " of " + drop.loafLimit + " loaves booked" }),
      el("div", { class: "drop-actions" },
        openOrSoon && announce.count ? (emailReady ? sendButton(drop, "announce", announce.count, drop.announced ? "Email list again" : "Email notify list") : el("a", { href: announce.href, text: "Email notify list (" + announce.count + ")" })) : null,
        !drop.cancelled && customers ? (emailReady ? sendButton(drop, "remind", customers, drop.reminded ? "Remind again" : "Remind customers") : el("a", { href: remind.href, text: "Remind customers (" + remind.count + ")" })) : null,
        edit,
        cancel
      ),
      emailReady ? sentLine(drop) : null
    );
  }

  function field(label, input, wide) {
    return el("div", { class: wide ? "wide" : "" }, el("label", { for: input.id, text: label }), input);
  }

  function input(id, type, value, extra) {
    var attrs = { id: id, type: type, value: value == null ? "" : String(value) };
    Object.keys(extra || {}).forEach(function (key) { attrs[key] = extra[key]; });
    return el("input", attrs);
  }

  function dropForm(drop) {
    var data = state.drops;
    var d = data.defaults;
    var pickupDate = drop ? drop.pickupDate : data.nextSaturday;
    var closesDefault = function (date) {
      var day = new Date(date + "T00:00:00Z");
      do { day.setUTCDate(day.getUTCDate() - 1); } while (day.getUTCDay() !== d.closesWeekday);
      return day.toISOString().slice(0, 10) + "T" + d.closesAt;
    };

    var f = {
      date: input("drop-date", "date", pickupDate, { required: "required" }),
      start: input("drop-start", "time", drop ? drop.windowStart : d.windowStart, { required: "required" }),
      end: input("drop-end", "time", drop ? drop.windowEnd : d.windowEnd, { required: "required" }),
      name: input("drop-name", "text", drop ? drop.locationName : d.locationName, { required: "required", maxlength: "100" }),
      address: input("drop-address", "text", drop ? drop.locationAddress : d.locationAddress, { required: "required", maxlength: "200" }),
      notes: input("drop-notes", "text", drop ? drop.notes : d.notes, { maxlength: "300" }),
      opens: input("drop-opens", "datetime-local", drop ? drop.opensLocal : data.nowLocal, { required: "required" }),
      closes: input("drop-closes", "datetime-local", drop ? drop.closesLocal : closesDefault(pickupDate), { required: "required" }),
      limit: input("drop-limit", "number", drop ? drop.loafLimit : d.loafLimit, { required: "required", min: "1", max: "500", inputmode: "numeric" }),
      announce: input("drop-announce", "checkbox", "", {})
    };
    f.announce.checked = drop ? drop.announce !== false : true;

    // A new drop's closing time follows its date until it's changed by hand.
    var closesTouched = Boolean(drop);
    f.closes.addEventListener("input", function () { closesTouched = true; });
    f.date.addEventListener("change", function () { if (!closesTouched && f.date.value) f.closes.value = closesDefault(f.date.value); });

    var error = el("p", { class: "error wide", role: "alert", hidden: "hidden" });
    var save = el("button", { class: "primary", type: "submit", text: drop ? "Save changes" : "Create drop" });
    var cancel = el("button", { class: "linkish", type: "button", text: "Cancel" });
    cancel.addEventListener("click", function () { state.editing = null; render(); });

    var form = el("form", { class: "card drop-form" },
      el("h3", { class: "wide", text: drop ? "Edit drop" : "New pickup drop" }),
      field("Pickup date", f.date, true),
      field("Pickup from", f.start),
      field("until", f.end),
      field("Location", f.name, true),
      field("Address", f.address, true),
      field("Note for customers (optional)", f.notes, true),
      field("Ordering opens (Pacific time)", f.opens, true),
      field("Ordering closes (Pacific time)", f.closes, true),
      field("Loaves available", f.limit),
      data.emailReady ? el("label", { class: "check", for: "drop-announce" }, f.announce,
        el("span", null, "Email the notify list when ordering opens",
          el("small", { text: "Untick to open this drop quietly. You can still email the list from the drop's card." }))) : null,
      error,
      el("div", { class: "buttons" }, save, cancel)
    );

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      save.disabled = true;
      error.hidden = true;
      var body = {
        pickupDate: f.date.value, windowStart: f.start.value, windowEnd: f.end.value,
        locationName: f.name.value, locationAddress: f.address.value, notes: f.notes.value,
        opensLocal: f.opens.value, closesLocal: f.closes.value, loafLimit: Number(f.limit.value)
      };
      if (data.emailReady) body.announce = f.announce.checked;
      api("POST", drop ? "drops/" + drop.id : "drops", body).then(function () {
        state.editing = null;
        return reloadDrops();
      }).catch(function (problem) {
        if (problem.message === "signed-out") return;
        save.disabled = false;
        error.hidden = false;
        error.textContent = problem.message;
      });
    });

    return form;
  }

  function reloadDrops() {
    return api("GET", "drops").then(function (data) {
      state.drops = data;
      if (state.subscribers) return loadSubscribers();
    }).then(render);
  }

  function loadSubscribers() {
    return api("GET", "subscribers").then(function (data) { state.subscribers = data.subscribers; });
  }

  function toggleSubscribers() {
    if (state.subscribers) {
      state.subscribers = null;
      render();
      return;
    }
    loadSubscribers().then(render).catch(function () {});
  }

  function subscribersCard() {
    var list = state.subscribers;
    var copy = el("button", { class: "quiet", type: "button", text: "Copy all emails" });
    copy.addEventListener("click", function () {
      navigator.clipboard.writeText(list.map(function (subscriber) { return subscriber.email; }).join(", ")).then(function () {
        copy.textContent = "Copied ✓";
      });
    });

    return el("div", { class: "card" },
      el("h3", { text: "Notify list" }),
      list.length ? el("ul", { class: "subscribers" }, ...list.map(function (subscriber) {
        var remove = el("button", { class: "linkish", type: "button", text: "Remove" });
        remove.addEventListener("click", function () {
          remove.disabled = true;
          api("POST", "subscribers/remove", { email: subscriber.email }).then(reloadDrops).catch(function () { remove.disabled = false; });
        });
        return el("li", {}, el("span", { text: subscriber.email + (subscriber.name ? " (" + subscriber.name + ")" : "") }), remove);
      })) : el("p", { class: "empty", text: "Nobody yet. Customers can join from the order page." }),
      list.length ? el("div", { class: "drop-actions" }, copy) : null
    );
  }

  load();

})();
</script>
</body>
</html>`;
