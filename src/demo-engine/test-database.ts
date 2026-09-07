/** Fail before importing dotenv/app or touching any DB. Tests erase demo fixtures. */
export function requireDemoTestDatabase(): void {
  const url = new URL(process.env.DATABASE_URL || 'https://invalid');
  if (
    process.env.NODE_ENV !== 'test' ||
    !['postgresql:', 'postgres:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    !/^\/steel_scale_demo_[a-z_]*test$/.test(url.pathname)
  ) {
    throw new Error(
      'Use NODE_ENV=test and an explicit loopback DATABASE_URL named steel_scale_demo_*test. Demo integration tests erase demo fixtures.',
    );
  }
}
