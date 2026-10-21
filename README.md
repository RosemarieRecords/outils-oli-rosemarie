# outils-oli-rosemarie

Outils et automatisations d'Olivier Grenier-Robert dans le cadre de ses fonctions chez Rosemarie Records. Indépendant du portail interne : aucun code, secret ni base partagés avec lui. Hors périmètre : les projets personnels hors Rosemarie.

## Structure

```
api/<outil>/…        points d'entrée HTTP de l'outil (Vercel, un fichier par route)
lib/<outil>/…        logique de l'outil, testable hors réseau
lib/redis.js         client Upstash partagé ; kvFor("<outil>") isole les clés de chaque outil
lib/asana.js         client Asana partagé (ASANA_PAT)
scripts/banc-<outil>.mjs  banc de tests de l'outil
```

Règles pour ajouter un outil :
1. Un dossier `api/<outil>/` et un dossier `lib/<outil>/`.
2. Ses variables d'environnement sont préfixées par le nom de l'outil (ex. `SECTION_CLAUDE_…`). Seules `ASANA_PAT`, `ADMIN_KEY` et les variables Redis sont communes.
3. Ses clés Redis passent par `kvFor("<outil>")`.
4. Une section dans ce README : rôle, routes, variables, mise en service, comment le couper.

## Variables communes

| Variable | Rôle |
|---|---|
| `ASANA_PAT` | Jeton d'accès personnel Asana dédié à cette app |
| `ADMIN_KEY` | Clé de 24 caractères ou plus pour les routes d'administration (en-tête `x-admin-key`) |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | Base Upstash Redis dédiée à cette app (ou `UPSTASH_REDIS_REST_URL` / `_TOKEN`) |

## Outil 1 : asana-section-claude

Déposer une tâche dans la section ✳️CLAUDE de Mes tâches (Asana, espace Rosemarie Records) lance la routine claude.ai « Exécution tâches Asana Claude » sur cette tâche, en général dans la minute. Le passage horaire de la routine reste le filet de sécurité, notamment pour les réponses aux questions ⚠️ (un commentaire ne déclenche rien en temps réel).

```
Asana (ajout d'une tâche à Mes tâches)
  → POST /api/asana-section-claude/webhook (signature HMAC vérifiée)
  → relecture de la tâche : non complétée, assignée à Olivier, section ✳️CLAUDE, titre sans 🔄
  → verrou par tâche (30 min) + plafond quotidien (Redis)
  → POST /fire de la routine (texte : version + GID seulement)
```

Garde-fous :
- La poignée de main Asana n'est acceptée que pendant les 2 minutes ouvertes par `/register` : personne ne peut remplacer le secret en créant son propre webhook vers cette URL.
- Aucun texte saisi dans Asana ne transite vers la routine : elle relit la tâche elle-même.
- Les renommages faits par la routine (🔄 ✅ ⚠️ ❌) sont des événements `changed`, ignorés : pas de boucle.
- Redis en erreur : aucun déclenchement (fermé par défaut).
- Le jeton de routine ne peut partir que vers `https://api.anthropic.com/v1/claude_code/routines/trig_…/fire`.

| Variable | Rôle |
|---|---|
| `SECTION_CLAUDE_ROUTINE_FIRE_URL` | URL /fire de la routine (donnée par claude.ai/code à l'ajout du déclencheur API) |
| `SECTION_CLAUDE_ROUTINE_TOKEN` | Jeton du déclencheur API (`sk-ant-oat01-…`), affiché une seule fois |
| `SECTION_CLAUDE_MAX_FIRES_PER_DAY` | Optionnel, 20 par défaut ; `0` coupe sans retirer le jeton |
| `SECTION_CLAUDE_SECTION_GID`, `SECTION_CLAUDE_USER_GID`, `SECTION_CLAUDE_WORKSPACE_GID` | Optionnels, valeurs par défaut dans `lib/asana-section-claude/core.js` |

Mise en service :
1. Variables posées, déploiement en production. `GET /api/asana-section-claude/webhook` répond `{ ok, redis, fire }`.
2. Inscription du webhook (PowerShell) :
   `curl.exe -X POST https://<domaine>/api/asana-section-claude/register -H "x-admin-key: <ADMIN_KEY>"`
3. Vérification : `curl.exe https://<domaine>/api/asana-section-claude/register -H "x-admin-key: <ADMIN_KEY>"` liste le webhook et la date du dernier événement reçu.
4. Test : déposer une tâche dans ✳️CLAUDE ; le titre doit passer à 🔄 dans la minute.

Couper : `SECTION_CLAUDE_MAX_FIRES_PER_DAY=0`, ou supprimer le webhook dans Asana. La routine continue son passage horaire.

## Tests

`npm test` : bancs hors réseau (Asana, Redis et /fire simulés).
