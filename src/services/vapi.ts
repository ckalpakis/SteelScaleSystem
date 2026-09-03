import { BookingSource, CallOutcome, CallType, Prisma, VoiceProvider } from '@prisma/client';

import { db } from '../db/client.js';
import { env } from '../config/env.js';
import type { InternalBookingRequest } from '../types/booking.js';
import { logger } from '../utils/logger.js';
import { createBookingAttempt } from './bookings.js';
import { getGhlCalendarAvailability } from './ghl.js';
import { checkAvailabilityThroughZapier } from './zapier-availability.js';
import { sendOwnerNotification } from './owner-notifications.js';
import { sendNoBookingSmsFollowUp } from './sms-booking.js';
import type { CalendarAvailabilityResult } from '../types/availability.js';
import { spokenAvailabilitySlots } from './availability-format.js';

type JsonObject = Record<string, unknown>;

interface VapiContext {
  callId: string;
  callerNumber: string;
  client: NonNullable<Awaited<ReturnType<typeof findClientForMessage>>>;
}

function objectValue(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function nestedString(value: unknown, key: string): string | undefined {
  return stringValue(objectValue(value)?.[key]);
}

async function findClientForMessage(message: JsonObject) {
  const call = objectValue(message.call);
  const phoneNumber = objectValue(message.phoneNumber);
  const assistantId = stringValue(call?.assistantId) ?? stringValue(message.assistantId);
  const phoneNumberId =
    stringValue(call?.phoneNumberId) ??
    stringValue(phoneNumber?.id) ??
    stringValue(message.phoneNumberId);

  const voiceConfig = await db.voiceAgentConfig.findFirst({
    where: {
      provider: VoiceProvider.vapi,
      OR: [
        ...(assistantId ? [{ agentId: assistantId }] : []),
        ...(phoneNumberId ? [{ phoneNumberId }] : []),
      ],
    },
    include: { client: { include: { destination: true } } },
  });

  if (voiceConfig) return { ...voiceConfig.client, voiceConfig };

  const calledNumber =
    nestedString(message.phoneNumber, 'number') ??
    nestedString(call?.phoneNumber, 'number') ??
    stringValue(call?.toNumber);

  if (!calledNumber) return null;

  const client = await db.client.findUnique({
    where: { phoneNumber: calledNumber },
    include: { voiceAgentConfig: true, destination: true },
  });

  if (!client?.voiceAgentConfig || client.voiceAgentConfig.provider !== VoiceProvider.vapi)
    return null;
  return { ...client, voiceConfig: client.voiceAgentConfig };
}

function renderSystemPrompt(
  template: string,
  businessName: string,
  services: string[],
  timezone: string,
  ownerTransferEnabled: boolean,
): string {
  const rendered = template
    .replaceAll('{business_name}', businessName)
    .replaceAll('{services}', services.join(', '));

  const transferInstructions = ownerTransferEnabled
    ? ' If the caller asks to speak with the owner, a manager, or a human, ask whether they want to be transferred now. Only after the caller explicitly confirms, acknowledge the transfer and invoke the transferCall tool in the same response. Do not invent or say the private destination number.'
    : '';

  return `${rendered}\n\nRuntime scheduling context: The current time is ${new Date().toISOString()} UTC. The business timezone is ${timezone}. Resolve words such as "today" and "tomorrow" using that timezone. Never submit a past appointment time. Before promising or creating an appointment, call check_availability for the caller's preferred time. If unavailable, offer the returned spokenAvailableSlots in one natural sentence and wait for the caller to choose one. Never read ISO timestamps, UTC offsets, hyphens, bullets, or list punctuation aloud, and never say "minus" before an appointment time. Use the corresponding availableSlots ISO value when calling create_booking. Only call create_booking with a time confirmed available by the tool.${transferInstructions}`;
}

function availabilityToolResult(availability: CalendarAvailabilityResult): JsonObject {
  return {
    ...availability,
    spokenAvailableSlots: spokenAvailabilitySlots(
      availability.availableSlots,
      availability.timezone,
    ),
  };
}

function ownerTransferTool(number: string, mode: string): JsonObject {
  return {
    type: 'transferCall',
    destinations: [
      {
        type: 'number',
        number,
        description:
          'The business owner. Use only when the caller explicitly confirms they want to speak with the owner, a manager, or a human now.',
        message: 'Okay, I’ll connect you with the owner now.',
        transferPlan: {
          mode: mode === 'warm-transfer-say-summary' ? mode : 'blind-transfer',
        },
      },
    ],
  };
}

export async function buildAssistantResponse(message: JsonObject): Promise<JsonObject> {
  const client = await findClientForMessage(message);
  if (!client) return { error: 'No voice agent is configured for this phone number.' };

  return {
    assistant: {
      firstMessage: `Thanks for calling ${client.businessName}. How can I help you today?`,
      model: {
        provider: 'openai',
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: renderSystemPrompt(
              client.voiceConfig.systemPrompt,
              client.businessName,
              client.services,
              client.timezone,
              Boolean(client.voiceConfig.ownerTransferNumber),
            ),
          },
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'check_availability',
              description:
                'Check the live calendar before promising an appointment. If unavailable, speak the returned spokenAvailableSlots naturally without reading ISO values, offsets, bullets, hyphens, or the word minus.',
              parameters: {
                type: 'object',
                properties: {
                  preferredTime: {
                    type: 'string',
                    description: 'Future ISO 8601 timestamp including the business timezone offset',
                  },
                },
                required: ['preferredTime'],
              },
            },
          },
          {
            type: 'function',
            function: {
              name: 'create_booking',
              description: 'Create a booking only after the caller confirms all collected details.',
              parameters: {
                type: 'object',
                properties: {
                  customerName: { type: 'string' },
                  phoneNumber: { type: 'string' },
                  address: { type: 'string' },
                  service: { type: 'string' },
                  preferredTime: {
                    type: 'string',
                    description: 'Future ISO 8601 timestamp including the business timezone offset',
                  },
                },
                required: ['customerName', 'phoneNumber', 'address', 'service', 'preferredTime'],
              },
            },
          },
          ...(client.voiceConfig.ownerTransferNumber
            ? [
                ownerTransferTool(
                  client.voiceConfig.ownerTransferNumber,
                  client.voiceConfig.ownerTransferMode,
                ),
              ]
            : []),
        ],
      },
      serverMessages: ['status-update', 'end-of-call-report', 'tool-calls'],
    },
  };
}

function availabilityCalendar(context: VapiContext): string | undefined {
  return context.client.destination?.ghlCalendarId ?? env.GHL_FALLBACK_CALENDAR_ID;
}

async function availabilityFor(
  context: VapiContext,
  preferredTime: string,
): Promise<CalendarAvailabilityResult> {
  if (context.client.destination?.destinationType === 'zapier') {
    const webhookUrl = context.client.destination.zapierAvailabilityWebhookUrl;
    if (!webhookUrl) throw new Error('No Zapier availability webhook is configured');
    return checkAvailabilityThroughZapier({
      clientId: context.client.id,
      businessName: context.client.businessName,
      webhookUrl,
      preferredTime,
      timezone: context.client.timezone,
    });
  }
  const calendarId = availabilityCalendar(context);
  if (!calendarId) throw new Error('No GHL calendar is configured for availability checks');
  const availability = await getGhlCalendarAvailability({
    calendarId,
    clientId: context.client.id,
    preferredTime,
    timezone: context.client.timezone,
  });
  return { ...availability, source: 'ghl' };
}

async function contextForMessage(message: JsonObject): Promise<VapiContext | undefined> {
  const call = objectValue(message.call);
  const client = await findClientForMessage(message);
  const callId = stringValue(call?.id);
  const callerNumber = nestedString(call?.customer, 'number') ?? stringValue(call?.fromNumber);
  if (!client || !callId || !callerNumber) return undefined;
  return { callId, callerNumber, client };
}

export async function logCallStarted(message: JsonObject): Promise<void> {
  const context = await contextForMessage(message);
  if (!context) throw new Error('Unable to resolve Vapi call-start context');

  await db.callLog.upsert({
    where: { providerCallId: context.callId },
    update: { rawPayload: message as Prisma.InputJsonValue },
    create: {
      clientId: context.client.id,
      providerCallId: context.callId,
      callerNumber: context.callerNumber,
      callType: CallType.answered_by_ai,
      durationSeconds: 0,
      outcome: CallOutcome.no_answer,
      rawPayload: message as Prisma.InputJsonValue,
    },
  });
}

function durationSeconds(message: JsonObject): number {
  const call = objectValue(message.call);
  const started = Date.parse(stringValue(call?.startedAt) ?? '');
  const ended = Date.parse(stringValue(call?.endedAt) ?? '');
  return Number.isFinite(started) && Number.isFinite(ended)
    ? Math.max(0, Math.round((ended - started) / 1000))
    : 0;
}

export async function logCallEnded(message: JsonObject): Promise<void> {
  const context = await contextForMessage(message);
  if (!context) throw new Error('Unable to resolve Vapi call-end context');
  const call = objectValue(message.call);
  const booking = await db.bookingAttempt.findFirst({
    where: { providerCallId: context.callId, status: 'success' },
  });

  await db.callLog.upsert({
    where: { providerCallId: context.callId },
    update: {
      durationSeconds: durationSeconds(message),
      outcome: booking ? CallOutcome.booked : CallOutcome.not_interested,
      rawPayload: message as Prisma.InputJsonValue,
    },
    create: {
      clientId: context.client.id,
      providerCallId: context.callId,
      callerNumber: context.callerNumber,
      callType: CallType.answered_by_ai,
      durationSeconds: durationSeconds(message),
      outcome: booking ? CallOutcome.booked : CallOutcome.not_interested,
      rawPayload: message as Prisma.InputJsonValue,
    },
  });

  const endedReason = stringValue(message.endedReason) ?? stringValue(call?.endedReason);
  const transferAttempted = endedReason?.toLocaleLowerCase('en-US').includes('transfer') === true;
  const transferFailed =
    transferAttempted &&
    (endedReason.toLocaleLowerCase('en-US').includes('fail') ||
      endedReason.toLocaleLowerCase('en-US').includes('error'));
  if (
    transferFailed &&
    context.client.ownerNotificationNumber &&
    context.client.notifyTransferFailureSms
  ) {
    await sendOwnerNotification({
      clientId: context.client.id,
      from: context.client.phoneNumber,
      to: context.client.ownerNotificationNumber,
      type: 'transfer_failure',
      eventKey: context.callId,
      body: `MISSED TRANSFER — ${context.client.businessName}\nCaller: ${context.callerNumber}\nThe owner transfer failed. Please call them back.`,
    });
  }
  if (
    !booking &&
    !transferFailed &&
    context.client.ownerNotificationNumber &&
    context.client.notifyUnbookedCallSms
  ) {
    await sendOwnerNotification({
      clientId: context.client.id,
      from: context.client.phoneNumber,
      to: context.client.ownerNotificationNumber,
      type: 'unbooked_call',
      eventKey: context.callId,
      body: `NEW CALL — ${context.client.businessName}\nCaller: ${context.callerNumber}\nThe AI handled the call, but no appointment was booked.`,
    });
  }
  if (!booking && !transferAttempted) {
    try {
      await sendNoBookingSmsFollowUp({
        clientId: context.client.id,
        callId: context.callId,
        customerNumber: context.callerNumber,
      });
    } catch (error) {
      logger.error(
        { error, clientId: context.client.id, callId: context.callId },
        'Post-call SMS booking follow-up failed',
      );
    }
  }
}

function parseToolArguments(value: unknown): JsonObject | undefined {
  if (typeof value === 'string') {
    try {
      return objectValue(JSON.parse(value) as unknown);
    } catch {
      return undefined;
    }
  }
  return objectValue(value);
}

function bookingFromTool(
  parameters: JsonObject,
  context: VapiContext,
  toolCallId: string,
): InternalBookingRequest | undefined {
  const customerName = stringValue(parameters.customerName);
  const phoneNumber = stringValue(parameters.phoneNumber);
  const address = stringValue(parameters.address);
  const service = stringValue(parameters.service);
  const preferredTime = stringValue(parameters.preferredTime);
  if (!customerName || !phoneNumber || !address || !service || !preferredTime) return undefined;

  return {
    clientId: context.client.id,
    source: BookingSource.voice,
    customerName,
    phoneNumber,
    address,
    service,
    preferredTime,
    providerCallId: context.callId,
    providerRequestId: toolCallId,
  };
}

export async function handleToolCalls(message: JsonObject): Promise<JsonObject> {
  const context = await contextForMessage(message);
  if (!context) throw new Error('Unable to resolve Vapi tool-call context');
  const toolCalls = Array.isArray(message.toolCallList) ? message.toolCallList : [];
  const results = [];

  for (const value of toolCalls) {
    const toolCall = objectValue(value);
    const functionCall = objectValue(toolCall?.function);
    const id = stringValue(toolCall?.id) ?? stringValue(toolCall?.toolCallId);
    const name = stringValue(toolCall?.name) ?? stringValue(functionCall?.name);
    if (!id || !name) continue;

    if (name !== 'create_booking' && name !== 'check_availability') {
      results.push({ name, toolCallId: id, result: JSON.stringify({ error: 'Unknown tool' }) });
      continue;
    }

    // Vapi's current Function Tool webhook uses `arguments`. Keep the older
    // `parameters` variants so calls created with legacy configurations still work.
    const parameters = parseToolArguments(
      toolCall?.arguments ??
        toolCall?.parameters ??
        functionCall?.arguments ??
        functionCall?.parameters,
    );
    const preferredTime = stringValue(parameters?.preferredTime);
    const preferredTimestamp = Date.parse(preferredTime ?? '');
    if (
      preferredTime &&
      (!Number.isFinite(preferredTimestamp) || preferredTimestamp <= Date.now())
    ) {
      results.push({
        name,
        toolCallId: id,
        result: JSON.stringify({
          accepted: false,
          error: 'The requested appointment time must be a valid future date and time.',
        }),
      });
      continue;
    }
    if (name === 'check_availability') {
      if (!preferredTime) {
        results.push({
          name,
          toolCallId: id,
          result: JSON.stringify({
            requestedAvailable: false,
            error: 'A preferred appointment time is required.',
          }),
        });
        continue;
      }
      try {
        const availability = await availabilityFor(context, preferredTime);
        results.push({
          name,
          toolCallId: id,
          result: JSON.stringify(availabilityToolResult(availability)),
        });
      } catch (error) {
        results.push({
          name,
          toolCallId: id,
          result: JSON.stringify({
            requestedAvailable: false,
            availableSlots: [],
            error: error instanceof Error ? error.message : String(error),
          }),
        });
      }
      continue;
    }
    const booking = parameters ? bookingFromTool(parameters, context, id) : undefined;

    if (!booking) {
      results.push({
        name,
        toolCallId: id,
        result: JSON.stringify({ accepted: false, error: 'Missing required booking details' }),
      });
      continue;
    }

    if (!env.BOOKING_DELIVERY_DRY_RUN && context.client.destination) {
      try {
        const availability = await availabilityFor(context, booking.preferredTime);
        if (!availability.requestedAvailable) {
          results.push({
            name,
            toolCallId: id,
            result: JSON.stringify({
              accepted: false,
              error: 'The requested time is not currently available.',
              availableSlots: availability.availableSlots,
              spokenAvailableSlots: spokenAvailabilitySlots(
                availability.availableSlots,
                availability.timezone,
              ),
            }),
          });
          continue;
        }
      } catch (error) {
        results.push({
          name,
          toolCallId: id,
          result: JSON.stringify({
            accepted: false,
            error: `Availability could not be confirmed: ${error instanceof Error ? error.message : String(error)}`,
          }),
        });
        continue;
      }
    }

    const bookingResult = await createBookingAttempt(booking);
    results.push({ name, toolCallId: id, result: JSON.stringify(bookingResult) });
  }

  logger.info({ callId: context.callId, toolCallCount: results.length }, 'Vapi tools processed');
  return { results };
}

export type VapiMessage = JsonObject;
