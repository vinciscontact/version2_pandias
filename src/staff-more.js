// Hotel Pandia's staff app: the running-the-business screens.
//   Bills      every bill, filters, reprint / PDF / Excel, void a wrong payment (manager)
//   Close day  settle every table, count the cash, keep the day's summary
//   Activity   who did what: prices, discounts, voids, cancellations, unpaid closes, staff changes
//   Team       add people (sign-in made by the staff-admin server function), roles, reset password, switch off
//   Setup      branches (address, hours, tax, packing charge), tables in bulk, QR cards, the 12-month data rule
// The database checks every permission again; these screens only shape what each role sees.

const FN_STAFF = "https://vlbnicfcjddaehyjindr.supabase.co/functions/v1/staff-admin";
const LOGIN_DOMAIN = "staff.pandias.invalid";
const METHOD = { cash: "Cash", upi: "UPI", card: "Card" };
const REASON = { paid: "Paid", walkout: "Walk-out", void: "Void", no_charge: "No charge", unspecified: "Closed unpaid" };
const ROLE_NAMES = { admin: "Owner", manager: "Manager", cashier: "Cashier", kitchen: "Kitchen", waiter: "Waiter" };

export function initMore(c) {
  const { sb, $, $$, esc, rupee, toast, act, friendly, clock } = c;
  const istToday = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
  const addDays = (ymd, n) => new Date(Date.parse(ymd + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
  const istStart = (ymd) => new Date(ymd + "T00:00:00+05:30").toISOString();
  const dayLabel = (ymd) => new Date(ymd + "T12:00:00+05:30").toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  const when = (iso) => new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  const bname = (id) => c.branches.find((b) => b.id === id)?.name || id || "";
  const isOwner = () => c.me.role === "admin";
  const isBoss = () => ["admin", "manager"].includes(c.me.role);
  let staffNames = {};
  async function loadStaffNames() {
    const { data } = await sb.from("staff").select("user_id, name");
    staffNames = Object.fromEntries((data || []).map((s) => [s.user_id, s.name]));
  }
  const who = (uid) => (uid ? staffNames[uid] || "Staff" : "–");

  // ---------- small shared pieces
  function csv(rows, file) {
    const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const blob = new Blob(["﻿" + rows.map((r) => r.map(cell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = file;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  /** a dialog in the app's panel style; returns the <dialog> */
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
  /** date range bar: Today / Yesterday / 7 days / This month / Last month / pick */
  function rangeBar(key) {
    return `<div class="rangebar" data-range-bar="${key}">
      <div class="seg seg--wrap">${[["today", "Today"], ["yesterday", "Yesterday"], ["7", "7 days"], ["month", "This month"], ["lastmonth", "Last month"]]
        .map(([v, l], i) => `<button type="button" data-r="${v}" aria-selected="${i === 0}">${l}</button>`)
        .join("")}</div>
      <label class="rangebar__pick">From <input type="date" data-rfrom></label><label class="rangebar__pick">To <input type="date" data-rto></label>
    </div>`;
  }
  function rangeOf(bar) {
    const sel = $("[data-r][aria-selected=true]", bar)?.dataset.r;
    const t = istToday();
    if (!sel) {
      const f = $("[data-rfrom]", bar).value || t;
      const to = $("[data-rto]", bar).value || f;
      return f <= to ? [f, to] : [to, f];
    }
    if (sel === "today") return [t, t];
    if (sel === "yesterday") return [addDays(t, -1), addDays(t, -1)];
    if (sel === "7") return [addDays(t, -6), t];
    if (sel === "month") return [t.slice(0, 8) + "01", t];
    const first = t.slice(0, 8) + "01";
    const lastPrev = addDays(first, -1);
    return [lastPrev.slice(0, 8) + "01", lastPrev];
  }
  function wireRange(bar, onChange) {
    $$("[data-r]", bar).forEach((b) =>
      b.addEventListener("click", () => {
        $$("[data-r]", bar).forEach((x) => x.setAttribute("aria-selected", String(x === b)));
        $("[data-rfrom]", bar).value = "";
        $("[data-rto]", bar).value = "";
        onChange();
      })
    );
    $$("input[type=date]", bar).forEach((i) =>
      i.addEventListener("change", () => {
        $$("[data-r]", bar).forEach((x) => x.setAttribute("aria-selected", "false"));
        onChange();
      })
    );
  }
  const rangeText = ([f, t]) => (f === t ? dayLabel(f) : `${dayLabel(f)} to ${dayLabel(t)}`);

  // ---------- screens: tabs + sections are added here, so index.html stays small
  const SCREENS = {
    bills: { roles: ["admin", "manager", "cashier"], label: "Bills", icon: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>' },
    close: { roles: ["admin", "manager", "cashier"], label: "Close day", icon: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>' },
    activity: { roles: ["admin", "manager"], label: "Activity", icon: '<path d="M3 12h4l3-8 4 16 3-8h4"/>' },
    team: { roles: ["admin", "manager"], label: "Team", icon: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M17 11h5M19.5 8.5v5"/>' },
    setup: { roles: ["admin"], label: "Setup", icon: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>' },
  };
  const nav = $(".tabs");
  for (const [k, s] of Object.entries(SCREENS)) {
    nav.insertAdjacentHTML("beforeend", `<a href="#${k}" data-tab="${k}"><svg viewBox="0 0 24 24">${s.icon}</svg><span>${s.label}</span></a>`);
  }
  const pdfBtn = (k) => `<button type="button" class="btn btn--line btn--sm btn--pdf" data-pdf="${k}">Download PDF</button>`;
  const xlsBtn = (k) => `<button type="button" class="btn btn--line btn--sm" data-xls="${k}">Excel</button>`;
  $(".main").insertAdjacentHTML(
    "beforeend",
    `
    <section class="screen" data-screen="bills" hidden>
      <header class="bar"><div><h1>Bills</h1><p class="soft" data-b-sum></p></div><div class="bar__tools">${xlsBtn("bills")}${pdfBtn("bills")}</div></header>
      ${rangeBar("bills")}
      <div class="menutools"><input type="search" placeholder="Table, name or number…" data-b-search aria-label="Find a bill">
        <select data-b-status aria-label="Status"><option value="">All bills</option><option value="paid">Paid</option><option value="open">Still open</option><option value="walkout">Walk-outs</option><option value="void">Voids</option><option value="no_charge">No charge</option></select>
        <label class="switchlab" data-b-allwrap hidden><input type="checkbox" data-b-all> All branches</label></div>
      <div data-bills></div>
    </section>
    <section class="screen" data-screen="close" hidden>
      <header class="bar"><div><h1>Close the day</h1><p class="soft" data-c-day></p></div><div class="bar__tools">${pdfBtn("close")}</div></header>
      <div data-close></div>
      <h2 class="h2">Past days</h2><div data-close-past></div>
    </section>
    <section class="screen" data-screen="activity" hidden>
      <header class="bar"><div><h1>Activity</h1><p class="soft">Every money, order, menu and staff change, with who did it and when.</p></div><div class="bar__tools">${xlsBtn("activity")}${pdfBtn("activity")}</div></header>
      ${rangeBar("activity")}
      <div class="menutools"><input type="search" placeholder="Search…" data-a-search aria-label="Search activity">
        <select data-a-kind aria-label="Kind"><option value="">Everything</option><option value="money">Money</option><option value="orders">Orders</option><option value="menu">Menu</option><option value="team">Team</option><option value="setup">Setup & days</option></select></div>
      <div data-activity></div>
    </section>
    <section class="screen" data-screen="team" hidden>
      <header class="bar"><div><h1>Team</h1><p class="soft">Everyone gets their own sign-in. Switch people off the day they leave.</p></div><div class="bar__tools"><button type="button" class="btn btn--gold" data-t-add>+ Add a person</button>${pdfBtn("team")}</div></header>
      <div data-team></div>
    </section>
    <section class="screen" data-screen="setup" hidden>
      <header class="bar"><div><h1>Setup</h1><p class="soft">Branches, tables, QR cards and your data.</p></div><div class="bar__tools"><button type="button" class="btn btn--gold" data-s-addbranch>+ Add a branch</button></div></header>
      <div data-s-data></div>
      <div data-setup></div>
    </section>`
  );

  // =====================================================================================
  // BILLS
  let bills = [];
  const billState = (s) => {
    const paid = (s.payments || []).filter((p) => !p.voided_at).reduce((a, p) => a + Number(p.amount), 0);
    if (s.status === "closed") return s.close_reason || (paid >= Number(s.total) ? "paid" : "unspecified");
    if (s.status === "paid") return "paid";
    return "open";
  };
  const STATE_LABEL = { ...REASON, open: "Open" };
  async function loadBills() {
    const bar = $("[data-range-bar=bills]");
    const [f, t] = rangeOf(bar);
    $("[data-b-allwrap]").hidden = !isOwner();
    const all = isOwner() && $("[data-b-all]").checked;
    let q = sb
      .from("table_sessions")
      .select("id, branch_id, table_label, status, close_reason, close_note, opened_at, closed_at, subtotal, tax, discount, total, guests, guests_max, closed_by, customers(name, phone), orders(id, status), payments(id, amount, method, received_by, voided_at, created_at)")
      .gte("opened_at", istStart(f))
      .lt("opened_at", istStart(addDays(t, 1)))
      .order("opened_at", { ascending: false })
      .limit(3000);
    if (!all) q = q.eq("branch_id", c.branch);
    const [{ data, error }] = await Promise.all([q, Object.keys(staffNames).length ? null : loadStaffNames()]);
    if (error) return ($("[data-bills]").innerHTML = `<p class="calm">Couldn't load bills. ${esc(friendly(error))}</p>`);
    bills = (data || []).map((s) => ({ ...s, state: billState(s), nOrders: (s.orders || []).filter((o) => o.status !== "cancelled").length, live: (s.payments || []).filter((p) => !p.voided_at) }));
    paintBills([f, t], all);
  }
  function billRows() {
    const q = $("[data-b-search]").value.trim().toLowerCase().replace(/\s/g, "");
    const st = $("[data-b-status]").value;
    return bills.filter(
      (s) =>
        (!st || s.state === st) &&
        (!q || s.table_label.toLowerCase() === q || (s.customers?.name || "").toLowerCase().replace(/\s/g, "").includes(q) || (s.customers?.phone || "").includes(q))
    );
  }
  function paintBills(range, all) {
    const list = billRows();
    const total = list.filter((s) => !["void"].includes(s.state)).reduce((a, s) => a + Number(s.total), 0);
    const taken = list.reduce((a, s) => a + s.live.reduce((x, p) => x + Number(p.amount), 0), 0);
    $("[data-b-sum]").textContent = `${rangeText(range)}${all ? " · all branches" : ""} · ${list.length} bills · billed ${rupee(total)} · received ${rupee(taken)}`;
    $("[data-bills]").innerHTML = list.length
      ? `<table class="gt"><thead><tr><th>When</th>${all ? "<th>Branch</th>" : ""}<th>Table</th><th>Guest</th><th>Orders</th><th>Status</th><th>Paid by</th><th>Made by</th><th class="num">Total</th></tr></thead><tbody>${list
          .map(
            (s) => `<tr class="is-live" data-bill="${s.id}">
              <td data-l="When">${when(s.opened_at)}</td>${all ? `<td data-l="Branch">${esc(bname(s.branch_id))}</td>` : ""}
              <td data-l="Table"><b>${esc(s.table_label)}</b></td>
              <td data-l="Guest">${s.customers ? esc(s.customers.name || "Guest") : '<span class="soft">–</span>'}</td>
              <td data-l="Orders">${s.nOrders}</td>
              <td data-l="Status"><em class="gst gst--${s.state}">${STATE_LABEL[s.state] || s.state}</em></td>
              <td data-l="Paid by">${[...new Set(s.live.map((p) => METHOD[p.method]))].join(" + ") || "–"}</td>
              <td data-l="Made by">${esc([...new Set(s.live.map((p) => who(p.received_by)))].join(", ") || "–")}</td>
              <td data-l="Total" class="num"><b>${rupee(s.total)}</b></td></tr>`
          )
          .join("")}</tbody></table>`
      : `<div class="calm"><b>No bills here.</b><span>Try another date or filter.</span></div>`;
  }
  wireRange($("[data-range-bar=bills]"), loadBills);
  $("[data-b-search]").addEventListener("input", () => paintBills(rangeOf($("[data-range-bar=bills]")), isOwner() && $("[data-b-all]").checked));
  $("[data-b-status]").addEventListener("change", () => paintBills(rangeOf($("[data-range-bar=bills]")), isOwner() && $("[data-b-all]").checked));
  $("[data-b-all]").addEventListener("change", loadBills);
  $("[data-bills]").addEventListener("click", (e) => {
    const r = e.target.closest("[data-bill]");
    if (r) openBill(r.dataset.bill);
  });

  async function openBill(id) {
    const s = bills.find((x) => x.id === id);
    const { data: o } = await sb.from("orders").select("id, code, status, created_at, order_items(name, qty, unit_price, parcel, parcel_fee, unavailable_at)").eq("session_id", id).order("created_at");
    const lines = (o || []).filter((x) => x.status !== "cancelled").flatMap((x) => x.order_items.filter((i) => !i.unavailable_at));
    const canVoid = isBoss() && s.status !== "closed";
    const d = modal(`Table ${s.table_label}`, `${bname(s.branch_id)} · ${when(s.opened_at)} · ${STATE_LABEL[s.state]}`, `
      ${s.customers ? `<p><b>${esc(s.customers.name || "Guest")}</b> · ${c.telLink(s.customers.phone)}${s.guests_max || s.guests ? ` · ${s.guests_max || s.guests} guests` : ""}</p>` : ""}
      <ul class="bl">${lines.map((i) => `<li><span>${i.qty} × ${esc(i.name)}${i.parcel ? " (parcel)" : ""}</span><b>${rupee(i.qty * i.unit_price + Number(i.parcel_fee || 0))}</b></li>`).join("") || "<li>No items.</li>"}</ul>
      <dl class="sum"><div><dt>Subtotal</dt><dd>${rupee(s.subtotal)}</dd></div>${Number(s.discount) ? `<div><dt>Discount</dt><dd>−${rupee(s.discount)}</dd></div>` : ""}<div><dt>GST</dt><dd>${rupee(s.tax)}</dd></div><div class="sum__total"><dt>Total</dt><dd>${rupee(s.total)}</dd></div></dl>
      <h3 class="h3">Payments</h3>
      <ul class="bl">${(s.payments || []).length
        ? s.payments
            .map(
              (p) => `<li class="${p.voided_at ? "is-void" : ""}"><span>${METHOD[p.method]} · ${clock(p.created_at)} · ${esc(who(p.received_by))}${p.voided_at ? " · voided" : ""}</span><b>${rupee(p.amount)}</b>${
                canVoid && !p.voided_at ? `<button type="button" class="link" data-void="${p.id}">Void</button>` : ""
              }</li>`
            )
            .join("")
        : "<li>No payments.</li>"}</ul>
      ${s.close_note ? `<p class="soft">Note: ${esc(s.close_note)}</p>` : ""}
      <div class="panel__foot"><button type="button" class="btn btn--line" data-bpdf>Bill PDF</button></div>`);
    d.addEventListener("click", async (e) => {
      const v = e.target.closest("[data-void]");
      if (v) {
        const reason = prompt("Why void this payment? (e.g. entered UPI, guest paid cash)\n\nThe desk records it again afterwards.");
        if (reason === null) return;
        if (await act(v, () => sb.rpc("void_payment", { p_payment: v.dataset.void, p_reason: reason }), "Payment voided. Record the right one on the table.")) {
          d.close();
          loadBills();
          c.reload();
        }
      }
      if (e.target.closest("[data-bpdf]")) {
        c.downloadPdf(e.target.closest("[data-bpdf]"), {
          title: `Bill - Table ${s.table_label}`,
          sections: [
            { kpis: [["Table", s.table_label], ["Opened", when(s.opened_at)], ["Status", STATE_LABEL[s.state]], ["Total", rupee(s.total)]] },
            { text: s.customers ? `Guest: ${s.customers.name || "Guest"}, ${c.fmtPhone(s.customers.phone)}` : "" },
            { heading: "Items", head: ["Item", "Qty", "Price", "Amount"], body: lines.map((i) => [i.name + (i.parcel ? " (parcel)" : ""), i.qty, rupee(i.unit_price), rupee(i.qty * i.unit_price + Number(i.parcel_fee || 0))]), align: { 1: "right", 2: "right", 3: "right" } },
            { head: null, body: [["Subtotal", rupee(s.subtotal)], ...(Number(s.discount) ? [["Discount", "-" + rupee(s.discount)]] : []), ["GST", rupee(s.tax)]], foot: ["Total", rupee(s.total)], align: { 1: "right" } },
            { heading: "Payments", head: ["Method", "Time", "By", "Amount"], body: (s.payments || []).map((p) => [METHOD[p.method] + (p.voided_at ? " (voided)" : ""), clock(p.created_at), who(p.received_by), rupee(p.amount)]), align: { 3: "right" } },
          ],
        }, `pandias-${s.branch_id}-bill-${s.table_label}-${s.opened_at.slice(0, 10)}.pdf`);
      }
    });
  }
  const billsReport = () => {
    const range = rangeOf($("[data-range-bar=bills]"));
    const list = billRows();
    return {
      title: "Bills",
      sections: [
        { text: $("[data-b-sum]").textContent },
        {
          head: ["When", "Branch", "Table", "Guest", "Orders", "Status", "Paid by", "Made by", "Total"],
          body: list.map((s) => [when(s.opened_at), bname(s.branch_id), s.table_label, s.customers?.name || "-", s.nOrders, STATE_LABEL[s.state], [...new Set(s.live.map((p) => METHOD[p.method]))].join(" + ") || "-", [...new Set(s.live.map((p) => who(p.received_by)))].join(", ") || "-", rupee(s.total)]),
          align: { 8: "right" },
          foot: ["", "", "", "", list.reduce((a, s) => a + s.nOrders, 0), "", "", "", rupee(list.filter((s) => s.state !== "void").reduce((a, s) => a + Number(s.total), 0))],
          empty: "No bills.",
        },
      ],
      file: `bills-${range[0]}-to-${range[1]}`,
    };
  };

  // =====================================================================================
  // CLOSE THE DAY
  let closeData = null;
  async function loadClose() {
    const day = istToday();
    $("[data-c-day]").textContent = `${dayLabel(day)} · ${bname(c.branch)}`;
    const [{ data, error }, past] = await Promise.all([
      sb.rpc("day_preview", { p_branch: c.branch, p_day: day }),
      sb.from("day_closes").select("day, closed_at, closed_by_name, cash_expected, cash_counted, difference, note, summary").eq("branch_id", c.branch).order("day", { ascending: false }).limit(31),
    ]);
    if (error) return ($("[data-close]").innerHTML = `<p class="calm">${esc(friendly(error))}</p>`);
    closeData = data;
    const s = data.summary;
    const open = data.openTables || [];
    const kpi = (l, v, sub = "") => `<div class="kpi"><span>${l}</span><b>${v}</b>${sub ? `<small>${sub}</small>` : ""}</div>`;
    const body = [];
    body.push(`<div class="kpis">${kpi("Sales today", rupee(s.sales), `${s.tables} tables · ${s.guests} guests`)}${kpi("Cash", rupee(s.cash))}${kpi("UPI", rupee(s.upi))}${kpi("Card", rupee(s.card))}</div>`);
    const flags = [
      [s.discounts, `Discounts ${rupee(s.discounts)}`],
      [s.walkouts, `${s.walkouts} walk-out${s.walkouts > 1 ? "s" : ""} (${rupee(s.walkout_amount)})`],
      [s.voids, `${s.voids} void${s.voids > 1 ? "s" : ""} (${rupee(s.void_amount)})`],
      [s.cancelled_orders, `${s.cancelled_orders} cancelled order${s.cancelled_orders > 1 ? "s" : ""}`],
      [s.cant_make, `${s.cant_make} "can't make"`],
      [s.payments_voided, `${s.payments_voided} payment${s.payments_voided > 1 ? "s" : ""} voided`],
    ].filter(([n]) => Number(n));
    body.push(`<p class="soft small cflags">${flags.length ? flags.map(([, t]) => esc(t)).join(" · ") : "No discounts, walk-outs, voids or cancellations today."}</p>`);
    if (data.closed) {
      const x = data.closed;
      body.push(`<div class="card closed"><h2 class="h3">Day closed ✓</h2><p>${esc(x.closed_by_name || "")} closed it at ${clock(x.closed_at)}.</p>
        <dl class="sum"><div><dt>Cash expected</dt><dd>${rupee(x.cash_expected)}</dd></div><div><dt>Cash counted</dt><dd>${rupee(x.cash_counted)}</dd></div><div class="sum__total"><dt>Difference</dt><dd class="${Math.abs(x.difference) > 100 ? "bad" : ""}">${Number(x.difference) >= 0 ? "+" : "−"}${rupee(Math.abs(x.difference))}</dd></div></dl>${x.note ? `<p class="soft">Note: ${esc(x.note)}</p>` : ""}</div>`);
    } else {
      body.push(`<div class="card"><h2 class="h3">1. Settle every table</h2>${
        open.length
          ? `<p>${open.length} table${open.length > 1 ? "s are" : " is"} still open. Take payment, or (manager) close as walk-out or void with a note.</p><div class="floor floor--mini">${open
              .map((t) => `<button type="button" class="tile tile--${t.status === "bill_requested" ? "bill" : "eat"}" data-open="${t.id}"><b>${esc(t.table)}</b><span>${t.status === "bill_requested" ? "Wants bill" : "Open"}</span><small>${rupee(t.total)} · paid ${rupee(t.paid)}</small></button>`)
              .join("")}</div>`
          : `<p class="ok">All tables are settled.${data.paidNotClosed ? ` ${data.paidNotClosed} paid table${data.paidNotClosed > 1 ? "s" : ""} will be closed for you.` : ""}</p>`
      }</div>
      <div class="card"><h2 class="h3">2. Count the cash drawer</h2>
        <p>Expected in the drawer: <b>${rupee(data.cashExpected)}</b>${Number(data.cashOut) ? ` <span class="soft">(cash sales ${rupee(s.cash)} − cash spent ${rupee(data.cashOut)})</span>` : ""}</p>
        ${isBoss() ? `<div class="cform"><label>Cash counted ₹<input type="number" inputmode="numeric" min="0" step="1" data-c-counted placeholder="0"></label>
        <label>Note <small>needed if it's off by more than ₹100</small><textarea rows="2" maxlength="500" data-c-note placeholder="e.g. ₹200 given to supplier, receipt in drawer"></textarea></label>
        <p class="soft small" data-c-diff></p>
        <button type="button" class="btn btn--dark" data-c-go ${open.length ? "disabled" : ""}>Close the day</button>${open.length ? '<span class="soft small"> Settle the open tables first.</span>' : ""}</div>` : `<p class="soft">A manager closes the day.</p>`}
      </div>`);
    }
    $("[data-close]").innerHTML = body.join("");
    const counted = $("[data-c-counted]");
    counted?.addEventListener("input", () => {
      const d = Number(counted.value || 0) - Number(data.cashExpected);
      $("[data-c-diff]").textContent = counted.value === "" ? "" : d === 0 ? "Matches exactly." : `${d > 0 ? "Extra" : "Short"} ${rupee(Math.abs(d))}${Math.abs(d) > 100 ? ". Add a note." : "."}`;
    });
    $("[data-c-go]")?.addEventListener("click", async (e) => {
      const n = Number(counted.value);
      if (counted.value === "" || !Number.isFinite(n) || n < 0) return toast("Enter the cash you counted.", "err");
      if (!confirm(`Close ${dayLabel(day)}?\n\nCash counted ${rupee(n)} (expected ${rupee(data.cashExpected)}).\nThis can't be undone.`)) return;
      if (await act(e.currentTarget, () => sb.rpc("close_day", { p_branch: c.branch, p_counted: n, p_note: $("[data-c-note]").value, p_day: day }), "Day closed. Good work today.")) {
        loadClose();
        c.reload();
      }
    });
    const P = past.data || [];
    $("[data-close-past]").innerHTML = P.length
      ? `<table class="gt"><thead><tr><th>Day</th><th>Closed by</th><th class="num">Sales</th><th class="num">Cash expected</th><th class="num">Counted</th><th class="num">Difference</th><th>Note</th></tr></thead><tbody>${P.map(
          (x) => `<tr><td data-l="Day">${dayLabel(x.day)}</td><td data-l="Closed by">${esc(x.closed_by_name || "")}</td><td data-l="Sales" class="num">${rupee(x.summary?.sales)}</td><td data-l="Expected" class="num">${rupee(x.cash_expected)}</td><td data-l="Counted" class="num">${rupee(x.cash_counted)}</td><td data-l="Difference" class="num ${Math.abs(x.difference) > 100 ? "bad" : ""}">${Number(x.difference) >= 0 ? "+" : "−"}${rupee(Math.abs(x.difference))}</td><td data-l="Note">${esc(x.note || "")}</td></tr>`
        ).join("")}</tbody></table>`
      : `<p class="soft">No days closed yet.</p>`;
    closeData.past = P;
  }
  const closeReport = () => {
    if (!closeData) return null;
    const s = closeData.summary;
    return {
      title: `Day report - ${dayLabel(closeData.day)}`,
      sections: [
        { kpis: [["Sales", rupee(s.sales)], ["Tables", String(s.tables)], ["Guests", String(s.guests)], ["Orders", String(s.orders)]] },
        { heading: "Money", head: ["", "Amount"], body: [["Cash", rupee(s.cash)], ["UPI", rupee(s.upi)], ["Card", rupee(s.card)], ["Discounts given", rupee(s.discounts)], ["GST on bills", rupee(s.tax)], ["Cash spent from drawer", rupee(closeData.cashOut)], ["Cash expected in drawer", rupee(closeData.cashExpected)], ...(closeData.closed ? [["Cash counted", rupee(closeData.closed.cash_counted)], ["Difference", rupee(closeData.closed.difference)]] : [])], align: { 1: "right" } },
        { heading: "Things to check", head: ["", "Count", "Amount"], body: [["Walk-outs", s.walkouts, rupee(s.walkout_amount)], ["Voids", s.voids, rupee(s.void_amount)], ["Cancelled orders", s.cancelled_orders, ""], ["Can't make", s.cant_make, ""], ["Payments voided", s.payments_voided, ""]], align: { 1: "right", 2: "right" } },
        { heading: "Top dishes", head: ["Dish", "Qty", "Sales"], body: (s.top_dishes || []).map((t) => [t.name, t.qty, rupee(t.amount)]), align: { 1: "right", 2: "right" }, empty: "No dishes sold." },
        ...(closeData.closed?.note ? [{ text: "Closing note: " + closeData.closed.note }] : []),
      ],
      file: `day-${closeData.day}`,
    };
  };

  // =====================================================================================
  // ACTIVITY
  let acts = [];
  const KIND = {
    money: ["payment", "payment_voided", "discount", "closed_unpaid", "day_closed"],
    orders: ["order_cancelled", "cant_make", "guests_confirmed"],
    menu: ["price_changed", "dish_added", "dish_removed", "dish_restored", "dish_on", "dish_sold_out", "dish_renamed"],
    team: ["staff_added", "staff_changed", "staff_deactivated", "staff_reactivated", "staff_account_created", "password_reset"],
    setup: ["branch_added", "branch_changed", "tables_added", "table_changed", "day_closed", "data_archived"],
  };
  function sentence(a) {
    const d = a.detail || {};
    const r = (n) => rupee(n);
    switch (a.action) {
      case "payment": return `took ${r(d.amount)} by ${METHOD[d.method] || d.method} · ${a.target || ""}`;
      case "payment_voided": return `voided a ${r(d.amount)} ${METHOD[d.method] || ""} payment · ${a.target || ""} · “${d.reason || ""}”`;
      case "discount": return `set a discount of ${r(d.to)} (was ${r(d.from)}) · ${a.target}`;
      case "closed_unpaid": return `closed ${a.target} without full payment: ${REASON[d.reason] || d.reason} · bill ${r(d.total)}, paid ${r(d.paid)}${d.note ? ` · “${d.note}”` : ""}`;
      case "order_cancelled": return `cancelled order ${a.target} (${r(d.total)})`;
      case "cant_make": return `marked “can't make”: ${a.target} · table ${d.table} (${r(d.amount)})`;
      case "guests_confirmed": return `confirmed ${d.guests || ""} guests at ${a.target}`;
      case "price_changed": return `changed the price of ${a.target}: ${r(d.from)} → ${r(d.to)}`;
      case "dish_added": return `added ${a.target} at ${r(d.price)}`;
      case "dish_removed": return `removed ${a.target} from the menu`;
      case "dish_restored": return `put ${a.target} back on the menu`;
      case "dish_on": return `switched ${a.target} back on`;
      case "dish_sold_out": return `marked ${a.target} sold out`;
      case "dish_renamed": return `renamed ${d.from} to ${a.target}`;
      case "staff_added": return `added ${a.target} as ${ROLE_NAMES[d.role] || d.role}`;
      case "staff_account_created": return `made a sign-in for ${a.target} (${ROLE_NAMES[d.role] || d.role})`;
      case "staff_changed": return `changed ${a.target}: ${ROLE_NAMES[d.role] || d.role}${d.branch !== d.was_branch ? ` at ${bname(d.branch)}` : ""}`;
      case "staff_deactivated": return `switched off ${a.target}'s sign-in`;
      case "staff_reactivated": return `switched ${a.target}'s sign-in back on`;
      case "password_reset": return `set a new password for ${a.target}`;
      case "branch_added": return `added the branch ${a.target}`;
      case "branch_changed": return `changed branch details for ${a.target}${d.tax_to != null ? ` (GST ${d.tax_from}% → ${d.tax_to}%)` : ""}`;
      case "tables_added": return `added tables ${a.target} (${d.count}, ${d.seats} seats)`;
      case "table_changed": return `changed ${a.target}: ${d.seats} seats, ${d.active ? "on" : "off"}`;
      case "day_closed": return `closed the day ${a.target}: sales ${r(d.sales)}, cash ${Number(d.difference) >= 0 ? "+" : "−"}${r(Math.abs(d.difference))}`;
      case "data_archived": return `archived old data ${a.target} (${d.tables} tables, ${d.orders} orders)`;
      default: return `${a.action.replace(/_/g, " ")} ${a.target || ""}`;
    }
  }
  const SERIOUS = new Set(["payment_voided", "closed_unpaid", "order_cancelled", "price_changed", "staff_deactivated", "data_archived", "dish_removed"]);
  async function loadActivity() {
    const [f, t] = rangeOf($("[data-range-bar=activity]"));
    let q = sb.from("activity_log").select("at, branch_id, actor_name, action, target, detail").gte("at", istStart(f)).lt("at", istStart(addDays(t, 1))).order("at", { ascending: false }).limit(3000);
    if (!isOwner()) q = q.eq("branch_id", c.branch);
    else q = q.or(`branch_id.eq.${c.branch},branch_id.is.null`);
    const { data, error } = await q;
    if (error) return ($("[data-activity]").innerHTML = `<p class="calm">${esc(friendly(error))}</p>`);
    acts = data || [];
    paintActivity();
  }
  function actRows() {
    const kind = $("[data-a-kind]").value;
    const q = $("[data-a-search]").value.trim().toLowerCase();
    return acts.filter((a) => (!kind || KIND[kind].includes(a.action)) && (!q || `${a.actor_name} ${sentence(a)}`.toLowerCase().includes(q)));
  }
  function paintActivity() {
    const list = actRows();
    $("[data-activity]").innerHTML = list.length
      ? `<ul class="alog">${list
          .map((a) => `<li class="${SERIOUS.has(a.action) ? "is-serious" : ""}"><time>${when(a.at)}</time><p><b>${esc(a.actor_name)}</b> ${esc(sentence(a))}</p></li>`)
          .join("")}</ul>`
      : `<div class="calm"><b>Nothing here.</b><span>Changes appear the moment they happen.</span></div>`;
  }
  wireRange($("[data-range-bar=activity]"), loadActivity);
  $("[data-a-kind]").addEventListener("change", paintActivity);
  $("[data-a-search]").addEventListener("input", paintActivity);
  const activityReport = () => ({
    title: "Activity",
    sections: [{ text: rangeText(rangeOf($("[data-range-bar=activity]"))) }, { head: ["When", "Who", "What"], body: actRows().map((a) => [when(a.at), a.actor_name, sentence(a)]), empty: "Nothing recorded." }],
    file: "activity",
  });

  // =====================================================================================
  // TEAM
  let team = [];
  async function loadTeam() {
    const { data, error } = await sb.from("staff").select("user_id, name, email, login, role, branch_id, active, phone, created_at").order("active", { ascending: false }).order("name");
    if (error) return ($("[data-team]").innerHTML = `<p class="calm">${esc(friendly(error))}</p>`);
    team = data || [];
    staffNames = Object.fromEntries(team.map((s) => [s.user_id, s.name]));
    const canEdit = (s) => isOwner() || (s.branch_id === c.me.branch_id && ["kitchen", "cashier", "waiter"].includes(s.role));
    const groups = isOwner() ? [["", "Owners"], ...c.branches.map((b) => [b.id, b.name])] : [[c.me.branch_id, bname(c.me.branch_id)]];
    $("[data-team]").innerHTML = groups
      .map(([bid, title]) => {
        const people = team.filter((s) => (bid ? s.branch_id === bid : !s.branch_id));
        if (!people.length) return "";
        return `<h2 class="h2">${esc(title)} <small>${people.filter((p) => p.active).length} active</small></h2><div class="people">${people
          .map(
            (s) => `<div class="person ${s.active ? "" : "is-off"}">
            <div><b>${esc(s.name)}</b><span class="rolechip rolechip--${s.role}">${ROLE_NAMES[s.role] || s.role}</span>${s.active ? "" : '<span class="rolechip">Switched off</span>'}</div>
            <p class="soft small">Sign-in: ${esc(s.login || s.email || "–")}${s.phone ? ` · ${c.telLink(s.phone)}` : ""}</p>
            ${canEdit(s) && s.user_id !== c.me.user_id ? `<div class="person__go"><button type="button" class="btn btn--line btn--sm" data-t-edit="${s.user_id}">Edit</button><button type="button" class="btn btn--line btn--sm" data-t-pw="${s.user_id}">New password</button></div>` : s.user_id === c.me.user_id ? '<p class="soft small">This is you.</p>' : ""}
          </div>`
          )
          .join("")}</div>`;
      })
      .join("");
  }
  const roleOptions = (sel) =>
    (isOwner() ? ["admin", "manager", "cashier", "waiter", "kitchen"] : ["cashier", "waiter", "kitchen"]).map((r) => `<option value="${r}" ${r === sel ? "selected" : ""}>${ROLE_NAMES[r]}</option>`).join("");
  const branchOptions = (sel) => c.branches.map((b) => `<option value="${b.id}" ${b.id === sel ? "selected" : ""}>${esc(b.name)}</option>`).join("");
  const ROLE_HELP = "Owner: everything, all branches · Manager: their branch, discounts, close the day, team · Cashier: tables, bills, payments · Waiter: takes orders on the phone, serves · Kitchen: the order board";
  async function callStaffFn(body) {
    const { data: auth } = await sb.auth.getSession();
    const r = await fetch(FN_STAFF, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth.session?.access_token}`, apikey: c.publishableKey }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) throw new Error(j.error || `http_${r.status}`);
    return j;
  }
  $("[data-t-add]").addEventListener("click", () => {
    const d = modal("Add a person", "They sign in with the name or email you set here.", `
      <form class="dform" data-f>
        <label>Full name<input name="name" required maxlength="60" autocomplete="off"></label>
        <label>Role<select name="role">${roleOptions("cashier")}</select><small>${ROLE_HELP}</small></label>
        <label data-brow>Branch<select name="branch">${isOwner() ? branchOptions(c.branch) : branchOptions(c.me.branch_id)}</select></label>
        <div class="dform__two"><label>Sign-in name<input name="login" maxlength="40" autocomplete="off" placeholder="e.g. ravi.k" pattern="[a-z0-9._\\-]{3,40}"><small>small letters, numbers, dot</small></label>
        <label>…or their email<input name="email" type="email" autocomplete="off" placeholder="optional"></label></div>
        <label>Mobile <small>optional</small><input name="phone" inputmode="tel" maxlength="14" autocomplete="off"></label>
        <label>Starting password<input name="password" type="text" minlength="8" maxlength="72" autocomplete="new-password" required><small>8 or more characters. Tell them in person; they can't reset it themselves.</small></label>
        <p class="err" data-err hidden></p>
        <div class="panel__foot"><button type="submit" class="btn btn--dark">Add and make sign-in</button></div>
      </form>`);
    const f = $("[data-f]", d);
    const syncBranch = () => ($("[data-brow]", d).hidden = f.role.value === "admin");
    f.role.addEventListener("change", syncBranch);
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      const err = $("[data-err]", d);
      err.hidden = true;
      const btn = $("button[type=submit]", f);
      btn.disabled = true;
      try {
        const r = await callStaffFn({ action: "create", name: f.name.value, role: f.role.value, branch: f.branch.value, login: f.login.value, email: f.email.value, phone: f.phone.value, password: f.password.value });
        d.close();
        toast(`${f.name.value} can now sign in as “${r.signIn}”.`);
        loadTeam();
      } catch (x) {
        err.textContent = friendly(x);
        err.hidden = false;
      } finally {
        btn.disabled = false;
      }
    });
  });
  $("[data-team]").addEventListener("click", (e) => {
    const ed = e.target.closest("[data-t-edit]");
    const pw = e.target.closest("[data-t-pw]");
    if (ed) {
      const s = team.find((x) => x.user_id === ed.dataset.tEdit);
      const d = modal(`Edit ${s.name}`, "", `
        <form class="dform" data-f>
          <label>Full name<input name="name" required maxlength="60" value="${esc(s.name)}"></label>
          <label>Role<select name="role">${roleOptions(s.role)}</select></label>
          <label data-brow ${s.role === "admin" ? "hidden" : ""}>Branch<select name="branch">${isOwner() ? branchOptions(s.branch_id) : branchOptions(c.me.branch_id)}</select></label>
          <label>Mobile<input name="phone" inputmode="tel" maxlength="14" value="${esc(c.fmtPhone(s.phone || ""))}"></label>
          <label class="switchlab"><input type="checkbox" name="active" ${s.active ? "checked" : ""}> Can sign in</label>
          <p class="soft small">Switching someone off stops them at once, on every phone. Their past work stays in the records.</p>
          <p class="err" data-err hidden></p>
          <div class="panel__foot"><button type="submit" class="btn btn--dark">Save</button></div>
        </form>`);
      const f = $("[data-f]", d);
      f.role.addEventListener("change", () => ($("[data-brow]", d).hidden = f.role.value === "admin"));
      f.addEventListener("submit", async (ev) => {
        ev.preventDefault();
        if (s.active && !f.active.checked && !confirm(`Switch off ${s.name}? They are signed out everywhere straight away.`)) return;
        const { error } = await sb.rpc("update_staff", { p_user: s.user_id, p_name: f.name.value, p_role: f.role.value, p_branch: f.role.value === "admin" ? null : f.branch.value, p_active: f.active.checked, p_phone: f.phone.value });
        if (error) return (($("[data-err]", d).textContent = friendly(error)), ($("[data-err]", d).hidden = false));
        d.close();
        toast("Saved");
        loadTeam();
      });
    }
    if (pw) {
      const s = team.find((x) => x.user_id === pw.dataset.tPw);
      const p = prompt(`New password for ${s.name} (8 or more characters).\nTell them in person.`);
      if (p === null) return;
      if (p.length < 8) return toast("Use 8 or more characters.", "err");
      callStaffFn({ action: "set_password", userId: s.user_id, password: p }).then(
        () => toast(`New password set for ${s.name}`),
        (x) => toast(friendly(x), "err")
      );
    }
  });
  const teamReport = () => ({
    title: "Team",
    sections: [{ head: ["Name", "Role", "Branch", "Sign-in", "Mobile", "Status"], body: team.map((s) => [s.name, ROLE_NAMES[s.role], s.branch_id ? bname(s.branch_id) : "All", s.login || s.email || "-", c.fmtPhone(s.phone || "") || "-", s.active ? "Active" : "Switched off"]) }],
    file: "team",
  });

  // =====================================================================================
  // SETUP: branches, tables, QR cards, data
  let allBranches = [];
  let tablesBy = {};
  async function loadSetup() {
    const [b, t, age] = await Promise.all([
      sb.from("branches").select("*").order("sort"),
      sb.from("dining_tables").select("branch_id, label, seats, active"),
      sb.rpc("data_age"),
    ]);
    allBranches = b.data || [];
    tablesBy = {};
    for (const x of t.data || []) (tablesBy[x.branch_id] ||= []).push(x);
    for (const k in tablesBy) tablesBy[k].sort((a, z) => a.label.localeCompare(z.label, "en", { numeric: true }));
    paintData(age.data);
    $("[data-setup]").innerHTML = `<p class="soft small">${allBranches.length} branches · ${allBranches.filter((x) => x.active).length} open to guests</p>` + allBranches
      .map((br) => {
        const tl = tablesBy[br.id] || [];
        const hours = br.opens && br.closes ? `${br.opens.slice(0, 5)}–${br.closes.slice(0, 5)}` : "hours not set";
        return `<div class="card branch ${br.active ? "" : "is-off"}">
          <div class="branch__head"><div><h2 class="h3">${esc(br.name)} ${br.active ? "" : '<span class="rolechip">Closed to guests</span>'}</h2>
          <p class="soft small">${esc(br.address || "Address not set")} · ${esc(br.phone || "phone not set")} · ${hours} · GST ${Number(br.tax_percent)}% · packing ₹${Number(br.parcel_charge)} · Seated check ${br.seat_confirm ? "on" : "off"}</p></div>
          <div class="person__go"><button type="button" class="btn btn--line btn--sm" data-s-edit="${br.id}">Edit</button><button type="button" class="btn btn--line btn--sm" data-s-tables="${br.id}">+ Tables</button><button type="button" class="btn btn--line btn--sm" data-s-qr="${br.id}" ${tl.length ? "" : "disabled"}>Print QR cards</button></div></div>
          <div class="tchips">${tl.length ? tl.map((x) => `<button type="button" class="tchip ${x.active ? "" : "is-off"}" data-s-table="${br.id}|${esc(x.label)}" title="${x.seats} seats">${esc(x.label)}<small>${x.seats}</small></button>`).join("") : '<p class="soft small">No tables yet. Add them with “+ Tables”.</p>'}</div>
        </div>`;
      })
      .join("");
  }
  function branchForm(br) {
    const v = (k) => esc(br?.[k] ?? "");
    const d = modal(br ? `Edit ${br.name}` : "Add a branch", br ? "Changes show on the website and every table straight away." : "Add its tables after saving.", `
      <form class="dform" data-f>
        <label>Branch name<input name="name" required maxlength="60" value="${v("name")}" placeholder="e.g. Anna Nagar"></label>
        <label>Address<input name="address" maxlength="200" value="${v("address")}"></label>
        <div class="dform__two"><label>Phone<input name="phone" maxlength="20" value="${v("phone")}" inputmode="tel"></label>
        <label>Google Maps link<input name="map_url" maxlength="500" value="${v("map_url")}" placeholder="https://maps.app.goo.gl/…"></label></div>
        <div class="dform__two"><label>Opens<input name="opens" type="time" value="${br?.opens?.slice(0, 5) || ""}"></label><label>Closes<input name="closes" type="time" value="${br?.closes?.slice(0, 5) || ""}"></label></div>
        <div class="dform__two"><label>GST %<input name="tax_percent" type="number" min="0" max="28" step="0.5" value="${br ? Number(br.tax_percent) : 5}"></label>
        <label>Packing charge ₹ <small>per parcel item</small><input name="parcel_charge" type="number" min="0" max="200" step="1" value="${br ? Number(br.parcel_charge) : 0}"></label></div>
        <div class="dform__two"><label>GSTIN <small>optional</small><input name="gstin" maxlength="15" value="${v("gstin")}" placeholder="33ABCDE1234F1Z5" style="text-transform:uppercase"></label>
        <label>Google review link<input name="google_review_url" maxlength="500" value="${v("google_review_url")}"></label></div>
        <label class="switchlab"><input type="checkbox" name="seat_confirm" ${!br || br.seat_confirm ? "checked" : ""}> Seated check (first order waits until staff confirm the guests)</label>
        <label class="switchlab"><input type="checkbox" name="active" ${!br || br.active ? "checked" : ""}> Open to guests (QR ordering works)</label>
        <p class="err" data-err hidden></p>
        <div class="panel__foot"><button type="submit" class="btn btn--dark">Save</button></div>
      </form>`);
    const f = $("[data-f]", d);
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      const row = {
        name: f.name.value.trim(), address: f.address.value.trim() || null, phone: f.phone.value.trim() || null, map_url: f.map_url.value.trim() || null,
        opens: f.opens.value || null, closes: f.closes.value || null, tax_percent: Number(f.tax_percent.value), parcel_charge: Number(f.parcel_charge.value),
        google_review_url: f.google_review_url.value.trim() || null, seat_confirm: f.seat_confirm.checked, active: f.active.checked,
        gstin: f.gstin.value.trim().toUpperCase() || null,
      };
      if (row.name.length < 2) return (($("[data-err]", d).textContent = "Give the branch a name."), ($("[data-err]", d).hidden = false));
      let res;
      if (br) {
        if (Number(br.tax_percent) !== row.tax_percent && !confirm(`Change GST at ${br.name} from ${Number(br.tax_percent)}% to ${row.tax_percent}%?\nNew bills use it at once; past bills don't change.`)) return;
        res = await sb.from("branches").update(row).eq("id", br.id);
      } else {
        const id = row.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
        if (allBranches.some((x) => x.id === id)) return (($("[data-err]", d).textContent = "A branch with that name already exists."), ($("[data-err]", d).hidden = false));
        res = await sb.from("branches").insert({ id, sort: allBranches.length, ...row });
      }
      if (res.error) return (($("[data-err]", d).textContent = friendly(res.error)), ($("[data-err]", d).hidden = false));
      d.close();
      toast("Saved");
      await c.reloadBranches();
      loadSetup();
    });
  }
  $("[data-s-addbranch]").addEventListener("click", () => branchForm(null));
  $("[data-setup]").addEventListener("click", async (e) => {
    const ed = e.target.closest("[data-s-edit]");
    if (ed) return branchForm(allBranches.find((x) => x.id === ed.dataset.sEdit));
    const tb = e.target.closest("[data-s-tables]");
    if (tb) {
      const br = allBranches.find((x) => x.id === tb.dataset.sTables);
      const d = modal(`Tables at ${br.name}`, "Add a run of numbers, e.g. 1 to 20, or A1 to A8 for a section.", `
        <form class="dform" data-f>
          <div class="dform__two"><label>From<input name="from" type="number" min="1" max="999" value="1" required></label><label>To<input name="to" type="number" min="1" max="999" value="10" required></label></div>
          <div class="dform__two"><label>Section letter <small>optional</small><input name="prefix" maxlength="3" pattern="[A-Za-z]{0,3}" placeholder="A"></label><label>Seats each<input name="seats" type="number" min="1" max="30" value="4"></label></div>
          <p class="soft small">Existing tables with the same name are switched back on, never doubled.</p>
          <div class="panel__foot"><button type="submit" class="btn btn--dark">Add tables</button></div>
        </form>`);
      $("[data-f]", d).addEventListener("submit", async (ev) => {
        ev.preventDefault();
        const f = ev.target;
        if (await act($("button", f), () => sb.rpc("add_tables", { p_branch: br.id, p_from: Number(f.from.value), p_to: Number(f.to.value), p_prefix: f.prefix.value, p_seats: Number(f.seats.value) }), "Tables added")) {
          d.close();
          loadSetup();
        }
      });
      return;
    }
    const tc = e.target.closest("[data-s-table]");
    if (tc) {
      const [bid, label] = tc.dataset.sTable.split("|");
      const x = tablesBy[bid].find((t) => t.label === label);
      const d = modal(`Table ${label}`, bname(bid), `
        <form class="dform" data-f><label>Seats<input name="seats" type="number" min="1" max="30" value="${x.seats}"></label>
        <label class="switchlab"><input type="checkbox" name="active" ${x.active ? "checked" : ""}> In use (guests can order from its QR)</label>
        <div class="panel__foot"><button type="submit" class="btn btn--dark">Save</button></div></form>`);
      $("[data-f]", d).addEventListener("submit", async (ev) => {
        ev.preventDefault();
        if (await act($("button", ev.target), () => sb.rpc("update_table", { p_branch: bid, p_label: label, p_seats: Number(ev.target.seats.value), p_active: ev.target.active.checked }), "Saved")) {
          d.close();
          loadSetup();
        }
      });
      return;
    }
    const qr = e.target.closest("[data-s-qr]");
    if (qr) printQr(allBranches.find((x) => x.id === qr.dataset.sQr), (tablesBy[qr.dataset.sQr] || []).filter((t) => t.active));
  });

  async function printQr(br, list) {
    const { default: qrcode } = await import("qrcode-generator");
    const base = new URL("../order.html", location.href).href;
    const cards = list
      .map((t) => {
        const url = `${base}?branch=${encodeURIComponent(br.id)}&table=${encodeURIComponent(t.label)}`;
        const q = qrcode(0, "M");
        q.addData(url);
        q.make();
        return `<div class="qrcard"><p class="qrcard__brand">HOTEL PANDIA'S</p>${q.createSvgTag({ cellSize: 6, margin: 2, scalable: true })}<p class="qrcard__t">Table ${esc(t.label)}</p><p class="qrcard__h">Scan to order · ${esc(br.name)}</p></div>`;
      })
      .join("");
    const w = window.open("", "_blank");
    if (!w) return toast("Allow pop-ups to print the QR cards.", "err");
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>QR cards · ${esc(br.name)}</title><style>
      @page { size: A4; margin: 10mm; } body { margin: 0; font-family: system-ui, sans-serif; color: #3a0a10; }
      .sheet { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6mm; }
      .qrcard { break-inside: avoid; border: 1.5px solid #3a0a10; border-radius: 4mm; padding: 5mm; text-align: center; }
      .qrcard svg { width: 100%; height: auto; display: block; }
      .qrcard__brand { margin: 0 0 2mm; font-weight: 800; letter-spacing: .12em; font-size: 10pt; }
      .qrcard__t { margin: 2mm 0 0; font-weight: 800; font-size: 22pt; } .qrcard__h { margin: 1mm 0 0; font-size: 9pt; color: #7a5a4c; }
      .note { font-size: 10pt; color: #7a5a4c; margin: 0 0 6mm; } @media print { .note { display: none; } }
    </style></head><body><p class="note">${list.length} cards for ${esc(br.name)}. Each opens ${esc(base)} for its table. Print, cut, and place one on each table.</p><div class="sheet">${cards}</div><script>onload = () => setTimeout(() => print(), 300)<\/script></body></html>`);
    w.document.close();
  }

  // ---------- the 12-month rule (owner)
  function paintData(age) {
    const box = $("[data-s-data]");
    if (!age) return (box.innerHTML = "");
    const due = Number(age.dueRows);
    const soon = Number(age.soonRows);
    box.innerHTML = `<div class="card data ${due ? "is-due" : soon ? "is-soon" : ""}">
      <h2 class="h3">Your data</h2>
      <p>Every bill, order and payment is kept for 12 months. Day totals are kept forever. Nothing is ever removed without you.</p>
      <p class="soft small">Oldest record: ${age.oldest ? dayLabel(age.oldest.slice(0, 10)) : "none yet"} · records older than 12 months: ${due} · turning 12 months in the next 30 days: ${Math.max(0, soon - due)}</p>
      ${due ? `<p><b>${due} tables are older than 12 months.</b> Download the archive, keep it in two places, then remove them.</p>
        <div class="person__go"><button type="button" class="btn btn--line" data-d-dl>1. Download archive (Excel)</button><button type="button" class="btn btn--dark" data-d-rm disabled>2. Remove from the app</button></div>` : soon ? `<p><b>Heads up:</b> some records turn 12 months old within 30 days. You'll be asked to download and archive them then.</p>` : ""}
    </div>`;
    $("[data-d-dl]")?.addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      const cut = istStart(age.cutoff);
      const [s, o, p] = await Promise.all([
        sb.from("table_sessions").select("id, branch_id, table_label, status, close_reason, opened_at, closed_at, subtotal, tax, discount, total, guests_max, customers(name, phone)").lt("opened_at", cut).limit(100000),
        sb.from("orders").select("code, session_id, branch_id, table_label, status, created_at, order_items(name, qty, unit_price, parcel_fee, unavailable_at)").lt("created_at", cut).limit(100000),
        sb.from("payments").select("session_id, branch_id, amount, method, received_by, created_at, voided_at, void_reason").lt("created_at", cut).limit(100000),
      ]);
      btn.disabled = false;
      if (s.error || o.error || p.error) return toast("Couldn't download. Try again.", "err");
      csv([["Bill id", "Branch", "Table", "Opened", "Closed", "Status", "Guest", "Mobile", "Guests", "Subtotal", "Discount", "GST", "Total"], ...s.data.map((x) => [x.id, bname(x.branch_id), x.table_label, x.opened_at, x.closed_at, x.close_reason || x.status, x.customers?.name, x.customers?.phone, x.guests_max, x.subtotal, x.discount, x.tax, x.total])], `pandias-archive-bills-before-${age.cutoff}.csv`);
      csv([["Bill id", "Branch", "Table", "Order", "Time", "Item", "Qty", "Price", "Packing", "Ran out"], ...o.data.flatMap((x) => x.order_items.map((i) => [x.session_id, bname(x.branch_id), x.table_label, x.code, x.created_at, i.name, i.qty, i.unit_price, i.parcel_fee, i.unavailable_at ? "yes" : ""]))], `pandias-archive-items-before-${age.cutoff}.csv`);
      csv([["Bill id", "Branch", "Time", "Method", "Amount", "Voided", "Void reason"], ...p.data.map((x) => [x.session_id, bname(x.branch_id), x.created_at, x.method, x.amount, x.voided_at || "", x.void_reason || ""])], `pandias-archive-payments-before-${age.cutoff}.csv`);
      toast("Three archive files downloaded. Keep them in two safe places.");
      $("[data-d-rm]").disabled = false;
    });
    $("[data-d-rm]")?.addEventListener("click", async (e) => {
      const phrase = `REMOVE BEFORE ${age.cutoff}`;
      const typed = prompt(`This permanently removes ${due} bills (and their orders, payments and feedback) from before ${dayLabel(age.cutoff)} from the app.\nDay totals stay. It can't be undone.\n\nOnly continue if the archive files are saved safely.\n\nType exactly:  ${phrase}`);
      if (typed === null) return;
      if (typed.trim() !== phrase) return toast("The words didn't match. Nothing was removed.", "err");
      const { data, error } = await sb.rpc("archive_remove", { p_before: age.cutoff, p_confirm: phrase });
      if (error) return toast(friendly(error), "err");
      toast(`Archived: ${data.tables} bills, ${data.orders} orders removed from the app.`);
      loadSetup();
    });
  }
  /** a banner on Today for the owner when old data is due */
  async function todayBanner() {
    if (!isOwner()) return "";
    const { data } = await sb.rpc("data_age");
    if (!data || !Number(data.soonRows)) return "";
    return Number(data.dueRows)
      ? `<a class="banner banner--due" href="#setup"><b>${data.dueRows} bills are older than 12 months.</b> Download the archive and clear them in Setup.</a>`
      : `<a class="banner" href="#setup"><b>Some records turn 12 months old within 30 days.</b> You'll download an archive in Setup.</a>`;
  }

  // ---------- route hooks
  const LOAD = { bills: loadBills, close: loadClose, activity: loadActivity, team: loadTeam, setup: loadSetup };
  const REPORTS = { bills: billsReport, close: closeReport, activity: activityReport, team: teamReport };
  document.addEventListener("click", (e) => {
    const x = e.target.closest("[data-xls]");
    if (!x) return;
    if (x.dataset.xls === "bills") {
      const list = billRows();
      const [f, t] = rangeOf($("[data-range-bar=bills]"));
      csv([["When", "Branch", "Table", "Guest", "Mobile", "Orders", "Status", "Paid by", "Made by", "Subtotal", "Discount", "GST", "Total"], ...list.map((s) => [when(s.opened_at), bname(s.branch_id), s.table_label, s.customers?.name || "", c.fmtPhone(s.customers?.phone || ""), s.nOrders, STATE_LABEL[s.state], [...new Set(s.live.map((p) => METHOD[p.method]))].join(" + "), [...new Set(s.live.map((p) => who(p.received_by)))].join(", "), s.subtotal, s.discount, s.tax, s.total])], `pandias-${c.branch}-bills-${f}-to-${t}.csv`);
    }
    if (x.dataset.xls === "activity") csv([["When", "Who", "What"], ...actRows().map((a) => [when(a.at), a.actor_name, sentence(a)])], `pandias-${c.branch}-activity.csv`);
  });
  return {
    roles: Object.fromEntries(Object.entries(SCREENS).map(([k, s]) => [k, s.roles])),
    load: (k) => LOAD[k]?.(),
    reports: REPORTS,
    todayBanner,
    refreshIfOpen: (k) => k === "close" && LOAD.close(),
  };
}
