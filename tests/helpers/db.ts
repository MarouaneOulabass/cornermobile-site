/** Integration-test helpers: a clean database per test. */
import { db } from "@/server/db";
import { resetData } from "@/server/maintenance";

export async function resetDb(): Promise<void> {
  await resetData(db);
}
