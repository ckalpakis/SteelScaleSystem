import { app } from './app.js';
import { env } from './config/env.js';
import { db } from './db/client.js';
import { logger } from './utils/logger.js';
import { resumeInterruptedLeadPipelines } from './lead-intelligence/pipeline/background.js';

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, 'HTTP server listening');
  void resumeInterruptedLeadPipelines().catch((error: unknown) => {
    logger.error({ err: error }, 'Failed to resume interrupted lead pipelines');
  });
});

function shutdown(signal: NodeJS.Signals): void {
  logger.info({ signal }, 'Shutting down');

  server.close((error) => {
    if (error) {
      logger.error({ error }, 'Failed to close HTTP server');
      process.exitCode = 1;
    }

    void db.$disconnect().catch((disconnectError: unknown) => {
      logger.error({ error: disconnectError }, 'Failed to disconnect from database');
      process.exitCode = 1;
    });
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
