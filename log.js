import { getStore } from '@netlify/blobs';

/* Shared pooled log for Gull Lake Fishing Bite Conditions.
 *
 * GET  /api/log   -> the whole pooled set
 * POST /api/log   -> merge the sender's entries in, return the merged set
 *
 * The client keeps its own copy in localStorage and pushes its full set on every
 * sync, so this is deliberately a merge rather than a replace. That has a useful
 * property: if two people write in the same instant and one write is lost, the
 * loser still holds its entries locally and re-pushes on the next load. Nothing
 * is permanently lost by a race.
 *
 * Writing is open — no key, no login — because that is what was asked for. The
 * guards below are therefore about limiting the blast radius of junk or accident
 * rather than keeping anyone out: everything is length-capped, range-clamped and
 * whitelisted, and the store is capped so it can't be inflated without bound.
 */

/* Deleting needs a password. Set LOG_PASSWORD in Netlify's environment variables to
   override this; the fallback keeps it working with no setup. Note the repo may be
   public, so treat the fallback as a guard against accidents, not real security. */
const PASSWORD = process.env.LOG_PASSWORD || 'meridian';

const MAX_TRIPS = 5000;
const MAX_READINGS = 5000;
const MAX_BATCH = 500;          // per request
const KEY = 'log';
const MAX_TOMBSTONES = 2000;

const num = (v, min, max, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
};
const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
const SPOTS = ['canal', 'shelf'];

/* Snapshots are model output and vary by version, so rather than whitelisting
   every field we cap the serialized size and keep it opaque. */
function cleanSnapshot(sn) {
  if (!sn || typeof sn !== 'object') return {};
  try {
    const s = JSON.stringify(sn);
    return s.length > 4000 ? { truncated: true } : JSON.parse(s);
  } catch { return {}; }
}

function cleanTrip(t) {
  if (!t || typeof t !== 'object') return null;
  const id = num(t.id, 1, 1e15, 0);
  if (!id) return null;
  return {
    id,
    when: str(t.when, 40),
    spot: SPOTS.includes(t.spot) ? t.spot : 'canal',
    hours: num(t.hours, 0, 48, 0),
    anglers: num(t.anglers, 1, 20, 1),
    walleye: num(t.walleye, 0, 9999, 0),
    pike: num(t.pike, 0, 9999, 0),
    who: str(t.who, 40),
    notes: str(t.notes, 500),
    snapshot: cleanSnapshot(t.snapshot)
  };
}

function cleanReading(r) {
  if (!r || typeof r !== 'object') return null;
  const id = num(r.id, 1, 1e15, 0);
  if (!id) return null;
  const val = num(r.val, -5, 40, null);
  if (val === null) return null;            // a reading without a usable value is not a reading
  return {
    id,
    val,                                     // stored in °C
    spot: r.spot === 'lake' ? 'lake' : 'canal',
    when: str(r.when, 40),
    who: str(r.who, 40)
  };
}

/* Merge by id, oldest trimmed if we ever hit the cap.
   `tomb` is the crucial part. Every client pushes its FULL local set on each sync,
   so without a record of what was deleted, another phone that still holds a deleted
   trip would helpfully re-add it on its next sync and the deletion would undo
   itself. The tombstone list is what makes a delete actually stay dead. */
function mergeById(existing, incoming, clean, cap, tomb) {
  const dead = new Set((tomb || []).map(Number));
  const out = new Map();
  for (const item of existing || []) {
    const c = clean(item);
    if (c && !dead.has(c.id)) out.set(c.id, c);
  }
  let added = 0;
  for (const item of (incoming || []).slice(0, MAX_BATCH)) {
    const c = clean(item);
    if (c && !dead.has(c.id) && !out.has(c.id)) { out.set(c.id, c); added++; }
  }
  let arr = [...out.values()].sort((a, b) => a.id - b.id);
  if (arr.length > cap) arr = arr.slice(arr.length - cap);
  return { arr, added };
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type',
  'cache-control': 'no-store'
};

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  let store;
  try {
    store = getStore({ name: 'gull-lake-log', consistency: 'strong' });
  } catch (e) {
    return json({ error: 'store unavailable' }, 500);
  }

  let current = { trips: [], readings: [], deleted: { trips: [], readings: [] } };
  try {
    const got = await store.get(KEY, { type: 'json' });
    if (got) current = { deleted: { trips: [], readings: [] }, ...got };
    if (!current.deleted) current.deleted = { trips: [], readings: [] };
  } catch { /* first run, or transient read failure — treat as empty */ }

  if (req.method === 'POST') {
    let body;
    try { body = await req.json(); }
    catch { return json({ error: 'bad JSON' }, 400); }

    /* Deletions are authenticated; ordinary syncing is not. */
    const wantsDelete = body.delete &&
      ((body.delete.trips || []).length || (body.delete.readings || []).length);
    if (wantsDelete && body.password !== PASSWORD) {
      return json({ error: 'wrong password' }, 403);
    }

    const ids = a => [...new Set((a || []).map(Number).filter(Boolean))];
    const deleted = {
      trips: ids([...(current.deleted.trips || []), ...((body.delete || {}).trips || [])]).slice(-MAX_TOMBSTONES),
      readings: ids([...(current.deleted.readings || []), ...((body.delete || {}).readings || [])]).slice(-MAX_TOMBSTONES)
    };

    const t = mergeById(current.trips, body.trips, cleanTrip, MAX_TRIPS, deleted.trips);
    const r = mergeById(current.readings, body.readings, cleanReading, MAX_READINGS, deleted.readings);
    current = { trips: t.arr, readings: r.arr, deleted, updated: new Date().toISOString() };

    try { await store.setJSON(KEY, current); }
    catch (e) { return json({ error: 'write failed', ...current }, 500); }

    return json({ ...current, addedTrips: t.added, addedReadings: r.added, deletedOk: !!wantsDelete });
  }

  return json(current);
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, 'content-type': 'application/json' }
  });
}

export const config = { path: '/api/log' };
