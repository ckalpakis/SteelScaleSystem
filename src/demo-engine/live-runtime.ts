import { createHash, randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import WebSocket from 'ws';
import { Prisma, type SalesDemoSession } from '@prisma/client';
import { db } from '../db/client.js';
import { logger } from '../utils/logger.js';
import { record } from '../services/openai-response.js';
import { canView, type Presentation } from './core.js';
import {
  createVoiceCall,
  demoChat,
  demoTool,
  hangupVoiceCall,
  voiceTransport,
  realtimeConfig,
  type DemoTurn,
} from './live-provider.js';

export class LiveError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export const SESSION_MINUTES = 10;
export const VOICE_SECONDS = 180;
export const MAX_TURNS = 20;
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const controls = new Map<string, WebSocket>();

export function liveReadiness() {
  const key = Boolean(process.env.DEMO_OPENAI_API_KEY || process.env.OPENAI_API_KEY);
  const enabled =
    process.env.DEMO_ENGINE_ENABLED === 'true' && process.env.DEMO_AI_ENABLED === 'true';
  return {
    chat: enabled && key,
    voice: enabled && key && process.env.DEMO_VOICE_ENABLED === 'true',
  };
}

function enabled(channel: string): void {
  const ready = liveReadiness();
  if (!(channel === 'voice' ? ready.voice : ready.chat))
    throw new LiveError(
      503,
      'Live AI is not enabled for this demo yet. Ask the presenter to check the demo settings.',
    );
}

export async function availableDemo(demoId: string, preview: boolean) {
  const demo = await db.salesDemo.findUnique({
    where: { id: demoId },
    select: { id: true, version: true, status: true, expiresAt: true, presentation: true },
  });
  if (!demo || (preview ? demo.status === 'archived' : !canView(demo.status, demo.expiresAt)))
    throw new LiveError(404, 'This demo is no longer available.');
  return demo;
}

export async function startSession(demoId: string, preview: boolean, channel: 'chat' | 'voice') {
  enabled(channel);
  const token = randomBytes(32).toString('hex');
  const now = new Date();
  const day = new Date(now);
  day.setUTCHours(0, 0, 0, 0);
  return db.$transaction(async (tx) => {
    // One shared DB lock makes daily and concurrency limits hold across replicas.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(728391004)`;
    const demo = await tx.salesDemo.findUnique({
      where: { id: demoId },
      select: { id: true, version: true, status: true, expiresAt: true, presentation: true },
    });
    if (!demo || (preview ? demo.status === 'archived' : !canView(demo.status, demo.expiresAt)))
      throw new LiveError(404, 'This demo is no longer available.');
    const p = demo.presentation as unknown as Presentation;
    if (!p.modules.includes(channel === 'voice' ? 'voice' : 'chatbot'))
      throw new LiveError(403, 'This experience is not included in this demo.');
    const [daily, perDemo, active, voiceDaily] = await Promise.all([
      tx.salesDemoSession.count({ where: { createdAt: { gte: day } } }),
      tx.salesDemoSession.count({ where: { demoId, createdAt: { gte: day } } }),
      tx.salesDemoSession.count({ where: { endedAt: null, expiresAt: { gt: now } } }),
      tx.salesDemoSession.count({ where: { channel: 'voice', createdAt: { gte: day } } }),
    ]);
    if (daily >= 40 || perDemo >= 10 || active >= 4 || (channel === 'voice' && voiceDaily >= 10))
      throw new LiveError(
        429,
        'The live demo usage limit has been reached. Please try again later.',
      );
    const expiresAt = new Date(
      Math.min(
        now.getTime() + (channel === 'voice' ? VOICE_SECONDS * 1000 : SESSION_MINUTES * 60000),
        !preview && demo.expiresAt ? demo.expiresAt.getTime() : Infinity,
      ),
    );
    const session = await tx.salesDemoSession.create({
      data: {
        demoId,
        demoVersion: demo.version,
        tokenHash: hash(token),
        channel,
        preview,
        expiresAt,
      },
    });
    return { id: session.id, token, expiresAt: expiresAt.toISOString(), maxTurns: MAX_TURNS };
  });
}

export async function authenticateSession(
  id: string,
  token: unknown,
  demoId: string,
  preview: boolean,
) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token))
    throw new LiveError(401, 'Demo session credentials are missing.');
  const session = await db.salesDemoSession.findFirst({
    where: { id, tokenHash: hash(token), demoId, preview },
  });
  if (!session) throw new LiveError(401, 'Demo session could not be verified.');
  return session;
}

async function activeSession(session: SalesDemoSession) {
  enabled(session.channel);
  if (session.endedAt || session.expiresAt <= new Date())
    throw new LiveError(410, 'This conversation has ended. Start a new conversation.');
  const demo = await availableDemo(session.demoId, session.preview);
  if (demo.version !== session.demoVersion)
    throw new LiveError(410, 'The demo has changed. Reload to start a new conversation.');
  return demo.presentation as unknown as Presentation;
}

export async function sendChat(session: SalesDemoSession, message: unknown) {
  if (session.channel !== 'chat') throw new LiveError(400, 'Use a chat session.');
  if (typeof message !== 'string' || !message.trim() || message.length > 1500)
    throw new LiveError(400, 'Enter a message of 1–1,500 characters.');
  const p = await activeSession(session);
  const claimed = await db.salesDemoSession.updateMany({
    where: {
      id: session.id,
      endedAt: null,
      expiresAt: { gt: new Date() },
      turns: { lt: MAX_TURNS },
      OR: [{ busyUntil: null }, { busyUntil: { lt: new Date() } }],
    },
    data: { busyUntil: new Date(Date.now() + 30000), turns: { increment: 1 } },
  });
  if (!claimed.count)
    throw new LiveError(
      429,
      'Wait for the current reply, or start a new conversation if the turn limit was reached.',
    );
  try {
    const fresh = await db.salesDemoSession.findUniqueOrThrow({ where: { id: session.id } });
    const previous = fresh.messages as unknown as DemoTurn[];
    const turns: DemoTurn[] = [...previous, { role: 'user', content: message.trim() }];
    const result = await demoChat(p, turns, session.id);
    // Recheck after the provider call so archive, edits and kill switches take effect in flight.
    await activeSession(await db.salesDemoSession.findUniqueOrThrow({ where: { id: session.id } }));
    await db.salesDemoSession.update({
      where: { id: session.id },
      data: {
        messages: json([...turns, { role: 'assistant', content: result.message }]),
        ...(result.booking ? { booking: json(result.booking) } : {}),
      },
    });
    return result;
  } finally {
    await db.salesDemoSession.updateMany({ where: { id: session.id }, data: { busyUntil: null } });
  }
}

export async function endSession(id: string) {
  const session = await db.salesDemoSession.findUnique({ where: { id } });
  if (!session) return;
  if (session.providerCallId) {
    // Retain call ID for watchdog retries if the provider is temporarily unavailable.
    await hangupVoiceCall(session.providerCallId);
  }
  await db.salesDemoSession.update({
    where: { id },
    data: { endedAt: new Date(), providerCallId: null },
  });
  const socket = controls.get(id);
  controls.delete(id);
  socket?.close();
}

async function handleVoiceEvent(id: string, socket: WebSocket, raw: unknown) {
  const event = record(raw);
  const session = await db.salesDemoSession.findUniqueOrThrow({ where: { id } });
  await activeSession(session);
  if (event.type === 'error') {
    await endSession(id);
    return;
  }
  if (event.type === 'session.updated') {
    // A browser data channel must not increase limits or replace the demo instructions/tools.
    const p = (await availableDemo(session.demoId, session.preview))
      .presentation as unknown as Presentation;
    const actual = record(event.session);
    const expected = realtimeConfig(p);
    const toolShape = (tools: unknown) =>
      Array.isArray(tools)
        ? tools.map((tool: unknown) => {
            const value = record(tool);
            return {
              type: value.type,
              name: value.name,
              description: value.description,
              parameters: value.parameters,
            };
          })
        : [];
    if (
      actual.instructions !== expected.instructions ||
      actual.max_output_tokens !== 512 ||
      !isDeepStrictEqual(toolShape(actual.tools), toolShape(expected.tools))
    ) {
      await endSession(id);
      return;
    }
  }
  if (event.type === 'response.created') {
    const updated = await db.salesDemoSession.update({
      where: { id },
      data: { turns: { increment: 1 } },
    });
    if (updated.turns > MAX_TURNS) {
      await endSession(id);
      return;
    }
  }
  if (event.type === 'response.function_call_arguments.done') {
    if (
      typeof event.name !== 'string' ||
      typeof event.arguments !== 'string' ||
      event.arguments.length > 4000 ||
      typeof event.call_id !== 'string'
    )
      throw new Error('Invalid voice tool');
    const result = demoTool(event.name, JSON.parse(event.arguments) as unknown, id);
    if (result.booking)
      await db.salesDemoSession.update({ where: { id }, data: { booking: json(result.booking) } });
    socket.send(
      JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: event.call_id,
          output: JSON.stringify(result),
        },
      }),
    );
    socket.send(JSON.stringify({ type: 'response.create' }));
  }
}

export async function connectVoice(session: SalesDemoSession, sdp: unknown) {
  if (
    session.channel !== 'voice' ||
    typeof sdp !== 'string' ||
    !sdp.startsWith('v=0') ||
    sdp.length > 24000
  )
    throw new LiveError(400, 'Invalid voice connection request.');
  const p = await activeSession(session);
  // A session authorizes exactly one provider call, including across retries and replicas.
  const claimed = await db.salesDemoSession.updateMany({
    where: { id: session.id, turns: 0, busyUntil: null, endedAt: null },
    data: { busyUntil: session.expiresAt, turns: 1 },
  });
  if (!claimed.count) throw new LiveError(409, 'This voice session has already started.');
  let callId: string | undefined;
  try {
    const connection = await createVoiceCall(sdp, p);
    callId = connection.callId;
    await db.salesDemoSession.update({
      where: { id: session.id },
      data: { providerCallId: callId },
    });
    await activeSession(await db.salesDemoSession.findUniqueOrThrow({ where: { id: session.id } }));
    const socket = voiceTransport.connect(callId);
    controls.set(session.id, socket);
    let queue: Promise<void> = Promise.resolve();
    let closing = false;
    let pending = 0;
    const failClosed = () => {
      if (closing) return;
      closing = true;
      void endSession(session.id).catch(() =>
        logger.error({ component: 'demo-voice' }, 'Voice cleanup pending retry'),
      );
    };
    socket.on('message', (data) => {
      if (closing) return;
      const bytes = Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.isBuffer(data)
          ? data
          : Buffer.from(data);
      let event: Record<string, unknown>;
      try {
        event = record(JSON.parse(bytes.toString('utf8')) as unknown);
      } catch {
        failClosed();
        return;
      }
      // Audio/transcript chunks go directly to the browser, not through DB checks per chunk.
      if (
        ![
          'response.created',
          'response.function_call_arguments.done',
          'session.updated',
          'error',
        ].includes(String(event.type))
      )
        return;
      if (++pending > 64) {
        failClosed();
        return;
      }
      queue = queue
        .then(async () => {
          if (!closing) await handleVoiceEvent(session.id, socket, event);
        })
        .catch(failClosed)
        .finally(() => {
          pending--;
        });
    });
    socket.on('close', failClosed);
    socket.on('error', failClosed);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    // The browser requests the first greeting after its data channel opens.
    return { sdp: connection.sdp, expiresAt: session.expiresAt.toISOString() };
  } catch {
    if (callId) await endSession(session.id).catch(() => undefined);
    else
      await db.salesDemoSession.update({
        where: { id: session.id },
        data: { endedAt: new Date() },
      });
    throw new LiveError(502, 'The receptionist could not connect. Please try a new call.');
  }
}

export async function sweepVoiceCalls(): Promise<void> {
  const sessions = await db.salesDemoSession.findMany({
    where: { providerCallId: { not: null } },
    include: { demo: { select: { version: true, status: true, expiresAt: true } } },
  });
  for (const session of sessions) {
    if (
      !liveReadiness().voice ||
      session.endedAt ||
      session.expiresAt <= new Date() ||
      session.demoVersion !== session.demo.version ||
      (session.preview
        ? session.demo.status === 'archived'
        : !canView(session.demo.status, session.demo.expiresAt))
    ) {
      await endSession(session.id).catch(() =>
        logger.error({ component: 'demo-voice' }, 'Voice hangup will be retried'),
      );
    }
  }
}

export function startVoiceWatchdog() {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void sweepVoiceCalls()
      .catch(() => logger.error({ component: 'demo-voice' }, 'Voice watchdog failed'))
      .finally(() => {
        running = false;
      });
  }, 2000);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await Promise.allSettled([...controls.keys()].map(endSession));
  };
}
