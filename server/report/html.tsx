/** @jsxImportSource @/server/report/jsx */
/**
 * The report as a static HTML page (screen preview and the frozen HTML deliverable): no script, no external
 * resource. Same structure and styles as the reference template, written in JSX and rendered to a string by a small
 * escaping runtime (server/report/jsx) — Next.js does not allow react-dom/server in route handlers.
 */
import { pyFixed, pyRound } from "../lib/py";
import type { ReportData } from "../services/report";
import { Fragment, type JSX } from "./jsx/jsx-runtime";

type ReactNode = JSX.Element | string | number | null | undefined | (JSX.Element | string)[];

const FONT = 'Inter, "Helvetica Neue", Arial, sans-serif';

/** Text inside a CSS string literal (page margin boxes), where HTML escaping does not apply. */
export function cssString(value: string): string {
  // str.isprintable(): no control, format, private-use, unassigned or separator character (the ASCII space aside).
  const printable = [...String(value)].filter((ch) => ch === " " || !/[\p{C}\p{Z}]/u.test(ch)).join("");
  return printable.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("<", "\\3C ");
}

function styles(data: ReportData): string {
  return `
  @page {
    size: A4;
    margin: 18mm 16mm 18mm 16mm;
    @bottom-left { content: "${cssString(`${data.organization.name} — ${data.mission.name}`)}"; font-family: ${FONT}; font-size: 8pt; color: #6b7280; }
    @bottom-right { content: "Page " counter(page) " / " counter(pages); font-family: ${FONT}; font-size: 8pt; color: #6b7280; }
    ${data.mission.published ? "" : `@top-right { content: "VERSION DE TRAVAIL — NON PUBLIÉE"; font-family: ${FONT}; font-size: 8pt; color: #b45309; font-weight: 700; }`}
  }
  @page :first { @bottom-left { content: ""; } @bottom-right { content: ""; } }
  :root { --ink: #18212f; --muted: #6b7280; --line: #e5e7eb; --info: #2563eb; --value: #15803d; --check: #b45309; --risk: #b91c1c; }
  * { box-sizing: border-box; }
  body { font-family: ${FONT}; color: var(--ink); font-size: 9.5pt; line-height: 1.45; margin: 0; background: #fff; }
  .page { max-width: 900px; margin: 0 auto; padding: 24px; }
  h1 { font-size: 24pt; margin: 0 0 4px; }
  h2 { font-size: 15pt; margin: 28px 0 10px; padding-bottom: 6px; border-bottom: 2px solid var(--ink); break-after: avoid; }
  h3 { font-size: 11pt; margin: 16px 0 6px; break-after: avoid; }
  p { margin: 4px 0 8px; }
  .muted { color: var(--muted); }
  .eyebrow { font-size: 8pt; text-transform: uppercase; letter-spacing: .08em; font-weight: 700; color: var(--muted); }
  .cover { min-height: 230mm; display: flex; flex-direction: column; justify-content: space-between; break-after: page; }
  .cover .brand { font-weight: 800; font-size: 14pt; } .cover .brand span { color: var(--info); }
  .cover h1 { font-size: 30pt; margin-top: 60mm; }
  .draft { display: inline-block; margin-top: 10px; padding: 4px 10px; border: 1.5px solid var(--check); color: var(--check); border-radius: 6px; font-weight: 700; font-size: 9pt; }
  .figures { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 12px 0; }
  .figure { border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; }
  .figure b { display: block; font-size: 15pt; } .figure.value b { color: var(--value); }
  .callout { border-left: 3px solid var(--info); background: #f8fafc; padding: 8px 12px; border-radius: 6px; margin: 8px 0; break-inside: avoid; }
  .callout.decision { border-color: var(--value); }
  table { width: 100%; border-collapse: collapse; margin: 6px 0 10px; font-size: 8.5pt; }
  th { text-align: left; font-size: 7.5pt; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); border-bottom: 1px solid var(--line); padding: 4px 6px; }
  td { border-bottom: 1px solid var(--line); padding: 4px 6px; vertical-align: top; }
  tr { break-inside: avoid; }
  .num { text-align: right; white-space: nowrap; }
  .tag { display: inline-block; font-size: 7pt; font-weight: 700; padding: 1px 6px; border-radius: 999px; background: #f3f4f6; color: #374151; white-space: nowrap; }
  .tag.critique, .tag.elevee { background: #fee2e2; color: var(--risk); }
  .tag.moyenne { background: #ffedd5; color: var(--check); }
  .tag.fait { background: #dbeafe; color: var(--info); } .tag.calcul { background: #dcfce7; color: var(--value); } .tag.hypothese { background: #ffedd5; color: var(--check); }
  .tag.a_verifier { background: #ffedd5; color: var(--check); } .tag.valide { background: #dcfce7; color: var(--value); } .tag.corrige { background: #dbeafe; color: var(--info); }
  .tag.P1 { background: #dcfce7; color: var(--value); } .tag.P2 { background: #dbeafe; color: var(--info); }
  .finding, .case { border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; margin: 8px 0; break-inside: avoid; }
  .case { break-inside: auto; }
  .case-head { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; }
  .kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; margin: 8px 0; }
  .kpis div { background: #f8fafc; border-radius: 6px; padding: 5px 8px; } .kpis b { display: block; font-size: 10.5pt; }
  .ref { display: inline-block; margin-left: 3px; font-size: 6.5pt; font-weight: 700; color: var(--info); text-decoration: none; vertical-align: super; }
  .phase { border-top: 3px solid #93c5fd; padding-top: 4px; margin-top: 10px; break-inside: avoid; }
  .bar { height: 6px; background: #e5e7eb; border-radius: 999px; overflow: hidden; } .bar i { display: block; height: 100%; background: var(--info); }
  .legend { font-size: 8pt; color: var(--muted); }
  .annex td { font-size: 7.5pt; } .annex tr.group td { background: #f8fafc; padding-top: 6px; } .excerpt { font-family: Menlo, monospace; font-size: 7pt; color: #4b5563; white-space: pre-wrap; }
  .recs { padding-left: 18px; margin: 4px 0 10px; } .recs li { margin-bottom: 5px; break-inside: avoid; }
  .break { break-before: page; }
  @media screen { body { background: #f5f7fb; } .page { background: #fff; margin: 16px auto; box-shadow: 0 1px 3px rgba(0,0,0,.08); border-radius: 12px; } .cover { min-height: auto; } .cover h1 { margin-top: 30px; } }
`;
}

function Refs({ refs }: { refs: number[] }) {
  return (
    <>
      {refs.map((n) => (
        <a key={n} className="ref" href={`#E${n}`}>
          E{n}
        </a>
      ))}
    </>
  );
}

function Tag({ kind, children }: { kind?: string; children: ReactNode }) {
  return <span className={kind ? `tag ${kind}` : "tag"}>{children}</span>;
}

const SPECIAL_RECS = new Set(["summary", "decision", "hypotheses"]);

export function Report({ data }: { data: ReportData }) {
  const { organization: org, mission, figures } = data;
  const priorities = data.recommendations.filter((r) => !SPECIAL_RECS.has(r.key ?? ""));
  const activeWeights = Object.entries(data.weights).filter(([, w]) => w > 0);
  const activePenalties = Object.entries(data.penalties).filter(([, w]) => w > 0);
  return (
    <html lang="fr">
      <head>
        <meta charSet="utf-8" />
        <title>{`${org.name} — Rapport d'audit IA & Performance`}</title>
        <style dangerouslySetInnerHTML={{ __html: styles(data) }} />
      </head>
      <body>
        <div className="page">
          <section className="cover">
            <div className="brand">
              Audit<span>Flow</span>
            </div>
            <div>
              <div className="eyebrow">Audit IA &amp; Performance — rapport dirigeant</div>
              <h1>{org.name}</h1>
              <p className="muted">
                {org.sector}
                {org.city ? ` — ${org.city}` : ""}
                {org.employees ? ` — ${org.employees} collaborateurs` : ""}
              </p>
              {mission.published ? (
                <p>
                  <b>Publié le {mission.published_at}</b> · analyse v{mission.version}
                </p>
              ) : (
                <span className="draft">Version de travail — non publiée</span>
              )}
            </div>
            <div className="legend">
              Généré le {data.generated_at} · {figures.sources} sources analysées · analyse v{mission.version}
              {mission.analyzed_at ? ` du ${mission.analyzed_at}` : ""}
              <br />
              Document confidentiel. Chaque chiffre est relié à sa source (annexe A, références <span className="ref">E#</span>) et qualifié : <Tag kind="fait">Fait</Tag> lu dans une source,{" "}
              <Tag kind="calcul">Calcul</Tag> déterministe, <Tag kind="hypothese">Hypothèse</Tag> à valider.
            </div>
          </section>

          <h2>1. Synthèse exécutive</h2>
          <div className="figures">
            <div className="figure value">
              <span className="eyebrow">Potentiel brut annuel</span>
              <b>{figures.value}</b>
              <span className="muted">{figures.opportunities} opportunités</span>
            </div>
            <div className="figure value">
              <span className="eyebrow">Opportunités prioritaires</span>
              <b>{figures.value_p1}</b>
              <span className="muted">{figures.p1} en P1</span>
            </div>
            <div className="figure">
              <span className="eyebrow">Irritants</span>
              <b>{figures.pain_points}</b>
              <span className="muted">dont {figures.critical} critiques</span>
            </div>
            <div className="figure">
              <span className="eyebrow">Revue consultant</span>
              <b>{figures.reviewed}</b>
              <span className="muted">confiance analyse {figures.confidence}</span>
            </div>
          </div>
          {data.recommendations.map((r, i) =>
            r.key === "summary" ? (
              <p key={i}>{r.text}</p>
            ) : r.key === "decision" ? (
              <div key={i} className="callout decision">
                <b>{r.title} :</b> {r.text}
              </div>
            ) : r.key === "hypotheses" ? (
              <div key={i} className="callout">
                <b>{r.title} :</b> {r.text}
              </div>
            ) : null,
          )}
          {priorities.length > 0 && (
            <>
              <h3>Recommandations prioritaires</h3>
              <ol className="recs">
                {priorities.map((r, i) => (
                  <li key={i}>
                    <b>{r.title}</b> — {r.text}
                  </li>
                ))}
              </ol>
            </>
          )}

          <h3>Opportunités prioritaires</h3>
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Opportunité</th>
                <th>Catégorie</th>
                <th className="num">Valeur / an</th>
                <th className="num">Payback</th>
                <th>Effort</th>
                <th>Priorité</th>
                <th>Statut</th>
              </tr>
            </thead>
            <tbody>
              {data.cases.slice(0, 8).map((c) => (
                <tr key={c.id}>
                  <td>{c.rank || "—"}</td>
                  <td>
                    <b>{c.title}</b>
                  </td>
                  <td>{c.category}</td>
                  <td className="num">{c.value}</td>
                  <td className="num">{c.payback}</td>
                  <td>{c.effort}</td>
                  <td>
                    <Tag kind={c.priority}>{c.priority}</Tag>
                  </td>
                  <td>
                    <Tag kind={c.status_key}>{c.status}</Tag>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {data.maturity.length > 0 && (
            <>
              <h3>Maturité opérationnelle</h3>
              <table>
                <tbody>
                  {data.maturity.map((m) => (
                    <tr key={m.key}>
                      <td style={{ width: "28%" }}>
                        <b>{m.label}</b>
                      </td>
                      <td style={{ width: "22%" }}>
                        <div className="bar">
                          <i style={{ width: `${pyFixed(pyRound(m.value * 100, 0), 1)}%` }} />
                        </div>
                      </td>
                      <td className="num" style={{ width: "8%" }}>
                        {Math.trunc(pyRound(m.value * 100, 0))} %
                      </td>
                      <td className="muted">{m.explanation}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          <h2 className="break">2. Constats</h2>
          <p className="muted">Irritants classés par criticité. Les points marqués « hypothèse à valider » ne reposent sur aucune donnée directe.</p>
          {data.findings.map((f, i) => (
            <div key={i} className="finding">
              <div className="case-head">
                <b>{f.title}</b>
                <Refs refs={f.refs} />
                <span>
                  <Tag kind={f.crit_key}>{f.criticality}</Tag> <Tag kind={f.status_key}>{f.status}</Tag>
                  {f.hypothesis && (
                    <>
                      {" "}
                      <Tag kind="hypothese">Hypothèse à valider</Tag>
                    </>
                  )}
                </span>
              </div>
              <div className="muted" style={{ fontSize: "8pt" }}>
                {f.department} · confiance {f.confidence}
              </div>
              <p>{f.description}</p>
              {f.metrics.length > 0 && (
                <table>
                  <tbody>
                    {f.metrics.map((m, j) => (
                      <tr key={j}>
                        <td>
                          {m.label}
                          <Refs refs={m.refs} />
                          <div className="muted" style={{ fontSize: "7pt" }}>
                            {m.formula}
                          </div>
                        </td>
                        <td className="num">
                          <b>{m.value}</b>
                        </td>
                        <td style={{ width: "70px" }}>
                          <Tag kind={m.nature_key}>{m.nature}</Tag>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ))}

          <h2 className="break">3. Business cases</h2>
          {data.cases.map((c) => (
            <div key={c.id} className="case">
              <div className="case-head">
                <h3 style={{ margin: 0 }}>{c.title}</h3>
                <span>
                  <Tag kind={c.priority}>{c.priority}</Tag> <Tag kind={c.status_key}>{c.status}</Tag>
                </span>
              </div>
              <p>{c.summary}</p>
              <p className="muted" style={{ fontSize: "8pt" }}>
                <b>{c.category}</b> — {c.rationale}
              </p>
              <div className="kpis">
                <div>
                  Valeur brute<b>{c.value}/an</b>
                </div>
                <div>
                  Gain net<b>{c.net}/an</b>
                </div>
                <div>
                  Payback<b>{c.payback}</b>
                </div>
                <div>
                  ROI 12 / 36 mois
                  <b>
                    {c.roi12} / {c.roi36}
                  </b>
                </div>
              </div>
              {c.lines.length > 0 && (
                <table>
                  <thead>
                    <tr>
                      <th>Source de valeur</th>
                      <th className="num">Valeur / an</th>
                    </tr>
                  </thead>
                  <tbody>
                    {c.lines.map((l, j) => (
                      <tr key={j}>
                        <td>{l.label}</td>
                        <td className="num">{l.value}</td>
                      </tr>
                    ))}
                    <tr>
                      <td className="muted">
                        Coût projet {c.project_cost} · coût récurrent {c.run_cost}/an · {c.hours} h/mois économisées
                      </td>
                      <td />
                    </tr>
                  </tbody>
                </table>
              )}
              <table>
                <thead>
                  <tr>
                    <th>Hypothèse</th>
                    <th className="num">Valeur</th>
                    <th>Nature</th>
                    <th>Source / justification</th>
                  </tr>
                </thead>
                <tbody>
                  {c.assumptions.map((a, j) => (
                    <tr key={j}>
                      <td>
                        {a.label}
                        <Refs refs={a.refs} />
                        {a.edited && (
                          <>
                            {" "}
                            <Tag kind="corrige">ajustée</Tag>
                          </>
                        )}
                      </td>
                      <td className="num">{a.value}</td>
                      <td>
                        <Tag kind={a.nature_key}>{a.nature}</Tag>
                      </td>
                      <td className="muted">{a.source}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {c.pilot.length > 0 && (
                <p style={{ fontSize: "8pt" }}>
                  <b>Plan pilote :</b>{" "}
                  {c.pilot.map((p, j) => (
                    <Fragment key={j}>
                      {p.step} ({p.weeks} sem.){j < c.pilot.length - 1 ? " → " : ""}
                    </Fragment>
                  ))}
                </p>
              )}
            </div>
          ))}

          <h2 className="break">4. Roadmap</h2>
          {data.roadmap.map((p) => (
            <div key={p.key} className="phase">
              <h3>{p.label}</h3>
              <table>
                <tbody>
                  {p.items.map((i, j) => (
                    <tr key={j}>
                      <td>
                        <b>{i.title}</b>
                      </td>
                      <td style={{ width: "90px" }}>
                        <Tag>{i.kind}</Tag>
                      </td>
                      <td style={{ width: "80px" }}>{i.weeks}</td>
                      <td style={{ width: "120px" }} className="muted">
                        {i.owner}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}

          {data.risks.length > 0 && (
            <>
              <h2>5. Risques</h2>
              <table>
                <thead>
                  <tr>
                    <th>Risque</th>
                    <th>Gravité</th>
                    <th className="num">Exposition</th>
                  </tr>
                </thead>
                <tbody>
                  {data.risks.map((r, i) => (
                    <tr key={i}>
                      <td>
                        <b>{r.title}</b>
                        <div className="muted">{r.description}</div>
                      </td>
                      <td>
                        <Tag>{r.severity}</Tag>
                      </td>
                      <td className="num">{r.exposure}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          <h2 className="break">Annexe A — Preuves citées</h2>
          <table className="annex">
            <thead>
              <tr>
                <th>Réf.</th>
                <th>Source</th>
                <th>Localisation</th>
                <th>Constat / extrait</th>
              </tr>
            </thead>
            <tbody>
              {data.evidence.map((e) => (
                <tr key={e.n} id={`E${e.n}`}>
                  <td>
                    <b>E{e.n}</b>
                  </td>
                  <td>{e.file}</td>
                  <td>{e.where}</td>
                  <td>
                    {e.summary}
                    {e.origin === "user" && (
                      <>
                        {" "}
                        <Tag kind="corrige">ajoutée par le consultant</Tag>
                      </>
                    )}
                    {e.excerpt && <div className="excerpt">{e.excerpt}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <h2>Annexe B — Hypothèses à valider</h2>
          <table className="annex">
            <thead>
              <tr>
                <th>Hypothèse</th>
                <th className="num">Valeur</th>
                <th>Justification</th>
              </tr>
            </thead>
            <tbody>
              {data.hypotheses.map((h, i) => (
                <Fragment key={i}>
                  <tr className="group">
                    <td colSpan={3}>
                      <b>{h.case}</b>
                    </td>
                  </tr>
                  {h.items.map((a, j) => (
                    <tr key={j}>
                      <td>
                        {a.label}
                        {a.edited && (
                          <>
                            {" "}
                            <Tag kind="corrige">ajustée</Tag>
                          </>
                        )}
                      </td>
                      <td className="num">{a.value}</td>
                      <td className="muted">{a.source}</td>
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>

          <h2>Annexe C — Méthode</h2>
          <p>
            <b>Détection :</b> détecteurs déterministes appliqués aux concepts des données (montants, retards, ressaisies, SLA…), indépendamment des noms de fichiers ; chaque constat cite les lignes ou extraits
            utilisés. Aucun chiffre n&apos;est produit par un modèle de langage.
          </p>
          <p>
            <b>Priorisation :</b> Priorité = {activeWeights.map(([k, w]) => `${pyFixed(w, 2)} × ${k}`).join(" + ")}
            {activePenalties.map(([k, w]) => ` − ${pyFixed(w, 2)} × ${k}`).join("")}
            {data.default_weights ? "" : " (coefficients personnalisés)"}. Les étiquettes P1/P2/P3 sont attribuées par rang au sein de la mission.
          </p>
          <p>
            <b>Chiffrage :</b> moteur ROI déterministe : heures/mois = Π facteurs ; valeur annuelle = heures × coût horaire × 12 ou Π facteurs ; payback = coût projet / (gain net / 12) ; ROI 12 mois = (gain net −
            coût projet) / coût projet ; ROI 36 mois = (3 × gain net − coût projet) / coût projet.
          </p>
          {data.completeness.gaps?.length ? (
            <p>
              <b>Limites des données :</b> {data.completeness.gaps.join(" ; ")}.
            </p>
          ) : null}

          <h2>Annexe D — Sources analysées ({data.sources.length})</h2>
          <table className="annex">
            <thead>
              <tr>
                <th>Fichier</th>
                <th>Catégorie</th>
                <th>Empreinte</th>
                <th>Statut</th>
              </tr>
            </thead>
            <tbody>
              {data.sources.map((s) => (
                <tr key={s.path}>
                  <td>{s.path}</td>
                  <td>{s.category}</td>
                  <td>{s.sha}</td>
                  <td>{s.status}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {data.validations.length > 0 && (
            <>
              <h2>Annexe E — Journal de validation</h2>
              <table className="annex">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Consultant</th>
                    <th>Élément</th>
                    <th>Décision</th>
                    <th>Champs modifiés</th>
                    <th>Commentaire</th>
                  </tr>
                </thead>
                <tbody>
                  {data.validations.map((v, i) => (
                    <tr key={i}>
                      <td>{v.when}</td>
                      <td>{v.who}</td>
                      <td>{v.what}</td>
                      <td>{v.status}</td>
                      <td>{v.fields}</td>
                      <td>{v.comment}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      </body>
    </html>
  );
}

export function renderHtml(data: ReportData): string {
  return `<!doctype html>\n${String(<Report data={data} />)}`;
}
