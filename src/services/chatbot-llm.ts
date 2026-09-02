import { randomUUID } from 'node:crypto';

import { env } from '../config/env.js';
import type { BookingToolInput, ChatTurn, LlmReply } from '../types/chatbot.js';
import { logger } from '../utils/logger.js';

const BOOKING_PARAMETERS = {
  type: 'object',
  properties: {
    customerName: { type: 'string', description: "Caller's full name" },
    phoneNumber: { type: 'string', description: 'Callback phone number' },
    address: { type: 'string', description: 'Service address' },
    service: { type: 'string', description: 'Requested service' },
    preferredTime: {
      type: 'string',
      description: 'Preferred appointment as an ISO 8601 timestamp including timezone offset',
    },
  },
  required: ['customerName', 'phoneNumber', 'address', 'service', 'preferredTime'],
  additionalProperties: false,
} as const;

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseBookingInput(value: unknown): BookingToolInput | undefined {
  const input = objectValue(value);
  if (!input) return undefined;
  const fields = ['customerName', 'phoneNumber', 'address', 'service', 'preferredTime'] as const;
  if (
    !fields.every((field) => typeof input[field] === 'string' && input[field].trim().length > 0)
  ) {
    return undefined;
  }
  return Object.fromEntries(
    fields.map((field) => [field, (input[field] as string).trim()]),
  ) as unknown as BookingToolInput;
}

async function fetchJson(
  url: string,
  init: RequestInit,
  context: { clientId: string; provider: 'openai' | 'anthropic' },
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  } catch (error: unknown) {
    logger.error(
      { err: error, ...context, attempted: 'chatbot_llm_completion' },
      'LLM API request failed',
    );
    throw error;
  }
  const body: unknown = await response.json();
  if (!response.ok) {
    logger.error(
      { ...context, attempted: 'chatbot_llm_completion', status: response.status },
      'LLM API rejected request',
    );
    throw new Error(`LLM request failed (${response.status}): ${JSON.stringify(body)}`);
  }
  const result = objectValue(body);
  if (!result) throw new Error('LLM returned an invalid response');
  return result;
}

async function callOpenAi(
  clientId: string,
  systemPrompt: string,
  turns: ChatTurn[],
): Promise<LlmReply> {
  if (!env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required for LLM_PROVIDER=openai');
  const response = await fetchJson(
    'https://api.openai.com/v1/responses',
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.OPENAI_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: env.LLM_MODEL ?? 'gpt-5.4-nano',
        instructions: systemPrompt,
        input: turns,
        tools: [
          {
            type: 'function',
            name: 'create_booking',
            description: 'Create the appointment after the visitor confirms all booking details.',
            parameters: BOOKING_PARAMETERS,
            strict: true,
          },
        ],
        tool_choice: 'auto',
      }),
    },
    { clientId, provider: 'openai' },
  );
  const output = Array.isArray(response.output) ? response.output : [];
  const functionCall = output.map(objectValue).find((item) => item?.type === 'function_call');
  if (functionCall) {
    const parsedArguments =
      typeof functionCall.arguments === 'string'
        ? parseBookingInput(JSON.parse(functionCall.arguments) as unknown)
        : undefined;
    if (!parsedArguments || typeof functionCall.call_id !== 'string') {
      throw new Error('OpenAI returned invalid create_booking arguments');
    }
    return {
      text: 'I have all the details. One moment while I record your booking.',
      toolCall: {
        id: functionCall.call_id,
        name: 'create_booking',
        input: parsedArguments,
      },
    };
  }
  if (typeof response.output_text !== 'string') throw new Error('OpenAI returned no text');
  return { text: response.output_text };
}

async function callAnthropic(
  clientId: string,
  systemPrompt: string,
  turns: ChatTurn[],
): Promise<LlmReply> {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is required for LLM_PROVIDER=anthropic');
  }
  const response = await fetchJson(
    'https://api.anthropic.com/v1/messages',
    {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: env.LLM_MODEL ?? 'claude-sonnet-4-5',
        max_tokens: 500,
        system: systemPrompt,
        messages: turns,
        tools: [
          {
            name: 'create_booking',
            description: 'Create the appointment after the visitor confirms all booking details.',
            input_schema: BOOKING_PARAMETERS,
          },
        ],
      }),
    },
    { clientId, provider: 'anthropic' },
  );
  const content = Array.isArray(response.content) ? response.content : [];
  const blocks = content.map(objectValue).filter((block) => block !== undefined);
  const toolUse = blocks.find(
    (block) => block.type === 'tool_use' && block.name === 'create_booking',
  );
  if (toolUse) {
    const input = parseBookingInput(toolUse.input);
    if (!input || typeof toolUse.id !== 'string')
      throw new Error('Claude returned invalid tool input');
    return {
      text: 'I have all the details. One moment while I record your booking.',
      toolCall: { id: toolUse.id, name: 'create_booking', input },
    };
  }
  const text = blocks
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n');
  if (!text) throw new Error('Claude returned no text');
  return { text };
}

function callMock(turns: ChatTurn[]): LlmReply {
  const latest = turns.at(-1)?.content;
  if (latest === '/test-booking') {
    return {
      text: 'Thanks — I have everything I need and recorded your test booking.',
      toolCall: {
        id: `mock-tool-${randomUUID()}`,
        name: 'create_booking',
        input: {
          customerName: 'Jamie Test',
          phoneNumber: '+15558675309',
          address: '123 Test Street, Raleigh, NC 27601',
          service: 'HVAC repair',
          preferredTime: '2027-01-15T10:00:00-05:00',
        },
      },
    };
  }
  return { text: 'I can help with that. What service do you need and what is your name?' };
}

export async function getChatbotReply(
  clientId: string,
  systemPrompt: string,
  turns: ChatTurn[],
): Promise<LlmReply> {
  if (env.LLM_PROVIDER === 'mock') return callMock(turns);
  return env.LLM_PROVIDER === 'anthropic'
    ? callAnthropic(clientId, systemPrompt, turns)
    : callOpenAi(clientId, systemPrompt, turns);
}
