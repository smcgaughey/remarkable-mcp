import type { Env } from '../index';

export const createFolderTool = {
  name: 'create_folder',
  description:
    "Create a folder on Steve's reMarkable tablet. Optional companion to upload_pdf when a new destination is needed. Cannot delete or rename existing folders.",
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Folder path to create, e.g. "/Articles/2026".',
      },
    },
    required: ['path'],
  },
} as const;

export async function handleCreateFolder(
  _args: Record<string, unknown>,
  _env: Env,
  _ctx: ExecutionContext,
): Promise<string> {
  throw new Error('create_folder: not yet implemented');
}
