-- Customers: the guest's mobile number is taken at their first "Send to kitchen" (no OTP),
-- kept as one row per number, and linked to every order and table visit.
-- Messages are not sent yet; staff can list and export customers. Consent for updates is
-- recorded separately (unticked by default), as the DPDP Act expects.

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  phone text not null unique check (phone ~ '^\+91[6-9][0-9]{9}$'), -- stored as +91XXXXXXXXXX
  name text check (char_length(name) <= 80),
  updates_ok boolean not null default false,  -- agreed to order updates by WhatsApp / SMS
  updates_ok_at timestamptz,                   -- when that choice was last made
  first_branch text references public.branches(id),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

alter table public.table_sessions add column customer_id uuid references public.customers(id);
alter table public.orders add column customer_id uuid references public.customers(id);
create index table_sessions_customer on public.table_sessions (customer_id);
create index orders_customer on public.orders (customer_id);

-- staff see a customer if they can see a branch the customer ordered at; no writes from the browser
alter table public.customers enable row level security;
create policy "branch staff read customers" on public.customers for select to authenticated using (
  (select public.is_admin())
  or exists (select 1 from public.orders o where o.customer_id = customers.id and public.can_see_branch(o.branch_id))
);

-- ===================================================================== internal: find or create the customer
-- Accepts "98765 43210", "+91 98765-43210", "09876543210"; anything that isn't an Indian mobile raises bad_phone.
create or replace function public._upsert_customer(p_phone text, p_name text, p_updates boolean, p_branch text)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_digits text := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
  v_id uuid;
begin
  if length(v_digits) = 12 and left(v_digits, 2) = '91' then v_digits := right(v_digits, 10);
  elsif length(v_digits) = 11 and left(v_digits, 1) = '0' then v_digits := right(v_digits, 10);
  end if;
  if v_digits !~ '^[6-9][0-9]{9}$' then
    raise exception 'bad_phone';
  end if;
  insert into public.customers (phone, name, updates_ok, updates_ok_at, first_branch)
  values ('+91' || v_digits, nullif(left(trim(coalesce(p_name, '')), 80), ''), coalesce(p_updates, false), now(), p_branch)
  on conflict (phone) do update set
    name = coalesce(excluded.name, public.customers.name),
    updates_ok = excluded.updates_ok,
    updates_ok_at = case when public.customers.updates_ok is distinct from excluded.updates_ok then now() else public.customers.updates_ok_at end,
    last_seen_at = now()
  returning id into v_id;
  return v_id;
end $$;
revoke execute on function public._upsert_customer(text, text, boolean, text) from public, anon, authenticated;

-- ===================================================================== place_order: now with the guest
drop function public.place_order(text, text, jsonb, text, uuid);
create function public.place_order(
  p_branch text, p_table text, p_lines jsonb, p_note text default null, p_token uuid default null,
  p_phone text default null, p_name text default null, p_updates boolean default false
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_s public.table_sessions;
  v_cust uuid;
  v_order uuid;
  v_n int;
  v_code text;
  v_total numeric := 0;
  v_line jsonb;
  v_item public.menu_items;
  v_qty int;
  v_last timestamptz;
  v_count int;
begin
  if not exists (
    select 1 from public.dining_tables t join public.branches b on b.id = t.branch_id
    where t.branch_id = p_branch and t.label = p_table and t.active and b.active
  ) then
    raise exception 'unknown_table';
  end if;
  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) not between 1 and 40 then
    raise exception 'bad_lines';
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

  -- the guest: a number is needed unless this table's bill already has one (friends who joined with the PIN)
  if nullif(trim(coalesce(p_phone, '')), '') is not null then
    v_cust := public._upsert_customer(p_phone, p_name, p_updates, p_branch);
  elsif v_s.customer_id is not null then
    v_cust := null; -- order is still tied to the visit's guest through the session
  else
    raise exception 'phone_required';
  end if;

  if v_s.id is null then
    insert into public.table_sessions (branch_id, table_label, customer_id) values (p_branch, p_table, v_cust) returning * into v_s;
  elsif v_s.customer_id is null and v_cust is not null then
    update public.table_sessions set customer_id = v_cust where id = v_s.id returning * into v_s;
  end if;

  -- abuse guards: no rapid-fire orders, sane number per visit
  select max(created_at), count(*) into v_last, v_count from public.orders where session_id = v_s.id;
  if v_last is not null and v_last > now() - interval '5 seconds' then
    raise exception 'too_fast';
  end if;
  if v_count >= 40 then
    raise exception 'too_many_orders';
  end if;

  insert into public.order_counters (branch_id, day, n)
  values (p_branch, (now() at time zone 'Asia/Kolkata')::date, 1)
  on conflict (branch_id, day) do update set n = public.order_counters.n + 1
  returning n into v_n;
  v_code := upper(left(p_branch, 1)) || '-' || lpad(v_n::text, 3, '0');

  insert into public.orders (code, session_id, branch_id, table_label, note, customer_id)
  values (v_code, v_s.id, p_branch, p_table, nullif(left(trim(p_note), 200), ''), coalesce(v_cust, v_s.customer_id))
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
    insert into public.order_items (order_id, item_id, name, unit_price, qty)
    values (v_order, v_item.id, v_item.name, v_item.price, v_qty);
    v_total := v_total + v_item.price * v_qty;
  end loop;

  update public.orders set total = v_total where id = v_order;
  perform public._recalc_session(v_s.id);

  return jsonb_build_object(
    'orderId', v_order, 'code', v_code, 'total', v_total,
    'sessionToken', v_s.token, 'placedAt', now(), 'etaMinutes', 15
  );
end $$;
grant execute on function public.place_order(text, text, jsonb, text, uuid, text, text, boolean) to anon, authenticated;

-- ===================================================================== get_table_status: does this bill have a guest number yet?
create or replace function public.get_table_status(p_token uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'status', s.status,
    'branchId', s.branch_id,
    'branchName', b.name,
    'table', s.table_label,
    'pin', s.pin,
    'hasGuest', s.customer_id is not null,
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
        'items', (select jsonb_agg(jsonb_build_object('name', i.name, 'qty', i.qty, 'price', i.unit_price) order by i.id)
                  from public.order_items i where i.order_id = o.id)
      ) order by o.created_at)
      from public.orders o where o.session_id = s.id
    ), '[]'::jsonb)
  )
  from public.table_sessions s join public.branches b on b.id = s.branch_id
  where s.token = p_token;
$$;

-- ===================================================================== staff: the customer list (owner: all; manager: own branch)
create or replace function public.list_customers(p_branch text default null, p_search text default null)
returns table (
  id uuid, phone text, name text, updates_ok boolean, first_seen timestamptz, last_order timestamptz,
  visits bigint, orders bigint, spent numeric, last_branch text
)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare me public.staff;
begin
  select * into me from public.staff s where s.user_id = auth.uid() and s.active;
  if not found or me.role not in ('admin', 'manager') then
    raise exception 'forbidden';
  end if;
  return query
    select c.id, c.phone, c.name, c.updates_ok, c.created_at,
           max(o.created_at), count(distinct o.session_id), count(o.id),
           coalesce(sum(o.total), 0), (array_agg(o.branch_id order by o.created_at desc))[1]
    from public.customers c
    join public.orders o on o.customer_id = c.id and o.status <> 'cancelled'
    where (me.role = 'admin' or o.branch_id = me.branch_id)
      and (p_branch is null or p_branch = '' or o.branch_id = p_branch)
      and (p_search is null or p_search = ''
           or (regexp_replace(p_search, '[^0-9]', '', 'g') <> '' and c.phone like '%' || regexp_replace(p_search, '[^0-9]', '', 'g') || '%')
           or c.name ilike '%' || p_search || '%')
    group by c.id
    order by max(o.created_at) desc
    limit 5000;
end $$;
revoke execute on function public.list_customers(text, text) from public, anon;
grant execute on function public.list_customers(text, text) to authenticated;
