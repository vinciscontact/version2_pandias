-- Dishes get their full details in the database (until now they lived only in the website's menu file),
-- a categories list, and owner-only add / edit / remove (remove = soft, restorable for 30 days).
create table public.menu_categories (
  id text primary key check (id ~ '^[a-z0-9-]{2,40}$'),
  name text not null check (char_length(name) between 2 and 60),
  blurb text check (char_length(blurb) <= 160),
  sort int not null default 0
);
alter table public.menu_categories enable row level security;
create policy "categories readable" on public.menu_categories for select to anon, authenticated using (true);
insert into public.menu_categories (id, name, blurb, sort) values
('biryani','Biryani','Golden, gently spiced, slow on the dum.',0),
('kuska','Kuska & Rice','Biryani rice, minus the pieces. North Madras loves it.',1),
('chicken','Fried Chicken & Starters','Seven ways to fry a chicken. All of them good.',2),
('seafood','Indian Seafood','Crab, prawn, karimeen and vanjaram from the coast.',3),
('kebabs','Kebabs & Tikka','Off the tandoor, smoky at the edges.',4),
('mutton','Mutton Specials','Kozhambu, pirattal and paya, South Indian style.',5),
('south-seafood','South Indian Seafood','Masala, thokku or pepper gravy.',6),
('indian-main','Indian Main Course','Pick the gravy, then pick the meat.',7),
('chinese','Chinese Main Course','Chennai-style Chinese. Pick the gravy, then pick the meat.',8),
('parotta','Parotta & Breads','Soft, flaky, made fresh in the evenings.',9),
('tiffin','Tiffin','Dosai, kalakki and the morning-to-night classics.',10),
('soups','Soups','Hot, peppery, Chettinad style.',11),
('rice-noodles','Rice & Noodles','Fried rice and noodles, wok-tossed.',12),
('shawarma','Shawarma','Rolled to order.',13),
('desserts','Desserts','Something cold after all that spice.',14)
on conflict (id) do nothing;

alter table public.menu_items
  add column tamil text check (char_length(tamil) <= 80),
  add column description text check (char_length(description) <= 300),
  add column diet text not null default 'nonveg' check (diet in ('veg', 'egg', 'nonveg')),
  add column tags text[] not null default '{}',
  add column sort int not null default 0,
  add column created_at timestamptz not null default now(),
  add column deleted_at timestamptz;

update public.menu_items m set tamil = v.tamil, description = v.descr, diet = v.diet, tags = v.tags, sort = v.sort
from (values
('mutton-biryani','மட்டன் பிரியாணி','Tender mutton and golden rice, with a gentle masala that lets the meat talk.','nonveg',array['signature','bestseller']::text[],0),
('chicken-biryani','சிக்கன் பிரியாணி','Juicy chicken pieces layered and sealed for dum.','nonveg',array['bestseller']::text[],1),
('fish-biryani',null,'Boneless fish folded through fragrant rice.','nonveg','{}'::text[],2),
('prawn-biryani',null,'Coastal prawns, slow-cooked with the rice.','nonveg','{}'::text[],3),
('egg-biryani',null,'Masala eggs on a full plate of biryani rice.','egg','{}'::text[],4),
('veg-biryani',null,'Garden vegetables, the same slow dum.','veg','{}'::text[],5),
('kuska','குஸ்கா','Biryani rice cooked in the mutton stock, minus the pieces. Pair it with a mutton kozhambu.','nonveg',array['signature']::text[],6),
('kuska-egg',null,null,'nonveg','{}'::text[],7),
('pandias-fried-chicken--full',null,'The house fry, named after the hotel.','nonveg',array['signature']::text[],8),
('pandias-fried-chicken--half',null,'The house fry, named after the hotel.','nonveg',array['signature']::text[],9),
('chettinad-fried-chicken--full',null,null,'nonveg',array['special','spicy']::text[],10),
('chettinad-fried-chicken--half',null,null,'nonveg',array['special','spicy']::text[],11),
('peppery-fried-chicken--full',null,null,'nonveg',array['special']::text[],12),
('peppery-fried-chicken--half',null,null,'nonveg',array['special']::text[],13),
('andhra-fried-chicken--full',null,null,'nonveg',array['special','spicy']::text[],14),
('andhra-fried-chicken--half',null,null,'nonveg',array['special','spicy']::text[],15),
('red-hot-fried-chicken--full',null,null,'nonveg',array['special','spicy']::text[],16),
('red-hot-fried-chicken--half',null,null,'nonveg',array['special','spicy']::text[],17),
('mughalai-fried-chicken--full',null,null,'nonveg',array['special']::text[],18),
('mughalai-fried-chicken--half',null,null,'nonveg',array['special']::text[],19),
('dragon-fried-chicken--full',null,null,'nonveg',array['special']::text[],20),
('dragon-fried-chicken--half',null,null,'nonveg',array['special']::text[],21),
('sutta-kozhi','சுட்ட கோழி','Chicken roasted over open fire.','nonveg','{}'::text[],22),
('dynamite-chicken',null,null,'nonveg',array['special','spicy']::text[],23),
('masala-chicken-65',null,null,'nonveg','{}'::text[],24),
('chicken-pakoda',null,null,'nonveg','{}'::text[],25),
('chicken-bits',null,null,'nonveg','{}'::text[],26),
('crab-fry',null,null,'nonveg','{}'::text[],27),
('crab-puttu',null,null,'nonveg','{}'::text[],28),
('crab-pepper-fry',null,null,'nonveg','{}'::text[],29),
('tiger-prawn-65',null,null,'nonveg','{}'::text[],30),
('curry-leaf-tiger-prawn',null,null,'nonveg','{}'::text[],31),
('ghee-tiger-prawn-pepper',null,null,'nonveg','{}'::text[],32),
('fried-tiger-prawn-chinese',null,null,'nonveg',array['special']::text[],33),
('prawn-65',null,null,'nonveg','{}'::text[],34),
('spl-fried-prawns',null,null,'nonveg',array['special']::text[],35),
('cheemeen-pollichathu',null,'Prawns in masala, wrapped in banana leaf and pan-roasted, Kerala style.','nonveg',array['special']::text[],36),
('karimeen-fry',null,null,'nonveg','{}'::text[],37),
('karimeen-pollichathu',null,'Pearl spot fish roasted in banana leaf with a thick masala.','nonveg',array['signature']::text[],38),
('spl-vanjaram-fry',null,null,'nonveg','{}'::text[],39),
('vanjaram-tawa-fry',null,null,'nonveg','{}'::text[],40),
('fish-65',null,null,'nonveg','{}'::text[],41),
('spicy-fish-65',null,null,'nonveg',array['spicy']::text[],42),
('nethili-65',null,null,'nonveg','{}'::text[],43),
('sura-puttu','சுறா புட்டு','Shark, flaked and dry-tossed with onion and spice.','nonveg',array['special']::text[],44),
('fish-puttu',null,null,'nonveg','{}'::text[],45),
('squid-65',null,null,'nonveg','{}'::text[],46),
('spl-fried-squid',null,null,'nonveg',array['special']::text[],47),
('basa-steak',null,'Any sauce: Chinese, Indian or BBQ.','nonveg','{}'::text[],48),
('tangdi-kebab',null,null,'nonveg','{}'::text[],49),
('malabar-chicken-tikka',null,null,'nonveg','{}'::text[],50),
('reshmi-kebab',null,null,'nonveg','{}'::text[],51),
('angari-kebab',null,null,'nonveg','{}'::text[],52),
('malai-kebab',null,null,'nonveg','{}'::text[],53),
('irani-kebab',null,null,'nonveg','{}'::text[],54),
('kalmi-kebab',null,null,'nonveg','{}'::text[],55),
('hariyali-kebab',null,null,'nonveg','{}'::text[],56),
('chicken-tikka',null,null,'nonveg','{}'::text[],57),
('hot-chicken-tikka',null,null,'nonveg',array['special','spicy']::text[],58),
('mutton-seekh-kebab',null,null,'nonveg','{}'::text[],59),
('kola-urundai-kozhambu','கோலா உருண்டை குழம்பு','Minced mutton balls in a spiced kozhambu.','nonveg','{}'::text[],60),
('nalli-roast--fry',null,'Mutton shank, as a dry fry or in kozhambu.','nonveg','{}'::text[],61),
('nalli-roast--kozhambu',null,'Mutton shank, as a dry fry or in kozhambu.','nonveg','{}'::text[],62),
('nenjelumbu--fry',null,'Mutton chest bone, as a dry fry or in kozhambu.','nonveg','{}'::text[],63),
('nenjelumbu--kozhambu',null,'Mutton chest bone, as a dry fry or in kozhambu.','nonveg','{}'::text[],64),
('mutton-egg-pirattal',null,null,'nonveg',array['special']::text[],65),
('pepper-paya',null,'Trotters slow-cooked with black pepper.','nonveg','{}'::text[],66),
('spl-mutton-kuruma',null,null,'nonveg',array['special']::text[],67),
('spl-mutton-kozhambu','மட்டன் குழம்பு','The regulars'' bowl with kuska and parotta.','nonveg',array['signature']::text[],68),
('mutton-kheema',null,null,'nonveg','{}'::text[],69),
('crab-shell-masala',null,null,'nonveg','{}'::text[],70),
('crab-shelless-masala',null,null,'nonveg','{}'::text[],71),
('prawn-masala',null,null,'nonveg','{}'::text[],72),
('in-chettinad--crab-shelless-',null,null,'nonveg',array['spicy']::text[],73),
('in-chettinad--prawn',null,null,'nonveg',array['spicy']::text[],74),
('in-chettinad--fish',null,null,'nonveg',array['spicy']::text[],75),
('in-chettinad--squid',null,null,'nonveg',array['spicy']::text[],76),
('in-chettinad--mutton',null,null,'nonveg',array['spicy']::text[],77),
('in-chettinad--chicken',null,null,'nonveg',array['spicy']::text[],78),
('in-chettinad--egg',null,null,'nonveg',array['spicy']::text[],79),
('in-kadai--prawn',null,null,'nonveg','{}'::text[],80),
('in-kadai--mutton',null,null,'nonveg','{}'::text[],81),
('in-kadai--chicken',null,null,'nonveg','{}'::text[],82),
('in-hyderabadi--prawn',null,null,'nonveg','{}'::text[],83),
('in-hyderabadi--mutton',null,null,'nonveg','{}'::text[],84),
('in-hyderabadi--chicken',null,null,'nonveg','{}'::text[],85),
('in-andhra--crab-shelless-',null,null,'nonveg',array['spicy']::text[],86),
('in-andhra--prawn',null,null,'nonveg',array['spicy']::text[],87),
('in-andhra--squid',null,null,'nonveg',array['spicy']::text[],88),
('in-andhra--mutton',null,null,'nonveg',array['spicy']::text[],89),
('in-andhra--chicken',null,null,'nonveg',array['spicy']::text[],90),
('in-andhra--egg',null,null,'nonveg',array['spicy']::text[],91),
('in-pepper-masala--crab-shelless-',null,null,'nonveg','{}'::text[],92),
('in-pepper-masala--prawn',null,null,'nonveg','{}'::text[],93),
('in-pepper-masala--fish',null,null,'nonveg','{}'::text[],94),
('in-pepper-masala--squid',null,null,'nonveg','{}'::text[],95),
('in-pepper-masala--mutton',null,null,'nonveg','{}'::text[],96),
('in-pepper-masala--chicken',null,null,'nonveg','{}'::text[],97),
('in-pepper-masala--egg',null,null,'nonveg','{}'::text[],98),
('in-masala--crab-shelless-',null,null,'nonveg','{}'::text[],99),
('in-masala--squid',null,null,'nonveg','{}'::text[],100),
('in-masala--mutton',null,null,'nonveg','{}'::text[],101),
('in-masala--chicken',null,null,'nonveg','{}'::text[],102),
('in-masala--egg',null,null,'nonveg','{}'::text[],103),
('in-pandia-s-spl--mutton',null,null,'nonveg',array['signature']::text[],104),
('in-pandia-s-spl--chicken',null,null,'nonveg',array['signature']::text[],105),
('in-shahi-korma--mutton',null,null,'nonveg','{}'::text[],106),
('in-shahi-korma--chicken',null,null,'nonveg','{}'::text[],107),
('in-mughalai--mutton',null,null,'nonveg','{}'::text[],108),
('in-mughalai--chicken',null,null,'nonveg','{}'::text[],109),
('in-mughalai--egg',null,null,'nonveg','{}'::text[],110),
('butter-chicken-masala--with-bone',null,null,'nonveg','{}'::text[],111),
('butter-chicken-masala--boneless',null,null,'nonveg','{}'::text[],112),
('chicken-tikka-masala',null,null,'nonveg','{}'::text[],113),
('mutton-kheema-masala',null,null,'nonveg','{}'::text[],114),
('chettinad-omelette-curry',null,null,'egg','{}'::text[],115),
('cn-chilly--crab-shelless-',null,null,'nonveg',array['spicy']::text[],116),
('cn-chilly--prawn',null,null,'nonveg',array['spicy']::text[],117),
('cn-chilly--fish',null,null,'nonveg',array['spicy']::text[],118),
('cn-chilly--squid',null,null,'nonveg',array['spicy']::text[],119),
('cn-chilly--mutton',null,null,'nonveg',array['spicy']::text[],120),
('cn-chilly--chicken',null,null,'nonveg',array['spicy']::text[],121),
('cn-chilly--egg',null,null,'nonveg',array['spicy']::text[],122),
('cn-manchurian--prawn',null,null,'nonveg','{}'::text[],123),
('cn-manchurian--fish',null,null,'nonveg','{}'::text[],124),
('cn-manchurian--squid',null,null,'nonveg','{}'::text[],125),
('cn-manchurian--chicken',null,null,'nonveg','{}'::text[],126),
('cn-manchurian--egg',null,null,'nonveg','{}'::text[],127),
('cn-dragon--fish',null,null,'nonveg','{}'::text[],128),
('cn-dragon--chicken',null,null,'nonveg','{}'::text[],129),
('cn-salt-pepper--crab-shelless-',null,null,'nonveg','{}'::text[],130),
('cn-salt-pepper--prawn',null,null,'nonveg','{}'::text[],131),
('cn-salt-pepper--fish',null,null,'nonveg','{}'::text[],132),
('cn-salt-pepper--squid',null,null,'nonveg','{}'::text[],133),
('cn-salt-pepper--chicken',null,null,'nonveg','{}'::text[],134),
('cn-golden-fried--prawn',null,null,'nonveg','{}'::text[],135),
('cn-golden-fried--mutton',null,null,'nonveg','{}'::text[],136),
('cn-golden-fried--chicken',null,null,'nonveg','{}'::text[],137),
('cn-butter-fried--prawn',null,null,'nonveg','{}'::text[],138),
('cn-butter-fried--mutton',null,null,'nonveg','{}'::text[],139),
('cn-butter-fried--chicken',null,null,'nonveg','{}'::text[],140),
('cn-honey-chilly--fish',null,null,'nonveg','{}'::text[],141),
('cn-honey-chilly--chicken',null,null,'nonveg','{}'::text[],142),
('cn-honey-chilly--egg',null,null,'nonveg','{}'::text[],143),
('cn-hot-garlic--prawn',null,null,'nonveg',array['special']::text[],144),
('cn-hot-garlic--fish',null,null,'nonveg',array['special']::text[],145),
('cn-hot-garlic--chicken',null,null,'nonveg',array['special']::text[],146),
('cn-hot-garlic--egg',null,null,'nonveg',array['special']::text[],147),
('parotta',null,'Soft, flaky layers. Ask for extra salna.','veg',array['bestseller']::text[],148),
('ghee-parotta',null,'Crisped in pure ghee.','veg','{}'::text[],149),
('chicken-kothu',null,'Parotta chopped on the tawa with chicken, egg and salna.','nonveg','{}'::text[],150),
('egg-kothu',null,null,'egg','{}'::text[],151),
('chapathi',null,null,'veg','{}'::text[],152),
('dosai',null,'Thin, crisp, with chutney and sambar.','veg','{}'::text[],153),
('egg-dosai',null,null,'egg','{}'::text[],154),
('kalakki','கலக்கி','Half-set egg swirled with salna. Eat it hot.','egg','{}'::text[],155),
('omelette',null,null,'egg','{}'::text[],156),
('chettinad-chicken-soup',null,'Peppery and a little fiery. Order it first.','nonveg',array['signature','spicy']::text[],157),
('mutton-bone-soup',null,null,'nonveg','{}'::text[],158),
('chicken-fried-rice',null,null,'nonveg','{}'::text[],159),
('chicken-noodles',null,null,'nonveg','{}'::text[],160),
('veg-fried-rice',null,null,'veg','{}'::text[],161),
('shawarma-roll',null,null,'nonveg','{}'::text[],162),
('shawarma-plate',null,null,'nonveg','{}'::text[],163),
('vanilla-ice-cream',null,null,'veg','{}'::text[],164),
('strawberry-ice-cream',null,null,'veg','{}'::text[],165),
('chocolate-ice-cream',null,null,'veg','{}'::text[],166),
('pista-ice-cream',null,null,'veg','{}'::text[],167),
('butterscotch-ice-cream',null,null,'veg','{}'::text[],168)
) as v(id, tamil, descr, diet, tags, sort)
where m.id = v.id;

-- ===================================================================== internal: name → id ("Mutton Chukka Fry" → "mutton-chukka-fry")
create or replace function public._slug(p text) returns text
language sql immutable set search_path = '' as $$
  select trim(both '-' from regexp_replace(lower(coalesce(p, '')), '[^a-z0-9]+', '-', 'g'));
$$;

-- ===================================================================== owner: add a dish (one price, or Full + Half)
create or replace function public.add_dish(
  p_name text, p_category text, p_price numeric, p_half numeric default null,
  p_diet text default 'nonveg', p_tamil text default null, p_desc text default null, p_tags text[] default '{}'
) returns text
language plpgsql security definer set search_path = '' as $$
declare v_base text; v_n int := 1; v_sort int; v_name text := trim(coalesce(p_name, ''));
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  if char_length(v_name) not between 2 and 80 then raise exception 'bad_name'; end if;
  if not exists (select 1 from public.menu_categories where id = p_category) then raise exception 'bad_category'; end if;
  if p_price is null or p_price < 0 or p_price > 100000 or p_price <> round(p_price) then raise exception 'bad_price'; end if;
  if p_half is not null and (p_half < 0 or p_half > 100000 or p_half <> round(p_half)) then raise exception 'bad_price'; end if;
  if coalesce(p_diet, '') not in ('veg', 'egg', 'nonveg') then raise exception 'bad_diet'; end if;
  if exists (select 1 from public.menu_items where lower(name) in (lower(v_name), lower(v_name) || ' (full)') and deleted_at is null) then
    raise exception 'duplicate_dish';
  end if;
  v_base := public._slug(v_name);
  if v_base = '' then raise exception 'bad_name'; end if;
  -- a free id: mutton-chukka, mutton-chukka-2, …
  while exists (select 1 from public.menu_items where id = v_base or id like v_base || '--%') loop
    v_n := v_n + 1;
    v_base := public._slug(v_name) || '-' || v_n;
  end loop;
  select coalesce(max(sort), 0) + 1 into v_sort from public.menu_items;
  if p_half is null then
    insert into public.menu_items (id, name, category, price, available, tamil, description, diet, tags, sort)
    values (v_base, v_name, p_category, p_price, true, nullif(trim(p_tamil), ''), nullif(trim(p_desc), ''), p_diet, coalesce(p_tags, '{}'), v_sort);
  else
    insert into public.menu_items (id, name, category, price, available, tamil, description, diet, tags, sort) values
      (v_base || '--full', v_name || ' (Full)', p_category, p_price, true, nullif(trim(p_tamil), ''), nullif(trim(p_desc), ''), p_diet, coalesce(p_tags, '{}'), v_sort),
      (v_base || '--half', v_name || ' (Half)', p_category, p_half, true, nullif(trim(p_tamil), ''), nullif(trim(p_desc), ''), p_diet, coalesce(p_tags, '{}'), v_sort);
  end if;
  return v_base;
end $$;

-- ===================================================================== owner: edit a dish's details (all its Full/Half rows together)
create or replace function public.update_dish(
  p_base text, p_name text, p_category text, p_diet text, p_tamil text default null, p_desc text default null, p_tags text[] default '{}'
) returns void
language plpgsql security definer set search_path = '' as $$
declare v_name text := trim(coalesce(p_name, ''));
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  if char_length(v_name) not between 2 and 80 then raise exception 'bad_name'; end if;
  if not exists (select 1 from public.menu_categories where id = p_category) then raise exception 'bad_category'; end if;
  if coalesce(p_diet, '') not in ('veg', 'egg', 'nonveg') then raise exception 'bad_diet'; end if;
  update public.menu_items set
    -- a Full / Half row keeps its "(Full)" / "(Half)" ending
    -- a dish with choices (Full / Half, Chicken / Mutton...) keeps each row's "(choice)" ending
    name = v_name || case when id like '%--%' then coalesce(substring(name from ' \((?:[^()]|\([^()]*\))*\)$'), '') else '' end,
    category = p_category, diet = p_diet,
    tamil = nullif(trim(p_tamil), ''), description = nullif(trim(p_desc), ''), tags = coalesce(p_tags, '{}'),
    updated_at = now()
  where id = p_base or id like p_base || '--%';
  if not found then raise exception 'unknown_item'; end if;
end $$;

-- ===================================================================== owner: remove (to Recently removed) and restore
create or replace function public.remove_dish(p_base text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  update public.menu_items set deleted_at = now(), available = false, updated_at = now()
  where (id = p_base or id like p_base || '--%') and deleted_at is null;
  if not found then raise exception 'unknown_item'; end if;
end $$;

create or replace function public.restore_dish(p_base text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  update public.menu_items set deleted_at = null, available = true, updated_at = now()
  where (id = p_base or id like p_base || '--%') and deleted_at is not null;
  if not found then raise exception 'unknown_item'; end if;
end $$;

-- ===================================================================== owner: add a category
create or replace function public.add_category(p_name text, p_blurb text default null) returns text
language plpgsql security definer set search_path = '' as $$
declare v_id text := public._slug(p_name);
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  if char_length(trim(coalesce(p_name, ''))) not between 2 and 60 or char_length(v_id) < 2 then raise exception 'bad_name'; end if;
  if exists (select 1 from public.menu_categories where id = v_id) then raise exception 'duplicate_category'; end if;
  insert into public.menu_categories (id, name, blurb, sort)
  values (v_id, trim(p_name), nullif(trim(p_blurb), ''), (select coalesce(max(sort), 0) + 1 from public.menu_categories));
  return v_id;
end $$;

revoke execute on function
  public.add_dish(text, text, numeric, numeric, text, text, text, text[]),
  public.update_dish(text, text, text, text, text, text, text[]),
  public.remove_dish(text), public.restore_dish(text), public.add_category(text, text)
from public, anon;
grant execute on function
  public.add_dish(text, text, numeric, numeric, text, text, text, text[]),
  public.update_dish(text, text, text, text, text, text, text[]),
  public.remove_dish(text), public.restore_dish(text), public.add_category(text, text)
to authenticated;
