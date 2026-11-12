-- TableServe v2, phase 1: dine-in core (docs/tableserve-v2-scenarios.md, section A).
--   * guest count, required when a table is opened (A2, A4)
--   * "Seated ✓": the first order of a fresh table is HELD until staff confirm guests are
--     really there (A10, prank / remote orders); later rounds go straight to the kitchen
--   * spice level, note and parcel per dish line; per-branch packing charge (A14, A15)
--   * guest cancels their own order while it is held or just received (A11)
--   * kitchen "can't make this" on one line, taken off the bill (A12)
--   * a one-time key per send, so a retry after a network drop never doubles an order (A17)
--
-- Applied in two steps: Postgres can't use a new enum value in the same transaction that adds it.

-- ===================================================================== step 1 (its own migration)
alter type public.order_status add value if not exists 'held' before 'received';

-- ===================================================================== step 2
alter table public.branches
  add column seat_confirm boolean not null default true,          -- hold first orders until "Seated ✓"
  add column parcel_charge numeric(6,2) not null default 0 check (parcel_charge between 0 and 200);

alter table public.table_sessions
  add column guests int check (guests between 1 and 60),         -- as now
  add column guests_max int check (guests_max between 1 and 60), -- most people seen at once (for per-head numbers)
  add column seated_at timestamptz,                               -- staff confirmed the party is at the table
  add column seated_by uuid references auth.users(id);

alter table public.order_items
  add column spice text check (spice in ('mild', 'medium', 'spicy')),
  add column note text check (char_length(note) <= 120),
  add column parcel boolean not null default false,
  add column parcel_fee numeric(10,2) not null default 0,
  add column unavailable_at timestamptz,                          -- kitchen: "can't make this"
  add column unavailable_by uuid references auth.users(id);

alter table public.orders
  add column client_key uuid unique;                              -- one-time key from the guest's phone

-- ===================================================================== internal: what an order is worth
-- lines the kitchen couldn't make are free; packing charges count
create or replace function public._recalc_order(p_order uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_total numeric; v_live int;
begin
  select coalesce(sum(i.unit_price * i.qty + i.parcel_fee) filter (where i.unavailable_at is null), 0),
         count(*) filter (where i.unavailable_at is null)
  into v_total, v_live
  from public.order_items i where i.order_id = p_order;
  update public.orders set total = v_total, updated_at = now(),
    status = case when v_live = 0 then 'cancelled'::public.order_status else status end
  where id = p_order;
end $$;
revoke execute on function public._recalc_order(uuid) from public, anon, authenticated;

-- ===================================================================== place_order: guests, hold, line options, one-time key
drop function public.place_order(text, text, jsonb, text, uuid, text, text, boolean);
create function public.place_order(
  p_branch text, p_table text, p_lines jsonb, p_note text default null, p_token uuid default null,
  p_phone text default null, p_name text default null, p_updates boolean default false,
  p_guests int default null, p_key uuid default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_b public.branches;
  v_s public.table_sessions;
  v_prev public.orders;
  v_cust uuid;
  v_order uuid;
  v_n int;
  v_code text;
  v_line jsonb;
  v_item public.menu_items;
  v_qty int;
  v_spice text;
  v_parcel boolean;
  v_last timestamptz;
  v_count int;
  v_status public.order_status;
begin
  -- the same send arriving twice (network retry): answer with the first one, change nothing
  if p_key is not null then
    select * into v_prev from public.orders where client_key = p_key;
    if found then
      return jsonb_build_object(
        'orderId', v_prev.id, 'code', v_prev.code, 'total', v_prev.total, 'held', v_prev.status = 'held',
        'sessionToken', (select token from public.table_sessions where id = v_prev.session_id),
        'placedAt', v_prev.created_at, 'etaMinutes', 15, 'repeat', true);
    end if;
  end if;

  select b.* into v_b from public.branches b
  join public.dining_tables t on t.branch_id = b.id
  where b.id = p_branch and t.label = p_table and t.active and b.active;
  if not found then
    raise exception 'unknown_table';
  end if;
  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) not between 1 and 40 then
    raise exception 'bad_lines';
  end if;
  if p_guests is not null and p_guests not between 1 and 60 then
    raise exception 'bad_guests';
  end if;

  -- the party currently at this table
  select * into v_s from public.table_sessions
  where branch_id = p_branch and table_label = p_table and status in ('open', 'bill_requested', 'paid')
  for update;

  -- someone else's open bill: this phone must join it with the table PIN first
  if found and v_s.status in ('open', 'bill_requested') and p_token is distinct from v_s.token then
    raise exception 'table_busy';
  end if;

  if found and v_s.status = 'paid' then
    if p_token is not null and p_token = v_s.token then
      update public.table_sessions set status = 'open', paid_at = null where id = v_s.id returning * into v_s;
    else
      -- previous party paid and left without the table being closed: close it, start fresh
      update public.table_sessions set status = 'closed', closed_at = now() where id = v_s.id;
      v_s := null;
    end if;
  elsif found and v_s.status = 'bill_requested' then
    update public.table_sessions set status = 'open', bill_requested_at = null where id = v_s.id returning * into v_s;
  end if;

  -- a new table needs the number of guests. Transitional: the v1 order page doesn't send a
  -- guest count or a one-time key yet, so only callers that send a key (v2) must give it.
  if v_s.id is null and p_guests is null and p_key is not null then
    raise exception 'guests_required';
  end if;

  -- the guest: a number is needed unless this table's bill already has one (friends who joined with the PIN)
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
    update public.table_sessions set
      customer_id = coalesce(customer_id, v_cust),
      guests = coalesce(p_guests, guests),
      guests_max = greatest(coalesce(guests_max, 0), coalesce(p_guests, 0), coalesce(guests, 0))
    where id = v_s.id returning * into v_s;
  end if;

  -- abuse guards: no rapid-fire orders, sane number per visit
  select max(created_at), count(*) into v_last, v_count from public.orders where session_id = v_s.id;
  if v_last is not null and v_last > now() - interval '5 seconds' then
    raise exception 'too_fast';
  end if;
  if v_count >= 40 then
    raise exception 'too_many_orders';
  end if;

  -- until staff confirm the party is seated, orders wait instead of going to the kitchen
  v_status := case when v_b.seat_confirm and v_s.seated_at is null then 'held' else 'received' end;

  insert into public.order_counters (branch_id, day, n)
  values (p_branch, (now() at time zone 'Asia/Kolkata')::date, 1)
  on conflict (branch_id, day) do update set n = public.order_counters.n + 1
  returning n into v_n;
  v_code := upper(left(p_branch, 1)) || '-' || lpad(v_n::text, 3, '0');

  insert into public.orders (code, session_id, branch_id, table_label, note, customer_id, status, client_key)
  values (v_code, v_s.id, p_branch, p_table, nullif(left(trim(p_note), 200), ''), coalesce(v_cust, v_s.customer_id), v_status, p_key)
  returning id into v_order;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_qty := (v_line ->> 'qty')::int;
    if v_qty is null or v_qty not between 1 and 30 then
      raise exception 'bad_qty';
    end if;
    select * into v_item from public.menu_items where id = v_line ->> 'id';
    if not found then
      raise exception 'unknown_item:%', v_line ->> 'id';
    end if;
    if not v_item.available then
      raise exception 'unavailable:%', v_item.name;
    end if;
    v_spice := nullif(v_line ->> 'spice', '');
    if v_spice is not null and v_spice not in ('mild', 'medium', 'spicy') then
      v_spice := null;
    end if;
    v_parcel := coalesce((v_line ->> 'parcel')::boolean, false);
    insert into public.order_items (order_id, item_id, name, unit_price, qty, spice, note, parcel, parcel_fee)
    values (v_order, v_item.id, v_item.name, v_item.price, v_qty, v_spice,
            nullif(left(trim(coalesce(v_line ->> 'note', '')), 120), ''), v_parcel,
            case when v_parcel then v_b.parcel_charge * v_qty else 0 end);
  end loop;

  perform public._recalc_order(v_order);
  perform public._recalc_session(v_s.id);

  return jsonb_build_object(
    'orderId', v_order, 'code', v_code, 'total', (select total from public.orders where id = v_order),
    'held', v_status = 'held', 'sessionToken', v_s.token, 'placedAt', now(), 'etaMinutes', 15
  );
end $$;
grant execute on function public.place_order(text, text, jsonb, text, uuid, text, text, boolean, int, uuid) to anon, authenticated;

-- ===================================================================== guest: change the number of people at the table
create or replace function public.set_guests(p_token uuid, p_guests int) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_guests is null or p_guests not between 1 and 60 then raise exception 'bad_guests'; end if;
  update public.table_sessions
  set guests = p_guests, guests_max = greatest(coalesce(guests_max, 0), p_guests)
  where token = p_token and status in ('open', 'bill_requested');
  if not found then raise exception 'unknown_session'; end if;
end $$;

-- ===================================================================== guest: cancel my own order before the kitchen starts it
create or replace function public.cancel_my_order(p_token uuid, p_order uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_o public.orders;
begin
  select o.* into v_o from public.orders o
  join public.table_sessions s on s.id = o.session_id
  where o.id = p_order and s.token = p_token
  for update of o;
  if not found then raise exception 'unknown_order'; end if;
  if v_o.status not in ('held', 'received') then raise exception 'already_cooking'; end if;
  update public.orders set status = 'cancelled', updated_at = now() where id = p_order;
  perform public._recalc_session(v_o.session_id);
end $$;

-- ===================================================================== staff: "Seated ✓" releases held orders to the kitchen
create or replace function public.confirm_seated(p_session uuid, p_guests int default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v_s public.table_sessions;
begin
  select * into v_s from public.table_sessions where id = p_session for update;
  if not found then raise exception 'unknown_session'; end if;
  if not public.has_role(array['cashier', 'manager']::public.staff_role[], v_s.branch_id) then raise exception 'forbidden'; end if;
  if p_guests is not null and p_guests not between 1 and 60 then raise exception 'bad_guests'; end if;
  update public.table_sessions set
    seated_at = coalesce(seated_at, now()),
    seated_by = coalesce(seated_by, auth.uid()),
    guests = coalesce(p_guests, guests),
    guests_max = greatest(coalesce(guests_max, 0), coalesce(p_guests, 0), coalesce(guests, 0))
  where id = p_session;
  -- held orders go to the kitchen now; their clock starts from the confirmation
  update public.orders set status = 'received', created_at = now(), updated_at = now(), updated_by = auth.uid()
  where session_id = p_session and status = 'held';
end $$;

-- ===================================================================== staff: correct the guest count
create or replace function public.set_session_guests(p_session uuid, p_guests int) returns void
language plpgsql security definer set search_path = '' as $$
declare v_b text;
begin
  select branch_id into v_b from public.table_sessions where id = p_session;
  if v_b is null or not public.has_role(array['cashier', 'manager']::public.staff_role[], v_b) then raise exception 'forbidden'; end if;
  if p_guests is null or p_guests not between 1 and 60 then raise exception 'bad_guests'; end if;
  update public.table_sessions set guests = p_guests, guests_max = greatest(coalesce(guests_max, 0), p_guests) where id = p_session;
end $$;

-- ===================================================================== kitchen: "can't make this" on one line
create or replace function public.cant_make(p_item bigint) returns void
language plpgsql security definer set search_path = '' as $$
declare v_o public.orders;
begin
  select o.* into v_o from public.orders o join public.order_items i on i.order_id = o.id where i.id = p_item for update of o;
  if not found then raise exception 'unknown_item'; end if;
  if not public.has_role(array['kitchen', 'cashier', 'manager']::public.staff_role[], v_o.branch_id) then raise exception 'forbidden'; end if;
  if v_o.status in ('served', 'cancelled') then raise exception 'too_late'; end if;
  update public.order_items set unavailable_at = coalesce(unavailable_at, now()), unavailable_by = auth.uid() where id = p_item;
  perform public._recalc_order(v_o.id);
  perform public._recalc_session(v_o.session_id);
end $$;

-- ===================================================================== kitchen and desk never move a held order themselves
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
    raise exception 'not_seated'; -- use "Seated ✓" on the desk
  elsif not public.has_role(array['kitchen', 'cashier', 'manager']::public.staff_role[], v_o.branch_id) then
    raise exception 'forbidden';
  end if;
  update public.orders set
    status = p_status,
    updated_at = now(),
    updated_by = auth.uid(),
    preparing_at = case when p_status = 'preparing' then coalesce(preparing_at, now()) else preparing_at end,
    ready_at = case when p_status = 'ready' then coalesce(ready_at, now()) else ready_at end,
    served_at = case when p_status = 'served' then coalesce(served_at, now()) else served_at end
  where id = p_order;
  if p_status = 'cancelled' or v_o.status = 'cancelled' then
    perform public._recalc_session(v_o.session_id);
  end if;
end $$;

-- ===================================================================== get_table_status: guests, hold, line details, what can be cancelled
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
    'paid', coalesce((select sum(p.amount) from public.payments p where p.session_id = s.id), 0),
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

grant execute on function public.set_guests(uuid, int), public.cancel_my_order(uuid, uuid) to anon, authenticated;
revoke execute on function public.confirm_seated(uuid, int), public.set_session_guests(uuid, int), public.cant_make(bigint) from public, anon;
grant execute on function public.confirm_seated(uuid, int), public.set_session_guests(uuid, int), public.cant_make(bigint) to authenticated;

-- ===================================================================== step 3 (applied separately): staff switch dishes on/off
-- Kitchen, managers and the owner can switch a dish on or off (it ran out / it's back).
-- Prices stay owner-only (existing "admin edits menu" policy).
create or replace function public.set_item_available(p_item text, p_available boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (
    select 1 from public.staff s
    where s.user_id = auth.uid() and s.active and s.role in ('admin', 'manager', 'kitchen')
  ) then
    raise exception 'forbidden';
  end if;
  update public.menu_items set available = p_available, updated_at = now() where id = p_item;
  if not found then raise exception 'unknown_item'; end if;
end $$;
revoke execute on function public.set_item_available(text, boolean) from public, anon;
grant execute on function public.set_item_available(text, boolean) to authenticated;
