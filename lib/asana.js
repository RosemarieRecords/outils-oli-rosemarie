// Appels Asana avec un jeton d'accès personnel (ASANA_PAT), dédié à ce relais.

const API = "https://app.asana.com/api/1.0";

export async function asana(path, { method = "GET", query, body, env = process.env } = {}) {
  const pat = String(env.ASANA_PAT || "").trim();
  if (!pat) throw Object.assign(new Error("ASANA_PAT non configuré"), { status: 500 });
  const qs = query ? `?${new URLSearchParams(query)}` : "";
  const r = await fetch(`${API}${path}${qs}`, {
    method,
    headers: { Authorization: `Bearer ${pat}`, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(8000),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) {
    const msg = j?.errors?.map((e) => e.message).join(" ; ") || `Asana HTTP ${r.status}`;
    throw Object.assign(new Error(msg), { status: r.status });
  }
  return j?.data ?? null;
}

export const fetchTask = (gid, optFields) =>
  asana(`/tasks/${encodeURIComponent(gid)}`, { query: { opt_fields: optFields } });
