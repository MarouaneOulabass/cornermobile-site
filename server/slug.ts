import { stripAccents } from "./lib/py";

/** ASCII slug, as in the Python version (NFKD, ascii-only, non-alphanumerics → "-", 80 characters). */
export function slugify(name: string): string {
  const ascii = stripAccents(name).replace(/[^\x00-\x7f]/g, "");
  return (
    ascii
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "org"
  );
}
