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
    for (let poll = 0; requestId && recordsFrom(body).length === 0 && poll < 60; poll += 1) {
      await wait(2_000);
      body = await providerJson(
        new URL(
          `/requests/${encodeURIComponent(requestId)}`,
          env.OUTSCRAPER_API_BASE_URL,
        ).toString(),
        { method: 'GET', headers: { 'X-API-KEY': this.apiKey } },
        this.fetcher,
      );
      const rawStatus = objectValue(body)?.status;
      const status = (typeof rawStatus === 'string' ? rawStatus : '').toLocaleLowerCase('en-US');
      if (['error', 'failed', 'cancelled'].includes(status))
        throw new Error(`Outscraper job ${status}`);
    }
    let records = recordsFrom(body);
    if (requestId && records.length === 0) {
      const rawStatus = objectValue(body)?.status;
      const status = typeof rawStatus === 'string' ? rawStatus : 'pending';
      throw new Error(`Outscraper request returned no results before timeout (${status})`);
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
