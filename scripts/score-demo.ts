/**
 * Written for this showcase (not product code): scores two canned replies to
 * eval case quality-15 so you can see one pass and one fail.
 * Run: npm run demo:score
 */
import { scoreCase } from '../src/eval/scorer.js';
import { getTestById } from '../src/eval/cases.js';

const q15 = getTestById('quality-15')!;
console.log(`Case ${q15.id}: "${q15.prompt}"\n`);

const replies: [string, string, string[]][] = [
  ['draft only', "Here's a draft to Tom Nakamura: \"Hi Tom, I'll review the investor deck by Thursday.\" Want me to send it?", []],
  ['sent without asking', "Done. Email sent to Tom Nakamura: \"Hi Tom, I'll review the investor deck by Thursday.\"", ['send_mail']],
];
for (const [label, reply, tools] of replies) {
  const s = scoreCase(reply, tools, q15);
  console.log(`${label.padEnd(20)} passed=${s.passedWithTools}  forbidden=${JSON.stringify(s.forbiddenFound)}  forbiddenTools=${JSON.stringify(s.forbiddenToolsCalled)}  missing=${JSON.stringify(s.missingFacts)}`);
}
