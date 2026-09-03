import { db } from '../db/client.js';
import { env } from '../config/env.js';
import type { CalendarAvailabilityResult } from '../types/availability.js';
import { getGhlCalendarAvailability } from './ghl.js';
import { checkAvailabilityThroughZapier } from './zapier-availability.js';

export async function checkClientAvailability(
  clientId: string,
  preferredTime: string,
): Promise<CalendarAvailabilityResult> {
  const client = await db.client.findUnique({
    where: { id: clientId },
    include: { destination: true },
  });
  if (!client) throw new Error('Client not found');

  if (client.destination?.destinationType === 'zapier') {
    if (!client.destination.zapierAvailabilityWebhookUrl) {
      throw new Error('No Zapier availability webhook is configured');
    }
    return checkAvailabilityThroughZapier({
      clientId: client.id,
      businessName: client.businessName,
      webhookUrl: client.destination.zapierAvailabilityWebhookUrl,
      preferredTime,
      timezone: client.timezone,
    });
  }

  const calendarId = client.destination?.ghlCalendarId ?? env.GHL_FALLBACK_CALENDAR_ID;
  if (!calendarId) throw new Error('No calendar is configured for availability checks');
  const result = await getGhlCalendarAvailability({
    calendarId,
    clientId: client.id,
    preferredTime,
    timezone: client.timezone,
  });
  return { ...result, source: 'ghl' };
}
