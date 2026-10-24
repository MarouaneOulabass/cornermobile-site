/**
 * File transfer for the source library. Locally (and for small batches) files go to the API as multipart; on
 * Vercel, where a function accepts at most 4.5 MB per request, the browser sends each file straight to Vercel Blob
 * (private store, short-lived token scoped to the batch folder) and the API then registers the batch.
 */
import { api } from "@/lib/api";
import type { AppConfig, UploadResult } from "@/lib/types";

export type Picked = { file: File; path: string };

const PARALLEL = 4;
const MULTIPART_ABOVE = 8 * 1024 * 1024;

function blobName(index: number, name: string): string {
  return `${index}-${name.normalize("NFKD").replace(/[^\w.-]+/g, "_")}`;
}

async function sendToBlob(missionId: string, files: Picked[], onProgress?: (done: number, total: number) => void): Promise<UploadResult> {
  const { upload } = await import("@vercel/blob/client");
  const { prefix } = await api.post<{ prefix: string }>(`/missions/${missionId}/documents/blob-batch`);
  const uploaded: { pathname: string; path: string }[] = new Array(files.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < files.length) {
      const i = next++;
      const { file, path } = files[i];
      const blob = await upload(`${prefix}/${blobName(i, file.name)}`, file, {
        access: "private",
        handleUploadUrl: `/api/missions/${missionId}/documents/blob-token`,
        headers: { "X-Requested-With": "auditflow" },
        multipart: file.size > MULTIPART_ABOVE,
      });
      uploaded[i] = { pathname: blob.pathname, path };
      onProgress?.(++done, files.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, files.length) }, worker));
  return api.post<UploadResult>(`/missions/${missionId}/documents/blob`, { prefix, files: uploaded });
}

export async function sendFiles(missionId: string, files: Picked[], config: AppConfig | undefined, onProgress?: (done: number, total: number) => void): Promise<UploadResult> {
  if (config?.uploads === "blob") return sendToBlob(missionId, files, onProgress);
  const form = new FormData();
  for (const p of files) {
    form.append("files", p.file, p.file.name);
    form.append("paths", p.path);
  }
  return api.post<UploadResult>(`/missions/${missionId}/documents`, form);
}
