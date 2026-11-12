// Menu page: search and the veg-only switch. The dishes are already in the HTML (fast, and search
// engines read them). After the page shows, one small request brings it up to date with the
// database: today's prices, dishes the owner added, and dishes the owner removed.
const SB = "https://vlbnicfcjddaehyjindr.supabase.co";
const KEY = "sb_publishable_X4LBIcYNnHLTqfgByI8dWA_OW2JPggP"; // public by design; the database decides what it may read
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const search = $("[data-search]");
const veg = $("[data-veg]");
const empty = $("[data-empty]");
const rupee = (n) => "₹" + Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 0 });
const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const DIET = { veg: "Vegetarian", egg: "Contains egg", nonveg: "Non-vegetarian" };

function apply() {
  const q = search.value.trim().toLowerCase();
  let shown = 0;
  for (const d of $$(".mdish")) {
    const ok = (!q || d.dataset.q.includes(q)) && (!veg.checked || d.dataset.diet === "veg");
    d.hidden = !ok;
    if (ok) shown++;
  }
  for (const c of $$("[data-cat]")) c.hidden = !c.querySelector(".mdish:not([hidden])");
  empty.hidden = shown > 0;
}
search.addEventListener("input", apply);
veg.addEventListener("change", apply);

/** "₹400", "₹400 / ₹270" or "from ₹190", with the choices underneath (same as the printed page) */
function priceHTML(rows) {
  const p = rows.map((r) => Number(r.price));
  const label = p.length === 1 ? rupee(p[0]) : p.length === 2 ? `${rupee(p[0])} / ${rupee(p[1])}` : `from ${rupee(Math.min(...p))}`;
  const note = rows.length > 1 ? rows.map((r) => r.name.match(/\(((?:[^()]|\([^()]*\))*)\)$/)?.[1] || "").join(" / ") : "";
  return esc(label) + (note ? `<small>${esc(note)}</small>` : "");
}

/** name, Tamil name, description and veg mark, as the owner last saved them */
function refreshText(li, r, head) {
  const name = r.id.includes("--") ? r.name.replace(/\s\((?:[^()]|\([^()]*\))*\)$/, "") : r.name;
  $(head, li).innerHTML = esc(name) + (r.tamil ? ` <span lang="ta">${esc(r.tamil)}</span>` : "");
  let p = $(":scope > p", li);
  if (r.description) {
    if (!p) li.append((p = document.createElement("p")));
    p.textContent = r.description;
  } else p?.remove();
  if (DIET[r.diet]) {
    li.dataset.diet = r.diet;
    const i = $(".diet", li);
    i.className = `diet diet--${r.diet}`;
    i.setAttribute("aria-label", DIET[r.diet]);
  }
  li.dataset.q = `${name} ${r.tamil || ""} ${r.description || ""}`.toLowerCase();
}

async function live() {
  const get = (path) => fetch(`${SB}/rest/v1/${path}`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } }).then((r) => (r.ok ? r.json() : Promise.reject(r.status)));
  const [items, cats] = await Promise.all([
    get("menu_items?select=id,name,category,price,diet,tamil,description,deleted_at&order=sort,name"),
    get("menu_categories?select=id,name,blurb&order=sort"),
  ]);
  const byId = Object.fromEntries(items.map((r) => [r.id, r]));
  const onPage = new Set();
  for (const li of $$(".mdish[data-ids]")) {
    const ids = li.dataset.ids.split(" ").filter(Boolean);
    ids.forEach((id) => onPage.add(id));
    if (!ids.length) continue; // "Seasonal": no fixed price
    const rows = ids.map((id) => byId[id]).filter(Boolean);
    if (rows.length !== ids.length) continue; // not in the database: leave the printed line alone
    const keep = rows.filter((r) => !r.deleted_at);
    if (!keep.length) {
      li.remove();
      continue;
    }
    $("b", li).innerHTML = priceHTML(keep);
    refreshText(li, keep[0], "h3");
  }
  // dishes added after the page was printed
  const fresh = {};
  for (const r of items) if (!r.deleted_at && !onPage.has(r.id)) (fresh[r.id.split("--")[0]] ||= []).push(r);
  const cat = Object.fromEntries(cats.map((c) => [c.id, c]));
  for (const rows of Object.values(fresh)) {
    const r0 = rows[0];
    const name = r0.id.includes("--") ? r0.name.replace(/\s\((?:[^()]|\([^()]*\))*\)$/, "") : r0.name;
    let sec = document.getElementById(r0.category);
    if (!sec) {
      sec = document.createElement("section");
      sec.className = "mcat";
      sec.id = r0.category;
      sec.dataset.cat = "";
      const c = cat[r0.category];
      sec.innerHTML = `<h2>${esc(c?.name || r0.category)}</h2>${c?.blurb ? `<p>${esc(c.blurb)}</p>` : ""}<ul class="mdishes"></ul>`;
      empty.before(sec);
    }
    const diet = DIET[r0.diet] ? r0.diet : "nonveg";
    const li = document.createElement("li");
    li.className = "mdish";
    li.dataset.diet = diet;
    li.dataset.q = `${name} ${r0.tamil || ""} ${r0.description || ""}`.toLowerCase();
    li.innerHTML =
      `<i class="diet diet--${diet}" role="img" aria-label="${DIET[diet]}"></i>` +
      `<h3>${esc(name)}${r0.tamil ? ` <span lang="ta">${esc(r0.tamil)}</span>` : ""}</h3><b>${priceHTML(rows)}</b>` +
      (r0.description ? `<p>${esc(r0.description)}</p>` : "");
    $(".mdishes", sec).append(li);
  }
  for (const c of $$("[data-cat]")) if (!$(".mdish", c)) c.remove();
  apply();
}
// after first paint, so the printed menu is never held up
(window.requestIdleCallback || ((f) => setTimeout(f, 300)))(() => live().catch(() => {}));
