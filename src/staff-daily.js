// Hotel Pandia's staff app: daily-work features.
//   Take order  captain mode: a waiter (or desk / manager) orders for a table on their phone
//   Takeaway    pre-orders from the website: accept, cook, hand over, pay at the desk
//   Feedback    every rating, low ones first; resolve with a note
//   Reports     month / quarter / year / custom, change vs last period and last year,
//               branch comparison, dishes (and dishes that never sold), kitchen timing; Excel + PDF
//   Loyalty     settings for the owner (stamps are given by the database when a bill is paid)
// Every rule is checked again by the database.

export function initDaily(c) {
  const { sb, $, $$, esc, rupee, toast, act, friendly, clock } = c;
  const istToday = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
  const addDays = (ymd, n) => new Date(Date.parse(ymd + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
  const istStart = (ymd) => new Date(ymd + "T00:00:00+05:30").toISOString();
  const dayLabel = (ymd) => new Date(ymd + "T12:00:00+05:30").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
  const when = (iso) => new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  const bname = (id) => c.branches.find((b) => b.id === id)?.name || id || "";
  const isOwner = () => c.me.role === "admin";
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (x) => (x ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (x / 4)))).toString(16)));
  function modal(title, sub, body, cls = "") {
    const d = document.createElement("dialog");
    d.className = "panel " + cls;
    d.innerHTML = `<header class="panel__head"><div><h2>${esc(title)}</h2>${sub ? `<p class="soft">${esc(sub)}</p>` : ""}</div><button type="button" class="x" data-x aria-label="Close">×</button></header><div class="panel__body">${body}</div>`;
    document.body.append(d);
    d.addEventListener("close", () => d.remove());
    d.addEventListener("click", (e) => (e.target === d || e.target.closest("[data-x]")) && d.close());
    d.showModal();
    return d;
  }
  function csv(rows, file) {
    const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const blob = new Blob(["﻿" + rows.map((r) => r.map(cell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = file;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---------- screens
  const SCREENS = {
    feedback: { roles: ["admin", "manager"], label: "Feedback", icon: '<path d="M4 5h16v11H9l-5 4z"/><path d="M9 10h6"/>' },
    reports: { roles: ["admin", "manager"], label: "Reports", icon: '<path d="M4 20V4M4 20h16"/><path d="M8 16l4-5 3 3 5-7"/>' },
  };
  const numbersTab = $('[data-tab="numbers"]');
  for (const [k, s] of Object.entries(SCREENS).reverse()) {
    numbersTab.insertAdjacentHTML("afterend", `<a href="#${k}" data-tab="${k}"><svg viewBox="0 0 24 24">${s.icon}</svg><span>${s.label}</span><b class="badge" data-badge="${k}" hidden></b></a>`);
  }
  const pdfBtn = (k) => `<button type="button" class="btn btn--line btn--sm btn--pdf" data-pdf="${k}">Download PDF</button>`;
  $(".main").insertAdjacentHTML(
    "beforeend",
    `<section class="screen" data-screen="feedback" hidden>
      <header class="bar"><div><h1>Feedback</h1><p class="soft" data-f-sum></p></div><div class="bar__tools">${pdfBtn("feedback")}</div></header>
      <div class="menutools"><div class="seg" data-f-view><button type="button" data-fv="open" aria-selected="true">Needs a reply</button><button type="button" data-fv="low" aria-selected="false">Low (1–3★)</button><button type="button" data-fv="all" aria-selected="false">All</button></div>
        <select data-f-days aria-label="Period"><option value="7">7 days</option><option value="30" selected>30 days</option><option value="90">90 days</option><option value="365">12 months</option></select></div>
      <div data-feedback></div>
    </section>
    <section class="screen" data-screen="reports" hidden>
      <header class="bar"><div><h1>Reports</h1><p class="soft" data-r-sum></p></div><div class="bar__tools"><button type="button" class="btn btn--line btn--sm" data-r-xls>Excel</button>${pdfBtn("reports")}</div></header>
      <div class="rangebar">
        <div class="seg seg--wrap" data-r-kind><button type="button" data-rk="month" aria-selected="true">Month</button><button type="button" data-rk="quarter" aria-selected="false">Quarter</button><button type="button" data-rk="year" aria-selected="false">Year</button><button type="button" data-rk="custom" aria-selected="false">Custom</button></div>
        <select data-r-pick aria-label="Period"></select>
        <span data-r-custom hidden><label class="rangebar__pick">From <input type="date" data-r-from></label> <label class="rangebar__pick">To <input type="date" data-r-to></label></span>
        <label class="switchlab" data-r-allwrap hidden><input type="checkbox" data-r-all> All branches</label>
      </div>
      <div data-reports><p class="soft">Loading…</p></div>
    </section>`
  );

  // =====================================================================================
  // MENU (for taking orders)
  let menu = null;
  let menuBranch = "";
  let cats = [];
  let combos = {}; // item id -> [{ id, qty }] (for kitchen tickets)
  async function loadMenu() {
    if (menu && menuBranch === c.branch) return;
    const [m, k, now] = await Promise.all([
      sb.from("menu_items").select("id, name, category, price, available, diet, sort, combo").is("deleted_at", null).order("sort").order("name"),
      sb.from("menu_categories").select("id, name, sort").order("sort"),
      sb.rpc("menu_prices", { p_branch: c.branch }),
    ]);
    // this branch, right now: branch price, offers, sold out here, serving hours
    const live = Object.fromEntries((now.data || []).map((x) => [x.id, x]));
    menu = (m.data || []).map((x) => ({ ...x, price: live[x.id]?.price ?? x.price, list: live[x.id]?.list ?? x.price, available: live[x.id] ? live[x.id].available : x.available, reason: live[x.id]?.reason, offer: live[x.id]?.offer }));
    menuBranch = c.branch;
    combos = Object.fromEntries((m.data || []).filter((x) => x.combo).map((x) => [x.id, x.combo]));
    cats = k.data || [];
    setTimeout(() => (menu = null), 5 * 60e3); // refresh prices / sold-out every few minutes
  }

  // =====================================================================================
  // TAKE ORDER (captain mode)
  const canTake = () => ["admin", "manager", "cashier", "waiter"].includes(c.me.role);
  async function takeOrder(table, session) {
    if (!canTake()) return;
    await loadMenu();
    const cart = new Map(); // id -> { item, qty, spice, note, parcel }
    const isNew = !session;
    let guests = session?.guests || 2;
    let cat = "";
    const d = modal(`Table ${table}`, isNew ? "New table · the order goes straight to the kitchen" : `Adding to the bill${session.customers?.name ? " · " + session.customers.name : ""}`, `
      <div class="to">
        ${isNew ? `<div class="to__guests"><span>Guests</span><div class="stepper"><button type="button" data-g="-1" aria-label="One less">−</button><span><b data-gn>${guests}</b></span><button type="button" data-g="1" aria-label="One more">+</button></div>
          <input data-to-name maxlength="60" placeholder="Guest name (optional)" autocomplete="off"><input data-to-phone inputmode="tel" maxlength="14" placeholder="Mobile (optional)" autocomplete="off"></div>` : ""}
        <input type="search" data-to-q placeholder="Find a dish…" aria-label="Find a dish">
        <div class="to__cats" data-to-cats></div>
        <div class="to__list" data-to-list></div>
        <div class="to__cart" data-to-cart hidden></div>
        <div class="to__foot"><input data-to-note maxlength="200" placeholder="Note for the kitchen (optional)"><button type="button" class="btn btn--gold" data-to-send disabled>Send to kitchen</button></div>
      </div>`, "panel--tall");
    const catIds = [...new Set(menu.map((m) => m.category))];
    $("[data-to-cats]", d).innerHTML = `<button type="button" class="chip is-on" data-cat="">All</button>` + cats.filter((k) => catIds.includes(k.id)).map((k) => `<button type="button" class="chip" data-cat="${esc(k.id)}">${esc(k.name)}</button>`).join("");
    const paintList = () => {
      const q = $("[data-to-q]", d).value.trim().toLowerCase();
      const list = menu.filter((m) => (!cat || m.category === cat) && (!q || m.name.toLowerCase().includes(q))).slice(0, 120);
      $("[data-to-list]", d).innerHTML = list
        .map((m) => {
          const n = cart.get(m.id)?.qty || 0;
          return `<div class="to__row ${m.available ? "" : "is-off"}" data-id="${esc(m.id)}"><i class="dd dd--${m.diet}"></i><span>${esc(m.name)}</span><b>${m.list > m.price ? `<s class="soft">${rupee(m.list)}</s> ` : ""}${rupee(m.price)}</b>${
            m.available
              ? n
                ? `<span class="to__qty"><button type="button" data-q="-1" aria-label="One less">−</button><output>${n}</output><button type="button" data-q="1" aria-label="One more">+</button></span>`
                : `<button type="button" class="btn btn--line btn--sm" data-q="1">Add</button>`
              : `<em>${m.reason === "not_now" ? "Not now" : m.reason === "not_today" ? "Not today" : "Sold out"}</em>`
          }</div>`;
        })
        .join("") || `<p class="soft">Nothing matches.</p>`;
    };
    const paintCart = () => {
      const lines = [...cart.values()];
      const count = lines.reduce((a, l) => a + l.qty, 0);
      const total = lines.reduce((a, l) => a + l.qty * l.item.price, 0);
      $("[data-to-cart]", d).hidden = !lines.length;
      $("[data-to-cart]", d).innerHTML = lines
        .map(
          (l) => `<div class="to__line" data-id="${esc(l.item.id)}"><b>${l.qty} × ${esc(l.item.name)}</b>
          <span class="to__opts"><select data-spice aria-label="Spice"><option value="">Spice: usual</option><option value="mild" ${l.spice === "mild" ? "selected" : ""}>Mild</option><option value="medium" ${l.spice === "medium" ? "selected" : ""}>Medium</option><option value="spicy" ${l.spice === "spicy" ? "selected" : ""}>Spicy</option></select>
          <label class="switchlab"><input type="checkbox" data-parcel ${l.parcel ? "checked" : ""}> Parcel</label>
          <input data-lnote maxlength="120" placeholder="Note (allergy, no onion…)" value="${esc(l.note)}"></span></div>`
        )
        .join("");
      const btn = $("[data-to-send]", d);
      btn.disabled = !count;
      btn.textContent = count ? `Send ${count} item${count > 1 ? "s" : ""} · ${rupee(total)}` : "Send to kitchen";
    };
    d.addEventListener("click", (e) => {
      const g = e.target.closest("[data-g]");
      if (g) return ($("[data-gn]", d).textContent = String((guests = Math.max(1, Math.min(60, guests + Number(g.dataset.g))))));
      const k = e.target.closest("[data-cat]");
      if (k) {
        cat = k.dataset.cat;
        $$("[data-cat]", d).forEach((x) => x.classList.toggle("is-on", x === k));
        return paintList();
      }
      const q = e.target.closest("[data-q]");
      if (q) {
        const id = q.closest("[data-id]").dataset.id;
        const item = menu.find((m) => m.id === id);
        const l = cart.get(id) || { item, qty: 0, spice: "", note: "", parcel: false };
        l.qty = Math.max(0, Math.min(30, l.qty + Number(q.dataset.q)));
        if (l.qty) cart.set(id, l);
        else cart.delete(id);
        navigator.vibrate?.(8);
        paintList();
        paintCart();
      }
    });
    d.addEventListener("input", (e) => {
      if (e.target.matches("[data-to-q]")) return paintList();
      const line = e.target.closest(".to__line");
      if (!line) return;
      const l = cart.get(line.dataset.id);
      if (e.target.matches("[data-spice]")) l.spice = e.target.value;
      if (e.target.matches("[data-parcel]")) l.parcel = e.target.checked;
      if (e.target.matches("[data-lnote]")) l.note = e.target.value;
    });
    const key = uuid(); // the same key on a retry, so a double tap never sends two orders
    $("[data-to-send]", d).addEventListener("click", async (e) => {
      const lines = [...cart.values()].map((l) => ({ id: l.item.id, qty: l.qty, spice: l.spice, note: l.note, parcel: l.parcel }));
      const ok = await act(e.currentTarget, () =>
        sb.rpc("staff_place_order", {
          p_branch: c.branch, p_table: table, p_lines: lines, p_guests: isNew ? guests : null,
          p_name: $("[data-to-name]", d)?.value || null, p_phone: $("[data-to-phone]", d)?.value || null,
          p_note: $("[data-to-note]", d).value || null, p_key: key,
        }), `Sent to the kitchen · Table ${table}`);
      if (ok) {
        d.close();
        c.reload();
      }
    });
    paintList();
    paintCart();
    $("[data-to-q]", d).focus();
  }

  // =====================================================================================
  // TAKEAWAY (pre-orders)
  const TA_STATE = (s, orders) => {
    const os = orders.filter((o) => o.session_id === s.id);
    if (os.some((o) => o.status === "held")) return ["wait", "New · accept it"];
    if (s.status === "paid") return ["paid", "Paid · hand over"];
    if (os.some((o) => o.status === "ready")) return ["bill", "Ready for pickup"];
    if (os.some((o) => ["received", "preparing"].includes(o.status))) return ["eat", "Cooking"];
    return ["eat", "Collected?"];
  };
  function takeawayHTML(list, orders) {
    if (!list.length) return "";
    return `<h2 class="h2">Takeaway <small>${list.length}</small></h2><div class="tas">${list
      .sort((a, b) => Date.parse(a.pickup_at) - Date.parse(b.pickup_at))
      .map((s) => {
        const [st, word] = TA_STATE(s, orders);
        const mins = Math.round((Date.parse(s.pickup_at) - Date.now()) / 60000);
        return `<div class="ta tile--${st}"><div><b>${clock(s.pickup_at)}</b><span class="soft small">${mins > 0 ? `in ${mins} min` : mins > -1 ? "now" : `${-mins} min ago`}</span></div>
          <p><b>${esc(s.customers?.name || "Guest")}</b> ${c.telLink(s.customers?.phone)}</p>
          <p class="small">${esc(word)} · ${rupee(s.total)}</p>
          <div class="person__go">${st === "wait" ? `<button type="button" class="btn btn--gold btn--sm" data-ta-accept="${s.id}">Accept</button>` : ""}<button type="button" class="btn btn--line btn--sm" data-open="${s.id}">Open</button></div></div>`;
      })
      .join("")}</div>`;
  }
  document.addEventListener("click", async (e) => {
    const a = e.target.closest("[data-ta-accept]");
    if (!a) return;
    e.stopPropagation();
    if (!confirm("Accept this takeaway and send it to the kitchen?\n\nIf it looks wrong, call the guest first.")) return;
    if (await act(a, () => sb.rpc("confirm_seated", { p_session: a.dataset.taAccept, p_guests: null }), "Accepted · sent to the kitchen")) c.reload();
  });

  // =====================================================================================
  // LOYALTY (shown inside the table panel; settings in Setup for the owner)
  let loyalty = null;
  async function loyaltySettings(force) {
    if (!loyalty || force) loyalty = (await sb.from("loyalty_settings").select("*").eq("id", 1).maybeSingle()).data;
    return loyalty;
  }
  async function loyaltyHTML(session) {
    const l = await loyaltySettings();
    const cust = session.customers;
    if (!l?.active || !cust) return "";
    const n = Number(cust.stamps || 0);
    const ready = n >= l.stamps_needed;
    const canGive = ["admin", "manager", "cashier"].includes(c.me.role);
    return `<div class="loyal ${ready ? "is-ready" : ""}"><span class="loyal__stamps">${Array.from({ length: l.stamps_needed }, (_, i) => `<i class="${i < n ? "on" : ""}"></i>`).join("")}</span>
      <span>${ready ? `<b>Reward ready: ${esc(l.reward)}</b>` : `${n} of ${l.stamps_needed} stamps · ${esc(l.reward)} at ${l.stamps_needed}`}</span>
      ${ready && canGive ? `<button type="button" class="btn btn--gold btn--sm" data-reward="${session.id}">Give reward</button>` : ""}</div>`;
  }
  document.addEventListener("click", async (e) => {
    const r = e.target.closest("[data-reward]");
    if (!r) return;
    const l = await loyaltySettings();
    if (!confirm(`Give the reward now: ${l.reward}?\n\nThis uses ${l.stamps_needed} stamps.`)) return;
    if (await act(r, () => sb.rpc("give_reward", { p_session: r.dataset.reward }), `Reward given: ${l.reward}`)) c.reload();
  });
  async function loyaltyCard() {
    const l = await loyaltySettings(true);
    if (!l) return "";
    return `<div class="card" data-loyal-card><h2 class="h3">Loyalty stamps</h2>
      <p class="soft small">Guests get one stamp for each paid visit over the minimum bill (one a day, linked to their mobile). The desk sees when a reward is ready.</p>
      <form class="dform dform--row" data-loyal-form>
        <label class="switchlab"><input type="checkbox" name="active" ${l.active ? "checked" : ""}> On</label>
        <label>Stamps needed<input name="needed" type="number" min="2" max="20" value="${l.stamps_needed}"></label>
        <label>Minimum bill ₹<input name="min" type="number" min="0" step="10" value="${Number(l.min_bill)}"></label>
        <label>Reward<input name="reward" maxlength="80" value="${esc(l.reward)}"></label>
        <button type="submit" class="btn btn--dark btn--sm">Save</button>
      </form></div>`;
  }
  document.addEventListener("submit", async (e) => {
    if (!e.target.matches("[data-loyal-form]")) return;
    e.preventDefault();
    const f = e.target;
    if (await act($("button", f), () => sb.rpc("set_loyalty", { p_active: f.active.checked, p_needed: Number(f.needed.value), p_min: Number(f.min.value), p_reward: f.reward.value }), "Loyalty saved")) loyaltySettings(true);
  });

  // =====================================================================================
  // FEEDBACK
  let fb = [];
  let fView = "open";
  async function loadFeedback() {
    const days = Number($("[data-f-days]").value);
    const { data, error } = await sb
      .from("feedback")
      .select("id, branch_id, table_label, rating, food, service, comment, name, phone, created_at, google_clicked_at, resolved_at, resolved_by, resolution_note")
      .eq("branch_id", c.branch)
      .gte("created_at", new Date(Date.now() - days * 864e5).toISOString())
      .order("created_at", { ascending: false })
      .limit(2000);
    if (error) return ($("[data-feedback]").innerHTML = `<p class="calm">${esc(friendly(error))}</p>`);
    fb = data || [];
    paintFeedback();
  }
  const fRows = () => fb.filter((f) => fView === "all" || (fView === "low" ? f.rating <= 3 : f.rating <= 3 && !f.resolved_at));
  const stars = (n) => (n ? "★".repeat(n) + "☆".repeat(5 - n) : "–");
  function paintFeedback() {
    const n = fb.length;
    const avg = n ? fb.reduce((a, f) => a + f.rating, 0) / n : 0;
    const open = fb.filter((f) => f.rating <= 3 && !f.resolved_at).length;
    $("[data-f-sum]").textContent = n ? `${n} ratings · average ${avg.toFixed(1)}★ · ${fb.filter((f) => f.google_clicked_at).length} went to Google · ${open} need a reply` : "No ratings in this period.";
    const list = fRows();
    $("[data-feedback]").innerHTML = list.length
      ? `<div class="fbs">${list
          .map(
            (f) => `<div class="fb ${f.rating <= 3 ? "is-low" : ""} ${f.resolved_at ? "is-done" : ""}">
          <div class="fb__head"><b class="fb__stars">${stars(f.rating)}</b><span class="soft small">${when(f.created_at)} · Table ${esc(f.table_label)}</span></div>
          <p class="small soft">Food ${stars(f.food)} · Service ${stars(f.service)}</p>
          ${f.comment ? `<p class="fb__c">“${esc(f.comment)}”</p>` : ""}
          ${f.name || f.phone ? `<p class="small"><b>${esc(f.name || "Guest")}</b> ${f.phone ? c.telLink(f.phone.startsWith("+") ? f.phone : "+91" + f.phone.replace(/\D/g, "").slice(-10)) : ""}</p>` : ""}
          ${f.resolved_at ? `<p class="small ok">Resolved ${when(f.resolved_at)}${f.resolution_note ? ` · ${esc(f.resolution_note)}` : ""}</p>` : f.rating <= 3 ? `<button type="button" class="btn btn--dark btn--sm" data-fb-resolve="${f.id}">Mark resolved</button>` : ""}
        </div>`
          )
          .join("")}</div>`
      : `<div class="calm"><b>${fView === "open" ? "Nothing waiting for a reply." : "No ratings here."}</b><span>Low ratings (1–3★) show up here until someone resolves them.</span></div>`;
    c.setBadge("feedback", open);
  }
  $$("[data-fv]").forEach((b) =>
    b.addEventListener("click", () => {
      fView = b.dataset.fv;
      $$("[data-fv]").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
      paintFeedback();
    })
  );
  $("[data-f-days]").addEventListener("change", loadFeedback);
  $("[data-feedback]").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-fb-resolve]");
    if (!b) return;
    const note = prompt("What did you do? (e.g. called the guest, apologised, offered a free dessert next visit)");
    if (note === null) return;
    if (note.trim().length < 3) return toast("Add a short note.", "err");
    if (await act(b, () => sb.rpc("resolve_feedback", { p_id: b.dataset.fbResolve, p_note: note.trim() }), "Marked resolved")) loadFeedback();
  });
  const feedbackReport = () => ({
    title: "Feedback",
    sections: [{ text: $("[data-f-sum]").textContent }, { head: ["When", "Table", "Rating", "Food", "Service", "Comment", "Guest", "Resolved"], body: fRows().map((f) => [when(f.created_at), f.table_label, f.rating, f.food || "-", f.service || "-", f.comment || "", f.name || "", f.resolved_at ? f.resolution_note || "yes" : ""]) }],
    file: "feedback",
  });
  /** for Today: unresolved low ratings in the last 2 days */
  async function lowRatingsToday() {
    if (!["admin", "manager"].includes(c.me.role)) return [];
    const { data } = await sb.from("feedback").select("id, table_label, rating, comment, created_at").eq("branch_id", c.branch).lte("rating", 3).is("resolved_at", null).gte("created_at", new Date(Date.now() - 2 * 864e5).toISOString());
    c.setBadge("feedback", (data || []).length);
    return data || [];
  }

  // =====================================================================================
  // REPORTS
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  let rKind = "month";
  let report = null;
  function fillPicker() {
    const t = istToday();
    const y = Number(t.slice(0, 4));
    const m = Number(t.slice(5, 7));
    const opts = [];
    if (rKind === "month") for (let i = 0; i < 24; i++) { const d = new Date(Date.UTC(y, m - 1 - i, 1)); opts.push([d.toISOString().slice(0, 7), `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}${i === 0 ? " (so far)" : ""}`]); }
    if (rKind === "quarter") {
      // Indian financial year quarters: Q1 Apr–Jun … Q4 Jan–Mar
      const fyStart = m >= 4 ? y : y - 1;
      for (let fy = fyStart; fy > fyStart - 3; fy--) for (let q = 4; q >= 1; q--) {
        const startMonth = [4, 7, 10, 1][q - 1];
        const startYear = q === 4 ? fy + 1 : fy;
        const start = `${startYear}-${String(startMonth).padStart(2, "0")}-01`;
        if (start > t) continue;
        opts.push([start, `Q${q} FY ${fy}-${String(fy + 1).slice(2)} (${MONTHS[startMonth - 1]}–${MONTHS[startMonth + 1]} ${startYear})`]);
      }
    }
    if (rKind === "year") {
      const fyStart = m >= 4 ? y : y - 1;
      for (let fy = fyStart; fy > fyStart - 3; fy--) opts.push([`fy${fy}`, `FY ${fy}-${String(fy + 1).slice(2)} (Apr–Mar)`]);
      for (let cy = y; cy > y - 3; cy--) opts.push([`cy${cy}`, `${cy} (Jan–Dec)`]);
    }
    $("[data-r-pick]").innerHTML = opts.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join("");
    $("[data-r-pick]").hidden = rKind === "custom";
    $("[data-r-custom]").hidden = rKind !== "custom";
  }
  function period() {
    const t = istToday();
    const v = $("[data-r-pick]").value;
    let f, to, label;
    if (rKind === "month") {
      f = v + "-01";
      to = addDays(new Date(Date.UTC(Number(v.slice(0, 4)), Number(v.slice(5, 7)), 1)).toISOString().slice(0, 10), -1);
    } else if (rKind === "quarter") {
      f = v;
      to = addDays(new Date(Date.UTC(Number(v.slice(0, 4)), Number(v.slice(5, 7)) + 2, 1)).toISOString().slice(0, 10), -1);
    } else if (rKind === "year") {
      const yr = Number(v.slice(2));
      [f, to] = v.startsWith("fy") ? [`${yr}-04-01`, `${yr + 1}-03-31`] : [`${yr}-01-01`, `${yr}-12-31`];
    } else {
      f = $("[data-r-from]").value || addDays(t, -29);
      to = $("[data-r-to]").value || t;
      if (f > to) [f, to] = [to, f];
    }
    if (to > t) to = t;
    label = $("[data-r-pick] option:checked")?.textContent || `${dayLabel(f)} – ${dayLabel(to)}`;
    if (rKind === "custom") label = `${dayLabel(f)} – ${dayLabel(to)}`;
    const len = Math.round((Date.parse(to) - Date.parse(f)) / 864e5) + 1;
    return { f, to, label, prev: [addDays(f, -len), addDays(f, -1)], lastYear: [addDays(f, -364), addDays(to, -364)] };
  }
  const SUM_KEYS = ["sales", "cash", "upi", "card", "tables", "guests", "orders", "items", "subtotal", "tax", "discounts", "walkouts", "walkout_amount", "voids", "void_amount", "cancelled_orders", "cant_make", "payments_voided"];
  const total = (rows) => {
    const t = Object.fromEntries(SUM_KEYS.map((k) => [k, 0]));
    for (const r of rows) for (const k of SUM_KEYS) t[k] += Number(r[k] || 0);
    t.days = new Set(rows.map((r) => r.day)).size;
    return t;
  };
  const change = (now, then) => (!then ? (now ? "new" : "–") : `${now >= then ? "▲" : "▼"} ${Math.abs(((now - then) / then) * 100).toFixed(0)}%`);
  async function loadReports() {
    $("[data-r-allwrap]").hidden = !isOwner();
    const all = isOwner() && $("[data-r-all]").checked;
    const p = period();
    $("[data-reports]").innerHTML = `<p class="soft">Loading ${esc(p.label)}…</p>`;
    // today's numbers are recomputed so a report that includes today is current
    if (p.to === istToday()) {
      const ids = all ? c.branches.map((b) => b.id) : [c.branch];
      await Promise.all(ids.map((id) => sb.rpc("refresh_day", { p_branch: id, p_day: p.to })));
    }
    const sums = (f, to) => {
      let q = sb.from("daily_summaries").select("*").gte("day", f).lte("day", to).limit(20000);
      if (!all) q = q.eq("branch_id", c.branch);
      return q;
    };
    let exq = sb.from("expenses").select("branch_id, category, amount, paid_from").gte("day", p.f).lte("day", p.to).is("voided_at", null).limit(20000);
    if (!all) exq = exq.eq("branch_id", c.branch);
    const [cur, prev, ly, dishes, kitchen, items, ex, gst] = await Promise.all([
      sums(p.f, p.to),
      sums(...p.prev),
      sums(...p.lastYear),
      sb.rpc("dish_sales", { p_branch: all ? null : c.branch, p_from: p.f, p_to: p.to }),
      sb.rpc("kitchen_times", { p_branch: all ? null : c.branch, p_from: p.f, p_to: p.to }),
      sb.from("menu_items").select("id, name, category, available").is("deleted_at", null),
      exq,
      sb.from("branches").select("id, name, gstin"),
    ]);
    if (cur.error) return ($("[data-reports]").innerHTML = `<p class="calm">${esc(friendly(cur.error))}</p>`);
    report = { p, all, rows: cur.data || [], now: total(cur.data || []), prev: total(prev.data || []), ly: total(ly.data || []), dishes: dishes.data || [], kitchen: kitchen.data || {}, menu: items.data || [], expenses: ex.data || [], gstin: Object.fromEntries((gst.data || []).map((b) => [b.id, b.gstin])) };
    paintReports();
  }
  function paintReports() {
    const { p, all, rows, now, prev, ly, dishes, kitchen } = report;
    $("[data-r-sum]").textContent = `${p.label}${all ? " · all branches" : " · " + bname(c.branch)} · ${now.days} trading days`;
    const kpi = (l, v, n, pv, lv) => `<div class="kpi"><span>${l}</span><b>${v}</b><small>${change(n, pv)} vs last period · ${change(n, lv)} vs last year</small></div>`;
    const perHead = now.guests ? now.sales / now.guests : 0;
    const avgBill = now.tables ? now.sales / now.tables : 0;
    // daily bars
    const byDay = {};
    for (const r of rows) byDay[r.day] = (byDay[r.day] || 0) + Number(r.sales);
    const days = [];
    for (let d = p.f; d <= p.to; d = addDays(d, 1)) days.push([d, byDay[d] || 0]);
    const max = Math.max(1, ...days.map(([, v]) => v));
    const monthly = days.length > 62;
    let bars = days;
    if (monthly) {
      const m = {};
      for (const [d, v] of days) m[d.slice(0, 7)] = (m[d.slice(0, 7)] || 0) + v;
      bars = Object.entries(m);
    }
    const bmax = Math.max(1, ...bars.map(([, v]) => v));
    // branches
    const byBranch = {};
    for (const r of rows) (byBranch[r.branch_id] ||= []).push(r);
    const branchRows = Object.entries(byBranch).map(([id, rs]) => [id, total(rs)]).sort((a, b) => b[1].sales - a[1].sales);
    const sold = new Set(dishes.filter((d) => Number(d.qty) > 0).map((d) => d.item_id));
    const never = report.menu.filter((m) => !sold.has(m.id) && m.available);
    $("[data-reports]").innerHTML = `
      <div class="kpis">${kpi("Sales", rupee(now.sales), now.sales, prev.sales, ly.sales)}${kpi("Tables", now.tables, now.tables, prev.tables, ly.tables)}${kpi("Guests", now.guests, now.guests, prev.guests, ly.guests)}${kpi("Per head", rupee(perHead), perHead, prev.guests ? prev.sales / prev.guests : 0, ly.guests ? ly.sales / ly.guests : 0)}</div>
      <div class="grid2">
        <div class="card"><h2 class="h3">Sales by ${monthly ? "month" : "day"}</h2><div class="rbars">${bars
          .map(([d, v]) => `<div class="rbar" title="${esc(monthly ? d : dayLabel(d))}: ${rupee(v)}"><i style="--h:${(v / bmax) * 100}%"></i><small>${monthly ? MONTHS[Number(d.slice(5, 7)) - 1] : Number(d.slice(8)) % (days.length > 20 ? 5 : 1) === 0 || days.length <= 10 ? Number(d.slice(8)) : ""}</small></div>`)
          .join("")}</div><p class="soft small">Best day: ${days.length ? (([d, v]) => `${dayLabel(d)}, ${rupee(v)}`)(days.reduce((a, b) => (b[1] > a[1] ? b : a))) : "–"} · average bill ${rupee(avgBill)}</p></div>
        <div class="card"><h2 class="h3">Money</h2><dl class="sum">
          <div><dt>Cash</dt><dd>${rupee(now.cash)}</dd></div><div><dt>UPI</dt><dd>${rupee(now.upi)}</dd></div><div><dt>Card</dt><dd>${rupee(now.card)}</dd></div>
          <div><dt>GST on bills</dt><dd>${rupee(now.tax)}</dd></div><div><dt>Discounts given</dt><dd>${rupee(now.discounts)}</dd></div>
          <div><dt>Walk-outs</dt><dd>${now.walkouts} · ${rupee(now.walkout_amount)}</dd></div><div><dt>Voids</dt><dd>${now.voids} · ${rupee(now.void_amount)}</dd></div>
          <div><dt>Cancelled orders</dt><dd>${now.cancelled_orders}</dd></div><div><dt>“Can't make”</dt><dd>${now.cant_make}</dd></div><div><dt>Payments voided</dt><dd>${now.payments_voided}</dd></div></dl></div>
      </div>
      ${all ? `<h2 class="h2">Branches</h2><table class="gt"><thead><tr><th>Branch</th><th class="num">Sales</th><th class="num">Share</th><th class="num">Tables</th><th class="num">Guests</th><th class="num">Per head</th><th class="num">Discounts</th><th class="num">Walk-outs</th></tr></thead><tbody>${branchRows
        .map(([id, t]) => `<tr><td data-l="Branch"><b>${esc(bname(id))}</b></td><td data-l="Sales" class="num">${rupee(t.sales)}</td><td data-l="Share" class="num">${now.sales ? Math.round((t.sales / now.sales) * 100) : 0}%</td><td data-l="Tables" class="num">${t.tables}</td><td data-l="Guests" class="num">${t.guests}</td><td data-l="Per head" class="num">${rupee(t.guests ? t.sales / t.guests : 0)}</td><td data-l="Discounts" class="num">${rupee(t.discounts)}</td><td data-l="Walk-outs" class="num">${t.walkouts}</td></tr>`)
        .join("")}</tbody></table>` : ""}
      <div class="grid2">
        <div class="card"><h2 class="h3">Kitchen timing</h2>${kitchen.orders ? `<dl class="sum"><div><dt>Average to ready</dt><dd>${kitchen.avgReady} min</dd></div><div><dt>9 in 10 orders ready within</dt><dd>${kitchen.p90Ready} min</dd></div><div><dt>Average to the table</dt><dd>${kitchen.avgServed ?? "–"} min</dd></div><div><dt>Late (20+ min)</dt><dd>${kitchen.late} of ${kitchen.orders}</dd></div></dl>
          ${(kitchen.slowDishes || []).length ? `<p class="soft small" style="margin-top:10px">Slowest: ${kitchen.slowDishes.slice(0, 5).map((d) => `${esc(d.name)} (${d.avgReady} min)`).join(", ")}</p>` : ""}` : `<p class="soft">No timed orders in this period.</p>`}</div>
        <div class="card"><h2 class="h3">Dishes that never sold</h2><p class="soft small">${never.length} dishes on the menu had no orders in this period.</p><p class="small">${never.slice(0, 40).map((m) => esc(m.name)).join(", ")}${never.length > 40 ? "…" : ""}</p></div>
      </div>
      ${gstAndProfitHTML()}
      <h2 class="h2">Dish sales</h2>
      <table class="gt"><thead><tr><th>Dish</th><th class="num">Sold</th><th class="num">Sales</th><th class="num">Share</th><th class="num">Can't make</th><th class="num">Remakes</th></tr></thead><tbody>${dishes
        .slice(0, 60)
        .map((d) => `<tr><td data-l="Dish">${esc(d.name)}</td><td data-l="Sold" class="num">${d.qty}</td><td data-l="Sales" class="num">${rupee(d.amount)}</td><td data-l="Share" class="num">${now.subtotal ? ((Number(d.amount) / now.subtotal) * 100).toFixed(1) : 0}%</td><td data-l="Can't make" class="num">${d.cant_make || ""}</td><td data-l="Remakes" class="num">${d.remakes || ""}</td></tr>`)
        .join("") || `<tr><td colspan="6" class="soft">No dishes sold in this period.</td></tr>`}</tbody></table>`;
  }
  const EXCAT = { supplies: "Supplies", salary: "Salary / wages", rent: "Rent", utilities: "Power & water", repairs: "Repairs", gas: "Gas", marketing: "Marketing", transport: "Transport", other: "Other" };
  function gstRows() {
    const { rows, all } = report;
    const by = {};
    for (const r of rows) (by[r.branch_id] ||= []).push(r);
    const ids = all ? Object.keys(by) : [c.branch];
    return ids.map((id) => {
      const t = total(by[id] || []);
      return { id, name: bname(id), gstin: report.gstin[id] || "not set", taxable: t.subtotal - t.discounts, tax: t.tax, cgst: t.tax / 2, sgst: t.tax / 2 };
    });
  }
  function expenseCats() {
    const m = {};
    for (const e of report.expenses) m[e.category] = (m[e.category] || 0) + Number(e.amount);
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  }
  function gstAndProfitHTML() {
    const g = gstRows();
    const ex = expenseCats();
    const exTotal = ex.reduce((a, [, v]) => a + v, 0);
    const sales = report.now.sales;
    return `<div class="grid2">
      <div class="card"><h2 class="h3">GST summary</h2>
        <table class="gt gt--plain"><thead><tr><th>Branch</th><th class="num">Taxable value</th><th class="num">CGST</th><th class="num">SGST</th><th class="num">Total GST</th></tr></thead><tbody>${g
          .map((r) => `<tr><td data-l="Branch"><b>${esc(r.name)}</b><br><small class="soft">GSTIN ${esc(r.gstin)}</small></td><td data-l="Taxable" class="num">${rupee(r.taxable)}</td><td data-l="CGST" class="num">${rupee(r.cgst)}</td><td data-l="SGST" class="num">${rupee(r.sgst)}</td><td data-l="GST" class="num"><b>${rupee(r.tax)}</b></td></tr>`)
          .join("")}</tbody></table>
        <p class="soft small">From the period's bills (after discounts; voids left out). Restaurant GST is split equally into CGST and SGST. Share this and the Excel file with your accountant.</p></div>
      <div class="card"><h2 class="h3">Sales and expenses</h2><dl class="sum">
        <div><dt>Money received</dt><dd>${rupee(sales)}</dd></div>
        ${ex.map(([k, v]) => `<div><dt>${esc(EXCAT[k] || k)}</dt><dd>−${rupee(v)}</dd></div>`).join("") || "<div><dt>No expenses recorded</dt><dd>–</dd></div>"}
        <div class="sum__total"><dt>Left after expenses</dt><dd class="${sales - exTotal < 0 ? "bad" : ""}">${rupee(sales - exTotal)}</dd></div></dl>
        <p class="soft small">Counts only what's recorded in Expenses (including paid stock purchases). GST collected is still owed to the government.</p></div>
    </div>`;
  }
  $$("[data-rk]").forEach((b) =>
    b.addEventListener("click", () => {
      rKind = b.dataset.rk;
      $$("[data-rk]").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
      fillPicker();
      loadReports();
    })
  );
  $("[data-r-pick]").addEventListener("change", loadReports);
  $$("[data-r-from], [data-r-to]").forEach((i) => i.addEventListener("change", loadReports));
  $("[data-r-all]").addEventListener("change", loadReports);
  fillPicker();
  const reportsReport = () => {
    if (!report) return null;
    const { p, all, now, prev, ly, dishes, kitchen, rows } = report;
    const byBranch = {};
    for (const r of rows) (byBranch[r.branch_id] ||= []).push(r);
    return {
      title: `Report - ${p.label}`,
      sections: [
        { text: `${all ? "All branches" : bname(c.branch)} · ${dayLabel(p.f)} to ${dayLabel(p.to)} · ${now.days} trading days` },
        { kpis: [["Sales", rupee(now.sales)], ["Tables", String(now.tables)], ["Guests", String(now.guests)], ["Per head", rupee(now.guests ? now.sales / now.guests : 0)]] },
        { heading: "Compared", head: ["", "This period", "Last period", "Change", "Same period last year", "Change"], body: [["Sales", "sales"], ["Tables", "tables"], ["Guests", "guests"], ["Discounts", "discounts"], ["Walk-outs", "walkouts"]].map(([l, k]) => [l, k === "sales" || k === "discounts" ? rupee(now[k]) : now[k], k === "sales" || k === "discounts" ? rupee(prev[k]) : prev[k], change(now[k], prev[k]), k === "sales" || k === "discounts" ? rupee(ly[k]) : ly[k], change(now[k], ly[k])]), align: { 1: "right", 2: "right", 4: "right" } },
        { heading: "Money and GST", head: ["", "Amount"], body: [["Cash", rupee(now.cash)], ["UPI", rupee(now.upi)], ["Card", rupee(now.card)], ["Taxable value (after discounts)", rupee(now.subtotal - now.discounts)], ["GST on bills", rupee(now.tax)], ["Discounts", rupee(now.discounts)], ["Walk-outs", `${now.walkouts} · ${rupee(now.walkout_amount)}`], ["Voids", `${now.voids} · ${rupee(now.void_amount)}`]], align: { 1: "right" } },
        ...(all ? [{ heading: "Branches", head: ["Branch", "Sales", "Tables", "Guests", "Per head", "Walk-outs"], body: Object.entries(byBranch).map(([id, rs]) => { const t = total(rs); return [bname(id), rupee(t.sales), t.tables, t.guests, rupee(t.guests ? t.sales / t.guests : 0), t.walkouts]; }), align: { 1: "right", 2: "right", 3: "right", 4: "right", 5: "right" } }] : []),
        { heading: "GST summary", head: ["Branch", "GSTIN", "Taxable value", "CGST", "SGST", "Total GST"], body: gstRows().map((r) => [r.name, r.gstin, rupee(r.taxable), rupee(r.cgst), rupee(r.sgst), rupee(r.tax)]), align: { 2: "right", 3: "right", 4: "right", 5: "right" } },
        { heading: "Sales and expenses", head: ["", "Amount"], body: [["Money received", rupee(now.sales)], ...expenseCats().map(([k, v]) => [EXCAT[k] || k, "-" + rupee(v)])], foot: ["Left after expenses", rupee(now.sales - expenseCats().reduce((a, [, v]) => a + v, 0))], align: { 1: "right" } },
        { heading: "Kitchen timing", head: ["", ""], body: kitchen.orders ? [["Average minutes to ready", kitchen.avgReady], ["9 in 10 orders ready within (min)", kitchen.p90Ready], ["Late orders (20+ min)", `${kitchen.late} of ${kitchen.orders}`]] : [["No timed orders", ""]] },
        { heading: "Dish sales", head: ["Dish", "Sold", "Sales", "Can't make", "Remakes"], body: dishes.map((d) => [d.name, d.qty, rupee(d.amount), d.cant_make || "", d.remakes || ""]), align: { 1: "right", 2: "right" } },
      ],
      file: `report-${p.f}-to-${p.to}`,
    };
  };
  $("[data-r-xls]").addEventListener("click", () => {
    if (!report) return;
    const { p, now, dishes, rows } = report;
    csv(
      [
        ["Hotel Pandia's report", p.label, report.all ? "All branches" : bname(c.branch)],
        [],
        ["Day", "Branch", "Sales", "Cash", "UPI", "Card", "Tables", "Guests", "Orders", "Subtotal", "GST", "Discounts", "Walk-outs", "Walk-out amount", "Voids", "Void amount", "Cancelled orders", "Can't make"],
        ...rows.sort((a, b) => (a.day < b.day ? -1 : 1)).map((r) => [r.day, bname(r.branch_id), r.sales, r.cash, r.upi, r.card, r.tables, r.guests, r.orders, r.subtotal, r.tax, r.discounts, r.walkouts, r.walkout_amount, r.voids, r.void_amount, r.cancelled_orders, r.cant_make]),
        ["Total", "", now.sales, now.cash, now.upi, now.card, now.tables, now.guests, now.orders, now.subtotal, now.tax, now.discounts, now.walkouts, now.walkout_amount, now.voids, now.void_amount, now.cancelled_orders, now.cant_make],
        [],
        ["GST", "GSTIN", "Taxable value", "CGST", "SGST", "Total GST"],
        ...gstRows().map((r) => [r.name, r.gstin, r.taxable, r.cgst.toFixed(2), r.sgst.toFixed(2), r.tax]),
        [],
        ["Expenses", "Amount"],
        ...expenseCats().map(([k, v]) => [EXCAT[k] || k, v]),
        [],
        ["Dish", "Sold", "Sales", "Can't make", "Remakes"],
        ...dishes.map((d) => [d.name, d.qty, d.amount, d.cant_make, d.remakes]),
      ],
      `pandias-${report.all ? "all" : c.branch}-report-${p.f}-to-${p.to}.csv`
    );
  });

  const LOAD = { feedback: loadFeedback, reports: loadReports };
  return {
    roles: Object.fromEntries(Object.entries(SCREENS).map(([k, s]) => [k, s.roles])),
    load: (k) => LOAD[k]?.(),
    reports: { feedback: feedbackReport, reports: reportsReport },
    takeOrder,
    canTake,
    /** "with: 1 Mutton Biryani, 1 Raitha" for a combo on a kitchen ticket */
    comboText: (id) => {
      const list = combos[id];
      if (!list?.length || !menu) return "";
      const name = (b) => (menu.find((m) => m.id === b || m.id.startsWith(b + "--"))?.name || b).replace(/\s\((?:[^()]|\([^()]*\))*\)$/, "");
      return list.map((x) => `${x.qty} ${name(x.id)}`).join(", ");
    },
    warmMenu: () => loadMenu(),
    takeawayHTML,
    loyaltyHTML,
    loyaltyCard,
    lowRatingsToday,
  };
}
