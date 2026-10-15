/**
 * Permission model types for the user permissions toggle system.
 *
 * Each Permission maps a user-facing toggle to the Microsoft Graph scopes
 * and agent tools it gates. Users can enable/disable permissions; the system
 * checks both the user toggle and whether the org admin has granted the
 * underlying Graph scope.
 */

export interface Permission {
  /** Unique identifier, e.g. 'mail.read', 'calendar.write'. */
  id: string;
  /** Short human-readable label, e.g. 'Read email'. */
  label: string;
  /** Longer description of what this permission allows. */
  description: string;
  /** Grouping category, e.g. 'Email', 'Calendar', 'Tasks'. */
  category: string;
  /** Microsoft Graph API scopes this permission maps to. */
  graphScopes: string[];
  /** Tool names (from tools.ts) that this permission gates. */
  toolNames: string[];
  /** Whether this is a write/destructive operation. */
  isWrite: boolean;
}

export interface UserPermissionState {
  /** The permission this state applies to. */
  permissionId: string;
  /** Whether the user has toggled this permission on. */
  enabled: boolean;
  /** Whether the org admin has granted the underlying Graph scope. */
  orgGranted: boolean;
}
