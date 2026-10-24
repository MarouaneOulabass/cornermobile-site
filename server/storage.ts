/**
 * Object storage for originals and exports: Vercel Blob (private blobs) in deployed environments, the local disk
 * otherwise. Keys are always "org/<org>/mission/<mission>/…", so a mission is deleted by prefix.
 */
import { mkdir, readFile, rm, stat, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { env } from "./env";

export interface Storage {
  put(key: string, data: Uint8Array, contentType?: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
  deletePrefix(prefix: string): Promise<number>;
}

export function safeKey(key: string): string {
  const parts = key.split("/").filter((p) => p !== "" && p !== "." && p !== "..");
  if (parts.length === 0) throw new Error("empty storage key");
  return parts.join("/");
}

export function missionPrefix(orgId: string, missionId: string): string {
  return `org/${orgId}/mission/${missionId}`;
}

class LocalStorage implements Storage {
  constructor(private readonly root: string) {}

  private file(key: string): string {
    return path.join(this.root, ...safeKey(key).split("/"));
  }

  async put(key: string, data: Uint8Array): Promise<void> {
    const file = this.file(key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, data);
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.file(key));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.file(key));
      return true;
    } catch {
      return false;
    }
  }

  async deletePrefix(prefix: string): Promise<number> {
    const dir = this.file(prefix);
    let count = 0;
    const walk = async (p: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(p, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.isDirectory()) await walk(path.join(p, e.name));
        else count += 1;
      }
    };
    await walk(dir);
    await rm(dir, { recursive: true, force: true });
    return count;
  }
}

class BlobStorage implements Storage {
  constructor(private readonly token: string) {}

  async put(key: string, data: Uint8Array, contentType?: string): Promise<void> {
    const { put } = await import("@vercel/blob");
    await put(safeKey(key), Buffer.from(data), {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType,
      token: this.token,
    });
  }

  async get(key: string): Promise<Buffer> {
    const { get } = await import("@vercel/blob");
    const result = await get(safeKey(key), { access: "private", token: this.token, useCache: false });
    if (!result) throw new Error(`blob not found: ${key}`);
    return Buffer.from(await new Response(result.stream).arrayBuffer());
  }

  async exists(key: string): Promise<boolean> {
    const { head } = await import("@vercel/blob");
    try {
      await head(safeKey(key), { token: this.token });
      return true;
    } catch {
      return false;
    }
  }

  async deletePrefix(prefix: string): Promise<number> {
    const { del, list } = await import("@vercel/blob");
    let cursor: string | undefined;
    let count = 0;
    do {
      const page = await list({ prefix: `${safeKey(prefix)}/`, cursor, token: this.token });
      if (page.blobs.length) {
        await del(page.blobs.map((b) => b.url), { token: this.token });
        count += page.blobs.length;
      }
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    return count;
  }
}

let storage: Storage | null = null;
let storageConfig = "";

export function getStorage(): Storage {
  const e = env();
  const config = e.BLOB_READ_WRITE_TOKEN ? "blob" : `local:${e.AUDITFLOW_STORAGE_DIR}`;
  if (!storage || storageConfig !== config) {
    storage = e.BLOB_READ_WRITE_TOKEN ? new BlobStorage(e.BLOB_READ_WRITE_TOKEN) : new LocalStorage(e.AUDITFLOW_STORAGE_DIR);
    storageConfig = config;
  }
  return storage;
}
