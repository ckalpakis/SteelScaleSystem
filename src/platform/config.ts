export function boundedInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(result) || result < min || result > max)
    throw new Error('Invalid bounded deployment setting');
  return result;
}

function connectionUrl(value: string) {
  try {
    return new URL(value);
  } catch {
    throw new Error('Invalid connection URL');
  }
}

export function queueConnection(value = process.env.REDIS_URL) {
  if (!value) throw new Error('REDIS_URL is required for the worker');
  const url = connectionUrl(value);
  if (!['redis:', 'rediss:'].includes(url.protocol)) throw new Error('Invalid Redis protocol');
  const database = url.pathname.slice(1);
  return {
    host: url.hostname,
    port: boundedInteger(url.port || undefined, 6379, 1, 65535),
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    db: boundedInteger(database || undefined, 0, 0, 15),
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
    maxRetriesPerRequest: null,
    connectTimeout: 5000,
    enableOfflineQueue: false,
  };
}

export function queuePrefix() {
  const prefix = process.env.QUEUE_PREFIX ?? 'steel-scale';
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(prefix)) throw new Error('Invalid QUEUE_PREFIX');
  return prefix;
}

export function databaseUrl(value: string | undefined) {
  if (!value) return undefined;
  const url = connectionUrl(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol))
    throw new Error('Invalid database protocol');
  if (!url.searchParams.has('connection_limit'))
    url.searchParams.set(
      'connection_limit',
      String(boundedInteger(process.env.DB_CONNECTION_LIMIT, 5, 1, 50)),
    );
  if (!url.searchParams.has('pool_timeout')) url.searchParams.set('pool_timeout', '10');
  if (!url.searchParams.has('connect_timeout')) url.searchParams.set('connect_timeout', '5');
  return url.toString();
}
