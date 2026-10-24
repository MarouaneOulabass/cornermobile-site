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
- État : les 10 étapes de l'ordre de construction (§18) sont faites. Évaluations au vert (`docs/evals/report.md`).

**Dépôt et branche** : le code vit sur la branche `claude/new-session-s0mlha` du dépôt
`MarouaneOulabass/cornermobile-site`. Son historique est **indépendant** de `master` (qui contient un autre site) :
ne jamais fusionner cette branche dans `master`. Elle pourra être poussée telle quelle dans un dépôt dédié.

## 2. Règles non négociables

1. **Le moteur ne lit jamais le corrigé.** `ground_truth.json` et `manifest.json` sont exclus à l'import
   (`DEMO_EXCLUDE` dans `backend/app/services/pipeline.py`). Seul `backend/evals/` (`evals/ground_truth.py`) les
   ouvre. Rien sous `backend/app/` n'importe `evals` ni ne mentionne `ground_truth` (test :
   `tests/test_evals.py::test_engine_never_reads_the_answer_key`). Ne jamais ajuster le moteur pour « coller » aux
   valeurs du corrigé : on corrige la détection ou la traçabilité, pas les chiffres.
2. **Aucun chiffre ne vient d'un LLM.** Détection, métriques, ROI et scoring sont des fonctions déterministes. Le
   LLM (Claude, `AUDITFLOW_LLM_PROVIDER=anthropic`, désactivé par défaut) ne sert qu'à classer des documents
   ambigus, sur un texte dont les données personnelles sont masquées (`app.security.redact`).
3. **Evidence-first.** Chaque irritant, métrique, opportunité et hypothèse « fait/calcul » est relié à au moins une
   `Evidence` (lignes de texte, lignes/cellules de CSV, agrégat) — ou explicitement marqué hypothèse. Chaque nombre
   écrit dans un titre, une description ou une recommandation doit être traçable (calcul, preuve, hypothèse, seuil
   déclaré dans `engine/benchmarks.py`, ou nombre présent dans une source texte). Les évals le vérifient.
4. **Nature de chaque valeur** : `fait` (lu dans une source), `calcul` (dérivé de faits), `hypothese` (benchmark
   ou estimation, toujours avec une justification dans `source`). Une convention (ex. 8 h/jour) est une hypothèse.
5. **Isolation multi-tenant.** Toute route mission passe par `MissionCtx` (`app/api/deps.py`) ; tout objet chargé
   par id passe par `get_owned(db, ctx, Model, id)`. Hors de son organisation, un utilisateur reçoit **404** (jamais
   403), comme si l'objet n'existait pas. Chaque nouvelle route doit avoir un test d'isolation.
6. **Rôles** : `admin` (plateforme), `consultant` (écriture), `executive` (dirigeant, lecture + contestation),
   `business_owner` (lecture limitée à son `department_scope`). `ctx.require_write()` / `ctx.require_admin()`. Les
   clients ne voient jamais les éléments rejetés ; ils ne lisent que la version **publiée** du rapport.
7. **Les modifications humaines survivent aux ré-analyses.** Les objets « revus » (`ReviewableMixin`) gardent
   `edited_fields`, `generated` (dernière valeur machine) et `validation_status`. La réconciliation se fait par clé
   stable (`code` des irritants/opportunités, `key` des hypothèses, `generated["key"]` des recommandations et items
   de roadmap). Un champ listé dans `edited_fields` n'est jamais écrasé par le moteur.
8. **Journal d'audit sans contenu** : `services/audit_log.record(...)` n'accepte que des clés de détail
   autorisées (identifiants, compteurs, statuts). Pas de texte client dans les logs.
9. **Secrets uniquement par variables d'environnement** (`AUDITFLOW_*`), jamais dans le code ni dans git
   (`.env` est ignoré).

## 3. Structure du dépôt

```
backend/                     FastAPI · SQLAlchemy 2 · Alembic · PostgreSQL · RQ · WeasyPrint (Python ≥ 3.11, uv)
  app/
    main.py                  création de l'app, CORS, garde CSRF, en-têtes de sécurité, routeurs sous /api
    config.py                Settings (préfixe AUDITFLOW_, lit backend/.env)
    db.py                    moteur, sessions, migrate() (Alembic)
    security.py              bcrypt, JWT, masquage PII, filtre de logs
    seed.py                  python -m app.seed [--reset] [--analyze] — comptes et missions de démo
    jobs.py / worker.py      jobs inline | thread | rq ; worker RQ (python -m app.worker)
    api/deps.py              auth (Bearer ou cookie af_session), OrgCtx/MissionCtx, get_owned
    api/routes/              auth, orgs, missions, documents, analysis, findings, opportunities, roadmap, report
    schemas/                 Pydantic (common, documents, analysis)
    models/                  tenancy, mission, documents, findings, collab (+ base : mixins, JSONType)
    domain/enums.py          rôles, statuts, catégories, natures, phases…
    ingestion/               parsers (CSV/XLSX/DOCX/PDF/TXT/MD/EML), classifier, chunking
    ai/                      provider (Null / Anthropic), embeddings (hachage local, pas d'appel externe)
    engine/                  le moteur d'analyse (voir §5)
    services/                ingestion, pipeline, search, review, business_case, report, missions, summary,
                             storage (local/S3), retention, audit_log
    templates/report.html.j2 gabarit du rapport (HTML écran + PDF)
  alembic/                   migrations (versions/9ad20df145fc_initial_schema.py)
  evals/                     évaluation sur le corrigé (python -m evals) — seul lecteur de ground_truth.json
  tests/                     pytest, un fichier par étape + evals + settings
  uv.lock, pyproject.toml, Dockerfile
frontend/                    Next.js 16 · React 19 · TypeScript 5.9 · Tailwind 4 · SWR · React Flow · Vitest · Playwright
  app/                       login, portefeuille (/), /new, /m/[missionId]/{onboarding,sources,processes,
                             pain-points,opportunities,opportunities/[oppId],business-case,roadmap,report,settings}
  components/                ui.tsx (Pill, Button, buttonClasses, Card, Stat, Drawer…), shell/, sources/, evidence/,
                             review/, graph/, findings/, opportunities/, business/, report/
  lib/                       api.ts (fetch + en-tête CSRF), types.ts, labels.ts, format.ts, assumptions.ts
  e2e/demo-flow.spec.ts      parcours de démo Playwright
  next.config.ts             proxy /api → AUDITFLOW_API_URL, en-têtes de sécurité des pages
demo-data/                   jeu de démonstration (ne pas modifier)
docs/kit/                    cahier des charges, maquette, README du kit
docs/evals/                  dernier rapport d'évaluation (report.md, results.json)
deploy/gen-secrets.sh        génère les secrets pour .env
docker-compose.yml           postgres, redis, api, worker, web (+ docker-compose.s3.yml : MinIO chiffré)
.github/workflows/ci.yml     lint, tests SQLite + PostgreSQL, migrations, evals, build front, e2e, images Docker
```

## 4. Installation et démarrage

### Local (recommandé pour développer ; sous Windows : dans WSL2 Ubuntu)

Prérequis : Python 3.11+ et `uv`, Node 22, PostgreSQL 16, Pango pour WeasyPrint
(`sudo apt install libpango-1.0-0 libpangoft2-1.0-0 libharfbuzz-subset0`).

```bash
# Base de données (une fois)
sudo -u postgres psql -c "CREATE USER auditflow WITH PASSWORD 'auditflow' CREATEDB;"
sudo -u postgres createdb -O auditflow auditflow
sudo -u postgres createdb -O auditflow auditflow_test

# API
cd backend
cp .env.example .env            # puis renseigner AUDITFLOW_SECRET_KEY (openssl rand -hex 32)
uv sync --extra dev
uv run python -m app.seed --reset --analyze    # migrations + 3 entreprises importées et analysées
uv run uvicorn app.main:app --reload           # http://localhost:8000/api/docs

# Web (autre terminal)
cd frontend
npm ci
npm run dev                                    # http://localhost:3000 (proxy /api → localhost:8000)
```

`Settings` lit `backend/.env` (répertoire courant). Sans Redis, les jobs tournent dans un thread de l'API
(`AUDITFLOW_JOB_BACKEND=thread`, défaut). Sans `AUDITFLOW_SECRET_KEY`, une clé éphémère est générée en dev (les
sessions sautent à chaque redémarrage) ; elle est obligatoire en `AUDITFLOW_ENV=prod`.

### Docker

```bash
cp .env.example .env && sh deploy/gen-secrets.sh >> .env
docker compose up --build
docker compose exec api python -m app.seed --analyze
```

L'image API exécute `alembic upgrade head` au démarrage. Le proxy `/api` du front est figé au build
(`AUDITFLOW_API_URL`, argument de build, `http://api:8000` par défaut). La pile Docker n'a jamais été exécutée
dans l'environnement où elle a été écrite (pas de démon) : en cas d'échec, corriger les Dockerfiles / compose.

### Comptes de démo

Mot de passe : `demo-auditflow` en dev, sinon `AUDITFLOW_DEMO_PASSWORD` (obligatoire en prod pour seeder).

| Email | Rôle |
|---|---|
| admin@auditflow.demo | administrateur plateforme (tout + scoring, rétention, suppression) |
| consultant@auditflow.demo | consultant sur les 3 entreprises |
| dirigeant@atlaspro.demo | dirigeant AtlasPro |
| finance@atlaspro.demo | responsable métier AtlasPro, périmètre Finance |
| dirigeant@darna.demo / dirigeant@maghrebpack.demo | dirigeants |

### Variables d'environnement (backend, préfixe `AUDITFLOW_`)

`ENV` (dev/test/prod) · `DATABASE_URL` · `SECRET_KEY` · `ACCESS_TOKEN_MINUTES` · `COOKIE_SECURE` (true derrière
HTTPS) · `STORAGE_BACKEND` (local/s3) · `STORAGE_DIR` · `S3_ENDPOINT_URL`, `S3_BUCKET`, `S3_ACCESS_KEY`,
`S3_SECRET_KEY`, `S3_REGION`, `S3_SERVER_SIDE_ENCRYPTION` · `JOB_BACKEND` (inline/thread/rq) · `REDIS_URL` ·
`LLM_PROVIDER` (none/anthropic) · `LLM_MODEL` · `ANTHROPIC_API_KEY` · `LLM_REDACT_PII` · `MAX_UPLOAD_MB` ·
`MAX_FILES_PER_UPLOAD` · `CORS_ORIGINS` (JSON) · `DEMO_DATA_DIR` · `DEMO_PASSWORD`.
Front : `AUDITFLOW_API_URL`. Tests : `TEST_DATABASE_URL`. E2E : `E2E_BASE_URL`, `E2E_PASSWORD`.

## 5. Commandes de travail

```bash
# Backend (depuis backend/)
uv run pytest                                   # SQLite en mémoire (~3 min, inclut les évals)
TEST_DATABASE_URL=postgresql+psycopg://auditflow:auditflow@localhost:5432/auditflow_test uv run pytest
uv run pytest tests/test_step9_report.py -x     # un fichier
uv run ruff check . && uv run ruff format --check .      # lint (ligne max 110)
uv run ruff format . && uv run ruff check --fix .        # corriger
uv run python -m evals --out ../docs/evals      # évaluations §14 ; code retour 1 si un seuil est raté
uv run alembic revision --autogenerate -m "…"   # après toute modification de modèle (contre PostgreSQL)
uv run alembic upgrade head && uv run alembic check      # aucune dérive modèle/migration
uv run python -m app.seed --reset --analyze     # repartir d'une base propre
uv run python -m app.services.retention --dry-run        # purge de rétention (à planifier chaque jour)

# Frontend (depuis frontend/)
npm run lint && npm run typecheck && npm test   # ESLint 9, tsc, Vitest
npm run build
npx playwright install --with-deps chromium     # une fois
npm run e2e                                     # nécessite API + web démarrés avec la démo fraîchement seedée
```

L'e2e **publie** le rapport d'AtlasPro : relancer `python -m app.seed --reset --analyze` avant de le rejouer.

## 6. Moteur d'analyse (`backend/app/engine/`)

Pipeline (`run.py::run_analysis`, appelé par le job `analyze`) :

1. `context.py` — `AnalysisContext.load` : jeux de données (CSV/XLSX) et textes de la mission ; helpers de
   citation `cite_rows`, `cite_aggregate`, `cite_lines`, `cite_document` (créent des `Evidence`) et `link`.
2. `semantics.py` — mapping des colonnes vers des **concepts** (`amount`, `days_overdue`, `issue`, `date`…) et
   des jeux vers des types (`quotes`, `receivables`, `inventory`, `tickets`, `interventions`, `purchases`,
   `maintenance`, `non_conformities`, `production`, `employees`, `org_chart`). La détection s'appuie sur ces
   concepts, **jamais sur les noms de fichiers**.
3. `extract.py` — organisation (départements, effectifs), processus (procédures parsées), contrats (montant, SLA,
   pénalité, lignes sources), KPI des rapports.
4. `organization.py`, `graph.py` — persistance de l'organisation, des processus et du business graph (upsert par
   clé ; les nœuds masqués / renommés par l'utilisateur sont préservés).
5. `detectors.py` — 16 détecteurs (`detect_manual_entry`, `detect_lost_quotes`, `detect_receivables`,
   `detect_dormant_stock`, `detect_support_dispersion`, `detect_sla`, `detect_manual_planning`,
   `detect_urgent_purchases`, `detect_maintenance`, `detect_quality`, `detect_production`, `detect_reporting`,
   `detect_field_reports`, `detect_invoicing_delay`, `detect_procedures`, `detect_forecast_gap`). Chacun renvoie des
   `Finding` avec `MetricSpec` (valeur, unité, formule, nature, **evidence**) et éventuellement un `RiskSpec`.
   Criticité calibrée (`graded`, part de « critique » ≤ 35 %, une hypothèse n'est jamais critique).
6. `pain_points.py` — persistance + réconciliation des irritants et métriques.
7. `opportunities.py` — 18 gabarits (`TEMPLATES`) qui transforment un irritant en `OpportunitySpec` : catégorie
   (`choose_category` : pas d'IA si une règle suffit), hypothèses `AssumptionSpec` (avec `metric_key` ou
   `evidence` pour toute valeur issue des données), lignes de valeur `ValueLine`. Helpers : `_volume`,
   `_metric_ev`, `_aggregate_ev`, `_revenue`, `extract_period` (période plausible des extraits non datés).
   `used_keys` retire toute hypothèse qui n'entre dans aucune formule. `opportunity_store.py` persiste et relie
   les preuves.
8. `roi.py` — moteur ROI pur : ligne « time » = heures/mois × coût horaire × 12 ; ligne « product » = Π facteurs ×
   annualisation ; payback = coût projet / (gain net / 12) ; ROI 12 mois = (net − projet)/projet ; ROI 36 mois =
   (3 × net − projet)/projet.
9. `scoring.py` — 11 sous-scores, priorité = Σ poids × sous-score − Σ pénalités ; poids par organisation
   (`ScoringModel`, éditable par l'admin) ; étiquettes P1/P2/P3 **par rang**.
   `services/business_case.py::recompute_mission` recalcule ROI, scores et rangs (après toute revue d'hypothèse).
10. `maturity.py` (maturité, complétude des données), `roadmap.py` (planification 30/60/90 j + trimestres,
    dépendances `DEPENDS_ON`, max 2 pilotes par phase), `recommendations.py` (synthèse, décision, une
    recommandation par P1, points à confirmer).
11. `benchmarks.py` — toutes les valeurs de référence (coût horaire 190 MAD/h, coût du capital 8 %, détention de
    stock 20 %, stock dormant 180 j…) ; surchargeables par mission (`mission.parameters`, page Paramètres).

Ajouter un détecteur : écrire `detect_x(env) -> list[Finding]` en citant chaque métrique, l'enregistrer dans
`run_detectors`, ajouter un gabarit dans `TEMPLATES` si besoin, un test, puis relancer `python -m evals`.

## 7. API (`/api`, docs sur `/api/docs`)

- `auth` : `POST /auth/login` (pose le cookie httpOnly `af_session`), `/logout`, `GET /auth/me`.
- `orgs` : `/portfolio`, `/orgs`, `/orgs/{id}` (PATCH ; `retention_days` admin), `/orgs/{id}/missions`,
  `/orgs/{id}/members`.
- `missions/{id}` : `""` (GET/PATCH/DELETE admin), `/stats`, `/summary`, `/benchmarks` (GET/PUT).
- `documents` : upload multipart (202 + job), liste/filtres, `/lines`, `/download`, reclassement, `/tables/{id}`,
  `/search` (hybride BM25 + vecteurs, RRF, citations), `/jobs`.
- `analysis` : `/analyze`, `/graph` (CRUD nœuds/arêtes), `/processes`, `/evidence`, `/review/{type}/{id}`
  (statut + modifications champ par champ, historique), `/comments` (commentaire / contestation).
- `findings` : `/pain-points`, `/metrics/{id}`, `/risks`.
- `opportunities` : liste/tri, détail, `/simulate`, `/scoring-model` (PUT admin), `/overview`.
- `roadmap` : GET/POST, DELETE (409 sur un élément généré : le rejeter plutôt).
- `report` : `/report` (JSON, consultant), `/report/html` (consultant : brouillon vivant ; client : snapshot
  publié), `/recommendations`, `/publication` (reste à revoir), `/publish` (409 si non revu sans
  `acknowledge_unreviewed`), `/unpublish`, `/exports` (PDF/HTML brouillon), `/exports/{id}/download`.

Sécurité transverse : écritures authentifiées par cookie → en-tête `X-Requested-With: auditflow` obligatoire
(`lib/api.ts` l'ajoute) ; l'API pose `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy` (Next.js n'ajoute pas
ses en-têtes aux réponses proxifiées `/api`) ; le rapport HTML a une CSP sans script et `SAMEORIGIN`.

## 8. Conventions

- **Langue** : interface, libellés, textes générés et rapport en **français** ; code, identifiants et commentaires
  en anglais. Montants via `fmt.mad()` côté back, `format.ts` côté front.
- **Python** : ruff (lignes ≤ 110, isort), `from __future__ import annotations`, SQLAlchemy 2 typé
  (`Mapped[...]`), Pydantic v2. Commentaires rares, qui expliquent le *pourquoi*.
- **Front** : composants client avec SWR (`useSWR(path)`, fetcher global sur `/api`), `useMission()` pour la
  mission / le rôle / `canWrite`, primitives de `components/ui.tsx`, couleurs du thème (`text-value`, `bg-info-soft`…).
  Pas de `setState` synchrone dans un `useEffect` (règle ESLint) : initialiser un formulaire via un composant
  enfant `key`é. Liens stylés en bouton : `buttonClasses()`, jamais `<a><Button/></a>`.
- **Tests** : chaque fonctionnalité a son test pytest (fixtures `client`, `db`, `seeded`, helper `login()`), y
  compris rôles et isolation. Les tests doivent passer sur SQLite **et** PostgreSQL.
- **Migrations** : toute modification de modèle = nouvelle révision Alembic autogénérée contre PostgreSQL, relue,
  puis `alembic check`. Les tests utilisent `create_all`, la prod et le seed utilisent les migrations.
- **Commits** : messages en anglais à l'impératif, préfixés par l'étape ou le domaine (« Step 9: … »,
  « Fix: … »), corps listant les changements.
- **Après un changement du moteur** : `uv run pytest` puis `uv run python -m evals --out ../docs/evals` et
  commiter le rapport mis à jour.

## 9. Pièges connus

- WeasyPrint a besoin de Pango/HarfBuzz au niveau système ; sous Windows natif c'est pénible → WSL2 ou Docker.
- Le venv créé par `uv` ne contient pas `pip` : utiliser `uv add`, `uv sync`, `uv run`.
- SQLite renvoie des datetimes naïfs : comparer en UTC (voir `_aware` dans `services/report.py`).
- `next.config.ts` → `headers()` ne s'applique pas aux réponses proxifiées `/api` : les en-têtes de sécurité de
  l'API sont posés par le middleware FastAPI.
- L'aperçu du rapport est un `<iframe sandbox src="/api/.../report/html">` (même origine) : un `srcdoc` casse les
  ancres `#E12` des preuves.
- Ne jamais lancer `pkill -f "next start"` depuis un shell dont la ligne de commande contient ce texte (il se tue
  lui-même) : passer par un script.
- `python -m app.seed --reset` supprime toutes les tables puis rejoue les migrations.
- Une ré-analyse ou une revue après publication remet la mission en « review » ; le client garde le snapshot publié
  jusqu'à republication.

## 10. Résultats d'évaluation et limites

Dernier `python -m evals` : recall 15/15 (dont 1 en hypothèse : prévisions commerciales de MaghrebPack, aucune
donnée de prévision), précision étayée 100 %, fidélité des preuves 100 %, métriques et business cases recalculés
à 100 %, 0 élément sans preuve, 0 nombre non traçable, ré-analyse déterministe, τ de Kendall min. 0,86 sous
±20 % de coefficients. Valeurs par opportunité plus prudentes que le kit (ratio médian ≈ 0,5), totaux proches
(1,60 / 1,37 / 2,06 M MAD/an contre 1,40 / 1,22 / 2,11).

Limites : le kit annonce « 40+ sources » mais il y en a 37/37/38 hors corrigé ; procédures et emails du kit très
répétitifs (le signal vient surtout des CSV) ; pile Docker et CI jamais exécutées (le workflow ne se déclenche
que sur `main` et les pull requests) ; tag MinIO de `docker-compose.s3.yml` non vérifié ; pas d'OCR, pas de
connecteurs ERP, pas de SSO (hors périmètre MVP, §17).

Pistes : faire tourner la CI (dépôt dédié ou PR), invitations d'utilisateurs, OCR des PDF scannés, connecteurs
ERP, SSO/SAML, juge LLM optionnel pour la qualité rédactionnelle de la synthèse.
