# Scholarship Eligibility Finder

An agentic retrieval system that tells an Indian student which government
scholarships will actually accept their application, and answers questions
about the paperwork from the scheme documents themselves.

Built on MERN, with MongoDB Atlas Vector Search, LLM tool calling, and a
measured evaluation set.

---

## The problem this is built around

A student asks:

> "I'm a final-year B.Tech student, OBC, family income 4 lakh, from UP."

Plain RAG embeds that question and searches the scheme documents. The top hit
is a scheme whose eligibility text reads *"Family income should not exceed
Rs 1,50,000 per annum. Applicable to OBC candidates."* — a near-perfect
semantic match, and a scheme the student is legally barred from.

The reason is structural. An embedding encodes what text is *about*, not what
it *evaluates to*. Run `npm run similarity` and you can see it:

```
Family income must not exceed Rs 2,50,000 per annum
Family income must not exceed Rs 8,00,000 per annum
```

These two score ~0.95 cosine similarity. They differ by five and a half lakh
rupees and the embedding barely notices, because they mean the same kind of
thing. Vector search ranks by closeness; it has no step that asks *is this
true?*

So this project splits the problem:

| Question type | Handled by | Why |
|---|---|---|
| Do I qualify? | MongoDB predicates on structured fields | Comparisons must be exact and auditable |
| What documents do I need? How is income defined? What if I repeat a year? | Vector search over document prose | No filter can answer these |

Structured filtering decides **who is eligible**. Semantic search does the
**explaining**, scoped only to schemes that survived the filter.

---

## Architecture

Retrieval isn't a fixed pipeline here — it's a set of tools the model calls.

```
student message
      │
      ▼
  LLM with three tools ──────────────────────────────┐
      │                                              │
      ├─ check_eligibility(profile)                  │
      │     MongoDB predicates: income <= ceiling,    │ model decides
      │     category in list, domicile, marks floor   │ which to call,
      │     → eligible[] + near_misses[] with reasons │ in what order,
      │                                              │ how many rounds
      ├─ search_scheme_docs(query, scheme_ids, section)
      │     $vectorSearch pre-filtered to those schemes
      │                                              │
      └─ compare_schemes(scheme_ids)                 │
            structured lookup: amount, deadline, link │
      │                                              │
      ▼ ◄────────────────────────────────────────────┘
  grounded answer + tool trace
```

Ask *"I qualify for both — which pays more and which is easier to apply for?"*
and the model calls eligibility once, then searches the benefits section for two
schemes, then the process section for two schemes, then synthesises. That
sequence isn't hardcoded. It decided.

`check_eligibility`'s parameter schema doubles as the profile extractor — the
model fills `income`, `category`, `state` straight from the student's sentence,
so there's no separate parsing step.

---

## Results

Run `npm run eval`. It measures two things on a hand-written set of 15 student
profiles with known-correct answers:

**Structured filtering (this project)**

```
precision            100.0%
recall               100.0%
barred schemes shown 0
```

**Naive vector search baseline** — same profiles, no eligibility filter, top-5
semantic search over the eligibility text:

```
schemes surfaced     75
student not eligible 67 (89.3%)
```

That last percentage is how often plain RAG would have shown a student a
scholarship they cannot apply for.


Plain retrieval put a scholarship the student cannot apply for in front of them
in 89.3% of results. Structured pre-filtering brought that to zero without
losing a single scheme the student did qualify for — recall stayed at 100%.

The eval also runs a correctness suite (`npm test`, 11 assertions) covering the
eligibility predicates, retrieval fallbacks, and chunking.
---

## Stack

| Layer | Choice |
|---|---|
| Frontend | React 18 + Vite |
| Backend | Node 20 + Express |
| Database | MongoDB Atlas |
| Vector search | Atlas `$vectorSearch`, with an in-memory cosine fallback |
| Embeddings | `@xenova/transformers` locally (384d), or OpenAI `text-embedding-3-small` (1536d) |
| LLM | Gemini free tier via its OpenAI-compatible endpoint, or OpenAI |

No LangChain. The retrieval pipeline is about forty lines written directly,
which is the point — every choice in it is one I can explain.

---

## Setup

Full step-by-step in [SETUP.md](./SETUP.md). Short version:

```bash
# 1. Server
cd server
npm install
cp .env.example .env        # add MONGODB_URI and LLM_API_KEY
npm run similarity          # see why this architecture exists
npm run ingest              # load schemes, chunk, embed, store
npm run eval                # measure
npm run dev                 # http://localhost:3000

# 2. Client, in a second terminal
cd client
npm install
cp .env.example .env
npm run dev                 # http://localhost:5173
```

---

## Project layout

```
server/
  lib/
    config.js     provider switches in one place
    embed.js      local or API embeddings behind one interface
    chunk.js      paragraph-aware, section-tagged chunking
    db.js         Mongo + both vector search backends
    tools.js      the three tools: schemas and implementations
    agent.js      the tool-calling loop
  scripts/
    similarity.js the day-one demo: embeddings can't compare numbers
    extract.js    LLM-assisted PDF → structured record (draft, needs verifying)
    ingest.js     chunk, embed, store
    eval.js       precision/recall + the naive-RAG baseline
  data/schemes.json
  eval/profiles.json
  index.js
client/
  src/App.jsx, api.js, styles.css
```

---

## Data accuracy

**The seed data in `data/schemes.json` is unverified placeholder data.** The
scheme names are real; the figures are illustrative so the pipeline has
something to run on.

Before demoing this, open each official document and correct every field, then
set `verified: true`. Use `scripts/extract.js` to draft a record from a PDF, but
check all twelve fields by hand — models slip most often on the lakh-to-rupee
conversion, and a wrong income ceiling silently tells a student they're
ineligible when they aren't. You'd spend two days debugging the pipeline before
thinking to check the data.

Scheme rules also change every academic year. Records carry an `academic_year`
field, and the UI links to the official portal for the final word.

---

## Known limitations

- Small corpus. Ten schemes is enough to demonstrate the filtering argument, not
  enough to be a real product.
- Eligibility fields are a simplification. Real schemes have conditions
  (institution type, admission route, one-scholarship-at-a-time rules) that
  aren't modelled, which is why near-misses report a reason rather than a
  verdict.
- No reranking yet. Retrieving 20 and reranking to 5 with a cross-encoder is
  the obvious next improvement.
- Scanned PDFs with no text layer aren't handled. Those schemes are skipped.
