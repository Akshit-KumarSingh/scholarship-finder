import { useState } from "react";
import { checkEligibility, sendChat } from "./api.js";

const BLANK = {
  income: "",
  category: "OBC",
  state: "UP",
  course_level: "UG",
  year_of_study: "1",
  gender: "MALE",
  marks_pct: "",
  disability: false,
};

const inr = (n) =>
  Number(n).toLocaleString("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  });

const prettyDate = (d) => {
  if (!d) return "no deadline listed";
  const dt = new Date(d);
  return Number.isNaN(dt.getTime())
    ? d
    : dt.toLocaleDateString("en-IN", {
        day: "numeric",
        month: "long",
        year: "numeric",
      });
};

// ── Small inline icons (no extra library needed) ────────────────────────────
const Icon = {
  Logo: () => (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path d="M12 4 2 9l10 5 8-4v6h2V9L12 4Z" fill="currentColor" />
      <path
        d="M6 12.5V16c0 1.7 2.7 3 6 3s6-1.3 6-3v-3.5l-6 3-6-3Z"
        fill="currentColor"
        opacity=".7"
      />
    </svg>
  ),
  Sparkle: () => (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path
        d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z"
        fill="currentColor"
      />
      <path
        d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15Z"
        fill="currentColor"
        opacity=".6"
      />
    </svg>
  ),
  Arrow: () => (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M7 17 17 7M9 7h8v8" />
    </svg>
  ),
  Send: () => (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  ),
  Bulb: () => (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3Z" />
    </svg>
  ),
};

export default function App() {
  const [form, setForm] = useState(BLANK);
  const [verdict, setVerdict] = useState(null);
  const [checking, setChecking] = useState(false);

  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState("");
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState(null);

  const set = (k) => (e) =>
    setForm((f) => ({
      ...f,
      [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value,
    }));

  function toProfile() {
    return {
      income: Number(form.income) || 0,
      category: form.category,
      state: form.state,
      course_level: form.course_level,
      year_of_study: Number(form.year_of_study),
      gender: form.gender,
      marks_pct: form.marks_pct === "" ? undefined : Number(form.marks_pct),
      disability: form.disability,
    };
  }

  async function onCheck(e) {
    e.preventDefault();
    setError(null);
    setChecking(true);
    try {
      setVerdict(await checkEligibility(toProfile()));
    } catch (err) {
      setError(err.message);
    } finally {
      setChecking(false);
    }
  }

  async function onAsk(e) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || thinking) return;

    const history = messages.flatMap((m) => [
      { role: "user", content: m.question },
      { role: "assistant", content: m.answer },
    ]);

    setMessages((m) => [...m, { question: text, answer: null, trace: [] }]);
    setDraft("");
    setThinking(true);
    setError(null);

    try {
      const res = await sendChat(text, history);
      setMessages((m) =>
        m.map((msg, i) =>
          i === m.length - 1
            ? { ...msg, answer: res.answer, trace: res.trace }
            : msg,
        ),
      );
    } catch (err) {
      setError(err.message);
      setMessages((m) => m.slice(0, -1));
    } finally {
      setThinking(false);
    }
  }

  function askAbout(scheme) {
    setDraft(`What documents do I need for ${scheme.name}?`);
    document.getElementById("ask-input")?.focus();
  }

  // ── Numbers for the summary cards ─────────────────────────────────────────
  const eligibleCount = verdict?.eligible_count ?? 0;
  const nearCount = verdict?.near_misses?.length ?? 0;
  const checked = eligibleCount + nearCount;
  const verifiedCount = verdict
    ? verdict.eligible.filter((s) => s.verified).length
    : 0;
  const verifiedPct = eligibleCount
    ? Math.round((verifiedCount / eligibleCount) * 100)
    : 0;
  const pct = (n) =>
    checked ? Math.max(4, Math.round((n / checked) * 100)) : 0;

  return (
    <div className="shell">
      <div className="app">
        {/* ── Top bar ─────────────────────────────────────────────── */}
        <header className="topbar">
          <div className="brand">
            <span className="brand__mark">
              <Icon.Logo />
            </span>
            <span className="brand__name">scholarfind</span>
          </div>
          <nav className="tabs" aria-label="Sections">
            <a href="#details" className="tab tab--active">
              Eligibility
            </a>
            <a href="#results" className="tab">
              Results
            </a>
            <a href="#ask" className="tab">
              Ask
            </a>
          </nav>
        </header>

        <div className="titlebar">
          <div>
            <h1>Scholarship finder</h1>
            <p>
              Tell it about yourself, see which government scholarships will
              actually accept your application, and ask anything about the
              paperwork.
            </p>
          </div>
          {verdict && (
            <div className="chips">
              <span className="chip">{form.state || "Any state"}</span>
              <span className="chip">{form.category}</span>
              <span className="chip">
                {form.course_level} · Year {form.year_of_study}
              </span>
              {form.income && <span className="chip">{inr(form.income)}</span>}
            </div>
          )}
        </div>

        {error && <div className="error">{error}</div>}

        {/* ── Top row: form + summary ─────────────────────────────── */}
        <div className="grid grid--top">
          <section className="card" id="details" aria-label="Your details">
            <div className="card__head">
              <h2>Your details</h2>
            </div>

            <form onSubmit={onCheck} className="form">
              <label>
                Annual family income
                <input
                  type="number"
                  value={form.income}
                  onChange={set("income")}
                  placeholder="400000"
                  required
                />
                <span className="hint">In rupees. 4 lakh is 400000.</span>
              </label>

              <div className="row">
                <label>
                  Category
                  <select value={form.category} onChange={set("category")}>
                    {["GENERAL", "OBC", "SC", "ST", "EWS", "MINORITY"].map(
                      (c) => (
                        <option key={c}>{c}</option>
                      ),
                    )}
                  </select>
                </label>
                <label>
                  State
                  <input
                    value={form.state}
                    onChange={set("state")}
                    placeholder="UP"
                  />
                </label>
              </div>

              <div className="row">
                <label>
                  Studying
                  <select
                    value={form.course_level}
                    onChange={set("course_level")}
                  >
                    <option value="SCHOOL">School</option>
                    <option value="DIPLOMA">Diploma</option>
                    <option value="UG">Undergraduate</option>
                    <option value="PG">Postgraduate</option>
                  </select>
                </label>
                <label>
                  Year
                  <input
                    type="number"
                    min="1"
                    value={form.year_of_study}
                    onChange={set("year_of_study")}
                  />
                </label>
              </div>

              <div className="row">
                <label>
                  Gender
                  <select value={form.gender} onChange={set("gender")}>
                    <option value="MALE">Male</option>
                    <option value="FEMALE">Female</option>
                    <option value="OTHER">Other</option>
                  </select>
                </label>
                <label>
                  Last exam (%)
                  <input
                    type="number"
                    value={form.marks_pct}
                    onChange={set("marks_pct")}
                    placeholder="78"
                  />
                </label>
              </div>

              <label className="check">
                <input
                  type="checkbox"
                  checked={form.disability}
                  onChange={set("disability")}
                />
                I have a disability certificate
              </label>

              <button type="submit" className="btn" disabled={checking}>
                {checking ? "Checking…" : "Check eligibility"}
              </button>
            </form>
          </section>

          <div className="stack">
            <section className="card" aria-label="Summary">
              <div className="card__head">
                <h2>Schemes you qualify for</h2>
              </div>

              <div className="bignum">
                <span className="bignum__value">
                  {verdict ? eligibleCount : "–"}
                </span>
                {verdict && checked > 0 && (
                  <span className="pill-badge">
                    <span className="pill-badge__dot" /> {pct(eligibleCount)}%
                    match
                  </span>
                )}
              </div>

              <div className="bars">
                <div className="bar">
                  <div className="bar__label">
                    <span>Eligible</span>
                    <strong>{verdict ? eligibleCount : 0}</strong>
                  </div>
                  <div className="bar__track">
                    <div
                      className="bar__fill bar__fill--green"
                      style={{ width: `${pct(eligibleCount)}%` }}
                    />
                  </div>
                </div>
                <div className="bar">
                  <div className="bar__label">
                    <span>Close, one rule blocks you</span>
                    <strong>{nearCount}</strong>
                  </div>
                  <div className="bar__track">
                    <div
                      className="bar__fill bar__fill--blue"
                      style={{ width: `${pct(nearCount)}%` }}
                    />
                  </div>
                </div>
                <div className="bar">
                  <div className="bar__label">
                    <span>Verified against official docs</span>
                    <strong>{verifiedCount}</strong>
                  </div>
                  <div className="bar__track">
                    <div
                      className="bar__fill bar__fill--pink"
                      style={{ width: `${pct(verifiedCount)}%` }}
                    />
                  </div>
                </div>
              </div>
            </section>

            <section className="card card--insight" aria-label="Note">
              <span className="insight__tag">
                <Icon.Bulb /> Insight
              </span>
              {verdict && eligibleCount > 0 ? (
                <>
                  <p className="insight__big">{verifiedPct}%</p>
                  <p className="insight__title">of your matches are verified</p>
                </>
              ) : (
                <p className="insight__title insight__title--solo">
                  Rules change every academic year
                </p>
              )}
              <p className="insight__text">
                Confirm anything you read here against the official portal
                before you apply.
              </p>
            </section>
          </div>
        </div>

        {/* ── Results ─────────────────────────────────────────────── */}
        <section id="results" className="results" aria-label="Results">
          {!verdict && (
            <div className="card empty">
              <h2>Start with your details</h2>
              <p>
                Eligibility is decided by comparing numbers, so it runs as a
                database query rather than a text search. Once you have your
                list, ask follow-up questions and the documents get searched for
                the answer.
              </p>
            </div>
          )}

          {verdict && (
            <>
              <h2 className="section-title">
                {eligibleCount === 0
                  ? "Nothing matches these details"
                  : `${eligibleCount} scheme${eligibleCount > 1 ? "s" : ""} will accept you`}
              </h2>

              <div className="grid grid--cards">
                {verdict.eligible.map((s) => (
                  <article key={s.id} className="card scheme">
                    <div className="card__head">
                      <h3>{s.name}</h3>
                      {s.apply_url && (
                        <a
                          className="round-btn"
                          href={s.apply_url}
                          target="_blank"
                          rel="noreferrer"
                          aria-label={`Open the official page for ${s.name}`}
                          title="Open the official page"
                        >
                          <Icon.Arrow />
                        </a>
                      )}
                    </div>
                    <p className="scheme__amount">{s.benefit_amount}</p>
                    <dl className="scheme__meta">
                      <div>
                        <dt>Closes</dt>
                        <dd>{prettyDate(s.deadline)}</dd>
                      </div>
                      <div>
                        <dt>Run by</dt>
                        <dd>{s.authority}</dd>
                      </div>
                    </dl>
                    <div className="scheme__foot">
                      <button
                        type="button"
                        className="ghost"
                        onClick={() => askAbout(s)}
                      >
                        <Icon.Sparkle /> Ask what documents it needs
                      </button>
                      {!s.verified && (
                        <span className="tag tag--warn">Not yet verified</span>
                      )}
                    </div>
                  </article>
                ))}
              </div>

              {verdict.near_misses.length > 0 && (
                <>
                  <h2 className="section-title section-title--sub">
                    Close, but one thing blocks you
                  </h2>
                  <div className="grid grid--cards">
                    {verdict.near_misses.map((s) => (
                      <article key={s.id} className="card scheme scheme--near">
                        <h3>{s.name}</h3>
                        <p className="scheme__reason">{s.reason}</p>
                      </article>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </section>

        {/* ── Chat ────────────────────────────────────────────────── */}
        <section id="ask" className="card chat" aria-label="Ask a question">
          {messages.length > 0 && (
            <div className="chat__log">
              {messages.map((m, i) => (
                <div className="exchange" key={i}>
                  <p className="bubble bubble--q">{m.question}</p>
                  {m.answer ? (
                    <>
                      <div className="bubble bubble--a">{m.answer}</div>
                      {m.trace?.length > 0 && (
                        <details className="trace">
                          <summary>{m.trace.length} tool calls</summary>
                          <ol>
                            {m.trace.map((t, j) => (
                              <li key={j}>
                                <code>{t.tool}</code>
                                <span>{t.summary}</span>
                              </li>
                            ))}
                          </ol>
                        </details>
                      )}
                    </>
                  ) : (
                    <div className="bubble bubble--a bubble--pending">
                      Working through it…
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          <div className="ask">
            <div className="ask__label">
              <Icon.Sparkle /> What would you like to know next?
            </div>
            <form className="ask__box" onSubmit={onAsk}>
              <input
                id="ask-input"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="What documents do I need? Which one pays more?"
                aria-label="Ask a question"
              />
              <button
                type="submit"
                className="round-btn round-btn--dark"
                disabled={thinking || !draft.trim()}
                aria-label="Ask"
              >
                <Icon.Send />
              </button>
            </form>
          </div>
        </section>
      </div>
    </div>
  );
}
