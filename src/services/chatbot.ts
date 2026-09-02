import { BookingSource, ChatRole, ChatSessionStatus } from '@prisma/client';

import { db } from '../db/client.js';
import type { ChatTurn } from '../types/chatbot.js';
import { createBookingAttempt } from './bookings.js';
import { getChatbotReply } from './chatbot-llm.js';

export interface ChatbotMessageInput {
  clientId: string;
  sessionId: string;
  message: string;
}

export interface ChatbotMessageResult {
  reply: string;
  booked: boolean;
  bookingAttemptId?: string;
}

function systemPrompt(businessName: string, services: string[], timezone: string): string {
  return [
    `You are the website booking assistant for ${businessName}.`,
    `The business offers: ${services.join(', ')}.`,
    `Qualify what the visitor needs and collect their full name, callback phone number, service address, requested service, and preferred appointment time in ${timezone}.`,
    'Ask concise questions, one or two at a time. Read all details back and ask for confirmation.',
    'Only after explicit confirmation, call create_booking with every required field and convert the preferred time to an ISO 8601 timestamp with timezone offset.',
    'Never invent details and never say a booking was accepted unless the tool succeeds.',
  ].join(' ');
}

export async function processChatbotMessage(
  input: ChatbotMessageInput,
): Promise<ChatbotMessageResult> {
  const client = await db.client.findUnique({ where: { id: input.clientId } });
  if (!client) throw new Error('Client not found');

  const session = await db.chatSession.upsert({
    where: { clientId_sessionKey: { clientId: client.id, sessionKey: input.sessionId } },
    update: {},
    create: { clientId: client.id, sessionKey: input.sessionId },
  });

  await db.chatMessage.create({
    data: { chatSessionId: session.id, role: ChatRole.user, content: input.message },
  });

  const history = await db.chatMessage.findMany({
    where: { chatSessionId: session.id, role: { in: [ChatRole.user, ChatRole.assistant] } },
    orderBy: { createdAt: 'asc' },
    take: 40,
  });
  const turns: ChatTurn[] = history.map((message) => ({
    role: message.role === ChatRole.user ? 'user' : 'assistant',
    content: message.content,
  }));
  const llmReply = await getChatbotReply(
    client.id,
    systemPrompt(client.businessName, client.services, client.timezone),
    turns,
  );

  if (!llmReply.toolCall) {
    await db.chatMessage.create({
      data: { chatSessionId: session.id, role: ChatRole.assistant, content: llmReply.text },
    });
    return { reply: llmReply.text, booked: false };
  }

  const booking = await createBookingAttempt({
    clientId: client.id,
    source: BookingSource.chatbot,
    ...llmReply.toolCall.input,
    providerRequestId: `${session.id}:${llmReply.toolCall.id}`,
  });
  const confirmation = `${llmReply.text} ${booking.message}`;

  await db.$transaction([
    db.chatMessage.create({
      data: {
        chatSessionId: session.id,
        role: ChatRole.tool,
        content: JSON.stringify(booking),
        toolCallId: llmReply.toolCall.id,
      },
    }),
    db.chatMessage.create({
      data: { chatSessionId: session.id, role: ChatRole.assistant, content: confirmation },
    }),
    db.chatSession.update({
      where: { id: session.id },
      data: { status: ChatSessionStatus.booked },
    }),
  ]);

  return { reply: confirmation, booked: true, bookingAttemptId: booking.bookingAttemptId };
}
