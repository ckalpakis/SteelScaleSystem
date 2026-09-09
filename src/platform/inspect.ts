import 'dotenv/config';
import { Queue } from 'bullmq';
import { lanes } from './queues.js';
import { queueConnection, queuePrefix } from './config.js';

async function main() {
  const deadline = setTimeout(() => {
    process.stderr.write('Queue inspection timed out\n');
    process.exit(1);
  }, 10000);
  deadline.unref();
  const results = [];
  for (const lane of lanes) {
    const queue = new Queue(`work-${lane}`, {
      connection: queueConnection(),
      prefix: queuePrefix(),
    });
    queue.on('error', () => {});
    try {
      const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed');
      const failures = await queue.getFailed(0, 19);
      results.push({
        lane,
        counts,
        failures: failures.map((job) => ({
          id: job.id,
          attempts: job.attemptsMade,
          finishedOn: job.finishedOn,
        })),
      });
    } finally {
      await queue.close();
    }
  }
  process.stdout.write(JSON.stringify(results, null, 2) + '\n');
  clearTimeout(deadline);
}
void main().catch(() => {
  process.stderr.write('Queue inspection failed; check private Redis connectivity\n');
  process.exit(1);
});
