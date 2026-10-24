# AuditFlow

Plateforme d'audit **IA & performance** pour cabinets de conseil : on importe les fichiers d'une entreprise
(exports CSV/XLSX, contrats, procédures, emails, rapports), AuditFlow reconstruit son organisation et ses
processus, détecte les irritants, chiffre les opportunités, propose une roadmap et produit un rapport dirigeant.
**Chaque chiffre est relié à sa source** et qualifié de *fait*, *calcul* ou *hypothèse* ; le consultant valide,
corrige ou rejette chaque conclusion avant publication.

Pour travailler sur le projet (humain ou Claude Code), lire d'abord [`CLAUDE.md`](CLAUDE.md).

Construit à partir du cahier des charges `docs/kit/specs-claude.md` (ordre de construction du §18), de la
maquette `docs/kit/mockup.html` et du jeu de démonstration `demo-data/` (3 entreprises fictives).

## Démarrage rapide

### Avec Docker

```bash
cp .env.example .env && ./deploy/gen-secrets.sh >> .env
docker compose up --build
docker compose exec api python -m app.seed --analyze   # charge et analyse les 3 entreprises de démo
```

Puis <http://localhost:3000>. Les comptes de démo utilisent le mot de passe `AUDITFLOW_DEMO_PASSWORD` de `.env`.
Stockage objet S3 (MinIO, chiffrement au repos) : `docker compose -f docker-compose.yml -f docker-compose.s3.yml up --build`.

### En local (développement)

Prérequis : Python 3.11+, [uv](https://docs.astral.sh/uv/), Node 22, PostgreSQL 16, et Pango pour les PDF
(`apt install libpango-1.0-0 libpangoft2-1.0-0 fonts-dejavu-core`). Installation pas à pas sur Windows
(PowerShell natif ou WSL2) : voir [`CLAUDE.md`](CLAUDE.md), §4.

```bash
# API
cd backend
cp .env.example .env                            # base locale, AUDITFLOW_SECRET_KEY=$(openssl rand -hex 32)
uv sync --extra dev
uv run python -m app.seed --reset --analyze     # migrations + démo analysée (≈ 10 s)
uv run uvicorn app.main:app --reload            # http://localhost:8000/api/docs

# Web
cd frontend
npm ci
npm run dev                                     # http://localhost:3000, proxy /api → localhost:8000
```

Sans Redis, les traitements tournent dans un thread de l'API (`AUDITFLOW_JOB_BACKEND=thread`) ; en production,
`rq` + `python -m app.worker`.

### Comptes de démonstration

| Compte | Rôle | Voit |
|---|---|---|
| `consultant@auditflow.demo` | Consultant | les 3 entreprises, édition et validation |
| `admin@auditflow.demo` | Administrateur plateforme | tout, plus coefficients de scoring, rétention, suppression |
| `dirigeant@atlaspro.demo` | Dirigeant | AtlasPro, lecture, contestation, rapport publié |
| `finance@atlaspro.demo` | Responsable métier (Finance) | AtlasPro, constats Finance uniquement |
| `dirigeant@darna.demo`, `dirigeant@maghrebpack.demo` | Dirigeant | leur entreprise |

Mot de passe : `demo-auditflow` en développement, `AUDITFLOW_DEMO_PASSWORD` sinon.

## Parcours (spec §9 et §15)

1. **Portefeuille** : les entreprises suivies, avancement, potentiel et confiance de l'analyse.
2. **Mission** : objectifs, guide d'entretiens, import par glisser-déposer (dossiers entiers, dédoublonnage par
   empreinte, versions), lancement de l'analyse avec progression.
3. **Sources** : bibliothèque classée, visionneuse (lignes et cellules surlignées), recherche hybride citée.
4. **Processus** : cartographie reconstruite + business graph éditable (organisation, outils, flux, irritants).
5. **Irritants** : constats classés par criticité, métriques avec formule et nature, preuves cliquables.
6. **Opportunités** : matrice impact/effort, catégorie justifiée (pas d'IA si une règle suffit), score détaillé.
7. **Business case** : simulateur ROI en direct, chaque hypothèse sourcée et modifiable.
8. **Roadmap** : 30/60/90 jours (glisser-déposer) et portefeuille 12 mois, dépendances respectées.
9. **Rapport** : synthèse dirigeant éditable, constats, business cases, roadmap, annexes de preuves ; export PDF ;
   publication qui fige une version HTML + PDF, seule visible par le client.

Chaque élément généré passe par *À vérifier → Validé / Corrigé / Rejeté* ; les modifications humaines sont
conservées lors des analyses suivantes et tracées (qui, quand, quoi).

## Architecture

```
frontend/   Next.js 16 · React 19 · TypeScript · Tailwind 4 · SWR · React Flow
backend/    FastAPI · SQLAlchemy 2 · Alembic · PostgreSQL · RQ/Redis · S3 ou disque · WeasyPrint
  app/ingestion/   parseurs CSV/XLSX/DOCX/PDF/TXT/MD/EML, classification, découpage
  app/engine/      sémantique des colonnes, extraction, graphe, 16 détecteurs, opportunités, ROI, scoring, roadmap
  app/ai/          fournisseur LLM optionnel (classification uniquement), embeddings locaux
  app/services/    ingestion, pipeline, revue humaine, rapport, rétention, stockage
  evals/           évaluation sur le corrigé du kit (seul code autorisé à lire ground_truth.json)
docs/evals/       dernier rapport d'évaluation
```

- **Aucun chiffre ne vient d'un LLM.** Détection et calculs sont déterministes (règles sur les concepts des
  colonnes, pas sur les noms de fichiers). Le LLM (Claude, désactivé par défaut) ne sert qu'à classer les
  documents ambigus, sur un texte dont les données personnelles sont masquées.
- **Multi-tenant** : chaque ligne porte `organization_id` ; toute requête passe par un contexte de mission qui
  répond 404 hors de l'organisation de l'utilisateur.
- **Recherche** : BM25 + vecteurs (embeddings locaux par hachage, sans appel externe) fusionnés par RRF ; chaque
  résultat cite fichier et lignes.

## Évaluation (spec §14)

`cd backend && uv run python -m evals --out ../docs/evals` relance tout le pipeline sur les 3 entreprises dans
une base jetable, puis note le résultat contre `ground_truth.json` et contre des recalculs indépendants depuis
les fichiers bruts. Dernier résultat ([rapport complet](docs/evals/report.md)) :

| Mesure | Résultat |
|---|---|
| Recall des 15 irritants plantés | 15/15 (14 étayés par les données, 1 signalé « hypothèse à valider » faute de données de prévision) |
| Irritants étayés par une preuve vérifiée ou signalés en hypothèse | 100 % |
| Fidélité des preuves (relues dans le fichier d'origine) | 100 % |
| Métriques clés recalculées indépendamment | 100 % |
| Business cases recalculés indépendamment | 100 % |
| Éléments sans preuve ni statut d'hypothèse | 0 |
| Nombres non traçables dans les textes générés | 0 |
| Ré-analyse identique / τ de Kendall min. sous ±20 % de coefficients | oui / 0,86 |

Le test `tests/test_evals.py` vérifie aussi que l'évaluateur détecte des fautes injectées (extrait falsifié,
métrique dérivée, ROI incohérent, chiffre inventé, irritant sans preuve).

## Sécurité (spec §12)

RBAC (administrateur, consultant, dirigeant, responsable métier avec périmètre de département) ; isolation
stricte par organisation ; session en cookie httpOnly + en-tête anti-CSRF ; en-têtes de sécurité et CSP stricte
sur le rapport ; journal d'audit sans contenu ; masquage des données personnelles avant tout appel LLM et dans
les logs ; chiffrement au repos des fichiers en S3 (SSE) ; rétention configurable par organisation
(`python -m app.services.retention`, à planifier chaque jour) ; suppression complète d'une mission (base +
fichiers) ; secrets uniquement par variables d'environnement (`AUDITFLOW_*`).

## Tests et CI

```bash
cd backend && uv run pytest                       # SQLite ; TEST_DATABASE_URL=postgresql+psycopg://… pour PostgreSQL
cd backend && uv run ruff check . && uv run ruff format --check .
cd frontend && npm run lint && npm run typecheck && npm test
cd frontend && npm run e2e                        # Playwright, sur une pile démarrée avec la démo analysée
```

`.github/workflows/ci.yml` exécute lint, tests (SQLite et PostgreSQL), vérification des migrations, évaluations,
build du front, parcours Playwright et build des images Docker.

## Limites connues

- Le kit annonce « 40+ sources » par entreprise : les dossiers en contiennent 37, 37 et 38 une fois le corrigé
  (`ground_truth.json`, `manifest.json`) exclu.
- Les procédures et emails du kit sont très similaires d'une entreprise à l'autre ; l'essentiel du signal vient
  des CSV. Les valeurs par opportunité sont en général plus prudentes que les estimations du kit (ratio médian
  ≈ 0,5), les totaux par entreprise restant proches (1,60 / 1,37 / 2,06 M MAD/an contre 1,40 / 1,22 / 2,11) ;
  l'écart est publié dans le rapport d'évaluation, pas masqué.
- Images Docker et compose non exécutés dans l'environnement de développement (pas de démon Docker) : ils sont
  construits et démarrés par la CI.
- Pas d'OCR des PDF scannés, pas de connecteurs ERP directs, pas de SSO (hors périmètre MVP, spec §17).
