/**
 * Run this first: npm run similarity
 *
 * It prints the evidence for the entire architecture. Two sentences with
 * wildly different income ceilings will score ~0.95 similar. That is why
 * eligibility goes to MongoDB and not to the vector store.
 *
 * Screenshot the output for your README.
 */
import { embed, cosine } from "../lib/embed.js";

const texts = [
  "Family income must not exceed Rs 2,50,000 per annum",
  "Family income must not exceed Rs 8,00,000 per annum",
  "Applicants must be permanent residents of Uttar Pradesh",
  "Documents required: caste certificate, income certificate, bank passbook",
];

const vectors = await embed(texts);

console.log("\nPairwise cosine similarity\n" + "-".repeat(64));
for (let i = 0; i < texts.length; i++) {
  for (let j = i + 1; j < texts.length; j++) {
    const score = cosine(vectors[i], vectors[j]).toFixed(3);
    console.log(`${score}  [${i}] <-> [${j}]`);
  }
}

console.log("\nLegend");
texts.forEach((t, i) => console.log(`  [${i}] ${t}`));

console.log(`
Read the [0] <-> [1] score. Those two sentences differ by 5.5 lakh rupees
and the embedding barely notices, because they mean the same kind of thing.
A student earning 4 lakh matches both equally well, and only one of them
will actually accept the application.

That is the bug this project is built around.
`);

process.exit(0);
