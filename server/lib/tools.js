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
        "Find which scholarship schemes a student qualifies for. Call this first whenever the student describes their situation. Returns eligible schemes and, separately, near-misses with the exact reason they failed.",
      parameters: {
        type: "object",
        properties: {
          income: {
            type: "number",
            description: "Annual family income in rupees, e.g. 400000 for 4 lakh",
          },
          category: {
            type: "string",
            enum: ["GENERAL", "OBC", "SC", "ST", "EWS", "MINORITY"],
          },
          state: { type: "string", description: "State of domicile, e.g. UP" },
          course_level: { type: "string", enum: ["UG", "PG", "DIPLOMA", "SCHOOL"] },
          year_of_study: { type: "number" },
          gender: { type: "string", enum: ["MALE", "FEMALE", "OTHER"] },
          marks_pct: { type: "number", description: "Percentage in last qualifying exam" },
          disability: { type: "boolean" },
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
          query: { type: "string", description: "What to look for, in natural language" },
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

/**
 * The core argument of this project lives here.
 *
 * Eligibility is a set of comparisons (income <= ceiling, category in list).
 * Embeddings cannot do comparisons — "income up to 2.5 lakh" and "income up to
 * 8 lakh" are ~0.95 cosine-similar. So this runs as a database predicate, and
 * vector search is reserved for the prose it cannot answer.
 */
export async function check_eligibility(profile) {
  const col = await schemes();
  const all = await col.find({}, { projection: { _id: 0 } }).toArray();

  const eligible = [];
  const nearMiss = [];

  for (const s of all) {
    const e = s.eligibility || {};
    const fails = [];

    if (e.income_max != null && profile.income > e.income_max) {
      fails.push(
        `income ceiling is ${inr(e.income_max)}, you reported ${inr(profile.income)}`
      );
    }
    if (e.categories?.length && !e.categories.includes("ALL")) {
      if (!e.categories.includes(profile.category)) {
        fails.push(`open to ${e.categories.join("/")} only`);
      }
    }
    if (s.state && s.state !== "ALL" && profile.state && s.state !== profile.state) {
      fails.push(`restricted to ${s.state} domicile`);
    }
    if (e.course_levels?.length && profile.course_level) {
      if (!e.course_levels.includes(profile.course_level)) {
        fails.push(`for ${e.course_levels.join("/")} students`);
      }
    }
    if (e.year_of_study?.length && profile.year_of_study) {
      if (!e.year_of_study.includes(profile.year_of_study)) {
        fails.push(`for year ${e.year_of_study.join(", ")} students`);
      }
    }
    if (e.gender && e.gender !== "ALL" && profile.gender && e.gender !== profile.gender) {
      fails.push(`for ${e.gender.toLowerCase()} applicants`);
    }
    if (e.min_marks_pct != null && profile.marks_pct != null) {
      if (profile.marks_pct < e.min_marks_pct) {
        fails.push(`needs ${e.min_marks_pct}% minimum, you reported ${profile.marks_pct}%`);
      }
    }
    if (e.requires_disability && !profile.disability) {
      fails.push("for students with a certified disability");
    }

    const row = {
      id: s.id,
      name: s.name,
      authority: s.authority,
      benefit_amount: s.benefit_amount,
      deadline: s.deadline,
      apply_url: s.apply_url,
      verified: s.verified === true,
    };

    if (fails.length === 0) eligible.push(row);
    else if (fails.length === 1) nearMiss.push({ ...row, reason: fails[0] });
  }

  // Soonest deadline first — a scholarship you find after it closes is useless.
  eligible.sort((a, b) => String(a.deadline).localeCompare(String(b.deadline)));

  return {
    profile_used: profile,
    eligible_count: eligible.length,
    eligible,
    near_misses: nearMiss,
    note: "Eligibility computed from structured fields, not from text similarity.",
  };
}

export async function search_scheme_docs({ query, scheme_ids, section }) {
  const [qVec] = await embed([query]);
  const hits = await vectorSearch(qVec, { schemeIds: scheme_ids, section, k: 8 });
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
      }
    )
    .toArray();
  return rows;
}

export const toolImpls = {
  check_eligibility,
  search_scheme_docs,
  compare_schemes,
};
