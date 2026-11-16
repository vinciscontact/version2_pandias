// Hotel Pandia's staff app: running the business.
//   Stock       what's on hand per branch, low-stock warnings, purchases (+ paid from the drawer = an expense),
//               use / waste, stock counts; every entry can be voided by a manager
//   Expenses    petty cash and bills by category; cash spends lower the cash expected at Close the day
//   Attendance  everyone checks in / out on their own phone; managers see the team and fix mistakes
// The database checks every role again.

const UNITS = ["kg", "g", "l", "ml", "pcs", "packet", "box", "tray", "bottle", "cylinder"];
const CATS = { supplies: "Supplies", salary: "Salary / wages", rent: "Rent", utilities: "Power & water", repairs: "Repairs", gas: "Gas", marketing: "Marketing", transport: "Transport", other: "Other" };
const PAID = { cash: "Cash (drawer)", upi: "UPI", bank: "Bank", card: "Card" };

export function initBusiness(c) {
  const { sb, $, $$, esc, rupee, toast, act, friendly, clock } = c;
  const istToday = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
  const addDays = (ymd, n) => new Date(Date.parse(ymd + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
  const dayLabel = (ymd) => new Date(ymd + "T12:00:00+05:30").toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });
  const when = (iso) => new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  const num = (n) => Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 });
  const isBoss = () => ["admin", "manager"].includes(c.me.role);
  function modal(title, sub, body) {
    const d = document.createElement("dialog");
    d.className = "panel";
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

  const SCREENS = {
    stock: { roles: ["admin", "manager", "kitchen"], label: "Stock", icon: '<path d="M3 7l9-4 9 4-9 4z"/><path d="M3 7v10l9 4 9-4V7M12 11v10"/>' },
    expenses: { roles: ["admin", "manager", "cashier"], label: "Expenses", icon: '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18M7 15h4"/>' },
    attendance: { roles: ["admin", "manager"], label: "Attendance", icon: '<rect x="4" y="5" width="16" height="16" rx="2"/><path d="M8 3v4M16 3v4M4 11h16M9 16l2 2 4-4"/>' },
  };
  const before = $('[data-tab="activity"]');
  for (const [k, s] of Object.entries(SCREENS)) before.insertAdjacentHTML("beforebegin", `<a href="#${k}" data-tab="${k}"><svg viewBox="0 0 24 24">${s.icon}</svg><span>${s.label}</span><b class="badge" data-badge="${k}" hidden></b></a>`);
  const pdfBtn = (k) => `<button type="button" class="btn btn--line btn--sm btn--pdf" data-pdf="${k}">Download PDF</button>`;
  $(".main").insertAdjacentHTML(
    "beforeend",
    `<section class="screen" data-screen="stock" hidden>
      <header class="bar"><div><h1>Stock</h1><p class="soft" data-st-sum></p></div><div class="bar__tools">
        <button type="button" class="btn btn--gold" data-st-act="purchase" data-boss>+ Purchase</button>
        <button type="button" class="btn btn--line" data-st-act="use">Used / wasted</button>
        <button type="button" class="btn btn--line" data-st-act="count" data-boss>Stock count</button>
        <button type="button" class="btn btn--line btn--sm" data-st-items data-boss>Items</button>${pdfBtn("stock")}</div></header>
      <div data-stock></div>
      <h2 class="h2">Recent entries</h2><div data-st-moves></div>
    </section>
    <section class="screen" data-screen="expenses" hidden>
      <header class="bar"><div><h1>Expenses</h1><p class="soft" data-ex-sum></p></div><div class="bar__tools"><button type="button" class="btn btn--gold" data-ex-add>+ Expense</button><button type="button" class="btn btn--line btn--sm" data-ex-xls>Excel</button>${pdfBtn("expenses")}</div></header>
      <div class="menutools"><select data-ex-days aria-label="Period"><option value="0">Today</option><option value="6">7 days</option><option value="month" selected>This month</option><option value="lastmonth">Last month</option><option value="89">90 days</option></select></div>
      <div data-ex-cats class="kpis kpis--auto"></div>
      <div data-expenses></div>
    </section>
    <section class="screen" data-screen="attendance" hidden>
      <header class="bar"><div><h1>Attendance</h1><p class="soft" data-at-sum></p></div><div class="bar__tools"><button type="button" class="btn btn--line" data-at-mark>Fix or add a record</button><button type="button" class="btn btn--line btn--sm" data-at-xls>Excel</button>${pdfBtn("attendance")}</div></header>
      <div class="menutools"><select data-at-month aria-label="Month"></select></div>
      <h2 class="h2">Today</h2><div data-at-today></div>
      <h2 class="h2">This month</h2><div data-at-month-list></div>
    </section>`
  );

  // =====================================================================================
  // STOCK
  let levels = [];
  let items = [];
  let moves = [];
  async function loadStock() {
    $$("[data-boss]").forEach((b) => (b.hidden = !isBoss()));
    const [lv, it, mv] = await Promise.all([
      sb.rpc("stock_levels", { p_branch: c.branch }),
      sb.from("stock_items").select("*").order("sort"),
      sb.from("stock_moves").select("id, item_id, kind, qty, counted, cost, supplier, note, at, by, voided_at").eq("branch_id", c.branch).order("at", { ascending: false }).limit(60),
    ]);
    if (lv.error) return ($("[data-stock]").innerHTML = `<p class="calm">${esc(friendly(lv.error))}</p>`);
    levels = lv.data || [];
    items = it.data || [];
    moves = mv.data || [];
    const low = levels.filter((l) => Number(l.on_hand) <= Number(l.low_at));
    c.setBadge("stock", low.length);
    $("[data-st-sum]").textContent = `${levels.length} items · ${low.length ? `${low.length} low` : "nothing low"}`;
    $("[data-stock]").innerHTML = `<table class="gt"><thead><tr><th>Item</th><th class="num">On hand</th><th class="num">Low at</th><th class="num">Used last 7 days</th><th class="num">Lasts about</th><th>Last bought</th><th>Last counted</th></tr></thead><tbody>${levels
      .map((l) => {
        const isLow = Number(l.on_hand) <= Number(l.low_at);
        const perDay = Number(l.used_7d) / 7;
        const lasts = perDay > 0 ? Math.floor(Number(l.on_hand) / perDay) : null;
        return `<tr class="${isLow ? "is-low" : ""}"><td data-l="Item"><b>${esc(l.name)}</b>${isLow ? ' <i class="mtag mtag--spicy">Low</i>' : ""}</td><td data-l="On hand" class="num"><b>${num(l.on_hand)}</b> ${esc(l.unit)}</td><td data-l="Low at" class="num">${num(l.low_at)}</td><td data-l="Used 7 days" class="num">${num(l.used_7d)}</td><td data-l="Lasts" class="num">${lasts === null ? "–" : lasts + (lasts === 1 ? " day" : " days")}</td><td data-l="Last bought">${l.last_purchase ? when(l.last_purchase) : "–"}</td><td data-l="Last counted">${l.last_count ? when(l.last_count) : "–"}</td></tr>`;
      })
      .join("")}</tbody></table>`;
    const name = (id) => items.find((i) => i.id === id);
    const KIND = { purchase: "Bought", use: "Used", waste: "Wasted", count: "Counted" };
    $("[data-st-moves]").innerHTML = moves.length
      ? `<ul class="alog">${moves
          .map((m) => {
            const it = name(m.item_id);
            return `<li class="${m.voided_at ? "is-void" : m.kind === "waste" ? "is-serious" : ""}"><time>${when(m.at)}</time><p>${KIND[m.kind]} <b>${m.kind === "count" ? num(m.counted) : num(Math.abs(m.qty))} ${esc(it?.unit || "")} ${esc(it?.name || "")}</b>${m.kind === "count" ? ` (${Number(m.qty) >= 0 ? "+" : ""}${num(m.qty)})` : ""}${m.cost ? ` · ${rupee(m.cost)}` : ""}${m.supplier ? ` · ${esc(m.supplier)}` : ""}${m.note ? ` · “${esc(m.note)}”` : ""}${m.voided_at ? " · voided" : isBoss() ? ` <button type="button" class="link" data-st-void="${m.id}">Void</button>` : ""}</p></li>`;
          })
          .join("")}</ul>`
      : `<p class="soft">No entries yet. Start with a stock count of everything on the shelves.</p>`;
  }
  const itemOptions = () => items.filter((i) => i.active).map((i) => `<option value="${i.id}">${esc(i.name)} (${i.unit})</option>`).join("");
  $$("[data-st-act]").forEach((b) =>
    b.addEventListener("click", () => {
      const kind = b.dataset.stAct;
      const title = { purchase: "Purchase", use: "Used or wasted", count: "Stock count" }[kind];
      const d = modal(title, kind === "count" ? "Count what's actually on the shelf. The difference is recorded." : kind === "purchase" ? "What came in today." : "What the kitchen used or threw away.", `
        <form class="dform" data-f>
          <label>Item<select name="item">${itemOptions()}</select></label>
          ${kind === "use" ? `<div class="dform__chips"><label><input type="radio" name="kind" value="use" checked><span>Used</span></label><label><input type="radio" name="kind" value="waste"><span>Wasted / spoilt</span></label></div>` : ""}
          <label>${kind === "count" ? "Counted on the shelf" : "Quantity"}<input name="qty" type="number" min="0" step="0.01" inputmode="decimal" required></label>
          ${kind === "purchase" ? `<div class="dform__two"><label>Cost ₹ <small>optional</small><input name="cost" type="number" min="0" step="1" inputmode="numeric"></label><label>Supplier <small>optional</small><input name="supplier" maxlength="80"></label></div>
            <label>Paid from<select name="paid"><option value="">Not paid now / on account</option>${Object.entries(PAID).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select><small>If paid, it's also added to Expenses (cash lowers the drawer at Close the day).</small></label>` : ""}
          <label>Note <small>optional</small><input name="note" maxlength="200"></label>
          <p class="err" data-err hidden></p>
          <div class="panel__foot"><button type="submit" class="btn btn--dark">Save</button></div>
        </form>`);
      $("[data-f]", d).addEventListener("submit", async (e) => {
        e.preventDefault();
        const f = e.target;
        const k = kind === "use" ? f.querySelector("[name=kind]:checked").value : kind;
        const { error } = await sb.rpc("stock_move", { p_branch: c.branch, p_item: Number(f.item.value), p_kind: k, p_qty: Number(f.qty.value), p_cost: f.cost?.value ? Number(f.cost.value) : null, p_supplier: f.supplier?.value || null, p_note: f.note.value || null, p_paid_from: f.paid?.value || null });
        if (error) return (($("[data-err]", d).textContent = friendly(error)), ($("[data-err]", d).hidden = false));
        d.close();
        toast("Saved");
        loadStock();
      });
    })
  );
  $("[data-st-moves]").addEventListener("click", async (e) => {
    const v = e.target.closest("[data-st-void]");
    if (!v || !confirm("Void this stock entry? (If it was paid, its expense is voided too.)")) return;
    if (await act(v, () => sb.rpc("void_stock_move", { p_id: Number(v.dataset.stVoid) }), "Voided")) loadStock();
  });
  $("[data-st-items]").addEventListener("click", () => {
    const d = modal("Stock items", "The list is shared by every branch. Low-at is when it shows as low.", `
      <form class="dform" data-f><table class="gt"><thead><tr><th>Item</th><th>Unit</th><th>Low at</th><th>In use</th></tr></thead><tbody>${items
        .map((i) => `<tr data-id="${i.id}"><td data-l="Item"><input name="name" value="${esc(i.name)}" maxlength="60"></td><td data-l="Unit"><select name="unit">${UNITS.map((u) => `<option ${u === i.unit ? "selected" : ""}>${u}</option>`).join("")}</select></td><td data-l="Low at"><input name="low" type="number" min="0" step="0.5" value="${Number(i.low_at)}"></td><td data-l="In use"><input type="checkbox" name="active" ${i.active ? "checked" : ""}></td></tr>`)
        .join("")}<tr data-id=""><td data-l="New item"><input name="name" maxlength="60" placeholder="+ New item"></td><td data-l="Unit"><select name="unit">${UNITS.map((u) => `<option>${u}</option>`).join("")}</select></td><td data-l="Low at"><input name="low" type="number" min="0" step="0.5" value="0"></td><td data-l="In use"><input type="checkbox" name="active" checked></td></tr></tbody></table>
        <p class="err" data-err hidden></p><div class="panel__foot"><button type="submit" class="btn btn--dark">Save</button></div></form>`);
    $("[data-f]", d).addEventListener("submit", async (e) => {
      e.preventDefault();
      for (const tr of $$("tr[data-id]", d)) {
        const id = tr.dataset.id ? Number(tr.dataset.id) : null;
        const nm = $("[name=name]", tr).value.trim();
        if (!id && !nm) continue;
        const i = items.find((x) => x.id === id);
        const row = { p_id: id, p_name: nm, p_unit: $("[name=unit]", tr).value, p_low: Number($("[name=low]", tr).value), p_active: $("[name=active]", tr).checked };
        if (i && i.name === row.p_name && i.unit === row.p_unit && Number(i.low_at) === row.p_low && i.active === row.p_active) continue;
        const { error } = await sb.rpc("save_stock_item", row);
        if (error) return (($("[data-err]", d).textContent = `${nm}: ${friendly(error)}`), ($("[data-err]", d).hidden = false));
      }
      d.close();
      toast("Saved");
      loadStock();
    });
  });
  const stockReport = () => ({
    title: "Stock",
    sections: [{ text: $("[data-st-sum]").textContent }, { head: ["Item", "On hand", "Unit", "Low at", "Used 7 days"], body: levels.map((l) => [l.name + (Number(l.on_hand) <= Number(l.low_at) ? " (LOW)" : ""), num(l.on_hand), l.unit, num(l.low_at), num(l.used_7d)]), align: { 1: "right", 3: "right", 4: "right" } }],
    file: "stock",
  });
  /** for Today: low stock (managers and kitchen) */
  async function lowStock() {
    if (!["admin", "manager", "kitchen"].includes(c.me.role)) return [];
    const { data } = await sb.rpc("stock_levels", { p_branch: c.branch });
    const low = (data || []).filter((l) => Number(l.on_hand) <= Number(l.low_at) && (Number(l.on_hand) > 0 || l.last_count || l.last_purchase));
    c.setBadge("stock", low.length);
    return low;
  }

  // =====================================================================================
  // EXPENSES
  let exps = [];
  function exRange() {
    const v = $("[data-ex-days]").value;
    const t = istToday();
    if (v === "month") return [t.slice(0, 8) + "01", t];
    if (v === "lastmonth") {
      const last = addDays(t.slice(0, 8) + "01", -1);
      return [last.slice(0, 8) + "01", last];
    }
    return [addDays(t, -Number(v)), t];
  }
  async function loadExpenses() {
    const [f, t] = exRange();
    const { data, error } = await sb.from("expenses").select("*").eq("branch_id", c.branch).gte("day", f).lte("day", t).order("day", { ascending: false }).order("at", { ascending: false }).limit(3000);
    if (error) return ($("[data-expenses]").innerHTML = `<p class="calm">${esc(friendly(error))}</p>`);
    exps = data || [];
    const live = exps.filter((e) => !e.voided_at);
    const total = live.reduce((a, e) => a + Number(e.amount), 0);
    const byCat = {};
    for (const e of live) byCat[e.category] = (byCat[e.category] || 0) + Number(e.amount);
    $("[data-ex-sum]").textContent = `${dayLabel(f)} – ${dayLabel(t)} · ${live.length} expenses · ${rupee(total)} · cash from drawer ${rupee(live.filter((e) => e.paid_from === "cash").reduce((a, e) => a + Number(e.amount), 0))}`;
    $("[data-ex-cats]").innerHTML = Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<div class="kpi"><span>${esc(CATS[k] || k)}</span><b>${rupee(v)}</b><small>${total ? Math.round((v / total) * 100) : 0}%</small></div>`).join("");
    $("[data-expenses]").innerHTML = exps.length
      ? `<table class="gt"><thead><tr><th>Day</th><th>What</th><th>Paid to</th><th>Paid from</th><th>Note</th><th class="num">Amount</th><th></th></tr></thead><tbody>${exps
          .map((e) => `<tr class="${e.voided_at ? "is-void" : ""}"><td data-l="Day">${dayLabel(e.day)}</td><td data-l="What">${esc(CATS[e.category] || e.category)}</td><td data-l="Paid to">${esc(e.payee || "–")}</td><td data-l="Paid from">${esc(PAID[e.paid_from] || e.paid_from)}</td><td data-l="Note">${esc(e.note || "")}${e.voided_at ? ` · voided: ${esc(e.void_reason || "")}` : ""}</td><td data-l="Amount" class="num"><b>${rupee(e.amount)}</b></td><td>${!e.voided_at && isBoss() ? `<button type="button" class="link" data-ex-void="${e.id}">Void</button>` : ""}</td></tr>`)
          .join("")}</tbody></table>`
      : `<div class="calm"><b>No expenses in this period.</b><span>Record every spend from the drawer, so Close the day matches.</span></div>`;
  }
  $("[data-ex-days]").addEventListener("change", loadExpenses);
  $("[data-ex-add]").addEventListener("click", () => {
    const d = modal("Add an expense", c.me.role === "cashier" ? "The desk can record today's cash spends up to ₹5,000." : "", `
      <form class="dform" data-f>
        <div class="dform__two"><label>What for<select name="cat">${Object.entries(CATS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></label>
        <label>Amount ₹<input name="amount" type="number" min="1" step="1" inputmode="numeric" required></label></div>
        <div class="dform__two"><label>Paid from<select name="paid">${Object.entries(PAID).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></label>
        <label>Day<input name="day" type="date" value="${istToday()}" max="${istToday()}" ${isBoss() ? "" : "disabled"}></label></div>
        <label>Paid to <small>optional</small><input name="payee" maxlength="80" placeholder="e.g. Murugan Vegetables"></label>
        <label>Note <small>optional</small><input name="note" maxlength="200"></label>
        <p class="err" data-err hidden></p>
        <div class="panel__foot"><button type="submit" class="btn btn--dark">Save</button></div>
      </form>`);
    $("[data-f]", d).addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = e.target;
      const { error } = await sb.rpc("add_expense", { p_branch: c.branch, p_category: f.cat.value, p_amount: Number(f.amount.value), p_paid_from: f.paid.value, p_payee: f.payee.value || null, p_note: f.note.value || null, p_day: f.day.value || null });
      if (error) return (($("[data-err]", d).textContent = friendly(error)), ($("[data-err]", d).hidden = false));
      d.close();
      toast("Expense saved");
      loadExpenses();
    });
  });
  $("[data-expenses]").addEventListener("click", async (e) => {
    const v = e.target.closest("[data-ex-void]");
    if (!v) return;
    const why = prompt("Why void this expense?");
    if (why === null) return;
    if (await act(v, () => sb.rpc("void_expense", { p_id: Number(v.dataset.exVoid), p_reason: why }), "Voided")) loadExpenses();
  });
  $("[data-ex-xls]").addEventListener("click", () => {
    const [f, t] = exRange();
    csv([["Day", "Category", "Paid to", "Paid from", "Note", "Amount", "Voided"], ...exps.map((e) => [e.day, CATS[e.category] || e.category, e.payee || "", PAID[e.paid_from], e.note || "", e.amount, e.voided_at ? e.void_reason || "yes" : ""])], `pandias-${c.branch}-expenses-${f}-to-${t}.csv`);
  });
  const expensesReport = () => ({
    title: "Expenses",
    sections: [
      { text: $("[data-ex-sum]").textContent },
      { heading: "By category", head: ["Category", "Amount"], body: Object.entries(exps.filter((e) => !e.voided_at).reduce((m, e) => ((m[e.category] = (m[e.category] || 0) + Number(e.amount)), m), {})).map(([k, v]) => [CATS[k] || k, rupee(v)]), align: { 1: "right" } },
      { heading: "Every expense", head: ["Day", "What", "Paid to", "Paid from", "Note", "Amount"], body: exps.map((e) => [e.day, CATS[e.category] || e.category, e.payee || "", PAID[e.paid_from], (e.note || "") + (e.voided_at ? " (VOIDED)" : ""), rupee(e.amount)]), align: { 5: "right" } },
    ],
    file: "expenses",
  });

  // =====================================================================================
  // ATTENDANCE
  let att = [];
  let people = [];
  function fillMonths() {
    const t = istToday();
    const opts = [];
    for (let i = 0; i < 6; i++) {
      const d = new Date(Date.UTC(Number(t.slice(0, 4)), Number(t.slice(5, 7)) - 1 - i, 1));
      opts.push(`<option value="${d.toISOString().slice(0, 7)}">${d.toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" })}</option>`);
    }
    $("[data-at-month]").innerHTML = opts.join("");
  }
  fillMonths();
  const hours = (a) => (a.check_out ? (Date.parse(a.check_out) - Date.parse(a.check_in)) / 36e5 : 0);
  async function loadAttendance() {
    const m = $("[data-at-month]").value;
    const from = m + "-01";
    const to = addDays(new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 1)).toISOString().slice(0, 10), -1);
    const [a, p] = await Promise.all([
      sb.from("attendance").select("*").eq("branch_id", c.branch).gte("day", from).lte("day", to).order("check_in"),
      sb.from("staff").select("user_id, name, role, active").eq("branch_id", c.branch).order("name"),
    ]);
    att = a.data || [];
    people = (p.data || []).filter((x) => x.active);
    const t = istToday();
    const todayRows = att.filter((x) => x.day === t);
    $("[data-at-sum]").textContent = `${todayRows.length} of ${people.length} checked in today`;
    $("[data-at-today]").innerHTML = `<div class="people">${people
      .map((s) => {
        const r = todayRows.filter((x) => x.user_id === s.user_id);
        const open = r.find((x) => !x.check_out);
        return `<div class="person ${r.length ? "" : "is-off"}"><div><b>${esc(s.name)}</b><span class="rolechip rolechip--${s.role}">${c.ROLE[s.role]}</span></div><p class="small">${r.length ? r.map((x) => `${clock(x.check_in)} – ${x.check_out ? clock(x.check_out) : "now"}`).join(", ") : "Not checked in"}${open ? ' <i class="mtag mtag--time">On duty</i>' : ""}</p></div>`;
      })
      .join("")}</div>`;
    const byPerson = people.map((s) => {
      const rs = att.filter((x) => x.user_id === s.user_id);
      return { s, days: new Set(rs.map((x) => x.day)).size, hrs: rs.reduce((h, x) => h + hours(x), 0), late: rs.filter((x) => x.note?.startsWith("auto")).length };
    });
    $("[data-at-month-list]").innerHTML = `<table class="gt"><thead><tr><th>Name</th><th>Role</th><th class="num">Days present</th><th class="num">Hours</th><th class="num">Avg hours / day</th><th class="num">Forgot to check out</th></tr></thead><tbody>${byPerson
      .map((x) => `<tr><td data-l="Name"><b>${esc(x.s.name)}</b></td><td data-l="Role">${c.ROLE[x.s.role]}</td><td data-l="Days" class="num">${x.days}</td><td data-l="Hours" class="num">${x.hrs.toFixed(1)}</td><td data-l="Avg" class="num">${x.days ? (x.hrs / x.days).toFixed(1) : "–"}</td><td data-l="Forgot" class="num">${x.late || ""}</td></tr>`)
      .join("")}</tbody></table>`;
  }
  $("[data-at-month]").addEventListener("change", loadAttendance);
  $("[data-at-mark]").addEventListener("click", () => {
    const d = modal("Fix or add attendance", "Replaces that person's record for that day.", `
      <form class="dform" data-f>
        <label>Person<select name="user">${people.map((s) => `<option value="${s.user_id}">${esc(s.name)}</option>`).join("")}</select></label>
        <label>Day<input type="date" name="day" value="${istToday()}" max="${istToday()}" required></label>
        <div class="dform__two"><label>In<input type="time" name="in" required></label><label>Out <small>empty if still working</small><input type="time" name="out"></label></div>
        <label>Note<input name="note" maxlength="200" placeholder="e.g. phone battery dead, checked by manager"></label>
        <p class="err" data-err hidden></p><div class="panel__foot"><button type="submit" class="btn btn--dark">Save</button></div>
      </form>`);
    $("[data-f]", d).addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = e.target;
      const { error } = await sb.rpc("mark_attendance", { p_user: f.user.value, p_day: f.day.value, p_in: f.in.value, p_out: f.out.value || null, p_note: f.note.value || null });
      if (error) return (($("[data-err]", d).textContent = friendly(error)), ($("[data-err]", d).hidden = false));
      d.close();
      toast("Saved");
      loadAttendance();
    });
  });
  $("[data-at-xls]").addEventListener("click", () => {
    const name = (id) => people.find((p) => p.user_id === id)?.name || "";
    csv([["Name", "Day", "In", "Out", "Hours", "Note"], ...att.map((a) => [name(a.user_id), a.day, clock(a.check_in), a.check_out ? clock(a.check_out) : "", hours(a).toFixed(2), a.note || ""])], `pandias-${c.branch}-attendance-${$("[data-at-month]").value}.csv`);
  });
  const attendanceReport = () => ({
    title: `Attendance - ${$("[data-at-month] option:checked")?.textContent || ""}`,
    sections: [{ head: ["Name", "Days present", "Hours", "Avg / day"], body: people.map((s) => { const rs = att.filter((x) => x.user_id === s.user_id); const days = new Set(rs.map((x) => x.day)).size; const h = rs.reduce((t, x) => t + hours(x), 0); return [s.name, days, h.toFixed(1), days ? (h / days).toFixed(1) : "-"]; }), align: { 1: "right", 2: "right", 3: "right" } }],
    file: `attendance-${$("[data-at-month]").value}`,
  });

  // ---------- check in / out for everyone with a branch (in the side bar)
  async function paintClock() {
    const btn = $("[data-clock]");
    if (!c.me.branch_id) return (btn.hidden = true);
    const { data } = await sb.from("attendance").select("id, check_in").eq("user_id", c.me.user_id).is("check_out", null).maybeSingle();
    btn.hidden = false;
    btn.classList.toggle("is-on", !!data);
    btn.textContent = data ? `On duty since ${clock(data.check_in)} · Check out` : "Check in";
    btn.dataset.in = data ? "1" : "";
  }
  $(".side__tools").insertAdjacentHTML("afterbegin", '<button type="button" class="chip chip--clock" data-clock hidden>Check in</button>');
  $("[data-clock]").addEventListener("click", async (e) => {
    const out = !!e.currentTarget.dataset.in;
    if (out && !confirm("Check out now?")) return;
    const { error } = await sb.rpc("clock", { p_in: !out });
    if (error) toast(friendly(error), "err");
    else toast(out ? "Checked out. Thank you for today!" : "Checked in. Have a good shift!");
    paintClock();
  });

  const LOAD = { stock: loadStock, expenses: loadExpenses, attendance: loadAttendance };
  return {
    roles: Object.fromEntries(Object.entries(SCREENS).map(([k, s]) => [k, s.roles])),
    load: (k) => LOAD[k]?.(),
    reports: { stock: stockReport, expenses: expensesReport, attendance: attendanceReport },
    lowStock,
    paintClock,
    CATS,
  };
}
