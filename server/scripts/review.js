/**
 * npm run review -- <scheme-id> --by "Your Name" [--all] [--field eligibility.income_max]
 *
 * Walks through every field that hasn't been reviewed yet. For each one you
 * see the extracted value, the PDF page and the exact supporting text, plus
 * any problem the automatic checks found. You decide:
 *
 *   a  approve       the value is right
 *   c  correct       type the right value (the original is kept for the audit trail)
 *   n  not in PDF    confirm the document really doesn't state this
 *   s  skip          decide later
 *   q  quit          save and stop
 *
 * Every decision is saved immediately with your name and the time.
 * --all also re-shows fields that were already reviewed.
 */
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { stdin, stdout } from "node:process";
import { fileURLToPath } from "node:url";
import {
  FIELDS,
  applyDecision,
  isReviewed,
  parseTypedValue,
  renderReport,
} from "../lib/verification.js";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const schemeId = args[0];
if (!schemeId || schemeId.startsWith("--")) {
  console.error('Usage: npm run review -- <scheme-id> --by "Your Name" [--all] [--field <key>]');
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const reviewPath = path.join(here, "../data/review", `${schemeId}.json`);
const reportPath = path.join(here, "../data/review", `${schemeId}.md`);
let review;
try {
  review = JSON.parse(await fs.readFile(reviewPath, "utf8"));
} catch {
  console.error(`No review file at ${reviewPath}. Run: npm run extract -- <pdf> ${schemeId}`);
  process.exit(1);
}

// A small line queue: works when typing, and when answers are piped in.
// If the input ends (window closed, Ctrl+C, end of a piped file), every
// decision made so far is already saved and the script stops cleanly.
const rl = readline.createInterface({ input: stdin, output: stdout, terminal: stdin.isTTY });
const lines = [];
const waiting = [];
let closed = false;
rl.on("line", (l) => (waiting.length ? waiting.shift()(l) : lines.push(l)));
rl.on("close", () => {
  closed = true;
  while (waiting.length) waiting.shift()(null);
});
const ask = (prompt) => {
  stdout.write(prompt);
  if (lines.length) return Promise.resolve(lines.shift());
  if (closed) return Promise.resolve(null);
  return new Promise((resolve) => waiting.push(resolve));
};
const QUIT = Symbol("quit");
const answer = async (prompt) => {
  const l = await ask(prompt);
  if (l === null) throw QUIT;
  return l;
};

let by = flag("--by") || process.env.REVIEWER;
try {
  while (!by || !by.trim()) by = await answer("Your name (recorded with each decision): ");
} catch {
  console.log("\nNo name given; nothing was changed.");
  process.exit(1);
}

const save = async () => {
  await fs.writeFile(reviewPath, JSON.stringify(review, null, 2) + "\n");
  await fs.writeFile(reportPath, renderReport(review));
};

const short = (v, n = 300) => {
  if (v === null || v === undefined) return "(none)";
  if (Array.isArray(v)) return v.length ? v.join(", ") : "(empty)";
  const s = String(v);
  return s.length > n ? s.slice(0, n) + "…" : s;
};

const only = flag("--field");
const todo = FIELDS.filter((f) => (only ? f.key === only : args.includes("--all") || !isReviewed(review.fields[f.key])));
if (!todo.length) {
  console.log(only ? `No field called ${only}.` : "Every field is already reviewed. Next: npm run finalize -- " + schemeId);
  rl.close();
  process.exit(0);
}

console.log(`\nReviewing ${schemeId}: ${todo.length} field(s). Open the PDF next to this window.\n`);

let n = 0;
outer: for (const spec of todo) {
  n++;
  const f = review.fields[spec.key];
  console.log("─".repeat(70));
  console.log(`[${n}/${todo.length}] ${spec.label}   (${spec.key})`);
  console.log(`  Extracted : ${short(f.value)}`);
  if (f.status === "corrected") console.log(`  (originally extracted: ${short(f.llm_value)})`);
  if (f.evidence.length === 0) console.log("  Evidence  : none given");
  for (const e of f.evidence) {
    const where = e.match === "exact" ? "found on this page" : e.match === "wrong_page" ? `ACTUALLY on page ${e.found_on_pages.join(", ")}` : e.match === "approximate" ? "only a loose match" : "NOT FOUND in the PDF text";
    console.log(`  Page ${String(e.page).padEnd(5)}: "${short(e.text, 260)}"   [${where}]`);
  }
  console.log(f.reasons.length ? `  Check     : !! ${f.reasons.join("\n              !! ")}` : "  Check     : OK, quote found on the cited page and the value matches it");
  if (f.review) console.log(`  Already   : ${f.review.decision} by ${f.review.by} at ${f.review.at}`);

  const canApprove = !(f.llm_value === null || f.llm_value === "" || (Array.isArray(f.llm_value) && !f.llm_value.length));
  const menu = [canApprove && "a = approve", "c = correct", !spec.required && "n = not in PDF", "s = skip", "q = save and quit"].filter(Boolean).join("   ");

  for (;;) {
    const choice = (await answer(`  ${menu}\n  > `)).trim().toLowerCase();
    try {
      if (choice === "a" && canApprove) {
        applyDecision(review, spec.key, "approve", { by });
      } else if (choice === "c") {
        const typed = await answer("  Correct value (e.g. 250000 or 2.5 lakh · SC, ST · 2026-10-31 · yes/no): ");
        const page = (await answer("  Page where you found it (Enter to skip): ")).trim();
        const text = (await answer("  Exact text from that page (Enter to skip): ")).trim();
        const note = (await answer("  Note (Enter to skip): ")).trim();
        applyDecision(review, spec.key, "correct", {
          by,
          note,
          value: parseTypedValue(spec.key, typed),
          ...(page || text ? { evidence: { page: page ? Number(page) : null, text } } : {}),
        });
      } else if (choice === "n" && !spec.required) {
        const note = (await answer("  Note (Enter to skip): ")).trim();
        applyDecision(review, spec.key, "not_found", { by, note });
      } else if (choice === "s") {
        break;
      } else if (choice === "q") {
        break outer;
      } else {
        console.log("  Please type one of the letters shown.");
        continue;
      }
      await save();
      console.log(`  Saved: ${review.fields[spec.key].status} → ${short(review.fields[spec.key].value, 80)}`);
      break;
    } catch (err) {
      if (err === QUIT) {
        console.log("\n  Input ended: stopping. Everything decided so far is saved.");
        break outer;
      }
      console.log(`  Not saved: ${err.message}`);
    }
  }
}

await save();
rl.close();
const left = FIELDS.filter((f) => !isReviewed(review.fields[f.key])).length;
console.log("─".repeat(70));
console.log(`\n${review.overall_status.toUpperCase()}: ${FIELDS.length - left}/${FIELDS.length} fields reviewed.`);
console.log(`Report: data/review/${schemeId}.md`);
console.log(left ? `Run again to continue: npm run review -- ${schemeId} --by "${by}"` : `Next: npm run finalize -- ${schemeId}`);
