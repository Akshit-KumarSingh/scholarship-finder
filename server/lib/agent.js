import OpenAI from "openai";
import { config } from "./config.js";
import { toolSchemas, toolImpls } from "./tools.js";

const client = new OpenAI({
  apiKey: config.llmApiKey,
  baseURL: config.llmBaseUrl,
});

const SYSTEM_PROMPT = `You help Indian students find government scholarships they qualify for.

How to work:
- When the student describes themselves, call check_eligibility first. Never judge eligibility yourself from document text — the tool compares the actual numbers.
- For anything the eligibility fields cannot answer (documents required, application steps, renewal rules, how family income is defined), call search_scheme_docs. Scope it with scheme_ids once you know which schemes matter.
- Use compare_schemes when the student asks which pays more or which closes first.
- You may call several tools, and call them again after seeing results.

How to answer:
- Ground every claim in tool output. If the tools did not return it, say you could not find it rather than guessing.
- Quote or closely paraphrase the relevant clause and name the scheme it came from.
- When a student just misses out, tell them the specific reason from near_misses.
- Amounts in rupees, dates in plain language. Keep it short — students are scanning.
- If a scheme is marked verified:false, note that the figures need checking against the official portal.
- Close by pointing to the official portal for the final word.

Valid scheme_ids are exactly: pms-sc, pms-obc, pms-st, css-ug, aicte-pragati, aicte-saksham, pm-yasasvi, nmms, mcm-minority, ishan-uday, igp-single-girl, up-postmatric, up-dashmottar, up-kanya-sumangala, up-kanya-vidya-dhan. Never invent an id — if you are unsure which scheme the student means, call search_scheme_docs without scheme_ids.`;

export async function runAgent(userMessage, history = []) {
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history,
    { role: "user", content: userMessage },
  ];

  const trace = [];
  const MAX_STEPS = 6;

  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await client.chat.completions.create({
      model: config.llmModel,
      messages,
      tools: toolSchemas,
    });

    const msg = res.choices[0].message;
    messages.push(msg);

    if (!msg.tool_calls?.length) {
      return { answer: msg.content, trace, steps: step + 1 };
    }

    for (const call of msg.tool_calls) {
      let result;
      let args = {};
      try {
        args = JSON.parse(call.function.arguments || "{}");
        console.log("[tool]", call.function.name, JSON.stringify(args));
        const impl = toolImpls[call.function.name];
        if (!impl) throw new Error(`Unknown tool ${call.function.name}`);
        result = await impl(args);
      } catch (err) {
        result = { error: err.message };
      }

      trace.push({
        step: step + 1,
        tool: call.function.name,
        args,
        summary: summarise(call.function.name, result),
      });

      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result),
      });
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
    return `${result.eligible_count} eligible, ${result.near_misses.length} near miss`;
  }
  if (name === "search_scheme_docs") {
    const top = result[0]?.score;
    return `${result.length} chunks, top score ${top ?? "-"}`;
  }
  if (name === "compare_schemes") return `${result.length} schemes`;
  return "ok";
}
