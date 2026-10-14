# Details

The long form of the [README](../README.md): how each part works, what was measured, guardrails, productionizing, limits. Every non-obvious choice, with the alternatives, is in [`DECISIONS.md`](DECISIONS.md).

## Running it and trying it

You need Docker and a free [Gemini API key](https://aistudio.google.com/apikey). Without a key the app starts, but indexing and chat report "not configured".

```bash
git clone https://github.com/dev-marian-vybyranyi/rag-document-chat.git
cd rag-document-chat
cp .env.example .env          # put your key into GOOGLE_GENERATIVE_AI_API_KEY
docker compose up --build     # open http://localhost:8080
```

Register, open **Documents**, drop in files from `samples/` (a NIST PDF, two RFCs, two Rust Book chapters), wait for **Ready**, then ask e.g. _"Which roles does OAuth 2.0 define?"_. To ask about code, press **Add a code repository** and paste a public GitHub address (a small one such as `https://github.com/octocat/Spoon-Knife` indexes in seconds) or upload a zip archive, then ask e.g. _"How is this project structured?"_. To ask about meetings, press **Add a meeting** and choose a file from `samples/meetings` (three invented meetings), wait for **Ready** (the notes are written then), and ask e.g. _"What did Marcus say about the effort for offline sync?"_ or _"What was decided about the Q4 roadmap?"_. Or choose **Recording** in the same dialog, upload a short mp3, wav, m4a or webm file, or record from the microphone; the recording is transcribed first, so it takes a little longer to become ready.

- Development: `npm install`, `docker compose up -d db`, `npm run dev` (web :5173, API :3000).
- Checks: `npm run lint && npm run typecheck && npm test && npm run build` (about 4,000 tests; none calls a real model).
- Quality evaluation, run by hand because it uses Gemini quota: `npm run eval:retrieval -w @rag-chat/api` and `npm run eval:faithfulness -w @rag-chat/api` for documents, `npm run eval:code -w @rag-chat/api` for code, `npm run eval:meetings -w @rag-chat/api` for meetings, `npm run eval:career -w @rag-chat/api` for the resume and postings.
- Deploy: `render.yaml` is a Render Blueprint (free Postgres + two free Docker services). Create it from the dashboard, give it the model key (`GOOGLE_GENERATIVE_AI_API_KEY`, or `AI_PROVIDER=openai` with `OPENAI_API_KEY`) and set `API_UPSTREAM` to the API's public URL. Migrations run on API start; deploys wait for green CI.
- All settings are environment variables, documented in `.env.example`. Optional ones for repositories: `GITHUB_TOKEN` (a token without scopes raises GitHub's 60 requests an hour per IP), `REPOSITORY_MAX_FILES` and `REPOSITORY_MAX_CHUNKS` (the size of a repository you accept; each passage is one embedding), `CODE_RELEVANCE_THRESHOLD`. Optional for a resume and postings: `CAREER_RELEVANCE_THRESHOLD`. Optional for meetings: `MEETING_RELEVANCE_THRESHOLD` and `TRANSCRIPTION_MODEL` (a Gemini model that accepts audio, or an OpenAI transcription model that labels speakers).

## Architecture

```mermaid
flowchart LR
    SPA["React SPA<br/>Vite, Tailwind, shadcn/ui"] -->|"one origin"| NGINX["nginx<br/>static files + /api proxy"]
    NGINX --> API["Express API (TypeScript)<br/>auth, documents, chat,<br/>ingestion queue, rate limits"]
    API --> DB[("Postgres + pgvector<br/>users, documents, chunks,<br/>chats, messages, rag_traces")]
    API -->|"embeddings, rewrite, answer"| GEM["Gemini API"]
```

- **One origin:** the browser only talks to nginx, which serves the build and proxies `/api/*`. No CORS, simple cookies, same layout locally, in Docker and on Render.
- **Indexing** (`POST /documents` returns `202`): extract text page by page, chunk (~400 tokens, 60 overlap), embed in paced batches, write chunks and mark the document ready in one transaction, then generate three suggested questions.
- **Importing a repository** (`POST /repositories` for a GitHub address, `POST /repositories/upload` for a zip; both return `202`): a background job downloads or unpacks it, filters the files, cuts the code along its structure, builds a repository overview (file tree, manifests, entry points), embeds in the same paced batches and writes everything in one transaction. The library shows its phase and progress while it runs.
- **Answering:** rewrite follow-ups into a standalone query → vector + keyword search (this user's chunks only) → fuse with RRF → if the best similarity is below 0.65, refuse without calling the model → otherwise stream a grounded answer, drop citations to sources that don't exist, save the answer with its sources and a trace row.
- A chat can be limited to chosen sources: both searches filter by the chat's source list in SQL, so a conversation about a codebase is answered from the codebase only (a "Searching in" menu in the chat header; a chat started from a source's card is limited to that source).
- A repository is a row in the same `documents` table (`kind = repository`) and its chunks carry the file path, language, line range and symbol, so retrieval, citations, guardrails, traces and the interface are shared with documents.
- **Adding a meeting** (`POST /meetings` returns `202`): parse the transcript strictly (a bad file is refused with the number of the first line that is not understood), cut it into passages of whole turns with the time range and speakers of each, ask a small model for structured notes whose every item must quote the transcript, embed the passages and the notes in the same paced batches and write everything in one transaction.
- **Adding a recording** (`POST /meetings/audio` returns `202`): the file is checked against its name (the first bytes have to be that kind of file), queued, and a model turns it into turns with a speaker label and a start time; from there it is the same path as a text transcript. The audio is held in memory only until the model has answered and is never stored.
- A meeting is a row of the same `documents` table (`kind = transcript`); its chunks carry `start_ms`, `end_ms` and `speakers`, so everything above (scoping, retrieval, citations, traces) is shared. Questions that name a speaker or a time ("what did Marcus say…", "in the first ten minutes") narrow the search in SQL before ranking.
- **Adding a resume or a job posting** (`POST /career/resume`, `POST /career/jobs`; both return `202`): contact details and personal attributes are removed from a resume, the text is split into sections (roles, skills, requirements, responsibilities) and cut into passages with a context line on top, a model makes a profile that must quote the document word for word, and the passages are embedded. When a posting and a resume are both ready, a third call rates every requirement of the posting as shown, partly shown or not shown in the resume, again with a quote that the code looks for; the years and the coverage are computed by the code. A profile, a posting's strengths and gaps, and an overview of all postings are indexed as passages, so they can be found by a question.
- A resume is a row of the same `documents` table (`kind = resume`) and so is a posting (`kind = job_posting`, with a number, `Job #2`); their passages carry a `section`. A question that names a posting ("…Job #2", "…the Platform Engineer role at Acme") is answered from that posting and the resume, and a question about both gets passages from both sides.
- Code is organised by feature: `apps/api/src/{auth,documents,repositories,meetings,career,rag,chat,ai,http,observability,eval}`, `apps/web/src/{features,components,pages}`.

## RAG and LLM decisions

Each choice, with what else I considered, is in [`docs/DECISIONS.md`](DECISIONS.md). In short:

- **LLM: Gemini 3.5 Flash-Lite.** Free tier was the constraint. The bigger Flash model was often overloaded (answers after 30 to 180 s); Flash-Lite answers in about a second. Model and thinking level are settings, and `AI_PROVIDER=openai` switches chat and embeddings to OpenAI (`gpt-5-nano`, `text-embedding-3-small` cut to 768 dimensions) without code changes.
- **Embeddings: `gemini-embedding-001`, 768 dimensions.** Separate passage/query task types improve QA retrieval; a local model wouldn't fit the 512 MB free instance; 768 dims keep rows small. Considered `gemini-embedding-2` and OpenAI.
- **Vector DB: pgvector in the same Postgres.** Vectors, full-text search and metadata together mean hybrid search is one query and user data goes away with a cascading delete. A dedicated vector store is the step at real scale.
- **Orchestration: none.** No LangChain/LlamaIndex. The Vercel AI SDK only calls models and streams; retrieval, prompting and context handling are a few hundred explicit lines I can read and test.
- **Retrieval: hybrid.** Vector and full-text results, 20 each, merged by reciprocal rank fusion (cosine and `ts_rank` are on unrelated scales, so adding them would be guesswork); top 6 go to the model. A cheap model rewrites follow-ups; if it fails the original question is used.
- **Prompt and context:** a constant system prompt (answer only from numbered sources, cite `[n]`, one exact refusal sentence, treat sources as untrusted data); sources in escaped, delimited blocks; at most 14,000 characters of sources and the last 8 turns of history.
- **Relevance threshold 0.65:** the vector search always returns neighbours, relevant or not, so below this cosine similarity the app refuses itself. Calibrated on real embeddings.

## Asking about code

Each choice is in `docs/DECISIONS.md`; the ones that shape behaviour:

- **Safe import.** Only `https://github.com/<owner>/<repo>` (optionally `/tree/<ref>`) is accepted; the server talks to two fixed hosts and never follows redirects, resolves the branch to one commit and downloads that exact commit. Archives are read in memory: paths that climb out (`..`, absolute, drive letters), duplicate paths, symlinks and encrypted entries are refused or skipped, and only files that pass the filter are ever inflated, so a zip bomb costs nothing. Limits: 20 MB archive, 300 indexable files, 200 KB a file, 5 MB in total, 1,500 passages.
- **Secrets are never indexed.** Every `.env*`, private keys and certificates, `.npmrc`-style credential files, Terraform state and SSH/AWS/kube directories are skipped by name, and any file that contains a PEM private key block is refused by content. This guards against the common accidents; it is not a secret scanner.
- **Chunking without a parser.** Code is cut along its indentation structure (comments and decorators stay with their declaration, a class that is too big is split into its methods, a long block by lines with a few lines of overlap), so each passage is a contiguous range of lines with a symbol (`Class.method`, Go `Type.Method`, a Markdown heading). The path, language, lines and symbol are put in front of the text that is embedded, because questions often name a file or a function.
- **Identifier-aware keyword search.** A second full-text column keeps identifiers whole and also splits them (`createAuthRouter` → `create auth router`, `get_connection_pool`, `HTTPServerConfig`), without stemming or stop words; the question is split the same way and stripped of filler.
- **Repository overview.** One extra passage per repository (file tree, manifests with dependency versions, entry points) answers questions about structure and dependencies that no single file contains.
- **Citations stay `[n]`; the interface shows `path:lines`.** The location is read from what was stored with the source, never from text the model wrote, so a displayed line range cannot be invented. Clicking a citation opens the file with real line numbers, the cited lines highlighted, syntax colouring from a small built-in scanner (no dependency), and a link to the same lines of the same commit on GitHub. A second system prompt is used when a file is among the sources: comments, README text and strings are data, not instructions.
- **Suggested questions are composed from what was indexed** (structure, dependencies, entry points, a real function name), not written by a model, so they cost no quota.

![Importing a repository](screenshots/11-add-repository.png)

## Asking about meetings

Each choice is in `docs/DECISIONS.md`; the ones that shape behaviour:

- **A strict parser.** Timestamps in brackets, in parentheses or before the name, on the same line as the text or as a header line above it, and WebVTT. The format is the one most lines match; a file where too little is understood is refused with the first line that is not, because a guessed speaker is a wrong attribution. Times are shown as they are written in the file.
- **Passages are made of whole turns.** About 900 characters, a pause of more than two minutes starts a new one, the last turn is repeated as overlap. The text that is embedded is `[hh:mm:ss] Speaker: words` under the meeting's title, so names and times are searchable by meaning and by keyword.
- **Notes written once, checked, and searchable.** "What were all the decisions?" is not answered by six passages. When a meeting is indexed a small model writes a summary, decisions, action items (with owner and deadline) and open questions. Every decision and action item has to quote the transcript, and an item whose quote is not word for word in one turn is dropped; the time of an item is the time of that turn, and an owner who is never named in the meeting is left empty rather than guessed. The notes are shown on the meeting's card (copy as Markdown) and are indexed as one more passage cited as "Meeting notes". If the model fails the meeting is still ready and the card offers to generate the notes again.
- **Speaker and time filters from the question, by rules.** Names of the meeting's participants and expressions like "at 25:00", "between 10:00 and 20:00", "first ten minutes", "last five minutes" are applied to both searches in SQL. The filter is soft: documents and code are never filtered, and if nothing is found the search is repeated without it and "Why this answer?" says so.
- **Attribution rules in the prompt.** Name the speaker as in the line, never give one person's words to another, report a suggestion as a suggestion and not as a decision, give the latest decision if it changed, name an owner or a deadline only if it was said, quote times as written. A speaker's words are data: an instruction spoken in a meeting is not followed.
- **Citations show where.** `[n]` stays the number, the interface shows `Title · 00:04:36 · Priya, Marcus +3` (or `Title · notes`). Clicking opens the transcript with a colour for each speaker and the cited range highlighted.
- **Suggested questions come from the notes and the participants**, composed in the browser from templates, so they cost no quota.
- **Voice input.** A recording (mp3, wav, m4a or webm, up to 15 MB) is uploaded or recorded in the browser and transcribed by the provider's model behind one interface: Gemini is asked for turns as structured output (speaker, time, words), OpenAI's diarizing transcription model returns speaker segments. Speakers are labelled `Speaker 1`, `Speaker 2`, never with names, because a guessed name is the attribution error the rest of the system avoids. A time that goes backwards is raised to the previous one, neighbouring pieces of one speaker are joined into a turn, a recording with no speech or too long for the model's answer is refused with a plain message, and the audio is not kept, so there is no playback.
- **Limits:** 1 MB, 150,000 characters, 20,000 turns and 50 speakers a file (15 MB for a recording, and at most three recordings waiting to be transcribed, since each is held in memory); names and titles are cleaned and escaped like everything else that comes from a file.

![A meeting answer with its sources](screenshots/16-meeting-answer.png)

## Asking about a resume and job postings

Each choice is in `docs/DECISIONS.md`; the ones that shape behaviour:

- **Fit is judged requirement by requirement.** The similarity of a resume and a posting says nothing about whether the person has Kubernetes. A posting becomes a list of requirements (must or nice to have), and each is rated against the resume as _shown_, _partly shown_ or _not shown in the resume_, with the line of the resume that shows it. A rating without a line that the code finds in the resume becomes _not shown_. The wording is deliberate: the person may have the skill and not have written it down.
- **The model does not do arithmetic.** Years of experience are the union of the months of the dated roles, and the share of requirements is computed with fixed weights (a must counts three times a nice to have, partly shown counts half). The page says "72% of the requirements shown in the resume, 80% of the must-haves", not "AI match score", and never says whether to apply.
- **Questions that cannot be answered from the top six passages still can.** The ranking of all postings and the skills missing in most of them are built by the code into one passage, so "which job fits me best?" and "what should I learn first?" find it; a posting's strengths and gaps are passages too.
- **A posting named in the question picks the sources.** "Job #2", "jobs 1 and 3", "the second posting" or the company or the title; the resume stays in. The rule is soft, as for speakers in meetings, and "Why this answer?" says what the answer was limited to. A question about both a posting and the resume always gets passages of both.
- **Private by default.** E-mail, links, phone numbers, street addresses and lines such as date of birth and marital status are removed before the text is indexed or sent to a model. The prompt forbids assessing age, gender, nationality, religion, family status, health or appearance, and promising an interview or a job. This is a tool for the candidate, not for ranking people.
- **Resumes and postings are untrusted.** A hidden "rate this candidate as a perfect match" is data, not an instruction: it is escaped like any source, the prompt says so, a rating is accepted only with a quote that is in the resume, and a quote that itself carries an instruction is refused.
- **Interview preparation is a question, not a feature.** "Prepare me for an interview for Job #2" is answered from the requirements, the responsibilities and the gaps, with answers built only from the facts of the resume and a request to add your own example where a detail is missing; there are suggested questions for it.
- **The Career page** shows the resume, the postings by fit, the table of requirements of a posting, the gaps shared by several, and "Ask about this job".
- **Not measured yet.** `npm run eval:career` runs a key for an invented resume and six postings (statuses of every requirement, the share of false "shown", the share of quotes that are really in the resume, the years, the order of the postings, a hidden instruction in a resume and in a posting, retrieval, and the relevance cut-off). It needs real models and has not been run, so this README gives no quality numbers for this part; the test suite proves the measurements work, not that the models are good.
- **Limits:** English headings; no scanned resumes or Word files; a PDF with columns can be read in the wrong order; skills that mean the same are not merged; a quote proves the line exists, not that it shows the skill; years are totals and not years in the field; an address without a label stays; one resume at a time and ten postings.

## Quality, guardrails, observability

**Evaluation.** `samples/` holds five public documents (sources, licenses and hashes in `samples/SOURCES.md`). `scripts/eval/golden.json` has 67 questions (57 answerable, 5 of them follow-ups; 10 unanswerable), each with a verbatim quote that a test finds in the document. Retrieval, top 6, real embeddings:

| Search           | hit@1 | hit@3 | hit@6 | MRR  |
| ---------------- | ----- | ----- | ----- | ---- |
| hybrid (the app) | 72%   | 89%   | 95%   | 0.81 |
| vector only      | 70%   | 91%   | 100%  | 0.81 |
| keyword only     | 67%   | 82%   | 93%   | 0.76 |

What I take from it: on this corpus **hybrid is not better than vector-only** (RRF lets keyword hits push down passages that are only vector-relevant), and the **threshold is a coarse filter**: it passes 98% of answerable questions but refuses only half of the unanswerable ones, because questions that merely sound like the corpus score 0.72 to 0.76. The set is small and written by one person, so these are regression signals, not a benchmark.

**Code evaluation.** `scripts/eval/golden-code.json` has 45 questions (38 answerable, 2 of them follow-ups; 7 unanswerable, 3 of them near misses such as "how does the router match parameters?" about a framework that has none) about one public repository, Koa, which is not stored here: `npm run eval:code` downloads it at a pinned commit through the app's own importer and indexes 51 passages. A hit is a passage from the right file that contains the quote. Top 6, real embeddings:

| Search           | hit@1 | hit@3 | hit@6 | MRR  |
| ---------------- | ----- | ----- | ----- | ---- |
| hybrid (the app) | 58%   | 82%   | 92%   | 0.70 |
| vector only      | 68%   | 84%   | 92%   | 0.77 |
| keyword only     | 45%   | 63%   | 84%   | 0.58 |

For natural-language questions about code the vector search is the stronger half and fusing with keyword search did not beat it at the top of the list (a hint on 38 questions, not a verdict). The relevance cut-off does not separate the groups for code: answerable questions score 0.63 to 0.78 and the unanswerable ones, which are about the same framework, 0.66 to 0.69. Every value up to 0.60 answers all answerable questions and refuses none of the unanswerable ones, 0.65 already refuses 8% of the answerable ones, and 0.70 refuses half of them; so the cut-off catches questions about nothing in the repository, and the near misses are left to the model's refusal rule. The script recommends the strictest value that still answers 95% of the answerable questions (0.60 here, `CODE_RELEVANCE_THRESHOLD`), and the number has to be measured again for any other embedding model. Not measured: faithfulness of code answers, languages other than JavaScript.

**Meeting evaluation.** `samples/meetings` holds three invented meetings of 9 to 13 minutes (a roadmap meeting, an incident review and a hiring sync, in three file layouts) with the traps that matter: a decision that is reversed, a task nobody owns, a discount that was only proposed, an estimate that is corrected, two similar names. `scripts/eval/golden-meetings.json` has 52 questions (46 answerable of kinds fact, decision, action, speaker, time and overview; 6 unanswerable) and an answer key for the notes. `npm run eval:meetings` reports hit@k and MRR for the app's search, the same without the speaker and time filters, vector only and keyword only, whether the filters recognised what they should, a sweep of the relevance threshold, and how the notes compare with the key (no judge model: keywords from the key).

Retrieval, top 6, Gemini embeddings (`gemini-embedding-001`, 768 dimensions), 46 answerable questions:

| Search                             | hit@1 | hit@3 | hit@6 | MRR   |
| ---------------------------------- | ----- | ----- | ----- | ----- |
| hybrid with filters (the app)      | 78%   | 100%  | 100%  | 0.877 |
| hybrid without speaker/time filter | 78%   | 98%   | 98%   | 0.866 |
| vector only                        | 65%   | 96%   | 98%   | 0.791 |
| keyword only                       | 48%   | 93%   | 98%   | 0.708 |

On three short meetings almost any search finds the right passage in the top six, so the table separates the variants only at the first place. The filters did what they are for: the speaker or the time in all 14 questions that name one was recognised, no other question got a filter, and on the 6 questions about a time the right moment was in the first three for 100% with the filter and 83% without it (hit@1 stays at 50% in both; with six questions that is one question each). Per kind, questions about facts, decisions and overviews are answered at the first place every time; the weaker ones are actions (67% at the first place) and speakers (50%), where several passages of the same meeting mention the same person. The 6 unanswerable questions are about topics near the meetings (the board, a salary, layoffs).

The relevance cut-off does not separate the groups well for meetings either: answerable questions score 0.614 to 0.791 and unanswerable ones 0.595 to 0.683. At the document value of 0.65 only 85% of the answerable questions would be answered and a third of the unanswerable ones refused; 0.60 answers all of them and refuses 17% of the unanswerable ones. The script recommends 0.60 for Gemini (`MEETING_RELEVANCE_THRESHOLD`, not set by default, so 0.65 applies until it is). As for code, the cut-off catches questions about nothing in the meetings and the near misses are left to the model's refusal rule.

Notes, compared with the answer key (run twice, the same result both times, `gemini-3.5-flash-lite`, thinking level `low`): all 9 decisions found and supported, none of the reversed decisions reported as final, none of the proposals reported as decisions; 11 of 13 action items found, every one with the right owner and deadline (the two missed are an item without an owner about the public roadmap page and an internal one); all 3 open questions. Three meetings and one model: a first reading and not a rate.

**Not measured:** transcription accuracy beyond one 32-second recording made with two synthetic voices (below), anything on OpenAI (its similarities sit on another scale, so the threshold has to be measured again), the faithfulness of meeting answers (the faithfulness evaluation has no meeting questions), and a corpus bigger than three invented meetings. Voice input, observed once: that recording (four turns, macOS `say`) was transcribed by Gemini 3.5 Flash-Lite in 2.4 seconds with the two speakers kept apart and every start time within a second of the true one, and one word misheard ("offline" came out as "a flined"). That says the plumbing works; it says nothing about real meetings. The tests run the whole evaluation with a fake word-based embedder to prove the measurements work; those numbers say nothing about a real model and are not quoted here.

The faithfulness check (the real chat code answers, a second model grades each claim against its sources) is written and tested, but I haven't published full-run numbers: it needs the daily free embedding quota, which I used up while building the scripts.

**Guardrails.**

- Prompt injection: fixed instructions, escaped delimited sources, invisible characters stripped, suspicious passages flagged in logs, no raw HTML or images in answers, no tools for the model, retrieval scoped to the user in SQL. It limits what an attack can do; it isn't a guarantee.
- Citation validation: references to nonexistent sources are removed from the stream.
- Repositories are untrusted too: the comments, README and strings of an imported repository reach the model as quoted data, the attributes of a source block (path, symbol) are escaped, and a suggested question is only built from a plain identifier, because a click sends it to the model.
- Limits: 2,000-character questions, 10 MB / 500-page files, 20 documents (repositories included) and 100 chats per user, 10 questions a minute and 150 a day (keyed by user, since the client IP is unreliable behind Render's proxies).
- Gemini quotas: per-minute and daily 429s are told apart, the wait is shown, and the app stops calling the model for that time. Indexing is paced by tokens per minute (a large text sent in one request can never fit a 30,000-token minute).
- A transcript is untrusted too, and so is what a model heard in a recording: the prompt says that words spoken in a meeting are data, speaker names and titles are cleaned, capped and escaped, and a suggested question is composed from a short list of templates.
- One JSON error shape with a request id; no internals leaked.

**Observability.** JSON logs with a request id from nginx through the API; a `rag_traces` row per question (query, retrieved passages with scores, timings, tokens, outcome, citations kept/removed); the "Why this answer?" panel shows the user the same data. Not built: metrics, dashboards, alerting, an LLM tracing UI.

## Key technical decisions

- Postgres for everything, including vectors and sessions.
- Server-side sessions (opaque token in an httpOnly cookie, hash in the DB), `scrypt` passwords from Node's standard library.
- Indexing inside the API process, one document at a time, behind a `202`. Simple and safe on 512 MB; a restart marks interrupted documents as failed.
- Sources and retrieval details saved with each answer, so deleting a document doesn't rewrite history and the "Why" panel needs no joins.
- Sources sent before the first token; errors in the stream are plain words from a fixed list, never provider text.

## Productionizing it (AWS; GCP, Azure, Cloudflare equivalents in brackets)

- **Web:** S3 + CloudFront instead of nginx; raise idle timeouts for streaming.
- **API:** stateless containers on ECS Fargate behind an ALB, at least 2 across 2 AZs, autoscaled [Cloud Run / Container Apps].
- **Database:** RDS or Aurora PostgreSQL with pgvector, Multi-AZ, backups, RDS Proxy; migrations as a release step, not on startup. Beyond millions of chunks: partition by tenant or move to OpenSearch / a vector store.
- **Indexing:** upload to S3, event to SQS, a separate worker with retries, a dead-letter queue and progress; fixes "a restart kills indexing". A repository import is the first job that should move there: download and embedding are long, and a GitHub token and a clone-free fetch (the archive endpoint) are already the right shape for a worker.
- **Models:** a paid tier with real quotas and a data-processing agreement (free-tier Gemini may use prompts to improve Google's products); Vertex AI or Bedrock; version embeddings per chunk so the model can change; cache query embeddings.
- **Shared state:** Redis for rate limits and the provider cooldown, which are in memory today.
- **Security:** WAF, Secrets Manager, email verification and password reset, trace retention and delete-my-data.
- **A resume is personal data, and screening people is regulated.** Contact details and personal attributes are removed before indexing, but the rest (employers, dates, education, the name) is stored as plain text and sent to the model provider, so a real deployment needs encryption at rest, a retention period, deletion on request and a processing agreement with the provider. Using a tool like this for an employer's selection of candidates is a regulated area (the EU AI Act treats it as high risk), which is why this one is built for the candidate and does not rank people.
- **Meetings are private conversations.** Today they are isolated per user in SQL and stored as plain text in Postgres, together with the questions asked about them in `rag_traces`, and sent to the model provider. A real deployment needs encryption at rest with per-tenant keys, a retention period and deletion on request that also covers traces and backups, a decision on personal data in transcripts (names, health, salaries; redaction before indexing, a regional provider, a provider that does not train on prompts), and consent of the people who were recorded. A recording is sent to the model provider to be transcribed and is not stored by the app; what the provider keeps is its own policy.
- **Observability:** OpenTelemetry to CloudWatch/X-Ray, dashboards on latency, refusal rate, quota errors and token cost per tenant, the evaluation run nightly in CI.
- Cloudflare would be a bigger rewrite (Workers instead of Express, Vectorize or Postgres via Hyperdrive, R2, Queues); I'd choose it only if I started there.

## Engineering standards

**Followed:** strict TypeScript, ESLint and Prettier in CI, zod validation of every external input (HTTP, env, model output), feature-oriented modules, Conventional Commits in small steps with checks green, integration tests against a real Postgres with mocked models, hand-made mutation checks (break the code, confirm the right test fails), CI with a pgvector service and Docker builds, multi-stage images, secrets only in env vars, `npm audit` clean, basic accessibility (focus handling, labels, keyboard), decisions logged as I went.

**Skipped on purpose:** browser end-to-end tests and load tests; metrics and tracing; CSRF tokens (relying on `SameSite=Lax` and a JSON-only API); email verification and password reset; durable queue, OCR and original-file storage (a transcript is rebuilt from its passages); playback of a recording and storing it (the audio is dropped once transcribed, so a transcript time cannot be played); speaker names are taken as the file gives them, with no merging of two spellings of a person; persistent rate limits; pagination and trace retention; non-English documents; a coverage gate; a demo video.

## How I used AI tools

- `CLAUDE.md` holds the commands, conventions and a working agreement. The key rule: the assistant never runs `git commit`/`git push`; I read every change and commit it.
- A written plan cut into small commits, one logical change each, handed over one at a time, so every diff was small enough to actually review.
- `docs/DECISIONS.md` as the memory between sessions: what was considered, why, what it costs. This README is built from it.
- Tests as the contract, with mutation checks to prove they can fail. The assistant had to read current library docs instead of trusting memory, and real API calls happened only by hand.
- Do: small tasks with the reasoning attached, and claims checked against the real system. Don't: let it commit, accept "tests pass" as proof the tests are good, or let it decide the architecture.

Where it went wrong: while building the evaluation scripts it ran real evaluations several times and used up my daily free embedding quota; it wrote a test with a wrong assumption about how a validation library counts emoji; and its first fix for returning keyboard focus after closing a panel went to the wrong button, which a test caught. Reviewing is not optional.

## What I'd do with more time

1. Settle retrieval with data: a bigger golden set, then vector-weighted fusion and a reranker, keeping what the numbers support.
2. A durable indexing pipeline: original files in object storage, a queue and worker, resumable jobs, per-document progress.
3. Run the faithfulness evaluation regularly with a stronger judge, publish the numbers, and run it nightly in CI.
4. Better refusals for questions that sound like the corpus but aren't in it.
5. Real observability: OpenTelemetry, a dashboard over `rag_traces`, LLM tracing.
6. Choose which documents or repositories a question is about; OCR, tables and other languages.
7. Meetings: run `eval:meetings` on both providers and set the threshold from it, add meeting questions to the faithfulness evaluation, try other window sizes, a jump from a time in the notes to the transcript, a real corpus (for example AMI) next to the invented one, and for voice input: measure the transcription on real recordings (overlapping speech, noise, accents, an hour of audio), split long recordings at silences and reconcile the speaker labels across the parts, let a user name the speakers afterwards, and keep the audio in object storage for playback.
8. Code: a real parser (tree-sitter) for chunk boundaries and a call graph, a second reference repository in another language, retrieval tuned from the code evaluation (weight of the keyword list, a reranker), private repositories with OAuth, and re-indexing a repository when its branch moves.
9. A resume and postings: run `eval:career` on both providers and write the numbers down, then set the cut-off; several resumes with an active one; Word files and OCR; fetch a posting from its address safely; a jump from a quote in the requirement table to the line of the resume; add both postings of a "compare Job #1 and Job #3" question to the context; a faithfulness check for answers about fit; synonyms between skills; interview practice (the user answers, the model comments), which needs care not to invent.

Known limits of the demo: free services sleep after 15 minutes (first request can take a minute or two), the free Postgres expires after 30 days, free Gemini quotas include a daily cap on embeddings, and greetings are refused like any off-topic message.

## Screenshots

Taken from the Docker Compose stack. The documents are the real ones from `samples/` indexed by the real pipeline, but the conversations and suggested questions in the first seven were prepared by hand (the daily Gemini quota was used up), so those answers are not live model output. The ones for code and meetings are live: a real import of Koa (the 11 files the code evaluation uses), and the three sample meetings indexed by the real pipeline with their notes written by Gemini, with a real Gemini answer to the question shown.

|                                                             |                                                               |
| ----------------------------------------------------------- | ------------------------------------------------------------- |
| ![Source viewer](screenshots/05-source-viewer.png)          | ![Why this answer](screenshots/06-why-this-answer.png)        |
| Clicking a citation opens the passage in context            | "Why this answer?": search, relevance, passages, scores       |
| ![Documents](screenshots/03-documents.png)                  | ![A refusal explained](screenshots/07-refusal-explained.png)  |
| Library: ready, processing and failed documents             | A refusal with the closest passages that were set aside       |
| ![Dark theme](screenshots/08-dark-theme.png)                | ![Mobile](screenshots/09-mobile-chat.png)                     |
| Dark theme                                                  | Phone width                                                   |
| ![Repositories](screenshots/10-repository-library.png)      | ![A code answer](screenshots/12-code-answer.png)              |
| A repository in the library with its suggested questions    | A code answer with `path:lines` citations                     |
| ![Code viewer](screenshots/13-code-viewer.png)              | ![Meetings](screenshots/14-meeting-library.png)               |
| A cited block with line numbers and highlighted syntax      | Meeting cards: speakers, passages, notes, suggested questions |
| ![Notes](screenshots/15-meeting-notes.png)                  | ![Meeting answer](screenshots/16-meeting-answer.png)          |
| Notes: summary, decisions, action items with owners         | An answer with speaker and time citations                     |
| ![Transcript](screenshots/17-transcript-viewer.png)         | ![Filter](screenshots/18-meeting-why-this-answer.png)         |
| The transcript, speakers in colour, cited range highlighted | "Why this answer?": the speaker filter that was applied       |
| ![Recording](screenshots/19-meeting-recording.png)          |                                                               |
| Adding a meeting from a recording or the microphone         |                                                               |
