/** Accent-insensitive normalisation shared by classification, embeddings and search. */
import { stripAccents } from "../lib/py";

/** Python: unicodedata.normalize("NFKD", text.lower()) without combining marks. */
export function normalize(text: string): string {
  return stripAccents(text.toLowerCase());
}
