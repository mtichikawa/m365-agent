// EXCERPT of src/agent/runner.ts — read-only, does not compile standalone.
/**
 * Azure OpenAI agent runner.
 *
 * Runs the model in-process via the OpenAI SDK's function-calling interface.
 * Two Azure OpenAI deployments: a small model by default and a larger one for
 * complex work. Their names (AZURE_OPENAI_DEPLOYMENT / _MINI) are historical
 * and don't say which model is served; see pricing.ts.
 *
 * Agent loop:
 *   message → model → tool_calls? → execute tools → loop → response
 *
 * Cost optimizations:
 *   - Smart model routing: the small model for simple messages, the large one for complex
 *   - Smart tool selection: only send relevant tool definitions per message
 *   - Token tracking: log usage and estimated cost to the token_usage table
 *
 * Tools (Graph API, etc.) are defined in src/agent/tools.ts.
 */

import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { AzureOpenAI } from 'openai';
import { setVisionClient } from './vision.js';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions.js';
import type { CompletionUsage } from 'openai/resources/completions.js';

import { ASSISTANT_NAME } from '../config.js';
import { logger } from '../logger.js';
import { buildSystemPrompt } from './systemPrompt.js';
import { priceFor, tokenCostUsd } from './pricing.js';
import { logTokenUsage, logToolSelection, getAllMemoryEmbeddings } from '../db.js';
// [excerpt: billing import omitted]
import type { ToolCallSummary } from '../types.js';
import { selectToolsByEmbedding, embedSingleText, selectMemoriesForMessage, embeddingsReady } from './embeddings.js';
import { tools, toolDefinitions, executeTool, selectToolsForMessage } from './tools.js';
// openai 6 made ChatCompletionTool and ChatCompletionMessageToolCall unions
// (function | custom). Microclaw only uses function-type tools and function
// tool-calls, so narrow both at the alias.
import type {
  ChatCompletionFunctionTool as ChatCompletionTool,
  ChatCompletionMessageFunctionToolCall as ChatCompletionMessageToolCall,
} from 'openai/resources/chat/completions.js';

const OPENAI_TIMEOUT_MS = 120_000; // 2 minute timeout per API call

// Azure OpenAI throttling tracker. Each 429 increments a counter
// keyed by deployment; a once-per-minute reporter flushes the counts
// into the log so capacity-shortfall events are visible (and grep-able
// for downstream alerting). Stays in-process — no external metric
// service needed for launch.
const _rateLimitHits: Map<string, { count: number; lastRetryAfter: number }> = new Map();
let _rateLimitReporter: ReturnType<typeof setInterval> | null = null;

function recordRateLimitHit(deployment: string, retryAfterSec: number): void {
  const prev = _rateLimitHits.get(deployment) ?? { count: 0, lastRetryAfter: 0 };
  prev.count += 1;
  prev.lastRetryAfter = retryAfterSec;
  _rateLimitHits.set(deployment, prev);

  // Lazy-start the periodic reporter so dev / unit-test runs that never
  // hit a 429 don't spawn a 1-minute interval timer.
  if (!_rateLimitReporter) {
    _rateLimitReporter = setInterval(() => {
      if (_rateLimitHits.size === 0) return;
      const summary: Record<string, { count: number; lastRetryAfter: number }> = {};
      for (const [k, v] of _rateLimitHits) summary[k] = v;
      logger.warn(
        { rateLimits: summary },
        'Azure OpenAI 429 throttling — increase deployment capacity if non-zero recurs',
      );
      _rateLimitHits.clear();
    }, 60_000);
    _rateLimitReporter.unref?.();
  }
}

// Module-level singleton — created once on first call, reused for all subsequent requests.
let _openaiClient: AzureOpenAI | null = null;
function getOpenAIClient(): AzureOpenAI {
  if (!_openaiClient) {
    const endpoint = process.env.AZURE_OPENAI_ENDPOINT!;
    const apiKey = process.env.AZURE_OPENAI_API_KEY!;
    _openaiClient = new AzureOpenAI({ endpoint, apiKey, apiVersion: '2024-10-21', timeout: OPENAI_TIMEOUT_MS });
  }
  return _openaiClient;
}

/** Maximum total tool calls allowed in a single agent turn. Prevents runaway billing. */
const MAX_TOOL_CALLS_PER_TURN = 35;

// Bounded 429 retry loop (found in Teams Store certification review). Under sustained Azure OpenAI
// throttling the loop used to retry forever, hanging the bot with no reply (a
// reviewer's "reschedule the meeting" hung ~3h). Counts CONSECUTIVE rate-limit
// hits (reset on any successful completion), giving up after either bound so a
// genuinely-progressing agentic run is never cut short. On give-up we return a
// graceful user-facing message instead of looping or throwing.
const MAX_CONSECUTIVE_RATE_LIMIT_RETRIES = 4;
const RATE_LIMIT_TOTAL_WAIT_BUDGET_MS = 90_000;

// ---------------------------------------------------------------------------
// Tool call summary helpers for history compression
// ---------------------------------------------------------------------------

/** Param fields that are too large to include in key params (email body, etc.) */
const LARGE_PARAM_FIELDS = new Set([
  'body', 'content', 'html_content', 'text', 'message', 'description',
  'note', 'comment', 'summary', 'instructions',
]);

/**
 * Extract key parameters from a tool call for history compression.
 * Skips large text fields; truncates remaining string values to 80 chars.
 */
function extractKeyParams(args: Record<string, any>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(args)) {
    if (LARGE_PARAM_FIELDS.has(k)) continue;
    if (typeof v === 'string') {
      out[k] = v.length > 80 ? v.slice(0, 77) + '…' : v;
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      out[k] = v;
    }
    // skip arrays/objects (e.g. attendees list) — too verbose
  }
  return out;
}

/**
 * Summarize a tool result JSON string into a brief description.
 * Used for history compression so compressed turns stay informative.
 */
function summarizeToolResult(rawJson: string): string {
  try {
    const parsed = JSON.parse(rawJson);
    if (typeof parsed === 'string') return parsed.slice(0, 120);
    if (Array.isArray(parsed)) return `${parsed.length} item${parsed.length !== 1 ? 's' : ''}`;
    if (parsed && typeof parsed === 'object') {
      if (parsed.success === false && parsed.error) return `Error: ${String(parsed.error).slice(0, 80)}`;
      if (parsed.success === true && parsed.message) return String(parsed.message).slice(0, 100);
      // Count arrays in response (emails, events, tasks, files, etc.)
      for (const [k, v] of Object.entries(parsed)) {
        if (Array.isArray(v) && v.length > 0) return `${v.length} ${k}`;
      }
      // Fallback: first string value
      for (const v of Object.values(parsed)) {
        if (typeof v === 'string' && v.length > 0) return v.slice(0, 100);
      }
    }
  } catch {
    // rawJson might be a plain string
    return rawJson.slice(0, 100);
  }
  return 'completed';
}

/** Strip <internal>...</internal> reasoning blocks before sending to user. */
function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

// [excerpt: per-user memory file loading (memoriesDir, loadMemoriesForMessage) omitted]

/** Threshold for considering a message "long" (routes to the large model). */
const COMPLEXITY_LENGTH_THRESHOLD = 200;

/** Keywords that suggest multi-step work (route to the large model). */
const COMPLEXITY_KEYWORDS = [
  'schedule',
  'prep me',
  'summarize all',
  'find everything',
  'analyze',
  'compare',
  'draft',
  'plan',
];

/** Tool call count in a single turn that triggers mid-conversation escalation. */
const TOOL_ESCALATION_THRESHOLD = 3;

export interface AgentInput {
  chatJid: string;
  userMessage: string;
  senderName: string;
  groupName: string;
  history?: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  /** Optional user ID for permission checks. If provided, tool execution
   *  will verify the user has toggled on the required permission. */
  userId?: string;
  /**
   * Microsoft Azure AD tenant ID for the sender's org. Passed through from the
   * Teams activity. Used to route DB operations and file paths to the correct
   * tenant-isolated store. Defaults to 'default' when not set (self-hosted).
   */
  tenantId?: string;
  /** Optional callback to send a partial message to the user mid-task. */
  onPartialMessage?: (text: string) => Promise<void>;
  /**
   * Optional callback invoked immediately after each write tool completes.
   * Receives the tool name and raw JSON result. Used by the automation runner
   * to register created resource IDs before the next event loop tick, preventing
   * the race condition where a Graph change-notification webhook arrives before
   * the full run completes and the IDs are registered in the exclusion set.
   */
  onToolResult?: (toolName: string, rawJson: string) => void;
  /**
   * Optional callback invoked BEFORE each tool runs, with the parsed args.
   * Used by automation runner to pre-register resource IDs for update_/delete_/
   * send_ tools — the args already carry the IDs and Graph webhook latency
   * (1-3 sec) can outrun a tool execution + post-run registration. Pre-
   * registration closes that timing window for known-ID mutations.
   */
  onPreToolCall?: (toolName: string, args: Record<string, any>) => void;
  /**
   * Replaces executeTool for this run. Production callers leave it unset; the
   * offline eval (eval/agent/replay.ts) passes a fixture executor so Microsoft
   * Graph is never called and write tools are recorded, not executed.
   */
  toolExecutor?: typeof executeTool;
  /**
   * Optional observer for each step of the turn (selection, model calls,
   * permission checks, tool calls). Production leaves it unset; the demo
   * console (demo/console-server.ts) renders it as a live trace.
   */
  onTrace?: (event: TraceEvent) => void;
  /** Clock for the system prompt's "current date and time". Defaults to now; the offline eval pins it to its dataset's date. */
  now?: Date;
  /**
   * Send every tool definition, skipping selection. Production leaves it unset;
   * the offline eval uses it as the unfiltered reference run.
   */
  allTools?: boolean;
  /** Internal: set to true on retry-with-all-tools pass to prevent infinite recursion. */
  _retrying?: boolean;
  /** Internal: usage from the filtered pass, carried into the retry so totals stay complete. */
  _priorUsage?: Record<string, ModelUsage>;
}

/** One observable step of a turn, reported through AgentInput.onTrace. */
export type TraceEvent =
  | { type: 'model'; deployment: string; reason: string }
  | {
      type: 'selection';
      method: 'embedding' | 'keyword' | 'all';
      offered: string[];
      total: number;
      /** Tools added by the automation-intent classifier. */
      automationAdded: string[];
    }
  | {
      type: 'completion';
      deployment: string;
      promptTokens: number;
      cachedTokens: number;
      completionTokens: number;
      ms: number;
      toolCalls: number;
    }
  | { type: 'escalation'; from: string; to: string; reason: string }
  | { type: 'permission'; tool: string; allowed: boolean; reason?: string }
  | { type: 'tool'; tool: string; args: Record<string, any>; result: string; ms: number }
  | { type: 'retry'; reason: string };

/** Data returned by a tool execution, kept alongside the text response. */
export interface ToolResultData {
  toolName: string;
  /** The raw JSON string returned by the tool (may be a JSON array/object). */
  rawJson: string;
  /** Arguments the tool was called with — used by loop prevention to track
   *  IDs of mutated resources (e.g. update_mail_flags' message_id). */
  args?: Record<string, any>;
}

/** Token usage for one deployment across every model call in a run. */
export interface ModelUsage {
  calls: number;
  promptTokens: number;
  /** Prompt tokens served from Azure's prompt cache (billed at a discount). */
  cachedTokens: number;
  completionTokens: number;
}

/** Add one completion's usage to the per-deployment totals. */
function addUsage(
  totals: Record<string, ModelUsage>,
  deployment: string,
  usage: CompletionUsage | undefined,
): void {
  if (!usage) return;
  const u = (totals[deployment] ??= { calls: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0 });
  u.calls++;
  u.promptTokens += usage.prompt_tokens ?? 0;
  u.cachedTokens += usage.prompt_tokens_details?.cached_tokens ?? 0;
  u.completionTokens += usage.completion_tokens ?? 0;
}

export interface AgentOutput {
  response: string;
  toolsUsed: string[];
  /** Structured data from tool results, if any tools returned JSON data. */
  toolResults?: ToolResultData[];
  /** Structured tool call log for history compression — stored alongside bot message. */
  toolCallLog?: ToolCallSummary[];
  latencyMs?: number;
  toolCallsCount?: number;
  totalCostUsd?: number;
  tokensIn?: number;
  tokensOut?: number;
  modelUsed?: string;
  /** Per-deployment usage, including any first pass before retry-with-all-tools. */
  usageByModel?: Record<string, ModelUsage>;
  /** Tools sent on the final model call. */
  toolsOffered?: number;
  /** The filtered pass gave up and the turn re-ran with every tool. */
  retriedWithAllTools?: boolean;
}

// -------------------------------------------------------------------------
// Smart model routing
// -------------------------------------------------------------------------

export interface ModelSelection {
  deployment: string;
  reason: string;
}

/**
 * Choose between the small and large deployments based on message complexity.
 * Defaults to the small one; escalates to the large one for complex requests.
 */
export function selectModel(message: string): ModelSelection {
  const deploymentFull = process.env.AZURE_OPENAI_DEPLOYMENT ?? 'gpt-4o';
  const deploymentMini =
    process.env.AZURE_OPENAI_DEPLOYMENT_MINI ?? 'gpt-4o-mini';

  // Check message length
  if (message.length > COMPLEXITY_LENGTH_THRESHOLD) {
    return {
      deployment: deploymentFull,
      reason: `message length ${message.length} > ${COMPLEXITY_LENGTH_THRESHOLD}`,
    };
  }

  // Check complexity keywords
  const lower = message.toLowerCase();
  for (const keyword of COMPLEXITY_KEYWORDS) {
    if (lower.includes(keyword)) {
      return {
        deployment: deploymentFull,
        reason: `complexity keyword "${keyword}" detected`,
      };
    }
  }

  // Default to mini
  return { deployment: deploymentMini, reason: 'simple message' };
}

async function buildMessages(
  input: AgentInput,
  selectedTools: ChatCompletionTool[],
  memories?: string,
): Promise<ChatCompletionMessageParam[]> {
  const messages: ChatCompletionMessageParam[] = [
    {
      role: 'system',
      content: await buildSystemPrompt(input.senderName, selectedTools, input.userId, memories, input.now),
    },
  ];

  if (input.history) {
    for (const h of input.history) {
      messages.push({ role: h.role, content: h.content });
    }
  }

  messages.push({ role: 'user', content: input.userMessage });
  return messages;
}


/**
 * The last user + assistant turn as plain text, for context-aware tool
 * selection. Skips the compressed-history system block. Each turn is capped so
 * a long reply (a 40-row table) can't push the embedding past its input limit.
 */
const CONTEXT_TURN_CHARS = 1500;
export function previousExchange(history: AgentInput['history']): string | undefined {
  const turns = (history ?? []).filter(h => h.role !== 'system').slice(-2);
  return turns.length ? turns.map(h => h.content.slice(0, CONTEXT_TURN_CHARS)).join('\n') : undefined;
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

// -------------------------------------------------------------------------
// Automation intent classifier
// -------------------------------------------------------------------------

/**
 * Lightweight small-model pre-classifier for automation/scheduling requests.
 * Fires only when keyword routing didn't include automation tools — covers
 * phrasings like "every Friday at 4pm", "when a Planner task is assigned",
 * or "if I get an email with an attachment, save it to OneDrive".
 */
async function classifyAutomationIntent(
  message: string,
  client: AzureOpenAI,
  usageByModel: Record<string, ModelUsage>,
): Promise<{ isAutomation: boolean; triggerType: string | null }> {
  try {
    const deploymentMini = process.env.AZURE_OPENAI_DEPLOYMENT_MINI ?? 'gpt-4o-mini';
    const response = await client.chat.completions.create({
      model: deploymentMini,
      messages: [
        {
          role: 'system',
          content: `You are a routing classifier. Determine if the user message is requesting an automation, reminder, or scheduled task to be set up or managed.

Automation signals: "when X happens", "every [time/day]", "remind me at [time]", "remind me tomorrow/in X hours", "automatically", "whenever", "if I get/receive", "set up a rule", "notify me when", "assigned to me", "at [time]", "every Monday/Friday/week/day", "each time", "any time", "once a week".

NOT an automation signal: "remind me to do X" with no time specified — that is a To Do task request, not a reminder.

Respond with JSON only, no explanation:
{"isAutomation": true, "triggerType": "new_mail"|"calendar_change"|"teams_message"|"task_assigned"|"scheduled"}
or
{"isAutomation": false, "triggerType": null}

triggerType: new_mail=email trigger, calendar_change=calendar events, teams_message=Teams messages, task_assigned=Planner task assignment, scheduled=time-based (recurring or one-time).`,
        },
        { role: 'user', content: message },
      ],
      temperature: 0,
      max_completion_tokens: 60, // accepted by every model generation; max_tokens is not
    });
    addUsage(usageByModel, deploymentMini, response.usage);
    const text = response.choices[0]?.message?.content?.trim() ?? '';
    return JSON.parse(text) as { isAutomation: boolean; triggerType: string | null };
  } catch {
    return { isAutomation: false, triggerType: null };
  }
}

/**
 * Returns true if a response text suggests GPT couldn't help due to missing tools.
 * Used to decide whether to retry with the full tool set.
 */
function responseIndicatesToolGap(text: string): boolean {
  const lower = text.toLowerCase();
  // Explicit capability gaps — model says it can't do something
  const capabilityGap =
    lower.includes("don't have access") ||
    lower.includes("don't have a tool") ||
    lower.includes("unable to") ||
    lower.includes("i can't") ||
    lower.includes("i cannot") ||
    lower.includes("not able to") ||
    lower.includes("no tool") ||
    lower.includes("not supported") ||
    lower.includes("not available");

  return capabilityGap;
}

export async function runAgent(input: AgentInput): Promise<AgentOutput> {
  logger.info(
    { chatJid: input.chatJid, group: input.groupName },
    'Agent invoked',
  );

  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const apiKey = process.env.AZURE_OPENAI_API_KEY;

  if (!endpoint || !apiKey) {
    return {
      response: [
        `Hi ${input.senderName}! ${ASSISTANT_NAME} isn't configured yet.`,
        `Set AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY in .env to enable the agent.`,
      ].join(' '),
      toolsUsed: [],
    };
  }

  // [excerpt: per-tenant message-cap check (billing) omitted]

  const client = getOpenAIClient();

  // Make the vision client available to tools (email/Teams image analysis)
  setVisionClient(client);

  // Smart model routing
  const modelSelection = selectModel(input.userMessage);
  let currentDeployment = modelSelection.deployment;
  logger.info(
    {
      model: currentDeployment,
      reason: modelSelection.reason,
      chatJid: input.chatJid,
    },
    'Model selected',
  );
  input.onTrace?.({ type: 'model', deployment: currentDeployment, reason: modelSelection.reason });

  // Smart tool selection — run with filtered tools first.
  // On retry (_retrying=true) skip filtering and send all tools.
  // For scheduler/automation runs, strip send_message — the agent's text response
  // IS the message; send_message is only for mid-task human-facing updates.
  const isAutomatedRun = input.senderName === 'scheduler' || input.senderName === 'Automation' || input.senderName === 'TestRunner';
  const usageByModel: Record<string, ModelUsage> = structuredClone(input._priorUsage ?? {});

  let selectionMethod: 'embedding' | 'keyword' = 'keyword';
  let preSelectedTools: ChatCompletionTool[];
  if (input._retrying || input.allTools) {
    preSelectedTools = toolDefinitions;
  } else {
    // Try semantic embedding selection first; fall back to keyword if not ready
    const embeddingResult = await selectToolsByEmbedding(input.userMessage, previousExchange(input.history));
    if (embeddingResult) {
      preSelectedTools = unionKeywordTools(embeddingResult, input.userMessage);
      selectionMethod = 'embedding';
    } else {
      preSelectedTools = selectToolsForMessage(input.userMessage);
    }
  }

  const selectedTools: ChatCompletionTool[] = preSelectedTools.filter(t => {
    if (!isAutomatedRun) return true;
    // Automations cannot spawn new automations, tasks, or reminders — prevents exponential growth
    const blocked = new Set(['send_message', 'save_automation', 'update_automation', 'create_scheduled_task', 'set_reminder']);
    return !blocked.has(t.function.name);
  });

  // Automation intent classifier: if keyword routing didn't include automation
  // tools, ask the small model to check. Handles phrasings like "every Friday at 4pm",
  // "when a Planner task is assigned", "if I get an email with an attachment..."
  const AUTOMATION_TOOL_NAMES = [
    'save_automation', 'list_automations', 'pause_automation',
    'enable_automation', 'delete_automation', 'update_automation',
    'create_scheduled_task', 'set_reminder',
  ];
  const hasAutomationTools = selectedTools.some(t =>
    AUTOMATION_TOOL_NAMES.includes(t.function.name),
  );
  // Pre-screen: only call the classifier if the message contains automation signals.
  // Avoids a 20-40s API call for every routine task/email/calendar request.
  const AUTOMATION_SIGNAL_WORDS = [
    'every ', 'whenever', 'when i get', 'when i receive', 'when a ', 'when an ',
    'if i get', 'if i receive', 'if a ', 'if an ', 'automatically', 'set up a rule',
    'notify me when', 'each time', 'any time', 'once a week', 'once a day',
    'remind me', 'daily', 'weekly', 'recurring',
  ];
  const msgLower = input.userMessage.toLowerCase();
  const looksLikeAutomation = AUTOMATION_SIGNAL_WORDS.some(w => msgLower.includes(w));

  const automationAdded: string[] = [];
  if (!hasAutomationTools && !input._retrying && looksLikeAutomation) {
    const intent = await classifyAutomationIntent(input.userMessage, client, usageByModel);
    if (intent.isAutomation) {
      const automationTools = toolDefinitions.filter(t =>
        AUTOMATION_TOOL_NAMES.includes(t.function.name),
      );
      for (const tool of automationTools) {
        if (!selectedTools.some(t => t.function.name === tool.function.name)) {
          selectedTools.push(tool);
          automationAdded.push(tool.function.name);
        }
      }
      logger.info(
        { chatJid: input.chatJid, triggerType: intent.triggerType, injected: AUTOMATION_TOOL_NAMES.length },
        'Automation intent classified — tools injected',
      );
    }
  }

  const wasFiltered = !input._retrying && selectedTools.length < toolDefinitions.length;
  logger.info(
    {
      toolCount: selectedTools.length,
      totalTools: toolDefinitions.length,
      filtered: wasFiltered,
      method: selectionMethod,
      retrying: input._retrying ?? false,
      chatJid: input.chatJid,
    },
    'Tools selected for message',
  );
  input.onTrace?.({
    type: 'selection',
    method: input._retrying || input.allTools ? 'all' : selectionMethod,
    offered: selectedTools.map((t) => t.function.name),
    total: toolDefinitions.length,
    automationAdded,
  });

  // Load persisted user memories, ranked by relevance to this message
  const memories = await loadMemoriesForMessage(input.userMessage, input.tenantId, input.userId);

  const messages = await buildMessages(input, selectedTools, memories);
  const toolsUsed: string[] = [];
  const toolResults: ToolResultData[] = [];
  const toolCallLog: ToolCallSummary[] = [];
  const toolCallHashes = new Map<string, number>(); // loop detection
  let totalToolCallsThisTurn = 0; // total calls cap
  let totalCostUsd = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  const startTime = Date.now();

  // Compact context on timeout — only once per run
  let contextCompacted = false;

  // Consecutive 429 tracking for the bounded retry (reset on success).
  let consecutiveRateLimitRetries = 0;
  let rateLimitWaitedMs = 0;

  for (;;) {
    let response;
    const callStarted = Date.now();
    try {
      response = await client.chat.completions.create({
        model: currentDeployment,
        messages,
        tools: selectedTools.length > 0 ? selectedTools : undefined,
        tool_choice: selectedTools.length > 0 ? 'auto' : undefined,
      });
    } catch (apiErr: any) {
      // On a 429 rate limit, wait the retry-after duration and retry
      const isRateLimit =
        apiErr?.status === 429 ||
        apiErr?.error?.code === 'rate_limit_exceeded';
      if (isRateLimit) {
        const retryAfterSec = parseInt(
          apiErr?.headers?.['retry-after'] ?? '10',
          10,
        );
        const waitMs = Math.min(retryAfterSec, 60) * 1000;
        // Track per-deployment hits + retry-after; flushed to logs once a
        // minute by the periodic reporter (above). Helps spot capacity shortfalls.
        recordRateLimitHit(currentDeployment, retryAfterSec);
        consecutiveRateLimitRetries += 1;
        // Give up (gracefully) once we've exhausted the retry budget rather
        // than looping forever. Either bound trips it: too many consecutive hits,
        // or the next wait would exceed the total wait ceiling.
        if (
          consecutiveRateLimitRetries > MAX_CONSECUTIVE_RATE_LIMIT_RETRIES ||
          rateLimitWaitedMs + waitMs > RATE_LIMIT_TOTAL_WAIT_BUDGET_MS
        ) {
          logger.error(
            {
              chatJid: input.chatJid,
              deployment: currentDeployment,
              consecutiveRateLimitRetries,
              rateLimitWaitedMs,
            },
            'Azure OpenAI rate-limit retry budget exhausted — returning graceful fallback',
          );
          return {
            response:
              "I'm a bit overloaded right now — please try that again in a moment.",
            toolsUsed,
            latencyMs: Date.now() - startTime,
            usageByModel,
          };
        }
        rateLimitWaitedMs += waitMs;
        logger.warn(
          {
            chatJid: input.chatJid,
            waitMs,
            deployment: currentDeployment,
            retryAfterSec,
            attempt: consecutiveRateLimitRetries,
          },
          'Rate limited — waiting before retry',
        );
        await new Promise((res) => setTimeout(res, waitMs));
        continue;
      }

      // On timeout with large context, compact to system + last 15 messages and retry once
      const isTimeout =
        apiErr?.name === 'APIConnectionTimeoutError' ||
        String(apiErr).toLowerCase().includes('timeout');
      if (isTimeout && !contextCompacted && messages.length > 20) {
        contextCompacted = true;
        const compacted = [messages[0], ...messages.slice(-15)];
        messages.splice(0, messages.length, ...compacted);
        logger.warn(
          { chatJid: input.chatJid, messagesKept: messages.length },
          'Timeout — compacted context, retrying',
        );
        continue;
      }

      // Content filter (400) — return a graceful message rather than throwing
      const isContentFilter =
        apiErr?.status === 400 &&
        (apiErr?.error?.code === 'content_filter' ||
          String(apiErr?.message ?? '').includes('content management policy'));
      if (isContentFilter) {
        logger.warn(
          { chatJid: input.chatJid },
          'Azure content filter triggered — returning graceful fallback',
        );
        return {
          response: "I wasn't able to process that — the request was flagged by the content filter. Please try rephrasing.",
          toolsUsed,
          latencyMs: Date.now() - startTime,
          usageByModel,
        };
      }

      throw apiErr;
    }

    // A completion succeeded — reset the consecutive-429 budget so a long
    // agentic run that hits the occasional throttle is never cut short.
    consecutiveRateLimitRetries = 0;
    rateLimitWaitedMs = 0;

    // Token tracking
    if (response.usage) {
      const promptTokens = response.usage.prompt_tokens ?? 0;
      const completionTokens = response.usage.completion_tokens ?? 0;
      const cachedTokens = response.usage.prompt_tokens_details?.cached_tokens ?? 0;
      // Priced by the model the API says it served, not the deployment name.
      const price = priceFor(response.model ?? '');
      if (!price) logger.warn({ model: response.model, deployment: currentDeployment }, 'No price for the served model; cost recorded as 0');
      const cost = price ? tokenCostUsd(price, promptTokens, cachedTokens, completionTokens) : 0;

      totalCostUsd += cost;
      totalPromptTokens += promptTokens;
      totalCompletionTokens += completionTokens;
      addUsage(usageByModel, currentDeployment, response.usage);
      input.onTrace?.({
        type: 'completion',
        deployment: currentDeployment,
        promptTokens,
        cachedTokens,
        completionTokens,
        ms: Date.now() - callStarted,
        toolCalls: response.choices[0]?.message?.tool_calls?.length ?? 0,
      });

      logger.info(
        {
          model: currentDeployment,
          promptTokens,
          completionTokens,
          estimatedCostUsd: cost.toFixed(6),
          chatJid: input.chatJid,
        },
        'Token usage',
      );

      // DB might not be initialized (tests, offline eval). The rejection must be
      // caught on the promise: a try/catch around `void promise` never sees it,
      // and an unhandled rejection terminates Node.
      logTokenUsage({
        chat_jid: input.chatJid,
        model: currentDeployment,
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        estimated_cost_usd: cost,
      }).catch(() => logger.debug('Token usage logging skipped (DB not available)'));
    }

    const choice = response.choices[0];
    if (!choice) {
      logger.error('Azure OpenAI returned no choices');
      return {
        response: 'Sorry, I got an empty response from the AI.',
        toolsUsed,
        usageByModel,
      };
    }

    const msg = choice.message;

    // If no tool calls, we have the final response
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      logger.debug(
        { content: (msg.content ?? '').slice(0, 300), toolsUsed, chatJid: input.chatJid },
        'Model returned no tool calls',
      );
      let responseText = stripInternalTags(msg.content ?? '');

      // The model sometimes returns null content or a response that is entirely
      // wrapped in <internal> tags, leaving an empty string after stripping.
      // Without a fallback, index.ts silently drops the response and the user
      // sees the typing indicator disappear with no reply.
      if (!responseText) {
        responseText = toolsUsed.length > 0
          ? "Done — let me know if you need anything else."
          : "I'm not sure how to help with that. Could you rephrase?";
      }

      // Retry with all tools if: we filtered, no tools were used, and GPT's
      // response signals it couldn't help — meaning a needed tool wasn't sent.
      if (wasFiltered && toolsUsed.length === 0 && responseIndicatesToolGap(responseText)) {
        logger.info(
          { chatJid: input.chatJid, hint: responseText.slice(0, 120) },
          'Tool gap detected in filtered response — retrying with all tools',
        );
        input.onTrace?.({ type: 'retry', reason: 'reply suggests a needed tool was not offered' });
        return runAgent({ ...input, _retrying: true, _priorUsage: usageByModel });
      }

      // Log the selection and the tools actually used, for evaluation (non-blocking, best-effort)
      if (!input._retrying) {
        void logToolSelection(
          input.userMessage,
          selectedTools.map((t) => t.function.name),
          toolsUsed,
          selectionMethod,
        );
      }

      let finalResponse = responseText;
      // [excerpt: usage-threshold warning (billing) appended here — omitted]

      return {
        response: finalResponse,
        toolsUsed,
        toolResults: toolResults.length > 0 ? toolResults : undefined,
        toolCallLog: toolCallLog.length > 0 ? toolCallLog : undefined,
        latencyMs: Date.now() - startTime,
        toolCallsCount: toolsUsed.length,
        totalCostUsd,
        tokensIn: totalPromptTokens,
        tokensOut: totalCompletionTokens,
        modelUsed: currentDeployment,
        toolsOffered: selectedTools.length,
        retriedWithAllTools: input._retrying ?? false,
        usageByModel,
      };
    }

    // Mid-conversation escalation: if tool calls exceed threshold, switch to full model
    if (msg.tool_calls.length > TOOL_ESCALATION_THRESHOLD) {
      const deploymentFull = process.env.AZURE_OPENAI_DEPLOYMENT ?? 'gpt-4o';
      if (currentDeployment !== deploymentFull) {
        logger.info(
          {
            toolCallCount: msg.tool_calls.length,
            from: currentDeployment,
            to: deploymentFull,
            chatJid: input.chatJid,
          },
          'Mid-conversation model escalation',
        );
        input.onTrace?.({
          type: 'escalation',
          from: currentDeployment,
          to: deploymentFull,
          reason: `${msg.tool_calls.length} tool calls in one step`,
        });
        currentDeployment = deploymentFull;
      }
    }

    // Add the assistant's message (with tool_calls) to the conversation
    messages.push(msg);

    // Total tool calls cap — abort turn if runaway detected
    totalToolCallsThisTurn += msg.tool_calls.length;
    if (totalToolCallsThisTurn > MAX_TOOL_CALLS_PER_TURN) {
      logger.warn(
        { chatJid: input.chatJid, totalToolCallsThisTurn },
        `Total tool calls exceeded ${MAX_TOOL_CALLS_PER_TURN} — aborting turn`,
      );
      return {
        response: `I hit the tool call limit for a single turn (${MAX_TOOL_CALLS_PER_TURN} calls). This may indicate a loop or an unusually complex task. Please try breaking the request into smaller steps.`,
        toolsUsed,
        latencyMs: Date.now() - startTime,
        usageByModel,
      };
    }

    // Execute each tool call and feed results back
    for (const call of msg.tool_calls) {
      // openai 6 made the tool-call type a union (function | custom).
      // Microclaw only registers function-type tools, so any non-function
      // call here would be an API anomaly. Narrow and skip.
      if (call.type !== 'function') {
        logger.warn({ callType: call.type }, 'Unexpected non-function tool call from OpenAI API; skipping');
        continue;
      }
      const toolName = call.function.name;
      toolsUsed.push(toolName);

      logger.info({ tool: toolName, chatJid: input.chatJid }, 'Executing tool');

      let args: Record<string, any>;
      try {
        args = JSON.parse(call.function.arguments);
      } catch (parseErr) {
        logger.warn(
          {
            tool: toolName,
            rawArgs: call.function.arguments,
            err: String(parseErr),
          },
          'Failed to parse tool arguments JSON — falling back to empty object',
        );
        args = {};
      }

      // Loop detection — block identical tool+args repeated 8 times
      const callHash = `${toolName}:${JSON.stringify(args)}`;
      const repeatCount = (toolCallHashes.get(callHash) ?? 0) + 1;
      toolCallHashes.set(callHash, repeatCount);
      if (repeatCount >= 8) {
        logger.warn({ tool: toolName, count: repeatCount }, 'Loop blocked — identical call repeated 8 times');
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: `[Loop blocked] "${toolName}" was called ${repeatCount} times with identical arguments. Do not repeat this call — try a different approach.`,
        });
        continue;
      }
      if (repeatCount >= 4) {
        logger.warn({ tool: toolName, count: repeatCount }, 'Repeated tool call approaching loop threshold');
      }

      // send_message: deliver partial update to user mid-task
      if (toolName === 'send_message' && input.onPartialMessage) {
        const text = typeof args.text === 'string' ? args.text : '';
        if (text) await input.onPartialMessage(text);
      }

      if (input.onPreToolCall) input.onPreToolCall(toolName, args);

      const toolStarted = Date.now();
      const onPermission = input.onTrace
        ? (r: { allowed: boolean; reason?: string }) =>
            input.onTrace!({ type: 'permission', tool: toolName, allowed: r.allowed, reason: r.reason })
        : undefined;
      const result = await (input.toolExecutor ?? executeTool)(
        toolName, args, input.userId, input.chatJid, input.tenantId, onPermission,
      );
      input.onTrace?.({ type: 'tool', tool: toolName, args, result, ms: Date.now() - toolStarted });
      toolResults.push({ toolName, rawJson: result, args });
      if (input.onToolResult) input.onToolResult(toolName, result);
      toolCallLog.push({
        tool: toolName,
        keyParams: extractKeyParams(args),
        resultSummary: summarizeToolResult(result),
      });

      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: result,
      });
    }
  }

}
