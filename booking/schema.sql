-- HARD GYM PT BOOKING APP / Supabase SQL schema
-- Run in a NEW Supabase project under SQL Editor, not in a public website page.
-- Client reads/writes are restricted with row-level security and trusted RPCs.
-- Dates stored in UTC; client UI displays Australia/Sydney.
begin;

create table if not exists public.hg_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  email text not null,
  phone text not null default '',
  role text not null default 'client' check (role in ('client','admin')),
  created_at timestamptz not null default now()
);

create or replace function public.hg_create_profile()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  insert into public.hg_profiles (id, display_name, email, role)
  values (
    new.id,
    left(coalesce(nullif(trim(new.raw_user_meta_data->>'full_name'),''), split_part(new.email,'@',1)),120),
    new.email,
    'client'
  ) on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists hg_after_auth_signup on auth.users;
create trigger hg_after_auth_signup
after insert on auth.users
for each row execute function public.hg_create_profile();

create or replace function public.hg_is_admin()
returns boolean language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.hg_profiles p
    where p.id = auth.uid() and p.role = 'admin'
  );
$$;

create table if not exists public.hg_settings (
  id integer primary key default 1 check (id=1),
  cancellation_cutoff_hours integer not null default 12 check (cancellation_cutoff_hours between 0 and 168),
  max_open_bookings integer not null default 8 check (max_open_bookings between 1 and 100),
  bookable_days_ahead integer not null default 42 check (bookable_days_ahead between 1 and 365)
);
insert into public.hg_settings (id) values (1) on conflict (id) do nothing;

create table if not exists public.hg_slots (
  id bigint generated always as identity primary key,
  service text not null check (service in ('one_on_one','partner','small_group')),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  coach text not null default 'HARD GYM' check (char_length(coach) between 1 and 80),
  capacity integer not null default 1 check (capacity between 1 and 12),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint hg_slot_valid_time check (ends_at > starts_at and ends_at <= starts_at + interval '3 hours'),
  constraint hg_private_session_capacity check (service='small_group' or capacity=1)
);
create index if not exists hg_slots_starts_at_idx on public.hg_slots (starts_at);

create table if not exists public.hg_bookings (
  id uuid primary key default gen_random_uuid(),
  slot_id bigint not null references public.hg_slots(id) on delete restrict,
  user_id uuid not null references public.hg_profiles(id) on delete cascade,
  status text not null default 'confirmed' check (status in ('confirmed','cancelled')),
  partner_name text,
  created_at timestamptz not null default now(),
  cancelled_at timestamptz
);
create index if not exists hg_bookings_slot_status_idx on public.hg_bookings(slot_id,status);
create index if not exists hg_bookings_user_status_idx on public.hg_bookings(user_id,status);
create unique index if not exists hg_no_duplicate_confirmed_booking
  on public.hg_bookings(slot_id,user_id) where status='confirmed';

create table if not exists public.hg_booking_events (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.hg_bookings(id) on delete cascade,
  event_type text not null check (event_type in ('booked','cancelled')),
  created_at timestamptz not null default now(),
  owner_sent_at timestamptz,
  client_sent_at timestamptz,
  delivery_error text
);
create index if not exists hg_booking_events_created_idx on public.hg_booking_events (created_at);

-- Admins cannot accidentally schedule overlapping sessions for the same coach.
create or replace function public.hg_validate_slot()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.is_active then
    perform pg_advisory_xact_lock(hashtext(lower(new.coach)));
    if exists (
      select 1 from public.hg_slots s
      where s.is_active and lower(s.coach)=lower(new.coach)
        and s.id is distinct from new.id
        and tstzrange(s.starts_at,s.ends_at,'[)') && tstzrange(new.starts_at,new.ends_at,'[)')
    ) then
      raise exception 'That coach already has a session during this time.';
    end if;
  end if;
  if tg_op = 'UPDATE' and old.is_active and not new.is_active
    and exists (select 1 from public.hg_bookings b where b.slot_id=old.id and b.status='confirmed')
  then
    raise exception 'This session has clients booked. Cancel those bookings first.';
  end if;
  return new;
end;
$$;
drop trigger if exists hg_validate_slot_trigger on public.hg_slots;
create trigger hg_validate_slot_trigger
before insert or update on public.hg_slots
for each row execute function public.hg_validate_slot();

create or replace function public.hg_queue_booking_event()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op='INSERT' and new.status='confirmed' then
    insert into public.hg_booking_events (booking_id,event_type)
    values (new.id,'booked');
  elsif tg_op='UPDATE' and old.status is distinct from new.status
    and new.status='cancelled' then
    insert into public.hg_booking_events (booking_id,event_type)
    values (new.id,'cancelled');
  end if;
  return new;
end;
$$;
drop trigger if exists hg_booking_event_trigger on public.hg_bookings;
create trigger hg_booking_event_trigger
after insert or update of status on public.hg_bookings
for each row execute function public.hg_queue_booking_event();

-- Live availability: only capacity totals, never other clients' private details.
create or replace function public.hg_available_slots()
returns table (
  slot_id bigint,
  service text,
  starts_at timestamptz,
  ends_at timestamptz,
  coach text,
  capacity integer,
  spots_left integer
)
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Sign in to see sessions.'; end if;
  return query
  select s.id,s.service,s.starts_at,s.ends_at,s.coach,s.capacity,
    greatest(0,s.capacity - count(b.id)::integer) as spots_left
  from public.hg_slots s
  left join public.hg_bookings b on b.slot_id=s.id and b.status='confirmed'
  where s.is_active and s.starts_at>now()
    and s.starts_at <= now() +
      make_interval(days=>(select bookable_days_ahead from public.hg_settings where id=1))
  group by s.id
  order by s.starts_at;
end;
$$;

-- Locks the slot row to guarantee two clients cannot take the last place.
create or replace function public.hg_book_slot(p_slot_id bigint, p_partner_name text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_slot public.hg_slots%rowtype;
  v_booked integer;
  v_upcoming integer;
  v_new_id uuid;
begin
  if v_user is null then raise exception 'You must sign in before booking.'; end if;
  select * into v_slot from public.hg_slots s where s.id=p_slot_id for update;
  if not found or not v_slot.is_active then raise exception 'This session is no longer available.'; end if;
  if v_slot.starts_at<=now() then raise exception 'This session has already started.'; end if;
  if v_slot.starts_at > now()+make_interval(days=>(select bookable_days_ahead from public.hg_settings where id=1)) then
    raise exception 'This session is outside the booking window.';
  end if;
  if exists (select 1 from public.hg_bookings b where b.slot_id=p_slot_id and b.user_id=v_user and b.status='confirmed') then
    raise exception 'You have already booked this session.';
  end if;
  select count(*)::integer into v_upcoming
  from public.hg_bookings b join public.hg_slots s on s.id=b.slot_id
  where b.user_id=v_user and b.status='confirmed' and s.starts_at>now();
  if v_upcoming >= (select max_open_bookings from public.hg_settings where id=1) then
    raise exception 'You have reached the maximum number of upcoming bookings.';
  end if;
  select count(*)::integer into v_booked from public.hg_bookings
    where slot_id=p_slot_id and status='confirmed';
  if v_booked >= v_slot.capacity then raise exception 'Sorry, this session has just filled up.'; end if;
  insert into public.hg_bookings (slot_id,user_id,partner_name)
  values (p_slot_id,v_user,
    case when v_slot.service='partner' then nullif(left(trim(coalesce(p_partner_name,'')),120),'') else null end)
  returning id into v_new_id;
  return v_new_id;
end;
$$;

create or replace function public.hg_cancel_booking(p_booking_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_booking public.hg_bookings%rowtype;
  v_start timestamptz;
  v_cutoff integer;
  v_admin boolean;
begin
  if auth.uid() is null then raise exception 'Please sign in first.'; end if;
  select * into v_booking from public.hg_bookings where id=p_booking_id for update;
  if not found then raise exception 'Booking not found.'; end if;
  v_admin := public.hg_is_admin();
  if v_booking.user_id is distinct from auth.uid() and not v_admin then
    raise exception 'You cannot cancel somebody else''s booking.';
  end if;
  if v_booking.status='cancelled' then return false; end if;
  select starts_at into v_start from public.hg_slots where id=v_booking.slot_id;
  if v_start<=now() then raise exception 'Past bookings cannot be cancelled here.'; end if;
  select cancellation_cutoff_hours into v_cutoff from public.hg_settings where id=1;
  if not v_admin and now()>v_start-make_interval(hours=>v_cutoff) then
    raise exception 'This booking is inside the cancellation cutoff. Please contact HARD GYM directly.';
  end if;
  update public.hg_bookings set status='cancelled',cancelled_at=now() where id=p_booking_id;
  return true;
end;
$$;

-- RLS: a client only sees their own personal details/bookings.
alter table public.hg_profiles enable row level security;
alter table public.hg_settings enable row level security;
alter table public.hg_slots enable row level security;
alter table public.hg_bookings enable row level security;
alter table public.hg_booking_events enable row level security;

create policy "HG profile self or admin reads" on public.hg_profiles for select
  to authenticated using (id=auth.uid() or public.hg_is_admin());
create policy "HG profile self updates" on public.hg_profiles for update
  to authenticated using (id=auth.uid()) with check (id=auth.uid());
create policy "HG settings readable by members" on public.hg_settings for select
  to authenticated using (true);
create policy "HG settings only admin updates" on public.hg_settings for update
  to authenticated using (public.hg_is_admin()) with check (public.hg_is_admin());
create policy "HG slots visible to members" on public.hg_slots for select
  to authenticated using (true);
create policy "HG admin creates slots" on public.hg_slots for insert
  to authenticated with check (public.hg_is_admin());
create policy "HG admin updates slots" on public.hg_slots for update
  to authenticated using (public.hg_is_admin()) with check (public.hg_is_admin());
create policy "HG admin deletes slots" on public.hg_slots for delete
  to authenticated using (public.hg_is_admin());
create policy "HG clients see own bookings and admin sees all" on public.hg_bookings for select
  to authenticated using (user_id=auth.uid() or public.hg_is_admin());
create policy "HG only admin reads notification status" on public.hg_booking_events for select
  to authenticated using (public.hg_is_admin());

-- Privileges in addition to RLS; do not allow clients to set themselves as admin.
revoke all on public.hg_profiles,public.hg_settings,public.hg_slots,public.hg_bookings,public.hg_booking_events from anon,authenticated;
grant select on public.hg_profiles,public.hg_settings,public.hg_slots,public.hg_bookings to authenticated;
grant update (display_name,phone) on public.hg_profiles to authenticated;
grant update (cancellation_cutoff_hours,max_open_bookings,bookable_days_ahead) on public.hg_settings to authenticated;
grant insert,update,delete on public.hg_slots to authenticated;
grant usage,select on sequence public.hg_slots_id_seq to authenticated;
grant select on public.hg_booking_events to authenticated;

revoke all on function public.hg_is_admin() from public;
revoke all on function public.hg_available_slots() from public;
revoke all on function public.hg_book_slot(bigint,text) from public;
revoke all on function public.hg_cancel_booking(uuid) from public;
grant execute on function public.hg_is_admin() to authenticated;
grant execute on function public.hg_available_slots() to authenticated;
grant execute on function public.hg_book_slot(bigint,text) to authenticated;
grant execute on function public.hg_cancel_booking(uuid) to authenticated;
commit;

-- IMPORTANT: AFTER owner account signs up and verifies their email,
-- run this SQL MANUALLY in Supabase SQL Editor, replacing the address:
-- update public.hg_profiles set role='admin' where email='YOUR-ADMIN-EMAIL';

-- IMPORTANT: Add a Supabase Database Webhook for INSERT on
-- public.hg_booking_events (the Edge Function path is below), so confirmed
-- bookings and cancellations send owner/client emails automatically.
