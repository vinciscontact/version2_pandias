// Hotel Pandia's: the staff app (v2/staff/). Built into v2/staff/app.js with esbuild (see v2/README.md).
//
// One page, five screens, shown by role:
//   Today    the date, the day's numbers, "needs you now" (confirm guests, bills, calls, late food)
//   Orders   the kitchen board: New → Cooking → Ready to serve, with "Can't make"
//   Tables   the floor: Seated ✓, the bill, discount, Cash / UPI / Card, print, close table
//   Menu     switch dishes off when they run out (owner can also see prices)
//   Numbers  sales by hour, payment split, top dishes, best tables, spend per head
//
// Every rule (who may do what, prices, the "held until seated" step) is enforced by the database
// (row-level security + checked functions); this file only shapes what each person sees.
// Data refreshes live: any change in this branch triggers one small re-read (debounced).

import { createClient } from "@supabase/supabase-js";

const sb = createClient("https://vlbnicfcjddaehyjindr.supabase.co", "sb_publishable_X4LBIcYNnHLTqfgByI8dWA_OW2JPggP", {
  auth: { persistSession: true, storageKey: "pd-staff" },
});

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const rupee = (n) => "₹" + Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 0 });
const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const mins = (iso) => Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60000));
const clock = (iso) => new Date(iso).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
/** +919876543210 → 98765 43210 */
const fmtPhone = (p) => String(p || "").replace(/^\+91(\d{5})(\d{5})$/, "$1 $2");
const telLink = (p) => (p ? `<a class="tel" href="tel:${esc(p)}">${esc(fmtPhone(p))}</a>` : "");
const ROLE = { admin: "Owner", manager: "Manager", kitchen: "Kitchen", cashier: "Cashier" };
const SCREENS = {
  today: ["admin", "manager", "cashier"],
  orders: ["admin", "manager", "kitchen", "cashier"],
  tables: ["admin", "manager", "cashier"],
  guests: ["admin", "manager", "cashier"],
  menu: ["admin", "manager", "kitchen"],
  numbers: ["admin", "manager"],
};
/** midnight in Chennai N days ago, as an ISO string (the restaurant's day, not the device's) */
function dayStart(daysAgo = 0) {
  const d = new Date(Date.now() + 5.5 * 3600e3);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return new Date(d.getTime() - 5.5 * 3600e3).toISOString();
}
const MSG = {
  forbidden: "Your role can't do that. Ask a manager.",
  unpaid: "This bill isn't paid. Only a manager can close it.",
  nothing_due: "Nothing left to pay on this bill.",
  session_closed: "This table is already closed.",
  bad_discount: "Discount can't be more than the bill.",
  bad_price: "Use a whole number of rupees, like 280.",
  not_seated: "Confirm the guests first (Seated ✓ on Tables).",
  too_late: "That order is already finished.",
  "Invalid login credentials": "That email or password doesn't match.",
};
const friendly = (e) => {
  const m = String(e?.message || e);
  for (const [k, v] of Object.entries(MSG)) if (m.includes(k)) return v;
  return "That didn't go through. Please try again.";
};
function toast(msg, kind = "ok") {
  const t = $("[data-toast]");
  t.textContent = msg;
  t.dataset.kind = kind;
  t.classList.add("show");
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove("show"), 2800);
}
/** run a database action from a button: busy state, friendly error, optional success note */
async function act(btn, fn, ok) {
  if (btn) btn.disabled = true;
  try {
    const { error } = await fn();
    if (error) throw error;
    if (ok) toast(ok);
    return true;
  } catch (e) {
    toast(friendly(e), "err");
    return false;
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ---------------------------------------------------------------- gentle sounds (Web Audio, nothing to download)
const sound = {
  ctx: null,
  on: false,
  async enable() {
    this.ctx ||= new AudioContext();
    await this.ctx.resume();
    this.on = true;
  },
  chime(times = 1) {
    if (!this.on || !this.ctx) return;
    for (let i = 0; i < times; i++) {
      const t = this.ctx.currentTime + i * 0.28;
      for (const [f, d] of [[880, 0], [1320, 0.09]]) {
        const o = this.ctx.createOscillator();
        const g = this.ctx.createGain();
        o.frequency.value = f;
        o.type = "sine";
        g.gain.setValueAtTime(0.0001, t + d);
        g.gain.exponentialRampToValueAtTime(0.25, t + d + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.5);
        o.connect(g).connect(this.ctx.destination);
        o.start(t + d);
        o.stop(t + d + 0.55);
      }
    }
  },
};

// ---------------------------------------------------------------- state
let me = null;
let branches = [];
let branch = "";
let tables = []; // labels
let sessions = []; // open table visits
let orders = []; // live orders (held / received / preparing / ready)
let calls = []; // waiter / bill calls
let today = { sales: 0, served: 0, guests: 0, visits: 0, orders: 0 };
let channel = null;
let openSession = null; // the table shown in the panel
let current = ""; // the screen on show
const seenOrders = new Set();

// ---------------------------------------------------------------- sign in / out
const showLogin = () => (($("[data-login]").hidden = false), ($("[data-app]").hidden = true));
$("[data-login-form]").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const err = $("[data-login-err]");
  err.hidden = true;
  const btn = $("button[type=submit]", e.target);
  btn.disabled = true;
  const { error } = await sb.auth.signInWithPassword({ email: String(f.get("email")).trim(), password: String(f.get("password")) });
  btn.disabled = false;
  if (error) return (err.textContent = friendly(error)), (err.hidden = false);
  boot();
});
$("[data-logout]").addEventListener("click", async () => {
  await sb.auth.signOut();
  location.hash = "";
  location.reload();
});

async function boot() {
  const { data: auth } = await sb.auth.getSession();
  if (!auth.session) return showLogin();
  const { data: staff } = await sb.from("staff").select("user_id, name, role, branch_id, active").eq("user_id", auth.session.user.id).maybeSingle();
  if (!staff || !staff.active) {
    await sb.auth.signOut();
    showLogin();
    $("[data-login-err]").textContent = "This account isn't set up for a branch yet. Ask the owner.";
    $("[data-login-err]").hidden = false;
    return;
  }
  me = staff;
  const { data: br } = await sb.from("branches").select("id, name, tax_percent, active, sort, seat_confirm").order("sort");
  branches = (br || []).filter((b) => b.active || me.role === "admin");
  if (me.role === "admin") {
    const sel = $("[data-branch]");
    sel.innerHTML = branches.map((b) => `<option value="${b.id}">${esc(b.name)}</option>`).join("");
    const saved = localStorage.getItem("pd-staff-branch");
    branch = branches.some((b) => b.id === saved) ? saved : branches[0]?.id;
    sel.value = branch;
    sel.hidden = false;
    sel.addEventListener("change", () => {
      branch = sel.value;
      localStorage.setItem("pd-staff-branch", branch);
      subscribe();
      reload();
    });
  } else {
    branch = me.branch_id;
    $("[data-branch-fixed]").textContent = branches.find((b) => b.id === branch)?.name || branch;
  }
  $("[data-me]").textContent = `${me.name} · ${ROLE[me.role]}`;
  $$("[data-tab]").forEach((a) => (a.hidden = !SCREENS[a.dataset.tab].includes(me.role)));
  $("[data-login]").hidden = true;
  $("[data-app]").hidden = false;
  route();
  subscribe();
  await reload();
  setInterval(tickAges, 20000);
  setInterval(reload, 120000); // safety net if a live message is missed
}

// ---------------------------------------------------------------- screens
function route() {
  const want = location.hash.slice(1);
  const allowed = Object.keys(SCREENS).filter((s) => SCREENS[s].includes(me.role));
  const screen = allowed.includes(want) ? want : allowed[0];
  $$("[data-screen]").forEach((s) => (s.hidden = s.dataset.screen !== screen));
  $$("[data-tab]").forEach((a) => a.toggleAttribute("aria-current", a.dataset.tab === screen));
  current = screen;
  if (screen === "menu") loadMenu();
  if (screen === "guests") loadGuests();
  if (screen === "numbers") loadNumbers();
  paint();
}
addEventListener("hashchange", () => me && route());

// ---------------------------------------------------------------- live data
let reloadTimer;
const soon = () => (clearTimeout(reloadTimer), (reloadTimer = setTimeout(reload, 300)));
function subscribe() {
  channel?.unsubscribe();
  const f = `branch_id=eq.${branch}`;
  channel = sb
    .channel("staff-" + branch)
    .on("postgres_changes", { event: "*", schema: "public", table: "orders", filter: f }, soon)
    .on("postgres_changes", { event: "*", schema: "public", table: "table_sessions", filter: f }, soon)
    .on("postgres_changes", { event: "*", schema: "public", table: "service_calls", filter: f }, soon)
    .on("postgres_changes", { event: "*", schema: "public", table: "payments", filter: f }, soon)
    .subscribe((s) => {
      $("[data-offline]").hidden = s === "SUBSCRIBED";
      if (s === "SUBSCRIBED") reload();
    });
}
document.addEventListener("visibilitychange", () => !document.hidden && me && reload());

async function reload() {
  if (!branch) return;
  const since = dayStart(0);
  const [t, s, o, c, pay, done] = await Promise.all([
    sb.from("dining_tables").select("label").eq("branch_id", branch).eq("active", true),
    sb.from("table_sessions").select("id, table_label, status, subtotal, tax, discount, total, opened_at, pin, guests, seated_at, customers(name, phone)").eq("branch_id", branch).in("status", ["open", "bill_requested", "paid"]),
    sb.from("orders").select("id, code, table_label, session_id, status, note, total, created_at, customers(name, phone), order_items(id, name, qty, unit_price, spice, note, parcel, parcel_fee, unavailable_at)").eq("branch_id", branch).in("status", ["held", "received", "preparing", "ready"]).order("created_at"),
    sb.from("service_calls").select("id, table_label, kind, created_at").eq("branch_id", branch).is("resolved_at", null).order("created_at"),
    sb.from("payments").select("amount").eq("branch_id", branch).gte("created_at", since),
    sb.from("table_sessions").select("guests, guests_max, status").eq("branch_id", branch).gte("opened_at", since),
  ]);
  if (t.error || s.error || o.error) return;
  tables = (t.data || []).map((r) => r.label).sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  sessions = s.data || [];
  const fresh = (o.data || []).filter((x) => x.status === "received" && !seenOrders.has(x.id));
  if (seenOrders.size && fresh.length) sound.chime(2); // something new for the kitchen
  for (const x of o.data || []) seenOrders.add(x.id);
  orders = o.data || [];
  calls = c.data || [];
  const visits = done.data || [];
  const servedCount = await sb.from("orders").select("id", { count: "exact", head: true }).eq("branch_id", branch).eq("status", "served").gte("created_at", since);
  today = {
    sales: (pay.data || []).reduce((a, p) => a + Number(p.amount), 0),
    guests: visits.reduce((a, v) => a + (v.guests_max || v.guests || 0), 0),
    visits: visits.length,
    served: servedCount.count || 0,
  };
  paint();
  if (openSession && $("[data-panel]").open) openPanel(openSession.id);
  if (current === "guests" && gView === "today") loadGuests();
}

// ---------------------------------------------------------------- paint everything visible
const sessionByTable = () => Object.fromEntries(sessions.map((s) => [s.table_label, s]));
const heldFor = (sid) => orders.some((o) => o.session_id === sid && o.status === "held");
function tableState(s) {
  if (!s) return "free";
  if (heldFor(s.id) && !s.seated_at) return "wait";
  if (s.status === "paid") return "paid";
  if (s.status === "bill_requested" || calls.some((c) => c.table_label === s.table_label && c.kind === "bill")) return "bill";
  return "eat";
}
function paint() {
  if (!me) return;
  $("[data-date]").textContent = new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", weekday: "long", day: "numeric", month: "long" }) + " · " + (branches.find((b) => b.id === branch)?.name || "");
  paintKpis();
  paintAttention();
  paintBoard();
  paintFloor();
  const waiting = sessions.filter((s) => tableState(s) === "wait").length + calls.length;
  badge("tables", waiting);
  badge("orders", orders.filter((o) => o.status === "received").length);
}
const badge = (k, n) => {
  const b = $(`[data-badge="${k}"]`);
  b.hidden = !n;
  b.textContent = String(n);
};
function paintKpis() {
  const seated = sessions.filter((s) => s.status !== "paid").reduce((a, s) => a + (s.guests || 0), 0);
  const cooking = orders.filter((o) => ["received", "preparing"].includes(o.status)).length;
  const kpi = (label, value, sub = "") => `<div class="kpi"><span>${label}</span><b>${value}</b>${sub ? `<small>${sub}</small>` : ""}</div>`;
  $("[data-kpis]").innerHTML = [
    kpi("Guests in now", seated, `${sessions.filter((s) => s.status !== "paid").length} tables`),
    kpi("In the kitchen", cooking, cooking ? "orders cooking or new" : "all caught up"),
    kpi("Served today", today.served, today.served >= 100 ? "a big day, well done" : ""),
    kpi("Taken today", rupee(today.sales), today.visits ? `${today.visits} tables · ${rupee(today.sales / Math.max(1, today.guests))} a head` : ""),
  ].join("");
}
function paintAttention() {
  const items = [];
  for (const s of sessions) {
    if (tableState(s) === "wait")
      items.push({ cls: "wait", t: `Table ${s.table_label}: confirm ${s.guests || "the"} guests`, sub: `${s.customers?.name ? s.customers.name + " · " + fmtPhone(s.customers.phone) + " · " : ""}Their first order is waiting for Seated ✓`, go: s.id });
  }
  for (const c of calls) {
    const s = sessionByTable()[c.table_label];
    items.push({ cls: c.kind === "bill" ? "bill" : "call", t: c.kind === "bill" ? `Table ${c.table_label} wants the bill` : `Table ${c.table_label} called a waiter`, sub: `${mins(c.created_at)} min ago`, go: s?.id, call: c.id });
  }
  for (const o of orders.filter((o) => ["received", "preparing"].includes(o.status) && mins(o.created_at) >= 20))
    items.push({ cls: "late", t: `Table ${o.table_label} waiting ${mins(o.created_at)} min`, sub: `Order #${o.code}: check with the kitchen`, go: sessions.find((s) => s.id === o.session_id)?.id });
  $("[data-attention]").innerHTML = items.length
    ? items
        .map(
          (i) => `<div class="att att--${i.cls}"><div><b>${esc(i.t)}</b><span>${esc(i.sub)}</span></div>
          <div class="att__go">${i.call ? `<button type="button" class="btn btn--line btn--sm" data-done-call="${i.call}">Done</button>` : ""}${i.go ? `<button type="button" class="btn btn--dark btn--sm" data-open="${i.go}">Open</button>` : ""}</div></div>`
        )
        .join("")
    : `<div class="calm"><b>All caught up.</b><span>Nothing needs you right now.</span></div>`;
}
function tile(label, s) {
  const st = tableState(s);
  const word = { free: "Free", wait: "Confirm guests", eat: "Eating", bill: "Wants bill", paid: "Paid" }[st];
  return `<button type="button" class="tile tile--${st}" ${s ? `data-open="${s.id}"` : "disabled"}>
    <b>${esc(label)}</b><span>${word}</span>${
      s
        ? `${s.customers ? `<em class="tile__who">${esc(s.customers.name || "Guest")}<br>${esc(fmtPhone(s.customers.phone))}</em>` : ""}<small>${s.pin && s.status !== "paid" ? `PIN <b class="tile__pin">${esc(s.pin)}</b> · ` : ""}${s.guests ? s.guests + " ppl · " : ""}${rupee(s.total)} · ${mins(s.opened_at)}m</small>`
        : ""
    }</button>`;
}
function paintFloor() {
  const by = sessionByTable();
  $("[data-floor]").innerHTML = tables.map((l) => tile(l, by[l])).join("");
  $("[data-floor-mini]").innerHTML = sessions.length
    ? sessions.sort((a, b) => a.table_label.localeCompare(b.table_label, "en", { numeric: true })).map((s) => tile(s.table_label, s)).join("")
    : `<div class="calm"><b>The floor is quiet.</b><span>Tables appear here when guests order.</span></div>`;
  const busy = sessions.filter((s) => s.status !== "paid").length;
  $("[data-floor-sum]").textContent = `${busy} of ${tables.length} tables busy`;
}

// ---------------------------------------------------------------- kitchen board
const ALERT = /allerg|nut|peanut|gluten|jain|no onion|no garlic/i;
const NEXT = { received: ["preparing", "Start cooking"], preparing: ["ready", "Ready"], ready: ["served", "Served"] };
function paintBoard() {
  for (const col of ["received", "preparing", "ready"]) {
    const list = orders.filter((o) => o.status === col);
    $(`[data-n="${col}"]`).textContent = String(list.length);
    $(`[data-col="${col}"]`).innerHTML = list.length
      ? list
          .map((o) => {
            const s = sessions.find((x) => x.id === o.session_id);
            const m = mins(o.created_at);
            return `<article class="ticket ${m >= 20 ? "is-late" : m >= 12 ? "is-warm" : ""}">
            <header><b class="ticket__table">T${esc(o.table_label)}</b><span>#${esc(o.code)}</span><span class="age" data-age="${o.created_at}">${m < 1 ? "now" : m + "m"}</span></header>
            ${o.customers || s?.guests ? `<p class="ticket__who">${o.customers ? `For <b>${esc(o.customers.name || "Guest")}</b> · ${telLink(o.customers.phone)}` : ""}${s?.guests ? ` · ${s.guests} at the table` : ""}</p>` : ""}
            <ul>${o.order_items
              .map(
                (i) => `<li class="${i.unavailable_at ? "is-out" : ""}"><span><b>${i.qty}×</b> ${esc(i.name)}${i.spice ? ` <em class="tag">${esc(i.spice)}</em>` : ""}${i.parcel ? ` <em class="tag">parcel</em>` : ""}${
                  i.note ? `<i class="lnote ${ALERT.test(i.note) ? "alert" : ""}">${esc(i.note)}</i>` : ""
                }</span>${i.unavailable_at ? "<small>ran out</small>" : `<button type="button" class="cant" data-cant="${i.id}" data-name="${esc(i.qty + "× " + i.name)}">Can't make</button>`}</li>`
              )
              .join("")}</ul>
            ${o.note ? `<p class="ticket__note">“${esc(o.note)}”</p>` : ""}
            <button type="button" class="btn ${col === "received" ? "btn--gold" : col === "preparing" ? "btn--green" : "btn--dark"} ticket__go" data-move="${o.id}" data-to="${NEXT[col][0]}">${NEXT[col][1]}</button>
          </article>`;
          })
          .join("")
      : `<p class="calm calm--col">${col === "received" ? "No new orders." : col === "preparing" ? "Nothing cooking." : "Nothing waiting."}</p>`;
  }
  const late = orders.filter((o) => ["received", "preparing"].includes(o.status) && mins(o.created_at) >= 20).length;
  $("[data-board-sum]").textContent = late ? `${late} running late` : "Everything on time";
}
function tickAges() {
  $$("[data-age]").forEach((el) => {
    const m = mins(el.dataset.age);
    el.textContent = m < 1 ? "now" : `${m}m`;
  });
}

// ---------------------------------------------------------------- one table (panel)
const panel = $("[data-panel]");
let pGuests = 2;
async function openPanel(id) {
  const s = sessions.find((x) => x.id === id);
  if (!s) return panel.close();
  openSession = s;
  const [o, p] = await Promise.all([
    sb.from("orders").select("id, code, status, total, created_at, customers(name, phone), order_items(id, name, qty, unit_price, spice, note, parcel, parcel_fee, unavailable_at)").eq("session_id", id).order("created_at"),
    sb.from("payments").select("amount, method").eq("session_id", id),
  ]);
  const list = o.data || [];
  const paid = (p.data || []).reduce((a, x) => a + Number(x.amount), 0);
  const due = Math.max(0, Number(s.total) - paid);
  const st = tableState(s);
  $("[data-p-title]").textContent = `Table ${s.table_label}`;
  $("[data-p-sub]").textContent = { wait: "Confirm guests", eat: "Eating", bill: "Wants the bill", paid: "Paid" }[st];
  // everyone who ordered at this table (one person usually; a second phone joins with the PIN)
  const people = [];
  for (const c of [s.customers, ...(o.data || []).map((x) => x.customers)]) if (c && !people.some((q) => q.phone === c.phone)) people.push(c);
  $("[data-p-guest]").innerHTML = `<div class="gcard">
      <div class="gcard__who">${
        people.length
          ? people.map((c) => `<p><b>${esc(c.name || "Guest")}</b>${telLink(c.phone)}</p>`).join("")
          : `<p><b>No name yet</b><span class="soft">It's asked at their first order.</span></p>`
      }</div>
      <dl class="gcard__facts">
        <div><dt>Table PIN</dt><dd class="gcard__pin">${s.pin && s.status !== "paid" ? esc(s.pin) : "–"}</dd></div>
        <div><dt>Guests</dt><dd>${s.guests || "–"}</dd></div>
        <div><dt>Since</dt><dd>${clock(s.opened_at)}</dd></div>
      </dl>
    </div>`;
  $("[data-p-seat]").hidden = st !== "wait";
  pGuests = s.guests || 2;
  $("[data-p-guests]").textContent = String(pGuests);
  $("[data-p-orders]").innerHTML = list
    .map(
      (x) => `<div class="po ${x.status === "cancelled" ? "is-x" : ""}"><div class="po__head"><b>#${esc(x.code)}</b><span>${clock(x.created_at)}</span><em class="pill pill--${x.status}">${x.status === "held" ? "waiting" : x.status}</em>${people.length > 1 && x.customers ? `<span class="po__who">${esc(x.customers.name || fmtPhone(x.customers.phone))}</span>` : ""}
      ${["held", "received", "preparing"].includes(x.status) && ["cashier", "manager", "admin"].includes(me.role) ? `<button type="button" class="link" data-cancel="${x.id}">Cancel</button>` : ""}</div>
      <ul>${x.order_items.map((i) => `<li class="${i.unavailable_at ? "is-out" : ""}"><span>${i.qty} × ${esc(i.name)}${i.spice ? ` · ${esc(i.spice)}` : ""}${i.parcel ? " · parcel" : ""}${i.note ? ` · <i>${esc(i.note)}</i>` : ""}</span><span>${rupee(i.unavailable_at ? 0 : i.qty * i.unit_price + Number(i.parcel_fee))}</span></li>`).join("")}</ul></div>`
    )
    .join("");
  const rate = branches.find((b) => b.id === branch)?.tax_percent ?? 5;
  $("[data-p-subtotal]").textContent = rupee(s.subtotal);
  $("[data-p-discrow]").hidden = !Number(s.discount);
  $("[data-p-disc]").textContent = "−" + rupee(s.discount);
  $("[data-p-rate]").textContent = String(Number(rate));
  $("[data-p-tax]").textContent = rupee(s.tax);
  $("[data-p-total]").textContent = rupee(s.total);
  $("[data-p-paidrow]").hidden = !paid;
  $("[data-p-paid]").textContent = rupee(paid);
  $("[data-p-pay]").hidden = due <= 0;
  $("[data-p-due]").textContent = rupee(due);
  $("[data-p-discbox]").hidden = !["manager", "admin"].includes(me.role) || s.status === "paid";
  $("[data-p-close-table]").hidden = !(s.status === "paid" || Number(s.total) === 0 || ["manager", "admin"].includes(me.role));
  $("[data-p-close-table]").textContent = s.status === "paid" || Number(s.total) === 0 ? "Close table" : "Close unpaid (manager)";
  openSession.list = list;
  if (!panel.open) panel.showModal();
}
$("[data-p-close]").addEventListener("click", () => panel.close());
panel.addEventListener("click", (e) => e.target === panel && panel.close());
$("[data-p-gdec]").addEventListener("click", () => ($("[data-p-guests]").textContent = String((pGuests = Math.max(1, pGuests - 1)))));
$("[data-p-ginc]").addEventListener("click", () => ($("[data-p-guests]").textContent = String((pGuests = Math.min(60, pGuests + 1)))));
$("[data-p-seatgo]").addEventListener("click", async (e) => {
  if (await act(e.currentTarget, () => sb.rpc("confirm_seated", { p_session: openSession.id, p_guests: pGuests }), "Sent to the kitchen")) reload();
});
$$("[data-pay]").forEach((b) =>
  b.addEventListener("click", async () => {
    if (await act(b, () => sb.rpc("record_payment", { p_session: openSession.id, p_method: b.dataset.pay }), `Paid by ${b.textContent}. Thank you!`)) reload();
  })
);
$("[data-p-discgo]").addEventListener("click", async (e) => {
  const v = Number($("[data-p-discin]").value || 0);
  if (await act(e.currentTarget, () => sb.rpc("set_discount", { p_session: openSession.id, p_amount: v }), "Discount applied")) {
    $("[data-p-discin]").value = "";
    reload();
  }
});
$("[data-p-close-table]").addEventListener("click", async (e) => {
  const unpaid = openSession.status !== "paid" && Number(openSession.total) > 0;
  if (unpaid && !confirm(`Close table ${openSession.table_label} without full payment?`)) return;
  if (await act(e.currentTarget, () => sb.rpc("close_session", { p_session: openSession.id }), `Table ${openSession.table_label} is free`)) {
    panel.close();
    reload();
  }
});
$("[data-p-orders]").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-cancel]");
  if (!b || !confirm("Cancel this order? It comes off the bill.")) return;
  if (await act(b, () => sb.rpc("set_order_status", { p_order: b.dataset.cancel, p_status: "cancelled" }), "Order cancelled")) reload();
});
$("[data-p-print]").addEventListener("click", () => {
  const s = openSession;
  const lines = (s.list || []).filter((x) => x.status !== "cancelled").flatMap((x) => x.order_items).filter((i) => !i.unavailable_at);
  $("[data-print]").innerHTML = `<h3>Hotel Pandia's</h3><p>${esc(branches.find((b) => b.id === branch)?.name)} · Table ${esc(s.table_label)}<br>${new Date().toLocaleString("en-IN")}</p>
    <table>${lines.map((i) => `<tr><td>${i.qty} × ${esc(i.name)}${i.parcel ? " (parcel)" : ""}</td><td>${rupee(i.qty * i.unit_price + Number(i.parcel_fee))}</td></tr>`).join("")}
    <tr><td>Subtotal</td><td>${rupee(s.subtotal)}</td></tr>${Number(s.discount) ? `<tr><td>Discount</td><td>−${rupee(s.discount)}</td></tr>` : ""}
    <tr><td>GST</td><td>${rupee(s.tax)}</td></tr><tr><th>Total</th><th>${rupee(s.total)}</th></tr></table><p>Thank you! வாங்க, மீண்டும் வருக!</p>`;
  print();
});

// ---------------------------------------------------------------- clicks anywhere: open a table, move a ticket, can't make, done call
document.addEventListener("click", async (e) => {
  const open = e.target.closest("[data-open]");
  if (open) return openPanel(open.dataset.open);
  const mv = e.target.closest("[data-move]");
  if (mv) {
    if (await act(mv, () => sb.rpc("set_order_status", { p_order: mv.dataset.move, p_status: mv.dataset.to }))) {
      const o = orders.find((x) => x.id === mv.dataset.move);
      if (o) o.status = mv.dataset.to;
      if (mv.dataset.to === "served") orders = orders.filter((x) => x.id !== mv.dataset.move);
      paint();
    }
    return;
  }
  const cant = e.target.closest("[data-cant]");
  if (cant) {
    if (!confirm(`Can't make ${cant.dataset.name}?\n\nIt comes off the guest's bill and their phone tells them it ran out.`)) return;
    if (await act(cant, () => sb.rpc("cant_make", { p_item: Number(cant.dataset.cant) }), "Taken off the bill")) reload();
    return;
  }
  const done = e.target.closest("[data-done-call]");
  if (done && (await act(done, () => sb.rpc("resolve_call", { p_id: Number(done.dataset.doneCall) })))) reload();
});

// ---------------------------------------------------------------- guests
// Today: every table visit at this branch since midnight, with name, number, PIN and bill.
// All customers (owner / manager): everyone who has ordered, searchable, downloadable for Excel.
// Numbers are for bringing the order to the right person; no messages are sent.
let gView = "today";
let gRows = [];
let gTimer;
const canAllGuests = () => ["admin", "manager"].includes(me.role);
const STATUS = { open: "Eating", bill_requested: "Wants bill", paid: "Paid", closed: "Left" };
const shortDay = (iso) => new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
async function loadGuests() {
  $("[data-gv=all]").hidden = !canAllGuests();
  $("[data-g-export]").hidden = !(canAllGuests() && gView === "all");
  $$("[data-gv]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.gv === gView)));
  const q = $("[data-g-search]").value.trim();
  const box = $("[data-guests]");
  if (gView === "today") {
    const { data, error } = await sb
      .from("table_sessions")
      .select("id, table_label, status, opened_at, pin, guests, guests_max, total, customers(name, phone), orders(id, status, customers(name, phone))")
      .eq("branch_id", branch)
      .gte("opened_at", dayStart(0))
      .order("opened_at", { ascending: false });
    if (error) return (box.innerHTML = `<p class="calm">Couldn't load today's guests. Pull down or try again.</p>`);
    gRows = (data || []).map((v) => {
      const people = [];
      for (const c of [v.customers, ...(v.orders || []).map((o) => o.customers)]) if (c && !people.some((x) => x.phone === c.phone)) people.push(c);
      return { ...v, people, nOrders: (v.orders || []).filter((o) => o.status !== "cancelled").length };
    });
    const ql = q.toLowerCase().replace(/\s/g, "");
    const list = gRows.filter((v) => !ql || v.table_label.toLowerCase() === ql || v.people.some((c) => (c.name || "").toLowerCase().replace(/\s/g, "").includes(ql) || c.phone.includes(ql)));
    const ppl = gRows.reduce((a, v) => a + (v.guests_max || v.guests || 0), 0);
    box.innerHTML =
      `<p class="soft small">${gRows.length} tables today · ${ppl} guests · ${gRows.filter((v) => v.people.length).length} gave a name and number</p>` +
      (list.length
        ? `<table class="gt"><thead><tr><th>Time</th><th>Table</th><th>Guest</th><th>Number</th><th>PIN</th><th>People</th><th>Orders</th><th>Bill</th><th>Status</th></tr></thead><tbody>${list
            .map(
              (v) => `<tr ${sessions.some((x) => x.id === v.id) ? `data-open="${v.id}" class="is-live"` : ""}>
                <td data-l="Time">${clock(v.opened_at)}</td>
                <td data-l="Table"><b>${esc(v.table_label)}</b></td>
                <td data-l="Guest">${v.people.map((c) => `<b>${esc(c.name || "Guest")}</b>`).join("<br>") || `<span class="soft">–</span>`}</td>
                <td data-l="Number">${v.people.map((c) => telLink(c.phone)).join("<br>") || `<span class="soft">–</span>`}</td>
                <td data-l="PIN">${["open", "bill_requested"].includes(v.status) && v.pin ? `<b class="gpin">${esc(v.pin)}</b>` : `<span class="soft">–</span>`}</td>
                <td data-l="People">${v.guests_max || v.guests || "–"}</td>
                <td data-l="Orders">${v.nOrders}</td>
                <td data-l="Bill">${rupee(v.total)}</td>
                <td data-l="Status"><em class="gst gst--${v.status}">${STATUS[v.status] || v.status}</em></td></tr>`
            )
            .join("")}</tbody></table>`
        : `<div class="calm"><b>${q ? "Nobody matches that." : "No guests yet today."}</b><span>${q ? "Try a name, a number or a table." : "Every table that orders from the QR shows up here."}</span></div>`);
    return;
  }
  // all customers
  box.innerHTML = `<p class="soft small">Loading…</p>`;
  const { data, error } = await sb.rpc("list_customers", { p_branch: me.role === "admin" ? null : branch, p_search: q || null });
  if (error) return (box.innerHTML = `<p class="calm">${esc(friendly(error))}</p>`);
  gRows = data || [];
  const bname = (id) => branches.find((b) => b.id === id)?.name || id || "";
  box.innerHTML =
    `<p class="soft small">${gRows.length} ${gRows.length === 1 ? "customer" : "customers"}${q ? " match" : ""} · newest first</p>` +
    (gRows.length
      ? `<table class="gt"><thead><tr><th>Name</th><th>Number</th><th>Visits</th><th>Orders</th><th>Spent</th><th>First visit</th><th>Last visit</th><th>Branch</th></tr></thead><tbody>${gRows
          .map(
            (c) => `<tr><td data-l="Name"><b>${esc(c.name || "–")}</b></td><td data-l="Number">${telLink(c.phone)}</td><td data-l="Visits">${c.visits}</td><td data-l="Orders">${c.orders}</td>
              <td data-l="Spent">${rupee(c.spent)}</td><td data-l="First visit">${shortDay(c.first_seen)}</td><td data-l="Last visit">${c.last_order ? shortDay(c.last_order) + ", " + clock(c.last_order) : "–"}</td><td data-l="Branch">${esc(bname(c.last_branch))}</td></tr>`
          )
          .join("")}</tbody></table>`
      : `<div class="calm"><b>${q ? "Nobody matches that." : "No customers yet."}</b><span>Names and numbers appear after guests order from the table QR.</span></div>`);
}
$$("[data-gv]").forEach((b) =>
  b.addEventListener("click", () => {
    gView = b.dataset.gv;
    loadGuests();
  })
);
$("[data-g-search]").addEventListener("input", () => {
  clearTimeout(gTimer);
  gTimer = setTimeout(loadGuests, 300);
});
$("[data-guests]").addEventListener("click", (e) => {
  if (e.target.closest("a")) return; // tapping a number calls it
  const r = e.target.closest("[data-open]");
  if (r) openPanel(r.dataset.open);
});
// a file Excel opens directly (UTF-8 CSV with a byte-order mark, so Tamil names survive)
$("[data-g-export]").addEventListener("click", () => {
  const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [["Name", "Number", "Visits", "Orders", "Spent (Rs)", "First visit", "Last visit", "Last branch"]].concat(
    gRows.map((c) => [c.name || "", fmtPhone(c.phone), c.visits, c.orders, Number(c.spent).toFixed(0), c.first_seen?.slice(0, 10), c.last_order?.slice(0, 10) || "", branches.find((b) => b.id === c.last_branch)?.name || c.last_branch || ""])
  );
  const blob = new Blob(["\ufeff" + lines.map((l) => l.map(cell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `pandias-customers-${dayStart(0).slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

// ---------------------------------------------------------------- menu and prices
// Everyone with Menu sees prices; only the owner can change them, add dishes, edit or remove them
// (the database enforces it). Every change asks first; prices keep a history. Past bills never change.
// A dish with choices (Full / Half, Chicken / Mutton…) is one row per choice in the database:
// "base--choice". Editing or removing works on the whole dish (its base).
let menu = [];
let categories = [];
const baseOf = (id) => id.split("--")[0];
const plainName = (m) => (m.id.includes("--") ? m.name.replace(/\s\((?:[^()]|\([^()]*\))*\)$/, "") : m.name);
const TAGS = { signature: "Signature", bestseller: "Bestseller", special: "Special", spicy: "Spicy" };
const DIETS = { veg: "Veg", egg: "Egg", nonveg: "Non-veg" };
async function loadMenu() {
  const [{ data, error }, cats] = await Promise.all([
    sb.from("menu_items").select("id, name, category, price, available, updated_at, tamil, description, diet, tags, sort, deleted_at").order("sort").order("name"),
    sb.from("menu_categories").select("id, name, sort").order("sort"),
  ]);
  if (error) return toast("Couldn't load the menu.", "err");
  if (cats.data) categories = cats.data;
  menu = data || [];
  $("[data-add-dish]").hidden = !canPrice();
  $("[data-menu-view] [value=removed]").hidden = !canPrice();
  paintMenu();
}
const canPrice = () => me.role === "admin";
const catName = (id) => categories.find((c) => c.id === id)?.name || id;
const dayLabel = (iso) => new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
function paintMenu() {
  const q = $("[data-menu-search]").value.trim().toLowerCase();
  const view = $("[data-menu-view]").value;
  const live = menu.filter((m) => !m.deleted_at);
  const removed = menu.filter((m) => m.deleted_at);
  const pool = view === "removed" ? removed : view === "off" ? live.filter((m) => !m.available) : live;
  const list = pool.filter((m) => !q || m.name.toLowerCase().includes(q) || (m.tamil || "").includes(q));
  const off = live.filter((m) => !m.available).length;
  const rank = (c) => (categories.findIndex((x) => x.id === c) + 1 || 999);
  const cats = [...new Set(list.map((m) => m.category))].sort((a, b) => rank(a) - rank(b));
  const head =
    view === "removed"
      ? `<p class="soft small">${removed.length ? `${new Set(removed.map((m) => baseOf(m.id))).size} removed dishes. Guests don't see them. Restore puts a dish back on the menu, with its old price.` : "Nothing removed. Removed dishes wait here, so nothing is ever lost by mistake."}</p>`
      : `<p class="soft small">${live.length} choices on the menu · ${off ? `${off} switched off` : "everything is on"}${canPrice() ? " · tap a dish name to edit it · type a new price and press Enter" : ""}</p>`;
  const row = (m) =>
    `<div class="mrow ${m.available ? "" : "is-off"}">
          <span class="mrow__name">${
            canPrice() ? `<button type="button" class="mname" data-edit="${esc(baseOf(m.id))}"><b>${esc(m.name)}</b></button>` : `<b>${esc(m.name)}</b>`
          }${(m.tags || []).map((t) => `<i class="mtag mtag--${esc(t)}">${esc(TAGS[t] || t)}</i>`).join("")}${
            canPrice() ? `<button type="button" class="link link--soft" data-history="${esc(m.id)}">History</button>` : ""
          }</span>
          ${
            canPrice()
              ? `<label class="price"><span>₹</span><input type="number" inputmode="numeric" min="0" max="100000" step="1" value="${Number(m.price)}" data-price="${esc(m.id)}" aria-label="Price of ${esc(m.name)} in rupees"></label>`
              : `<b class="price price--ro">${rupee(m.price)}</b>`
          }
          <label class="switch" title="On the menu"><input type="checkbox" data-avail="${esc(m.id)}" ${m.available ? "checked" : ""} aria-label="${esc(m.name)} on the menu"><i></i></label>
        </div>
        <div class="mhist" data-hist="${esc(m.id)}" hidden></div>`;
  // one Restore button per removed dish (on its first row)
  const firstOfBase = new Set();
  const rows = (c) =>
    list
      .filter((m) => m.category === c)
      .map((m) => {
        if (view === "removed") {
          const b = baseOf(m.id);
          const first = !firstOfBase.has(b);
          firstOfBase.add(b);
          return `<div class="mrow is-off">
            <span class="mrow__name"><b>${esc(m.name)}</b><small>Removed ${dayLabel(m.deleted_at)} · was ${rupee(m.price)}</small></span>
            ${first ? `<button type="button" class="btn btn--line btn--sm" data-restore="${esc(b)}">Restore</button>` : ""}
          </div>`;
        }
        return row(m);
      })
      .join("");
  $("[data-menu]").innerHTML = head + cats.map((c) => `<h2 class="mcat">${esc(catName(c))}</h2>` + rows(c)).join("");
}
$("[data-menu-search]").addEventListener("input", paintMenu);
$("[data-menu-view]").addEventListener("change", paintMenu);

// ---------------------------------------------------------------- add / edit / remove a dish (owner)
const dishDlg = $("[data-dish]");
const dishForm = $("[data-dish-form]");
let editing = null; // base id, or null when adding
function fillCats(selected) {
  $("[data-d-cat]").innerHTML =
    categories.map((c) => `<option value="${esc(c.id)}" ${c.id === selected ? "selected" : ""}>${esc(c.name)}</option>`).join("") +
    `<option value="__new">+ New category…</option>`;
  $("[data-d-newcat]").hidden = true;
}
function openDish(base) {
  editing = base;
  dishForm.reset();
  const rows = base ? menu.filter((m) => baseOf(m.id) === base && !m.deleted_at) : [];
  const m = rows[0];
  $("[data-d-title]").textContent = base ? "Edit dish" : "Add a dish";
  $("[data-d-sub]").textContent = base
    ? rows.length > 1
      ? `${rows.length} choices: ${rows.map((r) => r.name.match(/\(((?:[^()]|\([^()]*\))*)\)$/)?.[1] || r.name).join(", ")}. Change their prices on the menu list.`
      : "Change the price on the menu list. It keeps a history."
    : "It shows on the website and every table as soon as you save.";
  $("[data-d-prices]").hidden = !!base;
  $("[data-d-remove]").hidden = !base;
  fillCats(m?.category || $("[data-menu-search]").dataset.lastCat || categories[0]?.id);
  if (m) {
    dishForm.elements.name.value = plainName(m);
    dishForm.elements.tamil.value = m.tamil || "";
    dishForm.elements.desc.value = m.description || "";
    dishForm.elements.diet.value = m.diet || "nonveg";
    for (const t of m.tags || []) if (dishForm.elements["tag_" + t]) dishForm.elements["tag_" + t].checked = true;
  } else dishForm.elements.diet.value = "nonveg";
  $("[data-d-err]").hidden = true;
  dishDlg.showModal();
  dishForm.elements.name.focus();
}
$("[data-add-dish]").addEventListener("click", () => openDish(null));
$("[data-d-close]").addEventListener("click", () => dishDlg.close());
$("[data-d-cat]").addEventListener("change", (e) => {
  const isNew = e.target.value === "__new";
  $("[data-d-newcat]").hidden = !isNew;
  if (isNew) dishForm.elements.newcat.focus();
});
const dishErr = (t) => {
  const el = $("[data-d-err]");
  el.textContent = t;
  el.hidden = false;
};
Object.assign(MSG, {
  duplicate_dish: "There's already a dish with that name.",
  duplicate_category: "That category already exists. Pick it from the list.",
  bad_name: "Give it a name (2 to 80 letters).",
  bad_category: "Pick a category.",
});
dishForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = dishForm.elements;
  const name = f.name.value.trim().replace(/\s+/g, " ");
  if (name.length < 2) return dishErr("Give it a name (2 to 80 letters).");
  const tags = Object.keys(TAGS).filter((t) => f["tag_" + t].checked);
  const btn = $("[data-d-save]");
  let cat = f.cat.value;
  btn.disabled = true;
  try {
    if (cat === "__new") {
      const cname = f.newcat.value.trim();
      if (cname.length < 2) throw new Error("bad_category");
      const r = await sb.rpc("add_category", { p_name: cname, p_blurb: null });
      if (r.error) throw r.error;
      cat = r.data;
    }
    if (editing) {
      const r = await sb.rpc("update_dish", { p_base: editing, p_name: name, p_category: cat, p_diet: f.diet.value, p_tamil: f.tamil.value, p_desc: f.desc.value, p_tags: tags });
      if (r.error) throw r.error;
      toast(`${name} saved`);
    } else {
      const price = Number(f.price.value);
      const half = f.half.value === "" ? null : Number(f.half.value);
      const okNum = (n) => Number.isInteger(n) && n >= 0 && n <= 100000;
      if (f.price.value === "" || !okNum(price) || (half !== null && !okNum(half))) throw new Error("bad_price");
      const shown = half === null ? rupee(price) : `${rupee(price)} full, ${rupee(half)} half`;
      if (!confirm(`Add ${name} at ${shown} to ${catName(cat) || f.newcat.value}?\n\nGuests can order it straight away.`)) return;
      const r = await sb.rpc("add_dish", { p_name: name, p_category: cat, p_price: price, p_half: half, p_diet: f.diet.value, p_tamil: f.tamil.value, p_desc: f.desc.value, p_tags: tags });
      if (r.error) throw r.error;
      $("[data-menu-search]").dataset.lastCat = cat;
      toast(`${name} is on the menu`);
    }
    dishDlg.close();
    $("[data-menu-view]").value = "all";
    await loadMenu();
  } catch (x) {
    dishErr(friendly(x));
  } finally {
    btn.disabled = false;
  }
});
$("[data-d-remove]").addEventListener("click", async () => {
  const rows = menu.filter((m) => baseOf(m.id) === editing && !m.deleted_at);
  const name = plainName(rows[0]);
  const ask =
    `Remove ${name} from the menu?\n\n` +
    (rows.length > 1 ? `All ${rows.length} choices go (${rows.map((r) => r.name.match(/\(((?:[^()]|\([^()]*\))*)\)$/)?.[1]).join(", ")}).\n` : "") +
    `Guests stop seeing it on the website and at the tables.\nIt moves to "Recently removed", so you can restore it later. Past bills don't change.\n\nJust out for today? Use the on/off switch instead.`;
  if (!confirm(ask)) return;
  const ok = await act($("[data-d-remove]"), () => sb.rpc("remove_dish", { p_base: editing }), `${name} removed. It's in Recently removed.`);
  if (!ok) return;
  dishDlg.close();
  await loadMenu();
});

$("[data-menu]").addEventListener("change", async (e) => {
  // on / off
  const c = e.target.closest("[data-avail]");
  if (c) {
    const m = menu.find((x) => x.id === c.dataset.avail);
    const ok = await act(null, () => sb.rpc("set_item_available", { p_item: m.id, p_available: c.checked }), c.checked ? `${m.name} is back on` : `${m.name} marked sold out`);
    if (ok) m.available = c.checked;
    else c.checked = !c.checked;
    return paintMenu();
  }
  // price (owner)
  const inp = e.target.closest("[data-price]");
  if (!inp) return;
  const m = menu.find((x) => x.id === inp.dataset.price);
  const v = Number(inp.value);
  if (inp.value === "" || !Number.isInteger(v) || v < 0 || v > 100000) {
    toast("Use a whole number of rupees, like 280.", "err");
    inp.value = Number(m.price);
    return;
  }
  if (v === Number(m.price)) return;
  if (!confirm(`Change ${m.name}\n${rupee(m.price)} → ${rupee(v)}?\n\nGuests see the new price on their next order. Past bills don't change.`)) {
    inp.value = Number(m.price);
    return;
  }
  inp.disabled = true;
  const ok = await act(null, () => sb.rpc("set_item_price", { p_item: m.id, p_price: v }), `${m.name} is now ${rupee(v)}`);
  inp.disabled = false;
  const row = inp.closest(".mrow");
  if (ok) {
    m.price = v;
    row.classList.add("is-saved");
    setTimeout(() => row.classList.remove("is-saved"), 1500);
    if (!$(`[data-hist="${CSS.escape(m.id)}"]`).hidden) showHistory(m.id); // keep an open history up to date
  } else inp.value = Number(m.price);
});
// Enter saves (leaving the box fires "change"); Escape puts the old price back
$("[data-menu]").addEventListener("keydown", (e) => {
  const inp = e.target.closest("[data-price]");
  if (!inp) return;
  if (e.key === "Enter") inp.blur();
  if (e.key === "Escape") {
    inp.value = Number(menu.find((x) => x.id === inp.dataset.price).price);
    inp.blur();
  }
});
$("[data-menu]").addEventListener("click", async (e) => {
  const ed = e.target.closest("[data-edit]");
  if (ed) return openDish(ed.dataset.edit);
  const rs = e.target.closest("[data-restore]");
  if (rs) {
    const name = plainName(menu.find((m) => baseOf(m.id) === rs.dataset.restore));
    if (!confirm(`Put ${name} back on the menu?\n\nIt comes back with its old price, switched on.`)) return;
    if (await act(rs, () => sb.rpc("restore_dish", { p_base: rs.dataset.restore }), `${name} is back on the menu`)) loadMenu();
    return;
  }
  const b = e.target.closest("[data-history]");
  if (!b) return;
  const h = $(`[data-hist="${CSS.escape(b.dataset.history)}"]`);
  if (!h.hidden) return (h.hidden = true);
  showHistory(b.dataset.history);
});
let staffNames = null;
async function showHistory(id) {
  const h = $(`[data-hist="${CSS.escape(id)}"]`);
  h.hidden = false;
  h.textContent = "Loading…";
  const [{ data, error }, people] = await Promise.all([
    sb.from("menu_price_history").select("old_price, new_price, changed_by, changed_at").eq("item_id", id).order("changed_at", { ascending: false }).limit(10),
    staffNames ? null : sb.from("staff").select("user_id, name"),
  ]);
  if (people?.data) staffNames = Object.fromEntries(people.data.map((p) => [p.user_id, p.name]));
  if (error) return (h.textContent = "Couldn't load the history.");
  const when = (iso) => new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
  h.innerHTML = data?.length
    ? `<ul>${data
        .map((r) => `<li><span>${when(r.changed_at)}</span><b>${r.old_price == null ? "" : rupee(r.old_price) + " → "}${rupee(r.new_price)}</b><span>${esc(staffNames?.[r.changed_by] || "System")}</span></li>`)
        .join("")}</ul>`
    : `<p>No price changes yet. Changes from now on are kept here.</p>`;
}

// ---------------------------------------------------------------- numbers
let days = 0;
$$("[data-days]").forEach((b) =>
  b.addEventListener("click", () => {
    days = Number(b.dataset.days);
    $$("[data-days]").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
    loadNumbers();
  })
);
const bars = (rows) => {
  if (!rows.length) return `<p class="soft">Nothing yet.</p>`;
  const max = Math.max(...rows.map((r) => r.v), 1);
  return rows.map((r) => `<div class="hb"><span>${esc(r.k)}</span><i style="--w:${(r.v / max) * 100}%"></i><b>${esc(r.label)}</b></div>`).join("");
};
let numbersData = null;
async function loadNumbers() {
  const since = dayStart(days);
  const [pay, ses, items] = await Promise.all([
    sb.from("payments").select("amount, method, created_at").eq("branch_id", branch).gte("created_at", since).limit(20000),
    sb.from("table_sessions").select("table_label, total, guests, guests_max, status, opened_at").eq("branch_id", branch).gte("opened_at", since).limit(20000),
    sb.from("order_items").select("name, qty, unit_price, unavailable_at, orders!inner(branch_id, created_at, status)").eq("orders.branch_id", branch).gte("orders.created_at", since).neq("orders.status", "cancelled").limit(50000),
  ]);
  const P = pay.data || [];
  const S = ses.data || [];
  const I = (items.data || []).filter((i) => !i.unavailable_at);
  const sales = P.reduce((a, p) => a + Number(p.amount), 0);
  const guests = S.reduce((a, s) => a + (s.guests_max || s.guests || 0), 0);
  const kpi = (l, v, s = "") => `<div class="kpi"><span>${l}</span><b>${v}</b>${s ? `<small>${s}</small>` : ""}</div>`;
  $("[data-nkpis]").innerHTML = [
    kpi("Sales", rupee(sales)),
    kpi("Tables", S.length, `${guests} guests`),
    kpi("Per head", guests ? rupee(sales / guests) : "–"),
    kpi("Average bill", S.length ? rupee(sales / Math.max(1, S.filter((s) => s.status !== "open").length)) : "–"),
  ].join("");
  const hours = Array(24).fill(0);
  for (const p of P) hours[Number(new Date(p.created_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", hour12: false })) % 24] += Number(p.amount);
  const hmax = Math.max(...hours, 1);
  $("[data-hours]").innerHTML = hours
    .map((v, h) => (h >= 6 ? `<div class="hcol" title="${h % 12 || 12}${h < 12 ? "am" : "pm"}: ${rupee(v)}"><i style="--h:${(v / hmax) * 100}%"></i><small>${h % 3 === 0 ? (h % 12 || 12) + (h < 12 ? "a" : "p") : ""}</small></div>` : ""))
    .join("");
  const by = (arr, key, val) => Object.entries(arr.reduce((m, x) => ((m[key(x)] = (m[key(x)] || 0) + val(x)), m), {})).sort((a, b) => b[1] - a[1]);
  numbersData = {
    sales, guests, tables: S.length, bills: S.filter((s) => s.status !== "open").length, hours,
    methods: by(P, (p) => p.method.toUpperCase(), (p) => Number(p.amount)),
    dishes: by(I, (i) => i.name, (i) => i.qty),
    dishSales: Object.fromEntries(by(I, (i) => i.name, (i) => i.qty * Number(i.unit_price))),
    tablesTop: by(S, (s) => s.table_label, (s) => Number(s.total)),
  };
  $("[data-methods]").innerHTML = bars(by(P, (p) => p.method.toUpperCase(), (p) => Number(p.amount)).map(([k, v]) => ({ k, v, label: rupee(v) })));
  $("[data-top]").innerHTML = bars(by(I, (i) => i.name, (i) => i.qty).slice(0, 8).map(([k, v]) => ({ k, v, label: `${v}` })));
  $("[data-tables-top]").innerHTML = bars(by(S, (s) => "Table " + s.table_label, (s) => Number(s.total)).slice(0, 8).map(([k, v]) => ({ k, v, label: rupee(v) })));
}


// ---------------------------------------------------------------- PDF downloads (every screen, and one table's bill)
// The PDF code is a separate file, fetched the first time someone taps Download.
const branchName = () => branches.find((b) => b.id === branch)?.name || branch;
/** today in Chennai, for file names: 2026-11-13 */
const ymd = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
const STATE_WORD = { free: "Free", wait: "Confirm guests", eat: "Eating", bill: "Wants bill", paid: "Paid" };
const who = (c) => (c ? `${c.name || "Guest"}` : "");
function tableRows() {
  return [...sessions]
    .sort((a, b) => a.table_label.localeCompare(b.table_label, "en", { numeric: true }))
    .map((s) => [s.table_label, STATE_WORD[tableState(s)], who(s.customers) || "-", s.customers ? fmtPhone(s.customers.phone) : "-", s.status !== "paid" && s.pin ? s.pin : "-", s.guests || "-", rupee(s.total), clock(s.opened_at)]);
}
const TABLE_HEAD = ["Table", "Status", "Guest", "Number", "PIN", "People", "Bill", "Since"];
const itemsText = (o) =>
  o.order_items.map((i) => `${i.qty}x ${i.name}${i.spice ? ` (${i.spice})` : ""}${i.parcel ? " (parcel)" : ""}${i.note ? ` - ${i.note}` : ""}${i.unavailable_at ? " [ran out]" : ""}`).join("\n");
const ORDER_WORD = { held: "Waiting for Seated", received: "New", preparing: "Cooking", ready: "Ready to serve" };
const REPORTS = {
  today: () => ({
    title: "Today",
    sections: [
      { kpis: $$("[data-kpis] .kpi").map((k) => [$("span", k).textContent, $("b", k).textContent]) },
      { heading: "Needs attention", head: ["What", "Details"], body: $$("[data-attention] .att").map((a) => [$("b", a).textContent, $("span", a)?.textContent || ""]), empty: "All caught up." },
      { heading: "Tables now", head: TABLE_HEAD, body: tableRows(), align: { 6: "right" }, empty: "No tables in use." },
    ],
  }),
  orders: () => ({
    title: "Kitchen orders",
    sections: [
      { text: `${orders.length} open orders · ${orders.filter((o) => ["received", "preparing"].includes(o.status) && mins(o.created_at) >= 20).length} running late (20+ min)` },
      {
        head: ["Time", "Table", "Order", "Guest", "Number", "Items", "Status"],
        body: orders.map((o) => [clock(o.created_at), o.table_label, "#" + o.code, who(o.customers) || "-", o.customers ? fmtPhone(o.customers.phone) : "-", itemsText(o), ORDER_WORD[o.status] || o.status]),
        empty: "No open orders.",
      },
    ],
  }),
  tables: () => ({
    title: "Tables",
    sections: [
      { kpis: [["Tables busy", `${sessions.filter((s) => s.status !== "paid").length} of ${tables.length}`], ["Guests in", String(sessions.filter((s) => s.status !== "paid").reduce((a, s) => a + (s.guests || 0), 0))], ["Open bills", rupee(sessions.filter((s) => s.status !== "paid").reduce((a, s) => a + Number(s.total), 0))]] },
      { heading: "Tables in use", head: TABLE_HEAD, body: tableRows(), align: { 6: "right" }, empty: "No tables in use." },
      { heading: "Free tables", head: ["Tables"], body: [[tables.filter((l) => !sessions.some((s) => s.table_label === l)).join(", ") || "None"]] },
    ],
  }),
  guests: () =>
    gView === "today"
      ? {
          title: "Guests today",
          sections: [
            { text: $("[data-guests] p")?.textContent || "" },
            {
              head: ["Time", "Table", "Guest", "Number", "PIN", "People", "Orders", "Bill", "Status"],
              body: gRows.map((v) => [clock(v.opened_at), v.table_label, v.people.map((c) => c.name || "Guest").join("\n") || "-", v.people.map((c) => fmtPhone(c.phone)).join("\n") || "-", ["open", "bill_requested"].includes(v.status) && v.pin ? v.pin : "-", v.guests_max || v.guests || "-", v.nOrders, rupee(v.total), STATUS[v.status] || v.status]),
              align: { 7: "right" },
              foot: ["", "", "", "", "", gRows.reduce((a, v) => a + (v.guests_max || v.guests || 0), 0), gRows.reduce((a, v) => a + v.nOrders, 0), rupee(gRows.reduce((a, v) => a + Number(v.total), 0)), ""],
              empty: "No guests yet today.",
            },
          ],
        }
      : {
          title: "All customers",
          sections: [
            { text: `${gRows.length} customers${$("[data-g-search]").value.trim() ? ` matching "${$("[data-g-search]").value.trim()}"` : ""}, newest first.` },
            {
              head: ["Name", "Number", "Visits", "Orders", "Spent", "First visit", "Last visit", "Branch"],
              body: gRows.map((c) => [c.name || "-", fmtPhone(c.phone), c.visits, c.orders, rupee(c.spent), shortDay(c.first_seen), c.last_order ? shortDay(c.last_order) : "-", branches.find((b) => b.id === c.last_branch)?.name || c.last_branch || ""]),
              align: { 2: "right", 3: "right", 4: "right" },
            },
          ],
        },
  menu: () => {
    const live = menu.filter((m) => !m.deleted_at);
    const rank = (c) => categories.findIndex((x) => x.id === c) + 1 || 999;
    const rows = [...live].sort((a, b) => rank(a.category) - rank(b.category) || (a.sort ?? 0) - (b.sort ?? 0) || a.name.localeCompare(b.name));
    return {
      title: "Menu and prices",
      sections: [
        { text: `${live.length} choices on the menu · ${live.filter((m) => !m.available).length} switched off` },
        { head: ["Category", "Dish", "Type", "Price", "Today"], body: rows.map((m) => [catName(m.category), m.name, DIETS[m.diet] || "", rupee(m.price), m.available ? "On" : "Sold out"]), align: { 3: "right" } },
      ],
    };
  },
  numbers: () => {
    const d = numbersData;
    const range = { 0: "Today", 6: "Last 7 days", 29: "Last 30 days" }[days] || "";
    if (!d) return null;
    return {
      title: `Numbers - ${range}`,
      sections: [
        { kpis: [["Sales", rupee(d.sales)], ["Tables", `${d.tables} (${d.guests} guests)`], ["Per head", d.guests ? rupee(d.sales / d.guests) : "-"], ["Average bill", d.tables ? rupee(d.sales / Math.max(1, d.bills)) : "-"]] },
        { heading: "How guests paid", head: ["Method", "Amount", "Share"], body: d.methods.map(([k, v]) => [k, rupee(v), d.sales ? Math.round((v / d.sales) * 100) + "%" : "-"]), align: { 1: "right", 2: "right" }, foot: ["Total", rupee(d.sales), ""], empty: "No payments." },
        { heading: "Sales by hour", head: ["Hour", "Sales"], body: d.hours.map((v, h) => [v, h]).filter(([v]) => v > 0).map(([v, h]) => [`${h % 12 || 12} ${h < 12 ? "am" : "pm"}`, rupee(v)]), align: { 1: "right" }, empty: "No sales." },
        { heading: "Dishes sold", head: ["Dish", "Qty", "Sales"], body: d.dishes.map(([k, v]) => [k, v, rupee(d.dishSales[k] || 0)]), align: { 1: "right", 2: "right" }, empty: "No dishes sold." },
        { heading: "Tables", head: ["Table", "Takings"], body: d.tablesTop.map(([k, v]) => ["Table " + k, rupee(v)]), align: { 1: "right" } },
      ],
    };
  },
};
let pdfLib = null;
async function downloadPdf(btn, report, file) {
  if (!report) return toast("Open the screen first, then download.", "err");
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Preparing…";
  try {
    pdfLib ||= await import("./staff-pdf.js");
    pdfLib.makePdf({ ...report, place: `${branchName()} branch`, by: `${me.name} (${ROLE[me.role]})`, file });
    toast("PDF downloaded");
  } catch (e) {
    console.error(e);
    toast("Couldn't make the PDF. Check the connection and try again.", "err");
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-pdf]");
  if (!b) return;
  const k = b.dataset.pdf;
  const name = k === "guests" && gView === "all" ? "customers" : k;
  downloadPdf(b, REPORTS[k](), `pandias-${branch}-${name}-${ymd()}.pdf`);
});
// one table's bill
$("[data-p-pdf]").addEventListener("click", (e) => {
  const s = openSession;
  if (!s) return;
  const lines = (s.list || []).filter((x) => x.status !== "cancelled").flatMap((x) => x.order_items.filter((i) => !i.unavailable_at));
  const people = [];
  for (const c of [s.customers, ...(s.list || []).map((x) => x.customers)]) if (c && !people.some((q) => q.phone === c.phone)) people.push(c);
  const rate = branches.find((b) => b.id === branch)?.tax_percent ?? 5;
  const body = [["Subtotal", rupee(s.subtotal)]];
  if (Number(s.discount)) body.push(["Discount", "-" + rupee(s.discount)]);
  body.push([`GST ${Number(rate)}%`, rupee(s.tax)]);
  downloadPdf(
    e.currentTarget,
    {
      title: `Bill - Table ${s.table_label}`,
      sections: [
        { kpis: [["Table", s.table_label], ["Guests", String(s.guests || "-")], ["Since", clock(s.opened_at)], ["Status", STATE_WORD[tableState(s)]]] },
        { text: people.length ? "Guest: " + people.map((c) => `${c.name || "Guest"}, ${fmtPhone(c.phone)}`).join("; ") : "" },
        { heading: "Items", head: ["Item", "Qty", "Price", "Amount"], body: lines.map((i) => [`${i.name}${i.parcel ? " (parcel)" : ""}`, i.qty, rupee(i.unit_price), rupee(i.qty * i.unit_price + Number(i.parcel_fee || 0))]), align: { 1: "right", 2: "right", 3: "right" } },
        { head: null, body, foot: ["Total", rupee(s.total)], align: { 1: "right" } },
      ],
    },
    `pandias-${branch}-table-${s.table_label}-${ymd()}.pdf`
  );
});

// ---------------------------------------------------------------- sound needs one tap (browser rule)
$("[data-sound]").addEventListener("click", async (e) => {
  await sound.enable();
  sound.chime();
  e.currentTarget.textContent = "Sound on";
  e.currentTarget.classList.add("is-on");
});

boot();
