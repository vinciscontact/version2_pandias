# Hotel Pandia's v2

Plain HTML, CSS and JavaScript. No framework and no build step for the pages:
upload this folder as it is (Hostinger `public_html`, Vercel, any static host).

| File | What |
|---|---|
| `index.html` | Landing page: video hero, mascot, menu highlights, QR ordering, services, about, branches, reviews, catering |
| `menu.html` | The full menu (generated, see below) with search and a veg-only switch |
| `css/styles.css` | All styles for both pages |
| `js/main.js` | Landing page behaviour: nav, open-now, click tracking hooks, hero video, lazy 3D mascot |
| `js/menu.js` | Menu search and veg filter |
| `js/mascot-worker.js` | The built 3D mascot worker (three.js + mascot code). Fetched only when section two comes near |
| `src/mascot-worker.js` | Readable source of that worker |
| `tools/` | `menu.json` (the menu data) and `build-menu.py` (writes `menu.html`) |

## Table ordering (guests)

`order.html?branch=vadapalani&table=5` is what each table's QR code opens. It is generated: edit
`tools/order.template.html`, then run `npm run build:pages`. Logic in `js/order.js`, styles in `css/order.css`.

## Staff app (restaurant only)

`staff/` behind the small emblem in the footer's bottom-right corner (not indexed, not labelled).
Sign in with a staff account; each role sees only its screens:

| Screen | Owner | Manager | Cashier | Kitchen |
|---|---|---|---|---|
| Today: greeting, the day's numbers, "needs you now" | ✓ | ✓ | ✓ | |
| Orders: kitchen board, New → Cooking → Ready, Can't make | ✓ | ✓ | ✓ | ✓ |
| Tables: Seated ✓, bill, discount (manager), Cash / UPI / Card, print, close | ✓ | ✓ | ✓ | |
| Guests: today's tables with name, number, PIN, people, bill; tap to open the table | ✓ | ✓ | ✓ | |
| Guests → All customers: search, visits, spend, download for Excel | ✓ | ✓ (own branch) | | |
| Menu: switch dishes off when they run out | ✓ | ✓ | | ✓ |
| Menu: change prices (with history), add / edit / remove dishes, Recently removed + Restore | ✓ | | | |
| Numbers: sales by hour, payment split, top dishes, best tables, per head | ✓ | ✓ | | |
| Download PDF on every screen, and a PDF of one table's bill | ✓ | ✓ | ✓ | ✓ |

Source: `src/staff-app.js` → built to `staff/app.js`; the PDF maker (`src/staff-pdf.js`) is split into
`staff/chunks/` and only downloads when someone taps **Download PDF**. Once, `npm install`; then:

    npm run build:staff

First owner account (once): in Supabase → Authentication → Users → Add user (tick Auto Confirm), then run in the SQL editor:

    insert into staff (user_id, name, email, role, branch_id)
    select id, 'Owner', email, 'admin', null from auth.users where email = 'OWNER@EMAIL';

## Hero video (PLACEHOLDER FOOTAGE)

`video/hero-wide.mp4`, `video/hero-tall.mp4` and `img/hero-*.webp` are **not** Hotel Pandia's own kitchen.
Replace them with real footage before launch. From one upright (portrait) source video:

    # wide: three 8-second moments side by side (desktop)
    ffmpeg -i SOURCE.mp4 -filter_complex "[0:v]trim=3:11,setpts=PTS-STARTPTS,scale=540:960[a];[0:v]trim=15:23,setpts=PTS-STARTPTS,scale=540:960[b];[0:v]trim=27:35,setpts=PTS-STARTPTS,scale=540:960[c];[a][b][c]hstack=3,fps=24[v]" -map "[v]" -an -c:v libx264 -preset slow -crf 28 -pix_fmt yuv420p -movflags +faststart video/hero-wide.mp4
    # tall: one upright 12-second cut (phones)
    ffmpeg -i SOURCE.mp4 -filter_complex "[0:v]trim=3:7,setpts=PTS-STARTPTS[a];[0:v]trim=17:21,setpts=PTS-STARTPTS[b];[0:v]trim=27:31,setpts=PTS-STARTPTS[c];[a][b][c]concat=n=3,scale=480:854,fps=24[v]" -map "[v]" -an -c:v libx264 -preset slow -crf 29 -pix_fmt yuv420p -movflags +faststart video/hero-tall.mp4

Then save the first frame of each as `img/hero-wide.webp` and `img/hero-tall.webp` (these paint first; the video loads after).

## Changing the menu

Day to day, the owner does it in the staff app (**Menu → + Add dish**, tap a dish name to edit or remove it,
type a new price and press Enter). `menu.html` and `order.html` are printed from `tools/menu.json` so they show
instantly and search engines read them; after the page shows, `js/menu.js` and `js/order.js` fetch the live menu
and bring it up to date: prices, sold out, new dishes (and new categories), removed dishes, renamed dishes.

Now and then (e.g. before a release), re-print the pages so search engines see new dishes too: update
`tools/menu.json`, then run `npm run build:pages`. The six highlights on the landing page are written by hand in `index.html`.

Removed dishes are never deleted: they get a `deleted_at` date and wait in **Recently removed**. Past bills keep
the name and price they were sold at.

## Rebuilding the 3D worker

Only after editing `src/mascot-worker.js`:

    npm run build:mascot

## Before launch

- Replace the placeholder hero footage (above).
- Replace `https://hotelpandias.com` in `index.html`, `menu.html`, `robots.txt` and `sitemap.xml` with the real domain.
- Confirm prices and branch details with the owner (several are drafts carried over from v1).
- Ads later: every button carries `data-track`; clicks queue in `window.dataLayer` (top of `js/main.js`).

## Database

`supabase/migrations/` holds every database change, oldest first (Supabase project `vlbnicfcjddaehyjindr`).
All rules (who may do what, prices, the Seated ✓ hold, owner-only menu changes) live there, enforced by
row-level security and checked functions. The key in the pages is the public (publishable) key, by design.
`docs/` has the staff app plan, the SOPs and the ordering scenarios. Neither folder is deployed (`.vercelignore`).
