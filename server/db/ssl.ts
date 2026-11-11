import type { ConnectionOptions } from 'tls';

/**
 * TLS options for connections to user-supplied PostgreSQL databases.
 *
 * Certificate verification is ON by default. Supabase (and many hosted
 * providers) present certificates signed by their own CA, so either:
 *   - set PG_SSL_CA to the provider's CA certificate (PEM contents), or
 *   - set PG_SSL_REJECT_UNAUTHORIZED=false for local development only.
 */
export const userDbSsl = (): ConnectionOptions => {
  const ca = process.env.PG_SSL_CA?.replace(/\\n/g, '\n');
  return {
    rejectUnauthorized: process.env.PG_SSL_REJECT_UNAUTHORIZED !== 'false',
    ...(ca ? { ca } : {}),
  };
};
