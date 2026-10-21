// POST /api/asana-section-claude/register : inscrit (ou réinscrit) le webhook Asana sur la liste
// Mes tâches d'Olivier. Protégé par l'en-tête « x-admin-key » = ADMIN_KEY.
// GET (même en-tête) : liste les webhooks existants de ce relais.
//
// Séquence : ouvre la fenêtre de poignée de main (2 min), résout le GID de
// la liste Mes tâches, POST /webhooks vers https://<hôte>/api/asana-section-claude/webhook ; Asana
// fait la poignée de main avant de répondre. Filtres : tâche ajoutée et story
// ajoutée (commentaires) ; retentés sans filtre si Asana les refuse. Les
// webhooks existants de ce relais sont supprimés avant la création.

import crypto from "node:crypto";
import { kvFor, redisConfigured } from "../../lib/redis.js";
import { idsFromEnv } from "../../lib/asana-section-claude/core.js";
import { asana } from "../../lib/asana.js";

const redisKv = kvFor("asana-section-claude");

function authorized(req) {
  const expected = String(process.env.ADMIN_KEY || "");
  const given = String(req.headers["x-admin-key"] || "");
  if (expected.length < 24 || given.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

function target(req) {
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `https://${host}/api/asana-section-claude/webhook`;
}

export default async function handler(req, res) {
  if (!authorized(req)) return res.status(401).json({ error: "Non autorisé" });
  if (!redisConfigured()) return res.status(500).json({ error: "Redis non configuré" });
  const ids = idsFromEnv();

  try {
    if (req.method === "GET") {
      const hooks = await asana("/webhooks", { query: { workspace: ids.workspaceGid, opt_fields: "gid,active,target,resource.gid,resource.resource_type,last_success_at,last_failure_at,last_failure_content" } });
      const mine = (hooks || []).filter((h) => h.target === target(req));
      const lastEventAt = await redisKv.get("last-event-at").catch(() => null);
      return res.status(200).json({ webhooks: mine, lastEventAt });
    }
    if (req.method !== "POST") return res.status(405).json({ error: "Méthode non permise" });
    const utl = await asana(`/users/${ids.userGid}/user_task_list`, { query: { workspace: ids.workspaceGid, opt_fields: "gid" } });
    if (!utl?.gid) return res.status(500).json({ error: "Liste Mes tâches introuvable" });

    // Réinscription : Asana refuse deux webhooks sur la même ressource et la
    // même cible ; les webhooks existants de ce relais sont donc supprimés
    // d'abord. Si la création échoue ensuite, relancer la commande suffit.
    const existants = (await asana("/webhooks", { query: { workspace: ids.workspaceGid, opt_fields: "gid,target" } }) || [])
      .filter((h) => h.target === target(req));
    const supprimes = [];
    for (const h of existants) {
      await asana(`/webhooks/${h.gid}`, { method: "DELETE" });
      supprimes.push(h.gid);
    }

    await redisKv.set("handshake-open", "1", 120);
    const create = (filters) =>
      asana("/webhooks", {
        method: "POST",
        body: { data: { resource: utl.gid, target: target(req), ...(filters ? { filters } : {}) } },
        query: { opt_fields: "gid,active,resource.gid,target" },
      });
    let hook;
    let warning = null;
    try {
      hook = await create([
        { resource_type: "task", action: "added" },
        { resource_type: "story", action: "added" },
      ]);
    } catch (err) {
      if (err?.status !== 400) throw err;
      warning = `Filtre refusé par Asana (${err.message}) : webhook sans filtre, le relais trie lui-même.`;
      await redisKv.set("handshake-open", "1", 120);
      hook = await create(null);
    }
    return res.status(200).json({ ok: true, webhook: hook, userTaskList: utl.gid, anciensSupprimes: supprimes, ...(warning ? { warning } : {}) });
  } catch (err) {
    return res.status(err?.status || 500).json({ error: err?.message || "échec" });
  }
}
