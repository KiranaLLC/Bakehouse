/*
==================================================
MOVED ORDERS

A paid order, or some of its loaves, can be moved
to another delivery day or pickup drop from the
orders page. Stripe keeps the order as it was
paid; each move is a row in the order_moves table
(schema.sql) that takes loaves off the order and
puts them on the new day.

So everywhere loaves are counted:
  - the order itself counts only what's left on it
  - each moved part counts on its new day

Capacity always counts moved parts, even when the
order itself is too old to be in the Stripe list,
because the move is read from the database.

Without the database, or before schema.sql has
been re-run, there are simply no moves.
==================================================
*/

const hasDatabase = env => Boolean(env.DB);

// Moves made in the last this-many days are read (well past any order date).
const MOVES_LOOKBACK_DAYS = 120;

export function parseItems(value) {
  try {
    const parsed = JSON.parse(value || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const items = {};
    for (const [name, count] of Object.entries(parsed)) {
      const quantity = Number(count);
      if (Number.isInteger(quantity) && quantity > 0) items[name] = quantity;
    }
    return items;
  } catch {
    return {};
  }
}

export const sumItems = items => Object.values(items).reduce((total, count) => total + count, 0);

function toMove(row) {
  return {
    id: row.id,
    partId: `mv_${row.id}`,
    orderId: row.order_id,
    items: parseItems(row.items),
    deliveryDate: row.delivery_date || "",
    dropId: row.drop_id === null || row.drop_id === undefined ? "" : String(row.drop_id),
    fromDate: row.from_date || "",
    name: row.name || "",
    email: row.email || "",
    phone: row.phone || "",
    address: row.address || "",
    notes: row.notes || "",
    deliveredItems: parseItems(row.delivered_items),
    deliveredAt: row.delivered_at || "",
    createdAt: row.created_at
  };
}

// Every recent move. [] without the database or the table.
export async function listMoves(env) {
  if (!hasDatabase(env)) return [];
  const since = new Date(Date.now() - MOVES_LOOKBACK_DAYS * 864e5).toISOString();
  try {
    const { results } = await env.DB.prepare("SELECT * FROM order_moves WHERE created_at >= ?1 ORDER BY id").bind(since).all();
    return results.map(toMove).filter(move => sumItems(move.items) > 0);
  } catch (error) {
    if (/no such table/i.test(error.message || "")) return [];
    throw error;
  }
}

export async function getMove(env, partId) {
  const id = Number(String(partId).replace(/^mv_/, ""));
  if (!hasDatabase(env) || !Number.isInteger(id)) return null;
  const row = await env.DB.prepare("SELECT * FROM order_moves WHERE id = ?1").bind(id).first();
  return row ? toMove(row) : null;
}

// Loaves moved off each order: Map orderId → { "House White": 2 }.
export function movedOutByOrder(moves) {
  const out = new Map();
  for (const move of moves) {
    const items = out.get(move.orderId) || {};
    for (const [name, count] of Object.entries(move.items)) items[name] = (items[name] || 0) + count;
    out.set(move.orderId, items);
  }
  return out;
}

/*
  Capacity: takes moved loaves off the orders they
  left, and adds each moved part on the day or drop
  it went to (when that's one being counted).

  bookings: [{ id, loaves, ... }] keyed by `key`
  ("date" for delivery, "dropId" for pickup).
  Moved parts count as already booked, like
  invoices: ahead of any new payment page.
*/
export function applyMoves(bookings, moves, { key, wanted }) {

  const out = movedOutByOrder(moves);
  const adjusted = bookings.map(booking => {
    const moved = out.get(booking.id);
    return moved ? { ...booking, loaves: Math.max(0, booking.loaves - sumItems(moved)) } : booking;
  });

  for (const move of moves) {
    const target = key === "date" ? move.deliveryDate : move.dropId;
    if (!target || !wanted.has(target)) continue;
    adjusted.push({ id: move.partId, [key]: target, created: 0, loaves: sumItems(move.items), status: "moved", invoice: true });
  }

  return adjusted;

}

/*
==================================================
WRITING MOVES (orders page only)
==================================================
*/

export async function insertMove(env, move) {
  const row = await env.DB.prepare(`INSERT INTO order_moves
      (order_id, items, delivery_date, drop_id, from_date, name, email, phone, address, notes, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11) RETURNING id`)
    .bind(move.orderId, JSON.stringify(move.items), move.deliveryDate || "", move.dropId ? Number(move.dropId) : null,
      move.fromDate || "", move.name || "", move.email || "", move.phone || "", move.address || "", move.notes || "",
      new Date().toISOString())
    .first();
  return `mv_${row.id}`;
}

export async function updateMoveItems(env, move, items) {
  if (!sumItems(items)) {
    await env.DB.prepare("DELETE FROM order_moves WHERE id = ?1").bind(move.id).run();
    return;
  }
  await env.DB.prepare("UPDATE order_moves SET items = ?2 WHERE id = ?1").bind(move.id, JSON.stringify(items)).run();
}

export async function updateMoveTarget(env, move, { deliveryDate, dropId, fromDate }) {
  await env.DB.prepare("UPDATE order_moves SET delivery_date = ?2, drop_id = ?3, from_date = ?4 WHERE id = ?1")
    .bind(move.id, deliveryDate || "", dropId ? Number(dropId) : null, fromDate || "").run();
}

export async function setMoveDelivered(env, move, { deliveredItems, deliveredAt }) {
  await env.DB.prepare("UPDATE order_moves SET delivered_items = ?2, delivered_at = ?3 WHERE id = ?1")
    .bind(move.id, sumItems(deliveredItems) ? JSON.stringify(deliveredItems) : "", deliveredAt || "").run();
}
