export function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export async function providerJson(
  url: string,
  init: RequestInit,
  fetcher: typeof fetch,
): Promise<unknown> {
  const response = await fetcher(url, { ...init, signal: AbortSignal.timeout(120_000) });
  const body: unknown = await response.json();
  if (!response.ok) throw new Error(`Provider request failed (${response.status})`);
  return body;
}

export function recordsFrom(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    const values: unknown[] = value;
    return values.flatMap((item): unknown[] =>
      Array.isArray(item) ? (item as unknown[]) : [item],
    );
  }
  const object = objectValue(value);
  if (!object) return [];
  return recordsFrom(object.data ?? object.items ?? object.results ?? []);
}
