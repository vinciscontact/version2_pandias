-- Phases 2-4 (daily work, menu, business), exactly as applied to Supabase on 2026-11-16.
-- Apply after 20261116_foundation.sql.

-- ===== daily_captain_takeaway
alter table public.orders add column placed_by uuid references auth.users(id);
alter table public.table_sessions
  add column kind text not null default 'dine_in' check (kind in ('dine_in', 'takeaway')),
  add column pickup_at timestamptz,
  alter column table_label drop not null;
alter table public.table_sessions add constraint table_sessions_label_by_kind check ((kind = 'dine_in') = (table_label is not null));
alter table public.order_items
  add column remake_of bigint references public.order_items(id),
  add column remake_reason text check (char_length(remake_reason) <= 120);

-- one place for the rules about order lines (quantity, sold out, removed dishes, spice, parcel charge)
create or replace function public._add_lines(p_order uuid, p_branch text, p_lines jsonb, p_all_parcel boolean default false)
returns void language plpgsql security definer set search_path = '' as $$
declare v_line jsonb; v_item public.menu_items; v_qty int; v_spice text; v_parcel boolean; v_charge numeric;
begin
  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) not between 1 and 40 then raise exception 'bad_lines'; end if;
  select coalesce(parcel_charge, 0) into v_charge from public.branches where id = p_branch;
  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_qty := (v_line ->> 'qty')::int;
    if v_qty is null or v_qty not between 1 and 30 then raise exception 'bad_qty'; end if;
    select * into v_item from public.menu_items where id = v_line ->> 'id';
    if not found or v_item.deleted_at is not null then raise exception 'unknown_item:%', v_line ->> 'id'; end if;
    if not v_item.available then raise exception 'unavailable:%', v_item.name; end if;
    v_spice := nullif(v_line ->> 'spice', '');
    if v_spice is not null and v_spice not in ('mild', 'medium', 'spicy') then v_spice := null; end if;
    v_parcel := p_all_parcel or coalesce((v_line ->> 'parcel')::boolean, false);
    insert into public.order_items (order_id, item_id, name, unit_price, qty, spice, note, parcel, parcel_fee)
    values (p_order, v_item.id, v_item.name, v_item.price, v_qty, v_spice,
            nullif(left(trim(coalesce(v_line ->> 'note', '')), 120), ''), v_parcel,
            case when v_parcel then v_charge * v_qty else 0 end);
  end loop;
end $$;
revoke execute on function public._add_lines(uuid, text, jsonb, boolean) from public, anon, authenticated;

create or replace function public._next_code(p_branch text) returns text
language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  insert into public.order_counters (branch_id, day, n)
  values (p_branch, (now() at time zone 'Asia/Kolkata')::date, 1)
  on conflict (branch_id, day) do update set n = public.order_counters.n + 1
  returning n into v_n;
  return upper(left(p_branch, 1)) || '-' || lpad(v_n::text, 3, '0');
end $$;
revoke execute on function public._next_code(text) from public, anon, authenticated;

-- guest at the table (same behaviour as before; lines now go through _add_lines)
create or replace function public.place_order(p_branch text, p_table text, p_lines jsonb, p_note text default null, p_token uuid default null,
  p_phone text default null, p_name text default null, p_updates boolean default false, p_guests integer default null, p_key uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_b public.branches; v_s public.table_sessions; v_prev public.orders; v_cust uuid; v_order uuid; v_code text;
  v_last timestamptz; v_count int; v_status public.order_status;
begin
  if p_key is not null then
    select * into v_prev from public.orders where client_key = p_key;
    if found then
      return jsonb_build_object('orderId', v_prev.id, 'code', v_prev.code, 'total', v_prev.total, 'held', v_prev.status = 'held',
        'sessionToken', (select token from public.table_sessions where id = v_prev.session_id), 'placedAt', v_prev.created_at, 'etaMinutes', 15, 'repeat', true);
    end if;
  end if;
  select b.* into v_b from public.branches b join public.dining_tables t on t.branch_id = b.id
  where b.id = p_branch and t.label = p_table and t.active and b.active;
  if not found then raise exception 'unknown_table'; end if;
  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) not between 1 and 40 then raise exception 'bad_lines'; end if;
  if p_guests is not null and p_guests not between 1 and 60 then raise exception 'bad_guests'; end if;

  select * into v_s from public.table_sessions
  where branch_id = p_branch and table_label = p_table and status in ('open', 'bill_requested', 'paid') for update;
  if found and v_s.status in ('open', 'bill_requested') and p_token is distinct from v_s.token then raise exception 'table_busy'; end if;
  if found and v_s.status = 'paid' then
    if p_token is not null and p_token = v_s.token then
      update public.table_sessions set status = 'open', paid_at = null where id = v_s.id returning * into v_s;
    else
      update public.table_sessions set status = 'closed', closed_at = now(), close_reason = 'paid' where id = v_s.id;
      v_s := null;
    end if;
  elsif found and v_s.status = 'bill_requested' then
    update public.table_sessions set status = 'open', bill_requested_at = null where id = v_s.id returning * into v_s;
  end if;
  if v_s.id is null and p_guests is null and p_key is not null then raise exception 'guests_required'; end if;

  if nullif(trim(coalesce(p_phone, '')), '') is not null then
    v_cust := public._upsert_customer(p_phone, p_name, p_updates, p_branch);
  elsif v_s.customer_id is not null then
    v_cust := null;
  else
    raise exception 'phone_required';
  end if;

  if v_s.id is null then
    insert into public.table_sessions (branch_id, table_label, customer_id, guests, guests_max)
    values (p_branch, p_table, v_cust, p_guests, p_guests) returning * into v_s;
  else
    update public.table_sessions set customer_id = coalesce(customer_id, v_cust), guests = coalesce(p_guests, guests),
      guests_max = greatest(coalesce(guests_max, 0), coalesce(p_guests, 0), coalesce(guests, 0))
    where id = v_s.id returning * into v_s;
  end if;

  select max(created_at), count(*) into v_last, v_count from public.orders where session_id = v_s.id;
  if v_last is not null and v_last > now() - interval '5 seconds' then raise exception 'too_fast'; end if;
  if v_count >= 40 then raise exception 'too_many_orders'; end if;

  v_status := case when v_b.seat_confirm and v_s.seated_at is null then 'held' else 'received' end;
  v_code := public._next_code(p_branch);
  insert into public.orders (code, session_id, branch_id, table_label, note, customer_id, status, client_key)
  values (v_code, v_s.id, p_branch, p_table, nullif(left(trim(p_note), 200), ''), coalesce(v_cust, v_s.customer_id), v_status, p_key)
  returning id into v_order;
  perform public._add_lines(v_order, p_branch, p_lines, false);
  perform public._recalc_order(v_order);
  perform public._recalc_session(v_s.id);
  return jsonb_build_object('orderId', v_order, 'code', v_code, 'total', (select total from public.orders where id = v_order),
    'held', v_status = 'held', 'sessionToken', v_s.token, 'placedAt', now(), 'etaMinutes', 15);
end $$;

-- captain mode: a waiter (or desk / manager) orders for the table on their phone. Staff are at the
-- table, so the order goes straight to the kitchen and the guests count as seated.
create or replace function public.staff_place_order(p_branch text, p_table text, p_lines jsonb, p_guests integer default null,
  p_name text default null, p_phone text default null, p_note text default null, p_key uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_s public.table_sessions; v_prev public.orders; v_cust uuid; v_order uuid; v_code text;
begin
  if not public.has_role(array['waiter', 'cashier', 'manager']::public.staff_role[], p_branch) then raise exception 'forbidden'; end if;
  if p_key is not null then
    select * into v_prev from public.orders where client_key = p_key;
    if found then return jsonb_build_object('orderId', v_prev.id, 'code', v_prev.code, 'repeat', true); end if;
  end if;
  if not exists (select 1 from public.dining_tables where branch_id = p_branch and label = p_table and active) then raise exception 'unknown_table'; end if;
  if p_guests is not null and p_guests not between 1 and 60 then raise exception 'bad_guests'; end if;
  if nullif(trim(coalesce(p_phone, '')), '') is not null then
    v_cust := public._upsert_customer(p_phone, p_name, false, p_branch);
  end if;
  select * into v_s from public.table_sessions
  where branch_id = p_branch and table_label = p_table and status in ('open', 'bill_requested', 'paid') for update;
  if not found then
    if p_guests is null then raise exception 'guests_required'; end if;
    insert into public.table_sessions (branch_id, table_label, customer_id, guests, guests_max, seated_at, seated_by)
    values (p_branch, p_table, v_cust, p_guests, p_guests, now(), auth.uid()) returning * into v_s;
  else
    update public.table_sessions set
      status = case when status in ('paid', 'bill_requested') then 'open'::public.session_status else status end,
      paid_at = case when status = 'paid' then null else paid_at end,
      customer_id = coalesce(customer_id, v_cust),
      guests = coalesce(p_guests, guests),
      guests_max = greatest(coalesce(guests_max, 0), coalesce(p_guests, 0), coalesce(guests, 0)),
      seated_at = coalesce(seated_at, now()), seated_by = coalesce(seated_by, auth.uid())
    where id = v_s.id returning * into v_s;
    -- anything the guests sent from their own phones goes to the kitchen now that staff are with them
    update public.orders set status = 'received', created_at = now(), updated_at = now(), updated_by = auth.uid()
    where session_id = v_s.id and status = 'held';
  end if;
  v_code := public._next_code(p_branch);
  insert into public.orders (code, session_id, branch_id, table_label, note, customer_id, status, client_key, placed_by)
  values (v_code, v_s.id, p_branch, p_table, nullif(left(trim(p_note), 200), ''), coalesce(v_cust, v_s.customer_id), 'received', p_key, auth.uid())
  returning id into v_order;
  perform public._add_lines(v_order, p_branch, p_lines, false);
  perform public._recalc_order(v_order);
  perform public._recalc_session(v_s.id);
  return jsonb_build_object('orderId', v_order, 'code', v_code, 'total', (select total from public.orders where id = v_order), 'sessionId', v_s.id);
end $$;
revoke execute on function public.staff_place_order(text, text, jsonb, integer, text, text, text, uuid) from public, anon;
grant execute on function public.staff_place_order(text, text, jsonb, integer, text, text, text, uuid) to authenticated;

-- pre-order takeaway from the website: name + mobile required, pickup 15 min to 24 h ahead, pay at the
-- desk on pickup. It waits ("held") until the desk accepts it, so prank orders never reach the kitchen.
create or replace function public.place_takeaway(p_branch text, p_lines jsonb, p_name text, p_phone text, p_pickup timestamptz,
  p_note text default null, p_key uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_b public.branches; v_prev public.orders; v_cust uuid; v_s public.table_sessions; v_order uuid; v_code text;
  v_local time; v_live int; v_total numeric;
begin
  if p_key is not null then
    select * into v_prev from public.orders where client_key = p_key;
    if found then
      return jsonb_build_object('orderId', v_prev.id, 'code', v_prev.code, 'total', v_prev.total,
        'sessionToken', (select token from public.table_sessions where id = v_prev.session_id), 'repeat', true);
    end if;
  end if;
  select * into v_b from public.branches where id = p_branch and active;
  if not found then raise exception 'unknown_branch'; end if;
  if char_length(trim(coalesce(p_name, ''))) < 2 then raise exception 'name_required'; end if;
  if nullif(trim(coalesce(p_phone, '')), '') is null then raise exception 'phone_required'; end if;
  if p_pickup is null or p_pickup < now() + interval '14 minutes' or p_pickup > now() + interval '24 hours' then raise exception 'bad_pickup'; end if;
  if v_b.opens is not null and v_b.closes is not null then
    v_local := (p_pickup at time zone 'Asia/Kolkata')::time;
    if (v_b.opens < v_b.closes and (v_local < v_b.opens or v_local > v_b.closes))
       or (v_b.opens > v_b.closes and v_local < v_b.opens and v_local > v_b.closes) then
      raise exception 'closed_then';
    end if;
  end if;
  v_cust := public._upsert_customer(p_phone, p_name, false, p_branch);
  select count(*) into v_live from public.table_sessions
  where customer_id = v_cust and kind = 'takeaway' and status in ('open', 'bill_requested') and opened_at > now() - interval '24 hours';
  if v_live >= 2 then raise exception 'too_many_takeaways'; end if;
  insert into public.table_sessions (branch_id, table_label, kind, customer_id, pickup_at, guests, guests_max)
  values (p_branch, null, 'takeaway', v_cust, p_pickup, null, null) returning * into v_s;
  v_code := public._next_code(p_branch);
  insert into public.orders (code, session_id, branch_id, table_label, note, customer_id, status, client_key)
  values (v_code, v_s.id, p_branch, 'TA', nullif(left(trim(p_note), 200), ''), v_cust, 'held', p_key) returning id into v_order;
  perform public._add_lines(v_order, p_branch, p_lines, true);
  perform public._recalc_order(v_order);
  select total into v_total from public.orders where id = v_order;
  if v_total > 15000 then raise exception 'too_big'; end if;
  perform public._recalc_session(v_s.id);
  return jsonb_build_object('orderId', v_order, 'code', v_code, 'total', v_total, 'sessionToken', v_s.token, 'pickupAt', p_pickup);
end $$;
grant execute on function public.place_takeaway(text, jsonb, text, text, timestamptz, text, uuid) to anon, authenticated;

-- ===== daily_waiter_remake_loyalty
-- waiters may confirm guests (Seated ✓) and move orders (serve, recall)
create or replace function public.confirm_seated(p_session uuid, p_guests integer default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v_s public.table_sessions;
begin
  select * into v_s from public.table_sessions where id = p_session for update;
  if not found then raise exception 'unknown_session'; end if;
  if not public.has_role(array['cashier', 'manager', 'waiter']::public.staff_role[], v_s.branch_id) then raise exception 'forbidden'; end if;
  if p_guests is not null and p_guests not between 1 and 60 then raise exception 'bad_guests'; end if;
  update public.table_sessions set
    seated_at = coalesce(seated_at, now()), seated_by = coalesce(seated_by, auth.uid()),
    guests = coalesce(p_guests, guests),
    guests_max = greatest(coalesce(guests_max, 0), coalesce(p_guests, 0), coalesce(guests, 0))
  where id = p_session;
  update public.orders set status = 'received', created_at = now(), updated_at = now(), updated_by = auth.uid()
  where session_id = p_session and status = 'held';
end $$;

create or replace function public.set_order_status(p_order uuid, p_status public.order_status) returns void
language plpgsql security definer set search_path = '' as $$
declare v_o public.orders;
begin
  select * into v_o from public.orders where id = p_order for update;
  if not found then raise exception 'unknown_order'; end if;
  if p_status = 'held' then raise exception 'bad_status'; end if;
  if p_status = 'cancelled' then
    if not public.has_role(array['cashier', 'manager']::public.staff_role[], v_o.branch_id) then raise exception 'forbidden'; end if;
  elsif v_o.status = 'held' then
    raise exception 'not_seated';
  elsif v_o.status = 'cancelled' then
    raise exception 'too_late';
  elsif not public.has_role(array['kitchen', 'cashier', 'manager', 'waiter']::public.staff_role[], v_o.branch_id) then
    raise exception 'forbidden';
  end if;
  update public.orders set
    status = p_status, updated_at = now(), updated_by = auth.uid(),
    preparing_at = case when p_status = 'preparing' then coalesce(preparing_at, now()) else preparing_at end,
    ready_at = case when p_status = 'ready' then coalesce(ready_at, now()) else ready_at end,
    served_at = case when p_status = 'served' then coalesce(served_at, now()) when v_o.status = 'served' then null else served_at end
  where id = p_order;
  if p_status = 'cancelled' then perform public._recalc_session(v_o.session_id); end if;
end $$;

-- recall (a served order sent back to "ready" / "cooking") goes in the activity log
create or replace function public._trg_order_activity() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'cancelled' and old.status is distinct from 'cancelled' then
    perform public._activity('order_cancelled', new.branch_id, 'Table ' || coalesce(new.table_label, '') || ' #' || new.code,
      jsonb_build_object('total', old.total, 'was', old.status));
  elsif old.status = 'served' and new.status in ('ready', 'preparing', 'received') then
    perform public._activity('order_recalled', new.branch_id, 'Table ' || coalesce(new.table_label, '') || ' #' || new.code, '{}');
  end if;
  return null;
end $$;
revoke execute on function public._trg_order_activity() from public, anon, authenticated;

-- remake: a wrong or spoilt dish is made again at no charge (a new ticket for the kitchen)
create or replace function public.remake_item(p_item bigint, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_i public.order_items; v_o public.orders; v_s public.table_sessions; v_new uuid; v_code text;
begin
  select * into v_i from public.order_items where id = p_item;
  if not found then raise exception 'unknown_item'; end if;
  select * into v_o from public.orders where id = v_i.order_id;
  if not public.has_role(array['cashier', 'manager']::public.staff_role[], v_o.branch_id) then raise exception 'forbidden'; end if;
  if char_length(trim(coalesce(p_reason, ''))) < 3 then raise exception 'reason_required'; end if;
  select * into v_s from public.table_sessions where id = v_o.session_id for update;
  if v_s.status = 'closed' then raise exception 'session_closed'; end if;
  v_code := public._next_code(v_o.branch_id);
  insert into public.orders (code, session_id, branch_id, table_label, note, customer_id, status, placed_by)
  values (v_code, v_s.id, v_o.branch_id, v_o.table_label, left('REMAKE: ' || trim(p_reason), 200), v_o.customer_id, 'received', auth.uid())
  returning id into v_new;
  insert into public.order_items (order_id, item_id, name, unit_price, qty, spice, note, parcel, parcel_fee, remake_of, remake_reason)
  values (v_new, v_i.item_id, v_i.name, 0, v_i.qty, v_i.spice, v_i.note, v_i.parcel, 0, v_i.id, left(trim(p_reason), 120));
  perform public._recalc_order(v_new);
  perform public._recalc_session(v_s.id);
  perform public._activity('remake', v_o.branch_id, v_i.qty || 'x ' || v_i.name,
    jsonb_build_object('table', v_o.table_label, 'reason', trim(p_reason), 'value', v_i.qty * v_i.unit_price));
  return jsonb_build_object('orderId', v_new, 'code', v_code);
end $$;
revoke execute on function public.remake_item(bigint, text) from public, anon;
grant execute on function public.remake_item(bigint, text) to authenticated;

-- ===================================================================== loyalty stamps
create table public.loyalty_settings (
  id int primary key default 1 check (id = 1),
  active boolean not null default true,
  stamps_needed int not null default 5 check (stamps_needed between 2 and 20),
  min_bill numeric not null default 300 check (min_bill >= 0),
  reward text not null default 'Free dessert' check (char_length(reward) between 2 and 80),
  updated_at timestamptz not null default now()
);
insert into public.loyalty_settings (id) values (1);
alter table public.loyalty_settings enable row level security;
create policy "loyalty settings readable" on public.loyalty_settings for select to anon, authenticated using (true);

alter table public.customers
  add column stamps int not null default 0 check (stamps >= 0),
  add column rewards_given int not null default 0;

create table public.loyalty_events (
  id bigint generated always as identity primary key,
  customer_id uuid not null references public.customers(id),
  session_id uuid references public.table_sessions(id) on delete set null,
  branch_id text references public.branches(id),
  kind text not null check (kind in ('stamp', 'reward')),
  at timestamptz not null default now(),
  by uuid
);
create index loyalty_events_customer on public.loyalty_events (customer_id, at desc);
alter table public.loyalty_events enable row level security;
create policy "branch staff read loyalty" on public.loyalty_events for select to authenticated using ((select public.can_see_branch(branch_id)));

-- a stamp for each paid visit over the minimum bill, at most one a day per guest
create or replace function public._trg_session_loyalty() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_set public.loyalty_settings;
begin
  if new.status = 'paid' and old.status <> 'paid' and new.customer_id is not null then
    select * into v_set from public.loyalty_settings where id = 1;
    if v_set.active and new.total >= v_set.min_bill
       and not exists (select 1 from public.loyalty_events where session_id = new.id and kind = 'stamp')
       and not exists (select 1 from public.loyalty_events where customer_id = new.customer_id and kind = 'stamp'
                       and (at at time zone 'Asia/Kolkata')::date = (now() at time zone 'Asia/Kolkata')::date) then
      insert into public.loyalty_events (customer_id, session_id, branch_id, kind, by) values (new.customer_id, new.id, new.branch_id, 'stamp', auth.uid());
      update public.customers set stamps = stamps + 1 where id = new.customer_id;
    end if;
  end if;
  return null;
end $$;
revoke execute on function public._trg_session_loyalty() from public, anon, authenticated;
create trigger table_sessions_loyalty after update of status on public.table_sessions
  for each row execute function public._trg_session_loyalty();

create or replace function public.give_reward(p_session uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_s public.table_sessions; v_c public.customers; v_set public.loyalty_settings;
begin
  select * into v_s from public.table_sessions where id = p_session;
  if not found then raise exception 'unknown_session'; end if;
  if not public.has_role(array['cashier', 'manager']::public.staff_role[], v_s.branch_id) then raise exception 'forbidden'; end if;
  select * into v_set from public.loyalty_settings where id = 1;
  select * into v_c from public.customers where id = v_s.customer_id for update;
  if not found then raise exception 'no_guest'; end if;
  if not v_set.active or v_c.stamps < v_set.stamps_needed then raise exception 'not_enough_stamps'; end if;
  update public.customers set stamps = stamps - v_set.stamps_needed, rewards_given = rewards_given + 1 where id = v_c.id;
  insert into public.loyalty_events (customer_id, session_id, branch_id, kind, by) values (v_c.id, v_s.id, v_s.branch_id, 'reward', auth.uid());
  perform public._activity('reward_given', v_s.branch_id, coalesce(v_c.name, 'Guest'), jsonb_build_object('reward', v_set.reward, 'table', v_s.table_label));
  return jsonb_build_object('reward', v_set.reward, 'stampsLeft', v_c.stamps - v_set.stamps_needed);
end $$;

create or replace function public.set_loyalty(p_active boolean, p_needed int, p_min numeric, p_reward text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  update public.loyalty_settings set active = p_active, stamps_needed = p_needed, min_bill = p_min, reward = trim(p_reward), updated_at = now() where id = 1;
  perform public._activity('loyalty_changed', null, trim(p_reward), jsonb_build_object('active', p_active, 'needed', p_needed, 'min', p_min));
end $$;
revoke execute on function public.give_reward(uuid), public.set_loyalty(boolean, int, numeric, text) from public, anon;
grant execute on function public.give_reward(uuid), public.set_loyalty(boolean, int, numeric, text) to authenticated;

-- the guest's phone: takeaway details and their stamps
create or replace function public.get_table_status(p_token uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'status', s.status, 'kind', s.kind, 'pickupAt', s.pickup_at,
    'branchId', s.branch_id, 'branchName', b.name, 'branchPhone', b.phone,
    'table', s.table_label, 'pin', s.pin,
    'hasGuest', s.customer_id is not null, 'guests', s.guests,
    'seated', s.seated_at is not null or (s.kind = 'dine_in' and not b.seat_confirm),
    'parcelCharge', b.parcel_charge, 'subtotal', s.subtotal, 'taxPercent', b.tax_percent, 'tax', s.tax,
    'discount', s.discount, 'total', s.total,
    'paid', coalesce((select sum(p.amount) from public.payments p where p.session_id = s.id and p.voided_at is null), 0),
    'openedAt', s.opened_at,
    'feedbackGiven', exists (select 1 from public.feedback f where f.session_id = s.id),
    'googleReviewUrl', b.google_review_url,
    'loyalty', (select case when l.active and c.id is not null then jsonb_build_object('stamps', c.stamps, 'needed', l.stamps_needed, 'reward', l.reward, 'minBill', l.min_bill) end
                from public.loyalty_settings l left join public.customers c on c.id = s.customer_id where l.id = 1),
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

-- ===== daily_reports
-- dishes sold in a period (one branch, or every branch for the owner when p_branch is null)
create or replace function public.dish_sales(p_branch text, p_from date, p_to date)
returns table (item_id text, name text, qty bigint, amount numeric, orders bigint, remakes bigint, cant_make bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_branch is null then
    if not public.is_admin() then raise exception 'forbidden'; end if;
  elsif not public.has_role(array['manager']::public.staff_role[], p_branch) then raise exception 'forbidden'; end if;
  if p_to < p_from or p_to - p_from > 400 then raise exception 'bad_range'; end if;
  return query
    select i.item_id, max(i.name), coalesce(sum(i.qty) filter (where i.unavailable_at is null and i.remake_of is null), 0)::bigint,
           coalesce(sum(i.qty * i.unit_price) filter (where i.unavailable_at is null), 0),
           count(distinct o.id), count(*) filter (where i.remake_of is not null), count(*) filter (where i.unavailable_at is not null)
    from public.order_items i join public.orders o on o.id = i.order_id
    where (p_branch is null or o.branch_id = p_branch)
      and o.created_at >= (p_from::timestamp at time zone 'Asia/Kolkata') and o.created_at < ((p_to + 1)::timestamp at time zone 'Asia/Kolkata')
      and o.status not in ('cancelled', 'held')
    group by i.item_id
    order by 3 desc;
end $$;

-- kitchen timing: how long from the ticket to "ready" and to "served"
create or replace function public.kitchen_times(p_branch text, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v jsonb;
begin
  if p_branch is null then
    if not public.is_admin() then raise exception 'forbidden'; end if;
  elsif not public.has_role(array['manager']::public.staff_role[], p_branch) then raise exception 'forbidden'; end if;
  with o as (
    select o.*, extract(epoch from (o.ready_at - o.created_at)) / 60 as to_ready, extract(epoch from (o.served_at - o.created_at)) / 60 as to_served,
           extract(hour from o.created_at at time zone 'Asia/Kolkata')::int as hr
    from public.orders o
    where (p_branch is null or o.branch_id = p_branch)
      and o.created_at >= (p_from::timestamp at time zone 'Asia/Kolkata') and o.created_at < ((p_to + 1)::timestamp at time zone 'Asia/Kolkata')
      and o.status not in ('cancelled', 'held') and o.ready_at is not null and o.ready_at > o.created_at
  )
  select jsonb_build_object(
    'orders', (select count(*) from o),
    'avgReady', (select round(avg(to_ready)::numeric, 1) from o),
    'p90Ready', (select round((percentile_cont(0.9) within group (order by to_ready))::numeric, 1) from o),
    'avgServed', (select round(avg(to_served)::numeric, 1) from o where to_served is not null),
    'late', (select count(*) from o where to_ready >= 20),
    'byHour', coalesce((select jsonb_agg(jsonb_build_object('hour', hr, 'orders', n, 'avgReady', a) order by hr)
                        from (select hr, count(*) n, round(avg(to_ready)::numeric, 1) a from o group by hr) h), '[]'),
    'slowDishes', coalesce((select jsonb_agg(jsonb_build_object('name', name, 'avgReady', a, 'orders', n) order by a desc)
                        from (select i.name, round(avg(o.to_ready)::numeric, 1) a, count(distinct o.id) n
                              from o join public.order_items i on i.order_id = o.id group by i.name having count(distinct o.id) >= 3
                              order by 2 desc limit 10) d), '[]')
  ) into v;
  return v;
end $$;
revoke execute on function public.dish_sales(text, date, date), public.kitchen_times(text, date, date) from public, anon;
grant execute on function public.dish_sales(text, date, date), public.kitchen_times(text, date, date) to authenticated;

-- day totals for every past day that has data
do $$
declare b record; d date;
begin
  for b in select id from public.branches loop
    for d in select distinct (opened_at at time zone 'Asia/Kolkata')::date from public.table_sessions where branch_id = b.id loop
      perform public._compute_day(b.id, d);
    end loop;
  end loop;
end $$;

-- ===== menu_branch_time_offers
alter table public.menu_items
  add column photo text check (char_length(photo) <= 200),
  add column photo_at timestamptz,
  add column serve_from time,
  add column serve_to time,
  add column serve_days int[] check (serve_days is null or serve_days <@ array[0, 1, 2, 3, 4, 5, 6]),
  add column pairs text[] not null default '{}',
  add column combo jsonb check (combo is null or jsonb_typeof(combo) = 'array');
alter table public.menu_categories add column serve_from time, add column serve_to time;
alter table public.order_items add column list_price numeric, add column offer_id bigint;

-- one branch can switch a dish off (or the owner can price it differently there)
create table public.branch_menu (
  branch_id text references public.branches(id),
  item_id text references public.menu_items(id),
  available boolean not null default true,
  price numeric check (price is null or (price >= 0 and price <= 100000 and price = round(price))),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  primary key (branch_id, item_id)
);
alter table public.branch_menu enable row level security;
create policy "branch menu readable" on public.branch_menu for select to anon, authenticated using (true);

-- offers: % off or a fixed price, for dishes / categories / branches / days / hours / dates
create table public.offers (
  id bigint generated always as identity primary key,
  name text not null check (char_length(name) between 2 and 60),
  kind text not null check (kind in ('percent', 'price')),
  value numeric not null check (value >= 0 and value <= 100000),
  item_ids text[],
  category_ids text[],
  branch_ids text[],
  days int[] check (days is null or days <@ array[0, 1, 2, 3, 4, 5, 6]),
  start_time time,
  end_time time,
  starts_on date,
  ends_on date,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid,
  check (kind <> 'percent' or value <= 90)
);
alter table public.offers enable row level security;
create policy "offers readable" on public.offers for select to anon, authenticated using (true);

-- the price and availability of one dish, at one branch, at one moment
create or replace function public._item_now(p_item public.menu_items, p_branch text, p_at timestamptz default now())
returns table (available boolean, reason text, price numeric, list_price numeric, offer_id bigint, offer_name text)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_local timestamp := p_at at time zone 'Asia/Kolkata';
  v_t time := v_local::time;
  v_dow int := extract(dow from v_local)::int;
  v_bm public.branch_menu; v_cat public.menu_categories; v_from time; v_to time; o record; v_p numeric;
  v_base text := split_part(p_item.id, '--', 1);
begin
  select * into v_bm from public.branch_menu b where b.branch_id = p_branch and b.item_id = p_item.id;
  select * into v_cat from public.menu_categories c where c.id = p_item.category;
  list_price := coalesce(v_bm.price, p_item.price);
  price := list_price; offer_id := null; offer_name := null; available := true; reason := null;
  if p_item.deleted_at is not null then available := false; reason := 'removed';
  elsif not p_item.available or not coalesce(v_bm.available, true) then available := false; reason := 'sold_out';
  else
    v_from := coalesce(p_item.serve_from, v_cat.serve_from);
    v_to := coalesce(p_item.serve_to, v_cat.serve_to);
    if v_from is not null and v_to is not null and not (case when v_from <= v_to then v_t between v_from and v_to else v_t >= v_from or v_t <= v_to end) then
      available := false; reason := 'not_now';
    elsif p_item.serve_days is not null and not (v_dow = any (p_item.serve_days)) then
      available := false; reason := 'not_today';
    end if;
  end if;
  for o in
    select * from public.offers f
    where f.active
      and (f.starts_on is null or v_local::date >= f.starts_on) and (f.ends_on is null or v_local::date <= f.ends_on)
      and (f.days is null or v_dow = any (f.days))
      and (f.start_time is null or f.end_time is null or (case when f.start_time <= f.end_time then v_t between f.start_time and f.end_time else v_t >= f.start_time or v_t <= f.end_time end))
      and (f.branch_ids is null or p_branch = any (f.branch_ids))
      and ((f.item_ids is not null and (v_base = any (f.item_ids) or p_item.id = any (f.item_ids)))
           or (f.category_ids is not null and p_item.category = any (f.category_ids)))
  loop
    v_p := case when o.kind = 'percent' then round(list_price * (1 - o.value / 100)) else least(o.value, list_price) end;
    if v_p < price then price := v_p; offer_id := o.id; offer_name := o.name; end if;
  end loop;
  return next;
end $$;
revoke execute on function public._item_now(public.menu_items, text, timestamptz) from public, anon, authenticated;

-- what the menu pages and the waiter's phone show: price, offer and whether it can be ordered now
create or replace function public.menu_prices(p_branch text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'price', n.price, 'list', n.list_price, 'available', n.available,
           'reason', n.reason, 'offer', n.offer_name, 'from', coalesce(m.serve_from, c.serve_from), 'to', coalesce(m.serve_to, c.serve_to),
           'days', m.serve_days, 'photo', m.photo, 'pairs', m.pairs, 'combo', m.combo)), '[]')
  from public.menu_items m left join public.menu_categories c on c.id = m.category
  cross join lateral public._item_now(m, p_branch) n
  where m.deleted_at is null;
$$;
grant execute on function public.menu_prices(text) to anon, authenticated;

-- order lines now use the branch price, offers and serving hours
create or replace function public._add_lines(p_order uuid, p_branch text, p_lines jsonb, p_all_parcel boolean default false)
returns void language plpgsql security definer set search_path = '' as $$
declare v_line jsonb; v_item public.menu_items; v_now record; v_qty int; v_spice text; v_parcel boolean; v_charge numeric;
begin
  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) not between 1 and 40 then raise exception 'bad_lines'; end if;
  select coalesce(parcel_charge, 0) into v_charge from public.branches where id = p_branch;
  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_qty := (v_line ->> 'qty')::int;
    if v_qty is null or v_qty not between 1 and 30 then raise exception 'bad_qty'; end if;
    select * into v_item from public.menu_items where id = v_line ->> 'id';
    if not found or v_item.deleted_at is not null then raise exception 'unknown_item:%', v_line ->> 'id'; end if;
    select * into v_now from public._item_now(v_item, p_branch);
    if not v_now.available then
      raise exception '%:%', case v_now.reason when 'not_now' then 'not_now' when 'not_today' then 'not_today' else 'unavailable' end, v_item.name;
    end if;
    v_spice := nullif(v_line ->> 'spice', '');
    if v_spice is not null and v_spice not in ('mild', 'medium', 'spicy') then v_spice := null; end if;
    v_parcel := p_all_parcel or coalesce((v_line ->> 'parcel')::boolean, false);
    insert into public.order_items (order_id, item_id, name, unit_price, list_price, offer_id, qty, spice, note, parcel, parcel_fee)
    values (p_order, v_item.id, v_item.name, v_now.price, v_now.list_price, v_now.offer_id, v_qty, v_spice,
            nullif(left(trim(coalesce(v_line ->> 'note', '')), 120), ''), v_parcel,
            case when v_parcel then v_charge * v_qty else 0 end);
  end loop;
end $$;
revoke execute on function public._add_lines(uuid, text, jsonb, boolean) from public, anon, authenticated;

-- ===== menu_controls_photos
-- sold out: branch staff switch it for their own branch; the owner can do one branch or all branches
create or replace function public.set_branch_item(p_branch text, p_item text, p_available boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare v_name text;
begin
  if not public.has_role(array['kitchen', 'manager']::public.staff_role[], p_branch) then raise exception 'forbidden'; end if;
  select name into v_name from public.menu_items where id = p_item and deleted_at is null;
  if v_name is null then raise exception 'unknown_item'; end if;
  insert into public.branch_menu (branch_id, item_id, available, updated_by) values (p_branch, p_item, p_available, auth.uid())
  on conflict (branch_id, item_id) do update set available = excluded.available, updated_at = now(), updated_by = auth.uid();
  perform public._activity(case when p_available then 'dish_on' else 'dish_sold_out' end, p_branch, v_name, '{}');
end $$;

-- the old switch: the owner switches a dish for every branch; anyone else only for their own branch
create or replace function public.set_item_available(p_item text, p_available boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare me public.staff;
begin
  select * into me from public.staff where user_id = auth.uid() and active;
  if not found or me.role not in ('admin', 'manager', 'kitchen') then raise exception 'forbidden'; end if;
  if me.role = 'admin' then
    update public.menu_items set available = p_available, updated_at = now() where id = p_item and deleted_at is null;
    if not found then raise exception 'unknown_item'; end if;
  else
    perform public.set_branch_item(me.branch_id, p_item, p_available);
  end if;
end $$;

-- a different price at one branch (null = the normal price)
create or replace function public.set_branch_price(p_branch text, p_item text, p_price numeric) returns void
language plpgsql security definer set search_path = '' as $$
declare v_name text;
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  if p_price is not null and (p_price < 0 or p_price > 100000 or p_price <> round(p_price)) then raise exception 'bad_price'; end if;
  select name into v_name from public.menu_items where id = p_item;
  if v_name is null then raise exception 'unknown_item'; end if;
  insert into public.branch_menu (branch_id, item_id, price, updated_by) values (p_branch, p_item, p_price, auth.uid())
  on conflict (branch_id, item_id) do update set price = excluded.price, updated_at = now(), updated_by = auth.uid();
  perform public._activity('branch_price', p_branch, v_name, jsonb_build_object('price', p_price));
end $$;

-- serving hours / days, "goes well with", combo contents (whole dish: every Full / Half choice)
create or replace function public.set_dish_extras(p_base text, p_from time, p_to time, p_days int[], p_pairs text[], p_combo jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  if (p_from is null) <> (p_to is null) then raise exception 'bad_hours'; end if;
  if p_combo is not null and (jsonb_typeof(p_combo) <> 'array' or jsonb_array_length(p_combo) > 12) then raise exception 'bad_combo'; end if;
  update public.menu_items set serve_from = p_from, serve_to = p_to,
    serve_days = case when p_days is null or cardinality(p_days) in (0, 7) then null else p_days end,
    pairs = coalesce(p_pairs[1:6], '{}'), combo = case when p_combo is null or jsonb_array_length(p_combo) = 0 then null else p_combo end,
    updated_at = now()
  where id = p_base or id like p_base || '--%';
  if not found then raise exception 'unknown_item'; end if;
end $$;

create or replace function public.set_category_hours(p_category text, p_from time, p_to time) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  if (p_from is null) <> (p_to is null) then raise exception 'bad_hours'; end if;
  update public.menu_categories set serve_from = p_from, serve_to = p_to where id = p_category;
  if not found then raise exception 'bad_category'; end if;
  perform public._activity('category_hours', null, p_category, jsonb_build_object('from', p_from, 'to', p_to));
end $$;

create or replace function public.set_item_photo(p_base text, p_path text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  if p_path is not null and p_path !~ '^[a-z0-9-]+/[0-9]+$' then raise exception 'bad_photo'; end if;
  update public.menu_items set photo = p_path, photo_at = now(), updated_at = now() where id = p_base or id like p_base || '--%';
  if not found then raise exception 'unknown_item'; end if;
end $$;

create or replace function public.save_offer(p_id bigint, p_name text, p_kind text, p_value numeric, p_items text[], p_categories text[],
  p_branches text[], p_days int[], p_start time, p_end time, p_from date, p_to date, p_active boolean)
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_id bigint;
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  if coalesce(cardinality(p_items), 0) = 0 and coalesce(cardinality(p_categories), 0) = 0 then raise exception 'offer_needs_dishes'; end if;
  if p_kind = 'percent' and (p_value <= 0 or p_value > 90) then raise exception 'bad_offer'; end if;
  if p_from is not null and p_to is not null and p_to < p_from then raise exception 'bad_range'; end if;
  if p_id is null then
    insert into public.offers (name, kind, value, item_ids, category_ids, branch_ids, days, start_time, end_time, starts_on, ends_on, active, created_by)
    values (trim(p_name), p_kind, p_value, nullif(p_items, '{}'), nullif(p_categories, '{}'), nullif(p_branches, '{}'),
            case when cardinality(p_days) in (0, 7) then null else p_days end, p_start, p_end, p_from, p_to, coalesce(p_active, true), auth.uid())
    returning id into v_id;
  else
    update public.offers set name = trim(p_name), kind = p_kind, value = p_value, item_ids = nullif(p_items, '{}'), category_ids = nullif(p_categories, '{}'),
      branch_ids = nullif(p_branches, '{}'), days = case when cardinality(p_days) in (0, 7) then null else p_days end,
      start_time = p_start, end_time = p_end, starts_on = p_from, ends_on = p_to, active = p_active
    where id = p_id returning id into v_id;
    if v_id is null then raise exception 'unknown_offer'; end if;
  end if;
  perform public._activity('offer_saved', null, trim(p_name), jsonb_build_object('kind', p_kind, 'value', p_value, 'active', p_active));
  return v_id;
end $$;

-- "people who ordered this also ordered…" (last 90 days), to help choose pairings
create or replace function public.pair_suggestions(p_base text) returns table (base text, name text, together bigint)
language sql stable security definer set search_path = '' as $$
  select split_part(i2.item_id, '--', 1), max(regexp_replace(i2.name, '\s\((?:[^()]|\([^()]*\))*\)$', '')), count(distinct i1.order_id)
  from public.order_items i1 join public.order_items i2 on i2.order_id = i1.order_id
  join public.orders o on o.id = i1.order_id
  where public.has_role(array['manager']::public.staff_role[], o.branch_id)
    and split_part(i1.item_id, '--', 1) = p_base and split_part(i2.item_id, '--', 1) <> p_base
    and o.created_at > now() - interval '90 days' and o.status not in ('cancelled', 'held')
  group by 1 order by 3 desc limit 8;
$$;

revoke execute on function public.set_branch_item(text, text, boolean), public.set_branch_price(text, text, numeric),
  public.set_dish_extras(text, time, time, int[], text[], jsonb), public.set_category_hours(text, time, time),
  public.set_item_photo(text, text), public.save_offer(bigint, text, text, numeric, text[], text[], text[], int[], time, time, date, date, boolean),
  public.pair_suggestions(text) from public, anon;
grant execute on function public.set_branch_item(text, text, boolean), public.set_branch_price(text, text, numeric),
  public.set_dish_extras(text, time, time, int[], text[], jsonb), public.set_category_hours(text, time, time),
  public.set_item_photo(text, text), public.save_offer(bigint, text, text, numeric, text[], text[], text[], int[], time, time, date, date, boolean),
  public.pair_suggestions(text) to authenticated;

-- food photos: a public bucket anyone can view; only the owner can upload, replace or delete
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('menu-photos', 'menu-photos', true, 1048576, array['image/webp', 'image/jpeg'])
on conflict (id) do nothing;
create policy "owner uploads menu photos" on storage.objects for insert to authenticated with check (bucket_id = 'menu-photos' and (select public.is_admin()));
create policy "owner replaces menu photos" on storage.objects for update to authenticated using (bucket_id = 'menu-photos' and (select public.is_admin()));
create policy "owner deletes menu photos" on storage.objects for delete to authenticated using (bucket_id = 'menu-photos' and (select public.is_admin()));

-- ===== business_stock_expenses_attendance
alter table public.branches add column gstin text check (gstin is null or gstin ~ '^[0-9]{2}[A-Z0-9]{13}$');

-- ===================================================================== expenses (petty cash and bills)
create table public.expenses (
  id bigint generated always as identity primary key,
  branch_id text not null references public.branches(id),
  day date not null default (now() at time zone 'Asia/Kolkata')::date,
  category text not null check (category in ('supplies', 'salary', 'rent', 'utilities', 'repairs', 'gas', 'marketing', 'transport', 'other')),
  amount numeric not null check (amount > 0 and amount <= 10000000),
  paid_from text not null check (paid_from in ('cash', 'upi', 'bank', 'card')),
  payee text check (char_length(payee) <= 80),
  note text check (char_length(note) <= 200),
  stock_move_id bigint,
  at timestamptz not null default now(),
  by uuid default auth.uid(),
  voided_at timestamptz,
  voided_by uuid,
  void_reason text check (char_length(void_reason) <= 200)
);
create index expenses_branch_day on public.expenses (branch_id, day);
alter table public.expenses enable row level security;
create policy "owner managers cashiers read expenses" on public.expenses for select to authenticated using (
  (select public.has_role(array['manager', 'cashier']::public.staff_role[], branch_id))
);

create or replace function public.add_expense(p_branch text, p_category text, p_amount numeric, p_paid_from text, p_payee text default null, p_note text default null, p_day date default null)
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_id bigint; v_day date := coalesce(p_day, (now() at time zone 'Asia/Kolkata')::date);
begin
  if not public.has_role(array['manager', 'cashier']::public.staff_role[], p_branch) then raise exception 'forbidden'; end if;
  -- the desk can only record small cash spends for today; bigger ones and past days are for a manager
  if not public.has_role(array['manager']::public.staff_role[], p_branch) and (p_amount > 5000 or v_day <> (now() at time zone 'Asia/Kolkata')::date) then raise exception 'manager_needed'; end if;
  if v_day > (now() at time zone 'Asia/Kolkata')::date or v_day < (now() at time zone 'Asia/Kolkata')::date - 62 then raise exception 'bad_day'; end if;
  if exists (select 1 from public.day_closes where branch_id = p_branch and day = v_day) and p_paid_from = 'cash' then raise exception 'day_closed'; end if;
  insert into public.expenses (branch_id, day, category, amount, paid_from, payee, note)
  values (p_branch, v_day, p_category, round(p_amount, 2), p_paid_from, nullif(trim(p_payee), ''), nullif(trim(p_note), ''))
  returning id into v_id;
  perform public._activity('expense', p_branch, p_category, jsonb_build_object('amount', p_amount, 'paid_from', p_paid_from, 'payee', p_payee));
  return v_id;
end $$;

create or replace function public.void_expense(p_id bigint, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.expenses;
begin
  select * into v from public.expenses where id = p_id for update;
  if not found then raise exception 'unknown_expense'; end if;
  if not public.has_role(array['manager']::public.staff_role[], v.branch_id) then raise exception 'forbidden'; end if;
  if v.voided_at is not null then raise exception 'already_voided'; end if;
  if char_length(trim(coalesce(p_reason, ''))) < 3 then raise exception 'reason_required'; end if;
  if v.paid_from = 'cash' and exists (select 1 from public.day_closes where branch_id = v.branch_id and day = v.day) then raise exception 'day_closed'; end if;
  update public.expenses set voided_at = now(), voided_by = auth.uid(), void_reason = left(trim(p_reason), 200) where id = p_id;
  perform public._activity('expense_voided', v.branch_id, v.category, jsonb_build_object('amount', v.amount, 'reason', trim(p_reason)));
end $$;

-- ===================================================================== stock
create table public.stock_items (
  id bigint generated always as identity primary key,
  name text not null unique check (char_length(name) between 2 and 60),
  unit text not null check (unit in ('kg', 'g', 'l', 'ml', 'pcs', 'packet', 'box', 'tray', 'bottle', 'cylinder')),
  low_at numeric not null default 0 check (low_at >= 0),
  active boolean not null default true,
  sort int not null default 0
);
alter table public.stock_items enable row level security;
create policy "staff read stock items" on public.stock_items for select to authenticated using (true);

create table public.stock_moves (
  id bigint generated always as identity primary key,
  branch_id text not null references public.branches(id),
  item_id bigint not null references public.stock_items(id),
  kind text not null check (kind in ('purchase', 'use', 'waste', 'count')),
  qty numeric not null,             -- signed change to what's on hand
  counted numeric,                  -- for a count: what was actually there
  cost numeric check (cost is null or cost >= 0),
  supplier text check (char_length(supplier) <= 80),
  note text check (char_length(note) <= 200),
  at timestamptz not null default now(),
  by uuid default auth.uid(),
  voided_at timestamptz,
  voided_by uuid
);
create index stock_moves_branch_item on public.stock_moves (branch_id, item_id, at);
alter table public.stock_moves enable row level security;
create policy "branch staff read stock moves" on public.stock_moves for select to authenticated using (
  (select public.has_role(array['manager', 'kitchen']::public.staff_role[], branch_id))
);

create or replace function public.save_stock_item(p_id bigint, p_name text, p_unit text, p_low numeric, p_active boolean)
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_id bigint; me public.staff;
begin
  select * into me from public.staff where user_id = auth.uid() and active;
  if not found or me.role not in ('admin', 'manager') then raise exception 'forbidden'; end if;
  if p_id is null then
    insert into public.stock_items (name, unit, low_at, active, sort) values (trim(p_name), p_unit, coalesce(p_low, 0), coalesce(p_active, true), (select coalesce(max(sort), 0) + 1 from public.stock_items))
    returning id into v_id;
  else
    update public.stock_items set name = trim(p_name), unit = p_unit, low_at = coalesce(p_low, 0), active = coalesce(p_active, true) where id = p_id returning id into v_id;
    if v_id is null then raise exception 'unknown_item'; end if;
  end if;
  return v_id;
end $$;

-- on hand per item at a branch
create or replace function public.stock_levels(p_branch text)
returns table (item_id bigint, name text, unit text, low_at numeric, on_hand numeric, last_purchase timestamptz, last_count timestamptz, used_7d numeric)
language sql stable security definer set search_path = '' as $$
  select i.id, i.name, i.unit, i.low_at,
         coalesce(sum(m.qty) filter (where m.voided_at is null), 0),
         max(m.at) filter (where m.kind = 'purchase' and m.voided_at is null),
         max(m.at) filter (where m.kind = 'count' and m.voided_at is null),
         coalesce(-sum(m.qty) filter (where m.kind in ('use', 'waste') and m.voided_at is null and m.at > now() - interval '7 days'), 0)
  from public.stock_items i left join public.stock_moves m on m.item_id = i.id and m.branch_id = p_branch
  where i.active and public.has_role(array['manager', 'kitchen']::public.staff_role[], p_branch)
  group by i.id order by i.sort, i.name;
$$;

-- purchase (+, optionally paid from the drawer = an expense), use / waste (−), count (sets the number)
create or replace function public.stock_move(p_branch text, p_item bigint, p_kind text, p_qty numeric, p_cost numeric default null,
  p_supplier text default null, p_note text default null, p_paid_from text default null)
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_id bigint; v_on numeric; v_delta numeric; v_name text; v_exp bigint;
begin
  if p_kind in ('purchase', 'count') then
    if not public.has_role(array['manager']::public.staff_role[], p_branch) then raise exception 'forbidden'; end if;
  elsif p_kind in ('use', 'waste') then
    if not public.has_role(array['manager', 'kitchen']::public.staff_role[], p_branch) then raise exception 'forbidden'; end if;
  else raise exception 'bad_kind'; end if;
  select name into v_name from public.stock_items where id = p_item and active;
  if v_name is null then raise exception 'unknown_item'; end if;
  if p_qty is null or p_qty < 0 or p_qty > 100000 or (p_kind <> 'count' and p_qty = 0) then raise exception 'bad_qty'; end if;
  if p_kind = 'count' then
    select coalesce(sum(qty), 0) into v_on from public.stock_moves where branch_id = p_branch and item_id = p_item and voided_at is null;
    v_delta := p_qty - v_on;
  else
    v_delta := case when p_kind = 'purchase' then p_qty else -p_qty end;
  end if;
  insert into public.stock_moves (branch_id, item_id, kind, qty, counted, cost, supplier, note)
  values (p_branch, p_item, p_kind, v_delta, case when p_kind = 'count' then p_qty end, case when p_kind = 'purchase' then p_cost end,
          nullif(trim(p_supplier), ''), nullif(trim(p_note), ''))
  returning id into v_id;
  if p_kind = 'purchase' and coalesce(p_cost, 0) > 0 and p_paid_from is not null then
    v_exp := public.add_expense(p_branch, 'supplies', p_cost, p_paid_from, p_supplier, v_name || ' ' || p_qty);
    update public.expenses set stock_move_id = v_id where id = v_exp;
  end if;
  if p_kind in ('waste', 'count') then
    perform public._activity('stock_' || p_kind, p_branch, v_name, jsonb_build_object('qty', p_qty, 'change', v_delta, 'note', p_note));
  end if;
  return v_id;
end $$;

create or replace function public.void_stock_move(p_id bigint) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.stock_moves;
begin
  select * into v from public.stock_moves where id = p_id for update;
  if not found then raise exception 'unknown_move'; end if;
  if not public.has_role(array['manager']::public.staff_role[], v.branch_id) then raise exception 'forbidden'; end if;
  if v.voided_at is not null then raise exception 'already_voided'; end if;
  update public.stock_moves set voided_at = now(), voided_by = auth.uid() where id = p_id;
  update public.expenses set voided_at = now(), voided_by = auth.uid(), void_reason = 'stock entry voided' where stock_move_id = p_id and voided_at is null;
end $$;

-- ===================================================================== attendance
create table public.attendance (
  id bigint generated always as identity primary key,
  branch_id text not null references public.branches(id),
  user_id uuid not null references auth.users(id),
  day date not null,
  check_in timestamptz not null,
  check_out timestamptz,
  marked_by uuid,
  note text check (char_length(note) <= 200),
  check (check_out is null or check_out > check_in)
);
create unique index attendance_one_open on public.attendance (user_id) where check_out is null;
create index attendance_branch_day on public.attendance (branch_id, day);
alter table public.attendance enable row level security;
create policy "own and managed attendance" on public.attendance for select to authenticated using (
  user_id = (select auth.uid()) or (select public.has_role(array['manager']::public.staff_role[], branch_id))
);

-- staff check in / out on their own phone
create or replace function public.clock(p_in boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me public.staff; v public.attendance;
begin
  select * into me from public.staff where user_id = auth.uid() and active;
  if not found or me.branch_id is null then raise exception 'forbidden'; end if;
  select * into v from public.attendance where user_id = me.user_id and check_out is null;
  if p_in then
    if found then return to_jsonb(v); end if;
    insert into public.attendance (branch_id, user_id, day, check_in) values (me.branch_id, me.user_id, (now() at time zone 'Asia/Kolkata')::date, now()) returning * into v;
  else
    if not found then raise exception 'not_clocked_in'; end if;
    if v.check_in < now() - interval '20 hours' then
      update public.attendance set check_out = check_in + interval '12 hours', note = 'auto: forgot to check out' where id = v.id;
      raise exception 'forgot_checkout';
    end if;
    update public.attendance set check_out = now() where id = v.id returning * into v;
  end if;
  return to_jsonb(v);
end $$;

-- a manager fixes or adds a record (forgotten check-out, phone left at home)
create or replace function public.mark_attendance(p_user uuid, p_day date, p_in time, p_out time, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
declare t public.staff; v_in timestamptz; v_out timestamptz;
begin
  select * into t from public.staff where user_id = p_user;
  if not found or t.branch_id is null then raise exception 'unknown_staff'; end if;
  if not public.has_role(array['manager']::public.staff_role[], t.branch_id) then raise exception 'forbidden'; end if;
  if p_day > (now() at time zone 'Asia/Kolkata')::date or p_day < (now() at time zone 'Asia/Kolkata')::date - 62 then raise exception 'bad_day'; end if;
  v_in := (p_day + p_in) at time zone 'Asia/Kolkata';
  v_out := case when p_out is null then null when p_out > p_in then (p_day + p_out) at time zone 'Asia/Kolkata' else (p_day + 1 + p_out) at time zone 'Asia/Kolkata' end;
  delete from public.attendance where user_id = p_user and day = p_day;
  insert into public.attendance (branch_id, user_id, day, check_in, check_out, marked_by, note)
  values (t.branch_id, p_user, p_day, v_in, v_out, auth.uid(), nullif(trim(p_note), ''));
  perform public._activity('attendance_marked', t.branch_id, t.name, jsonb_build_object('day', p_day, 'in', p_in, 'out', p_out, 'note', p_note));
end $$;

revoke execute on function public.add_expense(text, text, numeric, text, text, text, date), public.void_expense(bigint, text),
  public.save_stock_item(bigint, text, text, numeric, boolean), public.stock_levels(text),
  public.stock_move(text, bigint, text, numeric, numeric, text, text, text), public.void_stock_move(bigint),
  public.clock(boolean), public.mark_attendance(uuid, date, time, time, text) from public, anon;
grant execute on function public.add_expense(text, text, numeric, text, text, text, date), public.void_expense(bigint, text),
  public.save_stock_item(bigint, text, text, numeric, boolean), public.stock_levels(text),
  public.stock_move(text, bigint, text, numeric, numeric, text, text, text), public.void_stock_move(bigint),
  public.clock(boolean), public.mark_attendance(uuid, date, time, time, text) to authenticated;

-- a starter list of what a biryani kitchen tracks (the owner can change it)
insert into public.stock_items (name, unit, low_at, sort) values
  ('Mutton', 'kg', 10, 1), ('Chicken', 'kg', 15, 2), ('Basmati rice', 'kg', 25, 3), ('Seeraga samba rice', 'kg', 25, 4),
  ('Onion', 'kg', 20, 5), ('Tomato', 'kg', 10, 6), ('Ghee', 'l', 5, 7), ('Cooking oil', 'l', 15, 8), ('Eggs', 'pcs', 60, 9),
  ('Curd', 'kg', 5, 10), ('Maida', 'kg', 15, 11), ('Fish', 'kg', 5, 12), ('Prawn', 'kg', 3, 13), ('Gas cylinder', 'cylinder', 2, 14),
  ('Parcel boxes', 'pcs', 100, 15)
on conflict (name) do nothing;
