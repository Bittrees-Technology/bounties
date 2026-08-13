-- Let profiles combine the full standard taxonomy with several custom values.
create or replace function public.app_profile_selections_valid(p_values text[])
returns boolean
language sql
immutable
parallel safe
set search_path = public
as $$
  select cardinality(coalesce(p_values, '{}'::text[])) <= 16
    and not exists (
      select 1
      from unnest(coalesce(p_values, '{}'::text[])) value
      where value is null
        or value <> btrim(value)
        or char_length(value) not between 1 and 64
        or value ~ '[[:cntrl:]]'
    )
    and cardinality(coalesce(p_values, '{}'::text[])) = (
      select count(distinct lower(value))
      from unnest(coalesce(p_values, '{}'::text[])) value
    );
$$;

comment on function public.app_profile_selections_valid(text[]) is
  'Validates up to sixteen unique, bounded profile work-type or category selections.';
