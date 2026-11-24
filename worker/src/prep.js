/*
==================================================
PREP TRACKER (orders page, Prep tab)

Like the prep spreadsheet: for each bake day, one
row per batch of loaves, with each step filled in
as it's done (autolyse, knead time, stretch &
folds, bulk ferment, shaped, baked).

A day's rows start from that day's orders the
first time it's opened. After that they're yours
to edit: split a loaf into batches, add extras,
delete rows. Saved in the pickup database
(prep_rows and prep_days in schema.sql).
==================================================
*/

// Steps that are '', 'Yes' or 'No'.
export const PREP_STATUS_FIELDS = ["autolyse", "bulk_ferment", "shaped", "baked"];
// Steps written in by hand.
export const PREP_TEXT_FIELDS = ["knead_time", "stretch_folds"];

const STATUSES = ["", "Yes", "No"];
const MAX_TEXT = 40;
const MAX_NAME = 60;
const MAX_QTY = 99;

export class PrepError extends Error {}

const isDate = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));

function toRow(row) {
  return {
    id: row.id,
    date: row.bake_date,
    position: row.position,
    name: row.name,
    qty: row.qty,
    autolyse: row.autolyse,
    knead_time: row.knead_time,
    stretch_folds: row.stretch_folds,
    bulk_ferment: row.bulk_ferment,
    shaped: row.shaped,
    baked: row.baked
  };
}

function needDatabase(env) {
  if (!env.DB) throw new PrepError("The prep tracker needs the pickup database. See README, \"Pickup drops\".");
}

// Rows and started days from `since` on: { "2026-11-25": { seeded, rows } }.
export async function listPrep(env, since) {
  if (!env.DB) return { ready: false, days: {} };
  if (!isDate(since)) throw new PrepError("Bad date.");
  try {
    const [{ results: rows }, { results: seeded }] = await env.DB.batch([
      env.DB.prepare("SELECT * FROM prep_rows WHERE bake_date >= ?1 ORDER BY bake_date, position, id").bind(since),
      env.DB.prepare("SELECT bake_date FROM prep_days WHERE bake_date >= ?1").bind(since)
    ]);
    const days = {};
    const day = date => (days[date] = days[date] || { seeded: false, rows: [] });
    for (const { bake_date: date } of seeded) day(date).seeded = true;
    for (const row of rows) day(row.bake_date).rows.push(toRow(row));
    return { ready: true, days };
  } catch (error) {
    if (/no such table/i.test(error.message || "")) return { ready: false, days: {} };
    throw error;
  }
}

function cleanName(value) {
  const name = String(value ?? "").trim().slice(0, MAX_NAME);
  return name;
}

function cleanQty(value) {
  const qty = Number(value);
  if (!Number.isInteger(qty) || qty < 0 || qty > MAX_QTY) throw new PrepError(`Quantity: enter a number from 0 to ${MAX_QTY}.`);
  return qty;
}

/*
  Starts a day from its orders: [{ name, qty }].
  Only the first time; after that the day's rows
  are left as they are (returns the rows either way).
*/
export async function seedPrepDay(env, date, items) {
  needDatabase(env);
  if (!isDate(date)) throw new PrepError("Bad date.");
  const now = new Date().toISOString();
  const started = await env.DB.prepare("INSERT OR IGNORE INTO prep_days (bake_date, seeded_at) VALUES (?1, ?2)").bind(date, now).run();
  if (started.meta?.changes) {
    const list = (Array.isArray(items) ? items : []).slice(0, 50)
      .map(item => ({ name: cleanName(item?.name), qty: cleanQty(item?.qty) }))
      .filter(item => item.name && item.qty > 0);
    if (list.length) {
      await env.DB.batch(list.map((item, index) => env.DB.prepare(
        "INSERT INTO prep_rows (bake_date, position, name, qty, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)"
      ).bind(date, index, item.name, item.qty, now)));
    }
  }
  return (await listPrep(env, date)).days[date] || { seeded: true, rows: [] };
}

export async function addPrepRow(env, date, input) {
  needDatabase(env);
  if (!isDate(date)) throw new PrepError("Bad date.");
  const name = cleanName(input?.name);
  const qty = cleanQty(input?.qty ?? 1);
  const now = new Date().toISOString();
  // A row added by hand also counts as starting the day.
  await env.DB.prepare("INSERT OR IGNORE INTO prep_days (bake_date, seeded_at) VALUES (?1, ?2)").bind(date, now).run();
  // After a given row (a split batch goes right under its loaf), else at the end.
  const after = Number.isInteger(input?.after) ? await env.DB.prepare("SELECT position FROM prep_rows WHERE id = ?1 AND bake_date = ?2").bind(input.after, date).first() : null;
  let position;
  if (after) {
    position = after.position + 1;
    await env.DB.prepare("UPDATE prep_rows SET position = position + 1 WHERE bake_date = ?1 AND position >= ?2").bind(date, position).run();
  } else {
    const last = await env.DB.prepare("SELECT MAX(position) AS position FROM prep_rows WHERE bake_date = ?1").bind(date).first();
    position = (last?.position ?? -1) + 1;
  }
  const row = await env.DB.prepare(
    "INSERT INTO prep_rows (bake_date, position, name, qty, updated_at) VALUES (?1, ?2, ?3, ?4, ?5) RETURNING *"
  ).bind(date, position, name, qty, now).first();
  return toRow(row);
}

// Changes one or more cells of a row.
export async function updatePrepRow(env, id, input) {
  needDatabase(env);
  const sets = [];
  const values = [];
  for (const [field, value] of Object.entries(input || {})) {
    if (PREP_STATUS_FIELDS.includes(field)) {
      if (!STATUSES.includes(value)) throw new PrepError("Pick Yes, No or blank.");
      sets.push(field); values.push(value);
    } else if (PREP_TEXT_FIELDS.includes(field)) {
      sets.push(field); values.push(String(value ?? "").trim().slice(0, MAX_TEXT));
    } else if (field === "name") {
      sets.push(field); values.push(cleanName(value));
    } else if (field === "qty") {
      sets.push(field); values.push(cleanQty(value));
    }
  }
  if (!sets.length) throw new PrepError("Nothing to change.");
  const assignments = sets.map((field, index) => `${field} = ?${index + 2}`).join(", ");
  const row = await env.DB.prepare(`UPDATE prep_rows SET ${assignments}, updated_at = ?${sets.length + 2} WHERE id = ?1 RETURNING *`)
    .bind(Number(id), ...values, new Date().toISOString()).first();
  if (!row) throw new PrepError("That row wasn't found. Refresh the page.");
  return toRow(row);
}

export async function deletePrepRow(env, id) {
  needDatabase(env);
  await env.DB.prepare("DELETE FROM prep_rows WHERE id = ?1").bind(Number(id)).run();
}
