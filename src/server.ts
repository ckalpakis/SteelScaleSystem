import { app } from './app.js';
import { env } from './config/env.js';
import { db } from './db/client.js';
import { logger } from './utils/logger.js';
import { resumeInterruptedLeadPipelines } from './lead-intelligence/pipeline/background.js';
import { startVoiceWatchdog } from './demo-engine/live-runtime.js';

const stopDemoVoice =
  process.env.DEMO_ENGINE_ENABLED === 'true' ? startVoiceWatchdog() : async () => {};

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, 'HTTP server listening');
  void resumeInterruptedLeadPipelines().catch((error: unknown) => {
    logger.error({ err: error }, 'Failed to resume interrupted lead pipelines');
  });
});

function shutdown(signal: NodeJS.Signals): void {
  logger.info({ signal }, 'Shutting down');
  const voiceCleanup = stopDemoVoice().catch(() =>
    logger.error({ component: 'demo-voice' }, 'Voice shutdown cleanup failed'),
  );

  server.close((error) => {
    if (error) {
      logger.error({ error }, 'Failed to close HTTP server');
      process.exitCode = 1;
    }

    void voiceCleanup
      .then(() => db.$disconnect())
      .catch((disconnectError: unknown) => {
        logger.error({ error: disconnectError }, 'Failed to disconnect from database');
        process.exitCode = 1;
      });
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
