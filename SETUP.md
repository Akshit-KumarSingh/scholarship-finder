# Setup

Everything here is free. No card needed anywhere.

---

## 1. Install Node 20+

```bash
node -v    # must be 20 or higher
```

If it's older, install from nodejs.org or via nvm. The project uses top-level
`await` and ES modules, which need 20.

---

## 2. MongoDB Atlas (free M0 cluster)

1. Sign up at mongodb.com/cloud/atlas. No card required for M0.
2. **Create a cluster** → choose **M0 Free** → pick the region closest to you.
3. **Database Access** → Add New Database User. Username and password, and save
   the password somewhere. Give it "Read and write to any database".
4. **Network Access** → Add IP Address → **Allow access from anywhere**
   (`0.0.0.0/0`). Fine for a student project; tighten later if you deploy.
5. **Connect** → **Drivers** → **Node.js**. Copy the connection string. It looks
   like:
   ```
   mongodb+srv://USER:<password>@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority
   ```
   Replace `<password>` with the actual password. If your password has special
   characters, URL-encode them (`@` becomes `%40`).

That string goes in `MONGODB_URI`.

---

## 3. Gemini API key (free tier)

1. Go to aistudio.google.com/apikey.
2. Sign in with a Google account → **Create API key**.
3. Copy it. No card, no billing setup.

That goes in `LLM_API_KEY`.

**If you'd rather use OpenAI:** it needs a $5 minimum prepaid top-up and an
international card. Actual usage for this project runs under $3 for the month.
Swap the three LLM lines in `.env` as shown in `.env.example`.

---

## 4. Server

```bash
cd server
npm install
cp .env.example .env
```

Open `.env` and fill in `MONGODB_URI` and `LLM_API_KEY`. Leave the rest as-is —
the defaults use local embeddings and the in-memory vector backend, both of
which work immediately.

### First run: see the problem

```bash
npm run similarity
```

The first run downloads ~90MB of embedding model weights, then works offline.
Read the output — the 0.95 score between the two income sentences is the
justification for the whole architecture. Screenshot it for your README.

### Load the data

```bash
npm run ingest
```

Should print something like:

```
schemes: 10 inserted
chunks: 40 to embed (384 dims)
  embedded 40/40
```

### Measure

```bash
npm run eval
```

You'll get precision and recall for the structured filter, plus the naive-RAG
baseline showing how often plain semantic search returns a barred scheme. Put
both blocks in your README.

### Run it

```bash
npm run dev
```

Check it's alive:

```bash
curl http://localhost:3000/api/health
```

---

## 5. Client

Second terminal:

```bash
cd client
npm install
cp .env.example .env
npm run dev
```

Open http://localhost:5173.

---

## 6. Switching to real Atlas Vector Search

The in-memory backend computes cosine similarity in Node. It's exact and fine
for this corpus size, and it lets you build everything before wrestling with
index config. But `$vectorSearch` is what you want on your resume, so switch
once the rest works.

1. Atlas → your cluster → **Atlas Search** tab → **Create Search Index**.
2. Choose **JSON Editor**, then **Vector Search** (not the default Search).
3. Database `scholarships`, collection `chunks`, index name `vector_index`.
4. Paste this:

```json
{
  "fields": [
    {
      "type": "vector",
      "path": "embedding",
      "numDimensions": 384,
      "similarity": "cosine"
    },
    { "type": "filter", "path": "scheme_id" },
    { "type": "filter", "path": "section" }
  ]
}
```

5. Create it and wait for status **Active** (a minute or two).
6. In `.env`, set `VECTOR_BACKEND=atlas`.
7. Restart the server and re-run `npm run eval`. Numbers should match the
   in-memory run closely.

### Three things that will bite you here

**`numDimensions` must match your embeddings.** 384 for local
`all-MiniLM-L6-v2`, 1536 for OpenAI `text-embedding-3-small`. Mismatch gives an
unhelpful error.

**A `filter` field must be declared in the index** before you can filter on it
in `$vectorSearch`. Miss it and the filter silently does nothing — your
retrieval looks broken while your code looks correct. This is the confusing bug
to watch for.

**`numCandidates` matters when the filter is narrow.** ANN search prunes before
returning, so with an aggressive filter a low `numCandidates` can return fewer
results than requested or miss good ones. The code uses `max(100, k * 20)`.
That tradeoff is a good interview answer — know it.

---

## 7. Adding real scheme data

```bash
mkdir server/pdfs
# download the official scheme PDF into it, then:
cd server
node scripts/extract.js ./pdfs/up-postmatric.pdf up-postmatric
```

It writes `data/draft-up-postmatric.json` and prints the fields to check.

**Verify all twelve by hand against the PDF.** Ten schemes × twelve fields = 120
values. It's boring and takes an afternoon and there's no clever way around it.
Then paste the record into `data/schemes.json`, set `verified: true`, and
re-run `npm run ingest`.

Hard cap at ten schemes. The eval numbers are what matter, not corpus size, and
this is the stage where projects quietly die from tedium.

---

## 8. Deploy

**Backend → Render.** New Web Service, connect your repo, root directory
`server`, build `npm install`, start `npm start`. Add every `.env` variable in
the Environment tab. Note that local embeddings download model weights on first
run, so the free instance's cold start will be slow — consider
`EMBED_PROVIDER=openai` in production if that bothers you.

**Frontend → Vercel.** Import the repo, root directory `client`, framework
Vite. Set `VITE_API_URL` to your Render URL.

**Database → Atlas**, already hosted.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `Missing in .env` on startup | `MONGODB_URI` or `LLM_API_KEY` not set |
| `MongoServerError: bad auth` | Password not URL-encoded, or `<password>` placeholder left in |
| Connection hangs | IP not whitelisted in Network Access |
| `Expected 384-dim vectors, got 1536` | `EMBED_PROVIDER` changed without re-running `npm run ingest` |
| Atlas returns nothing | Index not Active yet, or name doesn't match `ATLAS_VECTOR_INDEX` |
| Filter appears ignored | `filter` path not declared in the index JSON |
| 429 from the LLM | Free tier rate limit. Increase the delay in `scripts/ingest.js` |
| Empty text from a PDF | Scanned image, no text layer. Skip that scheme |
