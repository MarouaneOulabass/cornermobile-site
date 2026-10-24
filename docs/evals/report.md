# Évaluation AuditFlow sur le jeu de démonstration

_Généré le 2026-10-24 10:04 UTC par `python -m evals` (backend/evals)._

Le moteur analyse chaque entreprise exactement comme en production (import du dossier, analyse déterministe, aucun LLM). Le corrigé `ground_truth.json` n'est lu que par le module d'évaluation, après coup. Les mesures suivent le §14 du cahier des charges.

## Synthèse

| Mesure | Résultat | Seuil | |
|---|---|---|---|
| Recall des irritants attendus | 1 | ≥ 1 | ✅ |
| Précision (irritants étayés par une preuve vérifiée ou signalés en hypothèse) | 1 | ≥ 1 | ✅ |
| Fidélité des preuves (citation retrouvée telle quelle dans le fichier d'origine) | 1 | ≥ 1 | ✅ |
| Pertinence des preuves (la preuve parle du constat qu'elle étaye) | 1 | ≥ 0.9 | ✅ |
| Exactitude des métriques (recalcul indépendant depuis les CSV) | 1 | ≥ 1 | ✅ |
| Exactitude des business cases (recalcul indépendant des formules ROI) | 1 | ≥ 1 | ✅ |
| Éléments sans preuve ni statut d'hypothèse | 0 | ≤ 0 | ✅ |
| Chiffres non traçables dans les textes générés | 0 | ≤ 0 | ✅ |
| Déterminisme (ré-import + ré-analyse ⇒ classement identique) | oui | oui | ✅ |
| Stabilité du classement (τ de Kendall minimal, coefficients ±20 %) | 0.857 | ≥ 0.6 | ✅ |
| Qualité de la synthèse dirigeant (grille de contrôle) | 1 | ≥ 1 | ✅ |
| Corrigé du kit jamais ingéré | oui | — | ✅ |
| Analyses sans erreur | aucune | — | ✅ |

Indicateurs complémentaires : recall direct (hors hypothèses) 0.933, précision stricte vs corrigé 0.56, top 3 conservé sous perturbation 0.85, ratio médian valeur moteur / valeur de référence 0.513.

La précision stricte compte comme faux positif tout irritant absent du corrigé. Elle est basse par construction : le moteur remonte aussi des constats documentés que le corrigé ne liste pas (créances, procédures, SLA…). Ils sont listés plus bas avec leurs sources pour revue humaine.

## AtlasPro Distribution

37 sources analysées en 0.8 s · 8 irritants · 217 preuves liées · 89 nombres contrôlés dans les textes générés.

### Irritants plantés

| Irritant attendu | Gravité | Irritant produit | Score | Criticité | Preuves |
|---|---|---|---|---|---|
| Devis manuels | high | Devis préparés manuellement : 76 % ressaisis, 4 modèles différents, 37 min médianes | 0.77 | critique | 4 |
| Relances impayés non priorisées | high | Relances d'impayés non priorisées : 7,47 M MAD de créances échues | 0.89 | critique | 2 |
| Stock dormant | high | Stock dormant : 21,26 M MAD immobilisés (> 180 jours sans vente) | 0.85 | elevee | 1 |
| Reporting mensuel manuel | medium | Reporting mensuel manuel, avec des écarts récurrents vs l'ERP | 0.77 | elevee | 5 |
| SAV dispersé | high | Support éclaté sur 4 canaux, historique incomplet (17 % des tickets) | 0.79 | critique | 6 |

Constats supplémentaires (hors corrigé) :

- Potentiel commercial non exploité : 38 % de devis perdus, 33 % sans décision — 2 preuve(s) : data/quotes.csv
- Délais contractuels suivis sans alerte : risque de pénalités — 8 preuve(s) : data/tickets.csv, documents/contracts/contract_01.md, documents/contracts/contract_02.md, documents/contracts/contract_03.md
- Procédures incomplètes : 8 sans propriétaire, 4 non revues depuis plus de 24 mois — 6 preuve(s) : documents/procedures/procedure_01.md, documents/procedures/procedure_02.md, documents/procedures/procedure_03.md, documents/procedures/procedure_07.md

### Valeur annuelle vs estimations du kit

| Opportunité attendue | Référence (MAD/an) | Opportunité produite | Moteur (MAD/an) | Ratio | Priorité |
|---|---|---|---|---|---|
| Copilote de devis | 210 k | Copilote de devis | 124 k | 0.59 | P1 |
| Priorisation intelligente des relances | 330 k | Priorisation des relances d'impayés (marge × risque × ancienneté) | 378 k | 1.15 | P1 |
| Détection stock dormant & recommandations | 480 k | Détection du stock dormant & recommandations de déstockage | 425 k | 0.89 | P1 |
| Reporting direction automatisé | 120 k | Reporting direction automatisé | 77 k | 0.64 | P2 |
| Assistant SAV omnicanal | 260 k | Assistant SAV omnicanal | 139 k | 0.54 | P2 |

Total moteur 1 596 k MAD/an (toutes opportunités) vs 1 400 k MAD/an pour les 5 opportunités du kit.

### Calculs recalculés indépendamment

| Métrique | Recalcul | Référence | Moteur | |
|---|---|---|---|---|
| Part de devis ressaisis | `count(manual_reentry = yes) / count(*)` | 0.7562 | 0.7562 | ✅ |
| Modèles différents | `count(distinct template_used)` | 4 | 4.0 | ✅ |
| Temps médian de préparation | `median(prep_minutes)` | 37 | 37.0 | ✅ |
| Valeur du stock dormant | `Σ stock_value_mad | days_since_last_sale ≥ 180` | 2.12646e+07 | 21264593.0 | ✅ |
| Taux de transformation | `count(Won) / count(Won ∪ Lost)` | 0.4299 | 0.4299 | ✅ |
| Montant des créances échues | `Σ amount_mad | status = OVERDUE` | 7.46524e+06 | 7465236.0 | ✅ |
| Part des factures échues | `count(status = OVERDUE) / count(*)` | 0.3333 | 0.3333 | ✅ |
| Créances échues depuis 60 jours | `Σ amount_mad | OVERDUE et days_overdue ≥ 60` | 4.45163e+06 | 4451627.0 | ✅ |
| Canaux d'entrée | `count(distinct channel)` | 4 | 4.0 | ✅ |
| Tickets avec historique manquant | `count(observed_issue = Missing history) / count(*)` | 0.1722 | 0.1722 | ✅ |
| Délai médian de résolution | `median(resolution_hours)` | 47.5 | 47.5 | ✅ |

Business cases : 8 recalculés, 0 écart(s).

Stabilité : déterministe = oui ; 20 perturbations, τ min 0.857, τ moyen 0.986, top 3 conservé 95%, n°1 conservé 100%. Synthèse : 100% des contrôles.

## Darna Facility Services

37 sources analysées en 0.7 s · 9 irritants · 226 preuves liées · 83 nombres contrôlés dans les textes générés.

### Irritants plantés

| Irritant attendu | Gravité | Irritant produit | Score | Criticité | Preuves |
|---|---|---|---|---|---|
| Planification manuelle | high | Planification manuelle : 100 % des interventions planifiées via Excel, WhatsApp, Téléphone | 0.78 | critique | 5 |
| Comptes rendus terrain non structurés | high | Comptes rendus terrain non structurés (WhatsApp, transmission tardive) | 0.90 | elevee | 4 |
| SLA mal suivis | high | SLA non tenus et suivis trop tard : 66 % des interventions hors délai | 0.77 | critique | 5 |
| Achats urgents coûteux | medium | Achats urgents coûteux : 41 % des commandes, surcoût moyen 18,1 % | 0.83 | elevee | 2 |
| Facturation retardée | high | Facturation retardée : justificatifs d'intervention transmis tardivement à la finance | 1.00 | elevee | 5 |

Constats supplémentaires (hors corrigé) :

- Relances d'impayés non priorisées : 7,20 M MAD de créances échues — 2 preuve(s) : data/invoices.csv, documents/emails/email_04.txt
- Support éclaté sur 4 canaux, historique incomplet (16 % des tickets) — 6 preuve(s) : company_profile.md, data/tickets.csv, documents/emails/email_02.txt
- Reporting mensuel manuel, avec des écarts récurrents vs l'ERP — 5 preuve(s) : documents/contracts/contract_01.md, documents/procedures/procedure_03.md, documents/procedures/procedure_07.md, documents/reports/monthly_report_01.md
- Procédures incomplètes : 8 sans propriétaire, 4 non revues depuis plus de 24 mois — 6 preuve(s) : documents/procedures/procedure_01.md, documents/procedures/procedure_02.md, documents/procedures/procedure_04.md, documents/procedures/procedure_05.md

### Valeur annuelle vs estimations du kit

| Opportunité attendue | Référence (MAD/an) | Opportunité produite | Moteur (MAD/an) | Ratio | Priorité |
|---|---|---|---|---|---|
| Agent de planification des interventions | 360 k | Agent de planification des interventions | 203 k | 0.56 | P1 |
| Compte rendu terrain assisté par IA | 190 k | Compte rendu terrain assisté par IA | 65 k | 0.34 | P2 |
| Radar SLA & pénalités | 280 k | Radar SLA & pénalités | 141 k | 0.5 | P2 |
| Prévision des besoins en pièces | 170 k | Anticipation des besoins en pièces (stock de sécurité, achats groupés) | 322 k | 1.9 | P1 |
| Dossier d’intervention vers facturation | 220 k | Dossier d'intervention vers facturation | 80 k | 0.36 | P2 |

Total moteur 1 365 k MAD/an (toutes opportunités) vs 1 220 k MAD/an pour les 5 opportunités du kit.

### Calculs recalculés indépendamment

| Métrique | Recalcul | Référence | Moteur | |
|---|---|---|---|---|
| Part des interventions hors SLA | `count(sla_breached = yes) / count(*)` | 0.6591 | 0.6591 | ✅ |
| Dépassement moyen | `mean(actual − sla | sla_breached = yes)` | 29.5103 | 29.5 | ✅ |
| Part planifiée hors outil | `count(planning_source ∈ {Excel, WhatsApp, Phone}) / count(*)` | 1 | 1.0 | ✅ |
| Part des achats urgents | `count(urgent_purchase = yes) / count(*)` | 0.4083 | 0.4083 | ✅ |
| Surcoût moyen des achats urgents | `mean(price_premium_pct | urgent)` | 18.1429 | 18.14 | ✅ |
| Factures établies hors ERP | `count(source ≠ ERP) / count(*)` | 0.6417 | 0.6417 | ✅ |
| Montant des créances échues | `Σ amount_mad | status = OVERDUE` | 7.20152e+06 | 7201523.0 | ✅ |
| Part des factures échues | `count(status = OVERDUE) / count(*)` | 0.325 | 0.325 | ✅ |
| Créances échues depuis 60 jours | `Σ amount_mad | OVERDUE et days_overdue ≥ 60` | 3.19838e+06 | 3198379.0 | ✅ |
| Canaux d'entrée | `count(distinct channel)` | 4 | 4.0 | ✅ |
| Tickets avec historique manquant | `count(observed_issue = Missing history) / count(*)` | 0.1611 | 0.1611 | ✅ |
| Délai médian de résolution | `median(resolution_hours)` | 50 | 50.0 | ✅ |

Business cases : 9 recalculés, 0 écart(s).

Stabilité : déterministe = oui ; 20 perturbations, τ min 0.944, τ moyen 0.975, top 3 conservé 100%, n°1 conservé 100%. Synthèse : 100% des contrôles.

## MaghrebPack Industries

38 sources analysées en 0.8 s · 10 irritants · 247 preuves liées · 103 nombres contrôlés dans les textes générés.

### Irritants plantés

| Irritant attendu | Gravité | Irritant produit | Score | Criticité | Preuves |
|---|---|---|---|---|---|
| Planification de production instable | high | Planning de production instable : 1,4 replanification(s) par ordre, 65 % en dépassement | 0.53 | critique | 3 |
| Pannes répétitives mal capitalisées | high | Pannes répétitives mal capitalisées : 68 % sans cause identifiée | 0.95 | critique | 3 |
| Non-conformités récurrentes | high | Non-conformités récurrentes : 42 % se répètent sous 90 jours | 1.00 | critique | 3 |
| Prévisions commerciales faibles | medium | Visibilité commerciale insuffisante sur la charge (hypothèse à valider) _(hypothèse à valider)_ | 0.60 | moyenne | 1 |
| Consommation matière mal expliquée | high | Consommation matière mal expliquée : rebut moyen 5,6 % (cible 3,0 %) | 0.77 | critique | 4 |

Constats supplémentaires (hors corrigé) :

- Relances d'impayés non priorisées : 6,29 M MAD de créances échues — 3 preuve(s) : data/invoices.csv, documents/emails/email_04.txt, documents/emails/email_05.txt
- Support éclaté sur 4 canaux, historique incomplet (14 % des tickets) — 6 preuve(s) : company_profile.md, data/tickets.csv, documents/emails/email_04.txt
- Délais contractuels suivis sans alerte : risque de pénalités — 8 preuve(s) : data/tickets.csv, documents/contracts/contract_01.md, documents/contracts/contract_02.md, documents/contracts/contract_03.md
- Reporting mensuel manuel, avec des écarts récurrents vs l'ERP — 5 preuve(s) : documents/contracts/contract_01.md, documents/procedures/procedure_03.md, documents/procedures/procedure_07.md, documents/reports/monthly_report_01.md
- Procédures incomplètes : 8 sans propriétaire, 3 non revues depuis plus de 24 mois — 6 preuve(s) : documents/procedures/procedure_01.md, documents/procedures/procedure_02.md, documents/procedures/procedure_05.md, documents/procedures/procedure_06.md

### Valeur annuelle vs estimations du kit

| Opportunité attendue | Référence (MAD/an) | Opportunité produite | Moteur (MAD/an) | Ratio | Priorité |
|---|---|---|---|---|---|
| Assistant d’ordonnancement | 620 k | Assistant d'ordonnancement | 245 k | 0.4 | P2 |
| Copilote maintenance & diagnostic | 410 k | Copilote maintenance & diagnostic | 419 k | 1.02 | P1 |
| Analyse IA des non-conformités | 350 k | Analyse IA des non-conformités | 134 k | 0.38 | P2 |
| Prévision demande & charge | 290 k | Prévision demande & charge | 78 k | 0.27 | P3 |
| Détection dérives consommation matière | 440 k | Détection des dérives de consommation matière | 493 k | 1.12 | P1 |

Total moteur 2 055 k MAD/an (toutes opportunités) vs 2 110 k MAD/an pour les 5 opportunités du kit.

### Calculs recalculés indépendamment

| Métrique | Recalcul | Référence | Moteur | |
|---|---|---|---|---|
| Pannes sans cause racine | `count(root_cause_known = no) / count(*)` | 0.6786 | 0.6786 | ✅ |
| Heures d'arrêt totales | `Σ downtime_hours` | 936 | 936.0 | ✅ |
| Non-conformités répétées | `count(repeat_within_90d = yes) / count(*)` | 0.425 | 0.425 | ✅ |
| Replanifications moyennes | `mean(replans)` | 1.45 | 1.45 | ✅ |
| Dérive des temps réels | `(Σ actual_hours − Σ planned_hours) / Σ planned_hours` | 0.1933 | 0.1933 | ✅ |
| Taux de rebut matière moyen | `mean(material_waste_pct)` | 5.5642 | 5.56 | ✅ |
| Montant des créances échues | `Σ amount_mad | status = OVERDUE` | 6.28899e+06 | 6288990.0 | ✅ |
| Part des factures échues | `count(status = OVERDUE) / count(*)` | 0.2917 | 0.2917 | ✅ |
| Créances échues depuis 60 jours | `Σ amount_mad | OVERDUE et days_overdue ≥ 60` | 3.10045e+06 | 3100450.0 | ✅ |
| Canaux d'entrée | `count(distinct channel)` | 4 | 4.0 | ✅ |
| Tickets avec historique manquant | `count(observed_issue = Missing history) / count(*)` | 0.1444 | 0.1444 | ✅ |
| Délai médian de résolution | `median(resolution_hours)` | 42.5 | 42.5 | ✅ |

Business cases : 10 recalculés, 0 écart(s).

Stabilité : déterministe = oui ; 20 perturbations, τ min 0.867, τ moyen 0.956, top 3 conservé 60%, n°1 conservé 100%. Synthèse : 100% des contrôles.

## Méthode

- **Recall / précision** : appariement lexical (racines de mots, domaine) entre chaque irritant planté et les irritants produits, affectation un-à-un ; les scores d'appariement sont publiés ci-dessus.
- **Fidélité des preuves** : chaque preuve liée est relue dans le fichier d'origine, indépendamment de l'ingestion — lignes de texte identiques, cellules CSV identiques (ligne, colonne, valeur), colonnes et numéros de ligne existants.
- **Pertinence** : une preuve rattachée à un irritant doit partager du vocabulaire métier avec lui.
- **Exactitude des calculs** : une douzaine de faits clés par entreprise recalculés avec la bibliothèque standard (`evals/anchors.py`) ; chaque business case recalculé à partir de ses hypothèses avec les formules documentées (heures × coût horaire × 12, payback = coût projet / (gain net / 12), ROI 12/36 mois).
- **Hallucinations** : (1) irritants, métriques, opportunités et hypothèses « fait/calcul » sans preuve liée ; (2) chaque nombre des titres, descriptions et recommandations doit correspondre, à la précision affichée près, à une valeur calculée, une preuve, une hypothèse, un seuil déclaré ou un nombre écrit dans une source texte.
- **Stabilité** : ré-import du même dossier (tout est dédupliqué) puis ré-analyse ⇒ scores, rangs et étiquettes identiques ; chaque coefficient de priorisation est ensuite varié de ±20 %.
- **Synthèse dirigeant** : grille de contrôle (potentiel annoncé, irritants critiques nommés, décision citant une P1, chaque P1 chiffrée, hypothèses signalées, longueur).

Limites : l'appariement lexical peut être trompé par des formulations très éloignées ; la grille de synthèse vérifie la présence des éléments, pas la qualité rédactionnelle ; les valeurs du kit sont des estimations, pas des vérités terrain — l'écart de valeur est donc publié, pas noté.
