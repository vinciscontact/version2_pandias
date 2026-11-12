-- Table PIN: lets a guest get back to their table's bill on a new phone/browser, and lets friends join it.
-- A phone without the visit token can no longer see or add to an open bill without the PIN.

alter table public.table_sessions
  add column pin text not null default lpad((floor(random() * 10000))::int::text, 4, '0'),
  add column pin_fails int not null default 0,
  add column pin_locked_until timestamptz;

-- ===================================================================== customer: is someone seated here?
create or replace function public.table_state(p_branch text, p_table text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('busy', exists (
    select 1 from public.table_sessions
    where branch_id = p_branch and table_label = p_table and status in ('open', 'bill_requested')
  ));
$$;

-- ===================================================================== customer: join the open bill with its PIN
-- Returns {ok, token} or {ok:false, error: no_open_bill | wrong_pin | locked, retryInSeconds?}.
-- Never raises on a wrong PIN, so the failure counter is kept.
create or replace function public.join_table(p_branch text, p_table text, p_pin text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_s public.table_sessions;
begin
  select * into v_s from public.table_sessions
  where branch_id = p_branch and table_label = p_table and status in ('open', 'bill_requested')
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'no_open_bill');
  end if;
  if v_s.pin_locked_until is not null and v_s.pin_locked_until > now() then
    return jsonb_build_object('ok', false, 'error', 'locked',
      'retryInSeconds', ceil(extract(epoch from v_s.pin_locked_until - now()))::int);
  end if;
  if trim(coalesce(p_pin, '')) <> v_s.pin then
    if v_s.pin_fails + 1 >= 5 then
      update public.table_sessions set pin_fails = 0, pin_locked_until = now() + interval '15 minutes' where id = v_s.id;
      return jsonb_build_object('ok', false, 'error', 'locked', 'retryInSeconds', 900);
    end if;
    update public.table_sessions set pin_fails = pin_fails + 1 where id = v_s.id;
    return jsonb_build_object('ok', false, 'error', 'wrong_pin', 'triesLeft', 4 - v_s.pin_fails);
  end if;
  update public.table_sessions set pin_fails = 0, pin_locked_until = null where id = v_s.id;
  return jsonb_build_object('ok', true, 'token', v_s.token);
end $$;

-- ===================================================================== place_order: no joining an open bill without its token
create or replace function public.place_order(
  p_branch text, p_table text, p_lines jsonb, p_note text default null, p_token uuid default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_s public.table_sessions;
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

  if v_s.id is null then
    insert into public.table_sessions (branch_id, table_label) values (p_branch, p_table) returning * into v_s;
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

  insert into public.orders (code, session_id, branch_id, table_label, note)
  values (v_code, v_s.id, p_branch, p_table, nullif(left(trim(p_note), 200), ''))
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

-- ===================================================================== get_table_status: include the PIN for the token holder
create or replace function public.get_table_status(p_token uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'status', s.status,
    'branchId', s.branch_id,
    'branchName', b.name,
    'table', s.table_label,
    'pin', s.pin,
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

grant execute on function
  public.table_state(text, text),
  public.join_table(text, text, text)
to anon, authenticated;
