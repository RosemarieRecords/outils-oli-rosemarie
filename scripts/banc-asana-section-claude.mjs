// Banc hors réseau : Asana, Redis et /fire simulés. `npm test`.
import assert from "node:assert/strict";
import { extractCandidates, extractCommentCandidates, triggerFromWebhook, fireConfig, buildFireText, FIRE_PAYLOAD_VERSION, DEFAULT_IDS as IDS } from "../lib/asana-section-claude/core.js";

const URL = "https://api.anthropic.com/v1/claude_code/routines/trig_01Qk5UmhxsCAoid8RhcAqfx2/fire";
const ENV = { SECTION_CLAUDE_ROUTINE_FIRE_URL: URL, SECTION_CLAUDE_ROUTINE_TOKEN: "sk-ant-oat01-banc" };
let n = 0;
const cas = async (nom, fn) => { await fn(); console.log(`ok ${++n} - ${nom}`); };

function kvMemoire() {
  const m = new Map();
  return {
    setNx: async (k) => (m.has(k) ? false : (m.set(k, 1), true)),
    del: async (k) => (m.delete(k), 1),
    incr: async (k) => { const v = (m.get(k) || 0) + 1; m.set(k, v); return v; },
  };
}
const tache = (gid, extra = {}) => ({ gid, name: "Préparer la bio", completed: false, assignee: { gid: IDS.userGid }, assignee_section: { gid: IDS.sectionGid }, ...extra });
const ajout = (gid, parent) => ({ action: "added", resource: { gid, resource_type: "task" }, parent });
const dansSection = (gid) => ajout(gid, { gid: IDS.sectionGid, resource_type: "section" });
function fetchOk(appels) {
  return async (url, init) => { appels.push({ url, init }); return { ok: true, status: 200, json: async () => ({ claude_code_session_url: "https://claude.ai/code/session_1" }) }; };
}

await cas("extraction : section = certain, autre section et projet ignorés, liste = à vérifier, changed ignoré", async () => {
  const c = extractCandidates({ events: [
    dansSection("1"),
    ajout("2", { gid: "999", resource_type: "section" }),
    ajout("3", { gid: "777", resource_type: "user_task_list" }),
    ajout("4", { gid: "555", resource_type: "project" }),
    { action: "changed", resource: { gid: "5", resource_type: "task" }, change: { field: "name" } },
  ] }, IDS);
  assert.deepEqual(c, [{ taskGid: "1", certain: true }, { taskGid: "3", certain: false }]);
});

await cas("non configuré = no-op ; URL hors api.anthropic.com refusée", async () => {
  assert.equal((await triggerFromWebhook({ events: [] }, { env: {} })).reason, "non_configure");
  assert.equal(fireConfig({ ...ENV, SECTION_CLAUDE_ROUTINE_FIRE_URL: "https://exemple.com/fire" }).reason, "url_invalide");
});

await cas("tâche déposée : un /fire, texte constant + GID, jeton en en-tête", async () => {
  const appels = [];
  const r = await triggerFromWebhook({ events: [dansSection("11")] }, { env: ENV, kv: kvMemoire(), fetchTask: async (g) => tache(g), fetchImpl: fetchOk(appels) });
  assert.deepEqual(r.fired, ["11"]);
  assert.equal(appels[0].url, URL);
  assert.equal(appels[0].init.headers.Authorization, "Bearer sk-ant-oat01-banc");
  const texte = JSON.parse(appels[0].init.body).text;
  assert.equal(texte.split("\n")[0], FIRE_PAYLOAD_VERSION);
  assert.match(texte, /^taches: 11$/m);
});

await cas("relecture : hors section, complétée, autre assigné, déjà 🔄 = rien", async () => {
  const appels = [];
  const f = { 21: tache("21", { assignee_section: { gid: "0" } }), 22: tache("22", { completed: true }), 23: tache("23", { assignee: { gid: "42" } }), 24: tache("24", { name: "🔄 Bio" }) };
  const r = await triggerFromWebhook({ events: ["21", "22", "23", "24"].map(dansSection) }, { env: ENV, kv: kvMemoire(), fetchTask: async (g) => f[g], fetchImpl: fetchOk(appels) });
  assert.equal(appels.length, 0);
  assert.deepEqual(r.skipped.map((s) => s.reason).sort(), ["autre_assigne", "completee", "deja_prise", "hors_section"]);
});

await cas("verrou : même event livré deux fois = un seul /fire", async () => {
  const appels = [];
  const ctx = { env: ENV, kv: kvMemoire(), fetchTask: async (g) => tache(g), fetchImpl: fetchOk(appels) };
  await triggerFromWebhook({ events: [dansSection("31")] }, ctx);
  const r2 = await triggerFromWebhook({ events: [dansSection("31")] }, ctx);
  assert.equal(appels.length, 1);
  assert.equal(r2.skipped[0].reason, "deja_declenchee");
});

await cas("plafond quotidien atteint = aucun /fire", async () => {
  const appels = [];
  const r = await triggerFromWebhook({ events: [dansSection("41")] }, { env: { ...ENV, SECTION_CLAUDE_MAX_FIRES_PER_DAY: "1" }, kv: { ...kvMemoire(), incr: async () => 2 }, fetchTask: async (g) => tache(g), fetchImpl: fetchOk(appels) });
  assert.equal(appels.length, 0);
  assert.equal(r.skipped[0].reason, "plafond_quotidien");
});

await cas("Redis en erreur = fermé par défaut", async () => {
  const appels = [];
  const kv = { setNx: async () => { throw new Error("down"); }, del: async () => 0, incr: async () => { throw new Error("down"); } };
  const r = await triggerFromWebhook({ events: [dansSection("51")] }, { env: ENV, kv, fetchTask: async (g) => tache(g), fetchImpl: fetchOk(appels) });
  assert.equal(appels.length, 0);
  assert.equal(r.skipped[0].reason, "verrou_indisponible");
});

await cas("ajout à la liste sans relecture possible = rien", async () => {
  const appels = [];
  const r = await triggerFromWebhook({ events: [ajout("61", { gid: "777", resource_type: "user_task_list" })] }, { env: ENV, kv: kvMemoire(), fetchImpl: fetchOk(appels) });
  assert.equal(appels.length, 0);
  assert.match(r.skipped[0].reason, /^non_verifiable/);
});

await cas("/fire refusé (401) : verrou relâché, nouvelle tentative possible", async () => {
  const kv = kvMemoire();
  const refus = async () => ({ ok: false, status: 401, json: async () => ({ error: { message: "jeton" } }) });
  const r = await triggerFromWebhook({ events: [dansSection("71")] }, { env: ENV, kv, fetchTask: async (g) => tache(g), fetchImpl: refus });
  assert.equal(r.skipped[0].reason, "fire_refuse");
  assert.equal(await kv.setNx("task:71"), true);
});

await cas("texte du /fire sans contenu saisi dans Asana", async () => {
  const t = buildFireText(["1", "2"], new Date("2026-10-21T00:00:00Z"));
  assert.equal(t.split("\n").length, 3);
  assert.doesNotMatch(t, /bio/i);
});

const commentaire = (storyGid, taskGid, subtype = "comment_added") => ({ action: "added", resource: { gid: storyGid, resource_type: "story", resource_subtype: subtype }, parent: { gid: taskGid, resource_type: "task" } });
const story = (gid, taskGid, text, extra = {}) => ({ gid, text, resource_subtype: "comment_added", target: { gid: taskGid }, ...extra });

await cas("extraction des commentaires : comment_added sur une tâche seulement", async () => {
  const c = extractCommentCandidates({ events: [
    commentaire("901", "81"),
    commentaire("902", "82", "assigned"),
    { action: "added", resource: { gid: "903", resource_type: "story" }, parent: { gid: "5", resource_type: "project" } },
  ] });
  assert.deepEqual(c, [{ storyGid: "901", taskGid: "81" }]);
});

await cas("réponse humaine sur ⚠️ : un /fire ciblé sur la tâche", async () => {
  const appels = [];
  const r = await triggerFromWebhook({ events: [commentaire("911", "91")] }, {
    env: ENV, kv: kvMemoire(), fetchImpl: fetchOk(appels),
    fetchTask: async (g) => tache(g, { name: "⚠️ Préparer la bio" }),
    fetchStory: async (g) => story(g, "91", "Oui, prends la version courte."),
  });
  assert.deepEqual(r.fired, ["91"]);
  assert.match(JSON.parse(appels[0].init.body).text, /^taches: 91$/m);
});

await cas("commentaire de Claude (🤖) : ignoré, pas de boucle", async () => {
  const appels = [];
  const r = await triggerFromWebhook({ events: [commentaire("921", "92")] }, {
    env: ENV, kv: kvMemoire(), fetchImpl: fetchOk(appels),
    fetchTask: async (g) => tache(g, { name: "⚠️ Bio" }),
    fetchStory: async (g) => story(g, "92", "🤖 Claude : 1. Quelle version ?"),
  });
  assert.equal(appels.length, 0);
  assert.equal(r.skipped[0].reason, "commentaire_claude");
});

await cas("commentaire sur tâche sans préfixe, en 🔄 ou hors section : ignoré", async () => {
  const appels = [];
  const f = { 31: tache("31", { name: "Bio" }), 32: tache("32", { name: "🔄 Bio" }), 33: tache("33", { name: "⚠️ Bio", assignee_section: { gid: "0" } }) };
  const r = await triggerFromWebhook({ events: ["31", "32", "33"].map((g) => commentaire(`7${g}`, g)) }, {
    env: ENV, kv: kvMemoire(), fetchImpl: fetchOk(appels),
    fetchTask: async (g) => f[g], fetchStory: async (sg) => story(sg, sg.slice(1), "ok"),
  });
  assert.equal(appels.length, 0);
  assert.deepEqual(r.skipped.map((s) => s.reason).sort(), ["deja_prise", "hors_section", "sans_prefixe_relancable"]);
});

await cas("réponse rapide après un dépôt : le verrou de tâche ne bloque pas le commentaire", async () => {
  const appels = [];
  const kv = kvMemoire();
  await kv.setNx("task:95");
  const r = await triggerFromWebhook({ events: [commentaire("951", "95")] }, {
    env: ENV, kv, fetchImpl: fetchOk(appels),
    fetchTask: async (g) => tache(g, { name: "✅ Bio" }),
    fetchStory: async (g) => story(g, "95", "Peux-tu raccourcir ?"),
  });
  assert.deepEqual(r.fired, ["95"]);
});

await cas("même commentaire livré deux fois : un seul /fire", async () => {
  const appels = [];
  const ctx = { env: ENV, kv: kvMemoire(), fetchImpl: fetchOk(appels), fetchTask: async (g) => tache(g, { name: "❌ Bio" }), fetchStory: async (g) => story(g, "96", "Accès donné.") };
  await triggerFromWebhook({ events: [commentaire("961", "96")] }, ctx);
  await triggerFromWebhook({ events: [commentaire("961", "96")] }, ctx);
  assert.equal(appels.length, 1);
});

console.log(`\n${n} cas, tous verts.`);
