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

  /* Prep */
  .prep-list { list-style: none; margin: 0; padding: 0; }
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
  .deliver { padding: 12px; font: inherit; font-weight: 600; width: 100%; border-radius: 999px; border: 2px solid var(--good); background: white; color: var(--good); cursor: pointer; }
  .deliver:disabled { opacity: .6; cursor: default; }
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
    </div>
    <p id="summary" class="summary"></p>
    <p id="load-error" class="error" role="alert" hidden></p>
    <section id="orders-view"></section>
    <section id="prep-view" hidden></section>
  </div>

  <p id="loading" class="empty">Loading…</p>

</main>

<script>
(function () {

  var state = { orders: [], delivered: {}, tab: "orders" };

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
    return items.map(function (item) { return item.quantity + "\u00a0×\u00a0" + item.name; }).join(", ");
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
    return api("GET", "orders").then(function (data) {
      state.orders = data.orders;
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
    $("orders-view").hidden = tab !== "orders";
    $("prep-view").hidden = tab !== "prep";
    render();
  }

  $("tab-orders").addEventListener("click", function () { selectTab("orders"); });
  $("tab-prep").addEventListener("click", function () { selectTab("prep"); });

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

  function loafCount(orders) {
    return orders.reduce(function (total, order) { return total + order.loaves; }, 0);
  }

  function render() {
    var open = openOrders();
    $("summary").textContent = open.length
      ? plural(open.length, "order") + " to deliver · " + plural(loafCount(open), "loaf").replace("loafs", "loaves")
      : "";
    if (state.tab === "orders") renderOrders();
    else renderPrep(open);
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
      el("dt", { text: "Address" }),
      el("dd", {}, el("a", { href: "https://maps.apple.com/?q=" + encodeURIComponent(order.address), target: "_blank", rel: "noopener", text: order.address })),
      order.phone ? el("dt", { text: "Phone" }) : null,
      order.phone ? el("dd", {}, el("a", { href: "tel:" + order.phone.replace(/[^0-9+]/g, ""), text: order.phone })) : null,
      order.email ? el("dt", { text: "Email" }) : null,
      order.email ? el("dd", { text: order.email }) : null,
      order.notes ? el("dt", { text: "Notes" }) : null,
      order.notes ? el("dd", { text: order.notes }) : null,
      el("dt", { text: "Paid" }),
      el("dd", { text: money(order.totalCents) + (order.tipCents ? " (incl. " + money(order.tipCents) + " tip)" : "") })
    );

    var button = el("button", { class: "deliver", type: "button", text: "Mark delivered" + (order.email ? " & email " + firstName(order) : "") });
    button.addEventListener("click", function () { markDelivered(order, button); });

    return el("article", { class: "card order" },
      el("h3", { text: order.name || "(no name)" }),
      el("p", { class: "items", text: describeItems(order.items) }),
      details,
      button
    );
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
      el("p", { text: "✓ " + (order.name || "Order") + " delivered" }),
      el("div", { class: "actions" },
        order.email ? el("a", { href: deliveredEmail(order), text: "Email didn't open? Email " + firstName(order) }) : el("span", { text: "No email address on this order." }),
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

    byDay(open).forEach(function (day) {
      var counts = {};
      day.orders.forEach(function (order) {
        order.items.forEach(function (item) { counts[item.name] = (counts[item.name] || 0) + item.quantity; });
      });
      var names = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a] || a.localeCompare(b); });
      var total = loafCount(day.orders);

      view.append(dayHeading(day, plural(day.orders.length, "order")));
      view.append(el("div", { class: "card" },
        el("ul", { class: "prep-list" }, ...names.map(function (name) {
          return el("li", {}, el("span", { text: name }), el("span", { class: "count", text: String(counts[name]) }));
        })),
        el("div", { class: "prep-total" }, el("span", { text: "Total" }), el("span", { text: plural(total, "loaf").replace("loafs", "loaves") }))
      ));
    });
  }

  /* ---------- Delivering ---------- */

  function firstName(order) {
    return (order.name || "").trim().split(/\s+/)[0] || "customer";
  }

  // A ready-written "your order has been delivered" email for the Mail app.
  function deliveredEmail(order) {
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
      if (order.email) window.location.href = deliveredEmail(order);
    }).catch(function (error) {
      if (error.message === "signed-out") return;
      button.disabled = false;
      button.textContent = "Mark delivered";
      button.after(el("p", { class: "error", text: error.message }));
    });
  }

  load();

})();
</script>
</body>
</html>`;
