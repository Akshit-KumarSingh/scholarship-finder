/**
 * Run with:  npm run test:unit
 *
 * No database, no LLM, no .env needed. These run the real eligibility rules
 * on a frozen copy of the placeholder data (test/fixtures/schemes-placeholder.json,
 * so verifying real schemes into data/schemes.json doesn't change what these
 * tests mean), the input validation, and the agent's guard against
 * invented fields. (test/tools.test.js covers the same rules end to end
 * through MongoDB, plus retrieval.)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { evaluateSchemes, assertKnownIds } from "../lib/tools.js";
import { ProfileSchema, ChatSchema } from "../lib/validate.js";
import { prepareEligibilityArgs } from "../lib/agent.js";

const all = JSON.parse(
  readFileSync(new URL("./fixtures/schemes-placeholder.json", import.meta.url), "utf8"),
).filter((s) => !s.skip && s.id !== "_meta");

const ids = (rows) => rows.map((r) => r.id);

// The student from the bug report: final-year B.Tech, OBC, UP, 4 lakh, no marks.
const btech = { income: 400000, category: "OBC", state: "UP", course_level: "UG", year_of_study: 4 };

/* ---------------------------------------------------------------- */
/* Unknown details are flagged, never silently passed                */
/* ---------------------------------------------------------------- */

test("missing marks: a scheme with a marks floor is 'possible', not 'eligible'", () => {
  const r = evaluateSchemes(all, btech);
  assert.ok(!ids(r.eligible).includes("css-ug"), "css-ug needs 80%, marks were never given");
  const css = r.possible.find((s) => s.id === "css-ug");
  assert.ok(css, "css-ug should be listed as possible");
  assert.ok(css.unchecked.some((u) => u.startsWith("marks_pct")));
  assert.ok(r.missing_fields.includes("marks_pct"));
});

test("with marks given, the same student is confirmed eligible", () => {
  const r = evaluateSchemes(all, { ...btech, gender: "MALE", marks_pct: 85 });
  assert.ok(ids(r.eligible).includes("css-ug"));
  assert.equal(r.possible.filter((s) => s.id === "css-ug").length, 0);
});

test("marks below the floor fail with the real number, not an invented one", () => {
  const r = evaluateSchemes(all, { ...btech, gender: "MALE", marks_pct: 60 });
  const css = r.near_misses.find((s) => s.id === "css-ug");
  assert.ok(css);
  assert.match(css.reason, /80% minimum, you reported 60%/);
});

test("missing gender is flagged on a girls-only scheme", () => {
  const r = evaluateSchemes(all, btech);
  const pragati = [...r.possible, ...r.near_misses].find((s) => s.id === "aicte-pragati");
  assert.ok(pragati);
  assert.ok(pragati.unchecked.some((u) => u.startsWith("gender")));
});

/* ---------------------------------------------------------------- */
/* Case-insensitive comparisons                                       */
/* ---------------------------------------------------------------- */

test("state is case-insensitive: 'up' matches UP schemes", () => {
  const p = { income: 150000, category: "SC", course_level: "UG", year_of_study: 2, gender: "MALE", disability: false };
  const upper = evaluateSchemes(all, { ...p, state: "UP" });
  const lower = evaluateSchemes(all, { ...p, state: " up " });
  assert.deepEqual(ids(lower.eligible), ids(upper.eligible));
  assert.ok(ids(lower.eligible).includes("up-postmatric"));
});

test("category and gender are case-insensitive too", () => {
  const p = { income: 600000, course_level: "UG", year_of_study: 1, disability: false };
  const a = evaluateSchemes(all, { ...p, category: "GENERAL", gender: "FEMALE" });
  const b = evaluateSchemes(all, { ...p, category: "general", gender: "female" });
  assert.deepEqual(ids(b.eligible), ids(a.eligible));
});

/* ---------------------------------------------------------------- */
/* Input validation                                                  */
/* ---------------------------------------------------------------- */

test("validation converts '4' to 4 and uppercases enums", () => {
  const r = ProfileSchema.safeParse({ income: "400000", category: "obc", year_of_study: "4", state: "up" });
  assert.ok(r.success);
  assert.equal(r.data.year_of_study, 4);
  assert.equal(r.data.category, "OBC");
  assert.equal(r.data.state, "UP");
});

test("validation treats an empty marks box as 'not given'", () => {
  const r = ProfileSchema.safeParse({ income: 1, category: "SC", marks_pct: "" });
  assert.ok(r.success);
  assert.equal(r.data.marks_pct, undefined);
});

test("validation rejects nonsense with a readable message", () => {
  const r = ProfileSchema.safeParse({ income: "four lakh", category: "OBC", marks_pct: 140 });
  assert.ok(!r.success);
  const paths = r.error.issues.map((i) => i.path[0]);
  assert.ok(paths.includes("income"));
  assert.ok(paths.includes("marks_pct"));
});

test("chat requires a non-empty message", () => {
  assert.ok(!ChatSchema.safeParse({ message: "   " }).success);
  assert.ok(ChatSchema.safeParse({ message: "hi" }).success);
});

/* ---------------------------------------------------------------- */
/* The agent can't slip in details the student never gave            */
/* ---------------------------------------------------------------- */

const question =
  "I'm a final-year B.Tech student, OBC, from UP, with a family income of Rs 4 lakh. " +
  "Which scholarships can I apply for, and what documents will I need?";

test("invented marks are dropped (the live-site bug)", () => {
  const llmArgs = { ...btech, marks_pct: 75 };
  const { args, dropped } = prepareEligibilityArgs(llmArgs, question, null);
  assert.equal(args.marks_pct, undefined);
  assert.deepEqual(dropped, ["marks_pct"]);
});

test("marks the student did state are kept", () => {
  const { args, dropped } = prepareEligibilityArgs({ ...btech, marks_pct: 82 }, question + " I scored 82%.", null);
  assert.equal(args.marks_pct, 82);
  assert.deepEqual(dropped, []);
});

test("form values win over the model's arguments", () => {
  const form = { ...btech, gender: "MALE", marks_pct: 85, disability: false };
  const { args } = prepareEligibilityArgs({ ...btech, marks_pct: 75 }, question, form);
  assert.equal(args.marks_pct, 85);
});

/* ---------------------------------------------------------------- */
/* Made-up scheme ids are rejected, not silently searched around      */
/* ---------------------------------------------------------------- */

test("a made-up scheme id is rejected with the valid list", () => {
  assert.throws(
    () => assertKnownIds(["CSSS"], all),
    (err) => /Unknown scheme_ids: CSSS/.test(err.message) && /css-ug \(Central Sector/.test(err.message),
  );
});

test("real scheme ids pass, and no ids at all is fine", () => {
  assert.doesNotThrow(() => assertKnownIds(["css-ug", "pms-obc"], all));
  assert.doesNotThrow(() => assertKnownIds(undefined, all));
});

/* ---------------------------------------------------------------- */
/* Board percentile: a rank, not a score (from the real CSSS PDF)     */
/* ---------------------------------------------------------------- */

// css-ug as the real guidelines state it: above the 80th percentile of the
// board, no marks rule for applying fresh (50% is the renewal rule).
const cssReal = {
  ...all.find((s) => s.id === "css-ug"),
  eligibility: { ...all.find((s) => s.id === "css-ug").eligibility, min_marks_pct: null, min_board_percentile: 80 },
};
const student = { ...btech, year_of_study: 1, gender: "MALE", marks_pct: 92, disability: false };

test("percentile rule: unknown rank keeps the scheme 'possible', even with high marks", () => {
  const r = evaluateSchemes([cssReal], student);
  assert.equal(r.eligible.length, 0, "92% marks says nothing about the board percentile");
  assert.match(r.possible[0].unchecked.join(), /board_percentile: needs a rank above the 80th percentile/);
  assert.deepEqual(r.missing_fields, ["board_percentile"]);
});

test("percentile rule: a stated rank is checked (above 80 passes, 80 or below fails)", () => {
  assert.equal(evaluateSchemes([cssReal], { ...student, board_percentile: 85 }).eligible.length, 1);
  const r = evaluateSchemes([cssReal], { ...student, board_percentile: 70 });
  assert.match(r.near_misses[0].reason, /above the 80th percentile .* you reported 70th/);
});

test("board_percentile is validated and dropped unless the student talked about rank", () => {
  assert.equal(ProfileSchema.parse({ income: 1, category: "SC", board_percentile: "85" }).board_percentile, 85);
  assert.equal(ProfileSchema.safeParse({ income: 1, category: "SC", board_percentile: 150 }).success, false);
  const said = "I scored 92% in Class 12.";
  assert.deepEqual(prepareEligibilityArgs({ ...btech, board_percentile: 92 }, said, null).dropped, ["board_percentile"]);
  const ranked = "I was in the top 10% of my board.";
  assert.equal(prepareEligibilityArgs({ ...btech, board_percentile: 90 }, ranked, null).args.board_percentile, 90);
});
