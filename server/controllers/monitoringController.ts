import { Request, Response } from 'express';
import pg from 'pg';
import { register, Gauge } from 'prom-client';
import { pool as appDbPool, closePool } from '../db/db';
import { userDbSsl } from '../db/ssl';

// Consistent HTTP error responses for this controller
const sendErrorResponse = (
  res: Response,
  status: number,
  message: string,
  details?: string,
): void => {
  res.status(status).json({ error: message, message, details });
};

// Prometheus metrics
//
// pg_stat_database columns are cumulative totals maintained by Postgres, so
// they are exported as Gauges set to the current value (the same approach
// postgres_exporter uses). Calling Counter.inc() with these totals on every
// poll would add the whole total again each time and inflate the series.
// Names match grafana/dashboards/postgresql-overview.json; use rate() on the
// cumulative ones.
const labelNames = ['datname', 'user_id', 'instance'] as const;

const gauge = (name: string, help: string) =>
  new Gauge({ name, help, labelNames });

const pgStatGauges = {
  numbackends: gauge(
    'pg_stat_database_numbackends',
    'Number of backends currently connected to the database',
  ),
  xact_commit: gauge(
    'pg_stat_database_xact_commit',
    'Cumulative number of transactions committed',
  ),
  xact_rollback: gauge(
    'pg_stat_database_xact_rollback',
    'Cumulative number of transactions rolled back',
  ),
  blks_hit: gauge(
    'pg_stat_database_blks_hit',
    'Cumulative number of disk blocks found in the buffer cache',
  ),
  blks_read: gauge(
    'pg_stat_database_blks_read',
    'Cumulative number of disk blocks read',
  ),
  tup_returned: gauge(
    'pg_stat_database_tup_returned',
    'Cumulative number of rows returned by queries',
  ),
  tup_fetched: gauge(
    'pg_stat_database_tup_fetched',
    'Cumulative number of rows fetched by queries',
  ),
  tup_inserted: gauge(
    'pg_stat_database_tup_inserted',
    'Cumulative number of rows inserted',
  ),
  tup_updated: gauge(
    'pg_stat_database_tup_updated',
    'Cumulative number of rows updated',
  ),
  tup_deleted: gauge(
    'pg_stat_database_tup_deleted',
    'Cumulative number of rows deleted',
  ),
} as const;

const dbCacheHitRatio = gauge(
  'pg_stat_database_cache_hit_ratio',
  'Cache hit ratio for the database (percent)',
);

// 1 when the last scrape of the user's database succeeded, 0 when it failed.
const dbUp = new Gauge({
  name: 'pg_up',
  help: 'Whether the last metrics collection from the database succeeded',
  labelNames: ['user_id', 'instance'] as const,
});

// User connection pools management (per-user pools for metrics collection)
type UserPool = { pool: pg.Pool; uriString: string };
const userConnectionPools: Map<string, UserPool> = new Map();
let multiUserCollectionInterval: NodeJS.Timeout | null = null;

const createUserPool = (uriString: string): pg.Pool => {
  const pool = new pg.Pool({
    connectionString: uriString,
    ssl: userDbSsl(),
    max: 2, // metrics collection only needs one or two connections
  });
  // Without a listener, an idle-client error would crash the process.
  pool.on('error', (error) => {
    console.error('Idle client error in user metrics pool', error.message);
  });
  return pool;
};

// Store a user's pool, closing any previous pool for that user.
const setUserPool = (userId: string, pool: pg.Pool, uriString: string) => {
  const existing = userConnectionPools.get(userId);
  if (existing && existing.pool !== pool) {
    existing.pool.end().catch(() => undefined);
  }
  userConnectionPools.set(userId, { pool, uriString });
};

// "host:port" label for a connection string (default port 5432)
const instanceLabel = (uriString: string): string => {
  const url = new URL(uriString);
  return `${url.hostname}:${url.port || '5432'}`;
};

// Collect metrics from a specific user's database
const collectUserDatabaseMetrics = async (
  pool: pg.Pool,
  userId: string,
  uriString: string,
) => {
  try {
    const instance = instanceLabel(uriString);

    // Get database name
    const dbNameResult = await pool.query(
      'SELECT current_database() as datname',
    );
    const datname = dbNameResult.rows[0]?.datname || 'unknown';

    // Get pg_stat_database stats
    const statsResult = await pool.query(
      `
      SELECT 
        numbackends,
        xact_commit,
        xact_rollback,
        blks_hit,
        blks_read,
        tup_returned,
        tup_fetched,
        tup_inserted,
        tup_updated,
        tup_deleted
      FROM pg_stat_database 
      WHERE datname = $1
    `,
      [datname],
    );

    if (statsResult.rows.length > 0) {
      const row = statsResult.rows[0];
      const labels = { datname, user_id: userId, instance };

      // node-postgres returns bigint columns as strings, so convert first.
      const stats = Object.fromEntries(
        Object.keys(pgStatGauges).map((key) => [key, Number(row[key]) || 0]),
      ) as Record<keyof typeof pgStatGauges, number>;

      for (const [key, metric] of Object.entries(pgStatGauges)) {
        metric.set(labels, stats[key as keyof typeof pgStatGauges]);
      }

      const totalBlocks = stats.blks_hit + stats.blks_read;
      const cacheHitRatio =
        totalBlocks > 0 ? (stats.blks_hit / totalBlocks) * 100 : 0;
      dbCacheHitRatio.set(labels, cacheHitRatio);
    }

    dbUp.set({ user_id: userId, instance }, 1);
  } catch (error) {
    console.error(`Error collecting metrics for user ${userId}:`, error);
    setUserMetricsToError(userId, uriString);
  }
};

// Mark the user's database as unreachable
const setUserMetricsToError = (userId: string, uriString: string) => {
  try {
    dbUp.set({ user_id: userId, instance: instanceLabel(uriString) }, 0);
  } catch (error) {
    console.error(`Error setting error metrics for user ${userId}:`, error);
  }
};

// Collect metrics from all user databases
const collectAllUserMetrics = async () => {
  try {
    // Get all active user connections
    const result = await appDbPool.query(`
      SELECT user_id, uri_string 
      FROM user_connections 
      WHERE is_active = true
    `);

    const activeUserIds = new Set<string>();

    for (const row of result.rows) {
      const { user_id, uri_string } = row;
      const userId = user_id.toString();
      activeUserIds.add(userId);

      // Create a pool if missing, or replace it if the user changed databases
      const existing = userConnectionPools.get(userId);
      if (!existing || existing.uriString !== uri_string) {
        try {
          setUserPool(userId, createUserPool(uri_string), uri_string);
        } catch (error) {
          console.error(`Error creating pool for user ${userId}:`, error);
          setUserMetricsToError(userId, uri_string);
          continue;
        }
      }

      const entry = userConnectionPools.get(userId);
      if (entry) {
        await collectUserDatabaseMetrics(entry.pool, userId, uri_string);
      }
    }

    // Close pools for users who are no longer active
    for (const [userId, entry] of userConnectionPools) {
      if (!activeUserIds.has(userId)) {
        entry.pool.end().catch(() => undefined);
        userConnectionPools.delete(userId);
      }
    }
  } catch (error) {
    console.error('Error collecting all user metrics:', error);
  }
};

// Start multi-user metrics collection on a fixed interval
const startMultiUserMetricsCollection = () => {
  if (multiUserCollectionInterval) {
    return; // Already running
  }

  multiUserCollectionInterval = setInterval(async () => {
    await collectAllUserMetrics();
  }, 15000); // 15 seconds interval

  console.log('Multi-user metrics collection started with 15s interval');
};

// Cleanup function
const cleanup = async () => {
  // Close all user connection pools
  for (const [userId, { pool }] of userConnectionPools) {
    try {
      await pool.end();
      console.log(`Closed connection pool for user ${userId}`);
    } catch (error) {
      console.error(`Error closing pool for user ${userId}:`, error);
    }
  }
  userConnectionPools.clear();

  // Close app database pool
  try {
    await closePool();
    console.log('Closed app database pool');
  } catch (error) {
    console.error('Error closing app database pool:', error);
  }

  // Clear interval
  if (multiUserCollectionInterval) {
    clearInterval(multiUserCollectionInterval);
    multiUserCollectionInterval = null;
  }
};

// Setup monitoring for a new user connection.
// The user comes from the verified JWT (res.locals.userId set by
// authenticateUser), never from the request body, so one user cannot
// overwrite another user's connection.
const setupMonitoring = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = res.locals.userId;
    const { databaseUrl } = req.body ?? {};

    if (!userId) {
      sendErrorResponse(res, 401, 'Authentication required');
      return;
    }

    if (!databaseUrl) {
      sendErrorResponse(res, 400, 'databaseUrl is required');
      return;
    }

    try {
      new URL(databaseUrl);
    } catch {
      sendErrorResponse(res, 400, 'databaseUrl must be a postgres:// URL');
      return;
    }

    const userPool = createUserPool(databaseUrl);
    try {
      // Test connection
      await userPool.query('SELECT 1');
    } catch (error) {
      await userPool.end().catch(() => undefined);

      // Record the failed attempt so the collector does not poll it
      await appDbPool
        .query(
          `
        INSERT INTO user_connections (user_id, uri_string, is_active) 
        VALUES ($1, $2, false)
        ON CONFLICT (user_id) 
        DO UPDATE SET 
          uri_string = $2, 
          is_active = false, 
          updated_at = NOW()
      `,
          [userId, databaseUrl],
        )
        .catch((dbError) =>
          console.error('Failed to record connection attempt:', dbError),
        );

      console.error(
        'Database connection test failed:',
        error instanceof Error ? error.message : error,
      );
      sendErrorResponse(
        res,
        500,
        'Failed to connect to database',
        error instanceof Error ? error.message : 'Unknown error',
      );
      return;
    }

    // Store/update user connection in database
    await appDbPool.query(
      `
        INSERT INTO user_connections (user_id, uri_string, is_active) 
        VALUES ($1, $2, true)
        ON CONFLICT (user_id) 
        DO UPDATE SET 
          uri_string = $2, 
          is_active = true, 
          updated_at = NOW()
      `,
      [userId, databaseUrl],
    );

    // Start multi-user collection if not already running
    startMultiUserMetricsCollection();

    // Reuse the tested pool and collect metrics for this user immediately
    setUserPool(userId.toString(), userPool, databaseUrl);
    await collectUserDatabaseMetrics(userPool, userId.toString(), databaseUrl);

    res.json({
      success: true,
      message: 'Database connection established and monitoring started',
    });
  } catch (error) {
    console.error('Error in setupMonitoring:', error);
    sendErrorResponse(
      res,
      500,
      'Internal server error',
      error instanceof Error ? error.message : 'Unknown error',
    );
  }
};

// Get metrics endpoint
const getMetrics = async (req: Request, res: Response) => {
  try {
    // Collect fresh metrics from all users before serving
    await collectAllUserMetrics();

    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  } catch (error) {
    console.error('Error getting metrics:', error);
    sendErrorResponse(
      res,
      500,
      'Failed to get metrics',
      error instanceof Error ? error.message : 'Unknown error',
    );
  }
};

// Initialize function
const initialize = () => {
  startMultiUserMetricsCollection();
};

// Initialize on load
initialize();

export { setupMonitoring, getMetrics, cleanup };
