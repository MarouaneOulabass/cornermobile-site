# Cahier des charges — Plateforme d'Audit IA & Performance

## 1. Vision produit

Construire une plateforme qui transforme un ensemble de documents, fichiers structurés et entretiens en un **diagnostic opérationnel exploitable**.

Le produit ne doit pas se comporter comme un chatbot générique. Il doit produire un audit traçable, chiffré, priorisé et orienté décision.

**Promesse :** « Donnez-nous vos documents et quelques entretiens ; nous vous montrons où vous perdez du temps et de l'argent, ce qui peut être amélioré ou automatisé, et dans quel ordre agir. »

---

## 2. Périmètre MVP

Le MVP doit permettre :

1. Créer une entreprise / mission d'audit.
2. Importer PDF, DOCX, XLSX, CSV, TXT et emails exportés.
3. Classifier automatiquement les documents et extraire leurs métadonnées.
4. Construire une représentation de l'entreprise : départements, rôles, outils, processus, flux, données, KPI, contrats, contraintes.
5. Détecter des irritants et anomalies à partir de preuves.
6. Formuler des opportunités d'amélioration, d'automatisation et d'IA.
7. Chiffrer chaque opportunité avec hypothèses explicites.
8. Prioriser par Impact / Effort / Risque / Confiance.
9. Générer une roadmap 30/60/90 jours.
10. Produire un rapport dirigeant exportable.
11. Permettre à un consultant de corriger/valider chaque conclusion avant publication.

Le MVP ne doit pas déployer automatiquement des agents chez le client. Il peut générer une proposition de prototype, mais la mise en production est hors périmètre initial.

---

## 3. Personas

### Consultant / auditeur
Crée la mission, importe les sources, lance l'analyse, corrige les résultats, prépare la restitution.

### Dirigeant client
Consulte une synthèse simple : problèmes, valeur, priorités, roadmap.

### Responsable métier
Consulte les preuves liées à son périmètre et valide ou conteste les hypothèses.

### Admin
Gère utilisateurs, modèles de scoring, sécurité, rétention et paramètres.

---

## 4. Modèle de données conceptuel

- Organization
- AuditMission
- Department
- Person / Role
- Tool
- DataSource
- Document
- Evidence
- Process
- ProcessStep
- PainPoint
- Risk
- Opportunity
- Assumption
- Metric
- ROIModel
- Recommendation
- RoadmapItem
- Validation
- Comment
- Export

Chaque PainPoint et Opportunity doit avoir au moins une Evidence ou être explicitement marqué « hypothèse à valider ».

---

## 5. Pipeline d'analyse

### 5.1 Ingestion
- drag & drop multi-fichiers ;
- import de dossiers ;
- statut par fichier : reçu / parsé / indexé / erreur ;
- détection doublons ;
- hash et version ;
- extraction des tableaux ;
- conservation de la source originale.

### 5.2 Classification documentaire
Catégories minimales :
- finance ;
- ventes ;
- achats ;
- opérations ;
- RH ;
- contrats ;
- procédures ;
- qualité ;
- maintenance ;
- support ;
- reporting ;
- IT / sécurité ;
- autre.

### 5.3 Construction du Business Graph
Extraire les entités et relations :
- une équipe utilise un outil ;
- un processus consomme une donnée ;
- un KPI dépend d'un fichier ;
- un contrat impose un SLA ;
- une étape nécessite une validation ;
- une activité génère une ressaisie ;
- une donnée existe dans plusieurs systèmes.

Le graphe doit être visible et éditable.

### 5.4 Détection des irritants
Types d'irritants :
- double saisie ;
- tâche manuelle répétitive ;
- délai ;
- rupture de flux ;
- donnée contradictoire ;
- dépendance à une personne ;
- absence de contrôle ;
- non-respect SLA ;
- stock / cash immobilisé ;
- reporting tardif ;
- manque de traçabilité ;
- risque contractuel ;
- potentiel commercial non exploité.

Pour chaque irritant :
- titre ;
- description ;
- périmètre ;
- preuves ;
- fréquence estimée ;
- coût / impact ;
- confiance ;
- criticité ;
- statut de validation humaine.

### 5.5 Génération d'opportunités
Catégories :
- automatisation classique ;
- intégration SI ;
- amélioration de processus ;
- BI / data ;
- assistant IA ;
- agent IA ;
- recherche documentaire / RAG ;
- prédiction / optimisation ;
- nouveau service / revenu.

La plateforme ne doit jamais recommander de l'IA si une automatisation simple est suffisante.

---

## 6. Scoring

Chaque opportunité reçoit des notes 0-100 :

- Business Impact
- Time Saved
- Revenue Upside
- Cost Reduction
- Risk Reduction
- Feasibility
- Data Readiness
- Change Effort
- Technical Complexity
- Compliance Risk
- Confidence

### Priority Score proposé

Priority = 0.30 Impact + 0.20 TimeSaved + 0.15 CostReduction + 0.10 RevenueUpside + 0.10 Feasibility + 0.10 DataReadiness + 0.05 Confidence - pénalités Risk/Complexity.

Les coefficients doivent être configurables.

---

## 7. ROI

Chaque business case expose :

### Situation actuelle
- volume mensuel ;
- temps unitaire ;
- personnes impliquées ;
- coût horaire ;
- coût d'erreur / retard ;
- revenu ou marge concernés.

### Situation cible
- taux d'automatisation ;
- taux d'adoption ;
- temps restant ;
- coût projet ;
- coût récurrent.

### Indicateurs
- heures économisées / mois ;
- valeur annuelle brute ;
- coût annuel solution ;
- gain net ;
- payback ;
- ROI 12 mois ;
- ROI 36 mois.

Toutes les hypothèses doivent être visibles et modifiables.

---

## 8. Traçabilité / Evidence-first

C'est une exigence centrale.

Une recommandation doit afficher :
- les documents sources ;
- les lignes / cellules / extraits concernés ;
- les calculs ;
- les hypothèses ;
- le niveau de confiance ;
- qui a validé le point et quand.

Aucune affirmation chiffrée ne doit apparaître comme un fait si elle vient uniquement d'une estimation LLM.

---

## 9. Parcours utilisateur

### Écran 1 — Portefeuille d'audits
Cartes des entreprises, statut, progression, valeur identifiée, alertes.

### Écran 2 — Onboarding mission
- informations entreprise ;
- objectifs ;
- périmètre ;
- import fichiers ;
- checklist d'entretiens ;
- lancement analyse.

### Écran 3 — Vue entreprise
- synthèse ;
- score de maturité ;
- valeur potentielle ;
- quick wins ;
- risques ;
- complétude des données.

### Écran 4 — Processus
Liste + cartographie. Pour chaque processus : propriétaire, outils, entrées/sorties, temps, irritants, preuves.

### Écran 5 — Irritants
Backlog filtrable par département, criticité, type et confiance.

### Écran 6 — Opportunités
Vue cartes + matrice Impact/Effort. Tri par valeur annuelle, payback, complexité.

### Écran 7 — Business Case
Page détaillée d'une opportunité avec preuves, calculateur ROI, hypothèses, architecture cible, plan pilote.

### Écran 8 — Roadmap
Timeline 30/60/90 jours et portefeuille 12 mois.

### Écran 9 — Rapport
Executive summary, constats, business cases, roadmap, annexes, export PDF.

---

## 10. UX / Design

Style : SaaS B2B premium, très lisible, sobre, orienté décision.

Principes :
- pas de jargon IA sur la home ;
- la valeur avant la technologie ;
- chaque chiffre cliquable vers sa preuve ;
- distinguer faits, calculs et hypothèses ;
- utiliser des niveaux de confiance ;
- éviter les écrans trop longs ;
- navigation latérale persistante ;
- résumé exécutif toujours accessible.

Couleurs fonctionnelles :
- vert = valeur / validé ;
- orange = à vérifier ;
- rouge = risque / criticité ;
- bleu = information / structure.

---

## 11. Architecture technique cible

### Front
- Next.js / React
- TypeScript
- Tailwind
- composants accessibles

### Back
- FastAPI ou NestJS
- PostgreSQL
- stockage objet S3 compatible
- queue de jobs
- Redis

### IA
- couche provider-agnostic ;
- extraction structurée par schémas ;
- embeddings + recherche hybride ;
- LLM pour synthèse / classification / raisonnement ;
- moteur de règles déterministes pour calculs ;
- evals automatiques sur le dataset de référence.

### Search / knowledge
- pgvector ou moteur vectoriel dédié ;
- full-text search ;
- citations obligatoires.

---

## 12. Sécurité

Minimum :
- chiffrement transit/repos ;
- RBAC ;
- isolation stricte par organisation ;
- journal d'audit ;
- rétention configurable ;
- suppression complète d'une mission ;
- masquage des données sensibles ;
- aucun entraînement fournisseur sur données client ;
- secrets hors code ;
- logs sans contenu sensible.

Prévoir ensuite SSO/SAML et déploiement privé.

---

## 13. Human-in-the-loop

Chaque élément généré peut être :
- À vérifier
- Validé
- Corrigé
- Rejeté

Le consultant doit pouvoir modifier les métriques, hypothèses, texte, priorité et roadmap sans casser la traçabilité.

---

## 14. Evals et dataset de démonstration

Utiliser les 3 entreprises fournies dans `/demo-data`.

Chaque dossier contient `ground_truth.json` avec des problèmes volontairement injectés.

Mesures minimales :
- recall des irritants attendus ;
- précision des irritants ;
- pertinence des preuves ;
- exactitude des calculs ;
- taux d'hallucination ;
- stabilité du scoring ;
- qualité de synthèse dirigeant.

Objectif MVP : aucun chiffre non traçable et aucune recommandation majeure sans preuve ou hypothèse clairement signalée.

---

## 15. Démo attendue

La démo commerciale doit permettre en moins de 8 minutes de :

1. Sélectionner AtlasPro Distribution.
2. Montrer les 40+ sources importées.
3. Ouvrir la vue entreprise.
4. Montrer 5 irritants détectés.
5. Ouvrir « Copilote de devis ».
6. Montrer les preuves et hypothèses.
7. Modifier un coût horaire et recalculer le ROI en direct.
8. Montrer la matrice Impact/Effort.
9. Montrer la roadmap 90 jours.
10. Basculer sur Darna puis MaghrebPack pour prouver que le produit n'est pas spécifique à un secteur.

---

## 16. Critères d'acceptation MVP

- import d'au moins 100 fichiers par mission ;
- traitement asynchrone avec progression ;
- sources consultables ;
- chaque insight possède provenance et confiance ;
- calculs ROI déterministes ;
- édition humaine complète ;
- matrice Impact/Effort ;
- roadmap ;
- export de rapport ;
- multi-tenant ;
- tests automatiques sur les 3 sociétés fictives ;
- aucune donnée d'une organisation visible par une autre.

---

## 17. Hors périmètre MVP

- connexion directe à tous les ERP ;
- agent autonome modifiant le SI client ;
- exécution automatique des recommandations ;
- benchmark sectoriel mondial ;
- audit cybersécurité exhaustif ;
- conformité juridique automatisée garantie.

---

## 18. Ordre de construction recommandé pour Claude

1. Modèle de données + seed des 3 sociétés.
2. Shell UX + navigation.
3. Ingestion et bibliothèque de sources.
4. Business Graph.
5. Pain Points + evidence viewer.
6. Opportunities + scoring.
7. Business Case + simulateur ROI.
8. Roadmap.
9. Rapport / export.
10. Evals sur `ground_truth.json`.

À chaque étape : tests unitaires + tests d'intégration + données seedées. Ne pas bloquer le développement sur une validation manuelle si les tests sont verts ; conserver néanmoins les fonctionnalités de validation humaine dans le produit.
