/**
 * Permission registry — defines all permissions the system supports.
 *
 * Each permission maps to Graph scopes and the tool names it gates.
 * Grouped by category (Email, Calendar, Tasks, Files, etc.).
 */

import type { Permission } from './types.js';

// -------------------------------------------------------------------------
// Permission definitions
// -------------------------------------------------------------------------

const PERMISSIONS: Permission[] = [
  // --- Email ---
  {
    id: 'mail.read',
    label: 'Read email',
    description: 'View your inbox, search emails, and read message contents',
    category: 'Email',
    graphScopes: ['Mail.Read'],
    toolNames: ['get_unread_mail', 'search_mail', 'list_mail_by_category', 'get_mail_attachments', 'read_attachment'],
    isWrite: false,
  },
  {
    id: 'mail.write',
    label: 'Send and manage email',
    description: 'Send new emails and saved drafts, reply, forward, and update read/flag status',
    category: 'Email',
    graphScopes: ['Mail.ReadWrite', 'Mail.Send'],
    toolNames: [
      'send_mail',
      'reply_to_mail',
      'forward_mail',
      'update_mail_flags',
      'send_draft',
    ],
    isWrite: true,
  },
  {
    id: 'drafts.write',
    label: 'Draft email',
    description: 'Save emails and replies to your Drafts folder for you to review. Never sends.',
    category: 'Email',
    graphScopes: ['Mail.ReadWrite'],
    toolNames: ['create_draft'],
    isWrite: true,
  },

  // --- Calendar ---
  {
    id: 'calendar.read',
    label: 'Read calendar',
    description: 'View your calendar events and find available meeting times',
    category: 'Calendar',
    graphScopes: ['Calendars.Read'],
    toolNames: ['get_calendar_events', 'find_meeting_times', 'get_free_busy'],
    isWrite: false,
  },
  {
    id: 'calendar.write',
    label: 'Manage calendar',
    description: 'Create, update, delete, and respond to calendar events',
    category: 'Calendar',
    graphScopes: ['Calendars.ReadWrite'],
    toolNames: [
      'create_event',
      'update_event',
      'delete_event',
      'respond_to_event',
    ],
    isWrite: true,
  },

  // --- Teams ---
  {
    id: 'teams.read',
    label: 'Read Teams messages',
    description: 'Read messages from Teams channels and chats',
    category: 'Teams',
    graphScopes: ['ChannelMessage.Read.All', 'Chat.ReadWrite'],
    toolNames: ['get_teams_channel_messages', 'list_my_teams', 'list_team_channels', 'list_chats', 'get_chat_messages'],
    isWrite: false,
  },
  {
    id: 'teams.write',
    label: 'Send Teams messages',
    description: 'Send messages to Teams channels and chats',
    category: 'Teams',
    graphScopes: ['ChannelMessage.Send', 'Chat.ReadWrite'],
    toolNames: ['send_teams_channel_message', 'send_teams_chat_message'],
    isWrite: true,
  },

  // --- Tasks (To Do + Planner) ---
  {
    id: 'tasks.read',
    label: 'Read tasks',
    description:
      'View your To Do task lists, tasks, Planner plans, and Planner tasks',
    category: 'Tasks',
    graphScopes: ['Tasks.Read'],
    toolNames: [
      'list_todo_task_lists',
      'list_todo_tasks',
      'list_planner_plans',
      'list_planner_tasks',
    ],
    isWrite: false,
  },
  {
    id: 'tasks.write',
    label: 'Manage tasks',
    description: 'Create, update, and delete To Do tasks and Planner tasks',
    category: 'Tasks',
    graphScopes: ['Tasks.ReadWrite'],
    toolNames: [
      'create_todo_task',
      'update_todo_task',
      'delete_todo_task',
      'create_planner_plan',
      'create_planner_task',
      'update_planner_task',
    ],
    isWrite: true,
  },

  // --- Files (OneDrive + Excel) ---
  {
    id: 'files.read',
    label: 'Read files & Excel',
    description:
      'Search OneDrive, view file contents, read Excel workbooks, version history, and sharing permissions',
    category: 'Files',
    graphScopes: ['Files.Read'],
    toolNames: [
      'search_onedrive',
      'read_onedrive_file',
      'get_onedrive_item',
      'list_onedrive_children',
      'get_file_versions',
      'get_file_permissions',
      'list_excel_sheets',
      'read_excel_range',
      'read_excel_table',
      'read_excel_named_range',
    ],
    isWrite: false,
  },
  {
    id: 'files.write',
    label: 'Manage files & Excel',
    description: 'Upload files, create sharing links, manage folders, move, rename, delete, and write to Excel workbooks',
    category: 'Files',
    graphScopes: ['Files.ReadWrite'],
    toolNames: [
      'upload_file',
      'create_sharing_link',
      'create_folder',
      'move_item',
      'rename_item',
      'delete_drive_item',
      'read_teams_image',
      'write_excel_range',
      'add_excel_row',
    ],
    isWrite: true,
  },

  // --- SharePoint ---
  {
    id: 'sharepoint.read',
    label: 'Read SharePoint',
    description: 'Browse SharePoint sites and document libraries, list files and folders, and view file metadata including version history and sharing permissions.',
    category: 'SharePoint',
    graphScopes: ['Sites.Read.All'],
    toolNames: ['get_sharepoint_files', 'list_sharepoint_sites'],
    isWrite: false,
  },

  // --- People & Contacts ---
  {
    id: 'contacts.read',
    label: 'Read people & contacts',
    description: 'Search your Outlook contacts, find relevant people in your org directory, and check colleague availability',
    category: 'People & Contacts',
    graphScopes: ['Contacts.Read', 'People.Read', 'User.ReadBasic.All', 'Presence.Read'],
    toolNames: ['list_contacts', 'search_contacts', 'get_relevant_people', 'search_people', 'get_user_presence'],
    isWrite: false,
  },
  {
    id: 'contacts.write',
    label: 'Manage contacts',
    description: 'Create and update contacts in your Outlook address book',
    category: 'People & Contacts',
    graphScopes: ['Contacts.ReadWrite'],
    toolNames: ['create_contact', 'update_contact'],
    isWrite: true,
  },

  // --- OneNote ---
  {
    id: 'onenote.read',
    label: 'Read OneNote',
    description: 'Browse notebooks, sections, and pages, and read page content',
    category: 'OneNote',
    graphScopes: ['Notes.Read'],
    toolNames: [
      'list_onenote_notebooks',
      'list_onenote_sections',
      'list_onenote_pages',
      'get_onenote_page_content',
    ],
    isWrite: false,
  },

  // --- Meetings ---
  {
    id: 'meetings.read',
    label: 'Read meeting transcripts',
    description: 'Access transcripts from recorded meetings',
    category: 'Meetings',
    // Both scopes are required: OnlineMeetings.Read resolves the onlineMeeting
    // id from the event's joinUrl, OnlineMeetingTranscript.Read.All reads the
    // transcript once resolved.
    graphScopes: ['OnlineMeetings.Read', 'OnlineMeetingTranscript.Read.All'],
    toolNames: ['get_meeting_transcript'],
    isWrite: false,
  },

];

// -------------------------------------------------------------------------
// Lookup indexes (built once at import time)
// -------------------------------------------------------------------------

const byId = new Map<string, Permission>();
const byToolName = new Map<string, Permission>();
const byCategory = new Map<string, Permission[]>();

for (const perm of PERMISSIONS) {
  byId.set(perm.id, perm);

  for (const toolName of perm.toolNames) {
    byToolName.set(toolName, perm);
  }

  const existing = byCategory.get(perm.category) ?? [];
  existing.push(perm);
  byCategory.set(perm.category, existing);
}

// -------------------------------------------------------------------------
// Public API
// -------------------------------------------------------------------------

/** Get all defined permissions. */
export function getAllPermissions(): Permission[] {
  return [...PERMISSIONS];
}

/** Get a single permission by its ID. Returns undefined if not found. */
export function getPermissionById(id: string): Permission | undefined {
  return byId.get(id);
}

/** Get all permissions in a category. */
export function getPermissionsByCategory(category: string): Permission[] {
  return byCategory.get(category) ?? [];
}

/** Get all unique category names. */
export function getAllCategories(): string[] {
  return [...byCategory.keys()];
}

/**
 * Get the permission that gates a given tool.
 * Returns undefined if the tool is not gated by any permission
 * (e.g. search_across_m365 which spans multiple categories).
 */
export function getToolPermission(toolName: string): Permission | undefined {
  return byToolName.get(toolName);
}
