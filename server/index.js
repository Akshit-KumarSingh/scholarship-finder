import express from "express";
import cors from "cors";
import { config, assertConfig } from "./lib/config.js";
import { runAgent } from "./lib/agent.js";
import { check_eligibility } from "./lib/tools.js";
import { schemes } from "./lib/db.js";

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

// Direct filter, no LLM. Useful for the profile form, and for debugging:
// if this is wrong, the agent has no chance.
app.post("/api/eligibility", async (req, res, next) => {
  try {
    res.json(await check_eligibility(req.body));
  } catch (e) {
    next(e);
  }
});

app.post("/api/chat", async (req, res, next) => {
  try {
    const { message, history = [] } = req.body;
    if (!message?.trim()) {
      return res.status(400).json({ error: "message is required" });
    }
    const result = await runAgent(message, history);
    res.json(result);
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
