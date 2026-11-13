import OpenAI from "openai";
import { config } from "./config.js";
import { toolSchemas, toolImpls } from "./tools.js";
import { ProfileSchema, describeError } from "./validate.js";

// Created on first use, so tests can import this file without an API key.
let client;
const llm = () =>
  (client ??= new OpenAI({ apiKey: config.llmApiKey, baseURL: config.llmBaseUrl }));

const SYSTEM_PROMPT = `You help Indian students find government scholarships they qualify for.

How to work:
- When the student describes themselves, call check_eligibility first. Never judge eligibility yourself from document text — the tool compares the actual numbers.
- Pass check_eligibility ONLY the details the student actually stated. Never guess or assume marks, gender, disability or anything else. Leaving a field out is always better than inventing it.
- check_eligibility returns three groups: eligible (every rule checked and passed), possible (nothing failed, but some rules couldn't be checked because a detail is missing) and near_misses (exactly one rule failed). For "possible" schemes, say which detail is missing (from their unchecked list) and ask the student for it. Never present a "possible" scheme as confirmed.
- For anything the eligibility fields cannot answer (documents required, application steps, renewal rules, how family income is defined), call search_scheme_docs. Scope it with scheme_ids once you know which schemes matter.
- Use compare_schemes when the student asks which pays more or which closes first.
- You may call several tools, and call them again after seeing results.

How to answer:
- Ground every claim in tool output. If the tools did not return it, say you could not find it rather than guessing.
- Only state what the tool output says. Do not add documents, conditions, examples or advice from general knowledge, and do not say "typically" or "usually". If a list in the documents has five items, give those five items.
- Repeat reasons, missing details, numbers and places exactly as the tools give them (for example "needs 80% minimum", "restricted to AS domicile"). Do not reword them: 80% is not the same as the 80th percentile.
- Quote or closely paraphrase the relevant clause and name the scheme it came from.
- When a student just misses out, tell them the specific reason from near_misses.
- Amounts in rupees, dates in plain language. Keep it short — students are scanning.
- If a scheme is marked verified:false, note that the figures need checking against the official portal.
- Close by pointing to the official portal for the final word.

Valid scheme_ids, with the scheme each one means (use the id, not the name, in tool calls):
- pms-sc: Post Matric Scholarship for SC Students
- pms-obc: Post Matric Scholarship for OBC Students
- css-ug: Central Sector Scheme of Scholarship for College and University Students
- aicte-pragati: AICTE Pragati Scholarship for Girl Students
- aicte-saksham: AICTE Saksham Scholarship for Specially Abled Students
- pm-yasasvi: PM YASASVI Scholarship for OBC, EBC and DNT Students
- nmms: National Means cum Merit Scholarship
- up-postmatric: UP Post Matric Scholarship (Other than Intermediate)
- up-dashmottar: UP Dashmottar Scholarship for Minority Students
- up-kanya-sumangala: Mukhyamantri Kanya Sumangala Yojana
- pms-st: Post Matric Scholarship for ST Students
- mcm-minority: Merit cum Means Scholarship for Professional and Technical Courses (Minority)
- ishan-uday: Ishan Uday Special Scholarship for North Eastern Region
- igp-single-girl: Indira Gandhi Scholarship for Single Girl Child (Postgraduate)
- up-kanya-vidya-dhan: UP Kanya Vidya Dhan Yojana
Never invent an id. If you are unsure which scheme the student means, call search_scheme_docs without scheme_ids.`;

/*
 * Safety net for a bug seen on the live site: asked about a student who gave
 * no marks, the model called check_eligibility with marks_pct: 75 that it made
 * up. The prompt now forbids that, but prompts are guidance, not guarantees.
 * So for the three fields the model is most likely to invent, we keep a value
 * only if the student's own words mention that topic. Everything else the
 * model sends is still checked by ProfileSchema.
 *
 * If the student filled in the form, the form wins: those values are what they
 * actually entered, and they override whatever the model sent.
 */
const MENTIONED = {
  marks_pct: /\d\s*%|percent|marks|cgpa|sgpa|grade|scored|score/i,
  gender: /\b(male|female|boy|girl|man|woman|gender|transgender)\b/i,
  disability: /disab|pwd|divyang|handicap|impair|specially.?abled|blind|deaf/i,
};

export function prepareEligibilityArgs(args, statedText, formProfile) {
  if (formProfile) {
    return { args: { ...args, ...formProfile }, dropped: [] };
  }
  const clean = { ...args };
  const dropped = [];
  for (const [field, pattern] of Object.entries(MENTIONED)) {
    if (clean[field] !== undefined && !pattern.test(statedText)) {
      delete clean[field];
      dropped.push(field);
    }
  }
  return { args: clean, dropped };
}

export async function runAgent(userMessage, history = [], formProfile = null) {
  const messages = [{ role: "system", content: SYSTEM_PROMPT }];
  if (formProfile) {
    messages.push({
      role: "system",
      content:
        "The student filled in the eligibility form with these details (stated by them, use them as-is): " +
        JSON.stringify(formProfile),
    });
  }
  messages.push(...history, { role: "user", content: userMessage });

  // Everything the student has said, used to spot invented fields.
  const statedText = [...history.filter((m) => m.role === "user"), { content: userMessage }]
    .map((m) => m.content)
    .join("\n");

  const trace = [];
  const MAX_STEPS = 6;

  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await llm().chat.completions.create({
      model: config.llmModel,
      messages,
      tools: toolSchemas,
      temperature: 0, // least "creative": stick to what the tools returned
    });

    const msg = res.choices[0].message;
    messages.push(msg);

    if (!msg.tool_calls?.length) {
      return { answer: msg.content, trace, steps: step + 1 };
    }

    for (const call of msg.tool_calls) {
      let result;
      let args = {};
      let dropped = [];
      try {
        args = JSON.parse(call.function.arguments || "{}");
        if (call.function.name === "check_eligibility") {
          ({ args, dropped } = prepareEligibilityArgs(args, statedText, formProfile));
          const parsed = ProfileSchema.safeParse(args);
          if (!parsed.success) throw new Error(describeError(parsed.error));
          args = parsed.data;
        }
        console.log("[tool]", call.function.name, JSON.stringify(args),
          dropped.length ? `(dropped unstated: ${dropped.join(", ")})` : "");
        const impl = toolImpls[call.function.name];
        if (!impl) throw new Error(`Unknown tool ${call.function.name}`);
        result = await impl(args);
        if (dropped.length) {
          result.dropped_unstated_fields = dropped; // tell the model what we removed
        }
      } catch (err) {
        result = { error: err.message };
      }

      trace.push({
        step: step + 1,
        tool: call.function.name,
        args,
        ...(dropped.length ? { dropped } : {}),
        summary: summarise(call.function.name, result),
      });

      // Document text goes back with the grounding rule right beside it:
      // models follow an instruction next to the data more reliably than one
      // at the top of a long system prompt.
      const content =
        call.function.name === "search_scheme_docs" && Array.isArray(result)
          ? JSON.stringify({
              chunks: result,
              answer_rule:
                "Answer only from these texts. List exactly what they say, in their words. " +
                "Add nothing from general knowledge (no extra documents, authorities, formats or eligibility rules).",
            })
          : JSON.stringify(result);

      messages.push({ role: "tool", tool_call_id: call.id, content });
    }
  }

  return {
    answer:
      "I could not finish this within the step limit. Try asking about one scheme at a time.",
    trace,
    steps: MAX_STEPS,
  };
}

function summarise(name, result) {
  if (result?.error) return `error: ${result.error}`;
  if (name === "check_eligibility") {
    return `${result.eligible_count} eligible, ${result.possible.length} need more info, ${result.near_misses.length} near miss`;
  }
  if (name === "search_scheme_docs") {
    const top = result[0]?.score;
    return `${result.length} chunks, top score ${top ?? "-"}`;
  }
  if (name === "compare_schemes") return `${result.length} schemes`;
  return "ok";
}
