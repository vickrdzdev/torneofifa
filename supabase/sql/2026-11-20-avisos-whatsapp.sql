-- Avisos: muchos pasan de push a "solo grupo de WhatsApp" (kind 'wa_only', lo maneja
-- la función notify). Algunos llevan un texto distinto para el grupo (wa_text), p. ej.
-- la penalización por alineación, que en push le llega al player y en el grupo dice a quién.
alter table public.notifications add column if not exists wa_text text;
