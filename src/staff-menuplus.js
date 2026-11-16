// Hotel Pandia's staff app: the owner's extra menu controls.
//   More settings (per dish)  photo, serving hours and days, "goes well with", combo contents, per-branch on/off and price
//   Offers                    % off or a fixed price, by dish / category / branch / day / hours / dates
//   Category hours            e.g. Tiffin 6:00–11:30 for every dish in it
// Photos are resized in the browser to two WebP sizes (800 px and 400 px) before upload, so the
// guest pages stay fast. The database checks the owner again on every change.

const PHOTO_BASE = "https://vlbnicfcjddaehyjindr.supabase.co/storage/v1/object/public/menu-photos/";
export const photoUrl = (path, size = 400) => (path ? `${PHOTO_BASE}${path}-${size}.webp` : "");
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function initMenuPlus(c) {
  const { sb, $, $$, esc, rupee, toast, act, friendly } = c;
  const baseOf = (id) => id.split("--")[0];
  const plain = (m) => (m.id.includes("--") ? m.name.replace(/\s\((?:[^()]|\([^()]*\))*\)$/, "") : m.name);
  const choice = (m) => m.name.match(/\(((?:[^()]|\([^()]*\))*)\)$/)?.[1] || "";
  function modal(title, sub, body) {
    const d = document.createElement("dialog");
    d.className = "panel panel--wide";
    d.innerHTML = `<header class="panel__head"><div><h2>${esc(title)}</h2>${sub ? `<p class="soft">${esc(sub)}</p>` : ""}</div><button type="button" class="x" data-x aria-label="Close">×</button></header><div class="panel__body">${body}</div>`;
    document.body.append(d);
    d.addEventListener("close", () => d.remove());
    d.addEventListener("click", (e) => (e.target === d || e.target.closest("[data-x]")) && d.close());
    d.showModal();
    return d;
  }
  const dishes = (menu) => {
    const seen = new Map();
    for (const m of menu) if (!m.deleted_at && !seen.has(baseOf(m.id))) seen.set(baseOf(m.id), plain(m));
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  };
  const hm = (t) => (t ? t.slice(0, 5) : "");

  // ---------- resize to WebP in the browser
  async function toWebp(file, width) {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, width / bmp.width);
    const cv = document.createElement("canvas");
    cv.width = Math.round(bmp.width * scale);
    cv.height = Math.round(bmp.height * scale);
    cv.getContext("2d").drawImage(bmp, 0, 0, cv.width, cv.height);
    return new Promise((res, rej) => cv.toBlob((b) => (b ? res(b) : rej(new Error("photo"))), "image/webp", 0.8));
  }

  // =====================================================================================
  // MORE SETTINGS for one dish
  async function openExtras(base, menu, categories) {
    const rows = menu.filter((m) => baseOf(m.id) === base && !m.deleted_at);
    if (!rows.length) return;
    const m0 = rows[0];
    const [{ data: bm }, { data: br }, { data: sug }] = await Promise.all([
      sb.from("branch_menu").select("branch_id, item_id, available, price").in("item_id", rows.map((r) => r.id)),
      sb.from("branches").select("id, name").order("sort"),
      sb.rpc("pair_suggestions", { p_base: base }),
    ]);
    const bmap = Object.fromEntries((bm || []).map((x) => [x.branch_id + "|" + x.item_id, x]));
    const all = dishes(menu).filter(([b]) => b !== base);
    const opt = (sel) => `<option value="">–</option>` + all.map(([b, n]) => `<option value="${esc(b)}" ${b === sel ? "selected" : ""}>${esc(n)}</option>`).join("");
    const combo = Array.isArray(m0.combo) ? m0.combo : [];
    const d = modal(plain(m0), "Photo, hours, pairings, combo and branches", `
      <form class="dform" data-f>
        <fieldset class="xs"><legend>Photo</legend>
          <div class="xphoto">${m0.photo ? `<img src="${photoUrl(m0.photo, 400)}" alt="" width="160" height="120">` : `<div class="xphoto__none">No photo yet</div>`}
          <div><input type="file" accept="image/*" data-photo-file><p class="soft small">A clear, bright photo of the plate. It's resized for you (fast to load).</p>${m0.photo ? `<button type="button" class="link" data-photo-rm>Remove photo</button>` : ""}</div></div>
        </fieldset>
        <fieldset class="xs"><legend>When it's served <small>leave empty for all day, every day</small></legend>
          <div class="dform__two"><label>From<input type="time" name="from" value="${hm(m0.serve_from)}"></label><label>To<input type="time" name="to" value="${hm(m0.serve_to)}"></label></div>
          <div class="dform__chips">${DAYS.map((n, i) => `<label><input type="checkbox" name="day" value="${i}" ${!m0.serve_days || m0.serve_days.includes(i) ? "checked" : ""}><span>${n}</span></label>`).join("")}</div>
        </fieldset>
        <fieldset class="xs"><legend>Goes well with <small>suggested to guests after they add this</small></legend>
          <div class="xpairs">${[0, 1, 2, 3].map((i) => `<select name="pair">${opt(m0.pairs?.[i])}</select>`).join("")}</div>
          ${(sug || []).length ? `<p class="soft small">Often ordered together: ${sug.map((s) => `<button type="button" class="chip" data-sug="${esc(s.base)}">${esc(s.name)} · ${s.together}</button>`).join(" ")}</p>` : ""}
        </fieldset>
        <fieldset class="xs"><legend>Combo contents <small>only for a combo / meal; shown on the kitchen ticket</small></legend>
          <div data-combo>${[...combo, {}, {}].slice(0, Math.max(3, combo.length + 1)).map((x) => `<div class="xcombo"><select name="cdish">${opt(x.id)}</select><input name="cqty" type="number" min="1" max="10" value="${x.qty || 1}"></div>`).join("")}</div>
        </fieldset>
        <fieldset class="xs"><legend>Branches <small>switch off at one branch, or charge a different price there</small></legend>
          <table class="gt xbr"><thead><tr><th>Branch</th>${rows.map((r) => `<th>${esc(choice(r) || "Price")} <small>${rupee(r.price)}</small></th>`).join("")}<th>Sold there</th></tr></thead><tbody>${(br || [])
            .map(
              (b) => `<tr><td data-l="Branch"><b>${esc(b.name)}</b></td>${rows
                .map((r) => `<td data-l="${esc(choice(r) || "Price")}"><input type="number" min="0" step="1" inputmode="numeric" placeholder="${Number(r.price)}" data-bp="${esc(b.id)}|${esc(r.id)}" value="${bmap[b.id + "|" + r.id]?.price ?? ""}"></td>`)
                .join("")}<td data-l="Sold there"><input type="checkbox" data-ba="${esc(b.id)}" ${rows.every((r) => bmap[b.id + "|" + r.id]?.available !== false) ? "checked" : ""}></td></tr>`
            )
            .join("")}</tbody></table>
        </fieldset>
        <p class="err" data-err hidden></p>
        <div class="panel__foot"><button type="submit" class="btn btn--dark">Save</button></div>
      </form>`);
    const f = $("[data-f]", d);
    d.addEventListener("click", (e) => {
      const s = e.target.closest("[data-sug]");
      if (!s) return;
      const empty = [...f.querySelectorAll("[name=pair]")].find((x) => !x.value);
      if (empty) empty.value = s.dataset.sug;
    });
    $("[data-photo-rm]", d)?.addEventListener("click", async (e) => {
      if (!confirm("Remove this photo? Guests see the dish without a picture.")) return;
      if (await act(e.target, () => sb.rpc("set_item_photo", { p_base: base, p_path: null }), "Photo removed")) (d.close(), c.reloadMenu());
    });
    $("[data-photo-file]", d).addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      e.target.disabled = true;
      toast("Preparing the photo…");
      try {
        const path = `${base}/${Date.now()}`;
        const [big, small] = await Promise.all([toWebp(file, 800), toWebp(file, 400)]);
        for (const [blob, size] of [[big, 800], [small, 400]]) {
          const { error } = await sb.storage.from("menu-photos").upload(`${path}-${size}.webp`, blob, { contentType: "image/webp", cacheControl: "31536000", upsert: true });
          if (error) throw error;
        }
        const { error } = await sb.rpc("set_item_photo", { p_base: base, p_path: path });
        if (error) throw error;
        toast("Photo saved. Guests see it straight away.");
        const box = $(".xphoto", d);
        box.firstElementChild.outerHTML = `<img src="${photoUrl(path, 400)}" alt="" width="160" height="120">`;
        c.reloadMenu();
      } catch (x) {
        toast(friendly(x), "err");
      } finally {
        e.target.disabled = false;
      }
    });
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      const err = $("[data-err]", d);
      err.hidden = true;
      const days = [...f.querySelectorAll("[name=day]:checked")].map((x) => Number(x.value));
      if (!days.length) return ((err.textContent = "Pick at least one day."), (err.hidden = false));
      if (!!f.from.value !== !!f.to.value) return ((err.textContent = "Set both From and To, or leave both empty."), (err.hidden = false));
      const pairs = [...new Set([...f.querySelectorAll("[name=pair]")].map((x) => x.value).filter(Boolean))];
      const comboRows = [...f.querySelectorAll(".xcombo")].map((r) => ({ id: $("[name=cdish]", r).value, qty: Number($("[name=cqty]", r).value) || 1 })).filter((x) => x.id);
      const btn = $("button[type=submit]", f);
      btn.disabled = true;
      try {
        let r = await sb.rpc("set_dish_extras", { p_base: base, p_from: f.from.value || null, p_to: f.to.value || null, p_days: days, p_pairs: pairs, p_combo: comboRows });
        if (r.error) throw r.error;
        // branch changes (only the ones that differ from what was there)
        for (const inp of f.querySelectorAll("[data-bp]")) {
          const [bid, item] = inp.dataset.bp.split("|");
          const was = bmap[bid + "|" + item]?.price ?? null;
          const now = inp.value === "" ? null : Number(inp.value);
          if (now !== (was === null ? null : Number(was))) {
            r = await sb.rpc("set_branch_price", { p_branch: bid, p_item: item, p_price: now });
            if (r.error) throw r.error;
          }
        }
        for (const cb of f.querySelectorAll("[data-ba]")) {
          const bid = cb.dataset.ba;
          for (const row of rows) {
            const was = bmap[bid + "|" + row.id]?.available !== false;
            if (cb.checked !== was) {
              r = await sb.rpc("set_branch_item", { p_branch: bid, p_item: row.id, p_available: cb.checked });
              if (r.error) throw r.error;
            }
          }
        }
        d.close();
        toast("Saved");
        c.reloadMenu();
      } catch (x) {
        err.textContent = friendly(x);
        err.hidden = false;
      } finally {
        btn.disabled = false;
      }
    });
  }

  // =====================================================================================
  // OFFERS
  async function openOffers(menu, categories) {
    const [{ data: offers }, { data: br }] = await Promise.all([sb.from("offers").select("*").order("active", { ascending: false }).order("created_at", { ascending: false }), sb.from("branches").select("id, name").order("sort")]);
    const names = Object.fromEntries(dishes(menu));
    const catName = Object.fromEntries(categories.map((k) => [k.id, k.name]));
    const describe = (o) =>
      `${o.kind === "percent" ? `${Number(o.value)}% off` : `${rupee(o.value)} each`} · ${[...(o.item_ids || []).map((i) => names[i] || i), ...(o.category_ids || []).map((k) => catName[k] || k)].join(", ")}` +
      `${o.branch_ids ? " · " + o.branch_ids.map((b) => (br || []).find((x) => x.id === b)?.name || b).join(", ") : " · all branches"}` +
      `${o.days ? " · " + o.days.map((i) => DAYS[i]).join(" ") : ""}${o.start_time ? ` · ${hm(o.start_time)}–${hm(o.end_time)}` : ""}${o.starts_on || o.ends_on ? ` · ${o.starts_on || "…"} to ${o.ends_on || "…"}` : ""}`;
    const d = modal("Offers", "Happy hours, weekday deals, festival prices. Guests see the offer price with the old price struck out.", `
      <div class="person__go"><button type="button" class="btn btn--gold" data-new>+ New offer</button></div>
      <div class="offers">${(offers || []).length ? offers.map((o) => `<div class="offer ${o.active ? "" : "is-off"}"><div><b>${esc(o.name)}</b>${o.active ? "" : ' <span class="rolechip">Off</span>'}<p class="soft small">${esc(describe(o))}</p></div><button type="button" class="btn btn--line btn--sm" data-edit="${o.id}">Edit</button></div>`).join("") : '<p class="soft">No offers yet.</p>'}</div>`);
    d.addEventListener("click", (e) => {
      if (e.target.closest("[data-new]")) (d.close(), offerForm(null, menu, categories, br || []));
      const ed = e.target.closest("[data-edit]");
      if (ed) (d.close(), offerForm(offers.find((o) => String(o.id) === ed.dataset.edit), menu, categories, br || []));
    });
  }
  function offerForm(o, menu, categories, br) {
    const list = dishes(menu);
    const d = modal(o ? `Edit ${o.name}` : "New offer", "Pick the dishes or whole categories it applies to.", `
      <form class="dform" data-f>
        <label>Name guests see<input name="name" required maxlength="60" value="${esc(o?.name || "")}" placeholder="e.g. Weekday lunch 10% off"></label>
        <div class="dform__two"><label>Type<select name="kind"><option value="percent" ${o?.kind !== "price" ? "selected" : ""}>% off</option><option value="price" ${o?.kind === "price" ? "selected" : ""}>Fixed price (₹ each)</option></select></label>
        <label>Value<input name="value" type="number" min="1" step="1" required value="${o ? Number(o.value) : 10}"></label></div>
        <fieldset class="xs"><legend>Categories</legend><div class="dform__chips">${categories.map((k) => `<label><input type="checkbox" name="cat" value="${esc(k.id)}" ${o?.category_ids?.includes(k.id) ? "checked" : ""}><span>${esc(k.name)}</span></label>`).join("")}</div></fieldset>
        <fieldset class="xs"><legend>…or single dishes <small>hold Ctrl / ⌘ to pick several</small></legend><select name="items" multiple size="7">${list.map(([b, n]) => `<option value="${esc(b)}" ${o?.item_ids?.includes(b) ? "selected" : ""}>${esc(n)}</option>`).join("")}</select></fieldset>
        <fieldset class="xs"><legend>Branches <small>none ticked = every branch</small></legend><div class="dform__chips">${br.map((b) => `<label><input type="checkbox" name="br" value="${esc(b.id)}" ${o?.branch_ids?.includes(b.id) ? "checked" : ""}><span>${esc(b.name)}</span></label>`).join("")}</div></fieldset>
        <fieldset class="xs"><legend>Days</legend><div class="dform__chips">${DAYS.map((n, i) => `<label><input type="checkbox" name="day" value="${i}" ${!o?.days || o.days.includes(i) ? "checked" : ""}><span>${n}</span></label>`).join("")}</div></fieldset>
        <div class="dform__two"><label>From time <small>optional</small><input type="time" name="st" value="${hm(o?.start_time)}"></label><label>To time<input type="time" name="et" value="${hm(o?.end_time)}"></label></div>
        <div class="dform__two"><label>Starts on <small>optional</small><input type="date" name="sd" value="${o?.starts_on || ""}"></label><label>Ends on<input type="date" name="ed" value="${o?.ends_on || ""}"></label></div>
        <label class="switchlab"><input type="checkbox" name="active" ${!o || o.active ? "checked" : ""}> Offer is on</label>
        <p class="err" data-err hidden></p>
        <div class="panel__foot"><button type="submit" class="btn btn--dark">Save offer</button></div>
      </form>`);
    const f = $("[data-f]", d);
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      const vals = (n) => [...f.querySelectorAll(`[name=${n}]:checked`)].map((x) => x.value);
      const items = [...f.items.selectedOptions].map((x) => x.value);
      const { error } = await sb.rpc("save_offer", {
        p_id: o?.id ?? null, p_name: f.name.value, p_kind: f.kind.value, p_value: Number(f.value.value), p_items: items, p_categories: vals("cat"),
        p_branches: vals("br"), p_days: vals("day").map(Number), p_start: f.st.value || null, p_end: f.et.value || null,
        p_from: f.sd.value || null, p_to: f.ed.value || null, p_active: f.active.checked,
      });
      if (error) return (($("[data-err]", d).textContent = friendly(error)), ($("[data-err]", d).hidden = false));
      d.close();
      toast("Offer saved");
      c.reloadMenu();
    });
  }

  // =====================================================================================
  // CATEGORY HOURS
  async function openHours() {
    const { data: cats } = await sb.from("menu_categories").select("id, name, serve_from, serve_to").order("sort");
    const d = modal("Category hours", "Every dish in a category follows its hours, unless the dish has its own. Leave empty for all day.", `
      <form class="dform" data-f><table class="gt"><thead><tr><th>Category</th><th>From</th><th>To</th></tr></thead><tbody>${(cats || [])
        .map((k) => `<tr data-k="${esc(k.id)}"><td data-l="Category"><b>${esc(k.name)}</b></td><td data-l="From"><input type="time" name="f" value="${hm(k.serve_from)}"></td><td data-l="To"><input type="time" name="t" value="${hm(k.serve_to)}"></td></tr>`)
        .join("")}</tbody></table>
        <p class="err" data-err hidden></p><div class="panel__foot"><button type="submit" class="btn btn--dark">Save</button></div></form>`);
    $("[data-f]", d).addEventListener("submit", async (e) => {
      e.preventDefault();
      for (const tr of $$("[data-k]", d)) {
        const k = cats.find((x) => x.id === tr.dataset.k);
        const f = $("[name=f]", tr).value || null;
        const t = $("[name=t]", tr).value || null;
        if (f === (hm(k.serve_from) || null) && t === (hm(k.serve_to) || null)) continue;
        const { error } = await sb.rpc("set_category_hours", { p_category: k.id, p_from: f, p_to: t });
        if (error) return (($("[data-err]", d).textContent = `${k.name}: ${friendly(error)}`), ($("[data-err]", d).hidden = false));
      }
      d.close();
      toast("Hours saved");
      c.reloadMenu();
    });
  }

  return { openExtras, openOffers, openHours };
}
