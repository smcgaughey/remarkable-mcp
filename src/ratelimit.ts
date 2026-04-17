import type { Env } from './index';

function dayKey(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `bytes:${y}-${m}-${day}`;
}

export async function checkAndConsume(env: Env, bytes: number): Promise<void> {
  const capMb = parseInt(env.DAILY_UPLOAD_CAP_MB || '200', 10);
  const capBytes = capMb * 1024 * 1024;

  const key = dayKey();
  const currentStr = await env.RATE_LIMIT.get(key);
  const current = currentStr ? parseInt(currentStr, 10) : 0;
  const next = current + bytes;

  if (next > capBytes) {
    throw new Error(
      `Daily upload cap exceeded: ${current + bytes} > ${capBytes} bytes (${capMb} MB/day).`,
    );
  }

  await env.RATE_LIMIT.put(key, String(next), { expirationTtl: 48 * 60 * 60 });
}
