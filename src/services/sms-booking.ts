import { BookingSource, Prisma, SmsConversationStatus, SmsDirection } from '@prisma/client';

import { db } from '../db/client.js';
import type { ChatTurn } from '../types/chatbot.js';
import { logger } from '../utils/logger.js';
import { createBookingAttempt } from './bookings.js';
import { spokenAvailabilitySlots } from './availability-format.js';
import { getChatbotReply } from './chatbot-llm.js';
import { checkClientAvailability } from './client-availability.js';
import { sendSms } from './twilio-sms.js';

const STOP_WORDS = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit']);
const START_WORDS = new Set(['start', 'unstop']);

interface InboundSmsInput {
  messageSid: string;
  from: string;
  to: string;
  body: string;
}

function renderTemplate(template: string, businessName: string): string {
  return template.replaceAll('{business_name}', businessName);
}

function normalizedCommand(body: string): string {
  return body
    .trim()
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z]/g, '');
}

function smsPrompt(
  businessName: string,
  services: string[],
  timezone: string,
  phone: string,
): string {
  return [
    `You are the SMS booking assistant for ${businessName}.`,
    `The business offers: ${services.join(', ')}.`,
    `The customer's callback number is ${phone}; use it without asking again unless they request a different number.`,
    `Collect their full name, service address, requested service, and preferred appointment time in ${timezone}.`,
    'Keep every reply concise and suitable for SMS. Ask one or two questions at a time.',
    'Read the details back and obtain explicit confirmation before calling create_booking.',
    'Convert the confirmed time to an ISO 8601 timestamp with the correct timezone offset.',
    'Never invent details or claim a booking succeeded before the tool confirms it.',
  ].join(' ');
}

async function recordAndSend(input: {
  conversationId: string;
  clientId: string;
  from: string;
  to: string;
  body: string;
  dedupeKey?: string;
  bookingAttemptId?: string;
}): Promise<void> {
  let message: { id: string };
  try {
    message = await db.smsMessage.create({
      data: {
        smsConversationId: input.conversationId,
        direction: SmsDirection.outbound,
        body: input.body,
        dedupeKey: input.dedupeKey,
        bookingAttemptId: input.bookingAttemptId,
      },
      select: { id: true },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return;
    throw error;
  }

  try {
    const sent = await sendSms({
      clientId: input.clientId,
      from: input.from,
      to: input.to,
      body: input.body,
    });
    await db.smsMessage.update({
      where: { id: message.id },
      data: { providerMessageId: sent.sid },
    });
  } catch (error) {
    await db.smsMessage.delete({ where: { id: message.id } }).catch(() => undefined);
    throw error;
  }
}

export async function sendNoBookingSmsFollowUp(input: {
  clientId: string;
  callId: string;
  customerNumber: string;
}): Promise<boolean> {
  if (!/^\+[1-9]\d{7,14}$/.test(input.customerNumber)) return false;
  const client = await db.client.findUnique({ where: { id: input.clientId } });
  if (!client?.smsBookingEnabled) return false;

  const conversation = await db.smsConversation.upsert({
    where: {
      clientId_customerNumber: {
        clientId: client.id,
        customerNumber: input.customerNumber,
      },
    },
    update: {},
    create: { clientId: client.id, customerNumber: input.customerNumber },
  });
  if (conversation.status === SmsConversationStatus.opted_out) return false;

  await recordAndSend({
    conversationId: conversation.id,
    clientId: client.id,
    from: client.phoneNumber,
    to: input.customerNumber,
    body: renderTemplate(client.noBookingSmsTemplate, client.businessName),
    dedupeKey: `no-booking:${input.callId}`,
  });
  return true;
}

export async function processInboundSms(input: InboundSmsInput): Promise<void> {
  const client = await db.client.findUnique({ where: { phoneNumber: input.to } });
  if (!client?.smsBookingEnabled) {
    logger.info({ to: input.to, messageSid: input.messageSid }, 'Inbound SMS booking disabled');
    return;
  }

  const conversation = await db.smsConversation.upsert({
    where: { clientId_customerNumber: { clientId: client.id, customerNumber: input.from } },
    update: {},
    create: { clientId: client.id, customerNumber: input.from },
  });
  try {
    await db.smsMessage.create({
      data: {
        smsConversationId: conversation.id,
        direction: SmsDirection.inbound,
        body: input.body,
        providerMessageId: input.messageSid,
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return;
    throw error;
  }

  const command = normalizedCommand(input.body);
  if (STOP_WORDS.has(command)) {
    await db.smsConversation.update({
      where: { id: conversation.id },
      data: { status: SmsConversationStatus.opted_out },
    });
    return;
  }
  if (conversation.status === SmsConversationStatus.opted_out && !START_WORDS.has(command)) return;
  if (START_WORDS.has(command)) {
    await db.smsConversation.update({
      where: { id: conversation.id },
      data: { status: SmsConversationStatus.active },
    });
  }

  const messages = await db.smsMessage.findMany({
    where: { smsConversationId: conversation.id },
    orderBy: { createdAt: 'asc' },
    take: 40,
  });
  const turns: ChatTurn[] = messages.map((message) => ({
    role: message.direction === SmsDirection.inbound ? 'user' : 'assistant',
    content: message.body,
  }));
  const reply = await getChatbotReply(
    client.id,
    smsPrompt(client.businessName, client.services, client.timezone, input.from),
    turns,
  );

  if (!reply.toolCall) {
    await recordAndSend({
      conversationId: conversation.id,
      clientId: client.id,
      from: client.phoneNumber,
      to: input.from,
      body: reply.text,
      dedupeKey: `reply:${input.messageSid}`,
    });
    return;
  }

  let availability;
  try {
    availability = await checkClientAvailability(client.id, reply.toolCall.input.preferredTime);
  } catch (error) {
    logger.error({ error, clientId: client.id }, 'SMS availability check failed');
    await recordAndSend({
      conversationId: conversation.id,
      clientId: client.id,
      from: client.phoneNumber,
      to: input.from,
      body: 'I could not confirm the calendar right now. The business will follow up with you shortly.',
      dedupeKey: `reply:${input.messageSid}`,
    });
    return;
  }

  if (!availability.requestedAvailable) {
    const alternatives = spokenAvailabilitySlots(
      availability.availableSlots,
      availability.timezone,
    );
    const body = alternatives.length
      ? `That time is unavailable. I can offer ${alternatives.join(', or ')}. Which works best?`
      : 'That time is unavailable. What other day or time would work for you?';
    await recordAndSend({
      conversationId: conversation.id,
      clientId: client.id,
      from: client.phoneNumber,
      to: input.from,
      body,
      dedupeKey: `reply:${input.messageSid}`,
    });
    return;
  }

  const booking = await createBookingAttempt({
    clientId: client.id,
    source: BookingSource.sms,
    ...reply.toolCall.input,
    phoneNumber: reply.toolCall.input.phoneNumber || input.from,
    providerRequestId: `sms:${conversation.id}:${reply.toolCall.id}`,
  });
  const body = booking.accepted
    ? `You're booked with ${client.businessName}. ${booking.message}`
    : `I couldn't finish the booking. ${booking.message} The business will follow up with you.`;
  await recordAndSend({
    conversationId: conversation.id,
    clientId: client.id,
    from: client.phoneNumber,
    to: input.from,
    body,
    dedupeKey: `reply:${input.messageSid}`,
    bookingAttemptId: booking.bookingAttemptId,
  });
  if (booking.accepted) {
    await db.smsConversation.update({
      where: { id: conversation.id },
      data: { status: SmsConversationStatus.booked },
    });
  }
}
