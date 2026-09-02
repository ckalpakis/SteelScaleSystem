import { env } from '../../config/env.js';
import { registerLeadDiscoveryProvider } from '../pipeline/scheduler.js';
import { ApifyRealEstateDiscoveryProvider } from './apify.js';
import { OutscraperDiscoveryProvider } from './outscraper.js';

export function registerConfiguredLeadDiscoveryProviders(): void {
  if (env.OUTSCRAPER_API_KEY) {
    registerLeadDiscoveryProvider('outscraper_google_maps', new OutscraperDiscoveryProvider());
  }
  if (env.APIFY_API_TOKEN) {
    registerLeadDiscoveryProvider('real_estate', new ApifyRealEstateDiscoveryProvider());
  }
}
