# Pandia's staff app: everything a restaurant group needs

Plan for review. The staff app lives at `v2/staff/` behind the small emblem in the website's footer.
Built for **8 branches**, each with its own kitchen; payment at the desk only (cash, card, UPI).

Legend: **(built)** exists in v2 now · **(v1)** existed in the first version, to be carried over · **(new)** to build.

---

## The frame around every screen

- **Sidebar** grouped into four sections: Service, Menu, People, Business. On phones and tablets it becomes a bottom bar plus a "More" sheet.
- **Top of every screen:**
  - the person's name and role ("Ravi · Cashier");
  - today's date and a live clock ("Wednesday, 12 November · 8:42 PM"), always in Chennai time;
  - the branch name. The owner gets a branch switcher with "All branches";
  - a live/offline dot ("Live" / "Reconnecting…").
- **Shift greeting:** "Good evening, Ravi". At closing time the Today screen says "Ready to close the day?".
- **Gentle by design:**
  - one soft chime for new orders, nothing else beeps;
  - amber before red;
  - plain words and big buttons;
  - "All caught up" when there's nothing to do.

---

## SERVICE (the live restaurant)

### 1. Today (built, to extend)
- The day's numbers: guests in now, open tables, orders in the kitchen, plates served, money taken, spend per head.
- **Needs you now:** guests to confirm (Seated ✓), bill requests, waiter calls, food waiting 20+ min, walk-out alerts (served but unpaid 30 min).
- (new) **Compared with the same day last week** ("₹18,400 so far · 12% ahead of last Wednesday").
- (new) **Notice board:** the manager writes today's specials or notes ("Mutton runs out at 9 tonight"), shown to every screen in the branch.
- (new) **Owner's view:** one row per branch (8 rows) with sales, open tables and alerts, to spot the branch that needs help.

### 2. Orders: the kitchen board (built)
- New → Cooking → Ready to serve, with table, guest name, guest count, spice, parcel, notes (allergies in red), age timer, "Can't make".
- (new) **Dish target times:** biryani 8 min, fried chicken 15 min. The ticket turns amber at the target and red at 1.5×.
- (new) **All-day count:** "Mutton Biryani × 14 to make", so the cook batches.
- (new) **Kitchen offline warning** on the desk if the kitchen screen stops checking in.
- (new) **Bump bar mode** for a kitchen tablet: full screen, extra-large text, no sidebar.

### 3. Tables: the floor and the bill (built, to extend)
- Colour map, Seated ✓ with guest count, bill, discount (manager), Cash / UPI / Card, part payments, print bill, close table **(built)**.
- (new) **Captain mode:** waiters open a table and take orders on their own phone, for guests who don't scan.
- (new) **Move table, merge tables, split bill** (equal / by person / by items).
- (new) **Hold a table** for a phone reservation ("Kumar, 8:30 PM, 6 guests"), auto-released 20 min after.
- (new) **Remake or remove a dish** with a reason; removing needs the manager PIN.
- (new) **Waiter sections:** tables 1–10 belong to Ravi, so calls go to him first.

### 4. Takeaway pre-orders (new)
- Orders from the website with a pickup time, a short code (W-042) and pay at pickup.
- Limit per 15-minute slot, a pause switch, call-back above ₹1,000, and no-show tracking.

### 5. Bills (v1, to extend)
One row per bill, with these columns:

| When | Branch | Table | Orders | Status | Paid by | Made by | Total |
|---|---|---|---|---|---|---|---|
| 12 Nov, 8:42 PM | Vadapalani | T5 | 3 | Paid | UPI ₹600 + Cash ₹240 | Ravi (cashier) | ₹840 |

- **Status:** Eating · Wants bill · Part paid · Paid · Closed unpaid · Walk-out · Voided.
- **Paid by:** each payment method with its amount (a bill can be split across several).
- **Made by:** who confirmed the guests (Seated ✓), who took each payment, and who closed the table (all three on the detail view).
- **Open a bill** to see every order, every dish with spice/parcel/notes, discounts and their reason, dishes the kitchen couldn't make, the guest's name and number, and the time of every step.
- **Filters** (see "Filters and exports" below): period, branch, status, payment method, staff, table, guest phone, amount range, "has discount", "has void".
- **Totals bar** above the list for whatever is filtered: number of bills, sales, discounts, GST, average bill.
- Reprint, void with a reason (manager PIN, logged), and export to Excel / PDF.

---

## MENU

### 6. Menu and prices: dishes with photos (v1, to extend)
- **List view:** photo, name, category, price (or Full / Half), veg mark, on/off per branch, sold out today, last price change. Filters: category, branch, on/off, has photo, no photo yet.
- **One menu for the group**, with branch differences where needed:
  - categories with their order and a one-line description;
  - each dish: name, Tamil name, description, **photo**, veg / egg / non-veg, tags (signature, spicy, new, bestseller), price or variants (Full / Half), "spice level offered", target cooking time;
  - **per-branch control:** on/off per branch, and an optional different price per branch (Washermenpet may differ);
  - **time windows:** breakfast items only until 11 AM, at branches that serve them.
- **Sold out today** (built): one tap, and it comes back on automatically the next morning (new).
- **Food photos (new):**
  - upload from a phone or laptop;
  - the app automatically crops a square plus a wide version and saves light WebP files, so the website stays fast;
  - stored in Supabase Storage;
  - dishes without a photo show the illustrated plate.
- **Price history:** every change is kept. Past bills never change.
- **Publish to the website:** one button updates the public menu page and the QR ordering page with the new dishes, prices and photos.

### 7. Specials and combos (new, later)
- Today's special with an end time.
- Simple combos (Biryani + Coke ₹350) and happy-hour prices.

---

## PEOPLE

### 8. Customers (v1, to extend)
- **List:** name, number, first visit, last visit, visits, total spend, average bill, usual party size, branches visited, loyalty stamps.
- **Profile:** every visit with its bill, favourite dishes, feedback given, and a staff note ("likes it less spicy", "regular since 2019").
- **Groups:** new this period, regulars (5+ visits), not seen in 60 days, top spenders.
- **Filters:** period, branch, visits, spend range, last visit; search by name or number.
- Loyalty stamps: "6 of 10 visits", redeemed at the desk (new).
- Export to Excel / PDF; delete on request (privacy), through Recently removed.

### 9. Feedback (v1, to extend)
- **List:** date, branch, table, stars (overall, food, service), comment, guest name and number, waiter on duty, "went to Google", status (new / resolved).
- **Low ratings (1–3 stars):** alert the branch manager instantly on Today. The manager calls the guest and marks it resolved with a note of what was done.
- **Summary:** average rating, number of reviews, share that went to Google, and the trend month by month. Rating by branch, by dish ordered and by waiter (new).
- **Filters:** period, branch, stars, resolved / unresolved, has comment.
- Export to Excel / PDF.

### 10. Team / staff (v1, to extend)
- **Accounts:** name, phone, email, photo (optional), role (owner, manager, cashier, waiter, kitchen), branch, joining date, active / inactive.
- Add, edit, move branch, change role, deactivate (sign-in stops at once, history stays), reset password.
- (new) **Waiter role** for captain mode; **waiter sections** (which tables).
- (new) **Manager PIN** for voids, discounts and removing dishes.
- (new, optional) **Shifts and attendance:** clock in/out on the app, late arrivals, hours per month.
- **Performance per person:** tables served, orders taken, payments collected, discounts given, voids, average call response, and feedback when they were on duty.
- **Filters:** branch, role, active; period for performance. Export to Excel / PDF.

---

## BUSINESS

### Filters and exports (the same on every list and report)
- **Period presets:** Today · Yesterday · This week · Last week · **This month · Last month · This quarter (Q1 Apr–Jun, Q2 Jul–Sep, Q3 Oct–Dec, Q4 Jan–Mar, the Indian financial year) · Last quarter · This year · Last year** · Custom dates.
  - Calendar-year quarters (Jan–Mar first) are a setting, if you prefer them.
- **Compare with:** the previous period, or the same period last year, shown as "+12%" next to each number.
- **Branch:** one, several, or all 8.
- Plus the filters that fit each list: status, staff, payment method, category, stars, and so on.
- **The filters stay put** when you move between screens, and the period is always written in the title ("Vadapalani · October 2026").
- **Export any list or report:**
  - **Excel (.xlsx):** real columns and numbers, a totals row, one sheet per branch when several are chosen.
  - **PDF:** a clean printable page with the Pandia's header, the period, the filters used, page numbers and a "printed by / on" line.

### 11. Numbers and reports (built, to extend)
- **Ready-made reports:**
  - Daily summary
  - **Monthly report**
  - Quarterly report
  - Yearly report
  - Branch comparison
  - Dish sales
  - Staff performance
  - Discounts and voids
  - Payment reconciliation (cash, UPI and card per day, ready for the accountant)
  - GST summary (taxable value and GST per day / month)
- **Monthly report, made automatically on the 1st** for the month before, for each branch and for the group. It's saved in the app and ready as Excel and PDF:
  1. Sales, bills, guests, average bill and spend per head, against the previous month and the same month last year.
  2. Sales by day (calendar view) and by hour; best and quietest days.
  3. Payment split, discounts with reasons, voids, walk-outs, cash differences.
  4. Top 20 dishes and dishes that never sold; dishes the kitchen couldn't make.
  5. Kitchen speed, late tickets; table turns.
  6. Guests: new versus returning, top regulars; feedback average and low ratings handled.
  7. Staff: who served most, discounts given, attendance (if switched on).
- Sales by hour, payment split, top dishes, best tables, per head **(built)**.
- (new) **Branch comparison** for all 8 branches side by side.
- (new) **Dishes:** best sellers, never-sold dishes, ordered together, cancelled or "can't make" often.
- (new) **Kitchen speed:** time from order to ready, by dish and hour; late tickets.
- (new) **Tables:** turns per day, average time occupied, earnings per hour, seats wasted.
- (new) **Guests:** new versus returning, party sizes, repeat rate.
- (new) **Money honesty:** discounts by reason and person, voids, walk-outs, cash differences.
- (new) **Waiters:** tables served, call response time, captain orders.
- Any date range; export to spreadsheet and PDF.

### 12. Close the day (new)
- Settle every open table: paid, walk-out, or void with reason.
- **Cash count:** the counted amount against what's expected.
- **Day-end summary:** one page per branch (sales, guests, top dishes, discounts, issues), sent to the owner's dashboard and printable.

### 13. Stock and purchases (new, optional; the "coming in / going out")
- Stock items: rice, mutton (kg), oil, gas cylinders, parcel boxes.
- **In:** purchases with supplier, quantity and cost.
- **Out:** used per day (entered at closing, or worked out from recipes later), plus wastage with a reason.
- Low-stock alerts per branch.
- **Daily expenses** (vegetables, petty cash, gas), so the owner sees an approximate profit per day.

### 14. Branches and tables (v1, to extend for 8)
- Per branch: name, Tamil name, address, map pin, phone, hours (per day), Google review link, GST %, packing charge, Seated ✓ on/off, open/closed.
- Tables: add, rename, seats, section, on/off.
- **Print QR cards** for every table, branch by branch **(v1)**.

### 15. Activity log (new, owner only)
- Who changed a price, gave a discount, voided a dish, closed a table unpaid or switched a dish off, and when, with before and after.

### 17. Help and SOPs (new)
- The standard operating procedures for each role (founder/owner, branch manager, cashier, waiter, kitchen) live inside the app under **Help**. Each person sees their own first; each step links to the screen it talks about.
- Printable as PDF for the staff room wall. Full text: `docs/sops.md`.
- New staff see their role's SOP the first time they sign in, with a "Got it" at the end.

### 16. Settings (new)
- Restaurant name and logo on bills, bill footer text, receipt printer size.
- Sound on/off, how long data is kept.
- Optional Tamil screen labels for staff who prefer them.

---

## DATA: every day kept for a year, nothing lost, nothing deleted without warning

### What is saved, every day
- **Every detail, for 12 months:** each table visit, order, dish line (with price, spice, note, parcel), payment, discount, void, waiter call, feedback, guest count, and the time of every step (ordered, seated, cooking, ready, served, paid, closed).
- **Who did it:** every staff action carries the person and time (activity log).
- **Daily summaries, kept forever:** one small row per branch per day, with sales, guests, tables, dishes sold, payment split, discounts, voids, walk-outs and kitchen times. They're written each night after closing. Years of history take almost no space, and reports stay instant.
- **Prices are frozen on each bill.** Changing a price never changes an old bill.

### Never lost
- **Bills and payments can never be deleted**, only voided with a reason. The original stays visible.
- **Recently removed (30 days):** a deleted dish, table, photo, staff account or customer goes to a bin first. Anyone with access can restore it in one tap. Only the owner can empty it, after a confirmation that names exactly what will go.
- **Backups:**
  - **Every night:** each branch's day is also saved as a spreadsheet file (CSV) in the restaurant's own storage, as a second copy even if something goes wrong in the database.
  - **On the paid database plan:** automatic daily backups of the whole database.

### Warnings before anything is removed
- **In daily use:** every delete or "close unpaid" asks first, in plain words: "Remove Mutton Kola Urundai from the menu? It moves to Recently removed for 30 days."
- **At the 12-month mark,** nothing disappears on its own:
  - **30 days before:** the owner sees a banner on Today: "Detail from November 2026 will be archived on 12 December. Download the archive first." It has a **Download** button: a ZIP of every day's spreadsheets for that month.
  - **7 days and 1 day before:** the reminder appears again.
  - **Then:** the owner taps **"Archive and remove"** to confirm. Without that tap, the data stays.
  - **After archiving:** the daily summaries stay forever, so every year-on-year report still works. Only the line-by-line detail older than 12 months leaves the live database, and it's already in the downloaded archive.
- **Guest phone numbers (privacy):** kept for 12 months after the guest's last visit. Then the name and number are removed from the visits, but the numbers (sales, dishes) stay. This follows the same warning steps, and the privacy page says so.

### How big it gets (8 branches, assuming about 400 orders a day each)
- About **1.2 million orders and 4 million dish lines a year**, roughly **1.2–1.5 GB** of database including indexes.
- Food photos: about **300 KB per dish** (three sizes), so under 100 MB for the whole menu.
- **This does not fit the free Supabase plan** (500 MB database). The paid plan, about $25 a month at the time I checked, holds 8 GB, includes daily backups and never pauses. **Move to it before the 8-branch rollout.** For now the free plan is fine for building and testing, with the nightly spreadsheet copy as the safety net.

---

## Who sees what

| Section | Owner | Manager | Cashier | Waiter | Kitchen |
|---|---|---|---|---|---|
| Today | all branches | own branch | own branch | own tables | |
| Orders (kitchen board) | ✓ | ✓ | view | view | ✓ |
| Tables / Bills | ✓ | ✓ | ✓ | own section | |
| Takeaway | ✓ | ✓ | ✓ | | ✓ (cooking) |
| Menu: sold out today | ✓ | ✓ | | | ✓ |
| Menu: dishes, prices, photos | ✓ | | | | |
| Customers / Feedback | ✓ | own branch | | | |
| Team | ✓ | view own branch | | | |
| Numbers, Close the day | ✓ | own branch | close only | | |
| Stock and purchases | ✓ | own branch | | | enter usage |
| Branches and tables, Settings, Activity log | ✓ | | | | |

---

## What I need from you (the owner)

1. **The 8 branches:** names, addresses, phone numbers, opening hours, table numbers and seats. Only 4 are in the system now.
2. **The full menu:** printed menu photos for every page, and which prices differ by branch.
3. **Food photos:** as many dishes as possible, shot from above in daylight on a plain table. Phone photos are fine; the app crops and compresses them.
4. **Staff list per branch** with roles.
5. **GST rate, packing charge,** and whether you want stock and expenses tracking (section 13) now or later.

## Suggested build order

1. **Data foundation first:** activity log, Recently removed bin with restore, nightly daily summaries and spreadsheet copies, then the 12-month archive warnings. Then the frame (sidebar sections, name, date, clock, branch switcher) + **Dishes with photos and per-branch control** + **Branches and tables for 8** + **Team** (with waiter role).
2. **Bills**, **Customers**, **Feedback** (bringing v1 over) + **Close the day** with the cash count.
3. **Captain mode**, move/merge/split, holds, remake/remove with manager PIN, activity log.
4. **Takeaway pre-orders**.
5. **Reports** in full + branch comparison + day-end summary.
6. **Stock and purchases, expenses** + loyalty stamps + specials and combos.
