// EXCERPT of src/db.ts — tenant binding only. Pools, migrations, RLS policy
// definitions and role provisioning omitted. Read-only.

/**
 * Thrown when tenant-scoped data access (`getDb()` / `currentTenantId()`)
 * happens outside `_requestContext.run({ tenantId, ... })` in a multi-tenant
 * deployment. Previously the tenant silently fell back to 'default': reads
 * returned nothing and writes were filed under a tenant that doesn't exist.
 */
export class MissingTenantContextError extends Error {
  constructor() {
    super(
      'No tenant context: tenant-scoped DB access must run inside ' +
        '_requestContext.run({ tenantId, userId }, ...). Cross-tenant system ' +
        'work uses getSystemDb(); tenant-less tables use getGlobalDb().',
    );
    this.name = 'MissingTenantContextError';
  }
}

/**
 * Multi-tenant (RLS-enforced) unless `DEPLOYMENT_MODE=self-hosted`. Read at
 * call time so tests can flip it. This is the same predicate `initDatabase`
 * uses to decide whether to enable RLS, so "RLS on" and "tenant context
 * mandatory" can never disagree.
 */
function isMultiTenant(): boolean {
  return (process.env.DEPLOYMENT_MODE ?? 'standard').toLowerCase() !== 'self-hosted';
}

/**
 * The app-pool Db handle. Every query runs inside a transaction that first
 * calls `set_config('app.tenant_id', currentTenantId(), true)` so that
 * Postgres RLS policies (migration 34 onward) can filter rows by tenant
 * without the application code having to add `WHERE tenant_id = ...` to
 * every query. With no AsyncLocalStorage context, `currentTenantId()` throws
 * `MissingTenantContextError` in multi-tenant mode (fail loud, before any
 * connection is taken); self-hosted binds the single 'default' tenant.
 *
 * Per-query transaction overhead is ~3x more round-trips than a bare
 * `pool.query`. Acceptable for our workload (low qps, < 5 queries per
 * inbound message). For high-volume cron/retention queries that
 * legitimately span tenants, use `getSystemDb()` instead — it skips the
 * tenant binding and routes via the system pool (intended to hold
 * BYPASSRLS once migration 34 lands).
 */
function makeDb(): Db {
  const p = getPool();
  return {
    async query(text, values) {
      const tid = currentTenantId();
      const client = await p.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.tenant_id', $1::text, true)`, [tid]);
        const result = await client.query(text, values);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    async rows(text, values) {
      const r = await this.query(text, values);
      return r.rows as any[];
    },
    async one(text, values) {
      const r = await this.query(text, values);
      return r.rows[0] as any;
    },
    async tx(fn) {
      const tid = currentTenantId();
      const client = await p.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.tenant_id', $1::text, true)`, [tid]);
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
  };
}

/**
 * Returns the app-pool database handle. Every query runs inside a transaction
 * that binds `app.tenant_id` to the current request's tenant via
 * `set_config(..., true)`. Postgres RLS policies (migration 34 onward) use
 * this session-local setting to filter rows by tenant. For cron / system
 * paths that need to span tenants, use `getSystemDb()` instead.
 */
export function getDb(): Db {
  return makeDb();
}

/**
 * Returns an app-pool handle with NO tenant binding, for data that has no
 * tenant at all: tables without a `tenant_id` column (e.g.
 * `knn_training_embeddings`) and session-level primitives like advisory
 * locks. It does NOT bypass RLS — the app role is NOBYPASSRLS and
 * `app.tenant_id` is unset, so pointing it at a tenant table reads zero rows
 * and every write is rejected by WITH CHECK. The RLS catalog guard
 * (`security.rls-coverage.test.ts`) guarantees every `tenant_id` table has
 * that policy. Usable outside a request context.
 */
export function getGlobalDb(): Db {
  return makeUnboundDb(getPool());
}

/**
 * Returns the current tenantId from the request context. Used by `getDb()`
 * to bind `app.tenant_id` and by per-domain statements to fill / filter the
 * `tenant_id` column.
 *
 * Outside a request context: self-hosted (single tenant) gets 'default';
 * multi-tenant throws `MissingTenantContextError`. The old silent 'default'
 * fallback mis-filed writes under a non-existent tenant and made reads come
 * back empty with no error. Entry points (message handler, OAuth callback,
 * tabs, scheduler, webhooks, crons) wrap their work in
 * `_requestContext.run(...)`; cross-tenant work uses `getSystemDb()`.
 */
export function currentTenantId(): string {
  const tenantId = _requestContext.getStore()?.tenantId;
  if (tenantId !== undefined) return tenantId;
  if (isMultiTenant()) throw new MissingTenantContextError();
  return DEFAULT_TENANT;
}
