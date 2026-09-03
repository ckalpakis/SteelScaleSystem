function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function run(): Promise<void> {
  process.env.GHL_API_KEY = 'test-key';
  process.env.GHL_LOCATION_ID = 'test-location';
  const { getGhlCalendarAvailability } = await import('../src/services/ghl.js');
  const fetcher: typeof fetch = (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const parsed = new URL(url);
    assert(parsed.pathname.endsWith('/calendars/test-calendar/free-slots'), 'free-slots endpoint');
    assert(parsed.searchParams.has('startDate'), 'start date supplied');
    assert(parsed.searchParams.has('endDate'), 'end date supplied');
    assert(parsed.searchParams.get('timezone') === 'America/New_York', 'timezone supplied');
    assert(init?.method === 'GET', 'availability uses GET');
    return Promise.resolve(
      new Response(
        JSON.stringify({
          '2027-01-15': {
            slots: [
              '2027-01-15T16:30:00-05:00',
              '2027-01-15T17:00:00-05:00',
              '2027-01-15T18:00:00-05:00',
            ],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
  };
  const available = await getGhlCalendarAvailability(
    {
      calendarId: 'test-calendar',
      clientId: 'test-client',
      preferredTime: '2027-01-15T16:30:00-05:00',
      timezone: 'America/New_York',
    },
    fetcher,
  );
  assert(available.requestedAvailable, 'exact free slot recognized');

  const unavailable = await getGhlCalendarAvailability(
    {
      calendarId: 'test-calendar',
      clientId: 'test-client',
      preferredTime: '2027-01-15T17:30:00-05:00',
      timezone: 'America/New_York',
    },
    fetcher,
  );
  assert(!unavailable.requestedAvailable, 'unavailable slot rejected');
  assert(unavailable.availableSlots.length === 3, 'nearby alternatives returned');
  const { spokenAvailabilitySlots } = await import('../src/services/availability-format.js');
  const spokenSlots = spokenAvailabilitySlots(unavailable.availableSlots, 'America/New_York');
  assert(spokenSlots[0] === 'Friday, January 15 at 4:30 PM', 'speech-safe slot formatted');
  assert(
    spokenSlots.every((slot) => !slot.includes('-')),
    'speech-safe slots omit ISO hyphens',
  );
  const { parseZapierAvailabilityCallback } = await import('../src/routes/zapier-availability.js');
  const zapier = parseZapierAvailabilityCallback({
    requested_available: 'false',
    available_slots: '2027-01-15T17:00:00-05:00\n2027-01-15T18:00:00-05:00\nnot-a-time',
  });
  assert(zapier?.requestedAvailable === false, 'Zapier string boolean normalized');
  assert(zapier.availableSlots.length === 2, 'Zapier line-item slots normalized');
  process.stdout.write('GHL availability tests passed.\n');
}

void run();
