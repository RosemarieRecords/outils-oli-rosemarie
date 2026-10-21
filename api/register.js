// POST /api/register : inscrit (ou réinscrit) le webhook Asana sur la liste
// Mes tâches d'Olivier. Protégé par l'en-tête « x-admin-key » = ADMIN_KEY.
// GET (même en-tête) : liste les webhooks existants de ce relais.
//
// Séquence : ouvre la fenêtre de poignée de main (2 min), résout le GID de
// la liste Mes tâches, POST /webhooks vers https://<hôte>/api/webhook ; Asana
// fait la poignée de main avant de répondre. Le filtre « task / added » est
// retenté sans filtre si Asana le refuse.

import crypto from "node:crypto";
import { redisKv, redisConfigured } from "../lib/redis.js";
import { idsFromEnv } from "../lib/core.js";
import { asana } from "../lib/asana.js";

function authorized(req) {
  const expected = String(process.env.ADMIN_KEY || "");
  const given = String(req.headers["x-admin-key"] || "");
  if (expected.length < 24 || given.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

function target(req) {
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `https://${host}/api/webhook`;
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
      hook = await create([{ resource_type: "task", action: "added" }]);
    } catch (err) {
      if (err?.status !== 400) throw err;
      warning = `Filtre refusé par Asana (${err.message}) : webhook sans filtre, le relais trie lui-même.`;
      await redisKv.set("handshake-open", "1", 120);
      hook = await create(null);
    }
    return res.status(200).json({ ok: true, webhook: hook, userTaskList: utl.gid, ...(warning ? { warning } : {}) });
  } catch (err) {
    return res.status(err?.status || 500).json({ error: err?.message || "échec" });
  }
}
