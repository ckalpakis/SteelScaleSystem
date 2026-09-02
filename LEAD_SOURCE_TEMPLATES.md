# Lead Source Templates

These templates produce evidence-rich source files for Steel Scale Lead Intelligence. They intentionally stop at discovery and ingestion: they do not contact prospects, initiate SMS, or deliver leads to GHL.

## Template directory

| File                                                                  | Use                                                                           |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `templates/lead-intelligence/outscraper-voice-ai-restoration-pa.json` | Outscraper Google Maps search plan for restoration businesses in Pennsylvania |
| `templates/lead-intelligence/apify-zillow-search.example.json`        | First Apify task: discover newly listed Zillow properties                     |
| `templates/lead-intelligence/apify-zillow-detail.example.json`        | Second Apify task: enrich property URLs with listing and agent details        |
| `templates/lead-intelligence/apify-real-estate-output-contract.json`  | Reference showing the ideal JSON fields accepted by Steel Scale               |

## Outscraper template: Voice AI

Use Outscraper's Google Maps Data Scraper or `/maps/search` endpoint. The API template contains combined niche-and-location queries because Outscraper recommends including the location in each query.

### Dashboard setup

1. Create a Google Maps Data Scraper task.
2. Copy the values in the template's `request.query` array into the query input, one query per line.
3. Use English and United States as the language and region.
4. Start with 100 results per query and a 500-result total ceiling.
5. Enable provider-side duplicate removal when the dashboard offers it.
6. Do not purchase contact enrichment for the first test. Website Intelligence performs the qualification audit after ingestion.
7. Run a 20-record trial before increasing the limits.
8. Export **JSON**. JSON preserves structured hours, booking links, services, owner data, and `about` evidence better than CSV.
9. In Steel Scale, open `/admin/leads`, select **Import Outscraper file**, preview the mappings, and import.

### Reusing the template

Keep the request settings and replace the query matrix. High-priority Voice AI niches are:

- water restoration
- fire restoration
- mold remediation
- septic
- garage door
- tree service
- pest control
- towing
- HVAC
- plumbing
- electrician
- foundation repair
- waterproofing
- auto glass
- dentist
- med spa
- veterinarian
- property management

Use `niche, city, state, USA` for every query. Split dense cities into ZIP-code searches instead of raising the per-query limit indefinitely. Do not filter out businesses without websites; the absence of a website is itself useful evidence for later offers.

### Required and valuable output fields

`name` is the only mandatory business field. For safe deduplication, retain `place_id`, `google_id`, and `cid`. Retain the full set in the template whenever available so scoring can use reviews, rating, status, hours, booking links, verification, photos, and service-area status.

## Apify template: Real Estate Video

Use the Apify-maintained `maxcopell/zillow-scraper` for discovery and `maxcopell/zillow-detail-scraper` for details. The search dataset alone generally lacks enough agent contact information for the complete Real Estate Video workflow, so use a Search → Detail chain.

### Create the search task

1. Open Zillow in a normal browser.
2. Search the desired city or ZIP code.
3. Select **For sale** and sort by **Newest**.
4. Move the map slightly so the URL contains `searchQueryState`.
5. Copy the complete URL into `apify-zillow-search.example.json`.
6. In Apify, open `maxcopell/zillow-scraper`, switch to JSON input, and paste the completed template.
7. Start with `PAGINATION`, not zoom-in pagination, and 25-50 results per URL to control cost.

### Add listing details

Connect the Search actor to `maxcopell/zillow-detail-scraper` using Apify's Actor-to-Actor integration, or copy the discovered `propertyUrl` values into `apify-zillow-detail.example.json`. The Detail run should retain:

- ZPID or another external listing ID
- property URL
- structured address and coordinates
- price, bedrooms, bathrooms, and living area
- listing status
- `onMarketDate` or `datePosted`
- listing photos
- agent name, phone, email, profile, headshot, website, and social URLs when publicly available
- brokerage

Download the **Detail actor's dataset as JSON**. Compare one row with `apify-real-estate-output-contract.json` before a large run. Actor output can change, so validate a small dataset whenever the actor version changes.

## Safe operating schedule

| Source                 |               Trial | Initial production cadence       |           Initial cap |
| ---------------------- | ------------------: | -------------------------------- | --------------------: |
| Outscraper Google Maps |          20 records | Weekly per niche/market          |      500 per campaign |
| Apify Zillow Search    |         10 listings | Every 6 hours                    |     50 per search URL |
| Apify Zillow Detail    | Search results only | After each successful Search run | Same as Search output |

New real-estate listings lose value quickly, so prioritize newest-first search filters. Google Maps business data changes more slowly and does not need the same cadence.

## Quality gate before enrichment

For Outscraper, confirm most rows have `name` plus at least one stable Google identifier, phone, website, or address. For Apify, reject any template/run that does not reliably return an external listing ID, address, property URL, listing date, and agent identity. Missing optional fields should remain missing; never manufacture source evidence.

## Provider references

- Outscraper `/maps/search`: https://docs.outscraper.com/endpoints/maps-search/
- Apify Zillow Search actor: https://apify.com/maxcopell/zillow-scraper
- Apify Zillow Detail actor: https://apify.com/maxcopell/zillow-detail-scraper
- Apify Actor and dataset platform documentation: https://docs.apify.com/platform

Review provider pricing, terms, target-site terms, and applicable privacy/contact rules before scheduling large runs. Publicly visible contact information is not consent to send SMS.
