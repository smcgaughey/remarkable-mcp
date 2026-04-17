import { handleMcpRequest } from './mcp';

export interface Env {
  TOKEN_CACHE: KVNamespace;
  RATE_LIMIT: KVNamespace;
  REMARKABLE_DEVICE_TOKEN: string;
  MCP_BEARER_TOKEN: string;
  DAILY_UPLOAD_CAP_MB: string;
  DEFAULT_FOLDER: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/health') {
      return Response.json({ ok: true, service: 'remarkable-mcp' });
    }

    if (url.pathname !== '/mcp') {
      return new Response('Not Found', { status: 404 });
    }

    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    const auth = request.headers.get('Authorization');
    if (!auth || auth !== `Bearer ${env.MCP_BEARER_TOKEN}`) {
      return new Response('Unauthorized', { status: 401 });
    }

    return handleMcpRequest(request, env, ctx);
  },
};
