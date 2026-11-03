/*
==================================================
KIRANA BAKEHOUSE ORDERS WORKER

The bakery's private orders page (see admin.js),
deployed as its own worker, "kirana-orders", so
the whole thing can sit behind Cloudflare Access
(only the bakery's email gets in) while the
checkout worker stays public for customers.

  /        → redirects to /admin
  /admin   → the orders page and its API

Deploy with:
  npx wrangler deploy --config wrangler.orders.toml
==================================================
*/

import { handleAdmin } from "./admin.js";
import { stripe } from "./stripe.js";

export default {

  async fetch(request, env) {

    const url = new URL(request.url);

    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
      return handleAdmin(request, env, { stripe });
    }

    if (url.pathname === "/" && request.method === "GET") {
      return Response.redirect(`${url.origin}/admin`, 302);
    }

    return new Response("Not found.", { status: 404, headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" } });

  }

};
