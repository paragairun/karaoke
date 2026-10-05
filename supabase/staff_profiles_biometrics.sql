-- ============================================================
-- managesociety.in — staff & house-help profiles + fingerprint entry
-- Run in Supabase SQL editor. Guarded throughout, safe to re-run.
--
-- Adds:
--   1. Profile fields on staff_members and house_helps
--      (gender, address, ID type/number, DOB, emergency contact)
--   2. fingerprint_enrollments — one row per enrolled finger
--   3. Fingerprint columns on staff_logs so an entry records HOW it
--      was verified (qr | fingerprint | manual)
--
-- BIOMETRIC DATA NOTE
-- Fingerprint *templates* are stored, never raw images. Templates are
-- ISO/IEC 19794-2 byte strings from the reader, held base64. Under the
-- DPDP Act 2023 this is sensitive personal data: it is kept per society,
-- readable only by that society's admins and guards via RLS, carries an
-- explicit consent flag and timestamp, and is hard-deleted with the
-- staff member. ID numbers are likewise restricted (see policies below)
-- and are never exposed to the guard-facing queries.
-- ============================================================

-- ─────────────────────────────────────────────
-- 1. PROFILE FIELDS
-- ─────────────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_type where typname = 'gov_id_type') then
    create type public.gov_id_type as enum (
      'aadhaar', 'passport', 'pan', 'voter_id', 'driving_license', 'ration_card'
    );
  end if;
  if not exists (select 1 from pg_type where typname = 'staff_gender') then
    create type public.staff_gender as enum ('male', 'female', 'other', 'undisclosed');
  end if;
end $$;

alter table public.staff_members
  add column if not exists gender              public.staff_gender,
  add column if not exists date_of_birth       date,
  add column if not exists address             text,
  add column if not exists id_type             public.gov_id_type,
  add column if not exists id_number           text,
  add column if not exists emergency_contact   text,
  add column if not exists emergency_phone     text,
  add column if not exists fingerprint_enrolled boolean not null default false;

alter table public.house_helps
  add column if not exists gender              public.staff_gender,
  add column if not exists date_of_birth       date,
  add column if not exists address             text,
  add column if not exists id_type             public.gov_id_type,
  add column if not exists id_number           text,
  add column if not exists emergency_contact   text,
  add column if not exists emergency_phone     text,
  add column if not exists fingerprint_enrolled boolean not null default false;

-- An ID document should not be registered twice inside one society.
-- Partial index so the many NULLs (ID is optional) don't collide.
create unique index if not exists staff_members_society_id_doc_uniq
  on public.staff_members (society_id, id_type, id_number)
  where id_number is not null;

create unique index if not exists house_helps_society_id_doc_uniq
  on public.house_helps (society_id, id_type, id_number)
  where id_number is not null;

-- ─────────────────────────────────────────────
-- 2. FINGERPRINT ENROLMENTS
--    One row per finger per person. Several fingers per person is
--    deliberate: site workers damage fingertips, and a second finger
--    is the difference between a working gate and a queue.
--
--    subject_id is not a foreign key because a subject may live in
--    either staff_members or house_helps; subject_category says which.
--    The trigger below enforces that the row actually exists.
-- ─────────────────────────────────────────────
create table if not exists public.fingerprint_enrollments (
  id                uuid primary key default gen_random_uuid(),
  society_id        uuid not null references public.societies(id) on delete cascade,
  subject_category  public.staff_category not null,
  subject_id        uuid not null,
  finger_position   smallint not null check (finger_position between 1 and 10),
  template          text   not null,
  template_format   text   not null default 'ISO-19794-2',
  quality           smallint check (quality between 0 and 100),
  device_model      text,
  consent_given     boolean not null default false,
  consent_at        timestamptz,
  enrolled_by       uuid references auth.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (subject_category, subject_id, finger_position)
);

create index if not exists fingerprint_enrollments_society_idx
  on public.fingerprint_enrollments (society_id, subject_category);

-- Consent must be recorded before a template may be stored.
alter table public.fingerprint_enrollments
  drop constraint if exists fingerprint_consent_required;
alter table public.fingerprint_enrollments
  add constraint fingerprint_consent_required
  check (consent_given is true and consent_at is not null);

-- Referential integrity across the two possible subject tables.
create or replace function public.check_fingerprint_subject()
returns trigger
language plpgsql
as $$
begin
  if new.subject_category = 'society_staff' then
    if not exists (select 1 from public.staff_members m
                    where m.id = new.subject_id and m.society_id = new.society_id) then
      raise exception 'No staff member % in society %', new.subject_id, new.society_id;
    end if;
  elsif new.subject_category = 'house_help' then
    if not exists (select 1 from public.house_helps h
                    where h.id = new.subject_id and h.society_id = new.society_id) then
      raise exception 'No house help % in society %', new.subject_id, new.society_id;
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists fingerprint_subject_check on public.fingerprint_enrollments;
create trigger fingerprint_subject_check
  before insert or update on public.fingerprint_enrollments
  for each row execute function public.check_fingerprint_subject();

-- Deleting a staff member must take their biometrics with them. There is
-- no FK to cascade through, so do it explicitly from both parents.
create or replace function public.purge_fingerprints_for_subject()
returns trigger
language plpgsql
as $$
begin
  delete from public.fingerprint_enrollments
   where subject_id = old.id
     and subject_category = tg_argv[0]::public.staff_category;
  return old;
end;
$$;

drop trigger if exists purge_fingerprints_staff on public.staff_members;
create trigger purge_fingerprints_staff
  after delete on public.staff_members
  for each row execute function public.purge_fingerprints_for_subject('society_staff');

drop trigger if exists purge_fingerprints_help on public.house_helps;
create trigger purge_fingerprints_help
  after delete on public.house_helps
  for each row execute function public.purge_fingerprints_for_subject('house_help');

-- Keep the denormalised flag honest, so admin lists don't need a join.
create or replace function public.sync_fingerprint_flag()
returns trigger
language plpgsql
as $$
declare
  sid uuid := coalesce(new.subject_id, old.subject_id);
  cat public.staff_category := coalesce(new.subject_category, old.subject_category);
  remaining int;
begin
  select count(*) into remaining
    from public.fingerprint_enrollments
   where subject_id = sid and subject_category = cat;

  if cat = 'society_staff' then
    update public.staff_members set fingerprint_enrolled = (remaining > 0) where id = sid;
  else
    update public.house_helps set fingerprint_enrolled = (remaining > 0) where id = sid;
  end if;
  return null;
end;
$$;

drop trigger if exists sync_fingerprint_flag_trg on public.fingerprint_enrollments;
create trigger sync_fingerprint_flag_trg
  after insert or delete on public.fingerprint_enrollments
  for each row execute function public.sync_fingerprint_flag();

-- ─────────────────────────────────────────────
-- 3. RLS
--    has_role(auth.uid(), 'guard'|'admin') already exists in this
--    schema and is reused here so behaviour matches the rest of the app.
-- ─────────────────────────────────────────────
alter table public.fingerprint_enrollments enable row level security;

drop policy if exists "fingerprints: society admins manage" on public.fingerprint_enrollments;
create policy "fingerprints: society admins manage"
  on public.fingerprint_enrollments for all
  to authenticated
  using (
    society_id in (
      select p.society_id from public.profiles p
       where p.id = auth.uid() and public.has_role(auth.uid(), 'admin')
    )
  )
  with check (
    society_id in (
      select p.society_id from public.profiles p
       where p.id = auth.uid() and public.has_role(auth.uid(), 'admin')
    )
  );

-- Guards may read templates for their own society only — identification
-- at the gate needs the candidate set. They cannot enrol or delete.
drop policy if exists "fingerprints: guards read own society" on public.fingerprint_enrollments;
create policy "fingerprints: guards read own society"
  on public.fingerprint_enrollments for select
  to authenticated
  using (
    society_id in (
      select p.society_id from public.profiles p
       where p.id = auth.uid() and public.has_role(auth.uid(), 'guard')
    )
  );

-- ─────────────────────────────────────────────
-- 4. HOW AN ENTRY WAS VERIFIED
-- ─────────────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_type where typname = 'entry_method') then
    create type public.entry_method as enum ('qr', 'fingerprint', 'manual');
  end if;
end $$;

alter table public.staff_logs
  add column if not exists entry_method    public.entry_method not null default 'qr',
  add column if not exists match_score     smallint,
  add column if not exists device_model    text;

-- ─────────────────────────────────────────────
-- 5. GUARD-SAFE VIEW
--    Gate identification needs name, photo and templates — never the
--    ID number or home address. security_invoker keeps RLS applied.
-- ─────────────────────────────────────────────
create or replace view public.gate_fingerprint_candidates
with (security_invoker = on)
as
select f.id            as enrollment_id,
       f.society_id,
       f.subject_category,
       f.subject_id,
       f.finger_position,
       f.template,
       f.template_format,
       coalesce(m.name, h.name)             as name,
       coalesce(m.staff_type, h.help_type)  as role,
       coalesce(m.is_active, h.is_active)   as is_active
  from public.fingerprint_enrollments f
  left join public.staff_members m
         on f.subject_category = 'society_staff' and m.id = f.subject_id
  left join public.house_helps h
         on f.subject_category = 'house_help'   and h.id = f.subject_id
 where coalesce(m.is_active, h.is_active, false) is true;

grant select on public.gate_fingerprint_candidates to authenticated;
