// Client Upstash Redis minimal par l'API REST (aucune dépendance npm).
// Variables acceptées : celles de l'intégration Upstash du marketplace Vercel
// (KV_REST_API_URL / KV_REST_API_TOKEN) ou celles d'Upstash
// (UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN).
//
// Chaque outil obtient son propre espace de clés par kvFor("<outil>") : deux
// outils ne lisent jamais les clés l'un de l'autre.

function conf(env = process.env) {
  const url = String(env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL || "").trim();
  const token = String(env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN || "").trim();
  return url && token ? { url: url.replace(/\/+$/, ""), token } : null;
}

export function redisConfigured(env = process.env) {
  return conf(env) !== null;
}

async function cmd(args, env = process.env) {
  const c = conf(env);
  if (!c) throw new Error("Redis non configuré");
  const r = await fetch(c.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(3000),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || j?.error) throw new Error(j?.error || `Redis HTTP ${r.status}`);
  return j?.result ?? null;
}

/** Interface KV d'un outil : toutes ses clés commencent par « <outil>: ». */
export function kvFor(tool) {
  const PREFIX = `${tool}:`;
  return {
  available: true,
  get: (k) => cmd(["GET", PREFIX + k]),
  set: (k, v, ttl) => cmd(ttl ? ["SET", PREFIX + k, v, "EX", String(ttl)] : ["SET", PREFIX + k, v]),
  del: (k) => cmd(["DEL", PREFIX + k]),
  // true : posé ; false : déjà présent.
  setNx: async (k, v, ttl) => (await cmd(["SET", PREFIX + k, v, "NX", "EX", String(ttl)])) === "OK",
  incr: async (k, ttl) => {
    const n = await cmd(["INCR", PREFIX + k]);
    if (n === 1 && ttl) await cmd(["EXPIRE", PREFIX + k, String(ttl)]);
    return n;
  },
  };
}
