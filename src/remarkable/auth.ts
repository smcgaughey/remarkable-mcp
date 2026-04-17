import type { Env } from '../index';

const USER_TOKEN_ENDPOINT =
  'https://webapp-prod.cloud.remarkable.engineering/token/json/2/user/new';
const CACHE_KEY = 'user_token';
const CACHE_TTL_SECONDS = 23 * 60 * 60;

export async function getUserToken(env: Env): Promise<string> {
  const cached = await env.TOKEN_CACHE.get(CACHE_KEY);
  if (cached) return cached;

  const resp = await fetch(USER_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.REMARKABLE_DEVICE_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: '',
  });

  if (!resp.ok) {
    throw new Error(
      `Failed to mint user token: ${resp.status} ${await resp.text()}`,
    );
  }

  const token = (await resp.text()).trim();
  await env.TOKEN_CACHE.put(CACHE_KEY, token, { expirationTtl: CACHE_TTL_SECONDS });
  return token;
}
