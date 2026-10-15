import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the db module
vi.mock('../db.js', () => ({
  getUserToggles: vi.fn().mockResolvedValue([]),
  getOrgPermission: vi.fn().mockResolvedValue(undefined), // default: no admin override
}));

// Mock the registry module
vi.mock('./registry.js', () => ({
  getToolPermission: vi.fn(),
  getPermissionById: vi.fn(),
}));

// Mock the Graph client accessor (used by the scope check). Default: no client
// (scope check no-ops → allowed), matching the other tests.
vi.mock('../graph/client.js', () => ({
  getGraphClient: vi.fn(() => null),
}));

import { checkPermission, checkPermissionById } from './check.js';
import { getUserToggles } from '../db.js';
import { getToolPermission, getPermissionById } from './registry.js';
import { getGraphClient } from '../graph/client.js';

const mockedGetGraphClient = vi.mocked(getGraphClient);

const mockedGetToolPermission = vi.mocked(getToolPermission);
const mockedGetPermissionById = vi.mocked(getPermissionById);
const mockedGetUserToggles = vi.mocked(getUserToggles);

beforeEach(async () => {
  vi.clearAllMocks();
  mockedGetUserToggles.mockResolvedValue([]);
  mockedGetGraphClient.mockReturnValue(null as any);
});

describe('checkPermission', () => {
  it('allows execution for tools with no permission mapping (ungated)', async () => {
    // getToolPermission is sync and returns Permission | undefined.
    // Original test used mockResolvedValue which wraps in a Promise —
    // that breaks production code expecting a sync return.
    mockedGetToolPermission.mockReturnValue(undefined);

    const result = await checkPermission('user-1', 'some_ungated_tool');
    expect(result.allowed).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('denies execution when user has zero permission rows — fail-closed', async () => {
    // A user with NO toggle rows is denied for every
    // gated tool, with a message telling them to sign out and back in
    // (which re-runs initDefaultToggles to seed the baseline). This
    // surfaces silent initDefaultToggles failures instead of hiding them
    // behind the old 'read = allowed' fallback.
    mockedGetToolPermission.mockReturnValue({
      id: 'mail.read',
      label: 'Read email',
      description: 'View your inbox',
      category: 'Email',
      graphScopes: ['Mail.Read'],
      toolNames: ['get_unread_mail'],
      isWrite: false,
    });

    const result = await checkPermission('new-user', 'get_unread_mail');
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/couldn't load your permission settings/i);
  });

  it('denies execution when row exists for other perms but not this one', async () => {
    // A user with SOME rows but not one for the requested permission
    // (e.g., permission added to the registry post-sign-in) defaults to
    // off — opt-in, not opt-out. They can enable in Settings.
    mockedGetToolPermission.mockReturnValue({
      id: 'mail.write',
      label: 'Send and manage email',
      description: 'Send new emails',
      category: 'Email',
      graphScopes: ['Mail.ReadWrite', 'Mail.Send'],
      toolNames: ['send_mail'],
      isWrite: true,
    });
    // Seed a row for a DIFFERENT permission so toggles.length > 0
    mockedGetUserToggles.mockResolvedValue([
      { user_id: 'new-user', permission_id: 'mail.read', enabled: 1 },
    ]);

    const result = await checkPermission('new-user', 'send_mail');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('turned off');
  });

  it('blocks execution when user has explicitly toggled off a permission', async () => {
    mockedGetToolPermission.mockReturnValue({
      id: 'mail.read',
      label: 'Read email',
      description: 'View your inbox',
      category: 'Email',
      graphScopes: ['Mail.Read'],
      toolNames: ['get_unread_mail'],
      isWrite: false,
    });
    mockedGetUserToggles.mockResolvedValue([
      { user_id: 'user-1', permission_id: 'mail.read', enabled: 0 },
    ]);

    const result = await checkPermission('user-1', 'get_unread_mail');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('turned off');
  });

  it('allows execution when user has explicitly toggled on a write permission', async () => {
    mockedGetToolPermission.mockReturnValue({
      id: 'mail.write',
      label: 'Send and manage email',
      description: 'Send new emails',
      category: 'Email',
      graphScopes: ['Mail.ReadWrite', 'Mail.Send'],
      toolNames: ['send_mail'],
      isWrite: true,
    });
    mockedGetUserToggles.mockResolvedValue([
      { user_id: 'user-1', permission_id: 'mail.write', enabled: 1 },
    ]);

    const result = await checkPermission('user-1', 'send_mail');
    expect(result.allowed).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('denies when called with empty userId — fail-closed', async () => {
    // An empty userId used to fall through the 'default' lookup + the
    // hardcoded read-allowed baseline and return allowed. Now the user has
    // no toggle rows and gets denied. Callers (executeTool in
    // tools.ts) that legitimately need to bypass permission checks for
    // anonymous/system actors must do so at the call site by not invoking
    // checkPermission, not by relying on this function to default-allow.
    mockedGetToolPermission.mockReturnValue({
      id: 'mail.read',
      label: 'Read email',
      description: 'View your inbox',
      category: 'Email',
      graphScopes: ['Mail.Read'],
      toolNames: ['get_unread_mail'],
      isWrite: false,
    });

    const result = await checkPermission('', 'get_unread_mail');
    expect(result.allowed).toBe(false);
  });
});

// Found in certification review: search_across_m365 gates each resource type on its read permission
// via checkPermissionById (the tool spans categories, so it can't map to one
// permission in the registry).
describe('checkPermissionById', () => {
  const teamsRead = {
    id: 'teams.read',
    label: 'Read Teams messages',
    description: 'Read messages from Teams channels and chats',
    category: 'Teams',
    graphScopes: [] as string[],
    toolNames: ['get_chat_messages'],
    isWrite: false,
  };

  it('denies when the mapped permission toggle is OFF (the cross-category bypass)', async () => {
    mockedGetPermissionById.mockReturnValue(teamsRead);
    mockedGetUserToggles.mockResolvedValue([
      { user_id: 'user-1', permission_id: 'teams.read', enabled: 0 },
    ]);
    const result = await checkPermissionById('user-1', 'teams.read');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('turned off');
  });

  it('allows when the mapped permission toggle is ON', async () => {
    mockedGetPermissionById.mockReturnValue(teamsRead);
    mockedGetUserToggles.mockResolvedValue([
      { user_id: 'user-1', permission_id: 'teams.read', enabled: 1 },
    ]);
    const result = await checkPermissionById('user-1', 'teams.read');
    expect(result.allowed).toBe(true);
  });

  it('allows when the permission id is unknown (no gate)', async () => {
    mockedGetPermissionById.mockReturnValue(undefined);
    const result = await checkPermissionById('user-1', 'nonexistent.perm');
    expect(result.allowed).toBe(true);
  });
});

// Found in certification review: the scope check must read the CHECKED user's granted scopes, not
// getGraphClient()'s first-user fallback — else a user with all toggles on gets
// a false "requires admin approval" denial (e.g. transcript).
describe('scope check resolves the checked user', () => {
  const meetingsRead = {
    id: 'meetings.read',
    label: 'Read meeting transcripts',
    description: 'Access transcripts',
    category: 'Meetings',
    graphScopes: ['OnlineMeetingTranscript.Read.All'],
    toolNames: ['get_meeting_transcript'],
    isWrite: false,
  };

  beforeEach(() => {
    mockedGetToolPermission.mockReturnValue(meetingsRead);
    mockedGetUserToggles.mockResolvedValue([
      { user_id: 'reviewer', permission_id: 'meetings.read', enabled: 1 },
    ]);
  });

  it("uses getGraphClient(userId) — not the no-arg first-user client", async () => {
    mockedGetGraphClient.mockReturnValue({
      getGrantedScopes: () => ['OnlineMeetingTranscript.Read.All'],
    } as any);
    await checkPermission('reviewer', 'get_meeting_transcript');
    expect(mockedGetGraphClient).toHaveBeenCalledWith('reviewer');
  });

  it('allows when the CHECKED user has the scope', async () => {
    mockedGetGraphClient.mockReturnValue({
      getGrantedScopes: () => ['OnlineMeetingTranscript.Read.All'],
    } as any);
    const r = await checkPermission('reviewer', 'get_meeting_transcript');
    expect(r.allowed).toBe(true);
  });

  it('denies (admin approval) only when the CHECKED user truly lacks the scope', async () => {
    mockedGetGraphClient.mockReturnValue({
      getGrantedScopes: () => ['Mail.Read'], // has some scopes, not the transcript one
    } as any);
    const r = await checkPermission('reviewer', 'get_meeting_transcript');
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('admin approval');
  });
});
