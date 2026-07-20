import { getStore } from '@netlify/blobs';

/* Shared pooled log for Gull Lake Fishing Bite Conditions.
*
* GET /api/log -> the whole pooled set
* POST /api/log -> merge the sender's entries in, return the merged set
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

const MAX_TRIPS = 5000;
const MAX_READINGS = 5000;
const MAX_BATCH = 500; // per request
const KEY = 'log';

const num = (v, min, max, d) => {
const n = Number(v);
return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
};
const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
const SPOTS = ['canal', 'shelf'];
