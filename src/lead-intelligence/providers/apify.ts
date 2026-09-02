import { env } from '../../config/env.js';
import type { DiscoveryProvider, RealEstateSearchConfig } from '../pipeline/types.js';
import { objectValue, providerJson, recordsFrom } from './http.js';

function actorReference(actorId: string): string {
  return actorId.replace('/', '~');
}

export class ApifyRealEstateDiscoveryProvider implements DiscoveryProvider {
  constructor(
    private readonly token = env.APIFY_API_TOKEN,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private async runActor(actorId: string, input: unknown) {
    if (!this.token) throw new Error('APIFY_API_TOKEN is not configured');
    const url = new URL(
      `/acts/${encodeURIComponent(actorReference(actorId))}/runs`,
      env.APIFY_API_BASE_URL,
    );
    url.searchParams.set('waitForFinish', '120');
    let body = await providerJson(
      url.toString(),
      {
        method: 'POST',
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(input),
      },
      this.fetcher,
    );
    let run = objectValue(objectValue(body)?.data);
    const runId = typeof run?.id === 'string' ? run.id : undefined;
    for (
      let poll = 0;
      runId &&
      !['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'].includes(
        typeof run?.status === 'string' ? run.status : '',
      );
      poll += 1
    ) {
      if (poll >= 4) throw new Error('Apify actor did not finish before timeout');
      const pollUrl = new URL(`/actor-runs/${encodeURIComponent(runId)}`, env.APIFY_API_BASE_URL);
      pollUrl.searchParams.set('waitForFinish', '60');
      body = await providerJson(
        pollUrl.toString(),
        { method: 'GET', headers: { authorization: `Bearer ${this.token}` } },
        this.fetcher,
      );
      run = objectValue(objectValue(body)?.data);
    }
    if (run?.status !== 'SUCCEEDED' && typeof run?.status === 'string') {
      throw new Error(`Apify actor finished with status ${run.status}`);
    }
    const datasetId = typeof run?.defaultDatasetId === 'string' ? run.defaultDatasetId : undefined;
    if (!datasetId) throw new Error('Apify actor did not finish with a dataset');
    const datasetUrl = new URL(
      `/datasets/${encodeURIComponent(datasetId)}/items`,
      env.APIFY_API_BASE_URL,
    );
    datasetUrl.searchParams.set('clean', 'true');
    datasetUrl.searchParams.set('format', 'json');
    const items = await providerJson(
      datasetUrl.toString(),
      { method: 'GET', headers: { authorization: `Bearer ${this.token}` } },
      this.fetcher,
    );
    return { records: recordsFrom(items), runId };
  }

  async discover(config: RealEstateSearchConfig) {
    if (config.kind !== 'real_estate') throw new Error('Invalid Apify config');
    const search = await this.runActor(env.APIFY_ZILLOW_SEARCH_ACTOR_ID, {
      searchUrls: config.locations.map((url) => ({ url })),
      extractionMethod: 'PAGINATION',
      resultsLimit: config.maximumResults,
    });
    const propertyUrls = search.records.flatMap((record) => {
      const url = objectValue(record)?.propertyUrl;
      return typeof url === 'string' ? [{ url }] : [];
    });
    if (!propertyUrls.length) return { records: [], sourceReference: `apify-run:${search.runId}` };
    const detail = await this.runActor(env.APIFY_ZILLOW_DETAIL_ACTOR_ID, {
      propertyStatus: 'FOR_SALE',
      startUrls: propertyUrls.slice(0, config.maximumResults),
    });
    const cutoff = config.listedWithinHours
      ? Date.now() - config.listedWithinHours * 3_600_000
      : undefined;
    const records = detail.records.filter((record) => {
      if (cutoff === undefined) return true;
      const item = objectValue(record);
      const rawDate = item?.onMarketDate ?? item?.datePosted ?? item?.datePostedString;
      if (typeof rawDate !== 'string' && typeof rawDate !== 'number') return true;
      const timestamp = new Date(rawDate).getTime();
      return Number.isNaN(timestamp) || timestamp >= cutoff;
    });
    return {
      records: records.slice(0, config.maximumResults),
      sourceReference: `apify-runs:${search.runId},${detail.runId}`,
    };
  }
}
