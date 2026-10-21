// Logique du déclencheur, sans dépendance au runtime Vercel (testable hors
// réseau par scripts/banc.mjs).
//
// Chemin : Olivier dépose une tâche dans la section ✳️CLAUDE de Mes tâches ;
// Asana POSTe un event `added` sur le webhook de sa liste Mes tâches ;
// api/asana-section-claude/webhook.js valide la signature HMAC puis appelle triggerFromWebhook() :
//   1. extractCandidates : tâches ajoutées à la section (certain) ou à la
//      liste (à vérifier) ; tout le reste est ignoré ;
//   2. readTaskState : relecture Asana (source de vérité) ; non complétée,
//      assignée à Olivier, assignee_section = ✳️CLAUDE, titre sans 🔄 ;
//   3. verrou par tâche (30 min) : le /fire n'a pas de clé d'idempotence ;
//   4. plafond quotidien ;
//   5. un seul POST /fire par lot, texte = constantes + GIDs.
// Commentaires (relance d'une tâche ⚠️, ✅ ou ❌ par une réponse humaine) :
//   extractCommentCandidates repère les stories `comment_added` d'une tâche ;
//   readCommentState relit le commentaire (ignoré s'il commence par 🤖, la
//   marque des commentaires de Claude publiés sous le compte d'Olivier) puis la
//   tâche (section ✳️CLAUDE, non complétée, préfixe ⚠️, ✅ ou ❌) ; verrou par
//   commentaire, pour qu'une réponse rapide ne bute pas sur le verrou de tâche.
// Les changements de titre de la routine (🔄 ✅ ⚠️ ❌) sont des events
// `changed`, ignorés : aucune boucle possible. Redis en erreur = fermé par
// défaut (aucun /fire) ; le passage horaire de la routine rattrape.

export const FIRE_PAYLOAD_VERSION = "asana-section-claude/v1";

export const DEFAULT_IDS = Object.freeze({
  workspaceGid: "945096259991766",
  userGid: "1201745376905640",
  sectionGid: "1219042937374961",
});

export const TASK_OPT_FIELDS = "name,completed,assignee.gid,assignee_section.gid";
export const STORY_OPT_FIELDS = "text,resource_subtype,type,target.gid";
export const PRISE_EN_CHARGE = "🔄";
// Préfixes d'une tâche qu'un commentaire humain peut relancer.
export const RELANCABLES = Object.freeze(["⚠️", "⚠", "✅", "❌"]);
export const MARQUE_CLAUDE = "🤖";

const DEFAULT_MAX_FIRES_PER_DAY = 20;
const TASK_CLAIM_TTL_S = 30 * 60;
const DAILY_COUNTER_TTL_S = 26 * 3600;
const MAX_CANDIDATES_PER_BATCH = 25;
const VERIFY_TIMEOUT_MS = 4000;
const FIRE_TIMEOUT_MS = 5000;
const KV_TIMEOUT_MS = 3000;

// Seule destination acceptée pour le jeton de routine.
const FIRE_URL_RE = /^https:\/\/api\.anthropic\.com\/v1\/claude_code\/routines\/trig_[A-Za-z0-9]+\/fire$/;
const GID_RE = /^\d{1,30}$/;

function gidOr(value, fallback) {
  const v = String(value ?? "").trim();
  return GID_RE.test(v) ? v : fallback;
}

export function idsFromEnv(env = process.env) {
  return {
    workspaceGid: gidOr(env.SECTION_CLAUDE_WORKSPACE_GID, DEFAULT_IDS.workspaceGid),
    userGid: gidOr(env.SECTION_CLAUDE_USER_GID, DEFAULT_IDS.userGid),
    sectionGid: gidOr(env.SECTION_CLAUDE_SECTION_GID, DEFAULT_IDS.sectionGid),
  };
}

/** Configuration du /fire. Le jeton ne sort jamais de ce module. */
export function fireConfig(env = process.env) {
  const url = String(env.SECTION_CLAUDE_ROUTINE_FIRE_URL || "").trim();
  const token = String(env.SECTION_CLAUDE_ROUTINE_TOKEN || "").trim();
  const rawMax = String(env.SECTION_CLAUDE_MAX_FIRES_PER_DAY ?? "").trim();
  const maxFiresPerDay = /^\d+$/.test(rawMax) ? Number(rawMax) : DEFAULT_MAX_FIRES_PER_DAY;
  if (!url || !token) return { enabled: false, reason: "non_configure", maxFiresPerDay };
  if (!FIRE_URL_RE.test(url)) return { enabled: false, reason: "url_invalide", maxFiresPerDay };
  if (maxFiresPerDay === 0) return { enabled: false, reason: "coupe", maxFiresPerDay };
  return { enabled: true, url, token, maxFiresPerDay };
}

/**
 * Tâches ajoutées dans un lot d'events (fonction pure).
 * @returns {{taskGid: string, certain: boolean}[]}
 */
export function extractCandidates(payload, ids = DEFAULT_IDS) {
  const events = Array.isArray(payload?.events) ? payload.events : [];
  const byTask = new Map();
  for (const ev of events) {
    const r = ev?.resource;
    if (!r || r.resource_type !== "task" || !GID_RE.test(String(r.gid || ""))) continue;
    if (ev.action !== "added") continue;
    const parent = ev.parent || {};
    const taskGid = String(r.gid);
    if (parent.resource_type === "section") {
      if (String(parent.gid) === String(ids.sectionGid)) byTask.set(taskGid, { taskGid, certain: true });
      continue;
    }
    if (parent.resource_type === "user_task_list" || !parent.resource_type) {
      if (!byTask.has(taskGid)) byTask.set(taskGid, { taskGid, certain: false });
    }
  }
  return [...byTask.values()];
}

/**
 * Commentaires ajoutés dans un lot d'events (fonction pure).
 * @returns {{storyGid: string, taskGid: string}[]}
 */
export function extractCommentCandidates(payload) {
  const events = Array.isArray(payload?.events) ? payload.events : [];
  const byStory = new Map();
  for (const ev of events) {
    const r = ev?.resource;
    if (!r || r.resource_type !== "story" || !GID_RE.test(String(r.gid || ""))) continue;
    if (ev.action !== "added") continue;
    if (r.resource_subtype && r.resource_subtype !== "comment_added") continue;
    const parent = ev.parent || {};
    if (parent.resource_type !== "task" || !GID_RE.test(String(parent.gid || ""))) continue;
    byStory.set(String(r.gid), { storyGid: String(r.gid), taskGid: String(parent.gid) });
  }
  return [...byStory.values()];
}

function prefixeRelancable(name) {
  const n = String(name || "").trimStart();
  return RELANCABLES.some((p) => n.startsWith(p));
}

/** Relit le commentaire puis la tâche ; seules les valeurs relues décident. */
export async function readCommentState(c, ctx, ids) {
  if (typeof ctx.fetchStory !== "function" || typeof ctx.fetchTask !== "function") return { ok: false, reason: "sans_api" };
  let story;
  try {
    story = await withTimeout(ctx.fetchStory(c.storyGid, STORY_OPT_FIELDS), VERIFY_TIMEOUT_MS);
  } catch {
    return { ok: false, reason: "commentaire_illisible" };
  }
  if (!story) return { ok: false, reason: "commentaire_illisible" };
  if (story.resource_subtype !== "comment_added") return { ok: false, reason: "pas_un_commentaire" };
  if (String(story.target?.gid || c.taskGid) !== c.taskGid) return { ok: false, reason: "cible_incoherente" };
  if (String(story.text || "").trimStart().startsWith(MARQUE_CLAUDE)) return { ok: false, reason: "commentaire_claude" };
  const state = await readTaskState(c.taskGid, ctx.fetchTask, ids, { requirePrefix: true });
  if (!state.checked) return { ok: false, reason: `non_verifiable:${state.reason}` };
  return state.ok ? { ok: true } : { ok: false, reason: state.reason };
}

/** Texte envoyé au /fire : constantes et GIDs numériques seulement. */
export function buildFireText(taskGids, at = new Date()) {
  return [
    FIRE_PAYLOAD_VERSION,
    `taches: ${taskGids.join(", ")}`,
    `source: webhook outils-oli-rosemarie, ${at.toISOString()}`,
  ].join("\n");
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`délai dépassé (${ms} ms)`)), ms);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

export async function readTaskState(taskGid, fetchTask, ids, { requirePrefix = false } = {}) {
  if (typeof fetchTask !== "function") return { checked: false, reason: "sans_api" };
  let task;
  try {
    task = await withTimeout(fetchTask(taskGid, TASK_OPT_FIELDS), VERIFY_TIMEOUT_MS);
  } catch (err) {
    if (err?.status === 404) return { checked: true, ok: false, reason: "introuvable" };
    return { checked: false, reason: "api_erreur" };
  }
  if (!task) return { checked: false, reason: "api_vide" };
  if (task.completed) return { checked: true, ok: false, reason: "completee" };
  if (String(task.assignee?.gid || "") !== String(ids.userGid)) return { checked: true, ok: false, reason: "autre_assigne" };
  if (String(task.assignee_section?.gid || "") !== String(ids.sectionGid)) return { checked: true, ok: false, reason: "hors_section" };
  if (String(task.name || "").trimStart().startsWith(PRISE_EN_CHARGE)) return { checked: true, ok: false, reason: "deja_prise" };
  if (requirePrefix && !prefixeRelancable(task.name)) return { checked: true, ok: false, reason: "sans_prefixe_relancable" };
  return { checked: true, ok: true };
}

async function kvCall(fn) {
  try {
    return await withTimeout(fn(), KV_TIMEOUT_MS);
  } catch {
    return null;
  }
}

async function fireRoutine(cfg, text, fetchImpl) {
  let r;
  try {
    r = await fetchImpl(cfg.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(FIRE_TIMEOUT_MS),
    });
  } catch (err) {
    // La session a peut-être été créée : on garde les verrous.
    return { ok: false, outcome: "inconnu", error: err?.name === "TimeoutError" ? "délai dépassé" : err?.message || "réseau" };
  }
  const json = await r.json().catch(() => null);
  if (r.ok) return { ok: true, sessionUrl: json?.claude_code_session_url || null };
  return {
    ok: false,
    outcome: r.status >= 500 ? "inconnu" : "refuse",
    status: r.status,
    error: String(json?.error?.message || `HTTP ${r.status}`).slice(0, 300),
  };
}

/**
 * Point d'entrée. Ne rejette jamais.
 * ctx : { kv, fetchTask, fetchStory, fetchImpl, env, now, log }
 */
export async function triggerFromWebhook(payload, ctx = {}) {
  const summary = { enabled: false, candidates: 0, fired: [], skipped: [] };
  const log = typeof ctx.log === "function" ? ctx.log : () => {};
  try {
    const env = ctx.env || process.env;
    const cfg = fireConfig(env);
    if (!cfg.enabled) {
      summary.reason = cfg.reason;
      return summary;
    }
    summary.enabled = true;
    const ids = idsFromEnv(env);
    let candidates = extractCandidates(payload, ids);
    let comments = extractCommentCandidates(payload).slice(0, MAX_CANDIDATES_PER_BATCH);
    summary.candidates = candidates.length + comments.length;
    if (summary.candidates === 0) return summary;
    if (candidates.length > MAX_CANDIDATES_PER_BATCH) {
      for (const c of candidates.slice(MAX_CANDIDATES_PER_BATCH)) summary.skipped.push({ taskGid: c.taskGid, reason: "lot_trop_gros" });
      candidates = candidates.slice(0, MAX_CANDIDATES_PER_BATCH);
    }
    const kv = ctx.kv;
    const nowMs = typeof ctx.now === "function" ? ctx.now() : Date.now();

    const checked = await Promise.all(
      candidates.map(async (c) => {
        const state = await readTaskState(c.taskGid, ctx.fetchTask, ids);
        if (state.checked && !state.ok) return { c, skip: state.reason };
        if (!state.checked && !c.certain) return { c, skip: `non_verifiable:${state.reason}` };
        const verrou = kv ? await kvCall(() => kv.setNx(`task:${c.taskGid}`, String(nowMs), TASK_CLAIM_TTL_S)) : null;
        if (verrou === null) return { c, skip: "verrou_indisponible" };
        if (!verrou) return { c, skip: "deja_declenchee" };
        return { c };
      }),
    );
    const gids = [];
    const claims = [];
    for (const x of checked) {
      if (x.skip) summary.skipped.push({ taskGid: x.c.taskGid, reason: x.skip });
      else {
        gids.push(x.c.taskGid);
        claims.push(`task:${x.c.taskGid}`);
      }
    }

    // Commentaires : une tâche déjà retenue par un ajout n'est pas comptée deux fois.
    const commentChecks = await Promise.all(
      comments.map(async (c) => {
        const state = await readCommentState(c, ctx, ids);
        if (!state.ok) return { c, skip: state.reason };
        const verrou = kv ? await kvCall(() => kv.setNx(`comment:${c.storyGid}`, String(nowMs), TASK_CLAIM_TTL_S)) : null;
        if (verrou === null) return { c, skip: "verrou_indisponible" };
        if (!verrou) return { c, skip: "deja_declenchee" };
        return { c };
      }),
    );
    for (const x of commentChecks) {
      if (x.skip) summary.skipped.push({ taskGid: x.c.taskGid, storyGid: x.c.storyGid, reason: x.skip });
      else {
        claims.push(`comment:${x.c.storyGid}`);
        if (!gids.includes(x.c.taskGid)) gids.push(x.c.taskGid);
      }
    }
    if (gids.length === 0) return summary;

    const day = new Date(nowMs).toISOString().slice(0, 10);
    const count = await kvCall(() => kv.incr(`fires:${day}`, DAILY_COUNTER_TTL_S));
    if (!Number.isInteger(count) || count < 1 || count > cfg.maxFiresPerDay) {
      const reason = Number.isInteger(count) && count >= 1 ? "plafond_quotidien" : "compteur_indisponible";
      await Promise.all(claims.map((k) => kvCall(() => kv.del(k))));
      summary.throttled = true;
      for (const g of gids) summary.skipped.push({ taskGid: g, reason });
      log("warn", `aucun /fire (${reason}) pour ${gids.join(", ")}`);
      return summary;
    }

    const result = await fireRoutine(cfg, buildFireText(gids, new Date(nowMs)), ctx.fetchImpl || fetch);
    if (!result.ok) {
      if (result.outcome === "refuse") await Promise.all(claims.map((k) => kvCall(() => kv.del(k))));
      summary.error = result.status ? `HTTP ${result.status} ${result.error}` : result.error;
      for (const g of gids) summary.skipped.push({ taskGid: g, reason: `fire_${result.outcome}` });
      log("error", `/fire en échec pour ${gids.join(", ")} : ${summary.error}`);
      return summary;
    }
    summary.fired = gids;
    summary.sessionUrl = result.sessionUrl;
    log("info", `routine déclenchée pour ${gids.join(", ")} : ${result.sessionUrl || "(sans URL)"}`);
    return summary;
  } catch (err) {
    summary.error = err?.message || "inconnue";
    log("error", `erreur inattendue : ${summary.error}`);
    return summary;
  }
}
