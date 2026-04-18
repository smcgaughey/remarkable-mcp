// OAuth 2.1 + PKCE + Dynamic Client Registration for Claude.ai Custom Connectors.
//
// Flow from Claude.ai's perspective:
//   1. GET /.well-known/oauth-protected-resource  (MCP server announces its auth server)
//   2. GET /.well-known/oauth-authorization-server (auth server metadata)
//   3. POST /register  (Dynamic Client Registration; we accept any registration)
//   4. User's browser redirected to GET /authorize?... (we serve a consent form
//      asking for the MCP_BEARER_TOKEN; it's the single user-facing gate)
//   5. POST /authorize with token  (we verify token, issue auth code, redirect back)
//   6. POST /token  (Claude exchanges code + PKCE verifier for access token)
//   7. POST /mcp with Authorization: Bearer <access_token>
//
// State lives in the existing TOKEN_CACHE KV namespace under prefixed keys:
//   oauth:code:<code>     → code metadata  (5 min TTL)
//   oauth:token:<token>   → access token metadata  (24h TTL)

import type { Env } from './index';

const CODE_TTL_SECONDS = 5 * 60;
const ACCESS_TOKEN_TTL_SECONDS = 24 * 60 * 60;

// ─── crypto / encoding helpers ──────────────────────────────────────────────

function b64urlEncode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomB64Url(numBytes: number): string {
  const buf = new Uint8Array(numBytes);
  crypto.getRandomValues(buf);
  return b64urlEncode(buf);
}

async function sha256B64Url(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return b64urlEncode(new Uint8Array(digest));
}

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function baseUrl(request: Request): string {
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

// ─── KV-backed state ────────────────────────────────────────────────────────

interface CodeEntry {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string;
}

interface TokenEntry {
  clientId: string;
  issuedAt: number;
}

async function putCode(env: Env, code: string, entry: CodeEntry): Promise<void> {
  await env.TOKEN_CACHE.put(`oauth:code:${code}`, JSON.stringify(entry), {
    expirationTtl: CODE_TTL_SECONDS,
  });
}

async function takeCode(env: Env, code: string): Promise<CodeEntry | null> {
  const raw = await env.TOKEN_CACHE.get(`oauth:code:${code}`);
  if (!raw) return null;
  await env.TOKEN_CACHE.delete(`oauth:code:${code}`);
  return JSON.parse(raw) as CodeEntry;
}

async function putAccessToken(env: Env, token: string, entry: TokenEntry): Promise<void> {
  await env.TOKEN_CACHE.put(`oauth:token:${token}`, JSON.stringify(entry), {
    expirationTtl: ACCESS_TOKEN_TTL_SECONDS,
  });
}

export async function validateAccessToken(env: Env, token: string): Promise<boolean> {
  // Backwards compat: the raw MCP_BEARER_TOKEN also counts as a valid token.
  // Handy for curl testing and for the admin to confirm server health.
  if (token === env.MCP_BEARER_TOKEN) return true;
  const raw = await env.TOKEN_CACHE.get(`oauth:token:${token}`);
  return raw !== null;
}

// ─── JSON helpers ───────────────────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

function oauthError(code: string, description: string, status = 400): Response {
  return jsonResponse({ error: code, error_description: description }, status);
}

// ─── Discovery metadata ─────────────────────────────────────────────────────

export function handleAuthServerMetadata(request: Request): Response {
  const base = baseUrl(request);
  return jsonResponse({
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    scopes_supported: ['mcp'],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
  });
}

export function handleProtectedResourceMetadata(request: Request): Response {
  const base = baseUrl(request);
  return jsonResponse({
    resource: base,
    authorization_servers: [base],
    bearer_methods_supported: ['header'],
  });
}

// ─── Dynamic Client Registration (RFC 7591) ─────────────────────────────────

export async function handleRegister(request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return oauthError('invalid_request', 'POST required', 405);
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    // DCR metadata body is optional-ish; tolerate empty.
  }

  // Open registration. Anyone can register a client; the real gate is the
  // consent form at /authorize which requires the MCP_BEARER_TOKEN.
  const clientId = `c_${randomB64Url(16)}`;

  const redirectUris = Array.isArray(body.redirect_uris)
    ? (body.redirect_uris as string[])
    : [];

  return jsonResponse(
    {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: redirectUris,
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      client_name: (body.client_name as string) || 'MCP client',
    },
    201,
  );
}

// ─── Authorization endpoint ─────────────────────────────────────────────────

function consentPage(params: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string;
  error?: string;
}): Response {
  const p = params;
  const body = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize Claude.ai · reMarkable MCP</title>
  <style>
    body { font-family: -apple-system, system-ui, sans-serif; max-width: 420px; margin: 3rem auto; padding: 1.5rem; color: #111; }
    h1 { font-size: 1.25rem; margin: 0 0 0.75rem; }
    p { color: #555; line-height: 1.5; margin: 0 0 1rem; }
    label { display: block; font-size: 0.85rem; font-weight: 600; margin-bottom: 0.35rem; color: #333; }
    input[type=password] {
      width: 100%; padding: 0.55rem 0.7rem; font: inherit;
      border: 1px solid #bbb; border-radius: 6px; box-sizing: border-box;
    }
    input[type=password]:focus { border-color: #444; outline: 2px solid rgba(0,0,0,0.1); }
    button {
      padding: 0.55rem 1.1rem; font: inherit; font-weight: 600; cursor: pointer;
      background: #111; color: #fff; border: none; border-radius: 6px;
      margin-top: 1rem;
    }
    button:hover { background: #000; }
    .error { color: #b00020; font-size: 0.9rem; margin-top: 0.5rem; }
    .scope { font-size: 0.85rem; color: #777; margin-top: 1.25rem; border-top: 1px solid #eee; padding-top: 0.75rem; }
  </style>
</head>
<body>
  <h1>Authorize Claude.ai</h1>
  <p>Claude.ai wants to upload PDFs to your reMarkable tablet. Paste your access token to confirm.</p>
  <form method="POST" action="/authorize">
    <label for="token">Access token</label>
    <input type="password" id="token" name="token" required autocomplete="off">
    <input type="hidden" name="response_type" value="code">
    <input type="hidden" name="client_id" value="${htmlEscape(p.clientId)}">
    <input type="hidden" name="redirect_uri" value="${htmlEscape(p.redirectUri)}">
    <input type="hidden" name="state" value="${htmlEscape(p.state)}">
    <input type="hidden" name="code_challenge" value="${htmlEscape(p.codeChallenge)}">
    <input type="hidden" name="code_challenge_method" value="${htmlEscape(p.codeChallengeMethod)}">
    <input type="hidden" name="scope" value="${htmlEscape(p.scope)}">
    <button type="submit">Authorize</button>
    ${p.error ? `<p class="error">${htmlEscape(p.error)}</p>` : ''}
  </form>
  <div class="scope">
    Granted scope: <code>upload_pdf</code>, <code>create_folder</code>. No read access.
  </div>
</body>
</html>`;

  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function redirectWithCode(redirectUri: string, code: string, state: string): Response {
  const u = new URL(redirectUri);
  u.searchParams.set('code', code);
  if (state) u.searchParams.set('state', state);
  return Response.redirect(u.toString(), 302);
}

export async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  // GET → show consent form; POST → process it.
  if (request.method === 'GET') {
    const responseType = url.searchParams.get('response_type') ?? '';
    const clientId = url.searchParams.get('client_id') ?? '';
    const redirectUri = url.searchParams.get('redirect_uri') ?? '';
    const state = url.searchParams.get('state') ?? '';
    const codeChallenge = url.searchParams.get('code_challenge') ?? '';
    const codeChallengeMethod = url.searchParams.get('code_challenge_method') ?? 'S256';
    const scope = url.searchParams.get('scope') ?? '';

    if (responseType !== 'code') {
      return oauthError('unsupported_response_type', 'only response_type=code is supported');
    }
    if (!clientId || !redirectUri) {
      return oauthError('invalid_request', 'client_id and redirect_uri are required');
    }
    if (!codeChallenge || codeChallengeMethod !== 'S256') {
      return oauthError('invalid_request', 'code_challenge with method S256 is required (PKCE)');
    }

    return consentPage({
      clientId,
      redirectUri,
      state,
      codeChallenge,
      codeChallengeMethod,
      scope,
    });
  }

  if (request.method === 'POST') {
    const form = await request.formData();
    const token = String(form.get('token') ?? '');
    const clientId = String(form.get('client_id') ?? '');
    const redirectUri = String(form.get('redirect_uri') ?? '');
    const state = String(form.get('state') ?? '');
    const codeChallenge = String(form.get('code_challenge') ?? '');
    const codeChallengeMethod = String(form.get('code_challenge_method') ?? 'S256');
    const scope = String(form.get('scope') ?? '');

    if (!token || token !== env.MCP_BEARER_TOKEN) {
      return consentPage({
        clientId,
        redirectUri,
        state,
        codeChallenge,
        codeChallengeMethod,
        scope,
        error: 'Invalid access token. Check 1Password (or re-run scripts/bootstrap.sh).',
      });
    }

    const code = randomB64Url(32);
    await putCode(env, code, {
      clientId,
      redirectUri,
      codeChallenge,
      codeChallengeMethod,
      scope,
    });

    return redirectWithCode(redirectUri, code, state);
  }

  return oauthError('invalid_request', 'GET or POST required', 405);
}

// ─── Token endpoint ─────────────────────────────────────────────────────────

export async function handleToken(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return oauthError('invalid_request', 'POST required', 405);
  }

  // Per RFC 6749 §4.1.3: params come in application/x-www-form-urlencoded.
  // Some clients send JSON; tolerate both.
  let params: URLSearchParams;
  const ct = request.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    const j = (await request.json()) as Record<string, string>;
    params = new URLSearchParams(j);
  } else {
    params = new URLSearchParams(await request.text());
  }

  const grantType = params.get('grant_type');
  const code = params.get('code');
  const codeVerifier = params.get('code_verifier');
  const redirectUri = params.get('redirect_uri');
  const clientId = params.get('client_id');

  if (grantType !== 'authorization_code') {
    return oauthError('unsupported_grant_type', 'only authorization_code is supported');
  }
  if (!code || !codeVerifier || !redirectUri) {
    return oauthError('invalid_request', 'code, code_verifier, and redirect_uri are required');
  }

  const entry = await takeCode(env, code);
  if (!entry) {
    return oauthError('invalid_grant', 'code unknown or expired');
  }
  if (entry.redirectUri !== redirectUri) {
    return oauthError('invalid_grant', 'redirect_uri mismatch');
  }
  if (clientId && entry.clientId !== clientId) {
    return oauthError('invalid_grant', 'client_id mismatch');
  }

  // PKCE S256 verification
  const computed = await sha256B64Url(codeVerifier);
  if (computed !== entry.codeChallenge) {
    return oauthError('invalid_grant', 'PKCE verification failed');
  }

  const accessToken = randomB64Url(32);
  await putAccessToken(env, accessToken, {
    clientId: entry.clientId,
    issuedAt: Date.now(),
  });

  return jsonResponse({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    scope: entry.scope,
  });
}
