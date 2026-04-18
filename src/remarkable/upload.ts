import type { Env } from '../index';
import { getUserToken } from './auth';

const SYNC_HOST = 'https://internal.cloud.remarkable.com';
const BLOB_URL = `${SYNC_HOST}/sync/v3/files/`;
const ROOT_GET = `${SYNC_HOST}/sync/v4/root`;
const ROOT_PUT = `${SYNC_HOST}/sync/v3/root`;

export interface UploadInput {
  contentBase64: string;
  filename: string;
  folder: string;
}

export interface UploadResult {
  documentId: string;
  sizeBytes: number;
  resolvedParent: string; // empty string = root
  folderPath: string;     // the normalized folder path actually used
  fellBackToRoot: boolean;
}

interface RootMeta {
  hash: string;
  generation: number;
  schemaVersion?: number;
}

interface IndexLine {
  hash: string;
  type: string;
  id: string;
  subfiles: number;
  size: number;
}

// Wrap fetch with a per-request timeout and retry-on-5xx/abort. All reMarkable
// cloud operations in this module are idempotent — blob PUTs are keyed by
// content hash (so a retry writes the same bytes at the same key), GETs are
// pure, and the root commit's generation check makes a "duplicate" commit a
// no-op (returns 412, which the outer concurrency loop handles). That makes
// retries safe across the board.
//
// Default 25s per attempt × 3 attempts ≈ 75s worst case — still under the
// Cloudflare 524 edge timeout (100s) that bit us on the first real upload.
async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  opts: { timeoutMs?: number; maxAttempts?: number } = {},
): Promise<Response> {
  const { timeoutMs = 25_000, maxAttempts = 3 } = opts;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(url, { ...init, signal: controller.signal });
      clearTimeout(timer);
      // Retry server errors but return 4xx immediately (they're not transient).
      if (resp.status >= 500 && resp.status < 600 && attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 400 * attempt));
        continue;
      }
      return resp;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 400 * attempt));
        continue;
      }
    }
  }
  throw new Error(
    `fetch ${url} failed after ${maxAttempts} attempts: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  );
}

const CRC32C_TABLE = ((): Uint32Array => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32c(bytes: Uint8Array): Uint8Array {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC32C_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  crc = (crc ^ 0xffffffff) >>> 0;
  return new Uint8Array([
    (crc >>> 24) & 0xff,
    (crc >>> 16) & 0xff,
    (crc >>> 8) & 0xff,
    crc & 0xff,
  ]);
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function unhex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(s.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function b64encode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function uuidv4(): string {
  const r = new Uint8Array(16);
  crypto.getRandomValues(r);
  r[6] = (r[6] & 0x0f) | 0x40;
  r[8] = (r[8] & 0x3f) | 0x80;
  const h = hex(r);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

async function putBlob(
  userToken: string,
  hashHex: string,
  filename: string,
  body: Uint8Array,
  contentType = 'application/octet-stream',
): Promise<void> {
  const resp = await fetchWithRetry(BLOB_URL + hashHex, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${userToken}`,
      'rm-filename': filename,
      'x-goog-hash': `crc32c=${b64encode(crc32c(body))}`,
      'content-type': contentType,
    },
    body,
  });
  if (!resp.ok) {
    throw new Error(`PUT ${hashHex} (${filename}) -> ${resp.status} ${await resp.text()}`);
  }
}

async function fetchRootMeta(userToken: string): Promise<RootMeta> {
  const resp = await fetchWithRetry(ROOT_GET, {
    headers: { Authorization: `Bearer ${userToken}` },
  });
  if (resp.status === 404) return { hash: '', generation: 0 };
  if (!resp.ok) throw new Error(`GET /sync/v4/root -> ${resp.status}`);
  return (await resp.json()) as RootMeta;
}

async function fetchRootIndex(
  userToken: string,
  rootHash: string,
): Promise<IndexLine[]> {
  if (!rootHash) return [];
  const resp = await fetchWithRetry(BLOB_URL + rootHash, {
    headers: {
      Authorization: `Bearer ${userToken}`,
      'rm-filename': 'root.docSchema',
    },
  });
  if (!resp.ok) {
    throw new Error(`GET root index -> ${resp.status}`);
  }
  const text = await resp.text();
  const rows = text.split('\n').filter((l) => l.length > 0);
  const schema = rows.shift();
  if (schema === '4') rows.shift();
  return rows.map((l) => {
    const p = l.split(':');
    return {
      hash: p[0],
      type: p[1],
      id: p[2],
      subfiles: parseInt(p[3], 10),
      size: parseInt(p[4], 10),
    };
  });
}

async function hashConcatenated(hexHashes: string[]): Promise<string> {
  const concat = new Uint8Array(hexHashes.length * 32);
  for (let i = 0; i < hexHashes.length; i++) {
    concat.set(unhex(hexHashes[i]), i * 32);
  }
  return hex(await sha256(concat));
}

// ─── Folder resolution ──────────────────────────────────────────────────────

interface DocMetadata {
  visibleName: string;
  type: string;
  parent: string;
}

async function fetchDocMetadata(
  userToken: string,
  entry: IndexLine,
): Promise<DocMetadata | null> {
  // 1. Get the doc's sub-index (schema v3 list of files: .metadata, .content, ...)
  const subIndexResp = await fetchWithRetry(BLOB_URL + entry.hash, {
    headers: { Authorization: `Bearer ${userToken}`, 'rm-filename': entry.id },
  });
  if (!subIndexResp.ok) return null;

  const rows = (await subIndexResp.text()).split('\n').filter((l) => l.length > 0);
  rows.shift(); // drop schema line

  let metaHash: string | null = null;
  for (const row of rows) {
    const parts = row.split(':');
    if (parts[2]?.endsWith('.metadata')) {
      metaHash = parts[0];
      break;
    }
  }
  if (!metaHash) return null;

  // 2. Fetch the metadata blob
  const metaResp = await fetchWithRetry(BLOB_URL + metaHash, {
    headers: { Authorization: `Bearer ${userToken}`, 'rm-filename': `${entry.id}.metadata` },
  });
  if (!metaResp.ok) return null;

  const j = (await metaResp.json()) as Record<string, unknown>;
  return {
    visibleName: (j.visibleName as string) ?? '',
    type: (j.type as string) ?? '',
    parent: (j.parent as string) ?? '',
  };
}

// Folder resolution intentionally only reads from KV — never walks the tree
// at request time. Cloudflare Workers Free-plan subrequest budget is too
// tight for live resolution on non-trivial libraries. Populate the cache via
// the `scripts/sync-folders.sh` bootstrap (reads rmapi's local tree cache and
// writes `folder:/Inbox → <uuid>` entries via wrangler kv). Uploads to a
// folder not in the cache fall back to root with a flag, so nothing ever
// hard-errors on a user-facing path.
async function resolveFolder(
  path: string,
  _userToken: string,
  env: Env,
): Promise<{ parentId: string; fellBack: boolean; normalized: string }> {
  const clean = path.replace(/^\/+|\/+$/g, '');
  if (!clean) return { parentId: '', fellBack: false, normalized: '/' };

  const cached = await env.TOKEN_CACHE.get(`folder:/${clean}`);
  if (cached !== null) {
    return { parentId: cached, fellBack: false, normalized: `/${clean}` };
  }
  return { parentId: '', fellBack: true, normalized: `/${clean}` };
}

function buildMetadata(displayName: string, parent: string, nowMs: string): string {
  return JSON.stringify({
    visibleName: displayName,
    type: 'DocumentType',
    parent,
    lastModified: nowMs,
    lastOpened: '',
    lastOpenedPage: 0,
    version: 0,
    pinned: false,
    synced: true,
    modified: false,
    deleted: false,
    metadatamodified: false,
  });
}

function buildContent(): string {
  return JSON.stringify({
    dummyDocument: false,
    extraMetadata: {
      LastBrushColor: '',
      LastBrushThicknessScale: '',
      LastColor: '',
      LastEraserThicknessScale: '',
      LastEraserTool: '',
      LastPen: 'Finelinerv2',
      LastPenColor: '',
      LastPenThicknessScale: '',
      LastPencil: '',
      LastPencilColor: '',
      LastPencilThicknessScale: '',
      LastTool: 'Finelinerv2',
      ThicknessScale: '',
      LastFinelinerv2Size: '1',
    },
    fileType: 'pdf',
    fontName: '',
    lastOpenedPage: 0,
    lineHeight: -1,
    margins: 180,
    orientation: '',
    pageCount: 0,
    pages: null,
    pageTags: null,
    tags: null,
    redirectionPageMap: null,
    textScale: 1,
  });
}

export async function uploadPdf(input: UploadInput, env: Env): Promise<UploadResult> {
  const userToken = await getUserToken(env);
  const docId = uuidv4();
  const displayName = input.filename.replace(/\.pdf$/i, '');
  const pdfBytes = b64decode(input.contentBase64);
  const resolved = await resolveFolder(input.folder, userToken, env);
  const parent = resolved.parentId;

  const encoder = new TextEncoder();
  const metadataBytes = encoder.encode(buildMetadata(displayName, parent, String(Date.now())));
  const contentBytes = encoder.encode(buildContent());

  const metadataHash = hex(await sha256(metadataBytes));
  const contentHash = hex(await sha256(contentBytes));
  const pdfHash = hex(await sha256(pdfBytes));

  const files = [
    { id: `${docId}.content`, hash: contentHash, size: contentBytes.length },
    { id: `${docId}.metadata`, hash: metadataHash, size: metadataBytes.length },
    { id: `${docId}.pdf`, hash: pdfHash, size: pdfBytes.length },
  ].sort((a, b) => (a.id < b.id ? -1 : 1));

  const docHash = await hashConcatenated(files.map((f) => f.hash));
  const docSize = files.reduce((s, f) => s + f.size, 0);

  const docIndexText =
    '3\n' +
    files.map((f) => `${f.hash}:0:${f.id}:0:${f.size}`).join('\n') +
    '\n';

  await putBlob(userToken, metadataHash, `${docId}.metadata`, metadataBytes);
  await putBlob(userToken, contentHash, `${docId}.content`, contentBytes);
  await putBlob(userToken, pdfHash, `${docId}.pdf`, pdfBytes);
  await putBlob(
    userToken,
    docHash,
    `${docId}.docSchema`,
    encoder.encode(docIndexText),
    'text/plain; charset=UTF-8',
  );

  for (let attempt = 0; attempt < 10; attempt++) {
    const meta = await fetchRootMeta(userToken);
    const existing = await fetchRootIndex(userToken, meta.hash);

    const newEntry: IndexLine = {
      hash: docHash,
      type: '0',
      id: docId,
      subfiles: files.length,
      size: docSize,
    };
    const all = [...existing, newEntry].sort((a, b) => (a.id < b.id ? -1 : 1));

    const totalSize = all.reduce((s, l) => s + l.size, 0);
    let rootText = `4\n0:.:${all.length}:${totalSize}\n`;
    for (const l of all) {
      rootText += `${l.hash}:0:${l.id}:${l.subfiles}:${l.size}\n`;
    }

    const rootBytes = encoder.encode(rootText);
    const newRootHash = hex(await sha256(rootBytes));

    await putBlob(
      userToken,
      newRootHash,
      'root.docSchema',
      rootBytes,
      'text/plain; charset=UTF-8',
    );

    const commit = await fetchWithRetry(ROOT_PUT, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${userToken}`,
        'rm-filename': 'roothash',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        broadcast: true,
        hash: newRootHash,
        generation: meta.generation,
      }),
    });

    if (commit.ok) {
      return {
        documentId: docId,
        sizeBytes: pdfBytes.length,
        resolvedParent: parent,
        folderPath: resolved.fellBack ? '/ (root)' : resolved.normalized,
        fellBackToRoot: resolved.fellBack,
      };
    }
    if (commit.status === 412) continue;
    throw new Error(`Root commit -> ${commit.status} ${await commit.text()}`);
  }

  throw new Error('Root commit: 10 generation-conflict retries exhausted');
}
