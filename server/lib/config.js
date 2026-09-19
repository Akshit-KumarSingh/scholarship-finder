import "dotenv/config";

export const config = {
  mongoUri: process.env.MONGODB_URI,
  dbName: process.env.DB_NAME || "scholarships",

  vectorBackend: process.env.VECTOR_BACKEND || "memory",
  atlasVectorIndex: process.env.ATLAS_VECTOR_INDEX || "vector_index",

  embedProvider: process.env.EMBED_PROVIDER || "local",

  llmBaseUrl: process.env.LLM_BASE_URL,
  llmApiKey: process.env.LLM_API_KEY,
  llmModel: process.env.LLM_MODEL || "gemini-2.0-flash",

  port: Number(process.env.PORT || 3000),
};

// Embedding width depends on the provider. Atlas index config must match this
// number exactly or $vectorSearch fails with an unhelpful error.
export const EMBED_DIMS = config.embedProvider === "openai" ? 1536 : 384;

export function assertConfig() {
  const missing = [];
  if (!config.mongoUri) missing.push("MONGODB_URI");
  if (!config.llmApiKey) missing.push("LLM_API_KEY");
  if (missing.length) {
    console.error(`Missing in .env: ${missing.join(", ")}`);
    process.exit(1);
  }
}
