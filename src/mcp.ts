import type { Env } from './index';
import { uploadPdfTool, handleUploadPdf } from './tools/upload_pdf';
import { createFolderTool, handleCreateFolder } from './tools/create_folder';

const SERVER_INFO = { name: 'remarkable-mcp', version: '0.1.0' };
const TOOLS = [uploadPdfTool, createFolderTool];

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: unknown;
}

function rpcResult(id: unknown, result: unknown): Response {
  return Response.json({ jsonrpc: '2.0', id, result });
}

function rpcError(id: unknown, code: number, message: string): Response {
  return Response.json({ jsonrpc: '2.0', id, error: { code, message } });
}

export async function handleMcpRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  let body: JsonRpcRequest;
  try {
    body = await request.json();
  } catch {
    return rpcError(null, -32700, 'Parse error');
  }

  const { id = null, method, params } = body;

  try {
    switch (method) {
      case 'initialize':
        return rpcResult(id, {
          protocolVersion: '2024-11-05',
          serverInfo: SERVER_INFO,
          capabilities: { tools: {} },
        });

      case 'notifications/initialized':
        return new Response(null, { status: 202 });

      case 'ping':
        return rpcResult(id, {});

      case 'tools/list':
        return rpcResult(id, { tools: TOOLS });

      case 'tools/call': {
        const { name, arguments: args } = (params ?? {}) as {
          name?: string;
          arguments?: Record<string, unknown>;
        };
        let text: string;
        switch (name) {
          case 'upload_pdf':
            text = await handleUploadPdf(args ?? {}, env, ctx);
            break;
          case 'create_folder':
            text = await handleCreateFolder(args ?? {}, env, ctx);
            break;
          default:
            return rpcError(id, -32602, `Unknown tool: ${name}`);
        }
        return rpcResult(id, {
          content: [{ type: 'text', text }],
          isError: false,
        });
      }

      default:
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return rpcError(id, -32603, `Internal error: ${message}`);
  }
}
