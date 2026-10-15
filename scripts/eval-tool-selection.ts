/**
 * Tool-selection evaluation harness.
 *
 * Measures whether the selector OFFERS every tool a request needs ("coverage":
 * if a needed tool isn't offered, the model can't do the task) and how many
 * tools it sends (the input-token cost). Runs the production selection code —
 * selectToolNames() from embeddings.ts and unionKeywordTools() from runner.ts —
 * against the real training data and tool catalogue.
 *
 * [adapted for this repo: runs offline. The product version embeds with Azure
 *  OpenAI and caches the vectors; here every vector the sealed sets need is
 *  committed in eval-data/tool-selection/vectors/, exported from that cache.
 *  The imports and the embedAll() source are the only changes.]
 *
 * Usage:
 *   npm run eval:selection
 *   SHOW_MISSES=current npx tsx scripts/eval-tool-selection.ts <file>
 *
 * Case format: { id, query, tools, alt_map?, prev_user?, prev_assistant? }
 *   tools    — minimal set that must be offered
 *   alt_map  — { requiredTool: [acceptable substitutes] }
 *   prev_*   — the preceding exchange, for follow-up cases
 */

import { createHash } from 'crypto';
import { readFileSync } from 'fs';

import { TOOL_SELECTION_TRAINING_DATA } from '../src/tool-selection/training-data.js';
import { toolDefinitions } from '../src/tool-selection/catalogue.js';
import { selectToolsForMessage, unionKeywordTools } from '../src/tool-selection/keywords.js';
import { selectToolNames, splitClauses, type ToolEntry, type TrainEntry } from '../src/tool-selection/embeddings.js';

// ---------------------------------------------------------------------------
// Embeddings: precomputed text-embedding-3-small vectors, looked up by SHA-1 of the text
// ---------------------------------------------------------------------------

const VECTORS = new URL('../eval-data/tool-selection/vectors/', import.meta.url);
const index: { dim: number; keys: string[] } = JSON.parse(readFileSync(new URL('vectors-index.json', VECTORS), 'utf8'));
const raw = readFileSync(new URL('vectors.f32', VECTORS));
const all = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
const row = new Map(index.keys.map((k, i) => [k, i]));
const key = (t: string) => createHash('sha1').update(t).digest('hex');
let embeddedChars = 0;

async function embedAll(texts: string[]): Promise<number[][]> {
  return texts.map((t) => {
    const i = row.get(key(t));
    if (i === undefined) throw new Error(`No precomputed vector for ${JSON.stringify(t.slice(0, 60))}`);
    return Array.from(all.subarray(i * index.dim, (i + 1) * index.dim));
  });
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

interface Case {
  id: string;
  query: string;
  tools: string[];
  alt_map?: Record<string, string[]>;
  prev_user?: string;
  prev_assistant?: string;
}

interface Ctx {
  c: Case;
  emb: number[];
  ctxEmb: number[] | null;
  clauseEmbs: number[][];
  tools: ToolEntry[];
  train: TrainEntry[];
}

const names = (defs: { function: { name: string } }[]) => new Set(defs.map((d) => d.function.name));

/**
 * The selector as it shipped before 2026-10 (git show 1b8d860:src/agent/embeddings.ts):
 * KNN over training examples when the nearest one scores ≥ 0.80, otherwise
 * description similarity top-18, then the keyword union. Kept as the baseline.
 */
function legacy({ c, emb, tools, train }: Ctx): Set<string> {
  const nn = train.map((e) => ({ tools: e.tools, s: cosine(emb, e.embedding) })).sort((a, b) => b.s - a.s);
  let picked: string[];
  if (nn[0].s >= 0.8) {
    const freq: Record<string, number> = {};
    for (const n of nn.slice(0, 7)) for (const t of n.tools) freq[t] = (freq[t] ?? 0) + 1;
    picked = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 18).map(([n]) => n);
  } else {
    picked = tools.map((t) => ({ n: t.name, s: cosine(emb, t.embedding) })).sort((a, b) => b.s - a.s).slice(0, 18).map((t) => t.n);
  }
  picked.push('send_message');
  const kw = selectToolsForMessage(c.query);
  if (kw.length < toolDefinitions.length) for (const t of kw) picked.push(t.function.name);
  return new Set(picked);
}

/** Production: selectToolNames() then unionKeywordTools(), exactly as runner.ts calls them. */
function current({ c, emb, ctxEmb, clauseEmbs, tools, train }: Ctx): Set<string> {
  const picked = selectToolNames(emb, ctxEmb, tools, train, clauseEmbs);
  const defs = tools.filter((t) => picked.has(t.name)).map((t) => t.definition);
  return names(unionKeywordTools(defs, c.query));
}

const SELECTORS = { legacy, current };

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function covered(sel: Set<string>, c: Case): boolean {
  return c.tools.every((t) => sel.has(t) || (c.alt_map?.[t] ?? []).some((a) => sel.has(a)));
}

/** Wilson score interval, 95%. */
function wilson(k: number, n: number): [number, number] {
  const z = 1.96, p = k / n;
  const d = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [centre - half, centre + half];
}

/** Matches selectToolsByEmbedding: previous exchange, newline, current message. */
const contextText = (c: Case) =>
  c.prev_user ? `${c.prev_user}\n${c.prev_assistant ?? ''}\n${c.query}` : null;

async function main() {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error('usage: eval-tool-selection.ts <cases.json> [...]');
    process.exit(1);
  }

  const descTexts = toolDefinitions.map((t) => `${t.function.name}: ${t.function.description ?? ''}`);
  const trainQueries = TOOL_SELECTION_TRAINING_DATA.map((e) => e.query);
  const descEmb = await embedAll(descTexts);
  const trainEmb = await embedAll(trainQueries);
  const tools: ToolEntry[] = toolDefinitions.map((d, i) => ({ name: d.function.name, embedding: descEmb[i], definition: d }));
  const train: TrainEntry[] = TOOL_SELECTION_TRAINING_DATA.map((e, i) => ({ query: e.query, tools: e.tools, embedding: trainEmb[i] }));
  const trainSet = new Set(trainQueries.map((q) => q.toLowerCase().trim()));
  const allNames = new Set(tools.map((t) => t.name));

  for (const file of files) {
    const cases: Case[] = JSON.parse(readFileSync(file, 'utf8'));
    const unknown = cases.flatMap((c) => [...c.tools, ...Object.values(c.alt_map ?? {}).flat()]).filter((t) => !allNames.has(t));
    if (unknown.length) throw new Error(`${file}: unknown tools ${[...new Set(unknown)].join(', ')}`);

    const scored = cases.filter((c) => c.tools.length > 0);
    const leaked = scored.filter((c) => trainSet.has(c.query.toLowerCase().trim())).length;
    const embs = await embedAll(scored.map((c) => c.query));
    const ctxTexts = scored.map(contextText);
    const ctxEmbs = await embedAll(ctxTexts.filter((t): t is string => t !== null));
    let ci = 0;
    const ctxFor = ctxTexts.map((t) => (t === null ? null : ctxEmbs[ci++]));
    const clauseTexts = scored.map((c) => splitClauses(c.query));
    const clauseFlat = await embedAll(clauseTexts.flat());
    let cl = 0;
    const clausesFor = clauseTexts.map((ts) => ts.map(() => clauseFlat[cl++]));

    console.log(`\n${file}\n  ${scored.length} cases needing ≥1 tool (${leaked} verbatim in training data)`);
    for (const [name, fn] of Object.entries(SELECTORS)) {
      let hit = 0, size = 0;
      const misses: string[] = [];
      scored.forEach((c, i) => {
        const sel = fn({ c, emb: embs[i], ctxEmb: ctxFor[i], clauseEmbs: clausesFor[i], tools, train });
        size += sel.size;
        if (covered(sel, c)) hit++;
        else misses.push(`${c.id}: "${c.query.slice(0, 70)}" missing ${c.tools.filter((t) => !sel.has(t)).join(', ')}`);
      });
      const [lo, hi] = wilson(hit, scored.length);
      console.log(
        `  ${name.padEnd(8)} coverage ${((100 * hit) / scored.length).toFixed(1).padStart(5)}%` +
          ` (${hit}/${scored.length}, 95% CI ${(100 * lo).toFixed(1)}–${(100 * hi).toFixed(1)})` +
          `  avg tools offered ${(size / scored.length).toFixed(1)} of ${tools.length}`,
      );
      if (process.env.SHOW_MISSES === name) for (const m of misses) console.log('     ✗ ' + m);
    }
  }
  if (embeddedChars) console.log(`\n(embedded ${embeddedChars} new characters this run)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
