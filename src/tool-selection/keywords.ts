/**
 * Keyword routing, unioned with the embedding selection on every message.
 * EXCERPT: TOOL_GROUPS through selectToolsForMessage() from src/agent/tools.ts, and
 * unionKeywordTools() from src/agent/runner.ts, both verbatim.
 */
import type { ChatCompletionFunctionTool as ChatCompletionTool } from 'openai/resources/chat/completions.js';
import { toolDefinitions } from './catalogue.js';

interface ToolGroup {
  keywords: string[];
  toolNames: string[];
}

const TOOL_GROUPS: ToolGroup[] = [
  {
    keywords: [
      'email',
      'mail',
      'inbox',
      'send',
      'reply',
      'forward',
      'draft',
      'search mail',
      'find email',
      'category',
      'tag',
    ],
    toolNames: [
      'get_unread_mail',
      'search_mail',
      'list_mail_by_category',
      'send_mail',
      'reply_to_mail',
      'forward_mail',
      'update_mail_flags',
      'create_draft',
      'send_draft',
      'search_contacts',
    ],
  },
  {
    keywords: [
      'calendar',
      'meeting',
      'schedule',
      'free',
      'busy',
      'event',
      'invite',
      'cancel',
      'reschedule',
      'accept',
      'decline',
      'attending',
      'attendee',
      'attendees',
      // Time-of-day cues — frequently used to describe when to book
      'block',          // "block 30 min", "block my calendar"
      'morning',
      'afternoon',
      'evening',
      'noon',
    ],
    toolNames: [
      'get_calendar_events',
      'get_teams_channel_messages',
      'get_meeting_transcript',
      'create_event',
      'update_event',
      'delete_event',
      'respond_to_event',
      'find_meeting_times',
    ],
  },
  {
    keywords: [
      'task',
      'todo',
      'planner',
      'overdue',
      'assign',
      'create task',
      'add task',
      'complete task',
      'mark done',
    ],
    toolNames: [
      'list_todo_task_lists',
      'list_todo_tasks',
      'list_my_teams',
      'list_planner_plans',
      'list_planner_tasks',
      'create_todo_task',
      'update_todo_task',
      'delete_todo_task',
      'create_planner_task',
      'update_planner_task',
    ],
  },
  {
    keywords: [
      'file',
      'document',
      'sharepoint',
      'onedrive',
      'find file',
      'upload',
      'share link',
      'sharing',
      'version',
      'who has access',
      'permissions',
      'sites',
      'report',
      'read file',
      'open file',
      'contents of',
      'what does the',
      'summarize the',
      'create folder',
      'new folder',
      'move file',
      'rename file',
      'delete file',
    ],
    toolNames: [
      'get_sharepoint_files',
      'search_onedrive',
      'read_onedrive_file',
      'get_onedrive_item',
      'list_onedrive_children',
      'upload_file',
      'create_sharing_link',
      'list_sharepoint_sites',
      'get_file_versions',
      'get_file_permissions',
      'create_folder',
      'move_item',
      'rename_item',
      'delete_drive_item',
      'list_my_teams',
      'list_team_channels',
    ],
  },
  {
    keywords: [
      'attachment',
      'attached',
      'attached file',
      'image in email',
      'photo in email',
      'what did they attach',
      'teams image',
      'teams photo',
    ],
    toolNames: ['get_mail_attachments', 'read_attachment', 'read_teams_image'],
  },
  {
    keywords: [
      'excel',
      'spreadsheet',
      'workbook',
      'worksheet',
      'xlsx',
      'sheet',
      'cell',
      'cells',
      'column',
      'row in excel',
      'named range',
      'table in excel',
      'write to excel',
      'update excel',
      'add row',
      'formula',
    ],
    toolNames: [
      'list_excel_sheets',
      'read_excel_range',
      'read_excel_table',
      'read_excel_named_range',
      'write_excel_range',
      'add_excel_row',
    ],
  },
  {
    keywords: [
      'who',
      'contact',
      'presence',
      'available',
      'availability',
      'online',
      'status',
      'add contact',
      'email address',
      'phone',
      'phone number',
      'find a time',
      'schedule with',
    ],
    toolNames: [
      'list_contacts',
      'search_contacts',
      'get_relevant_people',
      'search_people',
      'get_user_presence',
      'get_free_busy',
      'create_contact',
      'update_contact',
    ],
  },
  {
    keywords: [
      'teams',
      'channel',
      'chat',
      'post',
      'message',
      'dm',
      'direct message',
      'conversation with',
      'group chat',
    ],
    toolNames: [
      'list_my_teams',
      'list_team_channels',
      'get_teams_channel_messages',
      'list_chats',
      'get_chat_messages',
      'send_teams_channel_message',
      'send_teams_chat_message',
      'save_automation',
      'list_automations',
    ],
  },
  {
    keywords: ['search', 'find', 'look for', 'where is', 'locate'],
    toolNames: ['search_across_m365', 'search_mail', 'search_onedrive'],
  },
  {
    keywords: ['briefing', 'morning', 'daily', 'catch up', 'start my day'],
    toolNames: ['generate_daily_briefing'],
  },
  {
    keywords: [
      'every monday',
      'every tuesday',
      'every wednesday',
      'every thursday',
      'every friday',
      'every saturday',
      'every sunday',
      'every morning',
      'every week',
      'every day',
      'pause that',
      'resume that',
      'pause my',
      'cancel that',
      'cancel my',
      'stop my',
      'run at',
      'scheduled task',
    ],
    toolNames: [
      'list_scheduled_tasks',
      'create_scheduled_task',
      'cancel_scheduled_task',
      'pause_scheduled_task',
      'resume_scheduled_task',
      'set_reminder',
    ],
  },
  {
    keywords: ['cost', 'usage', 'spending', 'token', 'how much', 'bill'],
    toolNames: ['get_usage_report'],
  },
  {
    keywords: ['remind', 'reminder', 'remind me', "don't forget", 'alert me'],
    toolNames: ['set_reminder'],
  },
  {
    keywords: [
      'automation',
      'what are you doing',
      'what do you do for me',
      'doing for me',
      'active tasks',
      'my automations',
      'scheduled',
      'webhooks',
      'reminders list',
      'everything you',
    ],
    toolNames: ['get_my_automations'],
  },
  {
    keywords: [
      'whenever',
      'every time',
      'each time',
      'when i get',
      'when a new',
      'when i receive',
      'automatically',
      'from now on',
      'going forward',
      'automation',
      'save automation',
      'cancel automation',
      'enable automation',
      'delete automation',
      'update automation',
      'modify automation',
      'turn off automation',
      'turn on automation',
      'list automations',
      'show my rules',
      'saved rules',
      'if-this',
      'ifttt',
      'reminder',
      'reminders',
      'remind me',
    ],
    toolNames: [
      'save_automation',
      'list_automations',
      'pause_automation',
      'enable_automation',
      'delete_automation',
      'update_automation',
      'create_scheduled_task',
      'set_reminder',
    ],
  },
  {
    keywords: [
      'settings',
      'permissions',
      'what can you do',
      'what are you allowed',
      'can you send',
      'capabilities',
      'access',
    ],
    toolNames: ['get_my_settings'],
  },
  {
    keywords: ['onenote', 'notebook', 'notebooks', 'notes', 'section', 'sections'],
    toolNames: [
      'list_onenote_notebooks',
      'list_onenote_sections',
      'list_onenote_pages',
      'get_onenote_page_content',
      // Also expose file tools — "notes" could be .txt files on OneDrive
      'search_onedrive',
      'read_onedrive_file',
      'list_onedrive_children',
    ],
  },
  {
    keywords: [
      'remember',
      'save that',
      'note that',
      'my preference',
      'always',
      "don't forget",
      'keep in mind',
      'prefer',
    ],
    toolNames: ['save_memory'],
  },
];

/** Keywords that indicate a broad request — send all tools. */
const BROAD_KEYWORDS = [
  'what do i need',
  'prep me',
  'catch me up',
  'what did i miss',
  'brief me',
  "what's going on",
  'summary of everything',
  'good morning',
  'start my day',
  'daily briefing',
];

/**
 * Analyze a user message and return only the relevant tool definitions.
 * If no specific group matches, or the message seems broad, returns all tools.
 */
export function selectToolsForMessage(message: string): ChatCompletionTool[] {
  const lower = message.toLowerCase();

  // Broad request → all tools
  if (BROAD_KEYWORDS.some((kw) => lower.includes(kw))) {
    return toolDefinitions;
  }

  // Collect matching tool names from all matching groups
  const matchedNames = new Set<string>();
  for (const group of TOOL_GROUPS) {
    if (group.keywords.some((kw) => lower.includes(kw))) {
      for (const name of group.toolNames) {
        matchedNames.add(name);
      }
    }
  }

  // No specific match → all tools
  if (matchedNames.size === 0) {
    return toolDefinitions;
  }

  // Always include send_message so the model can deliver mid-task updates.
  // save_memory is NOT always included — its keyword group covers explicit memory
  // requests. Always-including it causes the model to save preferences as a
  // fallback when the right tool isn't present, masking missing tool routing.
  const alwaysInclude = new Set(['send_message']);
  return toolDefinitions.filter(
    (td) => matchedNames.has(td.function.name) || alwaysInclude.has(td.function.name),
  );
}

/**
 * Union embedding-selected tools with keyword-matched tools so explicit keyword
 * hits (e.g. "settings" → get_my_settings) are never dropped. Only applies when
 * the keyword filter produced a focused set — if it returned the full catalog
 * (no group match, or broad keyword), skip the union to keep the selection small.
 */
export function unionKeywordTools(selected: ChatCompletionTool[], message: string): ChatCompletionTool[] {
  const keywordTools = selectToolsForMessage(message);
  if (keywordTools.length === toolDefinitions.length) return selected;
  const names = new Set(selected.map(t => t.function.name));
  return [...selected, ...keywordTools.filter(t => !names.has(t.function.name))];
}
