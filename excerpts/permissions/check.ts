/**
 * Permission checking for tool execution.
 *
 * Before a tool runs, this module verifies that the user has toggled on
 * the permission that gates it. If not, it returns a helpful denial message
 * that distinguishes between:
 *   1. User toggle is off — the user can self-serve in settings
 *   2. Org scope not granted — the user needs to ask their admin
 *
 * All permissions (read and write) use a simple on/off toggle.
 * Confirmation and execution style are handled conversationally by the model,
 * not by a system-level mode.
 */

import { getUserToggles, getOrgPermission } from '../db.js';
import { getGraphClient } from '../graph/client.js';
import { logger } from '../logger.js';
import { getToolPermission, getPermissionById } from './registry.js';
import type { Permission } from './types.js';

export interface PermissionCheckResult {
  allowed: boolean;
  /** If not allowed, why. */
  reason?: string;
}

/**
 * Check whether any required Graph scopes for a permission are missing
 * from the token's granted scopes. Returns the list of missing scope names.
 */
function getMissingScopesForPermission(
  requiredScopes: string[],
  userId: string,
): string[] | null {
  if (requiredScopes.length === 0) return null;

  // Resolve the CHECKED user's client — not getGraphClient()'s first-user
  // fallback, which reads the wrong user's granted scopes in a multi-user
  // process and produces a FALSE "requires admin approval" denial even when
  // the actual user has the scope (found in Teams Store certification review:
  // transcript denied despite all toggles on). Same first-client bug class as
  // the webhook fixes.
  const client = getGraphClient(userId);
  if (!client) return null; // Can't check — Graph not connected

  const granted = client.getGrantedScopes();
  if (granted.length === 0) return null; // No scope info available

  // Graph scopes are case-insensitive. MSAL may return full URIs
  // (e.g. "https://graph.microsoft.com/Mail.Send") while the registry
  // stores short names (e.g. "Mail.Send"). Normalize to short name for comparison.
  const shortName = (s: string) => s.toLowerCase().replace(/^https:\/\/graph\.microsoft\.com\//i, '');
  const grantedShort = new Set(granted.map(shortName));
  const missing = requiredScopes.filter(
    (s) => !grantedShort.has(shortName(s)),
  );
  return missing.length > 0 ? missing : null;
}

/**
 * Check whether a user has permission to use a given tool.
 *
 * - If the tool is not gated by any permission, it is always allowed.
 * - Fail-closed: if the user has no toggle rows at all (initDefaultToggles
 *   never seeded them at sign-in), the request is DENIED with a "sign out and
 *   back in" message — no hardcoded read-ON/write-OFF fallback (that fallback
 *   was a privilege-leak vector). A permission with no row for
 *   this specific user (e.g. added to the registry post-sign-in) defaults off.
 * - Returns { allowed: false, reason } with a user-friendly message if denied,
 *   distinguishing between user-toggle-off and org-scope-not-granted.
 */
export async function checkPermission(
  userId: string,
  toolName: string,
): Promise<PermissionCheckResult> {
  const permission = getToolPermission(toolName);
  // Tools not mapped to any permission are always allowed
  if (!permission) return { allowed: true };
  return evaluatePermission(userId, permission);
}

/**
 * Check a permission by its id — for tools that span MULTIPLE categories and
 * so can't map to a single permission (e.g. search_across_m365). The caller
 * gates each resource type on its own read permission id.
 */
export async function checkPermissionById(
  userId: string,
  permissionId: string,
): Promise<PermissionCheckResult> {
  const permission = getPermissionById(permissionId);
  if (!permission) return { allowed: true };
  return evaluatePermission(userId, permission);
}

/** Core evaluation: org admin policy + user toggle + Graph scopes. */
async function evaluatePermission(
  userId: string,
  permission: Permission,
): Promise<PermissionCheckResult> {
  // Layer 1: check org-level admin policy (ceiling — if admin disabled, user can't override)
  const orgPolicy = await getOrgPermission(permission.id);
  if (orgPolicy && !orgPolicy.admin_enabled) {
    return {
      allowed: false,
      reason:
        `${permission.label} has been disabled by your organization admin.`,
    };
  }

  // Fail-closed. Look up this user's toggles only — no 'default' fallback
  // (that was a privilege-leak vector). If the user has no rows at all, deny:
  // this means initDefaultToggles never ran for them (sign-in flow is
  // supposed to populate baseline at OAuth complete), and surfacing that
  // failure beats silently running on hardcoded defaults that hide bugs.
  const toggles = await getUserToggles(userId);
  if (toggles.length === 0) {
    logger.warn(
      { userId, permission: permission.id },
      'checkPermission: user has no permission toggle rows — denying. ' +
        'This means initDefaultToggles never ran for this user; ' +
        'they should sign out and back in to seed the baseline.',
    );
    return {
      allowed: false,
      reason:
        `I couldn't load your permission settings. ` +
        `Please sign out and sign back in to refresh them, ` +
        `or contact your administrator if this persists.`,
    };
  }
  const toggle = toggles.find((t) => t.permission_id === permission.id);

  // Toggle row may exist for OTHER permissions but not this one. That's
  // a normal state for any permission added to the registry after the user
  // signed in. Default that case to off (write-style: opt-in) — the user
  // can enable in Settings. (Was previously "read-on/write-off baseline";
  // that baseline now lives in initDefaultToggles which runs at sign-in,
  // so by the time checkPermission runs, every registered permission has
  // an explicit row unless added post-sign-in.)
  const enabled = toggle ? Boolean(toggle.enabled) : false;

  if (!enabled) {
    return {
      allowed: false,
      reason:
        `${permission.label} is turned off. ` +
        `You can enable it in your settings page.`,
    };
  }

  // Toggle is on — check org scopes
  const missingScopes = getMissingScopesForPermission(permission.graphScopes, userId);
  if (missingScopes) {
    return {
      allowed: false,
      reason:
        `This capability requires admin approval. ` +
        `Ask your administrator to grant the following scope${missingScopes.length > 1 ? 's' : ''}: ${missingScopes.join(', ')}.`,
    };
  }

  return { allowed: true };
}
