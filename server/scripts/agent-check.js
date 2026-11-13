/**
 * Run with:  npm run agent-check
 *
 * Asks the real agent (uses your LLM key and MongoDB) the question that
 * exposed the "invented marks" bug on the live site, and fails if:
 *   - check_eligibility was never called, or
 *   - its arguments contain a detail the student never gave
 *     (marks_pct, gender, disability), or
 *   - the answer claims marks the student never stated ("you reported 75%").
 *
 * It costs a few LLM calls, so it is separate from `npm test`.
 * LLM output varies: run it 3 times before trusting a pass.
 */
import { runAgent } from "../lib/agent.js";
import { closeDb } from "../lib/db.js";

const question =
  "I'm a final-year B.Tech student, OBC, from UP, with a family income of Rs 4 lakh. " +
  "Which scholarships can I apply for, and what documents will I need?";

const problems = [];
const { answer, trace } = await runAgent(question, []);

console.log("Trace:");
for (const t of trace) {
  console.log(` step ${t.step}  ${t.tool}  ${JSON.stringify(t.args)}`);
  if (t.dropped) console.log(`          dropped by the guard: ${t.dropped.join(", ")}`);
  console.log(`          -> ${t.summary}`);
}
console.log("\nAnswer:\n" + answer + "\n");

const elig = trace.filter((t) => t.tool === "check_eligibility");
if (elig.length === 0) problems.push("check_eligibility was never called");
for (const t of elig) {
  for (const field of ["marks_pct", "gender", "disability"]) {
    if (t.args[field] !== undefined) {
      problems.push(`check_eligibility received ${field}=${t.args[field]}, which the student never gave`);
    }
  }
  if (t.dropped?.length) {
    console.log(`Note: the model tried to send ${t.dropped.join(", ")}; the guard removed it.`);
  }
}
if (/you reported \d+\s*%/i.test(answer || "")) {
  problems.push("the answer claims marks the student never stated");
}

await closeDb();

if (problems.length) {
  console.log("FAIL");
  for (const p of problems) console.log(" - " + p);
  process.exit(1);
}
console.log("PASS: no invented details reached the eligibility check.");
