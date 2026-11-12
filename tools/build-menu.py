# Writes v2/menu.html from v2/tools/menu.json (exported from the v1 menu data).
#   python v2/tools/build-menu.py        (run from the folder that contains v2/)
# The page is plain static HTML so search engines read every dish; js/menu.js adds search + veg filter.
import html
import json
import os
import re

here = os.path.dirname(os.path.abspath(__file__))
data = json.load(open(os.path.join(here, "menu.json"), encoding="utf-8"))
e = html.escape
DIET = {"veg": "Vegetarian", "egg": "Contains egg", "nonveg": "Non-vegetarian"}


def dish(d):
    ta = f' <span lang="ta">{e(d["tamil"])}</span>' if d.get("tamil") else ""
    desc = f'<p>{e(d["desc"])}</p>' if d.get("desc") else ""
    variants = d.get("variants") or []
    note = " / ".join(v["label"] for v in variants)
    price = e(d["label"]) + (f"<small>{e(note)}</small>" if note else "")
    search = e((d["name"] + " " + d.get("tamil", "") + " " + d.get("desc", "")).lower())
    # database row ids (same keys as the ordering page), so js/menu.js can refresh prices live
    if variants:
        ids = [f'{d["id"]}--{re.sub(r"[^a-z0-9]+", "-", v["label"].lower())}' for v in variants if v["price"] is not None]
    else:
        ids = [] if d["price"] is None else [d["id"]]
    return (
        f'<li class="mdish" data-diet="{d["diet"]}" data-q="{search}" data-ids="{" ".join(ids)}">'
        f'<i class="diet diet--{d["diet"]}" role="img" aria-label="{DIET[d["diet"]]}"></i>'
        f'<h3>{e(d["name"])}{ta}</h3><b>{price}</b>{desc}</li>'
    )


sections, pills = [], []
for c in data["categories"]:
    items = [d for d in data["dishes"] if d["category"] == c["id"]]
    if not items:
        continue
    pills.append(f'<a class="pill pill--line" href="#{c["id"]}">{e(c["name"])}</a>')
    sections.append(
        f'<section class="mcat" id="{c["id"]}" data-cat><h2>{e(c["name"])}</h2><p>{e(c["blurb"])}</p>'
        f'<ul class="mdishes">{"".join(dish(d) for d in items)}</ul></section>'
    )

page = f"""<!doctype html>
<html lang="en-IN" class="no-js">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>Menu | Hotel Pandia's, Chennai</title>
  <meta name="description" content="The full Hotel Pandia's menu: mutton biryani, kuska, fried chicken, seafood, parotta, tiffin, soups and more, with prices.">
  <link rel="canonical" href="https://hotelpandias.com/menu.html">
  <meta name="theme-color" content="#fbf1df">
  <meta property="og:title" content="Menu | Hotel Pandia's">
  <meta property="og:image" content="https://hotelpandias.com/img/og.jpg">
  <link rel="icon" href="favicon.png" type="image/png">
  <link rel="preload" href="fonts/anek-latin.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="stylesheet" href="css/styles.css">
  <script>document.documentElement.className = "js";</script>
</head>
<body class="page-menu">
  <a class="skip" href="#main">Skip to content</a>
  <header class="nav">
    <nav class="nav__links" aria-label="Main">
      <a href="index.html">Home</a>
      <a href="index.html#about">About</a>
      <a href="index.html#visit">Branches</a>
      <a href="index.html#catering">Catering</a>
    </nav>
    <a class="nav__brand" href="index.html" aria-label="Hotel Pandia's, home">
      <img src="img/logo-emblem.webp" alt="" width="64" height="44">
      <img class="nav__word" src="img/logo-wordmark.webp" alt="Hotel Pandia's" width="124" height="35">
    </a>
    <a class="pill pill--dark nav__cta" href="index.html#visit" data-track="nav_directions">Find us</a>
  </header>

  <main id="main">
    <div class="mhead wrap">
      <p class="kicker">The menu</p>
      <h1>Hungry? Good.</h1>
    </div>
    <div class="mtools">
      <div class="wrap">
        <div class="mtools__row">
          <input type="search" placeholder="Search biryani, parotta, soup…" aria-label="Search the menu" data-search autocomplete="off">
          <label><input type="checkbox" data-veg> Veg <span>only</span></label>
        </div>
        <nav class="mcats" aria-label="Menu sections">{"".join(pills)}</nav>
      </div>
    </div>
    <div class="mlist wrap">
      {"".join(sections)}
      <p class="mempty" data-empty hidden>Nothing matches that. Try “biryani” or “parotta”.</p>
    </div>
  </main>

  <footer class="foot">
    <div class="wrap foot__in">
      <p class="foot__ta" lang="ta">வாங்க, சாப்பிடலாம்!</p>
      <nav aria-label="Footer">
        <a href="index.html">Home</a>
        <a href="index.html#visit">Branches</a>
        <a href="index.html#catering">Catering</a>
        <a href="https://wa.me/919217002598" target="_blank" rel="noopener">WhatsApp</a>
      </nav>
      <div class="foot__base"><p>© 2026 Hotel Pandia's, Chennai · Prices may change; taxes as applicable. · Designed by The Vincis</p><a class="foot__door" href="staff/" aria-label="Staff sign in" rel="nofollow"><img src="img/logo-emblem.webp" alt="" width="34" height="23" loading="lazy"></a></div>
    </div>
  </footer>
  <script type="module" src="js/menu.js"></script>
</body>
</html>
"""
out = os.path.join(here, "..", "menu.html")
open(out, "w", encoding="utf-8", newline="\n").write(page)
print(f"menu.html: {len(sections)} sections, {len(data['dishes'])} dishes, {len(page) // 1024} KB")
