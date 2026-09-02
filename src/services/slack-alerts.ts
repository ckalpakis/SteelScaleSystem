import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

export async function sendSlackMessage(
  text: string,
  context: { clientId?: string; bookingAttemptId?: string; attempted: string },
): Promise<boolean> {
  if (!env.SLACK_WEBHOOK_URL) {
    logger.error(
      { ...context },
      'Slack alert not sent because SLACK_WEBHOOK_URL is not configured',
    );
    return false;
  }

  let url: URL;
  try {
    url = new URL(env.SLACK_WEBHOOK_URL);
    if (url.protocol !== 'https:' && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
      throw new Error('Slack webhook must use HTTPS');
    }
  } catch (error: unknown) {
    logger.error({ err: error, ...context }, 'Slack webhook URL is invalid');
    return false;
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      const responseBody = (await response.text()).slice(0, 1_000);
      logger.error(
        { ...context, status: response.status, responseBody },
        'Slack webhook rejected alert',
      );
      return false;
    }
    logger.info({ ...context }, 'Slack message sent');
    return true;
  } catch (error: unknown) {
    logger.error({ err: error, ...context }, 'Slack webhook request failed');
    return false;
  }
}

export async function alertFailedBooking(input: {
  clientId: string;
  businessName: string;
  bookingAttemptId: string;
  callerName: string;
  callerPhone: string;
  service: string;
  preferredTime: string;
  error: string;
}): Promise<boolean> {
  return sendSlackMessage(
    [
      ':rotating_light: *Booking delivery failed after safety-net fallback*',
      `Client: ${input.businessName} (${input.clientId})`,
      `Lead: ${input.callerName} — ${input.callerPhone}`,
      `Request: ${input.service} at ${input.preferredTime}`,
      `Booking attempt: ${input.bookingAttemptId}`,
      `Error: ${input.error}`,
      'Action required: contact the lead and place the booking manually.',
    ].join('\n'),
    {
      clientId: input.clientId,
      bookingAttemptId: input.bookingAttemptId,
      attempted: 'failed_booking_alert',
    },
  );
}
