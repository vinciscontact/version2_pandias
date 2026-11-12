# TableServe v2 for Hotel Pandia's: scenarios, failure cases and fixes

Status: plan for review. Nothing below is built yet unless marked **(have)**.

Decisions already made:
- Guest count is **required** before the first order.
- Waiters can take orders on their own phones (**captain mode**).
- **One kitchen per branch** (one pass, no stations).
- Payment is **at the desk only**: cash, card, UPI. No online payment, no Razorpay.
- **Reservations by phone call only**; the desk can hold a table.
- **Pre-order takeaway: yes.** Delivery: no (Swiggy/Zomato stay separate).
- Stay on the free database plan for now (see "Data" for what that risks).
- Built as part of the **v2 design**, on the same database as today.

Each scenario lists what happens, what can go wrong (**fail**), and how the system handles it (**fix**).

---

## A. Dine-in: who walks in

### A1. One person, eats, pays, leaves
Scan → guest count 1 → name and phone → order → eat → "Get the bill" → pay at desk → desk closes table → feedback.
- **Fail:** pays at the desk but never taps "Get the bill". **Fix:** the desk can bill any table directly; the guest's tap is optional.
- **Fail:** leaves without paying (walk-out). **Fix:** a table that is served but unpaid 30 min after the last plate turns amber on the desk map. The manager closes it as "walk-out" with a reason. Walk-outs show on the dashboard; the number is not blocked automatically.
- **Fail:** cashier forgets to close the table after payment, so the next guests can't order. **Fix:** a paid table auto-closes after 10 min. A new guest scanning a "paid" table starts a fresh bill **(have)**.

### A2. Couple or family, one phone orders for everyone
- **Fail:** guest count left as 1 for a family of 5, so the spend-per-head numbers are wrong. **Fix:** the count is required and big (tap 1–8, "8+" asks the number). The waiter can correct it from their phone; changes are logged.

### A3. Group with several phones
First phone opens the table and gets the PIN; friends join with it **(have)**. Every order lands on one bill.
- **Fail:** two phones order the same dish by accident. **Fix:** before sending, "Already ordered at this table: 2 × Mutton Biryani (Priya)". A soft warning, not a block.
- **Fail:** the group wants separate bills. **Fix:** desk "Split bill" by equal shares, by person (each order carries who placed it), or by picking items. Each part takes its own payment.

### A4. Late arrivals or someone leaves early
- **Fix:** guest count can be edited by the guest ("+1") or the waiter. The visit keeps the highest count reached, for honest per-head numbers.

### A5. Guest who won't or can't scan (elderly, no smartphone, phone dead)
- **Fix:** **captain mode.** The waiter opens the table on their own phone, enters the guest count and takes the order. Name and phone are optional for waiter orders ("Guest at T5"). The kitchen sees "by Ravi (waiter)".

### A6. Big party across 2–3 tables
- **Fix:** desk "Merge tables" (T5 + T6 + T7 → one visit, one bill, one PIN). "Unmerge" if they split up.

### A7. Party moves table (to the AC hall, near the window)
- **Fix:** desk "Move table". Orders, bill and PIN move with it; the old table becomes free.

### A8. Returning regular
- **Fix:** phone remembered **(have)**. New: "Your usual?" shows their 3 most-ordered dishes for one-tap reorder.

### A9. Guest scans the wrong table's QR (sitting at 5, scans 6)
- **Fail:** the order goes to table 6. **Fix:** after the first order the screen says "Table 6" in large type. The desk can "Move order to table 5" in one tap.

### A10. Prank / remote orders (someone photographs a QR and orders from home)
- **Fail:** kitchen cooks food for an empty table. **Fix (recommended):** the **first order of a fresh table waits for a waiter's one-tap "Seated ✓"** on the desk or their phone. Later rounds go straight to the kitchen. Optional per branch: switch off when the risk is low (e.g. lunch).
- Extra guard: very large first orders (over ₹3,000) always need the confirm.

### A11. Guest wants to change or cancel an order
- **Fix:** the guest can cancel an order themselves while it is still "Received" (not yet cooking). After cooking starts, only staff can cancel, with a reason.

### A12. Dish runs out after the guest ordered it
- **Fix:** the kitchen taps "Can't make this" on that line. The line is removed from the bill, the guest's screen shows "Sorry, Kola Urundai just ran out", and the waiter is pinged to suggest something else. The dish is also marked sold out for everyone.

### A13. Wrong dish or complaint at the table
- **Fix:** waiter "Remake" (new ticket marked REMAKE, no extra charge) or "Remove from bill" (needs the manager PIN and a reason). Both are recorded for the dashboard.

### A14. Allergy, Jain, no onion, less spicy
- **Fix:** spice level (Mild / Medium / Spicy) and a note per dish line. Notes containing "allergy" or "nut" show in red on the kitchen ticket.

### A15. Leftovers to take home, or "pack 2 more biryani to go"
- **Fix:** a "Parcel" switch per line. It adds the packing charge (set per branch) and tells the kitchen to pack it.

### A16. Phone lost, browser closed, or friend's phone
- Rejoin with the table PIN **(have)**.

### A17. Network drops right after "Send to kitchen"
- **Fail:** the guest taps again and the kitchen gets the order twice. **Fix:** every send carries a one-time key, so a retry is recognised and never doubles. The screen says "Sending…" until the server confirms.

### A18. Guest orders more after the bill was printed
- **Fix:** the bill reopens **(have)**. The desk shows "Bill changed after printing" so the old printout isn't used.

### A19. Payment in parts (half cash, half UPI) or a short payment
- **Fix:** multiple payments per bill **(have)**. The table stays "Part paid" in amber until the total is covered.

### A20. Discount or complimentary dish
- **Fix:** only manager or owner, always with a reason ("regular", "complaint", "staff meal"). Every discount is listed on the day-end report.

---

## B. Pre-order takeaway

The guest orders from the website, picks a branch and pickup time ("as soon as possible" or a time slot), gives name and phone, and pays at the counter on pickup.

- **Fail: no-show** (food cooked, nobody comes). **Fix:**
  - Orders over ₹1,000 need a call-back confirmation before the kitchen starts.
  - Each no-show is recorded against the phone number. After 2 no-shows that number can only pre-order with a call.
- **Fail: kitchen is slammed** on Sunday lunch. **Fix:**
  - Each slot (e.g. 15 min) has a limit, such as 10 takeaway orders, and full slots disappear.
  - The manager can pause pre-orders for a branch with one switch.
- **Fail: branch closed or dish not served at that hour.** **Fix:** only open slots are offered. Breakfast items only appear for morning slots.
- **Fail: the wrong person collects.** **Fix:** each pickup has a short code (e.g. W-042) that the guest reads out at the counter.
- **Fail: guest doesn't know it's ready.** **Fix:** their order page shows Received → Cooking → Ready, live. No SMS, as decided.

## C. Reservations (by phone)

- The desk can "Hold table 8 for Kumar, 8:30 PM, 6 guests".
- A held table can't be opened by scanning until the hold is released.
- The hold releases automatically 20 min after its time, and the desk can release it by hand.
- **Fail:** the held table sits empty while walk-ins wait. **Fix:** the desk sees the hold time counting down, and is reminded at the release time.

---

## D. Staff and operations

### D1. Waiters on their own phones (captain mode)
- Each waiter signs in with their account and sees their branch's tables.
- Optional sections: tables 1–10 for Ravi, 11–20 for Suresh. Calls from a table ping that section's waiter first.
- They can open tables, take orders, mark served, and change the guest count.

### D2. Kitchen screen goes offline (Wi-Fi drops, tablet dies)
- **Fail:** orders pile up unseen. **Fix:**
  - The kitchen screen checks in every 30 s. If it misses a minute, the desk gets a loud banner ("Kitchen screen offline: 3 orders waiting") and can print the tickets.
  - Optional later: a thermal printer in the kitchen.

### D3. Internet down at the branch
- Guests' phones on mobile data still reach the system, but the staff screens can't.
- **Fix:** the desk keeps a printable "last 20 orders" view, and the team falls back to paper.
- **Recommended:** keep a 4G backup router per branch (about ₹2,000).

### D4. Kitchen forgets to tap "Ready" or "Served"
- **Fix:** paying the bill marks everything served, so it doesn't look stuck. Those orders are flagged "times not recorded" so they don't spoil the kitchen-speed numbers.

### D5. Ticket taking too long
- **Fix:** each dish has a target time (biryani 8 min, fried chicken 15 min). The ticket turns amber at the target and red at 1.5× the target.
- The desk sees "T7 waiting 22 min" so a waiter can go and reassure the guest.

### D6. Dish runs out mid-service
- The kitchen taps it sold out once; it disappears from every phone in the branch **(have, branch-wide)**.
- **New:** it automatically comes back the next morning, so nobody forgets to turn it on.

### D7. Branch-specific menus and times
- Washermenpet opens at 6:30 AM for tiffin.
- **Fix:** per-branch availability for each dish, plus time windows ("Breakfast until 11 AM").

### D8. End of day
- **Fail:** open tables at closing leave the day's numbers wrong. **Fix:** "Close the day" lists every open table. The manager must settle each one (paid / walk-out / void with reason) before closing.
- Then the day-end summary is generated.

### D9. Staff leaves the job
- Deactivate the account; their sign-in stops at once **(have)**. Their past actions stay in the records.

---

## E. Money and trust (keeping the numbers honest)

- **Nothing paid is ever deleted.** A mistake is a "void" with a reason and who did it.
- Voids, discounts and "remove from bill" need the manager PIN, and all appear on the day-end report.
- **Cash check:** at day end the cashier enters the cash counted. The system shows cash expected and the difference.
- **Duplicate payment warning:** the same amount on the same table within 2 min asks "Record again?".
- **Audit log:** every change to price, menu, bill, payment or staff is recorded with who, when, before and after.

---

## F. Loyalty (suggestion)

**Recommended: visit stamps, not points.** They're simpler for guests and harder to game.
- Every visit with a bill of ₹300 or more earns one stamp on that phone number.
- The 10th stamp gives a free kuska or soup, redeemed **only at the desk** by staff (one tap; shows on the bill as a discount with reason "loyalty").
- The guest sees "6 of 10 visits" on their order screen, with no messages sent.
- **Fail:** without OTP, someone uses a friend's number. **Fix:** redemption needs the desk, a minimum bill, and one redemption per number per week. Each stamp costs little, so the risk stays small.
- Points (₹100 = 1 point) can come later if wanted, but they need clear rules on expiry and value.

---

## G. Dashboards

**Today (live):**
- Open tables, guests seated, orders waiting, average wait, sales so far.
- Walk-outs, voids and discounts.

**Tables:**
- Revenue per table, turns per day, and average time occupied.
- Which tables earn the most per hour, and which sit empty.
- Guests per table versus seats (a 6-seater used by 2 people).

**Guests:**
- Spend per head and party size mix.
- New versus returning guests and repeat rate.
- Top regulars, and loyalty stamps given and redeemed.

**Kitchen:**
- Time from order to ready, by dish and by hour.
- Late tickets, remakes, and items that ran out.

**Menu:**
- Best sellers, and dishes that never sell (candidates to drop).
- What is ordered together (kuska + kozhambu), price changes and their effect.

**Staff:**
- Tables served per waiter, response time to calls, and orders taken in captain mode.

**Takeaway:**
- Pre-orders per slot, no-show rate and pickup delays.

**Money:**
- Cash / card / UPI split, the cash check difference, and discounts by reason.

**Branches:**
- Every number above compared across the four branches.

**Day-end summary:** one page per branch per day, to print or save as PDF.

---

## H. Data at 400 orders a day

- **Size:** about 150,000 orders and 500,000 dish lines a year. That's small for the database.
- **One record per thing:** guest (by phone), visit, order, order line, payment and feedback. Branch, table, guest count and times are stored once on the visit, so every report adds up the same way.
- **Prices frozen on each line:** changing a price never rewrites past sales **(have)**.
- **Fast dashboards:** each night, small daily summary tables (per branch, dish, hour and table) are filled in. Dashboards read those, not the raw orders, so they stay fast as years pass.
- **No junk data:** no browsing tracking. Only orders, times, counts, payments and ratings.
- **Housekeeping:** abandoned visits are closed each night. Guest phone numbers are kept for an agreed period and deleted on request (privacy page).
- **Free plan risk:** the free Supabase plan has no daily backups. Until you move to the paid plan, a nightly export of the day's data to a spreadsheet file is a cheap safety net.

---

## Build order (proposed)

1. **Dine-in core in the v2 design:**
   - guest count
   - first-order "Seated ✓" confirm
   - self-cancel while "Received"
   - spice and note per line, parcel switch
   - "Can't make this"
   - duplicate-send guard
2. **Captain mode for waiters,** plus move, merge and split tables.
3. **Desk money controls:** voids and discounts with manager PIN, cash check, day close, audit log.
4. **Pre-order takeaway** with slots and no-show rules.
5. **Dashboards and nightly summaries.**
6. **Loyalty stamps.**
