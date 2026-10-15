/**
 * Agent eval cases — EXCERPT: 13 of the 142 cases.
 *
 * Based on the seeded M365 dataset that eval/agent/fixtures.ts reproduces
 * offline:
 *   - 12 contacts (Alpha Ventures, Bridge Capital, Legacy Legal, etc.)
 *   - 10 calendar events (next 9 days)
 *   - 15 inbox emails (all unread)
 *   - 8 To Do tasks
 *   - Planner plan + tasks
 *
 * DO NOT edit expectedFacts / forbiddenFacts / formatReqs: the historical
 * 107-case and 142-case numbers were scored against them. Add new signal via
 * expectedTools / forbiddenTools, or flag a case `weak`, instead.
 */

/** A required tool: a name, or an array meaning "any one of these". */
export type ToolRequirement = string | readonly string[];

export type Split = 'dev' | 'heldout';

export interface EvalTest {
  id: string;
  category:
    | 'mail-read'
    | 'mail-write'
    | 'calendar-read'
    | 'calendar-write'
    | 'tasks'
    | 'contacts'
    | 'planner'
    | 'teams'
    | 'compound'
    | 'search'
    | 'meta'
    | 'quality'
    | 'automation';
  prompt: string;
  expectedFacts: string[];
  forbiddenFacts?: string[];
  formatReqs: {
    requireTable?: boolean;
    requireEmoji?: boolean;
    forbidFiller?: boolean;
    maxWords?: number;
  };
  difficulty: 'simple' | 'moderate' | 'complex';
  notes?: string;
  /** Tools the agent must call (each requirement met at least once). */
  expectedTools?: ToolRequirement[];
  /** Tools the agent must not call. */
  forbiddenTools?: string[];
  /**
   * The fact check carries little signal: 0–1 expected facts that are generic
   * or already in the prompt (mail-read-01 passes on the word "unread").
   * Reports show these separately; their tool assertions still count.
   */
  weak?: true;
  /**
   * expectedFacts are tool/trigger names (save_automation, new_mail, ...). The
   * scorer matches facts against the response TEXT, so these rarely pass the
   * historical rule; expectedTools/forbiddenTools carry the real signal.
   */
  factsNameTools?: true;
  /** 'heldout' = must not be tuned against. Absent = 'dev'. */
  split?: Split;
}

// Any-of groups for expectedTools.
const READ_MAIL = ['get_unread_mail', 'search_mail'] as const;
const TOPIC_SEARCH = ['search_mail', 'get_unread_mail', 'search_across_m365'] as const;
const FIND_CONTACT = ['list_contacts', 'search_contacts', 'search_people'] as const;
const LIST_AUTOMATIONS = ['list_automations', 'get_my_automations'] as const;
const STOP_AUTOMATION = ['pause_automation', 'delete_automation'] as const;
const SEND_TOOLS = ['send_mail', 'reply_to_mail', 'forward_mail', 'send_draft'];

// Held-out split (2026-10): 30 cases spanning every category carry
// `split: 'heldout'`. DO NOT tune prompts, routing or tools against them —
// iterate on the dev split and run heldout only to check that a change
// generalises. They were seen during the original Mar–Apr 2026 tuning, so they
// are held out from now on, not unseen.
export const EVAL_TESTS: EvalTest[] = [
  {
    id: 'mail-read-01',
    category: 'mail-read',
    prompt: 'How many unread emails do I have?',
    expectedFacts: ['unread'],
    formatReqs: { forbidFiller: true, maxWords: 80 },
    expectedTools: [READ_MAIL],
    weak: true,
    difficulty: 'simple',
    notes: 'Baseline: should report unread count from inbox.',
  },
  {
    id: 'mail-read-03',
    category: 'mail-read',
    prompt: 'Show me the email from James O\'Brien.',
    expectedFacts: ['contract', 'redlines', 'friday', 'april 1'],
    formatReqs: { forbidFiller: true },
    expectedTools: [READ_MAIL],
    difficulty: 'simple',
    notes: 'Fetch specific email by sender — contract deadline fact.',
  },
  {
    id: 'mail-read-04',
    category: 'mail-read',
    prompt: 'What did Derek Osei email me about?',
    expectedFacts: ['meridian', 'harlow', 'beacon', 'sign'],
    formatReqs: { forbidFiller: true, maxWords: 200 },
    expectedTools: [READ_MAIL],
    split: 'heldout',
    difficulty: 'simple',
    notes: 'Three deals needing sign-off. Changed "signature" → "sign" to match both "sign-off" and "signature".',
  },
  {
    id: 'contacts-02',
    category: 'contacts',
    prompt: 'Find all contacts at Alpha Ventures.',
    expectedFacts: ['sarah chen', 'marcus webb', 'priya kapoor', 'derek osei', 'lena johansson'],
    formatReqs: { forbidFiller: true },
    expectedTools: [FIND_CONTACT],
    difficulty: 'simple',
    notes: 'Five Alpha Ventures contacts.',
  },
  {
    id: 'compound-05',
    category: 'compound',
    prompt: 'Derek Osei mentioned three deals — Meridian, Harlow, and Beacon. Create tasks to review each one.',
    expectedFacts: ['meridian', 'harlow', 'beacon', 'created'],
    formatReqs: { forbidFiller: true },
    expectedTools: [['create_todo_task', 'create_planner_task']],
    split: 'heldout',
    difficulty: 'moderate',
    notes: 'Create three tasks from email context.',
  },
  {
    id: 'quality-01',
    category: 'quality',
    prompt: 'What\'s the difference between you drafting an email versus sending it?',
    expectedFacts: ['draft', 'send', 'confirm'],
    formatReqs: { forbidFiller: true, maxWords: 100 },
    difficulty: 'simple',
    notes: 'No tools. Tests self-awareness about draft vs send behavior. Should be concise.',
  },
  {
    id: 'quality-04',
    category: 'quality',
    prompt: 'List my contacts at Alpha Ventures.',
    expectedFacts: ['sarah chen', 'marcus webb', 'derek osei'],
    formatReqs: { requireTable: true, forbidFiller: true },
    expectedTools: [FIND_CONTACT],
    difficulty: 'simple',
    notes: 'Contacts filter by company. Should table only Alpha Ventures contacts.',
  },
  {
    id: 'quality-09',
    category: 'quality',
    prompt: 'What\'s my busiest day this week?',
    expectedFacts: [],
    formatReqs: { forbidFiller: true, maxWords: 60 },
    expectedTools: ['get_calendar_events'],
    weak: true,
    difficulty: 'simple',
    notes: 'Calendar analysis. Should name a specific day and say why. No filler.',
  },
  {
    id: 'quality-12',
    category: 'quality',
    prompt: 'Show me all my open tasks in a table.',
    expectedFacts: ['docusign', 'postmortem'],
    formatReqs: { requireTable: true, requireEmoji: true, forbidFiller: true },
    expectedTools: ['list_todo_tasks'],
    difficulty: 'simple',
    notes: 'Tasks table. ✅ emoji, due dates, no filler ending.',
  },
  {
    id: 'quality-15',
    category: 'quality',
    prompt: 'Draft an email to Tom Nakamura saying I\'ll review his investor deck by Thursday.',
    expectedFacts: ['tom nakamura', 'thursday', 'investor deck'],
    forbiddenFacts: ['email sent', 'sent successfully', 'i have sent'],
    formatReqs: { forbidFiller: true },
    forbiddenTools: [...SEND_TOOLS],
    difficulty: 'simple',
    notes: 'Must show draft and confirm before sending. Must NOT send. Escalates to the large model.',
  },
  {
    id: 'automation-03',
    category: 'automation',
    prompt: 'Every time I get a new email, send me a brief summary in this chat.',
    expectedFacts: ['automation', 'email', 'summary'],
    formatReqs: { forbidFiller: true },
    expectedTools: ['save_automation'],
    split: 'heldout',
    difficulty: 'moderate',
    notes: 'IFTTT: save_automation with trigger_type=new_email. Confirm back with rule name + trigger.',
  },
  {
    id: 'automation-37',
    category: 'automation',
    prompt: "Stop all my automations and reminders — I need a clean slate.",
    expectedFacts: ['list_automations', 'cancel_automation'],
    forbiddenFacts: ['save_automation'],
    formatReqs: { forbidFiller: true },
    expectedTools: [LIST_AUTOMATIONS, STOP_AUTOMATION],
    forbiddenTools: ['save_automation'],
    factsNameTools: true,
    difficulty: 'moderate',
    notes: 'Cancel-all lifecycle test. Should list_automations first, then call cancel_automation for each active rule. Should also address pending reminders. Tests the "cancel all" pattern.',
  },
  {
    id: 'automation-40',
    category: 'automation',
    prompt: "Show me the emails I got this morning.",
    expectedFacts: ['get_unread_mail', 'search_mail'],
    forbiddenFacts: ['save_automation', 'set_reminder'],
    formatReqs: { forbidFiller: true },
    expectedTools: [READ_MAIL],
    forbiddenTools: ['save_automation', 'set_reminder', 'create_scheduled_task'],
    factsNameTools: true,
    difficulty: 'simple',
    notes: 'NEGATIVE TEST — this is a data query, not an automation request. MC must NOT save an automation. Should call get_unread_mail or search_mail and return the results directly.',
  },
];

// [excerpt: 129 further cases omitted]

export function getTestById(id: string): EvalTest | undefined {
  return EVAL_TESTS.find((t) => t.id === id);
}
