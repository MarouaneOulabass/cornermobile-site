import { expect, type Page, test } from "@playwright/test";

const PASSWORD = process.env.E2E_PASSWORD ?? "demo-auditflow";

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.fill("input[type=email]", email);
  await page.fill("input[type=password]", PASSWORD);
  await page.click("button[type=submit]");
  await page.waitForURL("**/");
}

async function openMission(page: Page, company: string): Promise<string> {
  const card = page.getByTestId("portfolio-card").filter({ hasText: company });
  await card.click();
  await page.waitForURL(/\/m\/[^/]+/);
  return page.url().match(/\/m\/([^/?#]+)/)![1];
}

test.describe.serial("Parcours de démonstration (spec §15)", () => {
  let missionId = "";

  test("le consultant suit la mission de la source au rapport", async ({ page }) => {
    await login(page, "consultant@auditflow.demo");
    await expect(page.getByTestId("portfolio-card")).toHaveCount(3);
    missionId = await openMission(page, "AtlasPro Distribution");

    // Sources: the library and a cited full-text search.
    await page.goto(`/m/${missionId}/sources`);
    await expect(page.getByTestId("doc-grid")).toContainText("quotes.csv");
    await page.getByLabel("Recherche plein texte").fill("pénalité SLA");
    await page.getByRole("button", { name: "Rechercher" }).click();
    await expect(page.getByText(/contract_0\d\.md/).first()).toBeVisible();

    // Pain points: every finding opens on its evidence, down to the source rows.
    await page.goto(`/m/${missionId}/pain-points`);
    await page.getByTestId("pain-list").getByRole("button").filter({ hasText: "Devis préparés manuellement" }).click();
    await expect(page.getByTestId("metric-row").first()).toBeVisible();
    await page.getByTestId("evidence-card").first().click();
    await expect(page.getByTestId("table-view").or(page.getByTestId("text-view")).first()).toBeVisible();
    await page.keyboard.press("Escape");

    // Opportunities and business case: changing an assumption moves the ROI live.
    await page.goto(`/m/${missionId}/opportunities`);
    await expect(page.getByTestId("impact-effort-matrix")).toBeVisible();
    await page.getByTestId("opp-list").getByRole("link").filter({ hasText: "Copilote de devis" }).click();
    const gross = page.getByTestId("gross-value");
    const before = await gross.innerText();
    const adoption = page.getByLabel("Taux d'adoption par les commerciaux");
    await adoption.fill("50");
    await expect(gross).not.toHaveText(before);

    // Roadmap: the 90-day board.
    await page.goto(`/m/${missionId}/roadmap`);
    await expect(page.getByTestId("roadmap-90")).toBeVisible();
    await expect(page.getByTestId("roadmap-card").first()).toBeVisible();

    // Report: draft preview, PDF export, publication.
    await page.goto(`/m/${missionId}/report`);
    const preview = page.frameLocator("[data-testid=report-preview]");
    await expect(preview.getByText("Synthèse exécutive")).toBeVisible();
    await expect(preview.getByText("VERSION DE TRAVAIL — NON PUBLIÉE").first()).toBeVisible();
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Exporter PDF" }).click()]);
    expect(download.suggestedFilename()).toMatch(/^rapport-atlaspro-distribution-v\d+-brouillon\.pdf$/);
    await page.getByText("Je publie en connaissance de cause").click();
    await page.getByRole("button", { name: "Publier" }).click();
    await expect(page.getByText(/Publié le/)).toBeVisible();
  });

  test("le dirigeant lit la version publiée et télécharge le PDF", async ({ page }) => {
    await login(page, "dirigeant@atlaspro.demo");
    await expect(page.getByTestId("portfolio-card")).toHaveCount(1);
    await page.goto(`/m/${missionId}/report`);
    const preview = page.frameLocator("[data-testid=report-preview]");
    await expect(preview.getByText("Synthèse exécutive")).toBeVisible();
    await expect(preview.getByText("VERSION DE TRAVAIL — NON PUBLIÉE")).toHaveCount(0);
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Télécharger le PDF" }).click()]);
    expect(download.suggestedFilename()).toMatch(/^rapport-atlaspro-distribution-v\d+\.pdf$/);
  });

  test("une autre organisation ne voit rien d'AtlasPro", async ({ page }) => {
    await login(page, "dirigeant@darna.demo");
    await expect(page.getByTestId("portfolio-card")).toHaveCount(1);
    await expect(page.getByTestId("portfolio-card")).not.toContainText("AtlasPro");
    const status = await page.evaluate(async (id) => (await fetch(`/api/missions/${id}/report/html`)).status, missionId);
    expect(status).toBe(404);
  });
});
