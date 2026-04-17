import type { Env } from '../index';
import { getUserToken } from './auth';

export interface UploadInput {
  contentBase64: string;
  filename: string;
  folder: string;
}

export interface UploadResult {
  documentId: string;
  sizeBytes: number;
}

// TODO: port rmapi v0.0.32's v4-schema upload flow.
// Reference: https://github.com/ddvk/rmapi/tree/master/api
// High-level steps:
//   1. GET  /sync/v3/root           → current root hash + generation
//   2. Build document blobs: {uuid}.content, {uuid}.metadata, {uuid}.pagedata,
//      {uuid}.pdf (the payload). Each blob's key is sha256(content).
//   3. Upload a new "root index" blob listing these files plus everything
//      currently in root.
//   4. POST /sync/v3/root with new hash + previous generation to commit.
export async function uploadPdf(input: UploadInput, env: Env): Promise<UploadResult> {
  const userToken = await getUserToken(env);
  void userToken;
  void input;
  throw new Error('uploadPdf: not yet implemented — porting rmapi v4 upload flow');
}
