-- Excepción: la J2 (8 nov 2026) cierra alineaciones el miércoles 4 nov a las 11:59 pm (CDMX).
-- Aplicado en producción el 3 nov 2026.
create or replace function public.lineup_deadline(d date)
 returns timestamptz language sql immutable set search_path to '' as $function$
  select case when d is null then null
    when d = date '2026-11-08' then timestamp '2026-11-05 00:00:00' at time zone 'America/Mexico_City'
    else
    (((d - (case when ((extract(isodow from d)::int - 2 + 7) % 7) = 0 then 7
                 else ((extract(isodow from d)::int - 2 + 7) % 7) end)) + 1)::timestamp
      at time zone 'America/Mexico_City')
  end;
$function$;
-- Recorre 24 h los avisos de alineación de la J2 que aún no salen.
update public.notifications set send_at = send_at + interval '24 hours'
 where jornada_id = '163768b1-849e-4ceb-b29e-77468aa201bb' and kind in ('lineup_reminder', 'lineup_deadline') and sent_at is null;
