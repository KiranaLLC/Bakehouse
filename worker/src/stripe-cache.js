/*
==================================================
SHORT-LIVED STRIPE LISTS

The order page asks for loaf counts on every visit
(/api/capacity, /api/drops). Each count lists
recent Checkout Sessions and invoices from Stripe,
so the lists are remembered for a few seconds.

Only those two read-only calls use the remembered
lists. Checkout itself, and the orders page,
always ask Stripe fresh, so a remembered list can
never let an order through that doesn't fit; at
worst a day looks free for a few seconds after it
fills up, and checkout then says so.

Each worker instance keeps its own copy in memory.
==================================================
*/

export const STRIPE_CACHE_SECONDS = 30;

let sessionsCache = null;   // { key, at, since, sessions }
let invoicesCache = null;   // { key, at, since, invoices }

const cacheKey = env => env.STRIPE_SECRET_KEY || "";
const isFresh = (entry, env) => entry && entry.key === cacheKey(env) && Date.now() - entry.at < STRIPE_CACHE_SECONDS * 1000;

// Checkout Sessions created at or after `since` (unix seconds), newest first.
export async function listSessionsSince(env, stripe, since, { fresh = true } = {}) {

  if (!fresh && isFresh(sessionsCache, env) && sessionsCache.since <= since) {
    return sessionsCache.sessions.filter(({ created }) => created >= since);
  }

  const sessions = await listAll(env, stripe, "/checkout/sessions", { created: { gte: since } });
  sessionsCache = { key: cacheKey(env), at: Date.now(), since, sessions };
  return sessions;

}

// Invoices with this status ("paid" or "open") created at or after `since`.
export async function listInvoicesSince(env, stripe, status, since, { fresh = true } = {}) {

  if (!fresh && isFresh(invoicesCache, env) && invoicesCache.since <= since && invoicesCache.invoices[status]) {
    return invoicesCache.invoices[status].filter(({ created }) => created === undefined || created >= since);
  }

  const invoices = await listAll(env, stripe, "/invoices", { status, created: { gte: since } });
  const sameWindow = isFresh(invoicesCache, env) && invoicesCache.since === since;
  invoicesCache = { key: cacheKey(env), at: Date.now(), since, invoices: { ...(sameWindow ? invoicesCache.invoices : {}), [status]: invoices } };
  return invoices;

}

// After a payment page is opened or ended, the next count asks Stripe again.
export function forgetStripeLists() {
  sessionsCache = null;
  invoicesCache = null;
}

async function listAll(env, stripe, path, params) {
  const all = [];
  let startingAfter;
  do {
    const page = await stripe(env, "GET", path, { limit: 100, ...params, starting_after: startingAfter });
    all.push(...page.data);
    startingAfter = page.has_more ? page.data.at(-1).id : undefined;
  } while (startingAfter);
  return all;
}
