/**
 * Run with:  npm run test:unit
 *
 * No database, no LLM, no .env needed. These run the real eligibility rules
 * on data/schemes.json, the input validation, and the agent's guard against
 * invented fields. (test/tools.test.js covers the same rules end to end
 * through MongoDB, plus retrieval.)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { evaluateSchemes } from "../lib/tools.js";
import { ProfileSchema, ChatSchema } from "../lib/validate.js";
import { prepareEligibilityArgs } from "../lib/agent.js";

const all = JSON.parse(
  readFileSync(new URL("../data/schemes.json", import.meta.url), "utf8"),
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
