import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request, Response } from 'express';

const poolInstances: Array<{
  query: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
}> = [];
type PoolBehavior =
  | { type: 'resolve'; value?: { rows?: unknown[] } | unknown }
  | { type: 'reject'; value?: unknown }
  | { type: 'impl'; value: (sql: string) => unknown };

const poolBehaviorQueue: PoolBehavior[] = [];

vi.mock('pg', () => {
  class Pool {
    query = vi.fn();
    end = vi.fn().mockResolvedValue(undefined);
    on = vi.fn();

    constructor() {
      const behavior = poolBehaviorQueue.shift();
      if (behavior?.type === 'impl') {
        this.query.mockImplementation(async (sql: string) =>
          behavior.value(sql),
        );
      } else if (behavior?.type === 'reject') {
        this.query.mockRejectedValue(behavior.value ?? new Error('db error'));
      } else if (behavior?.type === 'resolve') {
        this.query.mockResolvedValue(behavior.value ?? { rows: [] });
      }
      poolInstances.push(this);
    }
  }

  return { default: { Pool }, Pool, __poolInstances: poolInstances };
});

vi.mock('prom-client', () => {
  class Counter {
    inc = vi.fn();
    constructor() {}
  }
  class Gauge {
    static instances: Gauge[] = [];
    set = vi.fn();
    name: string;
    constructor(opts: { name: string }) {
      this.name = opts.name;
      Gauge.instances.push(this);
    }
  }
  const register = {
    contentType: 'text/plain',
    metrics: vi.fn().mockResolvedValue('metrics'),
  };

  return { Counter, Gauge, register };
});

const createRes = (userId?: number): Response => {
  const res = {
    locals: { userId },
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    end: vi.fn().mockReturnThis(),
  } as unknown as Response;

  return res;
};

describe('monitoringController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    poolInstances.length = 0;
    poolBehaviorQueue.length = 0;
    process.env.DATABASE_URL = 'postgres://test';
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('returns 401 when there is no authenticated user', async () => {
    const { setupMonitoring } =
      await import('../controllers/monitoringController');
    // userId in the body must never be trusted
    const req = {
      body: { userId: '42', databaseUrl: 'postgres://user:pass@host/db' },
    } as Request;
    const res = createRes();

    await setupMonitoring(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('returns 400 when databaseUrl is missing', async () => {
    const { setupMonitoring } =
      await import('../controllers/monitoringController');
    const req = { body: {} } as Request;
    const res = createRes(42);

    await setupMonitoring(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'databaseUrl is required',
        message: 'databaseUrl is required',
      }),
    );
  });

  it('stores the connection for the JWT user, not a userId from the body', async () => {
    const { setupMonitoring } =
      await import('../controllers/monitoringController');
    const req = {
      body: { userId: '999', databaseUrl: 'postgres://user:pass@host/db' },
    } as Request;
    const res = createRes(42);

    await setupMonitoring(req, res);

    const appPool = poolInstances[0];
    const upsert = appPool.query.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO user_connections'),
    );
    expect(upsert?.[1]).toEqual([42, 'postgres://user:pass@host/db']);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
  });

  it('sets cumulative pg_stat_database values instead of adding them', async () => {
    poolBehaviorQueue.push({ type: 'resolve', value: { rows: [] } }); // app pool
    poolBehaviorQueue.push({
      type: 'impl',
      value: (sql: string) => {
        if (sql.includes('current_database'))
          return { rows: [{ datname: 'app' }] };
        if (sql.includes('pg_stat_database')) {
          // node-postgres returns bigint columns as strings
          return {
            rows: [
              {
                numbackends: 3,
                xact_commit: '1000',
                blks_hit: '90',
                blks_read: '10',
              },
            ],
          };
        }
        return { rows: [] };
      },
    });
    const { setupMonitoring } =
      await import('../controllers/monitoringController');
    const req = {
      body: { databaseUrl: 'postgres://user:pass@host:6543/db' },
    } as Request;
    const res = createRes(7);

    await setupMonitoring(req, res);

    const { Gauge } = await import('prom-client');
    const gauges = (
      Gauge as unknown as {
        instances: Array<{ name: string; set: ReturnType<typeof vi.fn> }>;
      }
    ).instances;
    const byName = (name: string) =>
      gauges.filter((g) => g.name === name).at(-1)!; // newest module instance
    const labels = { datname: 'app', user_id: '7', instance: 'host:6543' };

    expect(byName('pg_stat_database_xact_commit').set).toHaveBeenCalledWith(
      labels,
      1000,
    );
    expect(byName('pg_stat_database_numbackends').set).toHaveBeenCalledWith(
      labels,
      3,
    );
    expect(byName('pg_stat_database_cache_hit_ratio').set).toHaveBeenCalledWith(
      labels,
      90,
    );
    expect(byName('pg_up').set).toHaveBeenCalledWith(
      { user_id: '7', instance: 'host:6543' },
      1,
    );
  });

  it('returns 500 when database connection test fails', async () => {
    poolBehaviorQueue.push({ type: 'resolve', value: { rows: [] } });
    poolBehaviorQueue.push({ type: 'reject', value: new Error('db down') });

    const { setupMonitoring } =
      await import('../controllers/monitoringController');
    const req = {
      body: { databaseUrl: 'postgres://user:pass@host/db' },
    } as Request;
    const res = createRes(42);

    await setupMonitoring(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'Failed to connect to database',
        message: 'Failed to connect to database',
      }),
    );
  });

  it('returns 500 when metrics collection fails', async () => {
    const { getMetrics } = await import('../controllers/monitoringController');
    const { register } = await import('prom-client');
    (register.metrics as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('metrics failure'),
    );

    const req = {} as Request;
    const res = createRes();

    await getMetrics(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'Failed to get metrics',
        message: 'Failed to get metrics',
      }),
    );
  });
});
