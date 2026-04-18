import { handleMcpRequest } from './mcp';
import {
  handleAuthServerMetadata,
  handleProtectedResourceMetadata,
  handleRegister,
  handleAuthorize,
  handleToken,
  validateAccessToken,
} from './oauth';

export interface Env {
  TOKEN_CACHE: KVNamespace;
  RATE_LIMIT: KVNamespace;
  REMARKABLE_DEVICE_TOKEN: string;
  MCP_BEARER_TOKEN: string;
  DAILY_UPLOAD_CAP_MB: string;
  DEFAULT_FOLDER: string;
}

function unauthorized(request: Request): Response {
  const base = `${new URL(request.url).protocol}//${new URL(request.url).host}`;
  return new Response('Unauthorized', {
    status: 401,
    headers: {
      'WWW-Authenticate': `Bearer realm="remarkable-mcp", resource_metadata="${base}/.well-known/oauth-protected-resource"`,
    },
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Health check
    if (request.method === 'GET' && path === '/health') {
      return Response.json({ ok: true, service: 'remarkable-mcp' });
    }

    // OAuth discovery — unauthenticated
    if (request.method === 'GET' && path === '/.well-known/oauth-authorization-server') {
      return handleAuthServerMetadata(request);
    }
    // Accept bare path and any scoped variant (e.g. /.well-known/oauth-protected-resource/mcp)
    if (request.method === 'GET' && path.startsWith('/.well-known/oauth-protected-resource')) {
      return handleProtectedResourceMetadata(request);
    }

    // OAuth endpoints
    if (path === '/register') {
      return handleRegister(request);
    }
    if (path === '/authorize') {
      return handleAuthorize(request, env);
    }
    if (path === '/token') {
      return handleToken(request, env);
    }

    // MCP endpoint — requires a valid access token (OAuth-issued) or the raw
    // MCP_BEARER_TOKEN (handy for curl/smoke testing).
    if (path === '/mcp') {
      if (request.method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405 });
      }

      const auth = request.headers.get('Authorization') ?? '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (!token || !(await validateAccessToken(env, token))) {
        return unauthorized(request);
      }

      return handleMcpRequest(request, env, ctx);
    }

    return new Response('Not Found', { status: 404 });
  },
};
