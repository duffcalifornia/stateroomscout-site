// Stateroom Scout Room Pass alerts page: license -> sailing -> watches. The browser keeps only the
// license key (localStorage); the sailing and alerts live on the server, filed under the key, and are
// read back on every visit, so a new device only needs the key pasted again.

import {
  FUNCTION_URL, MAX_ROOMS, SUPABASE_KEY, SUPABASE_URL, categoriesFromRooms, cleanRooms, formatDate,
  generateTopic, money, parseMoney, parsePercent, roomProblems, screenFor, undiscountedTotal, validTopic,
} from "./lib.js";

const $ = (id) => document.getElementById(id);
const show = (el, on = true) => (typeof el === "string" ? $(el) : el).classList.toggle("hidden", !on);

// localStorage can throw (blocked site data, some private modes): the page still works, it just
// asks for the key again next visit.
const store = {
  async get(k) {
    try { return JSON.parse(localStorage.getItem(k) ?? "null"); } catch { return null; }
  },
  async set(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* not remembered */ }
  },
  async remove(k) {
    try { localStorage.removeItem(k); } catch { /* nothing stored */ }
  },
};

let license = null;   // { key }
let status = null;    // scout_status from the server
let roomIndex = new Map();
let taxPerGuest = null;

// --- server calls --------------------------------------------------------------------------------

async function api(action, extra = {}) {
  let res;
  try {
    res = await fetch(FUNCTION_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SUPABASE_KEY },
      body: JSON.stringify({ action, license_key: license?.key, ...extra }),
    });
  } catch {
    throw new Error("Couldn't reach Stateroom Scout. Check your connection and try again.");
  }
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(data.error || "Something went wrong. Try again in a minute.");
  return data.status;
}

/** Public reference data, read with the publishable key. Pages past Supabase's 1,000-row cap. */
async function rest(path) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      headers: { apikey: SUPABASE_KEY, Range: `${from}-${from + 999}` },
    });
    if (!res.ok) throw new Error(`Couldn't load cruise data (HTTP ${res.status}).`);
    const page = await res.json();
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
}

const today = () => new Date().toISOString().slice(0, 10);

// --- screens -------------------------------------------------------------------------------------

async function render() {
  show("loading", false);
  const screen = screenFor(license, status);
  for (const s of ["license", "sailing", "departed", "watches"]) show(`screen-${s}`, s === screen);
  const badge = $("sailing-badge");
  if (status?.sailing) {
    badge.textContent = `${status.sailing.ship_name.replace(/^Disney /, "")} · ${formatDate(status.sailing.sail_date)}`;
    show(badge);
  } else show(badge, false);

  if (screen === "sailing") await renderSailing();
  if (screen === "watches") await renderWatches();
}

async function refresh() {
  status = license ? await api("status") : null;
  await render();
}

// 1. License

async function activate() {
  const key = $("license-key").value.trim();
  const err = $("license-error");
  show(err, false);
  if (!key) { err.textContent = "Enter your license key."; show(err); return; }
  $("activate-btn").disabled = true;
  license = { key };
  try {
    status = await api("status");
    await store.set("license", license);
    await render().catch(fail);
  } catch (e) {
    license = null;
    err.textContent = e.message;
    show(err);
  } finally {
    $("activate-btn").disabled = false;
  }
}

async function forgetLicense() {
  await store.remove("license");
  license = null;
  status = null;
  $("license-key").value = "";
  await render();
}

// 2. Sailing

let shipsLoaded = false;
async function renderSailing() {
  const left = status?.resets_left ?? 1;
  $("reset-note").textContent = status && left === 0
    ? "You've used your one sailing change, so this choice is final. Double-check the ship and date before you set it."
    : "Double-check the ship and date: you can change your sailing once later, if you picked the wrong cruise or your plans change.";
  if (shipsLoaded) return;
  const ships = await rest("ships?select=ship_code,name&order=name");
  const sel = $("ship");
  for (const s of ships) sel.add(new Option(s.name, s.ship_code));
  shipsLoaded = true;
}

async function shipChanged() {
  const ship = $("ship").value;
  const sel = $("sailing");
  sel.length = 0;
  sel.disabled = true;
  $("set-sailing-btn").disabled = true;
  if (!ship) { sel.add(new Option("Choose a ship first", "")); return; }
  sel.add(new Option("Loading...", ""));
  // All upcoming sailings, including any Disney has stopped listing (sold out), since those are
  // exactly the ones someone might want a room alert on.
  const sailings = await rest(`sailings?select=voyage_id,sail_date,nights,name&ship_code=eq.${ship}&sail_date=gt.${today()}&order=sail_date`);
  sel.length = 0;
  sel.add(new Option(sailings.length ? "Choose your departure date" : "No upcoming sailings", ""));
  for (const s of sailings) sel.add(new Option(`${formatDate(s.sail_date)} - ${s.name}`, s.voyage_id));
  sel.disabled = !sailings.length;
}

let confirmingSailing = false;
async function setSailing() {
  const err = $("sailing-error");
  show(err, false);
  const btn = $("set-sailing-btn");
  if (!confirmingSailing) {
    confirmingSailing = true;
    btn.textContent = `Yes, ${$("sailing").selectedOptions[0].text.split(" - ")[0]} with ${$("guests").value} guest${$("guests").value === "1" ? "" : "s"}`;
    return;
  }
  btn.disabled = true;
  try {
    status = await api("set_sailing", { voyage_id: $("sailing").value, guests: Number($("guests").value) });
    await render().catch(fail);
  } catch (e) {
    err.textContent = e.message;
    show(err);
  } finally {
    confirmingSailing = false;
    btn.textContent = "Set my sailing";
    btn.disabled = !$("sailing").value;
  }
}

// 3. Watches

let watchesFor = null;   // voyage the form was last filled for
async function renderWatches() {
  const s = status.sailing;
  const guests = status.guests;
  const party = `${guests} guest${guests === 1 ? "" : "s"}`;
  $("sailing-title").textContent = `${s.ship_name}, ${formatDate(s.sail_date)}`;
  $("sailing-meta").textContent = `${s.name} (${status.voyage_id}) · ${party}`;
  for (const el of document.querySelectorAll(".party-text")) el.textContent = `a party of ${guests}`;
  for (const el of document.querySelectorAll(".guests-text")) el.textContent = String(guests);
  $("change-sailing-btn").textContent = status.resets_left > 0 ? "Change" : "";
  show("change-sailing-btn", status.resets_left > 0);
  $("license-ending").textContent = `License ...${license.key.slice(-4)}`;

  if (watchesFor === status.voyage_id) return;
  watchesFor = status.voyage_id;

  const [rooms, taxes] = await Promise.all([
    rest(`rooms?select=room_number,category,name,max_occupancy&ship_code=eq.${s.ship_code}&order=room_number`),
    // Only for the preview line; the database does the real calculation, so this may fail quietly.
    rest(`sailing_taxes?select=tax_per_guest&voyage_id=eq.${status.voyage_id}`).catch(() => []),
  ]);
  roomIndex = new Map(rooms.map((r) => [r.room_number, r]));
  taxPerGuest = taxes[0] ? Number(taxes[0].tax_per_guest) : null;

  const cat = $("category");
  cat.length = 1;
  for (const c of categoriesFromRooms(rooms)) cat.add(new Option(c.label, c.code));

  $("ntfy-topic").value = status.ntfy_topic ?? generateTopic();
  $("room-list").replaceChildren();
  for (const r of status.rooms?.length ? status.rooms : [""]) addRoom(r);

  const p = status.price;
  const finalPayment = s.final_payment_date;
  const closed = finalPayment && finalPayment <= today();
  $("price-closed").textContent = closed
    ? `Final payment for this sailing was due ${formatDate(finalPayment)}. After that Disney won't reprice a booking, so price alerts aren't available.`
    : `Price alerts run until final payment on ${formatDate(finalPayment)}; after that Disney won't reprice a booking.`;
  show("price-closed", true);
  $("price-enabled").disabled = !!closed;
  $("price-enabled").checked = !!p && !closed;
  if (p) {
    cat.value = p.category;
    $("paid-total").value = Number(p.paid_total).toFixed(2);
    const discounted = p.discount_pct !== null && p.discount_pct !== undefined;
    document.querySelector(`input[name="discounted"][value="${discounted ? "yes" : "no"}"]`).checked = true;
    $("discount-pct").value = discounted ? String(Number(p.discount_pct)) : "";
  }
  priceToggled();
}

function addRoom(value = "") {
  if ($("room-list").children.length >= MAX_ROOMS) return;
  const row = $("room-row").content.firstElementChild.cloneNode(true);
  const input = row.querySelector("input");
  input.value = value;
  input.addEventListener("input", () => input.classList.remove("invalid"));
  row.querySelector(".remove-room").addEventListener("click", () => {
    row.remove();
    if (!$("room-list").children.length) addRoom();
  });
  $("room-list").append(row);
  show("add-room-btn", $("room-list").children.length < MAX_ROOMS);
  return input;
}

function priceToggled() {
  show("price-fields", $("price-enabled").checked);
  show("discount-field", document.querySelector('input[name="discounted"]:checked').value === "yes");
  updatePreview();
}

function updatePreview() {
  const el = $("price-preview");
  const paid = parseMoney($("paid-total").value);
  const discounted = document.querySelector('input[name="discounted"]:checked').value === "yes";
  const pct = discounted ? parsePercent($("discount-pct").value) : null;
  if (!paid || Number.isNaN(pct)) { el.textContent = ""; return; }
  if (pct === null) {
    el.textContent = `We'll alert you when this category is on sale for less than ${money(paid)} for ${status.guests}.`;
    return;
  }
  const full = undiscountedTotal(paid, pct, taxPerGuest, status.guests);
  el.textContent = full === null
    ? `We'll work out your price before the ${pct}% discount (taxes aren't discounted) once we've checked this sailing's taxes, and alert you when the price drops below it.`
    : `Before your ${pct}% discount that's ${money(full)} (taxes aren't discounted). We'll alert you when this category is on sale for less.`;
}

async function save() {
  const err = $("save-error");
  const ok = $("save-ok");
  show(err, false);
  show(ok, false);
  const problems = [];

  const topic = $("ntfy-topic").value.trim();
  if (!validTopic(topic)) problems.push("Your ntfy topic needs 12 to 64 letters, numbers, dashes or underscores.");

  const inputs = [...$("room-list").querySelectorAll("input")];
  const rooms = cleanRooms(inputs.map((i) => i.value));
  const roomIssues = roomProblems(rooms, roomIndex, status.guests);
  for (const i of inputs) i.classList.toggle("invalid", roomIssues.some((p) => p.includes(i.value.trim()) && i.value.trim()));
  problems.push(...roomIssues);

  let price = null;
  if ($("price-enabled").checked) {
    const paid = parseMoney($("paid-total").value);
    const discounted = document.querySelector('input[name="discounted"]:checked').value === "yes";
    const pct = discounted ? parsePercent($("discount-pct").value) : null;
    if (!$("category").value) problems.push("Choose the stateroom category you booked.");
    if (!paid) problems.push("Enter the total you paid, including taxes.");
    if (Number.isNaN(pct)) problems.push("The discount should be a percentage between 0 and 100, or left blank.");
    price = { category: $("category").value, paid_total: paid, discount_pct: pct };
  }
  if (!rooms.length && !price) problems.push("Add at least one stateroom, or turn on price drop alerts.");

  if (problems.length) {
    err.textContent = problems.join(" ");
    show(err);
    return;
  }
  $("save-btn").disabled = true;
  try {
    status = await api("save", { ntfy_topic: topic, rooms, price });
    watchesFor = null;
    await render().catch(fail);
    ok.textContent = "Saved. We'll send alerts to your ntfy topic.";
    show(ok);
  } catch (e) {
    err.textContent = e.message;
    show(err);
  } finally {
    $("save-btn").disabled = false;
  }
}

async function testNtfy() {
  const topic = $("ntfy-topic").value.trim();
  const out = $("test-ntfy-result");
  if (!validTopic(topic)) { out.textContent = " Enter a topic of 12+ letters, numbers, dashes or underscores first."; return; }
  out.textContent = " Sending...";
  try {
    const res = await fetch("https://ntfy.sh/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic, title: "Stateroom Scout test", message: "Notifications are working. You'll get stateroom and price alerts here.", tags: ["ship"] }),
    });
    out.textContent = res.ok ? " Sent. Check your phone." : ` ntfy answered HTTP ${res.status}.`;
  } catch {
    out.textContent = " Couldn't reach ntfy.sh.";
  }
}

function askChangeSailing() {
  $("change-sailing-text").textContent =
    "Changing your sailing removes your current alerts, and you can only do it once with this license. After that, the new sailing is final.";
  show("change-sailing-confirm");
}

async function changeSailing() {
  $("change-sailing-yes").disabled = true;
  try {
    status = await api("reset");
    show("change-sailing-confirm", false);
    watchesFor = null;
    await render().catch(fail);
  } catch (e) {
    $("change-sailing-text").textContent = e.message;
  } finally {
    $("change-sailing-yes").disabled = false;
  }
}

// --- wiring --------------------------------------------------------------------------------------

function wire() {
  $("activate-btn").addEventListener("click", activate);
  $("license-key").addEventListener("keydown", (e) => e.key === "Enter" && activate());
  for (const b of document.querySelectorAll(".forget-license-btn")) b.addEventListener("click", forgetLicense);
  $("ship").addEventListener("change", () => shipChanged().catch(fail));
  $("sailing").addEventListener("change", () => {
    confirmingSailing = false;
    $("set-sailing-btn").textContent = "Set my sailing";
    $("set-sailing-btn").disabled = !$("sailing").value;
  });
  $("guests").addEventListener("change", () => { confirmingSailing = false; $("set-sailing-btn").textContent = "Set my sailing"; });
  $("set-sailing-btn").addEventListener("click", setSailing);
  $("add-room-btn").addEventListener("click", () => addRoom()?.focus());
  $("price-enabled").addEventListener("change", priceToggled);
  for (const r of document.querySelectorAll('input[name="discounted"]')) r.addEventListener("change", priceToggled);
  for (const id of ["paid-total", "discount-pct"]) $(id).addEventListener("input", updatePreview);
  $("generate-topic-btn").addEventListener("click", () => { $("ntfy-topic").value = generateTopic(); });
  $("test-ntfy-btn").addEventListener("click", testNtfy);
  $("save-btn").addEventListener("click", save);
  $("change-sailing-btn").addEventListener("click", askChangeSailing);
  $("change-sailing-no").addEventListener("click", () => show("change-sailing-confirm", false));
  $("change-sailing-yes").addEventListener("click", changeSailing);
}

function fail(e) {
  show("loading", false);
  $("fatal").textContent = e.message;
  show("fatal");
}

async function init() {
  wire();
  license = await store.get("license");
  try {
    await refresh();
  } catch (e) {
    // A key that stopped working (refunded) falls back to the license screen with the reason.
    if (license) {
      $("license-key").value = license.key;
      $("license-error").textContent = e.message;
      show("license-error");
      license = null;
      status = null;
      await render();
    } else fail(e);
  }
}

init().catch(fail);
