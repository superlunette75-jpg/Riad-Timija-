-- =====================================================================
-- Riad Timija — Migration Lodgify (Supabase > SQL Editor)
-- Additive et ré-exécutable. À lancer APRÈS migration-v2.sql.
-- =====================================================================

-- Identifiant de la réservation chez la source externe (Lodgify).
-- Sert de garde-fou anti-doublon lors des synchronisations répétées.
alter table reservations add column if not exists ext_source text;
alter table reservations add column if not exists ext_id text;

-- Une même réservation externe ne peut être insérée qu'une fois.
create unique index if not exists uniq_reservations_ext
  on reservations(ext_source, ext_id)
  where ext_id is not null;

notify pgrst, 'reload schema';
