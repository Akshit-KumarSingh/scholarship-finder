import express from "express";
import cors from "cors";
import { config, assertConfig } from "./lib/config.js";
import { runAgent } from "./lib/agent.js";
import { check_eligibility } from "./lib/tools.js";
import { schemes } from "./lib/db.js";
import { ProfileSchema, ChatSchema, describeError } from "./lib/validate.js";

assertConfig();

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

app.get("/api/health", (_req, res) =>
  res.json({
    ok: true,
    vectorBackend: config.vectorBackend,
    embedProvider: config.embedProvider,
    model: config.llmModel,
  })
);

app.get("/api/schemes", async (_req, res, next) => {
  try {
    const col = await schemes();
    const rows = await col
      .find({}, { projection: { _id: 0, sections: 0 } })
      .sort({ deadline: 1 })
      .toArray();
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

// Direct filter, no LLM. Used by the profile form, and for debugging:
// if this is wrong, the agent has no chance.
app.post("/api/eligibility", async (req, res, next) => {
  const parsed = ProfileSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: describeError(parsed.error) });
  }
  try {
    res.json(await check_eligibility(parsed.data));
  } catch (e) {
    next(e);
  }
});

// `profile` is optional: the form sends it once the student has checked
// eligibility, so the agent works from what they actually entered.
app.post("/api/chat", async (req, res, next) => {
  const parsed = ChatSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: describeError(parsed.error) });
  }
  try {
    const { message, history, profile } = parsed.data;
    res.json(await runAgent(message, history, profile ?? null));
  } catch (e) {
    next(e);
  }
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

app.listen(config.port, () =>
  console.log(`Server on http://localhost:${config.port}  (vector: ${config.vectorBackend}, embed: ${config.embedProvider})`)
);
