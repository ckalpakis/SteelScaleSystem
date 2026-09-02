function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function run(): Promise<void> {
  process.env.OUTSCRAPER_API_KEY = 'outscraper-test';
  process.env.APIFY_API_TOKEN = 'apify-test';
  const [{ OutscraperDiscoveryProvider }, { ApifyRealEstateDiscoveryProvider }] = await Promise.all(
    [
      import('../src/lead-intelligence/providers/outscraper.js'),
      import('../src/lead-intelligence/providers/apify.js'),
    ],
  );

  const requestUrl = (input: RequestInfo | URL) =>
    typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  const outscraperFetch: typeof fetch = (input) => {
    assert(requestUrl(input).includes('/maps/search'), 'Outscraper search endpoint used');
    return Promise.resolve(
      new Response(
        JSON.stringify({
          data: [
            { name: 'Qualified Plumber', reviews: 45 },
            { name: 'Too New Plumber', reviews: 3 },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
  };
  const outscraper = await new OutscraperDiscoveryProvider(
    'outscraper-test',
    outscraperFetch,
  ).discover({
    kind: 'outscraper_google_maps',
    keywords: ['plumber'],
    locations: ['Pittsburgh PA'],
    maximumResults: 10,
    minimumReviews: 10,
  });
  assert(outscraper.records.length === 1, 'Outscraper minimum reviews applied');

  let apifyCall = 0;
  const apifyFetch: typeof fetch = (input) => {
    apifyCall += 1;
    const url = requestUrl(input);
    if (url.includes('/acts/')) {
      const detail = apifyCall > 2;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              id: detail ? 'detail-run' : 'search-run',
              defaultDatasetId: detail ? 'detail-data' : 'search-data',
              status: 'SUCCEEDED',
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    }
    const detail = url.includes('detail-data');
    return Promise.resolve(
      new Response(
        JSON.stringify(
          detail
            ? [
                {
                  zpid: '123',
                  propertyUrl: 'https://www.zillow.com/homedetails/123',
                  listingAddress: { full: '123 Oak St' },
                },
              ]
            : [{ propertyUrl: 'https://www.zillow.com/homedetails/123' }],
        ),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
  };
  const apify = await new ApifyRealEstateDiscoveryProvider('apify-test', apifyFetch).discover({
    kind: 'real_estate',
    provider: 'zillow',
    locations: ['https://www.zillow.com/pittsburgh-pa/'],
    maximumResults: 10,
  });
  assert(apify.records.length === 1, 'Apify detail dataset returned');
  assert(apify.sourceReference?.includes('detail-run'), 'Apify run IDs retained');
  process.stdout.write('Lead discovery provider tests passed.\n');
}

void run();
