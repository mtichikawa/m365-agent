/**
 * Tool selection: rank every tool against the user message, using each tool's
 * description AND its labelled training examples as embedding targets.
 *
 * Startup flow:
 *   1. Embed all tool descriptions.
 *   2. Load training data (bundled at build time — see ./training-data.ts).
 *   3. Check DB cache — embed only uncached queries, persist new ones.
 *   4. Hold all training embeddings in memory.
 *
 * Query-time flow (one embeddings request):
 *   - Embed the user message, plus the previous exchange when there is one.
 *   - Score each tool = max cosine similarity over its description and every
 *     training example labelled with it. Take the top SELECT_TOP_N, plus any
 *     tool within SELECT_MARGIN of the best score.
 *   - Repeat for the previous exchange (top CONTEXT_TOP_N), so follow-ups
 *     like "yes", "the second one" or "move it to 3" keep the tools they need.
 *   - Repeat for each clause of a multi-part request (top CLAUSE_TOP_N), so
 *     the second half of "find the memo and email them" isn't averaged away.
 *   - Add address-resolution tools for any selected tool that takes email
 *     addresses, so "email Nikhil" can turn a name into an address.
 *
 * Replaces the earlier KNN-with-0.80-threshold design, which on unseen
 * queries cleared its threshold for only ~1 in 7 messages logged by the
 * deployed service, and otherwise fell back to description-only top-18.
 * Measured with scripts/eval-tool-selection.ts on held-out sets written
 * blind to the training data — see eval/tool-selection/README.md for the numbers.
 */

// [excerpt: Azure OpenAI client, DB-cached training embeddings, initToolEmbeddings(),
//  selectToolsByEmbedding() and memory selection omitted — see excerpts/tool-selection/]

import type { ChatCompletionFunctionTool as ChatCompletionTool } from 'openai/resources/chat/completions.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SELECT_TOP_N = 14;     // tools always taken from the top of the ranking
const SELECT_MARGIN = 0.05;   // plus any tool scoring within this of the best
const CONTEXT_TOP_N = 8;      // tools taken from the previous exchange's ranking
const CLAUSE_TOP_N = 4;       // tools taken from each clause of a multi-part request

/** Parameters that carry email addresses — their tools need name resolution. */
const ADDRESS_PARAMS = new Set(['to', 'cc', 'bcc', 'attendees', 'emails', 'recipient_email']);
const ADDRESS_RESOLVERS = ['search_contacts', 'search_people'];

export interface ToolEntry {
  name: string;
  embedding: number[];
  definition: ChatCompletionTool;
}

export interface TrainEntry {
  query: string;
  tools: string[];
  embedding: number[];
}


function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Rank tools for one embedded text: each tool scores its best cosine
 * similarity across its description and its labelled training examples.
 */
function rankTools(
  embedding: number[],
  tools: readonly ToolEntry[],
  train: readonly TrainEntry[],
): { name: string; score: number }[] {
  const score = new Map(tools.map(t => [t.name, cosineSimilarity(embedding, t.embedding)]));
  for (const ex of train) {
    const s = cosineSimilarity(embedding, ex.embedding);
    for (const name of ex.tools) {
      if (s > (score.get(name) ?? Infinity)) score.set(name, s);
    }
  }
  return [...score].map(([name, score]) => ({ name, score })).sort((a, b) => b.score - a.score);
}

function topOf(ranked: { name: string; score: number }[], n: number, margin: number): string[] {
  const best = ranked[0]?.score ?? 0;
  return ranked.filter((r, i) => i < n || r.score >= best - margin).map(r => r.name);
}

/**
 * Split a multi-part request ("find the memo and send them a heads-up") into
 * its clauses. A single embedding of the whole message averages the intents,
 * so the weaker one can fall out of the ranking. Returns [] for one clause.
 */
export function splitClauses(message: string): string[] {
  const parts = message
    .split(/[.?!;]\s+|,\s*|\s+(?:and then|and also|then|and|also|plus)\s+/i)
    .map(p => p.trim())
    .filter(p => p.split(/\s+/).length >= 3);
  return parts.length >= 2 ? parts : [];
}

/**
 * Pure selection step, exported for tests and the eval harness.
 * `contextEmbedding` is the embedding of the previous exchange plus the
 * current message, or null on the first turn. `clauseEmbeddings` are the
 * embeddings of splitClauses(message).
 */
export function selectToolNames(
  messageEmbedding: number[],
  contextEmbedding: number[] | null,
  tools: readonly ToolEntry[],
  train: readonly TrainEntry[],
  clauseEmbeddings: readonly number[][] = [],
): Set<string> {
  const selected = new Set(topOf(rankTools(messageEmbedding, tools, train), SELECT_TOP_N, SELECT_MARGIN));
  if (contextEmbedding) {
    for (const name of topOf(rankTools(contextEmbedding, tools, train), CONTEXT_TOP_N, 0)) selected.add(name);
  }
  for (const clause of clauseEmbeddings) {
    for (const name of topOf(rankTools(clause, tools, train), CLAUSE_TOP_N, 0)) selected.add(name);
  }

  const byName = new Map(tools.map(t => [t.name, t.definition]));
  for (const name of [...selected]) {
    const params = Object.keys((byName.get(name)?.function.parameters as any)?.properties ?? {});
    if (params.some(p => ADDRESS_PARAMS.has(p))) for (const r of ADDRESS_RESOLVERS) selected.add(r);
  }

  // Always include send_message for mid-task progress updates
  selected.add('send_message');
  return selected;
}
