/**
 * Per-request context — propagated through async call chains via AsyncLocalStorage.
 *
 * Carries the identity of the current user and their org (tenant), so any
 * function in the call tree can read it without explicit parameter threading.
 *
 * Extracted into its own module (rather than living in tools-utils.ts) so that
 * db.ts and other low-level modules can import it without creating circular deps.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  /** Teams user ID (activity.from.id) — identifies the individual. */
  userId: string;
  /**
   * Microsoft Azure AD tenant ID (activity.channelData.tenant.id) — identifies
   * the customer org. Used to route DB operations and file paths to the right
   * tenant-isolated store. Falls back to 'default' for self-hosted deployments
   * and test scripts where tenant is not set.
   */
  tenantId: string;
}

export const _requestContext = new AsyncLocalStorage<RequestContext | undefined>();

/** Current request's user ID, or undefined outside a request context. */
export function getContextUserId(): string | undefined {
  return _requestContext.getStore()?.userId;
}

/** Current request's tenant ID, or undefined outside a request context. */
export function getContextTenantId(): string | undefined {
  return _requestContext.getStore()?.tenantId;
}
