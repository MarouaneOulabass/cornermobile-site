# AuditFlow

Plateforme d'audit **IA & performance** pour cabinets de conseil : on importe les fichiers d'une entreprise
(exports CSV/XLSX, contrats, procédures, emails, rapports), AuditFlow reconstruit son organisation et ses
processus, détecte les irritants, chiffre les opportunités, propose une roadmap et produit un rapport dirigeant.
**Chaque chiffre est relié à sa source** et qualifié de *fait*, *calcul* ou *hypothèse* ; le consultant valide,
corrige ou rejette chaque conclusion avant publication.

Pour travailler sur le projet (humain ou Claude Code), lire d'abord [`CLAUDE.md`](CLAUDE.md).

Construit à partir du cahier des charges `docs/kit/specs-claude.md`, de la maquette `docs/kit/mockup.html` et du
jeu de démonstration `demo-data/` (3 entreprises fictives).

## Stack

Entièrement en TypeScript, déployée sur Vercel :

| Couche | Choix |
|---|---|
| Application | Next.js 16 (App Router, Turbopack), React 19, TypeScript 5.9, Tailwind 4, SWR, React Flow, Lucide |
| API | route handlers Next.js (`app/api/[...path]/route.ts`), validation Zod, traitements longs via `after()` |
| Base | PostgreSQL — Neon en production (`@neondatabase/serverless`), `pg` en local ; SQL écrit à la main, migrations numérotées dans `db/` |
| Identité | Clerk, une organisation Clerk par entreprise cliente (comptes locaux de démonstration hors Vercel) |
| Fichiers | Vercel Blob (privé), envoi direct depuis le navigateur ; disque local en développement |
| IA | Vercel AI SDK via AI Gateway (modèles Claude), uniquement pour classer des documents ambigus |
| Documents | unpdf (PDF), mammoth + cheerio (DOCX), read-excel-file (XLSX), jszip (métadonnées Office) ; rapport PDF avec @react-pdf/renderer + pdf-lib |
| Tests | Vitest (unitaires, intégration PostgreSQL, parité avec l'implémentation de référence), Playwright, évaluations |

## Démarrage sous Windows (PowerShell)

Prérequis : **Node 22+** et **PostgreSQL 16+** (17 vérifié). Rien d'autre (pas de Python, pas de Docker, pas de bibliothèque
système pour les PDF).

```powershell
# 1. Outils (une fois), puis rouvrir PowerShell
winget install -e --id Git.Git
winget install -e --id OpenJS.NodeJS.LTS
winget install -e --id PostgreSQL.PostgreSQL.16 --interactive   # noter le mot de passe « postgres »
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned               # autorise npm dans PowerShell

# 2. Code
New-Item -ItemType Directory -Force "$HOME\projets" | Out-Null
cd "$HOME\projets"
git clone -b claude/new-session-s0mlha https://github.com/MarouaneOulabass/cornermobile-site.git auditflow
cd auditflow
npm ci

# 3. Bases locales (une fois ; demande le mot de passe « postgres »)
$pg = "C:\Program Files\PostgreSQL\16\bin"   # adapter au numéro de version installé (ex. 17)
& "$pg\psql.exe" -U postgres -c "CREATE USER auditflow WITH PASSWORD 'auditflow' CREATEDB;"
& "$pg\createdb.exe" -U postgres -O auditflow auditflow
& "$pg\createdb.exe" -U postgres -O auditflow auditflow_test

# 4. Configuration (une fois)
Copy-Item .env.example .env.local
npm run secrets                       # ajoute AUDITFLOW_SESSION_SECRET et CRON_SECRET à .env.local

# 5. Démo analysée, puis l'application
npm run db:migrate
npm run seed -- --reset --analyze     # 3 entreprises importées et analysées (quelques secondes)
npm run dev                           # http://localhost:3000
```

Les jours suivants, `npm run dev` suffit (PostgreSQL tourne comme service Windows). Sous Linux/macOS, les mêmes
commandes npm s'appliquent (`cp .env.example .env.local`, bases créées avec `sudo -u postgres …`).

### Comptes de démonstration (mode local)

| Compte | Rôle | Voit |
|---|---|---|
| `consultant@auditflow.demo` | Consultant | les 3 entreprises, édition et validation |
| `admin@auditflow.demo` | Administrateur plateforme | tout, plus coefficients de scoring, rétention, suppression |
| `dirigeant@atlaspro.demo` | Dirigeant | AtlasPro, lecture, contestation, rapport publié |
| `finance@atlaspro.demo` | Responsable métier (Finance) | AtlasPro, constats Finance uniquement |
| `dirigeant@darna.demo`, `dirigeant@maghrebpack.demo` | Dirigeant | leur entreprise |

Mot de passe : `demo-auditflow`, ou la valeur de `AUDITFLOW_DEMO_PASSWORD`.

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
app/              pages (App Router) et l'API : app/api/[...path]/route.ts → server/api
components/, lib/ interface (client) : SWR, primitives UI, envoi des fichiers
server/           tout le code serveur
  api/            routeur, schémas Zod, une route par domaine (auth, orgs, missions, documents, analysis…)
  auth/           Clerk ou comptes locaux, contexte de mission (isolation par organisation)
  ingestion/      parseurs CSV/XLSX/DOCX/PDF/TXT/MD/EML, classification, découpage, embeddings locaux
  engine/         sémantique des colonnes, extraction, graphe, 16 détecteurs, opportunités, ROI, scoring, roadmap
  services/       pipeline, revue humaine, business case, rapport, rétention, recherche
  report/         rapport HTML (JSX → chaîne) et PDF (@react-pdf/renderer, polices embarquées)
db/               migrations SQL numérotées
evals/            évaluation sur le corrigé du kit (seul code autorisé à lire ground_truth.json)
scripts/          migrate, seed, evals, retention, secrets (npm run …)
tests/, e2e/      Vitest (dont parité avec tests/golden) et Playwright
docs/evals/       dernier rapport d'évaluation
```

- **Aucun chiffre ne vient d'un LLM.** Détection et calculs sont déterministes (règles sur les concepts des
  colonnes, pas sur les noms de fichiers). Le LLM (désactivé par défaut) ne sert qu'à classer les documents
  ambigus, sur un texte dont les données personnelles sont masquées.
- **Multi-tenant** : chaque ligne porte `organization_id` ; toute requête passe par un contexte de mission qui
  répond 404 hors de l'organisation de l'utilisateur.
- **Recherche** : BM25 + vecteurs (embeddings locaux par hachage, sans appel externe) fusionnés par RRF ; chaque
  résultat cite fichier et lignes.

## Déploiement sur Vercel

1. Importer le dépôt dans Vercel (projet dédié, framework Next.js ; `vercel.json` fixe la commande de build).
2. Ajouter depuis le Marketplace / Storage : **Neon** (fournit `DATABASE_URL`, une branche par preview),
   **Vercel Blob** en accès privé (`BLOB_READ_WRITE_TOKEN`) et **Clerk** (`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`,
   `CLERK_SECRET_KEY`). Dans Clerk : activer les Organizations ; rôles `org:admin`/`org:consultant` →
   consultant, `org:executive`/`org:member` → dirigeant, `org:business_owner` → responsable métier (département
   dans les métadonnées publiques de l'adhésion, clé `department`).
3. Variables à ajouter : `CRON_SECRET` (le cron quotidien de rétention s'authentifie avec), et si besoin
   `AUDITFLOW_LLM_PROVIDER=gateway` (AI Gateway, authentifié automatiquement sur Vercel).
4. Déployer : le build applique les migrations (`npm run db:migrate && npm run build`).
5. Démo (facultatif) : `vercel env pull .env.local` puis `npm run seed -- --analyze` depuis le poste, ce qui
   remplit Neon et Blob. Les entreprises de démo n'ont pas d'organisation Clerk : seul un administrateur
   plateforme les voit — mettre `{"platformAdmin": true}` dans les métadonnées publiques de l'utilisateur Clerk
   **avant** sa première connexion.

Sur Vercel, les comptes locaux sont toujours désactivés et l'envoi des fichiers passe directement du navigateur à
Blob (une fonction Vercel n'accepte que 4,5 Mo par requête).

## Évaluation (spec §14)

`npm run evals -- --out docs/evals` relance tout le pipeline sur les 3 entreprises dans une base jetable
(`EVALS_DATABASE_URL`, sinon `TEST_DATABASE_URL`), puis note le résultat contre `ground_truth.json` et contre des
recalculs indépendants depuis les fichiers bruts. Dernier résultat ([rapport complet](docs/evals/report.md)) :

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

`tests/evals.test.ts` vérifie aussi que l'évaluateur détecte des fautes injectées (extrait falsifié, métrique
dérivée, ROI incohérent, chiffre inventé, irritant sans preuve) et que ses résultats sont identiques à ceux de
l'implémentation de référence (`tests/golden/evals.json`).

## Sécurité (spec §12)

RBAC (administrateur, consultant, dirigeant, responsable métier avec périmètre de département) ; isolation
stricte par organisation ; Clerk en production, cookie de session httpOnly signé pour les comptes locaux ; en-tête
anti-CSRF sur les écritures ; en-têtes de sécurité et CSP stricte sur le rapport ; journal d'audit sans contenu ;
masquage des données personnelles avant tout appel LLM et dans les logs ; fichiers en Blob privé ; rétention
configurable par organisation (cron Vercel quotidien) ; suppression complète d'une mission (base + fichiers) ;
secrets uniquement par variables d'environnement.

## Tests et CI

```powershell
npm run lint; npm run typecheck
npm test                              # Vitest : unitaires + intégration sur TEST_DATABASE_URL (vidée)
npm run evals                         # évaluations ; code retour 1 si un seuil est raté
npx playwright install chromium       # une fois
npm run e2e                           # sur `npm run build; npm start` avec la démo fraîchement seedée
```

`.github/workflows/ci.yml` exécute lint, typecheck, tests, évaluations, build et le parcours Playwright (Node 22 +
PostgreSQL 16).

## Limites connues

- Le kit annonce « 40+ sources » par entreprise : les dossiers en contiennent 37, 37 et 38 une fois le corrigé
  (`ground_truth.json`, `manifest.json`) exclu.
- Les procédures et emails du kit sont très similaires d'une entreprise à l'autre ; l'essentiel du signal vient
  des CSV. Les valeurs par opportunité sont en général plus prudentes que les estimations du kit (ratio médian
  ≈ 0,5), les totaux par entreprise restant proches (1,60 / 1,37 / 2,06 M MAD/an contre 1,40 / 1,22 / 2,11).
- Clerk, Vercel Blob, l'AI Gateway et le déploiement Vercel n'ont pas été exercés avec de vraies clés : le code
  suit leur documentation et les tests couvrent le mode local.
- Pas d'OCR des PDF scannés, pas de connecteurs ERP directs (hors périmètre MVP, spec §17).
