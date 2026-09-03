import { env } from '../../config/env.js';
import type { DiscoveryProvider, OutscraperSearchConfig } from '../pipeline/types.js';
import { objectValue, providerJson, recordsFrom } from './http.js';

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class OutscraperDiscoveryProvider implements DiscoveryProvider {
  constructor(
    private readonly apiKey = env.OUTSCRAPER_API_KEY,
    private readonly fetcher: typeof fetch = fetch,
    private readonly polling = { intervalMs: 5_000, maximumAttempts: 120 },
    private readonly sleeper: (milliseconds: number) => Promise<void> = wait,
  ) {}

  async discover(rawConfig: OutscraperSearchConfig) {
    if (!this.apiKey) throw new Error('OUTSCRAPER_API_KEY is not configured');
    if (rawConfig.kind !== 'outscraper_google_maps') throw new Error('Invalid Outscraper config');
    const queries = rawConfig.keywords.flatMap((keyword) =>
      rawConfig.locations.map((location) => `${keyword}, ${location}`),
    );
    const url = new URL('/maps/search', env.OUTSCRAPER_API_BASE_URL);
    url.searchParams.set('query', JSON.stringify(queries));
    url.searchParams.set('limit', String(Math.min(500, rawConfig.maximumResults)));
    url.searchParams.set('dropDuplicates', 'true');
    url.searchParams.set('language', 'en');
    url.searchParams.set('region', 'US');
    url.searchParams.set('async', 'true');
    let body = await providerJson(
      url.toString(),
      { method: 'GET', headers: { 'X-API-KEY': this.apiKey } },
      this.fetcher,
    );
    const initial = objectValue(body);
    const requestId = typeof initial?.id === 'string' ? initial.id : undefined;
    let status = String(initial?.status ?? '').toLocaleLowerCase('en-US');
    for (
      let poll = 0;
      requestId &&
      !['success', 'completed', 'finished'].includes(status) &&
      poll < this.polling.maximumAttempts;
      poll += 1
    ) {
      await this.sleeper(this.polling.intervalMs);
      body = await providerJson(
        new URL(
          `/requests/${encodeURIComponent(requestId)}`,
          env.OUTSCRAPER_API_BASE_URL,
        ).toString(),
        { method: 'GET', headers: { 'X-API-KEY': this.apiKey } },
        this.fetcher,
      );
      const rawStatus = objectValue(body)?.status;
      status = (typeof rawStatus === 'string' ? rawStatus : '').toLocaleLowerCase('en-US');
      if (['error', 'failed', 'cancelled'].includes(status))
        throw new Error(`Outscraper job ${status}`);
    }
    let records = recordsFrom(body);
    if (requestId && !['success', 'completed', 'finished'].includes(status)) {
      throw new Error(
        `Outscraper request did not finish within ${Math.round((this.polling.intervalMs * this.polling.maximumAttempts) / 60_000)} minutes (${status || 'pending'})`,
      );
    }
    if (rawConfig.minimumReviews !== undefined) {
      records = records.filter((record) => {
        const reviews = Number(objectValue(record)?.reviews ?? objectValue(record)?.reviews_count);
        return Number.isFinite(reviews) && reviews >= rawConfig.minimumReviews!;
      });
    }
    return {
      records: records.slice(0, rawConfig.maximumResults),
      sourceReference: requestId ? `outscraper-request:${requestId}` : url.toString(),
    };
  }
}
