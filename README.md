# asana-rosemarie-section-claude

Automatisations d'Olivier Grenier-Robert dans le cadre de ses fonctions chez Rosemarie Records. Indépendant du portail interne : aucun code, secret ni base partagés.

## Outil 1 : déclencheur de la section ✳️CLAUDE

Déposer une tâche dans la section ✳️CLAUDE de Mes tâches (Asana, espace Rosemarie Records) lance la routine claude.ai « Exécution tâches Asana Claude » sur cette tâche, en général dans la minute. Le passage horaire de la routine reste le filet de sécurité, notamment pour les réponses aux questions ⚠️ (un commentaire ne déclenche rien en temps réel).

```
Asana (ajout d'une tâche à Mes tâches)
  → POST /api/webhook (signature HMAC vérifiée)
  → relecture de la tâche : non complétée, assignée à Olivier, section ✳️CLAUDE, titre sans 🔄
  → verrou par tâche (30 min) + plafond quotidien (Redis)
  → POST /fire de la routine (texte : version + GID seulement)
```

Garde-fous :
- La poignée de main Asana n'est acceptée que pendant les 2 minutes ouvertes par `/api/register` : personne ne peut remplacer le secret en créant son propre webhook vers cette URL.
- Aucun texte saisi dans Asana ne transite vers la routine : elle relit la tâche elle-même.
- Les renommages faits par la routine (🔄 ✅ ⚠️ ❌) sont des événements `changed`, ignorés : pas de boucle.
- Redis en erreur : aucun déclenchement (fermé par défaut).
- Le jeton de routine ne peut partir que vers `https://api.anthropic.com/v1/claude_code/routines/trig_…/fire`.

### Variables d'environnement (Vercel)

| Variable | Rôle |
|---|---|
| `ROUTINE_FIRE_URL` | URL /fire de la routine (donnée par claude.ai/code à l'ajout du déclencheur API) |
| `ROUTINE_TOKEN` | Jeton du déclencheur API (`sk-ant-oat01-…`), affiché une seule fois |
| `ASANA_PAT` | Jeton d'accès personnel Asana dédié à ce relais |
| `ADMIN_KEY` | Clé de 24 caractères ou plus pour `/api/register` |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | Upstash Redis (ou `UPSTASH_REDIS_REST_URL` / `_TOKEN`) |
| `MAX_FIRES_PER_DAY` | Optionnel, 20 par défaut ; `0` coupe sans retirer le jeton |
| `ASANA_SECTION_GID`, `ASANA_USER_GID`, `ASANA_WORKSPACE_GID` | Optionnels, valeurs par défaut dans `lib/core.js` |

### Mise en service

1. Variables posées, déploiement en production.
2. Inscription du webhook (PowerShell) :
   `curl.exe -X POST https://<domaine>/api/register -H "x-admin-key: <ADMIN_KEY>"`
3. Vérification : `curl.exe https://<domaine>/api/register -H "x-admin-key: <ADMIN_KEY>"` liste le webhook et la date du dernier événement reçu.
4. Test : déposer une tâche dans ✳️CLAUDE, le titre doit passer à 🔄 dans la minute.

Couper : `MAX_FIRES_PER_DAY=0`, ou supprimer le webhook dans Asana. La routine continue son passage horaire.

### Tests

`npm test` : banc hors réseau (Asana, Redis et /fire simulés).

## Ajouter un outil

Un fichier par point d'entrée dans `api/`, sa logique dans `lib/`, ses variables documentées ici. Aucun outil ne lit les secrets d'un autre.
