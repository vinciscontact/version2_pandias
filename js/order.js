// Hotel Pandia's v2: ordering at the table.
// Talks to the ordering backend (Supabase) with plain fetch() calls to its database functions,
// instead of loading the whole Supabase library: much lighter for a guest on mobile data.
// Every rule that matters (prices, who may order, table PINs, the "Seated ✓" hold) is enforced by
// the database itself; this file only shows things and asks.

// The project URL and its PUBLISHABLE key: meant to be public (they are in every visitor's browser).
// All data is protected by row-level security and checked database functions.
const SB = "https://vlbnicfcjddaehyjindr.supabase.co";
const KEY = "sb_publishable_X4LBIcYNnHLTqfgByI8dWA_OW2JPggP";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const rupee = (n) => "₹" + Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 });
const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};

// ---------------------------------------------------------------- backend
const headers = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
async function rpc(name, args = {}) {
  const r = await fetch(`${SB}/rest/v1/rpc/${name}`, { method: "POST", headers, body: JSON.stringify(args) });
  const body = r.status === 204 ? null : await r.json().catch(() => null);
  if (!r.ok) throw new Error(body?.message || `http_${r.status}`);
  return body;
}
async function get(path) {
  const r = await fetch(`${SB}/rest/v1/${path}`, { headers });
  if (!r.ok) throw new Error(`http_${r.status}`);
  return r.json();
}
const MESSAGES = {
  not_now: "One of your dishes isn't served at this hour. Please remove it.",
  not_today: "One of your dishes isn't served today. Please remove it.",
  bad_pickup: "Pick a pickup time at least 15 minutes from now.",
  closed_then: "The branch is closed at that time. Pick another time.",
  too_many_takeaways: "You already have two takeaway orders waiting. Call the branch to add to one.",
  too_big: "That's a big order! Please call the branch to place it.",
  name_required: "Please add your name.",
  unknown_branch: "That branch isn't taking orders right now.",
  unknown_table: "We couldn't find this table. Please scan the QR again.",
  too_fast: "Hold on a second, your last order is still being sent.",
  too_many_orders: "This table has a lot of orders. Please ask your server.",
  bad_qty: "Up to 30 of one dish per order, please.",
  phone_required: "Please add your mobile number so we can bring your order to you.",
  bad_phone: "That mobile number doesn't look right. Use a 10-digit Indian number.",
  guests_required: "Please tell us how many of you there are.",
  bad_guests: "Please pick how many of you there are.",
  already_cooking: "The kitchen has already started on this one. Please ask your server.",
  unknown_order: "We couldn't find that order.",
};
function friendly(err) {
  const m = String(err?.message || err);
  for (const [k, v] of Object.entries(MESSAGES)) if (m.includes(k)) return v;
  if (m.startsWith("unavailable:")) return `${m.split(":")[1]} just sold out. Please remove it and try again.`;
  if (m === "Failed to fetch" || m.includes("NetworkError")) return "No connection. Check your internet and try again.";
  return "Something went wrong. Please try again.";
}

// ---------------------------------------------------------------- page state
const branches = JSON.parse(document.body.dataset.branches);
const params = new URLSearchParams(location.search);
const branch = branches.find((b) => b.id === params.get("branch"));
// takeaway pre-order: order.html?takeaway=1&branch=… (no table; pickup slot; pay at the counter)
const takeaway = params.get("takeaway") === "1";
const table = takeaway ? "TA" : (params.get("table") || "").slice(0, 6);
const VIEWS = $$("[data-view]");
const show = (v) => {
  VIEWS.forEach((el) => (el.hidden = el.dataset.view !== v));
  $("[data-cartbar]").hidden = v !== "menu" || !cartCount();
  $$(".obar__call").forEach((b) => (b.hidden = !branch || v === "pick" || takeaway));
  scrollTo({ top: 0 });
};
const toast = (msg) => {
  const t = $("[data-toast]");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove("show"), 2800);
};

// ---------------------------------------------------------------- no table: pick one
if (!branch || !table) {
  show("pick");
  if (params.get("branch")) $("select[name=branch]").value = params.get("branch");
  if (takeaway) {
    $("[data-pick-kicker]").textContent = "Pre-order takeaway";
    $("[data-pick-title]").textContent = "Order ahead, pick it up hot";
    $("[data-pick-sub]").textContent = "Choose your branch. Pay at the counter when you collect.";
    $("[data-pick-table]").remove();
  }
  $("[data-pick-form]").addEventListener("submit", (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    location.search = takeaway ? `?takeaway=1&branch=${f.get("branch")}` : `?branch=${f.get("branch")}&table=${encodeURIComponent(String(f.get("table")).trim())}`;
  });
}

// ---------------------------------------------------------------- everything below needs a table
const K = branch ? `${branch.id}-${table}` : "";
const VISIT = `pd-visit-${K}`; // this phone's key to the table's open bill
const CART = `pd-cart-${K}`;
const GUESTS = `pd-guests-${K}`; // count picked before the first order
const SENDKEY = `pd-send-${K}`; // one-time key of a send that hasn't been confirmed yet
let token = branch ? store.get(VISIT) : null;
let cart = {};
let guest = null; // { phone, name } remembered on this phone
let visit = null;
let parcelCharge = 0;
try { cart = JSON.parse(store.get(CART) || "{}"); } catch {}
try { guest = JSON.parse(store.get("pd-guest") || "null"); } catch {}
const saveCart = () => store.set(CART, JSON.stringify(cart));
const cartLines = () => Object.values(cart);
const cartCount = () => cartLines().reduce((n, l) => n + l.qty, 0);
const lineTotal = (l) => l.qty * (l.price + (l.parcel ? parcelCharge : 0));


async function start() {
  wireMenu();
  wireCart();
  wireVisit();
  // live menu: prices, sold-out flags, dishes the owner added or removed, and the packing charge
  // (the printed menu stays if this fails)
  Promise.all([
    get("menu_items?select=id,name,category,price,available,diet,tamil,description,sort,deleted_at&order=sort,name"),
    get("menu_categories?select=id,name&order=sort"),
    get(`branches?select=parcel_charge&id=eq.${branch.id}`),
    rpc("menu_prices", { p_branch: branch.id }).catch(() => null),
  ])
    .then(([items, cats, br, now]) => {
      parcelCharge = Number(br?.[0]?.parcel_charge || 0);
      syncMenu(items, cats);
      if (now) applyNow(now);
      saveCart();
      paintCart();
    })
    .catch(() => {});

  if (token) {
    try {
      const v = await rpc("get_table_status", { p_token: token });
      if (v && v.status !== "closed") return openVisit(v);
    } catch {
      return openVisit(null); // offline for a moment: polling catches up
    }
    store.set(VISIT, null);
    token = null;
  }
  if (takeaway) {
    show("menu");
    return paintCart();
  }
  freshTable();
}

// a phone without a key to this table: ask the guest count (or the PIN, if the table is taken)
function freshTable() {
  show(store.get(GUESTS) ? "menu" : "count");
  paintCart();
  rpc("table_state", { p_branch: branch.id, p_table: table })
    .then((r) => r?.busy && !token && show("join"))
    .catch(() => {});
}

// ---------------------------------------------------------------- guest count
$$("[data-count]").forEach((b) =>
  b.addEventListener("click", () => {
    if (b.dataset.count === "more") {
      $("[data-count-more]").hidden = false;
      $("[data-count-more] input").focus();
      return;
    }
    setCount(Number(b.dataset.count));
  })
);
$("[data-count-more]").addEventListener("submit", (e) => {
  e.preventDefault();
  const n = Number(new FormData(e.target).get("n"));
  if (n >= 1 && n <= 60) setCount(n);
});
function setCount(n) {
  store.set(GUESTS, String(n));
  show("menu");
  paintCart();
}

// ---------------------------------------------------------------- PIN join
$("[data-join-form]").addEventListener("submit", async (e) => {
  e.preventDefault();
  const pin = String(new FormData(e.target).get("pin") || "").trim();
  const err = $("[data-join-err]");
  err.hidden = true;
  try {
    const r = await rpc("join_table", { p_branch: branch.id, p_table: table, p_pin: pin });
    if (r.ok) {
      token = r.token;
      store.set(VISIT, token);
      openVisit();
      return toast("You're in. Orders from this phone go on the table's bill.");
    }
    if (r.error === "no_open_bill") return freshTable();
    err.textContent = r.error === "locked"
      ? `Too many tries. Ask your server, or try again in ${Math.ceil((r.retryInSeconds || 900) / 60)} min.`
      : `That PIN doesn't match.${r.triesLeft ? ` ${r.triesLeft} ${r.triesLeft === 1 ? "try" : "tries"} left.` : ""}`;
    err.hidden = false;
  } catch (x) {
    toast(friendly(x));
  }
});

// ---------------------------------------------------------------- live menu
const NO_SPICE = new Set(["desserts"]);
const DIET = { veg: "Vegetarian", egg: "Contains egg", nonveg: "Non-vegetarian" };
let wireStep = () => {};
const baseOf = (id) => id.split("--")[0];
function stepHTML(r, label, spice) {
  return `<div class="step" data-step="${esc(r.id)}" data-name="${esc(r.name)}" data-price="${Number(r.price)}" data-spice="${spice ? 1 : 0}">${
    label ? `<span class="step__label">${esc(label)}</span>` : ""
  }<b class="step__price">${rupee(r.price)}</b><button type="button" class="step__add" data-add aria-label="Add ${esc(r.name)}">Add</button><span class="step__ctrl" hidden><button type="button" data-dec aria-label="One less ${esc(r.name)}">−</button><output data-qty>0</output><button type="button" data-inc aria-label="One more ${esc(r.name)}">+</button></span></div>`;
}
// this branch, right now: branch price, offers (old price struck out), serving hours, photos, pairings
const PHOTOS = `${SB}/storage/v1/object/public/menu-photos/`;
let pairsOf = {};
const hhmm = (t) => {
  const [h, m] = t.split(":").map(Number);
  return `${h % 12 || 12}${m ? ":" + String(m).padStart(2, "0") : ""} ${h < 12 ? "am" : "pm"}`;
};
function applyNow(now) {
  const by = Object.fromEntries(now.map((n) => [n.id, n]));
  pairsOf = {};
  for (const n of now) if (n.pairs?.length) pairsOf[baseOf(n.id)] = n.pairs;
  for (const s of $$("[data-step]")) {
    const n = by[s.dataset.step];
    if (!n) continue;
    s.dataset.price = String(n.price);
    $(".step__price", s).innerHTML = (Number(n.list) > Number(n.price) ? `<s>${rupee(n.list)}</s> ` : "") + rupee(n.price);
    const add = $("[data-add]", s);
    s.classList.toggle("is-out", !n.available);
    add.textContent = n.available ? "Add" : n.reason === "not_now" && n.from ? `From ${hhmm(n.from)}` : n.reason === "not_today" ? "Not today" : "Sold out";
    add.disabled = !n.available;
    if (!n.available) delete cart[s.dataset.step];
    else if (cart[s.dataset.step]) cart[s.dataset.step].price = Number(n.price);
  }
  for (const d of $$(".odish")) {
    const steps = $$("[data-step]", d).map((s) => by[s.dataset.step]).filter(Boolean);
    if (!steps.length) continue;
    const offer = steps.map((n) => n.offer).find(Boolean);
    const tag = $(".odish__offer", d);
    if (offer && !tag) $(".odish__top", d).insertAdjacentHTML("beforeend", `<span class="odish__offer">${esc(offer)}</span>`);
    else if (!offer && tag) tag.remove();
    const photo = steps[0].photo;
    if (photo && !$(".odish__img", d)) d.insertAdjacentHTML("afterbegin", `<img class="odish__img" src="${PHOTOS}${esc(photo)}-400.webp" alt="" loading="lazy" decoding="async" width="400" height="300">`);
  }
}
/** after adding a dish: "goes well with …" (the owner's pairings), at most two, gone in a few seconds */
function suggestPair(key) {
  const pairs = pairsOf[baseOf(key)];
  if (!pairs?.length) return;
  const steps = $$("[data-step]");
  const opts = pairs.map((b) => steps.find((s) => baseOf(s.dataset.step) === b && !s.classList.contains("is-out") && !cart[s.dataset.step])).filter(Boolean).slice(0, 2);
  if (!opts.length) return;
  let bar = $("[data-pairbar]");
  if (!bar) {
    document.body.insertAdjacentHTML("beforeend", '<div class="pairbar" data-pairbar role="status" hidden></div>');
    bar = $("[data-pairbar]");
  }
  bar.innerHTML = `<span>Goes well with</span>${opts.map((s) => `<button type="button" data-pair="${esc(s.dataset.step)}">${esc(s.dataset.name)} · ${rupee(s.dataset.price)} <b>+</b></button>`).join("")}<button type="button" class="pairbar__x" data-pair-x aria-label="No thanks">×</button>`;
  bar.hidden = false;
  clearTimeout(bar._t);
  bar._t = setTimeout(() => (bar.hidden = true), 7000);
}
document.addEventListener("click", (e) => {
  const p = e.target.closest("[data-pair]");
  if (p) {
    $(`[data-step="${CSS.escape(p.dataset.pair)}"] [data-add]`)?.click();
    $("[data-pairbar]").hidden = true;
  }
  if (e.target.closest("[data-pair-x]")) $("[data-pairbar]").hidden = true;
});

/** bring the printed menu up to date with the database */
function syncMenu(items, cats) {
  const live = Object.fromEntries(items.map((r) => [r.id, r]));
  const onPage = new Set($$("[data-step]").map((s) => s.dataset.step));
  for (const s of $$("[data-step]")) {
    const o = live[s.dataset.step];
    if (!o) continue;
    if (o.deleted_at) {
      // removed by the owner: gone from the page (and the cart)
      delete cart[s.dataset.step];
      const dish = s.closest(".odish");
      s.remove();
      if (dish && !$("[data-step]", dish)) dish.remove();
      continue;
    }
    s.dataset.price = String(o.price);
    $(".step__price", s).textContent = rupee(o.price);
    const add = $("[data-add]", s);
    s.classList.toggle("is-out", !o.available);
    add.textContent = o.available ? "Add" : "Sold out";
    add.disabled = !o.available;
    if (!o.available) delete cart[s.dataset.step];
    else if (cart[s.dataset.step]) cart[s.dataset.step].price = Number(o.price);
  }
  // names and descriptions as the owner last saved them
  for (const li of $$(".odish")) {
    const r = live[$("[data-step]", li)?.dataset.step];
    if (!r) continue;
    const name = r.id.includes("--") ? r.name.replace(/\s\((?:[^()]|\([^()]*\))*\)$/, "") : r.name;
    $("h3", li).innerHTML = esc(name) + (r.tamil ? ` <span lang="ta">${esc(r.tamil)}</span>` : "");
    let p = $(":scope > p", li);
    if (r.description) {
      if (!p) $(".odish__buy", li).before((p = document.createElement("p")));
      p.textContent = r.description;
    } else p?.remove();
    li.dataset.q = `${name} ${r.tamil || ""} ${r.description || ""}`.toLowerCase();
  }
  // dishes added after the page was printed
  const fresh = {};
  for (const r of items) if (!r.deleted_at && !onPage.has(r.id)) (fresh[baseOf(r.id)] ||= []).push(r);
  const catName = Object.fromEntries((cats || []).map((c) => [c.id, c.name]));
  for (const rows of Object.values(fresh)) {
    const r0 = rows[0];
    const multi = r0.id.includes("--");
    const name = multi ? r0.name.replace(/\s\((?:[^()]|\([^()]*\))*\)$/, "") : r0.name;
    const spice = !NO_SPICE.has(r0.category);
    let sec = $(`#c-${CSS.escape(r0.category)}`);
    if (!sec) {
      sec = document.createElement("section");
      sec.className = "mcat";
      sec.id = `c-${r0.category}`;
      sec.dataset.cat = "";
      sec.innerHTML = `<h2>${esc(catName[r0.category] || r0.category)}</h2><ul class="odishes"></ul>`;
      $("[data-empty]").before(sec);
    }
    const li = document.createElement("li");
    li.className = "odish";
    li.dataset.diet = r0.diet || "nonveg";
    li.dataset.q = `${name} ${r0.tamil || ""} ${r0.description || ""}`.toLowerCase();
    li.innerHTML =
      `<div class="odish__top"><i class="diet diet--${esc(li.dataset.diet)}" role="img" aria-label="${DIET[li.dataset.diet] || ""}"></i><h3>${esc(name)}${r0.tamil ? ` <span lang="ta">${esc(r0.tamil)}</span>` : ""}</h3></div>` +
      (r0.description ? `<p>${esc(r0.description)}</p>` : "") +
      `<div class="odish__buy">${rows.map((r) => stepHTML(r, multi ? r.name.match(/\(((?:[^()]|\([^()]*\))*)\)$/)?.[1] || "" : "", spice)).join("")}</div>`;
    $(".odishes", sec).append(li);
    for (const s of $$("[data-step]", li)) {
      wireStep(s);
      const o = live[s.dataset.step];
      if (!o.available) {
        s.classList.add("is-out");
        $("[data-add]", s).textContent = "Sold out";
        $("[data-add]", s).disabled = true;
      }
    }
  }
  // sections left empty by removals
  for (const c of $$("[data-cat]")) if (!$(".odish", c)) c.remove();
}

// ---------------------------------------------------------------- menu
function wireMenu() {
  const steps = $$("[data-step]");
  const change = (s, d) => {
    const key = s.dataset.step;
    if (d > 0 && s.classList.contains("is-out")) return;
    const line = cart[key] || { key, name: s.dataset.name, price: Number(s.dataset.price), qty: 0, spice: "", note: "", parcel: false, canSpice: s.dataset.spice === "1" };
    line.qty = Math.max(0, Math.min(30, line.qty + d));
    if (line.qty) cart[key] = line;
    else delete cart[key];
    saveCart();
    paintCart();
    if (d > 0) navigator.vibrate?.(8);
    if (d > 0 && line.qty === 1) suggestPair(key);
  };
  wireStep = (s) => {
    $("[data-add]", s).addEventListener("click", () => change(s, 1));
    $("[data-inc]", s).addEventListener("click", () => change(s, 1));
    $("[data-dec]", s).addEventListener("click", () => change(s, -1));
  };
  steps.forEach(wireStep);
  // search + veg only
  const q = $("[data-search]");
  const veg = $("[data-veg]");
  const filter = () => {
    const term = q.value.trim().toLowerCase();
    let shown = 0;
    for (const d of $$(".odish")) {
      const ok = (!term || d.dataset.q.includes(term)) && (!veg.checked || d.dataset.diet === "veg");
      d.hidden = !ok;
      shown += ok;
    }
    $$("[data-cat]").forEach((c) => (c.hidden = !$(".odish:not([hidden])", c)));
    $("[data-empty]").hidden = shown > 0;
  };
  q.addEventListener("input", filter);
  veg.addEventListener("change", filter);
}

// ---------------------------------------------------------------- cart
const sheet = $("[data-sheet]");
function paintCart() {
  if (takeaway) for (const l of cartLines()) l.parcel = true;
  for (const s of $$("[data-step]")) {
    const qty = cart[s.dataset.step]?.qty || 0;
    $("[data-add]", s).hidden = qty > 0;
    $(".step__ctrl", s).hidden = qty === 0;
    $("[data-qty]", s).textContent = String(qty);
  }
  const count = cartCount();
  const total = cartLines().reduce((t, l) => t + lineTotal(l), 0);
  $("[data-cartbar]").hidden = count === 0 || $("[data-view=menu]").hidden;
  $("[data-count]").textContent = String(count);
  $("[data-total]").textContent = rupee(total);
  $("[data-sheet-total]").textContent = rupee(total);
  const ul = $("[data-lines]");
  ul.innerHTML = cartLines()
    .map(
      (l) => `<li data-line="${esc(l.key)}">
        <div class="ln__top"><span class="ln__name">${esc(l.name)}</span>
          <span class="ln__qty"><button type="button" data-l="-1" aria-label="One less">−</button><output>${l.qty}</output><button type="button" data-l="1" aria-label="One more">+</button></span>
          <b class="ln__price">${rupee(lineTotal(l))}</b></div>
        <div class="ln__opts">
          ${l.canSpice ? `<span class="seg" role="group" aria-label="Spice level">${["mild", "medium", "spicy"].map((v) => `<button type="button" data-spice="${v}" aria-pressed="${l.spice === v}">${v}</button>`).join("")}</span>` : ""}
          ${takeaway ? (parcelCharge ? `<span class="ln__parcel">Packed (+${rupee(parcelCharge)} each)</span>` : "") : `<label class="ln__parcel"><input type="checkbox" data-parcel ${l.parcel ? "checked" : ""}> Parcel${parcelCharge ? ` (+${rupee(parcelCharge)} each)` : ""}</label>`}
        </div>
        <input class="ln__note" data-lnote maxlength="120" placeholder="Note for this dish (no onion, allergy…)" value="${esc(l.note)}">
      </li>`
    )
    .join("");
  if (!count && sheet.open) sheet.close();
}
function wireCart() {
  $("[data-open-cart]").addEventListener("click", () => {
    paintGuest();
    if (takeaway) fillPickup();
    sheet.showModal();
  });
  $("[data-close]").addEventListener("click", () => sheet.close());
  sheet.addEventListener("click", (e) => e.target === sheet && sheet.close());
  // one listener for every line's controls
  $("[data-lines]").addEventListener("click", (e) => {
    const li = e.target.closest("[data-line]");
    if (!li) return;
    const l = cart[li.dataset.line];
    const b = e.target.closest("button");
    if (b?.dataset.l) {
      l.qty = Math.max(0, Math.min(30, l.qty + Number(b.dataset.l)));
      if (!l.qty) delete cart[l.key];
    } else if (b?.dataset.spice) l.spice = l.spice === b.dataset.spice ? "" : b.dataset.spice;
    else return;
    saveCart();
    paintCart();
  });
  $("[data-lines]").addEventListener("change", (e) => {
    const li = e.target.closest("[data-line]");
    if (!li || !e.target.matches("[data-parcel]")) return;
    cart[li.dataset.line].parcel = e.target.checked;
    saveCart();
    paintCart();
  });
  $("[data-lines]").addEventListener("input", (e) => {
    const li = e.target.closest("[data-line]");
    if (!li || !e.target.matches("[data-lnote]")) return;
    cart[li.dataset.line].note = e.target.value;
    saveCart();
  });
  $("[data-guest-change]").addEventListener("click", () => paintGuest(true));
  $("[data-send]").addEventListener("click", send);
}

// guest name + number: needed unless this table's bill already has one
const tenDigits = (raw) => {
  let d = String(raw).replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("91")) d = d.slice(2);
  else if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? d : null;
};
const pretty = (d) => `${d.slice(0, 5)} ${d.slice(5)}`;
function paintGuest(forceForm = false) {
  const needed = takeaway || !(token && visit?.hasGuest);
  const box = $("[data-guest]");
  const known = $("[data-guest-known]");
  $("[data-guest-err]").hidden = true;
  if (guest && !forceForm) {
    box.hidden = true;
    known.hidden = false;
    $("[data-guest-who]").textContent = (guest.name ? guest.name + " · " : "") + pretty(guest.phone);
  } else {
    known.hidden = true;
    box.hidden = !needed && !forceForm;
    if (guest) {
      $("[name=gname]").value = guest.name || "";
      $("[name=gphone]").value = pretty(guest.phone);
    }
  }
}
function readGuest() {
  if ($("[data-guest]").hidden) return guest;
  const err = $("[data-guest-err]");
  const name = $("[name=gname]").value.trim();
  const phone = tenDigits($("[name=gphone]").value);
  if (name.length < 2) return (err.textContent = "Please add your name, so we bring your order to the right person."), (err.hidden = false), $("[name=gname]").focus(), "invalid";
  if (!phone) return (err.textContent = "Please add a 10-digit mobile number, e.g. 98765 43210."), (err.hidden = false), $("[name=gphone]").focus(), "invalid";
  return { phone, name };
}

/** pickup slots: every 15 minutes from ~20 minutes ahead, for the next 8 hours */
function fillPickup() {
  const sel = $("[data-pickup]");
  if (!sel) return;
  const keep = sel.value;
  const start = new Date(Math.ceil((Date.now() + 20 * 60e3) / (15 * 60e3)) * 15 * 60e3);
  const opts = [];
  for (let i = 0; i < 32; i++) {
    const t = new Date(start.getTime() + i * 15 * 60e3);
    const inMin = Math.round((t - Date.now()) / 60e3);
    opts.push(`<option value="${t.toISOString()}">${t.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" })} · in ${inMin < 60 ? inMin + " min" : Math.floor(inMin / 60) + " h " + (inMin % 60 ? (inMin % 60) + " min" : "")}</option>`);
  }
  sel.innerHTML = opts.join("");
  if (keep && [...sel.options].some((o) => o.value === keep)) sel.value = keep;
}

let sending = false;
async function send() {
  if (takeaway) return sendTakeaway();
  const lines = cartLines();
  if (!lines.length || sending) return;
  const g = readGuest();
  if (g === "invalid") return;
  const btn = $("[data-send]");
  sending = true;
  btn.disabled = true;
  btn.textContent = "Sending…";
  // the same key is reused if this send is retried (after a network drop or a reload), so the
  // kitchen never gets the order twice
  let key = store.get(SENDKEY);
  if (!key) store.set(SENDKEY, (key = crypto.randomUUID()));
  try {
    const r = await rpc("place_order", {
      p_branch: branch.id,
      p_table: table,
      p_lines: lines.map((l) => ({ id: l.key, qty: l.qty, spice: l.spice || null, note: l.note.trim() || null, parcel: l.parcel })),
      p_note: $("[data-note]").value.trim() || null,
      p_token: token,
      p_phone: g?.phone ?? null,
      p_name: g?.name ?? null,
      p_guests: token ? null : Number(store.get(GUESTS)) || null,
      p_key: key,
    });
    store.set(SENDKEY, null);
    token = r.sessionToken;
    store.set(VISIT, token);
    store.set(GUESTS, null);
    if (g) store.set("pd-guest", JSON.stringify((guest = g)));
    cart = {};
    saveCart();
    $("[data-note]").value = "";
    sheet.close();
    openVisit();
    toast(r.held ? `Order ${r.code} is in. A server will confirm your table.` : `Order ${r.code} is with the kitchen`);
  } catch (x) {
    const m = String(x?.message);
    if (/phone_required|bad_phone/.test(m)) {
      store.set(SENDKEY, null);
      paintGuest(true);
      $("[data-guest-err]").textContent = friendly(x);
      $("[data-guest-err]").hidden = false;
    } else if (m.includes("table_busy")) {
      store.set(SENDKEY, null);
      sheet.close();
      store.set(VISIT, null);
      token = null;
      show("join");
    } else if (m.includes("guests_required")) {
      store.set(SENDKEY, null);
      sheet.close();
      show("count");
    } else {
      // network trouble: keep the key so tapping again can't double the order
      if (!/Failed to fetch|NetworkError/.test(m)) store.set(SENDKEY, null);
      toast(friendly(x));
    }
  } finally {
    sending = false;
    btn.disabled = false;
    btn.textContent = "Send to kitchen";
  }
}

async function sendTakeaway() {
  const lines = cartLines();
  if (!lines.length || sending) return;
  let g = readGuest();
  if (g === "invalid") return;
  if (!g?.name) {
    paintGuest(true);
    $("[data-guest-err]").textContent = "Please add your name and mobile, so we can hand the order to you.";
    $("[data-guest-err]").hidden = false;
    return;
  }
  const btn = $("[data-send]");
  sending = true;
  btn.disabled = true;
  btn.textContent = "Placing…";
  let key = store.get(SENDKEY);
  if (!key) store.set(SENDKEY, (key = crypto.randomUUID()));
  try {
    const r = await rpc("place_takeaway", {
      p_branch: branch.id,
      p_lines: lines.map((l) => ({ id: l.key, qty: l.qty, spice: l.spice || null, note: l.note.trim() || null, parcel: true })),
      p_name: g.name,
      p_phone: g.phone,
      p_pickup: $("[data-pickup]").value,
      p_note: $("[data-note]").value.trim() || null,
      p_key: key,
    });
    store.set(SENDKEY, null);
    token = r.sessionToken;
    store.set(VISIT, token);
    store.set("pd-guest", JSON.stringify((guest = g)));
    cart = {};
    saveCart();
    $("[data-note]").value = "";
    sheet.close();
    openVisit();
    toast(`Order ${r.code} placed. The restaurant will accept it shortly.`);
  } catch (x) {
    const m = String(x?.message);
    if (!/Failed to fetch|NetworkError/.test(m)) store.set(SENDKEY, null);
    if (/phone_required|bad_phone|name_required/.test(m)) {
      paintGuest(true);
      $("[data-guest-err]").textContent = friendly(x);
      $("[data-guest-err]").hidden = false;
    } else {
      if (/bad_pickup/.test(m)) fillPickup();
      toast(friendly(x));
    }
  } finally {
    sending = false;
    btn.disabled = false;
    btn.textContent = "Place takeaway order";
  }
}

// ---------------------------------------------------------------- the visit
let poll;
const STAGE = { held: "Waiting", received: "Received", preparing: "Cooking", ready: "On its way", served: "Served", cancelled: "Cancelled" };
const ORDER = ["held", "received", "preparing", "ready", "served"];
function wireVisit() {
  $("[data-order-more]").addEventListener("click", () => {
    clearInterval(poll);
    show("menu");
    paintCart();
  });
  $$("[data-waiter]").forEach((b) =>
    b.addEventListener("click", async () => {
      try {
        await rpc("call_waiter", { p_branch: branch.id, p_table: table });
        toast(`A server is on the way to table ${table}`);
      } catch (x) {
        toast(friendly(x));
      }
    })
  );
  const guests = async (d) => {
    if (!visit) return;
    const n = Math.max(1, Math.min(60, (visit.guests || 1) + d));
    try {
      await rpc("set_guests", { p_token: token, p_guests: n });
      visit.guests = n;
      paintGuests();
    } catch (x) {
      toast(friendly(x));
    }
  };
  $("[data-guests-dec]").addEventListener("click", () => guests(-1));
  $("[data-guests-inc]").addEventListener("click", () => guests(1));
  $("[data-orders]").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-cancel]");
    if (!b || !confirm("Cancel this order?")) return;
    b.disabled = true;
    try {
      await rpc("cancel_my_order", { p_token: token, p_order: b.dataset.cancel });
      toast("Order cancelled");
      refresh();
    } catch (x) {
      toast(friendly(x));
      b.disabled = false;
    }
  });
  $("[data-ask-bill]").addEventListener("click", async (e) => {
    e.currentTarget.disabled = true;
    try {
      const v = await rpc("request_bill", { p_token: token });
      if (v) paintVisit(v);
      toast("We've told your server. The bill is on its way.");
    } catch (x) {
      toast(friendly(x));
    } finally {
      e.currentTarget.disabled = false;
    }
  });
  wireFeedback();
}
function paintGuests() {
  const n = visit?.guests || Number(store.get(GUESTS)) || 1;
  $("[data-guests]").textContent = String(n);
  $("[data-guests-word]").textContent = n === 1 ? "guest" : "guests";
  $("[data-guests-dec]").disabled = n <= 1;
}
async function refresh() {
  if (!token) return;
  try {
    const v = await rpc("get_table_status", { p_token: token });
    if (!v) {
      store.set(VISIT, null);
      token = null;
      clearInterval(poll);
      return freshTable();
    }
    paintVisit(v);
    if (v.status === "closed") clearInterval(poll);
  } catch {}
}
function openVisit(v) {
  show("status");
  if (v) paintVisit(v);
  else refresh();
  clearInterval(poll);
  poll = setInterval(refresh, 5000);
}
let fbJustSent = false;
function paintVisit(v) {
  visit = v;
  paintGuests();
  const live = v.orders.filter((o) => o.status !== "cancelled");
  const pending = live.filter((o) => o.status !== "served");
  const slowest = pending.reduce((a, o) => (!a || ORDER.indexOf(o.status) < ORDER.indexOf(a.status) ? o : a), null);
  const billing = v.status !== "open";
  const paid = v.status === "paid" || v.status === "closed";
  if (v.kind === "takeaway") return paintTakeaway(v, live);
  $("[data-status-title]").textContent = paid
    ? "All paid. Thank you!"
    : billing
      ? "Your bill is on its way"
      : !slowest
        ? "Enjoy your meal"
        : { held: "Your order is in", received: "The kitchen has it", preparing: "Cooking now", ready: "Coming to your table", served: "Enjoy your meal" }[slowest.status];
  $("[data-held]").hidden = !(live.some((o) => o.status === "held") && !v.seated);
  $("[data-orders]").innerHTML = v.orders
    .map(
      (o) => `<div class="vorder ${o.status === "cancelled" ? "is-x" : ""}">
        <div class="vorder__head"><b>#${esc(o.code)}</b><span>${new Date(o.createdAt).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" })}</span>
          <em class="chip chip--${o.status}">${STAGE[o.status]}</em>
          ${o.canCancel ? `<button type="button" class="vorder__x" data-cancel="${o.id}">Cancel</button>` : ""}</div>
        <ul>${(o.items || [])
          .map(
            (i) => `<li class="${i.unavailable ? "is-out" : ""}"><span>${i.qty} × ${esc(i.name)}${[i.spice, i.parcel ? "parcel" : "", i.note].filter(Boolean).map((t) => ` <small>${esc(t)}</small>`).join("")}${
              i.unavailable ? ` <small class="out">Sorry, this ran out. Not charged.</small>` : ""
            }</span><span>${rupee(i.unavailable ? 0 : i.qty * i.price + Number(i.parcelFee || 0))}</span></li>`
          )
          .join("")}</ul></div>`
    )
    .join("");
  $("[data-b-sub]").textContent = rupee(v.subtotal);
  $("[data-b-disc-row]").hidden = !Number(v.discount);
  $("[data-b-disc]").textContent = "−" + rupee(v.discount);
  $("[data-b-rate]").textContent = String(Number(v.taxPercent));
  $("[data-b-tax]").textContent = rupee(v.tax);
  $("[data-b-total]").textContent = rupee(v.total);
  const st = $("[data-bill-state]");
  st.textContent = paid ? "Paid" : billing ? "Bill requested" : "Open";
  st.dataset.state = paid ? "paid" : billing ? "asked" : "open";
  $("[data-ask-bill]").hidden = billing;
  $("[data-bill-note]").textContent = paid
    ? `Paid ${rupee(v.paid)}. See you again soon!`
    : billing
      ? "Your server is bringing the bill. Pay at the counter or to them: cash, card or UPI."
      : "Order as much as you like. Pay once at the end, at the counter: cash, card or UPI.";
  $("[data-order-more]").hidden = v.status === "closed";
  const live2 = v.status === "open" || v.status === "bill_requested";
  $("[data-pin-row]").hidden = !(v.pin && live2);
  if (v.pin) $("[data-pin]").textContent = v.pin;
  // feedback as the meal wraps up
  if (billing || (live.length && !pending.length)) $("[data-fb]").hidden = false;
  if (v.feedbackGiven && !fbJustSent && !$("[data-fb-form]").hidden) showThanks(null, 5);
}

function paintTakeaway(v, live) {
  const st = live.some((o) => o.status === "held") ? "held" : live.some((o) => ["received", "preparing"].includes(o.status)) ? (live.some((o) => o.status === "preparing") ? "preparing" : "received") : live.some((o) => o.status === "ready") ? "ready" : live.length ? "served" : "cancelled";
  const at = new Date(v.pickupAt).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
  $("[data-status-title]").textContent = { held: "Order placed", received: "Accepted", preparing: "Cooking now", ready: "Ready for pickup", served: "Collected. Enjoy!", cancelled: "Order cancelled" }[st];
  const held = $("[data-held]");
  held.hidden = false;
  held.innerHTML = st === "held"
    ? `<b>Waiting for ${esc(v.branchName)} to accept your order.</b> Pickup at ${at}.${v.branchPhone ? ` Questions? Call <a href="tel:${esc(v.branchPhone)}">${esc(v.branchPhone)}</a>.` : ""}`
    : st === "served" || st === "cancelled"
      ? `${esc(v.branchName)} · picked up${v.status === "closed" ? "" : ""}.`
      : `<b>Pickup at ${at}</b> at ${esc(v.branchName)}. Show order <b>#${esc(live[0]?.code || "")}</b> at the counter.`;
  $(".guests").hidden = true;
  $("[data-pin-row]").hidden = true;
  $("[data-order-more]").hidden = true;
  $$("[data-waiter]").forEach((b) => (b.hidden = true));
  $("[data-fb]").hidden = true;
  $("[data-orders]").innerHTML = v.orders
    .map(
      (o) => `<div class="vorder ${o.status === "cancelled" ? "is-x" : ""}"><div class="vorder__head"><b>#${esc(o.code)}</b><em class="chip chip--${o.status}">${{ held: "Waiting", received: "Accepted", preparing: "Cooking", ready: "Ready", served: "Collected", cancelled: "Cancelled" }[o.status]}</em>
        ${o.canCancel ? `<button type="button" class="vorder__x" data-cancel="${o.id}">Cancel</button>` : ""}</div>
        <ul>${(o.items || []).map((i) => `<li class="${i.unavailable ? "is-out" : ""}"><span>${i.qty} × ${esc(i.name)}${i.unavailable ? ` <small class="out">Sorry, this ran out. Not charged.</small>` : ""}</span><span>${rupee(i.unavailable ? 0 : i.qty * i.price + Number(i.parcelFee || 0))}</span></li>`).join("")}</ul></div>`
    )
    .join("");
  $("[data-b-sub]").textContent = rupee(v.subtotal);
  $("[data-b-disc-row]").hidden = !Number(v.discount);
  $("[data-b-disc]").textContent = "−" + rupee(v.discount);
  $("[data-b-rate]").textContent = String(Number(v.taxPercent));
  $("[data-b-tax]").textContent = rupee(v.tax);
  $("[data-b-total]").textContent = rupee(v.total);
  const paid = v.status === "paid" || v.status === "closed";
  const bs = $("[data-bill-state]");
  bs.textContent = paid ? "Paid" : "Pay on pickup";
  bs.dataset.state = paid ? "paid" : "open";
  $("[data-ask-bill]").hidden = true;
  $("[data-bill-note]").textContent = paid ? `Paid ${rupee(v.paid)}. Thank you!` : "Pay at the counter when you pick up: cash, card or UPI.";
  if (v.status === "closed" || st === "cancelled") clearInterval(poll);
}

// ---------------------------------------------------------------- feedback → Google
let rating = 0;
function wireFeedback() {
  const stars = $$("[data-stars] button");
  stars.forEach((b) =>
    b.addEventListener("click", () => {
      rating = Number(b.dataset.v);
      stars.forEach((x, i) => (x.classList.toggle("on", i < rating), x.setAttribute("aria-checked", String(i === rating - 1))));
      $("[data-fb-more]").hidden = false;
    })
  );
  $("[data-fb-form]").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!rating) return;
    try {
      const r = await rpc("submit_feedback", {
        p_token: token,
        p_rating: rating,
        p_comment: String(new FormData(e.target).get("comment") || "").trim() || null,
        p_name: guest?.name ?? null,
        p_phone: guest?.phone ?? null,
      });
      fbJustSent = true;
      showThanks(r?.googleReviewUrl, rating);
    } catch (x) {
      toast(friendly(x));
    }
  });
  $("[data-google]").addEventListener("click", () => token && rpc("mark_google_clicked", { p_token: token }).catch(() => {}));
}
function showThanks(url, r) {
  $("[data-fb-form]").hidden = true;
  $("[data-fb-thanks]").hidden = false;
  const low = r <= 3;
  $("[data-fb-title]").textContent = low ? "Thank you for telling us" : "Thank you!";
  $("[data-fb-msg]").textContent = low
    ? "Your note has gone straight to the manager, and we'll make it right. You can also review us on Google if you like."
    : "Enjoyed it? A Google review helps other biryani lovers find us. It takes 30 seconds.";
  // every guest gets the same Google button, whatever they rated (Google's rules: no review gating)
  $("[data-google]").href = url || visit?.googleReviewUrl || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent("Hotel Pandia's " + branch.name + " Chennai")}`;
}

// ---------------------------------------------------------------- go (last, once everything above exists)
if (branch && table) {
  $("[data-table-label]").textContent = takeaway ? "Takeaway" : `Table ${table}`;
  if (takeaway) {
    document.title = "Pre-order takeaway | Hotel Pandia's";
    $("[data-pickup-row]").hidden = false;
    $("[data-send]").textContent = "Place takeaway order";
    $(".sheet__fine").textContent = "Taxes as applicable. Pay at the counter when you pick up.";
  }
  $("[data-branch-label]").textContent = `Hotel Pandia's, ${branch.name}`;
  for (const s of ["[data-count-where]", "[data-join-where]"]) $(s).textContent = `Table ${table} · ${branch.name}`;
  start();
}
