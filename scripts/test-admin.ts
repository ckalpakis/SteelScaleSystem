import { createServer } from 'node:http';
import { once } from 'node:events';

async function testAdmin(): Promise<void> {
  process.env.DATABASE_URL ??= 'postgresql://postgres:postgres@localhost:54329/steel_scale';
  process.env.ADMIN_USERNAME = 'admin-test';
  process.env.ADMIN_PASSWORD = 'admin-test-password';

  const { app } = await import('../src/app.js');
  const { db } = await import('../src/db/client.js');
  const client = await db.client.findUniqueOrThrow({
    where: { phoneNumber: '+15550102030' },
  });
  const server = createServer(app);
  server.listen(0, '127.0.0.1');

  try {
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Admin test server failed');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const unauthorized = await fetch(`${baseUrl}/admin`);
    if (unauthorized.status !== 401)
      throw new Error(`Expected 401, received ${unauthorized.status}`);

    const authorization = `Basic ${Buffer.from('admin-test:admin-test-password').toString('base64')}`;
    const list = await fetch(`${baseUrl}/admin`, { headers: { authorization } });
    const listHtml = await list.text();
    if (list.status !== 200 || !listHtml.includes(client.businessName)) {
      throw new Error('Authenticated client list did not render the seeded client');
    }

    const detail = await fetch(`${baseUrl}/admin/clients/${client.id}`, {
      headers: { authorization },
    });
    const detailHtml = await detail.text();
    if (detail.status !== 200 || !detailHtml.includes('Recent booking attempts')) {
      throw new Error('Client detail page did not render operational activity');
    }

    console.log(
      'Admin smoke test passed: authentication, client list, and detail activity render correctly.',
    );
  } finally {
    server.close();
    await once(server, 'close');
    await db.$disconnect();
  }
}

void testAdmin();
