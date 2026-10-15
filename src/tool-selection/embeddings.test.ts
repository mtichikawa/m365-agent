/**
 * Tool selection — the pure ranking step, with hand-built vectors so each
 * component (description vs example scoring, context, clauses, address
 * resolution) can be checked in isolation. End-to-end coverage on real
 * embeddings is measured by scripts/eval-tool-selection.ts.
 */
import { describe, it, expect } from 'vitest';
import { selectToolNames, splitClauses, type ToolEntry, type TrainEntry } from './embeddings.js';

// One axis per "topic"; a query pointing along an axis matches that topic.
const DIM = 20;
const axis = (i: number, w = 1) => Array.from({ length: DIM }, (_, j) => (j === i ? w : 0));
const blend = (...vs: number[][]) => vs[0].map((_, i) => vs.reduce((s, v) => s + v[i], 0));

function tool(name: string, embedding: number[], params: string[] = []): ToolEntry {
  return {
    name,
    embedding,
    definition: {
      type: 'function',
      function: {
        name,
        description: name,
        parameters: { type: 'object', properties: Object.fromEntries(params.map(p => [p, { type: 'string' }])) },
      },
    },
  };
}

// 16 filler tools on their own axes push the catalogue past SELECT_TOP_N (14).
const filler = Array.from({ length: 16 }, (_, i) => tool(`filler_${i}`, axis(i)));
const TOOLS: ToolEntry[] = [
  ...filler,
  tool('create_todo_task', axis(16)),
  tool('send_mail', axis(17), ['to', 'subject']),
  tool('search_contacts', axis(18)),
  tool('search_people', axis(19)),
  tool('send_message', axis(19, 0.5)),
];

describe('selectToolNames', () => {
  it('scores a tool by its training examples, not only its description', () => {
    // The description of create_todo_task points elsewhere; an example labelled
    // with it matches the query exactly.
    const tools = TOOLS.map(t => (t.name === 'create_todo_task' ? { ...t, embedding: axis(3) } : t));
    const fromQuery = blend(axis(0), axis(16));
    const train: TrainEntry[] = [{ query: 'add a task', tools: ['create_todo_task'], embedding: fromQuery }];
    expect(selectToolNames(fromQuery, null, tools, train).has('create_todo_task')).toBe(true);
    expect(selectToolNames(fromQuery, null, tools, []).has('create_todo_task')).toBe(false);
  });

  it('caps the ranking at the top 14 plus near-ties', () => {
    // Query matches filler_0 strongly; everything else scores 0 — 14 taken, no near-ties.
    const sel = selectToolNames(axis(0), null, TOOLS, []);
    sel.delete('send_message');
    expect(sel.size).toBe(14);
    expect(sel.has('filler_0')).toBe(true);
  });

  it('adds tools from the previous exchange for follow-ups', () => {
    // "yes" points at nothing useful; the previous exchange was about a task.
    const yes = blend(axis(0), axis(1), axis(2), axis(4), axis(5), axis(6), axis(7), axis(8),
      axis(9), axis(10), axis(11), axis(12), axis(13), axis(14), axis(15));
    expect(selectToolNames(yes, null, TOOLS, []).has('create_todo_task')).toBe(false);
    expect(selectToolNames(yes, axis(16), TOOLS, []).has('create_todo_task')).toBe(true);
  });

  it('adds each clause’s top tools for multi-part requests', () => {
    const whole = blend(...Array.from({ length: 15 }, (_, i) => axis(i)));
    expect(selectToolNames(whole, null, TOOLS, []).has('create_todo_task')).toBe(false);
    expect(selectToolNames(whole, null, TOOLS, [], [axis(16)]).has('create_todo_task')).toBe(true);
  });

  it('adds address resolvers for tools that take email addresses', () => {
    const sel = selectToolNames(axis(17, 10), null, [tool('send_mail', axis(17), ['to']), ...TOOLS.slice(0, 16),
      tool('search_contacts', axis(0, -1)), tool('search_people', axis(0, -1))], []);
    expect(sel.has('send_mail')).toBe(true);
    expect(sel.has('search_contacts')).toBe(true);
    expect(sel.has('search_people')).toBe(true);
  });

  it('always includes send_message', () => {
    expect(selectToolNames(axis(0), null, TOOLS, []).has('send_message')).toBe(true);
  });
});

describe('splitClauses', () => {
  it('splits multi-part requests on sentence breaks and conjunctions', () => {
    expect(splitClauses("what's in the attachment from Lorenzo? add the deadlines to my to do")).toEqual([
      "what's in the attachment from Lorenzo",
      'add the deadlines to my to do',
    ]);
    expect(splitClauses('find the merger memo and then email everyone on it')).toEqual([
      'find the merger memo',
      'email everyone on it',
    ]);
  });

  it('returns [] for a single intent, ignoring fragments under 3 words', () => {
    expect(splitClauses('check my inbox')).toEqual([]);
    expect(splitClauses('set up a meeting with Ananya and Brett')).toEqual([]);
  });
});
