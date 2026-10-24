/**
 * The report as a PDF, from the same data model as the HTML page. Pure JavaScript (@react-pdf/renderer): no Pango,
 * Cairo or headless browser, so exports work identically on Vercel and on a Windows workstation.
 */
import path from "node:path";
import { Document, Font, Link, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import type { ReactNode } from "react";
import { pyFixed, pyRound } from "../lib/py";
import type { ReportCase, ReportData } from "../services/report";

const FONTS = path.join(process.cwd(), "server", "report", "fonts");
let fontsReady = false;

function registerFonts(): void {
  if (fontsReady) return;
  Font.register({
    family: "Inter",
    fonts: [
      { src: path.join(FONTS, "Inter-Regular.ttf"), fontWeight: 400 },
      { src: path.join(FONTS, "Inter-SemiBold.ttf"), fontWeight: 600 },
      { src: path.join(FONTS, "Inter-Bold.ttf"), fontWeight: 700 },
      { src: path.join(FONTS, "Inter-ExtraBold.ttf"), fontWeight: 800 },
    ],
  });
  // Fallback for glyphs Inter lacks (∪, Arabic names…), and excerpts.
  Font.register({ family: "DejaVu", src: path.join(FONTS, "DejaVuSans.ttf") });
  Font.register({ family: "DejaVuMono", src: path.join(FONTS, "DejaVuSansMono.ttf") });
  // French text: never break words with English hyphenation rules; long paths and identifiers may wrap after
  // "/", "_" or ".".
  Font.registerHyphenationCallback((word) => (word.length > 18 ? word.split(/(?<=[/_.])/) : [word]));
  fontsReady = true;
}

const INK = "#18212f";
const MUTED = "#6b7280";
const LINE = "#e5e7eb";
const INFO = "#2563eb";
const VALUE = "#15803d";
const CHECK = "#b45309";
const RISK = "#b91c1c";
const SOFT = "#f8fafc";

const TAG_COLORS: Record<string, [string, string]> = {
  critique: ["#fee2e2", RISK],
  elevee: ["#fee2e2", RISK],
  moyenne: ["#ffedd5", CHECK],
  fait: ["#dbeafe", INFO],
  calcul: ["#dcfce7", VALUE],
  hypothese: ["#ffedd5", CHECK],
  a_verifier: ["#ffedd5", CHECK],
  valide: ["#dcfce7", VALUE],
  corrige: ["#dbeafe", INFO],
  P1: ["#dcfce7", VALUE],
  P2: ["#dbeafe", INFO],
};

const s = StyleSheet.create({
  page: { fontFamily: ["Inter", "DejaVu"], fontSize: 9, lineHeight: 1.4, color: INK, paddingTop: 48, paddingBottom: 48, paddingHorizontal: 45 },
  cover: { fontFamily: ["Inter", "DejaVu"], fontSize: 9, color: INK, padding: 50, justifyContent: "space-between" },
  brand: { fontSize: 14, fontWeight: 800 },
  eyebrow: { fontSize: 7.5, fontWeight: 700, color: MUTED, textTransform: "uppercase", letterSpacing: 0.6 },
  h1: { fontSize: 28, fontWeight: 800, marginTop: 6, marginBottom: 4 },
  h2: { fontSize: 14, fontWeight: 700, marginTop: 18, marginBottom: 8, paddingBottom: 4, borderBottomWidth: 2, borderBottomColor: INK },
  h3: { fontSize: 10.5, fontWeight: 700, marginTop: 10, marginBottom: 4 },
  p: { marginBottom: 5 },
  muted: { color: MUTED },
  small: { fontSize: 7.5 },
  draft: { marginTop: 8, alignSelf: "flex-start", borderWidth: 1.2, borderColor: CHECK, color: CHECK, borderRadius: 4, paddingHorizontal: 8, paddingVertical: 3, fontWeight: 700 },
  figures: { flexDirection: "row", gap: 6, marginVertical: 8 },
  figure: { flex: 1, borderWidth: 1, borderColor: LINE, borderRadius: 6, padding: 7 },
  figureValue: { fontSize: 13, fontWeight: 700, marginVertical: 2 },
  callout: { borderLeftWidth: 3, borderLeftColor: INFO, backgroundColor: SOFT, padding: 7, borderRadius: 4, marginVertical: 5 },
  box: { borderWidth: 1, borderColor: LINE, borderRadius: 6, padding: 8, marginVertical: 5 },
  head: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 6 },
  tags: { flexDirection: "row", gap: 3, flexShrink: 0 },
  tag: { alignSelf: "flex-start", fontSize: 6.5, fontWeight: 700, paddingHorizontal: 5, paddingVertical: 1.5, borderRadius: 8, backgroundColor: "#f3f4f6", color: "#374151" },
  ref: { fontSize: 6, fontWeight: 700, color: INFO, textDecoration: "none" },
  table: { marginVertical: 4 },
  tr: { flexDirection: "row", borderBottomWidth: 0.6, borderBottomColor: LINE },
  th: { fontSize: 6.5, fontWeight: 700, color: MUTED, textTransform: "uppercase", paddingVertical: 3, paddingHorizontal: 4 },
  td: { paddingVertical: 3, paddingHorizontal: 4, fontSize: 8 },
  num: { textAlign: "right" },
  kpis: { flexDirection: "row", gap: 5, marginVertical: 5 },
  kpi: { flex: 1, backgroundColor: SOFT, borderRadius: 4, padding: 5 },
  kpiValue: { fontSize: 10, fontWeight: 700 },
  bar: { height: 5, backgroundColor: LINE, borderRadius: 3 },
  barFill: { height: 5, backgroundColor: INFO, borderRadius: 3 },
  phase: { borderTopWidth: 3, borderTopColor: "#93c5fd", paddingTop: 3, marginTop: 8 },
  excerpt: { fontFamily: "DejaVuMono", fontSize: 6.5, color: "#4b5563", marginTop: 2 },
  footerLeft: { position: "absolute", bottom: 22, left: 45, right: 160, fontSize: 7.5, color: MUTED },
  header: { position: "absolute", top: 20, right: 45, fontSize: 7.5, color: CHECK, fontWeight: 700 },
});

function Tag({ kind, children }: { kind?: string; children: ReactNode }) {
  const [bg, fg] = (kind && TAG_COLORS[kind]) || ["#f3f4f6", "#374151"];
  return <Text style={[s.tag, { backgroundColor: bg, color: fg }]}>{children}</Text>;
}

function Refs({ refs }: { refs: number[] }) {
  if (!refs.length) return null;
  return (
    <Text>
      {refs.map((n) => (
        <Link key={n} src={`#E${n}`} style={s.ref}>
          {` E${n}`}
        </Link>
      ))}
    </Text>
  );
}

interface Column {
  label: string;
  width: number | string;
  align?: "right";
}

function Table({ columns, rows, header = true }: { columns: Column[]; rows: ReactNode[][]; header?: boolean }) {
  const cell = (c: Column) => ({ width: typeof c.width === "number" ? `${c.width}%` : c.width, ...(c.align === "right" ? s.num : {}) });
  return (
    <View style={s.table}>
      {header && (
        <View style={s.tr} fixed={false}>
          {columns.map((c, i) => (
            <Text key={i} style={[s.th, cell(c)]}>
              {c.label}
            </Text>
          ))}
        </View>
      )}
      {rows.map((row, i) => (
        <View key={i} style={s.tr} wrap={false}>
          {row.map((content, j) => (
            <View key={j} style={[s.td, cell(columns[j])]}>
              {typeof content === "string" || typeof content === "number" ? <Text style={columns[j].align === "right" ? s.num : undefined}>{content}</Text> : content}
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

function Case({ c }: { c: ReportCase }) {
  return (
    <View style={s.box}>
      <View style={s.head} wrap={false}>
        <Text style={[s.h3, { marginTop: 0, flex: 1 }]}>{c.title}</Text>
        <View style={s.tags}>
          <Tag kind={c.priority}>{c.priority}</Tag>
          <Tag kind={c.status_key}>{c.status}</Tag>
        </View>
      </View>
      <Text style={s.p}>{c.summary}</Text>
      <Text style={[s.p, s.muted, s.small]}>
        <Text style={{ fontWeight: 700 }}>{c.category}</Text> — {c.rationale}
      </Text>
      <View style={s.kpis} wrap={false}>
        {[
          ["Valeur brute", `${c.value}/an`],
          ["Gain net", `${c.net}/an`],
          ["Payback", c.payback],
          ["ROI 12 / 36 mois", `${c.roi12} / ${c.roi36}`],
        ].map(([label, value]) => (
          <View key={label} style={s.kpi}>
            <Text style={s.small}>{label}</Text>
            <Text style={s.kpiValue}>{value}</Text>
          </View>
        ))}
      </View>
      {c.lines.length > 0 && (
        <Table
          columns={[
            { label: "Source de valeur", width: 75 },
            { label: "Valeur / an", width: 25, align: "right" },
          ]}
          rows={[
            ...c.lines.map((l) => [l.label, l.value]),
            [<Text key="c" style={s.muted}>{`Coût projet ${c.project_cost} · coût récurrent ${c.run_cost}/an · ${c.hours} h/mois économisées`}</Text>, ""],
          ]}
        />
      )}
      <Table
        columns={[
          { label: "Hypothèse", width: 32 },
          { label: "Valeur", width: 16, align: "right" },
          { label: "Nature", width: 14 },
          { label: "Source / justification", width: 38 },
        ]}
        rows={c.assumptions.map((a) => [
          <Text key="l">
            {a.label}
            <Refs refs={a.refs} />
            {a.edited ? " (ajustée)" : ""}
          </Text>,
          a.value,
          <Tag key="n" kind={a.nature_key}>
            {a.nature}
          </Tag>,
          <Text key="s" style={s.muted}>
            {a.source}
          </Text>,
        ])}
      />
      {c.pilot.length > 0 && (
        <Text style={s.small}>
          <Text style={{ fontWeight: 700 }}>Plan pilote : </Text>
          {c.pilot.map((p) => `${p.step} (${p.weeks} sem.)`).join(" → ")}
        </Text>
      )}
    </View>
  );
}

const SPECIAL_RECS = new Set(["summary", "decision", "hypotheses"]);

export function ReportPdf({ data }: { data: ReportData }) {
  const { organization: org, mission, figures } = data;
  const priorities = data.recommendations.filter((r) => !SPECIAL_RECS.has(r.key ?? ""));
  const weights = Object.entries(data.weights).filter(([, w]) => w > 0);
  const penalties = Object.entries(data.penalties).filter(([, w]) => w > 0);
  // Page numbers are stamped afterwards (numberPages): react-pdf's dynamic `render` breaks pagination here.
  const footer = (
    <Text style={s.footerLeft} fixed>
      {`${org.name} — ${mission.name}`}
    </Text>
  );
  const draft = mission.published ? null : (
    <Text style={s.header} fixed>
      VERSION DE TRAVAIL — NON PUBLIÉE
    </Text>
  );
  return (
    <Document title={`${org.name} — Rapport d'audit IA & Performance`} author="AuditFlow" subject={mission.name} language="fr">
      <Page size="A4" style={s.cover}>
        <Text style={s.brand}>
          Audit<Text style={{ color: INFO }}>Flow</Text>
        </Text>
        <View>
          <Text style={s.eyebrow}>Audit IA &amp; Performance — rapport dirigeant</Text>
          <Text style={s.h1}>{org.name}</Text>
          <Text style={s.muted}>
            {org.sector ?? ""}
            {org.city ? ` — ${org.city}` : ""}
            {org.employees ? ` — ${org.employees} collaborateurs` : ""}
          </Text>
          {mission.published ? (
            <Text style={{ marginTop: 6 }}>
              <Text style={{ fontWeight: 700 }}>Publié le {mission.published_at}</Text> · analyse v{mission.version}
            </Text>
          ) : (
            <Text style={s.draft}>Version de travail — non publiée</Text>
          )}
        </View>
        <Text style={[s.small, s.muted]}>
          {`Généré le ${data.generated_at} · ${figures.sources} sources analysées · analyse v${mission.version}${mission.analyzed_at ? ` du ${mission.analyzed_at}` : ""}\n`}
          Document confidentiel. Chaque chiffre est relié à sa source (annexe A, références E#) et qualifié : Fait (lu dans une source), Calcul (déterministe) ou Hypothèse (à valider).
        </Text>
      </Page>

      <Page size="A4" style={s.page}>
        {draft}
        {footer}
        <Text style={s.h2}>1. Synthèse exécutive</Text>
        <View style={s.figures} wrap={false}>
          {[
            ["Potentiel brut annuel", figures.value, `${figures.opportunities} opportunités`, true],
            ["Opportunités prioritaires", figures.value_p1, `${figures.p1} en P1`, true],
            ["Irritants", String(figures.pain_points), `dont ${figures.critical} critiques`, false],
            ["Revue consultant", figures.reviewed, `confiance analyse ${figures.confidence}`, false],
          ].map(([label, value, note, money]) => (
            <View key={label as string} style={s.figure}>
              <Text style={s.eyebrow}>{label}</Text>
              <Text style={[s.figureValue, money ? { color: VALUE } : {}]}>{value}</Text>
              <Text style={[s.muted, s.small]}>{note}</Text>
            </View>
          ))}
        </View>
        {data.recommendations.map((r, i) =>
          r.key === "summary" ? (
            <Text key={i} style={s.p}>
              {r.text}
            </Text>
          ) : r.key === "decision" || r.key === "hypotheses" ? (
            <View key={i} style={[s.callout, r.key === "decision" ? { borderLeftColor: VALUE } : {}]} wrap={false}>
              <Text>
                <Text style={{ fontWeight: 700 }}>{r.title} : </Text>
                {r.text}
              </Text>
            </View>
          ) : null,
        )}
        {priorities.length > 0 && (
          <View>
            <Text style={s.h3}>Recommandations prioritaires</Text>
            {priorities.map((r, i) => (
              <Text key={i} style={[s.p, { paddingLeft: 10 }]}>
                {`${i + 1}. `}
                <Text style={{ fontWeight: 700 }}>{r.title}</Text> — {r.text}
              </Text>
            ))}
          </View>
        )}
        <Text style={s.h3}>Opportunités prioritaires</Text>
        <Table
          columns={[
            { label: "#", width: 5 },
            { label: "Opportunité", width: 29 },
            { label: "Catégorie", width: 15 },
            { label: "Valeur / an", width: 13, align: "right" },
            { label: "Payback", width: 10, align: "right" },
            { label: "Effort", width: 8 },
            { label: "Priorité", width: 8 },
            { label: "Statut", width: 12 },
          ]}
          rows={data.cases.slice(0, 8).map((c) => [
            String(c.rank || "—"),
            <Text key="t" style={{ fontWeight: 700 }}>
              {c.title}
            </Text>,
            c.category,
            c.value,
            c.payback,
            c.effort,
            <Tag key="p" kind={c.priority}>
              {c.priority}
            </Tag>,
            <Tag key="s" kind={c.status_key}>
              {c.status}
            </Tag>,
          ])}
        />
        {data.maturity.length > 0 && (
          <View wrap={false}>
            <Text style={s.h3}>Maturité opérationnelle</Text>
            <Table
              header={false}
              columns={[
                { label: "", width: 26 },
                { label: "", width: 20 },
                { label: "", width: 8, align: "right" },
                { label: "", width: 46 },
              ]}
              rows={data.maturity.map((m) => [
                <Text key="l" style={{ fontWeight: 700 }}>
                  {m.label}
                </Text>,
                <View key="b" style={[s.bar, { marginTop: 3 }]}>
                  <View style={[s.barFill, { width: `${pyFixed(pyRound(m.value * 100, 0), 0)}%` }]} />
                </View>,
                `${Math.trunc(pyRound(m.value * 100, 0))} %`,
                <Text key="e" style={[s.muted, s.small]}>
                  {m.explanation}
                </Text>,
              ])}
            />
          </View>
        )}

        <Text style={s.h2} break>
          2. Constats
        </Text>
        <Text style={[s.p, s.muted]}>Irritants classés par criticité. Les points marqués « hypothèse à valider » ne reposent sur aucune donnée directe.</Text>
        {data.findings.map((f, i) => (
          <View key={i} style={s.box} wrap={false}>
            <View style={s.head}>
              <Text style={{ fontWeight: 700, flex: 1 }}>
                {f.title}
                <Refs refs={f.refs} />
              </Text>
              <View style={s.tags}>
                <Tag kind={f.crit_key}>{f.criticality}</Tag>
                <Tag kind={f.status_key}>{f.status}</Tag>
                {f.hypothesis ? <Tag kind="hypothese">Hypothèse à valider</Tag> : null}
              </View>
            </View>
            <Text style={[s.muted, s.small]}>{`${f.department} · confiance ${f.confidence}`}</Text>
            <Text style={s.p}>{f.description}</Text>
            {f.metrics.length > 0 && (
              <Table
                header={false}
                columns={[
                  { label: "", width: 62 },
                  { label: "", width: 24, align: "right" },
                  { label: "", width: 14 },
                ]}
                rows={f.metrics.map((m) => [
                  <View key="l">
                    <Text>
                      {m.label}
                      <Refs refs={m.refs} />
                    </Text>
                    <Text style={[s.muted, { fontSize: 6.5 }]}>{m.formula}</Text>
                  </View>,
                  <Text key="v" style={[s.num, { fontWeight: 700 }]}>
                    {m.value}
                  </Text>,
                  <Tag key="n" kind={m.nature_key}>
                    {m.nature}
                  </Tag>,
                ])}
              />
            )}
          </View>
        ))}

        <Text style={s.h2} break>
          3. Business cases
        </Text>
        {data.cases.map((c) => (
          <Case key={c.id} c={c} />
        ))}

        <Text style={s.h2} break>
          4. Roadmap
        </Text>
        {data.roadmap.map((p) => (
          <View key={p.key} style={s.phase} wrap={false}>
            <Text style={s.h3}>{p.label}</Text>
            <Table
              header={false}
              columns={[
                { label: "", width: 52 },
                { label: "", width: 16 },
                { label: "", width: 12 },
                { label: "", width: 20 },
              ]}
              rows={p.items.map((i) => [
                <Text key="t" style={{ fontWeight: 700 }}>
                  {i.title}
                </Text>,
                <Tag key="k">{i.kind}</Tag>,
                i.weeks,
                <Text key="o" style={s.muted}>
                  {i.owner}
                </Text>,
              ])}
            />
          </View>
        ))}

        {data.risks.length > 0 && (
          <View>
            <Text style={s.h2}>5. Risques</Text>
            <Table
              columns={[
                { label: "Risque", width: 64 },
                { label: "Gravité", width: 16 },
                { label: "Exposition", width: 20, align: "right" },
              ]}
              rows={data.risks.map((r) => [
                <View key="r">
                  <Text style={{ fontWeight: 700 }}>{r.title}</Text>
                  <Text style={s.muted}>{r.description}</Text>
                </View>,
                <Tag key="g">{r.severity}</Tag>,
                r.exposure,
              ])}
            />
          </View>
        )}

        <Text style={s.h2} break>
          Annexe A — Preuves citées
        </Text>
        <Table
          columns={[
            { label: "Réf.", width: 7 },
            { label: "Source", width: 24 },
            { label: "Localisation", width: 19 },
            { label: "Constat / extrait", width: 50 },
          ]}
          rows={data.evidence.map((e) => [
            <Text key="n" id={`E${e.n}`} style={{ fontWeight: 700 }}>{`E${e.n}`}</Text>,
            <Text key="f" style={s.small}>
              {e.file}
            </Text>,
            <Text key="w" style={s.small}>
              {e.where}
            </Text>,
            <View key="s">
              <Text style={s.small}>
                {e.summary}
                {e.origin === "user" ? " (ajoutée par le consultant)" : ""}
              </Text>
              {e.excerpt ? <Text style={s.excerpt}>{e.excerpt}</Text> : null}
            </View>,
          ])}
        />

        <Text style={s.h2}>Annexe B — Hypothèses à valider</Text>
        {data.hypotheses.map((h, i) => (
          <View key={i}>
            <Text style={[s.h3, { fontSize: 9 }]}>{h.case}</Text>
            <Table
              header={i === 0}
              columns={[
                { label: "Hypothèse", width: 36 },
                { label: "Valeur", width: 16, align: "right" },
                { label: "Justification", width: 48 },
              ]}
              rows={h.items.map((a) => [
                `${a.label}${a.edited ? " (ajustée)" : ""}`,
                a.value,
                <Text key="s" style={[s.muted, s.small]}>
                  {a.source}
                </Text>,
              ])}
            />
          </View>
        ))}

        <Text style={s.h2}>Annexe C — Méthode</Text>
        <Text style={s.p}>
          <Text style={{ fontWeight: 700 }}>Détection : </Text>
          détecteurs déterministes appliqués aux concepts des données (montants, retards, ressaisies, SLA…), indépendamment des noms de fichiers ; chaque constat cite les lignes ou extraits utilisés. Aucun
          chiffre n&apos;est produit par un modèle de langage.
        </Text>
        <Text style={s.p}>
          <Text style={{ fontWeight: 700 }}>Priorisation : </Text>
          {`Priorité = ${weights.map(([k, w]) => `${pyFixed(w, 2)} × ${k}`).join(" + ")}${penalties.map(([k, w]) => ` − ${pyFixed(w, 2)} × ${k}`).join("")}${data.default_weights ? "" : " (coefficients personnalisés)"}. Les étiquettes P1/P2/P3 sont attribuées par rang au sein de la mission.`}
        </Text>
        <Text style={s.p}>
          <Text style={{ fontWeight: 700 }}>Chiffrage : </Text>
          moteur ROI déterministe : heures/mois = Π facteurs ; valeur annuelle = heures × coût horaire × 12 ou Π facteurs ; payback = coût projet / (gain net / 12) ; ROI 12 mois = (gain net − coût projet) / coût
          projet ; ROI 36 mois = (3 × gain net − coût projet) / coût projet.
        </Text>
        {data.completeness.gaps?.length ? (
          <Text style={s.p}>
            <Text style={{ fontWeight: 700 }}>Limites des données : </Text>
            {`${data.completeness.gaps.join(" ; ")}.`}
          </Text>
        ) : null}

        <Text style={s.h2}>{`Annexe D — Sources analysées (${data.sources.length})`}</Text>
        <Table
          columns={[
            { label: "Fichier", width: 50 },
            { label: "Catégorie", width: 18 },
            { label: "Empreinte", width: 18 },
            { label: "Statut", width: 14 },
          ]}
          rows={data.sources.map((src) => [src.path, src.category, src.sha, src.status])}
        />

        {data.validations.length > 0 && (
          <View>
            <Text style={s.h2}>Annexe E — Journal de validation</Text>
            <Table
              columns={[
                { label: "Date", width: 15 },
                { label: "Consultant", width: 16 },
                { label: "Élément", width: 14 },
                { label: "Décision", width: 11 },
                { label: "Champs modifiés", width: 18 },
                { label: "Commentaire", width: 26 },
              ]}
              rows={data.validations.map((v) => [v.when, v.who ?? "", v.what, v.status, v.fields, v.comment])}
            />
          </View>
        )}
      </Page>
    </Document>
  );
}

/** "Page n / N" at the bottom right of every page but the cover (same position and colour as the footer). */
async function numberPages(pdf: Uint8Array): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdf);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = doc.getPages();
  pages.forEach((page, i) => {
    if (i === 0) return;
    const label = `Page ${i + 1} / ${pages.length}`;
    const size = 7.5;
    const width = font.widthOfTextAtSize(label, size);
    page.drawText(label, { x: page.getWidth() - 45 - width, y: 22, size, font, color: rgb(0x6b / 255, 0x72 / 255, 0x80 / 255) });
  });
  return doc.save();
}

export async function renderPdf(data: ReportData): Promise<Uint8Array> {
  registerFonts();
  return numberPages(new Uint8Array(await renderToBuffer(<ReportPdf data={data} />)));
}
