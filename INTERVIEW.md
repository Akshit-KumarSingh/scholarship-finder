# Interview prep

Questions you will be asked about this project, and the shape of a good answer.
Practise these out loud.

## "Walk me through what happens when a student asks a question."

Trace one real request end to end. Name the tools, say which fires first and
why, mention that the model chooses the sequence rather than you hardcoding it.
Don't say "LangChain handled it" — you wrote every line, so use that.

## "What is an embedding?"

Text mapped to a vector where similar meaning lands nearby. Then immediately go
to your own evidence: the two income sentences scoring 0.95. Concrete beats
definitional.

## "Why not just put everything in the vector store?"

The core answer. Embeddings do similarity; eligibility needs comparison. Those
are different operations. `income <= 250000` is a boolean evaluated against a
value, and vector search has no evaluation step at all — it ranks by closeness
and returns the top k. Nothing ever asks "is this true?"

Follow up with: you could hand all ten schemes to the LLM and ask it to judge,
and it would mostly work. "Mostly" is the problem — it'll misread a figure
occasionally and you'd have no way to know which answer was wrong. A MongoDB
predicate is right every time, costs nothing, and is auditable.

## "How did you choose your chunk size?"

Never say "I read that 1000 was good." Say what you measured: fixed-character
slicing cut rules mid-sentence, so you moved to paragraph-aware chunking with
one paragraph of overlap, and section tags so a documents question searches only
documents. Then cite the eval delta.

## "What's your biggest failure mode?"

Retrieval misses, not generation. Explain how you diagnosed it: you log the
retrieved chunks and read those before looking at the answer, because if the
right chunk isn't in the top k the LLM cannot save you.

## "Why is RAG better than fine-tuning here?"

Cheaper, updates the moment a scheme changes, produces citations, needs no
training data. For something with real consequences, a student has to be able to
verify a claim against the official document — a fine-tuned model can't show its
source.

## "How does vector search find neighbours fast?"

Exact search is O(n) over every vector. Production systems use approximate
nearest neighbour indexes like HNSW, which trade a little recall for a lot of
speed. Then the sharp bit: filtered ANN search prunes before returning, so an
aggressive filter with low `numCandidates` can return fewer results than
requested or miss good ones. That's why the code uses `max(100, k * 20)`.

## "What would you do with 10 million documents?"

Metadata filtering first to cut the candidate set, then reranking on what
survives, then caching for repeated queries. And you'd need a real eval set
before any of it, because at that scale you can't eyeball results.

## "What's the weakest part?"

Answer honestly — it reads better than a deflection. Ten schemes is a small
corpus. The eligibility model simplifies real rules (institution type, admission
route, one-scholarship-at-a-time conditions aren't captured). No reranking yet.
Then say what you'd do next and why.

## "How do you handle stale data?"

Scheme rules change every academic year, so records carry an `academic_year`
field and re-ingestion is a rerun of the pipeline rather than a rewrite. The UI
links to the official portal for the final word, and unverified records are
flagged in the interface rather than presented as fact.

## The thing to lead with

"Naive retrieval returned schemes the student was legally barred from, because
embeddings can't compare numbers. I moved eligibility into structured MongoDB
fields, pre-filtered on those, and ran vector search only over what survived.
On my eval set that took X to Y."

That's a systems answer, not a tutorial answer.
