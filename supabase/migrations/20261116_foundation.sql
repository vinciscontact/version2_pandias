-- Foundation for running 8 branches safely:
--   1. activity log (who did what, written by triggers so no path can skip it)
--   2. payments can be voided (with a reason), never deleted; every total ignores voided payments
--   3. tables close with a reason: paid / walk-out / void / no charge (unpaid needs a manager and a note)
--   4. team: names, phone, waiter role, owner/manager edits (accounts are created by the staff-admin function)
--   5. branches: address, phone, map, hours; tables added in bulk
--   6. close the day: cash count, difference note, day summary
--   7. daily summaries (kept forever, tiny) + nightly job; 12-month archive with a typed confirmation
-- Every function checks the caller's role itself (security definer, empty search_path).

-- ===================================================================== 1. activity log
create table public.activity_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  branch_id text references public.branches(id),
  actor uuid,
  actor_name text not null default 'Guest / system',
  action text not null,
  target text,
  detail jsonb not null default '{}'
);
create index activity_log_at on public.activity_log (at desc);
create index activity_log_branch_at on public.activity_log (branch_id, at desc);
alter table public.activity_log enable row level security;
create policy "owner and managers read activity" on public.activity_log for select to authenticated using (
  (select public.is_admin())
  or (branch_id is not null and (select public.has_role(array['manager']::public.staff_role[], branch_id)))
);

create or replace function public._activity(p_action text, p_branch text, p_target text, p_detail jsonb default '{}')
returns void language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_name text;
begin
  if v_uid is not null then select name into v_name from public.staff where user_id = v_uid; end if;
  insert into public.activity_log (branch_id, actor, actor_name, action, target, detail)
  values (p_branch, v_uid, coalesce(v_name, case when v_uid is null then 'Guest / system' else 'Staff' end),
          p_action, p_target, coalesce(p_detail, '{}'));
end $$;
revoke execute on function public._activity(text, text, text, jsonb) from public, anon, authenticated;

-- menu: added, price, sold out / back on, removed / restored, renamed
create or replace function public._trg_menu_activity() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    perform public._activity('dish_added', null, new.name, jsonb_build_object('price', new.price));
    return null;
  end if;
  if new.price is distinct from old.price then
    perform public._activity('price_changed', null, new.name, jsonb_build_object('from', old.price, 'to', new.price));
  end if;
  if new.deleted_at is distinct from old.deleted_at then
    perform public._activity(case when new.deleted_at is null then 'dish_restored' else 'dish_removed' end, null, new.name, '{}');
  elsif new.available is distinct from old.available then
    perform public._activity(case when new.available then 'dish_on' else 'dish_sold_out' end, null, new.name, '{}');
  end if;
  if new.name is distinct from old.name then
    perform public._activity('dish_renamed', null, new.name, jsonb_build_object('from', old.name));
  end if;
  return null;
end $$;
create trigger menu_items_activity after insert or update on public.menu_items
  for each row execute function public._trg_menu_activity();

-- orders: cancelled (by a guest or staff)
create or replace function public._trg_order_activity() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'cancelled' and old.status is distinct from 'cancelled' then
    perform public._activity('order_cancelled', new.branch_id, 'Table ' || new.table_label || ' #' || new.code,
      jsonb_build_object('total', old.total, 'was', old.status));
  end if;
  return null;
end $$;
create trigger orders_activity after update of status on public.orders
  for each row execute function public._trg_order_activity();

-- order lines: "can't make"
create or replace function public._trg_item_activity() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_o public.orders;
begin
  if new.unavailable_at is not null and old.unavailable_at is null then
    select * into v_o from public.orders where id = new.order_id;
    perform public._activity('cant_make', v_o.branch_id, new.qty || 'x ' || new.name,
      jsonb_build_object('table', v_o.table_label, 'order', v_o.code, 'amount', new.qty * new.unit_price));
  end if;
  return null;
end $$;
create trigger order_items_activity after update of unavailable_at on public.order_items
  for each row execute function public._trg_item_activity();

-- tables: discount, guests confirmed, closed without full payment
create or replace function public._trg_session_activity() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.discount is distinct from old.discount then
    perform public._activity('discount', new.branch_id, 'Table ' || new.table_label,
      jsonb_build_object('from', old.discount, 'to', new.discount, 'subtotal', new.subtotal));
  end if;
  if new.seated_at is not null and old.seated_at is null then
    perform public._activity('guests_confirmed', new.branch_id, 'Table ' || new.table_label, jsonb_build_object('guests', new.guests));
  end if;
  if new.status = 'closed' and old.status <> 'closed' and coalesce(new.close_reason, '') not in ('paid', 'no_charge') then
    perform public._activity('closed_unpaid', new.branch_id, 'Table ' || new.table_label,
      jsonb_build_object('reason', coalesce(new.close_reason, 'unspecified'), 'note', new.close_note, 'total', new.total,
        'paid', (select coalesce(sum(amount), 0) from public.payments p where p.session_id = new.id and p.voided_at is null)));
  end if;
  return null;
end $$;

-- ===================================================================== 2. payments: void, never delete
alter table public.payments
  add column voided_at timestamptz,
  add column voided_by uuid references auth.users(id),
  add column void_reason text check (char_length(void_reason) <= 200);
create index if not exists payments_branch_created on public.payments (branch_id, created_at);
create index if not exists payments_session on public.payments (session_id);

create or replace function public._trg_payment_activity() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_t text;
begin
  select 'Table ' || table_label into v_t from public.table_sessions where id = new.session_id;
  if tg_op = 'INSERT' then
    perform public._activity('payment', new.branch_id, v_t, jsonb_build_object('amount', new.amount, 'method', new.method));
  elsif new.voided_at is not null and old.voided_at is null then
    perform public._activity('payment_voided', new.branch_id, v_t,
      jsonb_build_object('amount', new.amount, 'method', new.method, 'reason', new.void_reason));
  end if;
  return null;
end $$;
create trigger payments_activity after insert or update of voided_at on public.payments
  for each row execute function public._trg_payment_activity();

create or replace function public.record_payment(p_session uuid, p_method public.pay_method, p_amount numeric default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_s public.table_sessions; v_paid numeric; v_amt numeric;
begin
  select * into v_s from public.table_sessions where id = p_session for update;
  if not found then raise exception 'unknown_session'; end if;
  if not public.has_role(array['cashier', 'manager']::public.staff_role[], v_s.branch_id) then raise exception 'forbidden'; end if;
  if v_s.status = 'closed' then raise exception 'session_closed'; end if;
  select coalesce(sum(amount), 0) into v_paid from public.payments where session_id = p_session and voided_at is null;
  v_amt := coalesce(p_amount, v_s.total - v_paid);
  if v_amt <= 0 then raise exception 'nothing_due'; end if;
  if v_amt > 1000000 then raise exception 'bad_amount'; end if;
  insert into public.payments (session_id, branch_id, amount, method, received_by)
  values (p_session, v_s.branch_id, v_amt, p_method, auth.uid());
  if v_paid + v_amt >= v_s.total then
    update public.table_sessions set status = 'paid', paid_at = now() where id = p_session;
    update public.service_calls set resolved_at = now(), resolved_by = auth.uid()
    where branch_id = v_s.branch_id and table_label = v_s.table_label and kind = 'bill' and resolved_at is null;
  end if;
  return jsonb_build_object('paid', v_paid + v_amt, 'total', v_s.total);
end $$;

-- wrong method or amount entered: the manager voids it (with a reason) and the desk records it again
create or replace function public.void_payment(p_payment uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_p public.payments; v_s public.table_sessions; v_paid numeric;
begin
  select * into v_p from public.payments where id = p_payment for update;
  if not found then raise exception 'unknown_payment'; end if;
  if not public.has_role(array['manager']::public.staff_role[], v_p.branch_id) then raise exception 'forbidden'; end if;
  if v_p.voided_at is not null then raise exception 'already_voided'; end if;
  if char_length(trim(coalesce(p_reason, ''))) < 3 then raise exception 'reason_required'; end if;
  select * into v_s from public.table_sessions where id = v_p.session_id for update;
  if v_s.status = 'closed' then raise exception 'session_closed'; end if;
  update public.payments set voided_at = now(), voided_by = auth.uid(), void_reason = left(trim(p_reason), 200) where id = p_payment;
  select coalesce(sum(amount), 0) into v_paid from public.payments where session_id = v_s.id and voided_at is null;
  if v_s.status = 'paid' and v_paid < v_s.total then
    update public.table_sessions set status = 'open', paid_at = null where id = v_s.id;
  end if;
end $$;

-- the guest's phone: "paid" ignores voided payments
create or replace function public.get_table_status(p_token uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'status', s.status,
    'branchId', s.branch_id,
    'branchName', b.name,
    'table', s.table_label,
    'pin', s.pin,
    'hasGuest', s.customer_id is not null,
    'guests', s.guests,
    'seated', s.seated_at is not null or not b.seat_confirm,
    'parcelCharge', b.parcel_charge,
    'subtotal', s.subtotal,
    'taxPercent', b.tax_percent,
    'tax', s.tax,
    'discount', s.discount,
    'total', s.total,
    'paid', coalesce((select sum(p.amount) from public.payments p where p.session_id = s.id and p.voided_at is null), 0),
    'openedAt', s.opened_at,
    'feedbackGiven', exists (select 1 from public.feedback f where f.session_id = s.id),
    'googleReviewUrl', b.google_review_url,
    'orders', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', o.id, 'code', o.code, 'status', o.status, 'total', o.total, 'createdAt', o.created_at,
        'canCancel', o.status in ('held', 'received'),
        'items', (select jsonb_agg(jsonb_build_object(
                    'name', i.name, 'qty', i.qty, 'price', i.unit_price, 'spice', i.spice, 'note', i.note,
                    'parcel', i.parcel, 'parcelFee', i.parcel_fee, 'unavailable', i.unavailable_at is not null
                  ) order by i.id)
                  from public.order_items i where i.order_id = o.id)
      ) order by o.created_at)
      from public.orders o where o.session_id = s.id
    ), '[]'::jsonb)
  )
  from public.table_sessions s join public.branches b on b.id = s.branch_id
  where s.token = p_token;
$$;

-- ===================================================================== 3. closing a table, with a reason
alter table public.table_sessions
  add column close_reason text check (close_reason in ('paid', 'walkout', 'void', 'no_charge', 'unspecified')),
  add column close_note text check (char_length(close_note) <= 300),
  add column closed_by uuid references auth.users(id);
create index if not exists table_sessions_branch_opened on public.table_sessions (branch_id, opened_at);
create index if not exists orders_session on public.orders (session_id);
create index if not exists orders_branch_created on public.orders (branch_id, created_at);
create index if not exists order_items_order on public.order_items (order_id);

create trigger table_sessions_activity after update on public.table_sessions
  for each row execute function public._trg_session_activity();

drop function if exists public.close_session(uuid);
create or replace function public.close_session(p_session uuid, p_reason text default null, p_note text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare v_s public.table_sessions; v_paid numeric; v_reason text; v_note text := nullif(left(trim(coalesce(p_note, '')), 300), '');
begin
  select * into v_s from public.table_sessions where id = p_session for update;
  if not found then raise exception 'unknown_session'; end if;
  if not public.has_role(array['cashier', 'manager']::public.staff_role[], v_s.branch_id) then raise exception 'forbidden'; end if;
  if v_s.status = 'closed' then raise exception 'session_closed'; end if;
  select coalesce(sum(amount), 0) into v_paid from public.payments where session_id = p_session and voided_at is null;
  if v_s.total = 0 then
    v_reason := 'no_charge';
  elsif v_paid >= v_s.total then
    v_reason := 'paid';
  else
    -- money still due: only a manager, and (from the new app) only with a reason and a note
    if not public.has_role(array['manager']::public.staff_role[], v_s.branch_id) then raise exception 'unpaid'; end if;
    if p_reason is null then
      v_reason := 'unspecified'; -- the old desk screen sends no reason
    elsif p_reason in ('walkout', 'void') then
      if v_note is null or char_length(v_note) < 3 then raise exception 'note_required'; end if;
      v_reason := p_reason;
    else
      raise exception 'reason_required';
    end if;
  end if;
  update public.table_sessions
    set status = 'closed', closed_at = now(), closed_by = auth.uid(), close_reason = v_reason, close_note = v_note
  where id = p_session;
  update public.service_calls set resolved_at = now(), resolved_by = auth.uid()
  where branch_id = v_s.branch_id and table_label = v_s.table_label and resolved_at is null;
end $$;
revoke execute on function public.close_session(uuid, text, text) from public, anon;
grant execute on function public.close_session(uuid, text, text) to authenticated;
revoke execute on function public.void_payment(uuid, text) from public, anon;
grant execute on function public.void_payment(uuid, text) to authenticated;

-- ===================================================================== 4. team
alter table public.staff
  add column phone text check (phone is null or phone ~ '^\+91[6-9][0-9]{9}$'),
  add column login text unique check (login is null or login ~ '^[a-z0-9._-]{3,40}$'),
  add column updated_at timestamptz;

create or replace function public._trg_staff_activity() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    perform public._activity('staff_added', new.branch_id, new.name, jsonb_build_object('role', new.role));
  elsif (new.role, new.branch_id, new.active, new.name) is distinct from (old.role, old.branch_id, old.active, old.name) then
    perform public._activity(case when old.active and not new.active then 'staff_deactivated'
                                  when new.active and not old.active then 'staff_reactivated' else 'staff_changed' end,
      coalesce(new.branch_id, old.branch_id), new.name,
      jsonb_build_object('role', new.role, 'was_role', old.role, 'branch', new.branch_id, 'was_branch', old.branch_id));
  end if;
  return null;
end $$;
create trigger staff_activity after insert or update on public.staff
  for each row execute function public._trg_staff_activity();

-- owner: anyone; manager: kitchen / cashier / waiter of their own branch. Nobody switches themselves off.
create or replace function public.update_staff(p_user uuid, p_name text, p_role public.staff_role, p_branch text, p_active boolean, p_phone text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare c public.staff; t public.staff; v_phone text; v_digits text;
begin
  select * into c from public.staff where user_id = auth.uid() and active;
  if not found or c.role not in ('admin', 'manager') then raise exception 'forbidden'; end if;
  select * into t from public.staff where user_id = p_user for update;
  if not found then raise exception 'unknown_staff'; end if;
  if char_length(trim(coalesce(p_name, ''))) not between 2 and 60 then raise exception 'bad_name'; end if;
  if p_role <> 'admin' and (p_branch is null or not exists (select 1 from public.branches where id = p_branch)) then raise exception 'branch_required'; end if;
  if c.role = 'manager' and not (
       t.branch_id = c.branch_id and p_branch = c.branch_id
       and t.role in ('kitchen', 'cashier', 'waiter') and p_role in ('kitchen', 'cashier', 'waiter')) then
    raise exception 'forbidden';
  end if;
  if p_user = c.user_id and (not p_active or p_role <> c.role) then raise exception 'not_yourself'; end if;
  v_digits := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
  if v_digits = '' then v_phone := null;
  elsif v_digits ~ '^(91|0)?[6-9][0-9]{9}$' then v_phone := '+91' || right(v_digits, 10);
  else raise exception 'bad_phone';
  end if;
  update public.staff set name = trim(p_name), role = p_role,
    branch_id = case when p_role = 'admin' then null else p_branch end,
    active = p_active, phone = v_phone, updated_at = now()
  where user_id = p_user;
end $$;
revoke execute on function public.update_staff(uuid, text, public.staff_role, text, boolean, text) from public, anon;
grant execute on function public.update_staff(uuid, text, public.staff_role, text, boolean, text) to authenticated;

-- ===================================================================== 5. branches and tables
alter table public.branches
  add column address text check (char_length(address) <= 200),
  add column phone text check (char_length(phone) <= 20),
  add column map_url text check (char_length(map_url) <= 500),
  add column opens time,
  add column closes time;

create or replace function public._trg_branch_activity() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform public._activity(case when tg_op = 'INSERT' then 'branch_added' else 'branch_changed' end, new.id, new.name,
    case when tg_op = 'UPDATE' and new.tax_percent is distinct from old.tax_percent
         then jsonb_build_object('tax_from', old.tax_percent, 'tax_to', new.tax_percent) else '{}'::jsonb end);
  return null;
end $$;
create trigger branches_activity after insert or update on public.branches
  for each row execute function public._trg_branch_activity();

-- add tables 1..20 (or A1..A12) in one go; existing ones are switched back on, never duplicated
create or replace function public.add_tables(p_branch text, p_from int, p_to int, p_prefix text default '', p_seats int default 4)
returns int language plpgsql security definer set search_path = '' as $$
declare v_n int := 0; i int; v_label text;
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  if not exists (select 1 from public.branches where id = p_branch) then raise exception 'unknown_branch'; end if;
  if p_from is null or p_to is null or p_from < 1 or p_to < p_from or p_to - p_from > 199 then raise exception 'bad_range'; end if;
  if coalesce(p_prefix, '') !~ '^[A-Za-z]{0,3}$' then raise exception 'bad_prefix'; end if;
  if p_seats not between 1 and 30 then raise exception 'bad_seats'; end if;
  for i in p_from..p_to loop
    v_label := upper(coalesce(p_prefix, '')) || i;
    insert into public.dining_tables (branch_id, label, seats, active) values (p_branch, v_label, p_seats, true)
    on conflict (branch_id, label) do update set active = true, seats = excluded.seats;
    v_n := v_n + 1;
  end loop;
  perform public._activity('tables_added', p_branch, upper(coalesce(p_prefix, '')) || p_from || '-' || upper(coalesce(p_prefix, '')) || p_to, jsonb_build_object('count', v_n, 'seats', p_seats));
  return v_n;
end $$;

create or replace function public.update_table(p_branch text, p_label text, p_seats int, p_active boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  if p_seats not between 1 and 30 then raise exception 'bad_seats'; end if;
  if not p_active and exists (select 1 from public.table_sessions where branch_id = p_branch and table_label = p_label and status <> 'closed') then
    raise exception 'table_in_use';
  end if;
  update public.dining_tables set seats = p_seats, active = p_active where branch_id = p_branch and label = p_label;
  if not found then raise exception 'unknown_table'; end if;
  perform public._activity('table_changed', p_branch, 'Table ' || p_label, jsonb_build_object('seats', p_seats, 'active', p_active));
end $$;
revoke execute on function public.add_tables(text, int, int, text, int), public.update_table(text, text, int, boolean) from public, anon;
grant execute on function public.add_tables(text, int, int, text, int), public.update_table(text, text, int, boolean) to authenticated;

-- ===================================================================== 7a. daily summaries (computed; kept forever)
create table public.daily_summaries (
  branch_id text references public.branches(id),
  day date,
  sales numeric not null default 0,
  cash numeric not null default 0,
  upi numeric not null default 0,
  card numeric not null default 0,
  tables int not null default 0,
  guests int not null default 0,
  orders int not null default 0,
  items int not null default 0,
  subtotal numeric not null default 0,
  tax numeric not null default 0,
  discounts numeric not null default 0,
  walkouts int not null default 0,
  walkout_amount numeric not null default 0,
  voids int not null default 0,
  void_amount numeric not null default 0,
  cancelled_orders int not null default 0,
  cant_make int not null default 0,
  payments_voided int not null default 0,
  top_dishes jsonb not null default '[]',
  computed_at timestamptz not null default now(),
  primary key (branch_id, day)
);
alter table public.daily_summaries enable row level security;
create policy "owner and managers read summaries" on public.daily_summaries for select to authenticated using (
  (select public.has_role(array['manager']::public.staff_role[], branch_id))
);

-- one branch, one day (Chennai calendar day). Sales are money received that day; tables are those opened that day.
create or replace function public._compute_day(p_branch text, p_day date) returns public.daily_summaries
language plpgsql security definer set search_path = '' as $$
declare
  v_from timestamptz := (p_day::timestamp at time zone 'Asia/Kolkata');
  v_to timestamptz := ((p_day + 1)::timestamp at time zone 'Asia/Kolkata');
  r public.daily_summaries;
begin
  r.branch_id := p_branch; r.day := p_day; r.computed_at := now();
  select coalesce(sum(amount), 0),
         coalesce(sum(amount) filter (where method = 'cash'), 0),
         coalesce(sum(amount) filter (where method = 'upi'), 0),
         coalesce(sum(amount) filter (where method = 'card'), 0)
    into r.sales, r.cash, r.upi, r.card
  from public.payments where branch_id = p_branch and created_at >= v_from and created_at < v_to and voided_at is null;
  select count(*) filter (where voided_at is not null) into r.payments_voided
  from public.payments where branch_id = p_branch and created_at >= v_from and created_at < v_to;
  select count(*), coalesce(sum(coalesce(guests_max, guests, 0)), 0),
         coalesce(sum(subtotal) filter (where coalesce(close_reason, '') <> 'void'), 0),
         coalesce(sum(tax) filter (where coalesce(close_reason, '') <> 'void'), 0),
         coalesce(sum(discount) filter (where coalesce(close_reason, '') <> 'void'), 0),
         count(*) filter (where close_reason = 'walkout'),
         coalesce(sum(total) filter (where close_reason = 'walkout'), 0),
         count(*) filter (where close_reason = 'void'),
         coalesce(sum(total) filter (where close_reason = 'void'), 0)
    into r.tables, r.guests, r.subtotal, r.tax, r.discounts, r.walkouts, r.walkout_amount, r.voids, r.void_amount
  from public.table_sessions where branch_id = p_branch and opened_at >= v_from and opened_at < v_to;
  select count(*) filter (where status not in ('cancelled', 'held')), count(*) filter (where status = 'cancelled')
    into r.orders, r.cancelled_orders
  from public.orders where branch_id = p_branch and created_at >= v_from and created_at < v_to;
  select coalesce(sum(i.qty) filter (where i.unavailable_at is null and o.status <> 'cancelled'), 0),
         count(*) filter (where i.unavailable_at is not null)
    into r.items, r.cant_make
  from public.order_items i join public.orders o on o.id = i.order_id
  where o.branch_id = p_branch and o.created_at >= v_from and o.created_at < v_to;
  select coalesce(jsonb_agg(jsonb_build_object('name', name, 'qty', qty, 'amount', amount) order by qty desc), '[]')
    into r.top_dishes
  from (
    select i.name, sum(i.qty) qty, sum(i.qty * i.unit_price) amount
    from public.order_items i join public.orders o on o.id = i.order_id
    where o.branch_id = p_branch and o.created_at >= v_from and o.created_at < v_to
      and i.unavailable_at is null and o.status not in ('cancelled', 'held')
    group by i.name order by 2 desc limit 15
  ) t;
  insert into public.daily_summaries values (r.*)
  on conflict (branch_id, day) do update set
    sales = excluded.sales, cash = excluded.cash, upi = excluded.upi, card = excluded.card,
    tables = excluded.tables, guests = excluded.guests, orders = excluded.orders, items = excluded.items,
    subtotal = excluded.subtotal, tax = excluded.tax, discounts = excluded.discounts,
    walkouts = excluded.walkouts, walkout_amount = excluded.walkout_amount, voids = excluded.voids, void_amount = excluded.void_amount,
    cancelled_orders = excluded.cancelled_orders, cant_make = excluded.cant_make, payments_voided = excluded.payments_voided,
    top_dishes = excluded.top_dishes, computed_at = excluded.computed_at;
  return r;
end $$;
revoke execute on function public._compute_day(text, date) from public, anon, authenticated;

-- every night (01:00 Chennai): yesterday and the day before, for every branch
create or replace function public._nightly() returns void
language plpgsql security definer set search_path = '' as $$
declare b record; v_today date := (now() at time zone 'Asia/Kolkata')::date;
begin
  for b in select id from public.branches loop
    perform public._compute_day(b.id, v_today - 1);
    perform public._compute_day(b.id, v_today - 2);
  end loop;
end $$;
revoke execute on function public._nightly() from public, anon, authenticated;

-- staff can refresh a day (e.g. "Today" in Reports) for a branch they may see
create or replace function public.refresh_day(p_branch text, p_day date) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.has_role(array['manager']::public.staff_role[], p_branch) then raise exception 'forbidden'; end if;
  if p_day > (now() at time zone 'Asia/Kolkata')::date or p_day < (now() at time zone 'Asia/Kolkata')::date - 400 then raise exception 'bad_day'; end if;
  perform public._compute_day(p_branch, p_day);
end $$;
revoke execute on function public.refresh_day(text, date) from public, anon;
grant execute on function public.refresh_day(text, date) to authenticated;

-- ===================================================================== 6. close the day
create table public.day_closes (
  branch_id text references public.branches(id),
  day date,
  closed_at timestamptz not null default now(),
  closed_by uuid references auth.users(id),
  closed_by_name text,
  cash_expected numeric not null,
  cash_counted numeric not null,
  difference numeric generated always as (cash_counted - cash_expected) stored,
  note text check (char_length(note) <= 500),
  summary jsonb not null default '{}',
  primary key (branch_id, day)
);
alter table public.day_closes enable row level security;
create policy "branch staff read day closes" on public.day_closes for select to authenticated using (
  (select public.can_see_branch(branch_id))
);

-- what closing would look like right now (the manager reads this before counting the cash)
create or replace function public.day_preview(p_branch text, p_day date default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_day date := coalesce(p_day, (now() at time zone 'Asia/Kolkata')::date);
  v_to timestamptz := ((v_day + 1)::timestamp at time zone 'Asia/Kolkata');
  s public.daily_summaries;
  v_cash_out numeric := 0;
begin
  if not public.has_role(array['cashier', 'manager']::public.staff_role[], p_branch) then raise exception 'forbidden'; end if;
  s := public._compute_day(p_branch, v_day);
  if to_regclass('public.expenses') is not null then
    execute 'select coalesce(sum(amount), 0) from public.expenses where branch_id = $1 and day = $2 and paid_from = ''cash'' and voided_at is null'
      into v_cash_out using p_branch, v_day;
  end if;
  return jsonb_build_object(
    'day', v_day,
    'closed', (select to_jsonb(d) from public.day_closes d where d.branch_id = p_branch and d.day = v_day),
    'openTables', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'table', table_label, 'status', status, 'total', total,
                      'paid', (select coalesce(sum(amount), 0) from public.payments p where p.session_id = t.id and p.voided_at is null)) order by table_label)
                   from public.table_sessions t where branch_id = p_branch and status in ('open', 'bill_requested') and opened_at < v_to), '[]'),
    'paidNotClosed', (select count(*) from public.table_sessions where branch_id = p_branch and status = 'paid' and opened_at < v_to),
    'summary', to_jsonb(s),
    'cashOut', v_cash_out,
    'cashExpected', s.cash - v_cash_out
  );
end $$;

create or replace function public.close_day(p_branch text, p_counted numeric, p_note text default null, p_day date default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_day date := coalesce(p_day, (now() at time zone 'Asia/Kolkata')::date);
  v_to timestamptz := ((v_day + 1)::timestamp at time zone 'Asia/Kolkata');
  v_prev jsonb; v_expected numeric; v_note text := nullif(left(trim(coalesce(p_note, '')), 500), ''); v_name text;
begin
  if not public.has_role(array['manager']::public.staff_role[], p_branch) then raise exception 'forbidden'; end if;
  if v_day > (now() at time zone 'Asia/Kolkata')::date then raise exception 'bad_day'; end if;
  if exists (select 1 from public.day_closes where branch_id = p_branch and day = v_day) then raise exception 'already_closed'; end if;
  if p_counted is null or p_counted < 0 or p_counted > 10000000 then raise exception 'bad_amount'; end if;
  if exists (select 1 from public.table_sessions where branch_id = p_branch and status in ('open', 'bill_requested') and opened_at < v_to) then
    raise exception 'tables_open';
  end if;
  -- paid tables nobody closed: close them now
  update public.table_sessions set status = 'closed', closed_at = now(), closed_by = auth.uid(), close_reason = 'paid'
  where branch_id = p_branch and status = 'paid' and opened_at < v_to;
  v_prev := public.day_preview(p_branch, v_day);
  v_expected := (v_prev ->> 'cashExpected')::numeric;
  if abs(p_counted - v_expected) > 100 and (v_note is null or char_length(v_note) < 5) then raise exception 'note_required'; end if;
  select name into v_name from public.staff where user_id = auth.uid();
  insert into public.day_closes (branch_id, day, closed_by, closed_by_name, cash_expected, cash_counted, note, summary)
  values (p_branch, v_day, auth.uid(), v_name, v_expected, p_counted, v_note, v_prev -> 'summary');
  perform public._activity('day_closed', p_branch, to_char(v_day, 'DD Mon YYYY'),
    jsonb_build_object('expected', v_expected, 'counted', p_counted, 'difference', p_counted - v_expected, 'sales', v_prev -> 'summary' -> 'sales'));
  return v_prev || jsonb_build_object('counted', p_counted, 'difference', p_counted - v_expected);
end $$;
revoke execute on function public.day_preview(text, date), public.close_day(text, numeric, text, date) from public, anon;
grant execute on function public.day_preview(text, date), public.close_day(text, numeric, text, date) to authenticated;

-- ===================================================================== 7b. the 12-month rule
-- Nothing is removed automatically. 30 days before data turns 12 months old the owner sees a banner,
-- downloads the archive, then confirms by typing the exact phrase. Daily summaries stay forever.
create or replace function public.data_age() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_oldest timestamptz; v_cut date := ((now() at time zone 'Asia/Kolkata')::date - interval '12 months')::date;
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  select min(opened_at) into v_oldest from public.table_sessions;
  return jsonb_build_object(
    'oldest', v_oldest,
    'cutoff', v_cut,
    'warnFrom', v_cut + 30,
    'dueRows', (select count(*) from public.table_sessions where opened_at < (v_cut::timestamp at time zone 'Asia/Kolkata')),
    'soonRows', (select count(*) from public.table_sessions where opened_at < ((v_cut + 30)::timestamp at time zone 'Asia/Kolkata'))
  );
end $$;

create or replace function public.archive_remove(p_before date, p_confirm text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_cut date := ((now() at time zone 'Asia/Kolkata')::date - interval '12 months')::date;
  v_ts timestamptz := (p_before::timestamp at time zone 'Asia/Kolkata');
  d date; b record; n_s int; n_o int; n_i int; n_p int; n_f int;
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  if p_before is null or p_before > v_cut then raise exception 'too_recent'; end if;
  if p_confirm is distinct from 'REMOVE BEFORE ' || to_char(p_before, 'YYYY-MM-DD') then raise exception 'confirm_mismatch'; end if;
  -- keep the day totals forever before the detail goes
  for b in select id from public.branches loop
    for d in select distinct (opened_at at time zone 'Asia/Kolkata')::date from public.table_sessions where branch_id = b.id and opened_at < v_ts loop
      if not exists (select 1 from public.daily_summaries where branch_id = b.id and day = d) then
        perform public._compute_day(b.id, d);
      end if;
    end loop;
  end loop;
  delete from public.feedback where session_id in (select id from public.table_sessions where opened_at < v_ts and status = 'closed');
  get diagnostics n_f = row_count;
  delete from public.payments where session_id in (select id from public.table_sessions where opened_at < v_ts and status = 'closed');
  get diagnostics n_p = row_count;
  delete from public.order_items where order_id in (select o.id from public.orders o join public.table_sessions s on s.id = o.session_id where s.opened_at < v_ts and s.status = 'closed');
  get diagnostics n_i = row_count;
  delete from public.orders where session_id in (select id from public.table_sessions where opened_at < v_ts and status = 'closed');
  get diagnostics n_o = row_count;
  delete from public.table_sessions where opened_at < v_ts and status = 'closed';
  get diagnostics n_s = row_count;
  delete from public.service_calls where created_at < v_ts;
  perform public._activity('data_archived', null, 'Before ' || to_char(p_before, 'DD Mon YYYY'),
    jsonb_build_object('tables', n_s, 'orders', n_o, 'items', n_i, 'payments', n_p, 'feedback', n_f));
  return jsonb_build_object('tables', n_s, 'orders', n_o, 'items', n_i, 'payments', n_p, 'feedback', n_f);
end $$;
revoke execute on function public.data_age(), public.archive_remove(date, text) from public, anon;
grant execute on function public.data_age(), public.archive_remove(date, text) to authenticated;

-- ===================================================================== nightly job
create extension if not exists pg_cron;
select cron.schedule('pandias-nightly-summaries', '30 19 * * *', $job$select public._nightly()$job$);
