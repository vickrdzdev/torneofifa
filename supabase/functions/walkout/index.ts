// Video "walkout" de las compras del Mercado abierto y del Fast Track (ver supabase/sql/2026-11-15-walkout-video.sql).
// La llama el workflow walkout.yml de GitHub Actions con ?job=<id>&token=<token>:
//   GET            → datos de la compra para grabar el video
//   POST video/mp4 → guarda el video y lo manda al grupo de WhatsApp
//   POST &fail=1   → plan B (también lo usa pg_cron): el mensaje de antes, texto + foto, solo WhatsApp
// Se despliega sin verificación de JWT: la autorización es el token de un solo uso del job.
import { createClient } from "npm:@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const IS_TEST = (Deno.env.get("SUPABASE_URL") || "").includes("bcvzgwnwjtcmtbhwruhi");
const SITE = IS_TEST ? "https://vickrdzdev.github.io/torneofifa-pruebas/" : "https://torneofifa.com/";
const PHOTO_BASE = "https://cdn3.futbin.com/content/fifa27/img/players/";  // igual que en index.html
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

async function purchaseInfo(purchaseId: string) {
  const { data: job } = await sb.from("walkout_jobs").select("note").eq("purchase_id", purchaseId).maybeSingle();
  const { data: pu } = await sb.from("team_purchases").select("id, season_id, player_id, card_id, card_name, pos, rat, wf, sm, price").eq("id", purchaseId).maybeSingle();
  if (!pu) return null;
  const { data: pl } = await sb.from("players").select("name").eq("id", pu.player_id).maybeSingle();
  const buyer = pl?.name || "Alguien";
  return {
    ...pu, buyer,
    // En el video no se dice a quién compró: la sorpresa está en el video. El plan B (foto) sí lo dice.
    title: "💸 " + buyer + " hizo una compra",
    titleFull: "💸 " + buyer + " compró a " + pu.card_name,
    // Mercado abierto: solo el título. Fast Track: + quién sigue de turno.
    body: job?.note || "",
  };
}

// Cambia el job de "pending" al estado dado; solo uno gana (video o plan B).
async function claim(jobId: string, status: string) {
  const { data } = await sb.from("walkout_jobs").update({ status, done_at: new Date().toISOString() })
    .eq("id", jobId).eq("status", "pending").select("id").maybeSingle();
  return !!data;
}
async function setResult(jobId: string, result: string) {
  await sb.from("walkout_jobs").update({ result }).eq("id", jobId);
}

// Plan B: el aviso de antes, pero solo al grupo (kind "wa_only": sin push).
async function fallback(job: { id: string; purchase_id: string }, why: string) {
  const info = await purchaseInfo(job.purchase_id);
  if (!info) { await setResult(job.id, "compra borrada"); return; }
  let photo: string | null = null;
  try {
    const mk = await (await fetch(SITE + "market.json")).json();
    const row = mk.rows.find((r: unknown[]) => r[0] === info.card_id);
    const p = row ? row[mk.cols.indexOf("photo")] : null;
    if (p) photo = PHOTO_BASE + p;
  } catch (_) { /* sin foto: solo texto */ }
  await sb.from("notifications").upsert({
    season_id: info.season_id, key: "buywa:" + info.id, kind: "wa_only", title: info.titleFull, body: info.body,
    url: "./?m=transacciones", whatsapp: true, wa_photo: photo, send_at: new Date().toISOString(),
  }, { onConflict: "key", ignoreDuplicates: true });
  await setResult(job.id, "plan B: " + why);
  // Que notify lo mande ya (si no, pg_cron lo toma en menos de un minuto).
  try {
    await fetch(Deno.env.get("SUPABASE_URL") + "/functions/v1/notify", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") }, body: "{}",
    });
  } catch (_) { /* lo toma pg_cron */ }
}

Deno.serve(async (req) => {
  const u = new URL(req.url);
  const jobId = u.searchParams.get("job") || "", token = u.searchParams.get("token") || "";
  if (!/^[0-9a-f-]{36}$/.test(jobId) || !token) return json({ error: "falta job" }, 400);
  const { data: job } = await sb.from("walkout_jobs").select("id, purchase_id, token, status").eq("id", jobId).maybeSingle();
  if (!job || job.token !== token) return json({ error: "no autorizado" }, 403);
  if (job.status !== "pending") return json({ error: "ya procesado: " + job.status }, 409);

  if (req.method === "GET") {
    const info = await purchaseInfo(job.purchase_id);
    if (!info) return json({ error: "compra borrada" }, 404);
    // Escudos para la transferencia: el equipo de quien compra y, si alguien del torneo lo vendió antes, el de esa persona.
    const team = async (playerId: string) => {
      const { data: p } = await sb.from("players").select("name, team_name, logo_path").eq("id", playerId).maybeSingle();
      if (!p) return { team: null, logo: null };
      const signed = p.logo_path ? (await sb.storage.from("logos").createSignedUrl(p.logo_path, 3600)).data : null;
      return { team: p.team_name || p.name, logo: signed ? signed.signedUrl : null };
    };
    const to = await team(info.player_id);
    const { data: prev } = await sb.from("team_purchases").select("player_id").eq("season_id", info.season_id).eq("card_id", info.card_id)
      .not("sold_at", "is", null).neq("id", info.id).order("sold_at", { ascending: false }).limit(1).maybeSingle();
    const from = prev ? await team(prev.player_id) : { team: null, logo: null };
    return json({ card_id: info.card_id, card_name: info.card_name, pos: info.pos, rat: info.rat, wf: info.wf, sm: info.sm, price: info.price, buyer: info.buyer,
      buyer_team: to.team, buyer_logo: to.logo, from_team: from.team, from_logo: from.logo });
  }
  if (req.method !== "POST") return json({ error: "método" }, 405);

  if (u.searchParams.get("fail")) {
    if (!(await claim(job.id, "fallback"))) return json({ error: "ya procesado" }, 409);
    await fallback(job, u.searchParams.get("why") || "sin video");
    return json({ ok: true, fallback: true });
  }

  const mp4 = new Uint8Array(await req.arrayBuffer());
  if (mp4.length < 10000 || mp4.length > 15 * 1024 * 1024) return json({ error: "video inválido" }, 400);
  if (!(await claim(job.id, "sent"))) return json({ error: "ya procesado" }, 409);
  const info = await purchaseInfo(job.purchase_id);
  if (!info) { await setResult(job.id, "compra borrada"); return json({ error: "compra borrada" }, 404); }

  const { data: secrets } = await sb.from("app_secrets").select("name, value");
  const sec = Object.fromEntries((secrets || []).map((s) => [s.name, s.value]));
  try {
    const path = `walkout/${job.id}.mp4`;
    const up = await sb.storage.from("whatsapp").upload(path, mp4, { contentType: "video/mp4", upsert: true });
    if (up.error) throw new Error("storage " + up.error.message);
    const { data: signed } = await sb.storage.from("whatsapp").createSignedUrl(path, 3600);
    if (!signed) throw new Error("liga temporal");
    const caption = (IS_TEST ? "🧪 PRUEBAS\n" : "") + "*" + info.title + "*" + (info.body ? "\n" + info.body : "");
    const r = await fetch(`${sec.greenapi_url}/waInstance${sec.greenapi_instance}/sendFileByUrl/${sec.greenapi_token}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId: sec.whatsapp_group, urlFile: signed.signedUrl, fileName: "walkout.mp4", caption }),
    });
    const txt = (await r.text()).slice(0, 120);
    if (!r.ok) throw new Error("Green-API " + r.status + " " + txt);
    await setResult(job.id, "video enviado " + Math.round(mp4.length / 1024) + " KB · imágenes " + (u.searchParams.get("imgs") || "?") + " · " + txt);
    return json({ ok: true });
  } catch (e) {
    // El video no salió: el mensaje de antes para no perder la compra.
    await fallback(job, String((e as Error).message || e).slice(0, 120));
    return json({ ok: false, fallback: true, error: String(e) }, 502);
  }
});
