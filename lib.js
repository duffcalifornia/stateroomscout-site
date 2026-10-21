// Stateroom Scout: pure helpers shared by the alerts page and the tests (no DOM here).

export const SUPABASE_URL = "https://chcdkipybohdncuvsrbk.supabase.co";
// Publishable key: public by design. It can only read the public tables (ships, rooms, sailings,
// taxes); licenses and watches go through the scout Edge Function.
export const SUPABASE_KEY = "sb_publishable_2ZtHeRWzJ_T6breZc4U8Tg_WPhBQiC1";
export const FUNCTION_URL = `${SUPABASE_URL}/functions/v1/scout`;

export const MAX_ROOMS = 20;

/** Disney prints categories without the leading zero: 04B -> 4B, 11C -> 11C. */
export const categoryLabel = (code) => String(code).replace(/^0(?=\d)/, "");

/** "Sep 10, 2027" from "2027-09-10", without the local time zone shifting the day. */
export function formatDate(iso) {
  return new Date(`${String(iso).slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
  });
}

export const money = (n) =>
  `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** One option per category on the ship, Disney's order (concierge first), with its most common name. */
export function categoriesFromRooms(rooms) {
  const byCode = new Map();
  for (const r of rooms) {
    if (!r.category) continue;
    const names = byCode.get(r.category) ?? new Map();
    if (r.name) names.set(r.name, (names.get(r.name) ?? 0) + 1);
    byCode.set(r.category, names);
  }
  return [...byCode.entries()]
    .map(([code, names]) => {
      const name = [...names.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
      return { code, label: `${categoryLabel(code)}${name ? ` - ${name}` : ""}` };
    })
    .sort((a, b) => a.code.localeCompare(b.code, "en", { numeric: true }));
}

/** Trimmed, de-duplicated room numbers from the text boxes, blanks dropped, in the order typed. */
export function cleanRooms(values) {
  const out = [];
  for (const v of values) {
    const r = String(v ?? "").trim();
    if (r && !out.includes(r)) out.push(r);
  }
  return out;
}

/** Problems with the typed rooms, one sentence each; empty when they're all fine. */
export function roomProblems(rooms, roomIndex, guests) {
  const problems = [];
  for (const r of rooms) {
    const room = roomIndex.get(r);
    if (!/^\d{3,5}$/.test(r)) problems.push(`"${r}" doesn't look like a stateroom number.`);
    else if (!room) problems.push(`Room ${r} isn't on this ship.`);
    else if (room.max_occupancy && guests && room.max_occupancy < guests) {
      problems.push(`Room ${r} sleeps at most ${room.max_occupancy}, and your party is ${guests}.`);
    }
  }
  if (rooms.length > MAX_ROOMS) problems.push(`You can watch up to ${MAX_ROOMS} staterooms.`);
  return problems;
}

/** Reads a price typed as "$3,033.12" or "3033.12"; null if it isn't a positive amount. */
export function parseMoney(text) {
  const n = Number(String(text ?? "").replace(/[$,\s]/g, ""));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

/** Reads "10", "10%" or blank (null). Returns NaN for anything else so the form can complain. */
export function parsePercent(text) {
  const t = String(text ?? "").replace(/[%\s]/g, "");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 && n < 100 ? n : NaN;
}

/**
 * The price before a fare discount, as the database computes it (midship_mouse migration 030):
 * taxes aren't discounted, so they come off before dividing and go back on after. Shown in the
 * popup as a preview; null when the sailing's taxes aren't known yet.
 */
export function undiscountedTotal(paid, pct, taxPerGuest, guests) {
  if (pct === null || pct === undefined) return paid;
  if (taxPerGuest === null || taxPerGuest === undefined) return null;
  const taxes = taxPerGuest * guests;
  return Math.round(((paid - taxes) / (1 - pct / 100) + taxes) * 100) / 100;
}

/** A hard-to-guess ntfy topic: anyone who knows a topic can read its messages. */
export function generateTopic(random = (n) => crypto.getRandomValues(new Uint8Array(n))) {
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  return `scout-${[...random(16)].map((b) => alphabet[b % alphabet.length]).join("")}`;
}

export const validTopic = (t) => /^[A-Za-z0-9_-]{12,64}$/.test(String(t ?? "").trim());

/** Which screen the popup shows for a stored license and the server's status for it. */
export function screenFor(license, status) {
  if (!license?.key) return "license";
  if (status?.departed) return "departed";
  if (!status?.voyage_id) return "sailing";
  return "watches";
}

// --- Room Passes saved in this browser ----------------------------------------------------------
// A list of { key, label, topic }: one per Room Pass (people book several cruises at once). label
// and topic are cached from the server so the switcher can name each pass without asking Gumroad
// about every key on every visit.

/** The saved list, upgrading the single { key } that earlier versions of the page stored. */
export function loadPasses(saved, legacy) {
  const list = Array.isArray(saved) ? saved.filter((p) => p && typeof p.key === "string" && p.key) : [];
  if (legacy?.key && !list.some((p) => sameKey(p.key, legacy.key))) list.push({ key: legacy.key, label: null, topic: null });
  return list;
}

/** Keys are compared the way the server reads them: no spaces, upper case. */
export const sameKey = (a, b) => normalizeKey(a) === normalizeKey(b);
export const normalizeKey = (k) => String(k ?? "").replace(/\s+/g, "").toUpperCase();

/** Adds a key unless it's already there (then nothing changes). */
export function addPass(list, key) {
  return list.some((p) => sameKey(p.key, key)) ? list : [...list, { key: normalizeKey(key), label: null, topic: null }];
}

export const removePass = (list, key) => list.filter((p) => !sameKey(p.key, key));

/** Caches what the server said about a pass: its label and ntfy topic. */
export function updatePass(list, key, status) {
  return list.map((p) => (sameKey(p.key, key) ? { ...p, label: passLabel(key, status), topic: status?.ntfy_topic ?? p.topic ?? null } : p));
}

/** "Destiny · Jan 21, 2027", or what state the pass is in when it has no sailing. */
export function passLabel(key, status) {
  const ending = `...${normalizeKey(key).slice(-4)}`;
  if (status?.sailing) return `${status.sailing.ship_name.replace(/^Disney /, "")} · ${formatDate(status.sailing.sail_date)}`;
  if (status?.departed) return `Departed sailing (${ending})`;
  return `New Room Pass (${ending})`;
}

/** The ntfy topic to suggest for a pass without one: the one already used by another pass, if any. */
export function suggestedTopic(list, key) {
  return list.find((p) => !sameKey(p.key, key) && p.topic)?.topic ?? null;
}
