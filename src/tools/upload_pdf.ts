import type { Env } from '../index';
import { uploadPdf } from '../remarkable/upload';
import { checkAndConsume } from '../ratelimit';

export const uploadPdfTool = {
  name: 'upload_pdf',
  description:
    "Upload a PDF to Steve's reMarkable tablet. WRITE-ONLY: this server cannot read, modify, or delete existing documents. Files land in /Inbox on the tablet by default.",
  inputSchema: {
    type: 'object',
    properties: {
      content_base64: {
        type: 'string',
        description: 'Base64-encoded PDF file contents.',
      },
      filename: {
        type: 'string',
        description:
          'Name to display on the tablet. Extension optional; ".pdf" is added if missing.',
      },
      folder: {
        type: 'string',
        description: 'Destination folder path on the tablet. Defaults to /Inbox.',
        default: '/Inbox',
      },
    },
    required: ['content_base64', 'filename'],
  },
} as const;

export async function handleUploadPdf(
  args: Record<string, unknown>,
  env: Env,
  _ctx: ExecutionContext,
): Promise<string> {
  const content_base64 = args.content_base64;
  const filename = args.filename;
  const folder =
    (args.folder as string | undefined) ?? env.DEFAULT_FOLDER ?? '/Inbox';

  if (typeof content_base64 !== 'string' || content_base64.length === 0) {
    throw new Error('content_base64 is required (non-empty base64 string)');
  }
  if (typeof filename !== 'string' || filename.length === 0) {
    throw new Error('filename is required');
  }

  const bytes = Uint8Array.from(atob(content_base64), (c) => c.charCodeAt(0));
  await checkAndConsume(env, bytes.length);

  const result = await uploadPdf(
    { contentBase64: content_base64, filename, folder },
    env,
  );

  return `Uploaded "${filename}" (${result.sizeBytes} bytes) to ${folder}. Document ID: ${result.documentId}`;
}
