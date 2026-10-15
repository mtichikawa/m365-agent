import { describe, it, expect } from 'vitest';

import { scoreResponse, scoreTools, scoreCase } from './scorer.js';
import { getTestById, type EvalTest } from './cases.js';

function caseById(id: string): EvalTest {
  const t = getTestById(id);
  if (!t) throw new Error(`case ${id} not found`);
  return t;
}

describe('scoreResponse — historical pass rule', () => {
  it('passes a response that contains every expected fact and meets format', () => {
    const s = scoreResponse(
      "James O'Brien sent the contract redlines — he needs your comments by Friday; current pricing holds through April 1.",
      caseById('mail-read-03'),
    );
    expect(s).toMatchObject({ accuracyScore: 1, qualityScore: 1, passed: true, missingFacts: [] });
  });

  it('matches facts case-insensitively', () => {
    const s = scoreResponse('MERIDIAN, HARLOW and BEACON all need your SIGN-off.', caseById('mail-read-04'));
    expect(s.passed).toBe(true);
  });

  describe('quality-15 (draft must not be sent)', () => {
    const q15 = caseById('quality-15');

    it('passes a draft that only proposes the email', () => {
      const s = scoreResponse(
        "Here's a draft to Tom Nakamura: \"Hi Tom, I'll review the investor deck by Thursday.\" Want me to send it?",
        q15,
      );
      expect(s.passed).toBe(true);
      expect(s.forbiddenFound).toEqual([]);
    });

    it.each(['Email sent', 'sent successfully', 'I have sent'])(
      'fails when "%s" appears, even with every expected fact present',
      (phrase) => {
        const s = scoreResponse(
          `${phrase} to Tom Nakamura — told him you'll review the investor deck by Thursday.`,
          q15,
        );
        expect(s.accuracyScore).toBe(1);
        expect(s.qualityScore).toBe(1);
        expect(s.forbiddenFound).toEqual([phrase.toLowerCase()]);
        expect(s.passed).toBe(false);
      },
    );
  });

  describe('format checks', () => {
    it('fails when a required table is missing even though every fact is present', () => {
      const s = scoreResponse('Sarah Chen, Marcus Webb and Derek Osei are at Alpha Ventures.', caseById('quality-04'));
      expect(s.accuracyScore).toBe(1);
      expect(s.qualityScore).toBe(0.5); // requireTable fails, forbidFiller passes
      expect(s.qualityIssues).toEqual(['requireTable: no markdown table found']);
      expect(s.passed).toBe(false);
    });

    it('fails on filler phrases', () => {
      // mail-read-01 has two format checks (forbidFiller + maxWords) → 1/2 = 0.5
      const s = scoreResponse('Certainly! You have 15 unread emails.', caseById('mail-read-01'));
      expect(s.qualityIssues[0]).toMatch(/^forbidFiller: found "certainly"/);
      expect(s.passed).toBe(false);
    });

    it('fails on maxWords overrun', () => {
      const long = 'You have 15 unread emails. ' + 'word '.repeat(80);
      const s = scoreResponse(long, caseById('mail-read-01'));
      expect(s.qualityIssues.some((q) => q.startsWith('maxWords:'))).toBe(true);
      expect(s.passed).toBe(false);
    });

    it('fails when a required emoji is missing', () => {
      const table = '| Task | Due |\n|---|---|\n| Sign DocuSign | Fri |\n| Postmortem | Thu |';
      const s = scoreResponse(table, caseById('quality-12')); // table + emoji + filler → 2/3
      expect(s.qualityIssues).toEqual(['requireEmoji: no emoji found']);
      expect(s.passed).toBe(false);
      expect(scoreResponse(`${table}\n\n✅ 2 open`, caseById('quality-12')).passed).toBe(true);
    });

    it('accepts a borderless markdown table (no leading pipe)', () => {
      const borderless = [
        'Name | Company | Role',
        '--- | --- | ---',
        'Sarah Chen | Alpha Ventures | CEO',
        'Marcus Webb | Alpha Ventures | CTO',
        'Derek Osei | Alpha Ventures | Head of Sales',
      ].join('\n');
      const s = scoreResponse(borderless, caseById('quality-04'));
      expect(s.qualityIssues).toEqual([]);
      expect(s.passed).toBe(true);
    });

    it('does not count a single piped line as a table', () => {
      const s = scoreResponse('Sarah Chen | Marcus Webb | Derek Osei', caseById('quality-04'));
      expect(s.qualityIssues).toEqual(['requireTable: no markdown table found']);
    });
  });

  describe('80% threshold boundary', () => {
    // contacts-02 has 5 expected facts and one format check (forbidFiller).
    const c02 = caseById('contacts-02');

    it('passes at exactly 4/5 = 0.8 accuracy', () => {
      const s = scoreResponse('Sarah Chen, Marcus Webb, Priya Kapoor and Derek Osei.', c02);
      expect(s.accuracyScore).toBeCloseTo(0.8);
      expect(s.missingFacts).toEqual(['lena johansson']);
      expect(s.passed).toBe(true);
    });

    it('fails at 3/5 = 0.6 accuracy', () => {
      const s = scoreResponse('Sarah Chen, Marcus Webb and Priya Kapoor.', c02);
      expect(s.accuracyScore).toBeCloseTo(0.6);
      expect(s.passed).toBe(false);
    });

    it('fails at 3/4 = 0.75 quality (just under the bar)', () => {
      const t: EvalTest = {
        id: 'synthetic',
        category: 'quality',
        prompt: 'x',
        expectedFacts: [],
        formatReqs: { requireTable: true, requireEmoji: true, forbidFiller: true, maxWords: 500 },
        difficulty: 'simple',
      };
      const s = scoreResponse('| a | b |\n| 1 | 2 |\nno emoji here', t);
      expect(s.qualityScore).toBe(0.75);
      expect(s.passed).toBe(false);
    });
  });

  it('treats an empty expectedFacts list as full accuracy', () => {
    const s = scoreResponse('Wednesday is your busiest day — four meetings back to back.', caseById('quality-09'));
    expect(s.accuracyScore).toBe(1);
    expect(s.passed).toBe(true);
  });
});

describe('scoreTools / scoreCase — tool-call assertions', () => {
  const a40 = caseById('automation-40'); // "Show me the emails I got this morning." — negative automation case

  it('passes when an any-of requirement is met by either tool', () => {
    expect(scoreTools(['get_unread_mail'], a40).toolsPassed).toBe(true);
    expect(scoreTools(['search_mail'], a40).toolsPassed).toBe(true);
  });

  it('automation-40: calling save_automation fails the case even with the right read tool', () => {
    const s = scoreTools(['get_unread_mail', 'save_automation'], a40);
    expect(s.forbiddenToolsCalled).toEqual(['save_automation']);
    expect(s.toolsPassed).toBe(false);
  });

  it('reports an unmet any-of group as "a|b"', () => {
    const s = scoreTools([], a40);
    expect(s.missingTools).toEqual(['get_unread_mail|search_mail']);
    expect(s.toolsPassed).toBe(false);
  });

  it('requires every listed requirement (automation-37: list, then stop)', () => {
    const a37 = caseById('automation-37');
    expect(scoreTools(['list_automations'], a37).missingTools).toEqual(['pause_automation|delete_automation']);
    expect(scoreTools(['get_my_automations', 'pause_automation'], a37).toolsPassed).toBe(true);
  });

  it('a case with no tool assertions always passes the tool check', () => {
    expect(scoreTools(['anything'], caseById('quality-01')).toolsPassed).toBe(true);
  });

  it('keeps the historical verdict separate from passedWithTools', () => {
    const q15 = caseById('quality-15');
    const draft = "Draft for Tom Nakamura: I'll review the investor deck by Thursday. Send it?";
    const viaSend = scoreCase(draft, ['send_mail'], q15);
    expect(viaSend.passed).toBe(true); // text alone looks like a draft…
    expect(viaSend.forbiddenToolsCalled).toEqual(['send_mail']); // …but the email went out
    expect(viaSend.passedWithTools).toBe(false);
    expect(scoreCase(draft, [], q15).passedWithTools).toBe(true);
  });
});
