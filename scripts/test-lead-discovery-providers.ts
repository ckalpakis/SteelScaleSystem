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
    const url = new URL(requestUrl(input));
    assert(url.pathname === '/maps/search', 'Outscraper search endpoint used');
    assert(
      url.searchParams.getAll('query')[0] === 'plumber, Pittsburgh PA',
      'Outscraper query uses repeated query parameters',
    );
    assert(
      url.searchParams.getAll('query').length === 2,
      'Outscraper sends every query separately',
    );
    assert(url.searchParams.get('limit') === '5', 'Outscraper limit is distributed per query');
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
    keywords: ['plumber', 'hvac'],
    locations: ['Pittsburgh PA'],
    maximumResults: 10,
    minimumReviews: 10,
  });
  assert(outscraper.records.length === 1, 'Outscraper minimum reviews applied');

  let outscraperPoll = 0;
  const asynchronousOutscraperFetch: typeof fetch = (input) => {
    const polling = requestUrl(input).includes('/requests/');
    if (polling) outscraperPoll += 1;
    return Promise.resolve(
      new Response(
        JSON.stringify(
          polling && outscraperPoll >= 2
            ? { id: 'async-request', status: 'Success', data: [[{ name: 'Async Plumber' }]] }
            : { id: 'async-request', status: 'Pending' },
        ),
        { status: polling ? 200 : 202, headers: { 'content-type': 'application/json' } },
      ),
    );
  };
  const asynchronousOutscraper = await new OutscraperDiscoveryProvider(
    'outscraper-test',
    asynchronousOutscraperFetch,
    { intervalMs: 0, maximumAttempts: 3 },
    () => Promise.resolve(),
  ).discover({
    kind: 'outscraper_google_maps',
    keywords: ['plumber'],
    locations: ['Pittsburgh PA'],
    maximumResults: 10,
  });
  assert(outscraperPoll === 2, 'Outscraper pending request should be polled until success');
  assert(asynchronousOutscraper.records.length === 1, 'Outscraper async results returned');

  const emptySuccessfulOutscraper = await new OutscraperDiscoveryProvider(
    'outscraper-test',
    () =>
      Promise.resolve(
        new Response(JSON.stringify({ id: 'empty-request', status: 'Success', data: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    { intervalMs: 0, maximumAttempts: 1 },
    () => Promise.resolve(),
  ).discover({
    kind: 'outscraper_google_maps',
    keywords: ['impossible niche'],
    locations: ['Pittsburgh PA'],
    maximumResults: 10,
  });
  assert(
    emptySuccessfulOutscraper.records.length === 0,
    'Outscraper successful empty result should not be treated as a timeout',
  );

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
