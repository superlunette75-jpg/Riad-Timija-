-- =====================================================================
-- Riad Timija — Schéma d'exploitation (PostgreSQL / Supabase)
-- Migration multi-appareils du système SQLite local.
-- À exécuter dans Supabase > SQL Editor.
-- =====================================================================

-- --- Paramètres (entité émettrice, règles fiscales) -------------------
create table if not exists params (
  k text primary key,
  v text
);

-- --- Réservations -----------------------------------------------------
create table if not exists reservations (
  id           bigint generated always as identity primary key,
  guest        text not null,
  channel      text,                       -- Airbnb / Booking / Direct / Autre
  arrival      date,
  departure    date,
  pax          int  default 1,
  amount       numeric(12,2) default 0,    -- revenus hébergement (MAD)
  tourist_tax  numeric(12,2) default 0,    -- taxe de séjour (nuits * pax * tarif)
  status       text default 'Confirmée',   -- Confirmée / En cours / Terminée / Annulée
  notes        text,
  created_at   timestamptz default now()
);
create index if not exists idx_res_arrival on reservations(arrival);

-- --- Dépenses ---------------------------------------------------------
create table if not exists expenses (
  id          bigint generated always as identity primary key,
  edate       date not null default current_date,
  category    text,
  description text,
  amount      numeric(12,2) default 0,
  created_at  timestamptz default now()
);
create index if not exists idx_exp_date on expenses(edate);

-- --- Ménage & maintenance --------------------------------------------
create table if not exists interventions (
  id          bigint generated always as identity primary key,
  idate       date not null default current_date,
  kind        text,                         -- Ménage / Maintenance
  description text,
  provider    text,
  cost        numeric(12,2) default 0,
  status      text default 'Fait',          -- Fait / Planifié
  created_at  timestamptz default now()
);
create index if not exists idx_int_date on interventions(idate);

-- --- Factures d'honoraires émises (numérotation séquentielle) ---------
create table if not exists invoices (
  id            bigint generated always as identity primary key,
  number        text unique not null,       -- ex : TIMIJA-2026-0001
  period_start  date,
  period_end    date,
  revenue       numeric(12,2),
  expenses      numeric(12,2),
  tourist_tax   numeric(12,2),
  commission    numeric(12,2),
  tva           numeric(12,2),
  ttc           numeric(12,2),
  created_at    timestamptz default now()
);

-- =====================================================================
-- Vue : relevé consolidé par mois (revenus, taxe, charges, net)
-- Rattachement d'une réservation au mois de sa date d'arrivée.
-- =====================================================================
create or replace view v_releve_mensuel as
with rev as (
  select to_char(arrival,'YYYY-MM') as mois,
         sum(amount)      as revenus,
         sum(tourist_tax) as taxe_sejour
  from reservations where status <> 'Annulée' group by 1
),
dep as (
  select to_char(edate,'YYYY-MM') as mois, sum(amount) as depenses
  from expenses group by 1
),
itv as (
  select to_char(idate,'YYYY-MM') as mois, sum(cost) as maintenance
  from interventions group by 1
)
select
  coalesce(rev.mois,dep.mois,itv.mois)              as mois,
  coalesce(rev.revenus,0)                           as revenus,
  coalesce(rev.taxe_sejour,0)                       as taxe_sejour,
  coalesce(dep.depenses,0) + coalesce(itv.maintenance,0) as charges,
  coalesce(rev.revenus,0)
    - coalesce(dep.depenses,0) - coalesce(itv.maintenance,0) as net_avant_honoraires
from rev
full join dep on dep.mois = rev.mois
full join itv on itv.mois = coalesce(rev.mois,dep.mois)
order by mois desc;

-- =====================================================================
-- Fonction : prochain numéro de facture pour l'année courante
-- =====================================================================
create or replace function next_invoice_number(prefix text)
returns text language plpgsql as $$
declare yr text := to_char(now(),'YYYY'); n int;
begin
  select count(*) into n from invoices where number like prefix||'-'||yr||'-%';
  return prefix||'-'||yr||'-'||lpad((n+1)::text,4,'0');
end $$;

-- =====================================================================
-- Sécurité (Supabase) : activer RLS et restreindre aux utilisateurs
-- authentifiés. Adapter selon vos rôles (gestionnaire, personnel).
-- =====================================================================
alter table reservations  enable row level security;
alter table expenses      enable row level security;
alter table interventions enable row level security;
alter table invoices      enable row level security;
alter table params        enable row level security;

-- Exemple de politique : lecture/écriture pour tout utilisateur connecté.
-- Remplacer par une logique par rôle si du personnel est ajouté.
create policy "authenticated all" on reservations  for all to authenticated using (true) with check (true);
create policy "authenticated all" on expenses      for all to authenticated using (true) with check (true);
create policy "authenticated all" on interventions for all to authenticated using (true) with check (true);
create policy "authenticated all" on invoices      for all to authenticated using (true) with check (true);
create policy "authenticated all" on params        for all to authenticated using (true) with check (true);
