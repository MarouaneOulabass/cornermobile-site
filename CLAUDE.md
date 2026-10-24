# CLAUDE.md — AuditFlow

Guide de travail pour Claude Code (et pour tout développeur) sur ce dépôt. À lire en entier avant de modifier
quoi que ce soit.

## 1. Le projet en bref

AuditFlow est une plateforme d'**audit IA & performance** pour cabinets de conseil (marché marocain, interface en
français, montants en MAD). Un consultant importe les fichiers d'une entreprise (CSV/XLSX, contrats, procédures,
emails, rapports) ; l'application reconstruit l'organisation et les processus, détecte les irritants, chiffre les
opportunités (ROI déterministe), propose une roadmap 30/60/90 jours + 12 mois et produit un rapport dirigeant PDF.
Le consultant valide / corrige / rejette chaque conclusion avant publication au client.

- Cahier des charges : `docs/kit/specs-claude.md` (les § cités dans le code renvoient à ce fichier).
- Maquette de référence : `docs/kit/mockup.html`.
- Jeu de démo : `demo-data/` — 3 entreprises fictives (AtlasPro Distribution, Darna Facility Services,
  MaghrebPack Industries), chacune avec `data/*.csv`, `documents/**`, `company_profile.md`, **`ground_truth.json`
  et `manifest.json` (le corrigé — voir règle n°1)**.
- État : les 10 étapes du §18 sont faites, puis l'application a été portée de Python (FastAPI) vers une stack
  100 % TypeScript sur Vercel (migrations M0 à M6), avec **parité exacte** vérifiée contre les sorties de
  l'implémentation Python (`tests/golden/`). Le code Python a été supprimé ; il reste dans l'historique git
  jusqu'au commit `2f7b1da`.

**Dépôt et branche** : le code vit sur la branche `claude/new-session-s0mlha` du dépôt
`MarouaneOulabass/cornermobile-site`. Son historique est **indépendant** de `master` (qui contient un autre site) :
ne jamais fusionner cette branche dans `master`. Elle pourra être poussée telle quelle dans un dépôt dédié. Projet
autonome : son propre projet Vercel, sa propre base Neon, sa propre application Clerk.

## 2. Règles non négociables

1. **Le moteur ne lit jamais le corrigé.** `ground_truth.json` et `manifest.json` sont exclus à l'import
   (`DEMO_EXCLUDE` dans `server/services/pipeline.ts`). Seul `evals/` (`evals/groundTruth.ts`) les ouvre. Rien
   sous `server/`, `app/`, `lib/`, `components/` n'importe `evals/` ni ne mentionne `ground_truth` (test :
   `tests/evals.test.ts`, « are never reachable from the engine… »). Ne jamais ajuster le moteur pour « coller » aux
   valeurs du corrigé : on corrige la détection ou la traçabilité, pas les chiffres.
2. **Aucun chiffre ne vient d'un LLM.** Détection, métriques, ROI et scoring sont des fonctions déterministes. Le
   LLM (Claude via le Vercel AI SDK et l'AI Gateway, `AUDITFLOW_LLM_PROVIDER=gateway`, désactivé par défaut) ne
   sert qu'à classer des documents ambigus (`server/ai/provider.ts`), sur un texte dont les données personnelles
   sont masquées (`server/security.ts::redact`).
3. **Evidence-first.** Chaque irritant, métrique, opportunité et hypothèse « fait/calcul » est relié à au moins une
   preuve (`evidence` : lignes de texte, lignes/cellules de CSV, agrégat) — ou explicitement marqué hypothèse.
   Chaque nombre écrit dans un titre, une description ou une recommandation doit être traçable (calcul, preuve,
   hypothèse, seuil déclaré dans `server/engine/benchmarks.ts`, ou nombre présent dans une source texte). Les
   évals le vérifient.
4. **Nature de chaque valeur** : `fait` (lu dans une source), `calcul` (dérivé de faits), `hypothese` (benchmark
   ou estimation, toujours avec une justification dans `source`). Une convention (ex. 8 h/jour) est une hypothèse.
5. **Isolation multi-tenant.** Toute route mission passe par `missionContext(req, missionId)`
   (`server/auth/context.ts`) ; tout objet chargé par id passe par `getOwned(ctx, table, id)`. Hors de son
   organisation, un utilisateur reçoit **404** (jamais 403), comme si l'objet n'existait pas. Chaque nouvelle route
   doit avoir un test d'isolation.
6. **Rôles** : `admin` (plateforme), `consultant` (écriture), `executive` (dirigeant, lecture + contestation),
   `business_owner` (lecture limitée à son `department_scope`). `ctx.requireWrite()` / `ctx.requireAdmin()`. Les
   clients ne voient jamais les éléments rejetés ; ils ne lisent que la version **publiée** du rapport.
7. **Les modifications humaines survivent aux ré-analyses.** Les tables « revues » gardent `edited_fields`,
   `generated` (dernière valeur machine) et `validation_status`. La réconciliation se fait par clé stable (`code`
   des irritants/opportunités, `key` des hypothèses, `generated.key` des recommandations et items de roadmap). Un
   champ listé dans `edited_fields` n'est jamais écrasé par le moteur.
8. **Journal d'audit sans contenu** : `server/audit.ts::record(...)` n'accepte que des clés de détail autorisées
   (identifiants, compteurs, statuts). Pas de texte client dans les logs.
9. **Secrets uniquement par variables d'environnement**, jamais dans le code ni dans git (`.env*` ignorés sauf
   `.env.example`).
10. **Parité** : les fichiers de `tests/golden/` sont la référence. Un changement volontaire de comportement du
    moteur met à jour le fichier golden dans le même commit, avec l'explication dans le message.

## 3. Stack et structure du dépôt

Next.js 16 (App Router, Server Components, Turbopack ; `proxy.ts` remplace `middleware.ts`), React 19,
TypeScript 5.9, Tailwind 4, SWR, React Flow, Lucide · PostgreSQL (Neon en production via
`@neondatabase/serverless`, `pg` en local et en CI) avec SQL écrit à la main · Clerk · Vercel Blob · Vercel AI
SDK 7 + AI Gateway · unpdf, mammoth + cheerio, read-excel-file, jszip · @react-pdf/renderer + pdf-lib · Zod ·
Vitest + Playwright.

```
app/                         pages : login, portefeuille (/), /new, /m/[missionId]/{onboarding,sources,processes,
                             pain-points,opportunities,opportunities/[oppId],business-case,roadmap,report,settings}
  api/[...path]/route.ts     toute l'API : runtime nodejs, maxDuration 300, délègue à server/api
  layout.tsx                 ClerkProvider quand la clé publique Clerk est définie
proxy.ts                     clerkMiddleware quand Clerk est configuré, sinon passe-plat
components/                  ui.tsx (Pill, Button, buttonClasses, Card, Stat, Drawer…), shell/, sources/,
                             evidence/, review/, graph/, findings/, opportunities/, business/, report/
lib/                         api.ts (fetch + en-tête CSRF), upload.ts (multipart ou Blob direct), auth.ts,
                             types.ts, labels.ts, format.ts, assumptions.ts, hooks/
server/                      code serveur uniquement (import "server-only" là où il le faut)
  env.ts                     configuration validée par Zod (process.env)
  db.ts                      tag `sql`, Db (query/one/maybeOne/exec/insertMany), pool pg ou Neon, transaction()
  migrate.ts                 applique db/NNN_*.sql une seule fois chacun (verrou consultatif)
  http.ts                    HttpError → {detail}, body()/searchParams() Zod (422), garde CSRF, en-têtes
  api/router.ts, index.ts    routeur interne (ordre d'enregistrement), /health
  api/schemas.ts             schémas d'entrée Zod et listes de champs de sortie (pick)
  api/routes/                auth, orgs, missions, documents, analysis, findings, opportunities, roadmap,
                             report, system (/config, /cron/retention)
  auth/                      session.ts (Clerk ou cookie local signé), clerk.ts (miroir des organisations),
                             context.ts (OrgContext/MissionContext, getOwned)
  jobs.ts                    jobs en base ; exécutés après la réponse via after(), ou inline (tests, scripts)
  storage.ts                 Vercel Blob privé ou disque local ; clés org/<org>/mission/<mission>/…
  ingestion/                 parsers (CSV/XLSX/DOCX/PDF/TXT/MD/EML), classifier, chunking, embeddings (hachage)
  engine/                    le moteur d'analyse (voir §6)
  services/                  ingestion, pipeline, search, review, businessCase, report, missions, summary,
                             retention
  report/                    html.tsx (JSX → chaîne, runtime jsx/ maison), pdf.tsx (@react-pdf/renderer),
                             fonts/ (Inter, DejaVu, embarquées)
  lib/                       py.ts / pyre.ts (sémantique numérique et regex de Python, voir §9), csv.ts, fmt.ts
  seed.ts, maintenance.ts    entreprises et comptes de démo ; resetData (vider les tables)
  rows.ts, domain/enums.ts   formes des lignes SQL, rôles/statuts/catégories/natures/phases
db/001_initial.sql           schéma (colonnes json, pas jsonb : l'ordre des clés est conservé)
evals/                       évaluation sur le corrigé (npm run evals) — seul lecteur de ground_truth.json
scripts/                     migrate, seed, evals, retention, secrets ; env.ts charge .env.local puis .env
tests/                       Vitest serveur (intégration PostgreSQL, parité golden, API, évals) ; helpers/
tests/golden/                sorties de référence de l'implémentation Python (voir son README)
e2e/demo-flow.spec.ts        parcours de démo Playwright
vercel.json                  build = migrations + next build ; cron quotidien /api/cron/retention
.github/workflows/ci.yml     lint, typecheck, tests, évals, build, e2e (Node 22 + PostgreSQL 16)
docs/kit/, docs/evals/       cahier des charges et maquette ; dernier rapport d'évaluation
demo-data/                   jeu de démonstration (ne pas modifier)
```

## 4. Installation et démarrage

### Windows natif (PowerShell)

Seuls **Node 22+** et **PostgreSQL 16** sont nécessaires (pas de Python, pas de Docker, pas de bibliothèque
système : le PDF est produit en JavaScript avec des polices embarquées).

```powershell
# 1. Outils (une fois). Rouvrir PowerShell ensuite pour que le PATH soit à jour.
winget install -e --id Git.Git
winget install -e --id OpenJS.NodeJS.LTS
winget install -e --id PostgreSQL.PostgreSQL.16 --interactive   # noter le mot de passe « postgres » choisi
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned               # autorise npm dans PowerShell
git config --global user.name "Votre Nom"
git config --global user.email "vous@example.com"

# 2. Code
New-Item -ItemType Directory -Force "$HOME\projets" | Out-Null
cd "$HOME\projets"
git clone -b claude/new-session-s0mlha https://github.com/MarouaneOulabass/cornermobile-site.git auditflow
cd auditflow
npm ci

# 3. Bases de données (une fois ; demande le mot de passe « postgres »)
$pg = "C:\Program Files\PostgreSQL\16\bin"
& "$pg\psql.exe" -U postgres -c "CREATE USER auditflow WITH PASSWORD 'auditflow' CREATEDB;"
& "$pg\createdb.exe" -U postgres -O auditflow auditflow
& "$pg\createdb.exe" -U postgres -O auditflow auditflow_test

# 4. Configuration (une fois)
Copy-Item .env.example .env.local      # DATABASE_URL, TEST_DATABASE_URL, AUDITFLOW_DEV_AUTH=1…
npm run secrets                        # ajoute AUDITFLOW_SESSION_SECRET et CRON_SECRET (sans écraser)

# 5. Démo et application
npm run db:migrate
npm run seed -- --reset --analyze      # 3 entreprises importées et analysées
npm run dev                            # http://localhost:3000

# 6. Claude Code (autre terminal)
irm https://claude.ai/install.ps1 | iex
cd "$HOME\projets\auditflow"
claude
```

PostgreSQL tourne ensuite comme service Windows : les jours suivants, `npm run dev` suffit. Le clone utilise le
gestionnaire d'identifiants de Git pour Windows (connexion GitHub dans le navigateur si le dépôt est privé).
Variables ponctuelles en PowerShell : `$env:NOM = "valeur"`. Ne pas rediriger de sortie vers `.env.local` avec
`>>` (Windows PowerShell écrit en UTF-16) : `npm run secrets` écrit le fichier lui-même.

### Linux / macOS / WSL2

```bash
sudo -u postgres psql -c "CREATE USER auditflow WITH PASSWORD 'auditflow' CREATEDB;"
sudo -u postgres createdb -O auditflow auditflow
sudo -u postgres createdb -O auditflow auditflow_test
npm ci
cp .env.example .env.local && npm run secrets
npm run db:migrate && npm run seed -- --reset --analyze
npm run dev
```

### Configuration (`.env.local`, détail dans `.env.example`)

`next dev`/`next start` lisent `.env.local` et `.env` ; les scripts `npm run …` aussi (`scripts/env.ts`) ; les
variables déjà définies dans le shell gagnent.

- Base : `DATABASE_URL` (application), `TEST_DATABASE_URL` (vidée par `npm test`), `EVALS_DATABASE_URL`
  (vidée par `npm run evals`, défaut : `TEST_DATABASE_URL`), `AUDITFLOW_DB_DRIVER=neon` pour forcer le pilote Neon
  (détecté sinon par le nom d'hôte).
- Identité : `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` + `CLERK_SECRET_KEY` (Clerk actif dès que les deux sont là) ;
  sinon comptes locaux si `AUDITFLOW_DEV_AUTH=1` (jamais sur Vercel), avec `AUDITFLOW_SESSION_SECRET`
  (≥ 32 caractères) et `AUDITFLOW_DEMO_PASSWORD` (défaut `demo-auditflow`, obligatoire pour seeder sur Vercel).
- Fichiers : `BLOB_READ_WRITE_TOKEN` (Blob privé) sinon disque `AUDITFLOW_STORAGE_DIR` (défaut `var/storage`) ;
  `AUDITFLOW_MAX_UPLOAD_MB`, `AUDITFLOW_MAX_FILES_PER_UPLOAD`.
- IA : `AUDITFLOW_LLM_PROVIDER` (`none` | `gateway`), `AUDITFLOW_LLM_MODEL` (défaut `anthropic/claude-opus-5-5`),
  `AUDITFLOW_LLM_REDACT_PII` (défaut actif), `AI_GATEWAY_API_KEY` hors Vercel.
- Rétention : `CRON_SECRET` (Vercel Cron l'envoie en `Authorization: Bearer`).
- Divers : `AUDITFLOW_DEMO_DATA_DIR`, `AUDITFLOW_JOBS=inline` (scripts et tests). E2E : `E2E_BASE_URL`,
  `E2E_PASSWORD`.

### Comptes de démo (mode local)

Mot de passe : `demo-auditflow`, sinon `AUDITFLOW_DEMO_PASSWORD`.

| Email | Rôle |
|---|---|
| admin@auditflow.demo | administrateur plateforme (tout + scoring, rétention, suppression) |
| consultant@auditflow.demo | consultant sur les 3 entreprises |
| dirigeant@atlaspro.demo | dirigeant AtlasPro |
| finance@atlaspro.demo | responsable métier AtlasPro, périmètre Finance |
| dirigeant@darna.demo / dirigeant@maghrebpack.demo | dirigeants |

### Déploiement (Vercel + Neon + Clerk + Blob)

- Projet Vercel dédié ; intégrations Neon (`DATABASE_URL`, une branche de base par preview), Vercel Blob en
  accès **privé** (`BLOB_READ_WRITE_TOKEN`), Clerk (`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`) ;
  ajouter `CRON_SECRET`. `vercel.json` : build = `npm run db:migrate && npm run build`, cron quotidien de
  rétention.
- Clerk : activer les Organizations. Une organisation Clerk = une entreprise cliente ; créer une entreprise depuis
  l'application crée l'organisation Clerk. Rôles Clerk → AuditFlow : `org:admin`, `org:consultant` → consultant ;
  `org:executive`, `org:member` → dirigeant ; `org:business_owner` → responsable métier (département : métadonnée
  publique `department` de l'adhésion). Les adhésions sont recopiées dans `memberships` à la connexion et à
  l'ouverture du portefeuille (`server/auth/clerk.ts`).
- Administrateur plateforme : `{"platformAdmin": true}` dans les métadonnées publiques de l'utilisateur Clerk,
  **avant sa première connexion** (l'indicateur est lu à la création de la ligne `users` ; ensuite, mettre à jour
  `users.is_platform_admin`). C'est le seul moyen de voir les entreprises de démo, qui n'ont pas d'organisation
  Clerk.
- Démo sur un déploiement : `vercel env pull .env.local`, puis `npm run seed -- --analyze` depuis le poste (avec
  le jeton Blob, sinon les fichiers resteraient sur le disque local).
- Envoi des fichiers : sur Vercel (Blob configuré) le navigateur envoie chaque fichier directement dans Blob
  (`documents/blob-batch` → jeton `documents/blob-token` limité au dossier du lot → `documents/blob`
  enregistre le lot), car une fonction n'accepte que 4,5 Mo par requête ; en local, multipart vers l'API.

## 5. Commandes de travail

```bash
npm run dev                                   # http://localhost:3000
npm run lint && npm run typecheck             # ESLint 9 (config Next), tsc --noEmit
npm test                                      # Vitest : projets « ui » (jsdom) et « server » (PostgreSQL)
npm run test:server -- tests/api.report.test.ts   # un fichier ; -t "nom" pour un test
npm run evals -- --out docs/evals             # évaluations §14 ; code retour 1 si un seuil est raté
npm run db:migrate                            # migrations en attente sur DATABASE_URL
npm run seed -- --reset --analyze             # repartir d'une base propre (refusé sur Vercel)
npm run retention -- --dry-run                # purge de rétention (le cron Vercel appelle /api/cron/retention)
npm run secrets                               # secrets locaux manquants → .env.local
npm run build && npm start                    # build de production local
npx playwright install chromium               # une fois
npm run e2e                                   # sur npm start, AUDITFLOW_DEV_AUTH=1, démo fraîchement seedée
```

Les tests serveur tournent fichier par fichier sur une seule base (`TEST_DATABASE_URL`, schéma recréé au début de
chaque `npm test`). L'e2e **publie** le rapport d'AtlasPro : relancer `npm run seed -- --reset --analyze` avant
de le rejouer, avec `E2E_PASSWORD` = `AUDITFLOW_DEMO_PASSWORD`.

## 6. Moteur d'analyse (`server/engine/`)

Pipeline (`run.ts::runAnalysis`, appelé par le job `analyze`, dans une transaction) :

1. `context.ts` — `AnalysisContext` : jeux de données (CSV/XLSX) et textes de la mission ; citations `citeRows`,
   `citeAggregate`, `citeLines`, `citeDocument` (créent des preuves) et `link` ; `flush()` les persiste dans
   l'ordre de création.
2. `semantics.ts` — mapping des colonnes vers des **concepts** (`amount`, `days_overdue`, `issue`, `date`…) et
   des jeux vers des types (`quotes`, `receivables`, `inventory`, `tickets`, `interventions`, `purchases`,
   `maintenance`, `non_conformities`, `production`, `employees`, `org_chart`). La détection s'appuie sur ces
   concepts, **jamais sur les noms de fichiers**.
3. `extract.ts` — organisation (départements, effectifs), processus (procédures parsées), contrats (montant, SLA,
   pénalité, lignes sources), KPI des rapports.
4. `organization.ts`, `graph.ts` — persistance de l'organisation, des processus et du business graph (upsert par
   clé ; les nœuds masqués / renommés par l'utilisateur sont préservés).
5. `detectors.ts` — 16 détecteurs (`detectManualEntry`, `detectLostQuotes`, `detectReceivables`,
   `detectDormantStock`, `detectSupportDispersion`, `detectSla`, `detectManualPlanning`, `detectUrgentPurchases`,
   `detectMaintenance`, `detectQuality`, `detectProduction`, `detectReporting`, `detectFieldReports`,
   `detectInvoicingDelay`, `detectProcedures`, `detectForecastGap`). Chacun renvoie des `Finding` avec
   `MetricSpec` (valeur, unité, formule, nature, **evidence**) et éventuellement un `RiskSpec`. Criticité calibrée
   (`graded`, `calibrate` : part de « critique » ≤ 35 %, une hypothèse n'est jamais critique).
6. `painPoints.ts` — persistance + réconciliation des irritants, métriques et risques.
7. `opportunities.ts` — 18 gabarits (`TEMPLATES`) qui transforment un irritant en `OpportunitySpec` : catégorie
   (`chooseCategory` : pas d'IA si une règle suffit), hypothèses `AssumptionSpec` (avec métrique ou preuve pour
   toute valeur issue des données), lignes de valeur. `extractPeriod` (période plausible des extraits non datés),
   `usedKeys` retire toute hypothèse qui n'entre dans aucune formule. `opportunityStore.ts` persiste et relie les
   preuves.
8. `roi.ts` — moteur ROI pur : ligne « time » = heures/mois × coût horaire × 12 ; ligne « product » = Π facteurs ×
   annualisation ; payback = coût projet / (gain net / 12) ; ROI 12 mois = (net − projet)/projet ; ROI 36 mois =
   (3 × net − projet)/projet.
9. `scoring.ts` — 11 sous-scores, priorité = Σ poids × sous-score − Σ pénalités ; poids par organisation
   (`scoring_models`, éditable par l'admin) ; étiquettes P1/P2/P3 **par rang** (`labels`).
   `services/businessCase.ts::recomputeMission` recalcule ROI, scores et rangs (après toute revue d'hypothèse).
10. `maturity.ts` (maturité, complétude des données), `roadmap.ts` (30/60/90 j + trimestres, dépendances
    `DEPENDS_ON`, max 2 pilotes par phase), `recommendations.ts` (synthèse, décision, une recommandation par P1,
    points à confirmer).
11. `benchmarks.ts` — toutes les valeurs de référence (coût horaire 190 MAD/h, coût du capital 8 %, détention de
    stock 20 %, stock dormant 180 j…) ; surchargeables par mission (`audit_missions.parameters`, page Paramètres).

Ajouter un détecteur : écrire `detectX(env)` en citant chaque métrique, l'enregistrer dans `runDetectors`,
ajouter un gabarit dans `TEMPLATES` si besoin, un test, puis `npm run evals -- --out docs/evals` (et mettre à
jour les fichiers golden concernés, règle n°10).

## 7. API (`/api`, mêmes routes et mêmes formes JSON que l'API Python d'origine)

- `auth` : `POST /auth/login` (comptes locaux : cookie httpOnly `af_session` + jeton), `/logout`, `GET /auth/me`.
- `orgs` : `/portfolio`, `/orgs` (POST : crée aussi l'organisation Clerk), `/orgs/{id}` (PATCH ;
  `retention_days` admin), `/orgs/{id}/missions`, `/orgs/{id}/members`.
- `missions/{id}` : `""` (GET/PATCH/DELETE admin), `/stats`, `/summary`, `/benchmarks` (GET/PUT).
- `documents` : upload multipart (202 + job) ou Blob (`blob-batch`, `blob-token`, `blob`), liste/filtres,
  `/lines`, `/download`, reclassement, `/tables/{id}`, `/search` (hybride BM25 + vecteurs, RRF, citations),
  `/jobs`.
- `analysis` : `/analyze`, `/graph` (CRUD nœuds/arêtes), `/processes`, `/evidence`, `/review/{type}/{id}`
  (statut + modifications champ par champ, historique), `/comments` (commentaire / contestation).
- `findings` : `/pain-points`, `/metrics/{id}`, `/risks`.
- `opportunities` : liste/tri, détail, `/simulate`, `/scoring-model` (PUT admin), `/overview`.
- `roadmap` : GET/POST, DELETE (409 sur un élément généré : le rejeter plutôt).
- `report` : `/report` (JSON, consultant), `/report/html` (consultant : brouillon vivant ; client : snapshot
  publié), `/recommendations`, `/publication` (reste à revoir), `/publish` (409 si non revu sans
  `acknowledge_unreviewed`), `/unpublish`, `/exports` (PDF/HTML brouillon), `/exports/{id}/download`.
- `system` : `/health`, `/config` (mode d'identité et d'envoi des fichiers pour l'interface),
  `/cron/retention` (Bearer `CRON_SECRET`, `?dry_run=1`).

Sécurité transverse : écritures authentifiées par cookie → en-tête `X-Requested-With: auditflow` obligatoire
(`lib/api.ts` l'ajoute) ; `server/http.ts` pose `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy` sur l'API
(`next.config.ts` les pose sur les pages) ; le rapport HTML a une CSP sans script et `SAMEORIGIN`. Erreurs :
`{"detail": …}` avec les mêmes codes qu'avant (401, 403, 404, 409, 422, 503).

## 8. Conventions

- **Langue** : interface, libellés, textes générés et rapport en **français** ; code, identifiants et commentaires
  en anglais. Montants via `server/lib/fmt.ts` côté serveur, `lib/format.ts` côté interface.
- **TypeScript** : strict ; imports relatifs dans `server/`, `evals/`, `scripts/` (exécutés aussi par `tsx`),
  alias `@/` dans l'interface et les tests. Les lignes SQL restent en snake_case (`server/rows.ts`), comme les
  réponses JSON de l'API. Commentaires rares, qui expliquent le *pourquoi*.
- **SQL** : requêtes écrites à la main avec le tag `sql` (paramètres toujours liés, jamais concaténés) ; ordre
  explicite (`ORDER BY ordinal, …`) partout où l'ordre se voit ; insertions en lot via `db.insertMany`. Toute
  évolution du schéma = nouveau fichier `db/NNN_description.sql` (jamais modifier un fichier déjà appliqué en
  production).
- **Front** : composants client avec SWR (`useSWR(path)`, fetcher global sur `/api`), `useMission()` pour la
  mission / le rôle / `canWrite`, primitives de `components/ui.tsx`, couleurs du thème (`text-value`,
  `bg-info-soft`…). Pas de `setState` synchrone dans un `useEffect` (règle ESLint) : initialiser un formulaire via un
  composant enfant `key`é. Liens stylés en bouton : `buttonClasses()`, jamais `<a><Button/></a>`.
- **Tests** : chaque fonctionnalité a son test Vitest (`tests/helpers/client.ts` : `TestClient`, `login()`),
  y compris rôles et isolation. Les traitements tournent inline dans les tests (`AUDITFLOW_JOBS=inline`).
- **Commits** : messages en anglais à l'impératif, préfixés par l'étape ou le domaine (« Migration M6: … »,
  « Fix: … »), corps listant les changements.
- **Après un changement du moteur** : `npm test` puis `npm run evals -- --out docs/evals` et commiter le rapport.

## 9. Pièges connus

- **Parité numérique avec Python** : le moteur reproduit au chiffre près l'implémentation d'origine grâce à
  `server/lib/py.ts` — `pyRound`/`pyFixed` (arrondi au pair sur la valeur binaire exacte, pas `toFixed`), `sum`
  (compensation de Neumaier, comme Python ≥ 3.12), `fsum`, `fmean`, `mean` (moyenne exacte), `median`,
  `sortedBy` (tri stable, clés tuples), `truthy`/`pyOr`/`pyBool` (vérité à la Python), `pyCapitalize`,
  `splitlines`, `pyStrip`, et `server/lib/pyre.ts` pour les regex (`\w`, `\b` Unicode). Utiliser ces helpers dans
  le moteur, jamais `Math.round`, `toFixed` ou une somme naïve.
- **Colonnes `json`, pas `jsonb`** : `jsonb` réordonne les clés et casse la parité (rapport, preuves) ; caster en
  `jsonb` seulement pour les opérateurs (`payload::jsonb || …`). `insertMany` passe par `json_to_recordset`.
- **`tsx` ne charge pas @react-pdf/renderer** (sous-chemin ESM `@react-pdf/hyphenate/en-us`) : les scripts CLI ne
  produisent pas de PDF ; le rendu PDF se teste sous Vitest ou via le serveur Next.
- **@react-pdf/renderer** : pas de `render` sur un élément `fixed` (erreur « unsupported number -1.68e21 ») ; les
  numéros de page sont tamponnés après coup avec pdf-lib (`numberPages`). Le PDF n'est pas identique au PDF
  WeasyPrint d'origine (même contenu, mise en page proche).
- Next interdit `react-dom/server` dans un route handler : le rapport HTML utilise le runtime JSX maison
  (`/** @jsxImportSource @/server/report/jsx */`), qui échappe tout texte.
- Les polices du PDF sont lues sur disque : `next.config.ts` les inclut dans la fonction
  (`outputFileTracingIncludes`) ; @react-pdf/renderer et pdf-lib sont `serverExternalPackages`.
- `.gitattributes` force LF pour le code mais laisse `demo-data/` tel quel (ses CSV sont en CRLF, avec BOM) : ne
  jamais renormaliser le jeu de démo.
- Ne jamais lancer `pkill -f "next start"` (ou `next-server`) depuis un shell dont la ligne de commande contient ce
  texte : il se tue lui-même. Passer par `ps … | awk … | xargs kill`. Un ancien `next-server` resté actif sert un
  build périmé (« port in use ») : le tuer avant `npm start`.
- L'aperçu du rapport est un `<iframe sandbox src="/api/.../report/html">` (même origine) : un `srcdoc` casse les
  ancres `#E12` des preuves.
- Les traitements longs (`after()`) sont limités par `maxDuration = 300` s sur Vercel ; l'analyse des 3 dossiers
  de démo prend moins d'une seconde chacun.
- `npm run seed -- --reset` vide toutes les tables (refusé sur Vercel). `npm test` et `npm run evals` vident leur
  base : ne jamais les pointer sur `DATABASE_URL` (le script d'évals le refuse).
- Une ré-analyse ou une revue après publication remet la mission en « review » ; le client garde le snapshot publié
  jusqu'à republication.

## 10. Résultats d'évaluation et limites

Dernier `npm run evals` (identique à l'implémentation Python, `tests/golden/evals.json`) : recall 15/15 (dont 1
en hypothèse : prévisions commerciales de MaghrebPack, aucune donnée de prévision), précision étayée 100 %,
fidélité des preuves 100 %, métriques et business cases recalculés à 100 %, 0 élément sans preuve, 0 nombre non
traçable, ré-analyse déterministe, τ de Kendall min. 0,86 sous ±20 % de coefficients. Valeurs par opportunité plus
prudentes que le kit (ratio médian ≈ 0,5), totaux proches (1,60 / 1,37 / 2,06 M MAD/an contre 1,40 / 1,22 / 2,11).

Limites : le kit annonce « 40+ sources » mais il y en a 37/37/38 hors corrigé ; procédures et emails du kit très
répétitifs (le signal vient surtout des CSV) ; Clerk, Vercel Blob, l'AI Gateway et le déploiement Vercel n'ont pas
été exercés avec de vraies clés (tests et e2e en mode local) ; la CI ne se déclenche que sur `main`/`master` et les
pull requests ; pas d'OCR, pas de connecteurs ERP (hors périmètre MVP, §17).

Pistes : premier déploiement Vercel (Neon + Clerk + Blob) et passage de l'e2e en mode Clerk, invitations
d'utilisateurs, OCR des PDF scannés, connecteurs ERP, juge LLM optionnel pour la qualité rédactionnelle de la
synthèse.
