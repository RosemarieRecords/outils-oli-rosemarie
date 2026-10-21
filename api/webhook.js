// POST /api/webhook : receveur du webhook Asana (liste Mes tâches d'Olivier).
//
// 1. Poignée de main (en-tête X-Hook-Secret) : acceptée SEULEMENT pendant une
//    fenêtre ouverte par /api/register (clé « handshake-open », 2 min). Sans
//    cette garde, n'importe qui pourrait créer un webhook Asana vers cette URL
//    et remplacer le secret. Le secret est stocké dans Redis.
// 2. Événement (en-tête X-Hook-Signature) : HMAC-SHA256 du corps brut avec le
//    secret ; signature invalide = 401, rien n'est traité.
// La réponse est toujours rapide ; le déclencheur ne change jamais le code
// HTTP d'un lot valide (un webhook en échec 24 h est supprimé par Asana).
// GET = santé (aucun secret exposé).

import crypto from "node:crypto";
import { redisKv, redisConfigured } from "../lib/redis.js";
import { triggerFromWebhook, fireConfig } from "../lib/core.js";
import { fetchTask } from "../lib/asana.js";

export const config = { api: { bodyParser: false } };

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sameHex(a, b) {
  const ab = Buffer.from(String(a || ""), "hex");
  const bb = Buffer.from(String(b || ""), "hex");
  return ab.length > 0 && ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

const log = (level, msg) => console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](`[section-claude] ${msg}`);

export default async function handler(req, res) {
  if (req.method === "GET") {
    const cfg = fireConfig();
    return res.status(200).json({ ok: true, redis: redisConfigured(), fire: cfg.enabled ? "configure" : cfg.reason });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Méthode non permise" });
  if (!redisConfigured()) return res.status(500).json({ error: "Redis non configuré" });

  let raw;
  try {
    raw = await readRaw(req);
  } catch {
    return res.status(400).json({ error: "Corps illisible" });
  }

  const handshake = req.headers["x-hook-secret"];
  if (handshake) {
    const open = await redisKv.get("handshake-open").catch(() => null);
    if (!open) {
      log("warn", "poignée de main refusée : aucune inscription en cours");
      return res.status(403).json({ error: "Aucune inscription en cours" });
    }
    await redisKv.set("hook-secret", String(handshake));
    await redisKv.del("handshake-open").catch(() => {});
    log("info", "poignée de main acceptée, secret enregistré");
    res.setHeader("X-Hook-Secret", String(handshake));
    return res.status(200).end();
  }

  const secret = await redisKv.get("hook-secret").catch(() => null);
  const expected = secret ? crypto.createHmac("sha256", secret).update(raw).digest("hex") : "";
  if (!secret || !sameHex(req.headers["x-hook-signature"], expected)) {
    log("warn", "signature invalide");
    return res.status(401).json({ error: "Signature invalide" });
  }

  let payload = null;
  try {
    payload = raw.length ? JSON.parse(raw.toString("utf8")) : null;
  } catch {
    payload = null;
  }
  await redisKv.set("last-event-at", new Date().toISOString()).catch(() => {});
  const summary = await triggerFromWebhook(payload, { kv: redisKv, fetchTask, log });
  return res.status(200).json({ ok: true, fired: summary.fired.length, skipped: summary.skipped.length });
}
