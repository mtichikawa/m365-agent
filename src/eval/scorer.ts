/**
 * Scorer — grades an agent response against a case's expected facts and
 * format requirements.
 *
 * The pass rule is the historical one used for the 107/142-case batteries
 * and must not change (see eval/agent/README.md): accuracy >= 0.8 AND quality >= 0.8
 * AND no forbidden fact present.
 */

import type { EvalTest } from './cases.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BotScore {
  /** 0-1: fraction of expectedFacts found in response (case-insensitive). */
  accuracyScore: number;
  /** 0-1: fraction of format requirements passed. */
  qualityScore: number;
  /** true if accuracyScore >= 0.8 AND qualityScore >= 0.8 AND no forbiddenFacts found. */
  passed: boolean;
  /** Which expectedFacts were missing from the response. */
  missingFacts: string[];
  /** Which forbiddenFacts appeared in the response. */
  forbiddenFound: string[];
  /** Which format requirements failed. */
  qualityIssues: string[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const FILLER_PHRASES = [
  'certainly',
  'of course',
  'great question',
  'happy to help',
  "sure!",
  'absolutely',
];

/** Check whether a response contains at least one emoji character. */
function hasEmoji(text: string): boolean {
  // Unicode ranges that cover common emoji blocks
  return /[\u{1F300}-\u{1FAFF}]|[\u{2600}-\u{27BF}]|[\u{2300}-\u{23FF}]|[\u{FE00}-\u{FEFF}]/u.test(text);
}

/** Check whether a response contains a markdown table (multiple rows with |). */
function hasTable(text: string): boolean {
  const lines = text.split('\n');
  // Accept tables with or without leading pipe (e.g. "Day | Event | Time" is valid markdown)
  const tableLines = lines.filter((l) => {
    const trimmed = l.trim();
    return trimmed.includes('|') && (trimmed.startsWith('|') || trimmed.split('|').length >= 3);
  });
  return tableLines.length >= 2;
}

/** Rough word count (split on whitespace). */
function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

// ─── Core scoring ─────────────────────────────────────────────────────────────

export function scoreResponse(response: string, test: EvalTest): BotScore {
  const lower = response.toLowerCase();

  // Accuracy: check expectedFacts
  const missingFacts: string[] = [];
  let matched = 0;
  for (const fact of test.expectedFacts) {
    if (lower.includes(fact.toLowerCase())) {
      matched++;
    } else {
      missingFacts.push(fact);
    }
  }
  const accuracyScore =
    test.expectedFacts.length > 0 ? matched / test.expectedFacts.length : 1.0;

  // Forbidden facts
  const forbiddenFound: string[] = [];
  for (const bad of test.forbiddenFacts ?? []) {
    if (lower.includes(bad.toLowerCase())) {
      forbiddenFound.push(bad);
    }
  }

  // Quality: check formatReqs
  const qualityIssues: string[] = [];
  let qualityChecks = 0;
  let qualityPassed = 0;

  if (test.formatReqs.requireTable !== undefined) {
    qualityChecks++;
    if (hasTable(response)) {
      qualityPassed++;
    } else {
      qualityIssues.push('requireTable: no markdown table found');
    }
  }

  if (test.formatReqs.requireEmoji !== undefined) {
    qualityChecks++;
    if (hasEmoji(response)) {
      qualityPassed++;
    } else {
      qualityIssues.push('requireEmoji: no emoji found');
    }
  }

  if (test.formatReqs.forbidFiller) {
    qualityChecks++;
    const foundFiller = FILLER_PHRASES.filter((p) => lower.includes(p.toLowerCase()));
    if (foundFiller.length === 0) {
      qualityPassed++;
    } else {
      qualityIssues.push(`forbidFiller: found "${foundFiller.join('", "')}"`);
    }
  }

  if (test.formatReqs.maxWords !== undefined) {
    qualityChecks++;
    const wc = wordCount(response);
    if (wc <= test.formatReqs.maxWords) {
      qualityPassed++;
    } else {
      qualityIssues.push(`maxWords: ${wc} words > limit of ${test.formatReqs.maxWords}`);
    }
  }

  const qualityScore = qualityChecks > 0 ? qualityPassed / qualityChecks : 1.0;

  const passed =
    accuracyScore >= 0.8 &&
    qualityScore >= 0.8 &&
    forbiddenFound.length === 0;

  return {
    accuracyScore,
    qualityScore,
    passed,
    missingFacts,
    forbiddenFound,
    qualityIssues,
  };
}

// ─── Tool-call assertions ─────────────────────────────────────────────────────
//
// Added with the 2026-10 revival. Kept separate from `passed` so the historical
// fact/format pass rate stays comparable; `passedWithTools` is the stricter
// verdict that also requires the right tools (and none of the wrong ones).

export interface ToolScore {
  /** true if every expectedTools requirement was met and no forbiddenTools was called. */
  toolsPassed: boolean;
  /** Unmet requirements; an any-of group is rendered "a|b". */
  missingTools: string[];
  /** forbiddenTools the agent called. */
  forbiddenToolsCalled: string[];
}

export function scoreTools(toolsUsed: readonly string[], test: EvalTest): ToolScore {
  const used = new Set(toolsUsed);
  const missingTools = (test.expectedTools ?? [])
    .map((req) => (typeof req === 'string' ? [req] : req))
    .filter((anyOf) => !anyOf.some((name) => used.has(name)))
    .map((anyOf) => anyOf.join('|'));
  const forbiddenToolsCalled = (test.forbiddenTools ?? []).filter((name) => used.has(name));
  return {
    toolsPassed: missingTools.length === 0 && forbiddenToolsCalled.length === 0,
    missingTools,
    forbiddenToolsCalled,
  };
}

export interface CaseScore extends BotScore, ToolScore {
  /** `passed` (historical rule) AND `toolsPassed`. */
  passedWithTools: boolean;
}

export function scoreCase(response: string, toolsUsed: readonly string[], test: EvalTest): CaseScore {
  const text = scoreResponse(response, test);
  const tools = scoreTools(toolsUsed, test);
  return { ...text, ...tools, passedWithTools: text.passed && tools.toolsPassed };
}
