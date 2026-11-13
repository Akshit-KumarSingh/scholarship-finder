import { schemes, vectorSearch } from "./db.js";
import { embed } from "./embed.js";

/* ------------------------------------------------------------------ */
/* Tool schemas — what the model sees                                  */
/* ------------------------------------------------------------------ */

export const toolSchemas = [
  {
    type: "function",
    function: {
      name: "check_eligibility",
      description:
        "Find which scholarship schemes a student qualifies for. Call this first whenever the student describes their situation. Only include fields the student actually stated; leave the rest out (never guess). Returns eligible schemes, 'possible' schemes that need a missing detail, and near-misses with the exact reason they failed.",
      parameters: {
        type: "object",
        properties: {
          income: {
            type: "number",
            description:
              "Annual family income in rupees, e.g. 400000 for 4 lakh. Required.",
          },
          category: {
            type: "string",
            enum: ["GENERAL", "OBC", "SC", "ST", "EWS", "MINORITY"],
          },
          state: {
            type: "string",
            description: "State of domicile as a code, e.g. UP. Only if the student stated it.",
          },
          course_level: {
            type: "string",
            enum: ["UG", "PG", "DIPLOMA", "SCHOOL"],
            description: "Only if the student stated it (B.Tech/B.A./B.Sc = UG).",
          },
          year_of_study: {
            type: "number",
            description: "Only if the student stated it (final year of a 4-year course = 4).",
          },
          gender: {
            type: "string",
            enum: ["MALE", "FEMALE", "OTHER"],
            description: "Only if the student stated it. Never guess.",
          },
          marks_pct: {
            type: "number",
            description:
              "Percentage in last qualifying exam. Only if the student stated it. Never guess.",
          },
          disability: {
            type: "boolean",
            description: "Only if the student stated it. Never guess.",
          },
        },
        required: ["income", "category"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_scheme_docs",
      description:
        "Search the text of scheme documents for things eligibility fields cannot answer: documents required, application and renewal process, how family income is defined, what happens on a repeat year. Scope to scheme_ids whenever you already know which schemes matter.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "What to look for, in natural language",
          },
          scheme_ids: {
            type: "array",
            items: { type: "string" },
            description: "Restrict the search to these schemes",
          },
          section: {
            type: "string",
            enum: ["eligibility", "benefits", "documents", "process"],
            description: "Restrict to one section of the documents",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "compare_schemes",
      description:
        "Fetch structured facts (benefit amount, deadline, authority, apply link) for several schemes side by side. Use when the student asks which pays more or which closes first.",
      parameters: {
        type: "object",
        properties: {
          scheme_ids: { type: "array", items: { type: "string" } },
        },
        required: ["scheme_ids"],
      },
    },
  },
];

/* ------------------------------------------------------------------ */
/* Implementations — plain functions, testable without any LLM         */
/* ------------------------------------------------------------------ */

const inr = (n) => `Rs ${Number(n).toLocaleString("en-IN")}`;

// Compare "up", " UP" and "Up" as the same value.
const norm = (v) => String(v ?? "").trim().toUpperCase();
const known = (v) => v !== undefined && v !== null && v !== "";

/**
 * The core argument of this project lives here.
 *
 * Eligibility is a set of comparisons (income <= ceiling, category in list).
 * Embeddings cannot do comparisons: "income up to 2.5 lakh" and "income up to
 * 8 lakh" are almost identical vectors. So eligibility is checked with exact
 * rules in code, and vector search is reserved for the prose it cannot answer.
 *
 * Every rule ends in one of three states:
 *   pass       the student's value satisfies it
 *   fail       the student's value breaks it        -> goes into `fails`
 *   unchecked  the student didn't give that value   -> goes into `unchecked`
 * An unknown value is never treated as a pass. That used to hide rules such
 * as "80% marks minimum" when the student hadn't mentioned marks.
 */
export function checkScheme(s, profile) {
  const e = s.eligibility || {};
  const fails = [];
  const unchecked = [];

  if (e.income_max != null) {
    if (!known(profile.income)) {
      unchecked.push(`income: ceiling is ${inr(e.income_max)}`);
    } else if (Number(profile.income) > e.income_max) {
      fails.push(
        `income ceiling is ${inr(e.income_max)}, you reported ${inr(profile.income)}`,
      );
    }
  }

  const cats = (e.categories || []).map(norm);
  if (cats.length && !cats.includes("ALL")) {
    if (!known(profile.category)) {
      unchecked.push(`category: open to ${e.categories.join("/")} only`);
    } else if (!cats.includes(norm(profile.category))) {
      fails.push(`open to ${e.categories.join("/")} only`);
    }
  }

  if (s.state && norm(s.state) !== "ALL") {
    if (!known(profile.state)) {
      unchecked.push(`state: restricted to ${s.state} domicile`);
    } else if (norm(s.state) !== norm(profile.state)) {
      fails.push(`restricted to ${s.state} domicile`);
    }
  }

  if (e.course_levels?.length) {
    if (!known(profile.course_level)) {
      unchecked.push(`course_level: for ${e.course_levels.join("/")} students`);
    } else if (!e.course_levels.map(norm).includes(norm(profile.course_level))) {
      fails.push(`for ${e.course_levels.join("/")} students`);
    }
  }

  if (e.year_of_study?.length) {
    if (!known(profile.year_of_study)) {
      unchecked.push(`year_of_study: for year ${e.year_of_study.join(", ")} students`);
    } else if (!e.year_of_study.map(Number).includes(Number(profile.year_of_study))) {
      fails.push(`for year ${e.year_of_study.join(", ")} students`);
    }
  }

  if (e.gender && norm(e.gender) !== "ALL") {
    if (!known(profile.gender)) {
      unchecked.push(`gender: for ${e.gender.toLowerCase()} applicants`);
    } else if (norm(e.gender) !== norm(profile.gender)) {
      fails.push(`for ${e.gender.toLowerCase()} applicants`);
    }
  }

  if (e.min_marks_pct != null) {
    if (!known(profile.marks_pct)) {
      unchecked.push(`marks_pct: needs ${e.min_marks_pct}% minimum`);
    } else if (Number(profile.marks_pct) < e.min_marks_pct) {
      fails.push(
        `needs ${e.min_marks_pct}% minimum, you reported ${profile.marks_pct}%`,
      );
    }
  }

  if (e.requires_disability) {
    if (!known(profile.disability)) {
      unchecked.push("disability: for students with a certified disability");
    } else if (!profile.disability) {
      fails.push("for students with a certified disability");
    }
  }

  return { fails, unchecked };
}

/** Pure function (no database), so tests can run it on schemes.json directly. */
export function evaluateSchemes(all, profile) {
  const eligible = []; // every rule checked and passed
  const possible = []; // nothing failed, but some rules couldn't be checked
  const nearMiss = []; // exactly one rule failed

  for (const s of all) {
    const { fails, unchecked } = checkScheme(s, profile);
    const row = {
      id: s.id,
      name: s.name,
      authority: s.authority,
      benefit_amount: s.benefit_amount,
      deadline: s.deadline,
      apply_url: s.apply_url,
      verified: s.verified === true,
      unchecked,
    };

    if (fails.length === 0 && unchecked.length === 0) eligible.push(row);
    else if (fails.length === 0) possible.push(row);
    else if (fails.length === 1) nearMiss.push({ ...row, reason: fails[0] });
    // 2+ failed rules: not shown
  }

  // Soonest deadline first: a scholarship you find after it closes is useless.
  const byDeadline = (a, b) => String(a.deadline).localeCompare(String(b.deadline));
  eligible.sort(byDeadline);
  possible.sort(byDeadline);

  // Which missing details would settle the "possible" schemes.
  const missing_fields = [
    ...new Set(possible.flatMap((r) => r.unchecked.map((u) => u.split(":")[0]))),
  ];

  return {
    profile_used: profile,
    eligible_count: eligible.length,
    eligible,
    possible,
    near_misses: nearMiss,
    missing_fields,
    note:
      "Eligibility computed from structured fields, not from text similarity. " +
      "'possible' schemes passed every rule that could be checked; ask the student for missing_fields before confirming them.",
  };
}

export async function check_eligibility(profile) {
  const col = await schemes();
  const all = await col.find({}, { projection: { _id: 0 } }).toArray();
  return evaluateSchemes(all, profile);
}

export async function search_scheme_docs({ query, scheme_ids, section }) {
  const [qVec] = await embed([query]);
  let hits = await vectorSearch(qVec, { schemeIds: scheme_ids, section, k: 8 });

  // A filter that matches nothing is worse than no filter — the model may have
  // guessed an id that doesn't exist. Widen the search rather than return empty.
  if (hits.length === 0 && scheme_ids?.length) {
    hits = await vectorSearch(qVec, { section, k: 8 });
  }
  if (hits.length === 0 && section) {
    hits = await vectorSearch(qVec, { k: 8 });
  }

  return hits.map((h) => ({
    scheme_id: h.scheme_id,
    scheme_name: h.scheme_name,
    section: h.section,
    text: h.text,
    score: Number(h.score.toFixed(3)),
  }));
}

export async function compare_schemes({ scheme_ids }) {
  const col = await schemes();
  const rows = await col
    .find(
      { id: { $in: scheme_ids } },
      {
        projection: {
          _id: 0,
          id: 1,
          name: 1,
          authority: 1,
          benefit_amount: 1,
          deadline: 1,
          apply_url: 1,
          state: 1,
          verified: 1,
        },
      },
    )
    .toArray();
  return rows;
}

export const toolImpls = {
  check_eligibility,
  search_scheme_docs,
  compare_schemes,
};
