-- Video "walkout" de las compras del Mercado abierto en el grupo de WhatsApp.
--
-- Al registrarse una compra con el Mercado abierto o en un Fast Track (todo menos el
-- Draft inicial, team_purchases.draft = 'initial', que necesita los mensajes al instante) se crea un
-- walkout_jobs y se le pide a GitHub Actions (workflow walkout.yml del repo del sitio)
-- que grabe el video. El workflow pide los datos y entrega el MP4 a la función
-- "walkout", que lo manda al grupo. El texto es "💸 X compró a Y"; en el Fast Track la
-- app agrega quién sigue de turno con walkout_note(). Con el Mercado abierto ya no hay
-- aviso push; en el Fast Track los avisos push siguen, pero sin la foto en WhatsApp.
-- Si el video no llega en 8 minutos (o GitHub rechazó la petición), se manda el
-- mensaje de antes al grupo (texto + foto, solo WhatsApp) para no perder la compra.
--
-- Secretos (app_secrets): github_token (token de GitHub con permiso Actions: write
-- sobre el repo), github_repo (p. ej. vickrdzdev/torneofifa-pruebas) y walkout_api
-- (https://<proyecto>.supabase.co/functions/v1/walkout).
--
-- Para quitarlo: drop trigger team_purchases_walkout on team_purchases;
-- select cron.unschedule('walkout-fallback'); y volver a crear el aviso en la app.

create table if not exists public.walkout_jobs (
  id uuid primary key default gen_random_uuid(),
  purchase_id uuid not null unique references public.team_purchases(id) on delete cascade,
  season_id uuid,
  token text not null default encode(extensions.gen_random_bytes(16), 'hex'),
  status text not null default 'pending',  -- pending | sent | fallback
  dispatch_id bigint,                      -- petición a GitHub (net._http_response)
  fallback_at timestamptz,                 -- última vez que se pidió el plan B
  note text,                               -- texto extra del video (Fast Track: quién sigue)
  result text,
  created_at timestamptz not null default now(),
  done_at timestamptz
);
alter table public.walkout_jobs enable row level security;  -- sin políticas: solo el servidor

-- Pide a GitHub que grabe el video del job.
create or replace function public.walkout_dispatch(job_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  j public.walkout_jobs;
  tok text := (select value from app_secrets where name = 'github_token');
  repo text := (select value from app_secrets where name = 'github_repo');
  api text := (select value from app_secrets where name = 'walkout_api');
  rid bigint;
begin
  select * into j from walkout_jobs where id = job_id;
  if j.id is null then return; end if;
  if tok is null or repo is null or api is null then
    update walkout_jobs set result = 'sin secretos de GitHub' where id = job_id;
    return;  -- walkout_fallback() manda el mensaje de antes
  end if;
  select net.http_post(
    'https://api.github.com/repos/' || repo || '/actions/workflows/walkout.yml/dispatches',
    jsonb_build_object('ref', 'main', 'inputs', jsonb_build_object('job', j.id::text, 'token', j.token, 'api', api)),
    headers := jsonb_build_object('Authorization', 'Bearer ' || tok, 'Accept', 'application/vnd.github+json',
      'X-GitHub-Api-Version', '2022-11-28', 'User-Agent', 'torneofifa-walkout', 'Content-Type', 'application/json'),
    timeout_milliseconds := 20000) into rid;
  update walkout_jobs set dispatch_id = rid where id = job_id;
end $$;

create or replace function public.walkout_on_purchase() returns trigger
language plpgsql security definer set search_path = public as $$
declare jid uuid;
begin
  if new.draft = 'initial' then return new; end if;  -- Draft inicial: sigue la foto al instante
  insert into walkout_jobs (purchase_id, season_id) values (new.id, new.season_id) returning id into jid;
  perform walkout_dispatch(jid);
  return new;
end $$;

drop trigger if exists team_purchases_walkout on public.team_purchases;
create trigger team_purchases_walkout after insert on public.team_purchases
  for each row execute function public.walkout_on_purchase();

-- Plan B: si el video no llegó, el mensaje de antes (texto + foto) solo por WhatsApp.
-- La función walkout arma ese mensaje (busca la foto en market.json del sitio).
create or replace function public.walkout_fallback() returns void
language plpgsql security definer set search_path = public as $$
declare
  j record;
  api text := (select value from app_secrets where name = 'walkout_api');
begin
  for j in
    select w.* from walkout_jobs w
    left join net._http_response r on r.id = w.dispatch_id
    where w.status = 'pending'
      and (w.fallback_at is null or w.fallback_at < now() - interval '10 minutes')
      and (w.created_at < now() - interval '8 minutes'
        or (w.dispatch_id is null and w.created_at < now() - interval '30 seconds')
        or (r.id is not null and (r.status_code is null or r.status_code >= 300)))
  loop
    update walkout_jobs set fallback_at = now(), result = coalesce(result || ' · ', '') || 'plan B' where id = j.id;
    if api is null then
      update walkout_jobs set status = 'fallback', done_at = now(), result = result || ' (sin walkout_api)' where id = j.id;
      continue;
    end if;
    perform net.http_post(api || '?job=' || j.id || '&token=' || j.token || '&fail=1', '{}'::jsonb,
      headers := '{"Content-Type":"application/json"}'::jsonb, timeout_milliseconds := 30000);
    -- La función cambia el status; si no contesta, se reintenta a los 10 minutos.
  end loop;
end $$;

select cron.unschedule('walkout-fallback') where exists (select 1 from cron.job where jobname = 'walkout-fallback');
select cron.schedule('walkout-fallback', '* * * * *', 'select public.walkout_fallback()');

-- La app agrega al video quién sigue de turno (Fast Track). Una sola vez y mientras no se haya mandado.
create or replace function public.walkout_note(p_purchase uuid, p_note text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return; end if;
  update walkout_jobs set note = left(p_note, 300) where purchase_id = p_purchase and status = 'pending' and note is null;
end $$;
revoke execute on function public.walkout_note(uuid, text) from public, anon;
grant execute on function public.walkout_note(uuid, text) to authenticated;

-- Solo el servidor las usa (no por la API pública).
revoke execute on function public.walkout_dispatch(uuid), public.walkout_fallback(), public.walkout_on_purchase() from public, anon, authenticated;

-- Secretos por proyecto (github_token lo agrega el admin a mano, no va en el repo):
-- pruebas: walkout_api = https://bcvzgwnwjtcmtbhwruhi.supabase.co/functions/v1/walkout, github_repo = vickrdzdev/torneofifa-pruebas
-- real:    walkout_api = https://zohacxiwuapnziicaarj.supabase.co/functions/v1/walkout,  github_repo = vickrdzdev/torneofifa
