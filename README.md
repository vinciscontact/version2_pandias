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

| Screen | Owner | Manager | Cashier | Waiter | Kitchen |
|---|---|---|---|---|---|
| Today: numbers, "needs you now" (confirm guests, new takeaways, bills, calls, late food, low ratings, low stock) | ✓ | ✓ | ✓ | | |
| Orders: kitchen board, Can't make, combo contents, takeaway pickup times, Just served → Recall | ✓ | ✓ | ✓ | ✓ | ✓ |
| Tables: Seated ✓, take an order on the phone (captain mode), bill, loyalty reward, remake, pay, void a payment (manager), close with a reason | ✓ | ✓ | ✓ | ✓ | |
| Takeaway pre-orders (`order.html?takeaway=1`): accept, cook, pay on pickup | ✓ | ✓ | ✓ | ✓ | |
| Guests: today with name, number, PIN; All customers (owner, manager) | ✓ | ✓ | ✓ | | |
| Menu: sold out at this branch | ✓ (all branches) | ✓ | | | ✓ |
| Menu: prices + history, add / edit / remove dishes, photos, serving hours and days, goes-well-with, combos, branch prices, offers, category hours | ✓ | | | | |
| Numbers (today / 7 / 30 days); Reports (month, quarter, year, custom; vs last period and last year; branches; dishes; never sold; kitchen timing; GST; sales vs expenses; Excel + PDF) | ✓ | ✓ | | | |
| Feedback: low ratings first, resolve with a note | ✓ | ✓ | | | |
| Bills: every bill with filters, reprint, PDF, Excel | ✓ | ✓ | ✓ | | |
| Close the day: settle tables, count the cash, day report | ✓ | ✓ | view | | |
| Stock: levels, low warnings, purchases (+ expense), used / wasted, counts | ✓ | ✓ | | | ✓ (used / wasted) |
| Expenses: by category, cash spends lower the drawer | ✓ | ✓ | ✓ (today, up to ₹5,000) | | |
| Attendance: everyone checks in / out; managers see and fix | ✓ | ✓ | own | own | own |
| Activity: who did what (money, orders, menu, team, setup) | ✓ | ✓ | | | |
| Team: add people (sign-in name or email), roles, new password, switch off | ✓ | ✓ (cashier / waiter / kitchen) | | | |
| Setup: branches (address, hours, GST, GSTIN, packing, Seated check), tables in bulk, QR cards, loyalty, the 12-month data rule | ✓ | | | | |
| Download PDF on every screen | ✓ | ✓ | ✓ | ✓ | ✓ |

Screens live in `src/staff-app.js` (core), `staff-more.js` (bills, close day, activity, team, setup), `staff-daily.js`
(take order, takeaway, feedback, reports, loyalty), `staff-menuplus.js` (owner menu tools), `staff-business.js`
(stock, expenses, attendance) and `staff-pdf.js` (PDFs, loaded on demand). Staff accounts are created by the
`supabase/functions/staff-admin` server function (it holds the service key; the browser never does).

**Looks and installs like an iPhone app** (`src/staff-ios.js`, the "iOS layer" at the end of `staff/staff.css`).
On phones and iPad portrait there is a tab bar with the four screens that role uses most, plus **More** (every
other screen, branch, sound, check-in, sign out). Every dialog opens as a bottom sheet you can drag down to close.
Wide screens keep an iPad-style sidebar. To install: open `/staff/` in Safari → Share → **Add to Home Screen**
(Android Chrome: **More → Install on this phone**). `staff/sw.js` keeps the app's own files for a quick start
and short outages; orders, bills and guest data are never stored on the phone.

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
