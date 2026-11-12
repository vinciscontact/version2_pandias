-- Every price change is recorded: old price, new price, who changed it, when.
-- Past bills are never affected (each bill line keeps the price it was sold at).
create table public.menu_price_history (
  id bigint generated always as identity primary key,
  item_id text not null references public.menu_items(id) on delete cascade,
  old_price numeric(10,2),
  new_price numeric(10,2) not null,
  changed_by uuid references auth.users(id),
  changed_at timestamptz not null default now()
);
create index menu_price_history_item on public.menu_price_history (item_id, changed_at desc);
alter table public.menu_price_history enable row level security;
create policy "owner and managers read price history" on public.menu_price_history for select to authenticated using (
  exists (select 1 from public.staff s where s.user_id = (select auth.uid()) and s.active and s.role in ('admin', 'manager'))
);

create or replace function public._log_price_change() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.price is distinct from old.price then
    insert into public.menu_price_history (item_id, old_price, new_price, changed_by)
    values (new.id, old.price, new.price, auth.uid());
    new.updated_at := now();
  end if;
  return new;
end $$;
revoke execute on function public._log_price_change() from public, anon, authenticated;
create trigger menu_items_price_history before update of price on public.menu_items
for each row execute function public._log_price_change();

-- the owner changes a price through one checked function (sane range, whole rupees)
create or replace function public.set_item_price(p_item text, p_price numeric) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  if p_price is null or p_price < 0 or p_price > 100000 or p_price <> round(p_price) then raise exception 'bad_price'; end if;
  update public.menu_items set price = p_price where id = p_item;
  if not found then raise exception 'unknown_item'; end if;
end $$;
revoke execute on function public.set_item_price(text, numeric) from public, anon;
grant execute on function public.set_item_price(text, numeric) to authenticated;
