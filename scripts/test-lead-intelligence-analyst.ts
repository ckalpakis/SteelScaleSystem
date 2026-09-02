import type { DashboardProspect } from '../src/lead-intelligence/admin-dashboard.js';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function fixture(
  leadId: string,
  score: number,
  confidence: number,
  name: string,
): DashboardProspect {
  return {
    leadId,
    clientId: 'client-test',
    clientName: 'Test Client',
    entityId: `business-${leadId}`,
    entityType: 'business',
    name,
    location: 'Pittsburgh, PA',
    city: 'Pittsburgh',
    state: 'PA',
    niche: 'Water restoration',
    primaryOffer: 'VOICE_AI',
    score,
    scoreBand: score >= 90 ? 'HOT' : 'HIGH',
    confidence,
    reasons: ['Emergency service offered', 'No online booking detected'],
    keyTrigger: 'Emergency service offered',
    reviewsOrListings: 120,
    reviewCount: 120,
    rating: 4.7,
    activeListings: null,
    phone: '+14125550100',
    website: 'https://example.test',
    listingUrl: null,
    listingAddress: null,
    listingPrice: null,
    listingImages: [],
    listingDate: null,
    lastSeenAt: new Date('2026-09-02T12:00:00.000Z'),
    lastEnrichedAt: new Date('2026-09-02T11:00:00.000Z'),
    outreachStatus: 'not_contacted',
    lastContactedAt: null,
    sources: ['outscraper_google_maps'],
    needsEnrichment: false,
    failedEnrichment: false,
    signals: new Map(),
    scoreComponents: [
      { rule: 'EMERGENCY_SERVICE', label: 'Emergency service', points: 15, observedValue: true },
    ],
  };
}

async function run(): Promise<void> {
  process.env.OPENAI_API_KEY = 'test-key';
  const { analyzeLeadList, prepareLeadAnalystInputs } =
    await import('../src/lead-intelligence/analyst/service.js');
  const rows = [
    fixture('lead-lower', 82, 0.99, 'Lower Lead'),
    fixture('lead-top', 94, 0.9, 'Top Lead'),
  ];
  const prepared = prepareLeadAnalystInputs(rows);
  assert(prepared[0]?.leadId === 'lead-top', 'deterministic score controls ranking order');

  const fetcher: typeof fetch = (_input, init) => {
    assert(typeof init?.body === 'string', 'analyst request has JSON body');
    const request = JSON.parse(init.body) as { input?: string };
    assert(request.input?.includes('Emergency service offered'), 'evidence sent to analyst');
    const report = {
      rankings: [
        {
          leadId: 'lead-lower',
          fitSummary: 'Good fit.',
          salesAngle: 'Overflow calls',
          notes: ['Strong review activity', 'Emergency service'],
          risks: [],
        },
        {
          leadId: 'lead-top',
          fitSummary: 'Best fit.',
          salesAngle: 'After-hours lead capture',
          notes: ['High deterministic score', 'No online booking'],
          risks: ['Confirm current booking process'],
        },
      ],
    };
    return Promise.resolve(
      new Response(
        JSON.stringify({
          output: [{ content: [{ type: 'output_text', text: JSON.stringify(report) }] }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
  };
  const result = await analyzeLeadList(rows, {
    fetcher,
    now: new Date('2026-09-02T13:00:00.000Z'),
  });
  assert(result.rankings[0]?.leadId === 'lead-top', 'AI cannot reorder deterministic ranking');
  assert(result.rankings[0]?.notes.length === 2, 'analyst notes parsed');
  process.stdout.write('Lead Intelligence AI analyst tests passed.\n');
}

void run();
