# Writes v2/order.html (table ordering) from v2/tools/menu.json.
#   python v2/tools/build-order.py        (run from the folder that contains v2/)
# Dishes are written into the page, so it shows instantly; js/order.js adds the cart, live prices,
# sold-out flags and everything that talks to the ordering backend.
import html
import json
import os
import re

here = os.path.dirname(os.path.abspath(__file__))
data = json.load(open(os.path.join(here, "menu.json"), encoding="utf-8"))
e = html.escape
DIET = {"veg": "Vegetarian", "egg": "Contains egg", "nonveg": "Non-vegetarian"}
NO_SPICE = {"desserts"}  # categories where a spice level makes no sense

BRANCHES = [
    {"id": "vadapalani", "name": "Vadapalani"},
    {"id": "washermenpet", "name": "Washermenpet"},
    {"id": "royapuram", "name": "Royapuram"},
    {"id": "kottivakkam", "name": "Kottivakkam"},
]


def rupee(n):
    return "₹" + f"{n:,.0f}".replace(",", ",")


def options(d):
    """Orderable choices, same keys as the database: the dish id, or id--variant for Full/Half etc."""
    if d.get("variants"):
        return [
            {"key": f'{d["id"]}--{re.sub(r"[^a-z0-9]+", "-", v["label"].lower())}', "label": v["label"],
             "name": f'{d["name"]} ({v["label"]})', "price": v["price"]}
            for v in d["variants"] if v["price"] is not None
        ]
    return [] if d["price"] is None else [{"key": d["id"], "label": "", "name": d["name"], "price": d["price"]}]


def stepper(o, spice):
    lab = f'<span class="step__label">{e(o["label"])}</span>' if o["label"] else ""
    return (
        f'<div class="step" data-step="{e(o["key"])}" data-name="{e(o["name"])}" data-price="{o["price"]}" data-spice="{1 if spice else 0}">'
        f'{lab}<b class="step__price">{rupee(o["price"])}</b>'
        f'<button type="button" class="step__add" data-add aria-label="Add {e(o["name"])}">Add</button>'
        f'<span class="step__ctrl" hidden><button type="button" data-dec aria-label="One less {e(o["name"])}">−</button>'
        f'<output data-qty>0</output><button type="button" data-inc aria-label="One more {e(o["name"])}">+</button></span></div>'
    )


def dish(d, cat):
    ta = f' <span lang="ta">{e(d["tamil"])}</span>' if d.get("tamil") else ""
    desc = f'<p>{e(d["desc"])}</p>' if d.get("desc") else ""
    opts = options(d)
    buy = "".join(stepper(o, cat not in NO_SPICE) for o in opts) or '<p class="odish__ask">Seasonal. Ask your server.</p>'
    search = e((d["name"] + " " + d.get("tamil", "") + " " + d.get("desc", "")).lower())
    return (
        f'<li class="odish" data-diet="{d["diet"]}" data-q="{search}">'
        f'<div class="odish__top"><i class="diet diet--{d["diet"]}" role="img" aria-label="{DIET[d["diet"]]}"></i>'
        f'<h3>{e(d["name"])}{ta}</h3></div>{desc}<div class="odish__buy">{buy}</div></li>'
    )


sections, pills = [], []
for c in data["categories"]:
    items = [d for d in data["dishes"] if d["category"] == c["id"]]
    if not items:
        continue
    pills.append(f'<a class="pill pill--line" href="#c-{c["id"]}">{e(c["name"])}</a>')
    sections.append(
        f'<section class="mcat" id="c-{c["id"]}" data-cat><h2>{e(c["name"])}</h2>'
        f'<ul class="odishes">{"".join(dish(d, c["id"]) for d in items)}</ul></section>'
    )

branch_opts = "".join(f'<option value="{b["id"]}">{e(b["name"])}</option>' for b in BRANCHES)
template = open(os.path.join(here, "order.template.html"), encoding="utf-8").read()
page = (
    template.replace("{{BRANCHES_JSON}}", json.dumps(BRANCHES))
    .replace("{{BRANCH_OPTIONS}}", branch_opts)
    .replace("{{CATEGORY_PILLS}}", "".join(pills))
    .replace("{{SECTIONS}}", "".join(sections))
)
out = os.path.join(here, "..", "order.html")
open(out, "w", encoding="utf-8", newline="\n").write(page)
print(f"order.html: {len(sections)} sections, {page.count('data-step=')} orderable options, {len(page) // 1024} KB")
