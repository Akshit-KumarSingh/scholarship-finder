const BASE = import.meta.env.VITE_API_URL || "http://localhost:3000";

async function post(path, body) {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.error || `Request failed (${res.status})`);
  }
  return res.json();
}

export const checkEligibility = (profile) => post("/api/eligibility", profile);

// `profile` is the one the server last checked (or null): the agent then
// works from what the student actually entered instead of guessing.
export const sendChat = (message, history, profile = null) =>
  post("/api/chat", { message, history, profile });

export const getSchemes = () => fetch(BASE + "/api/schemes").then((r) => r.json());

// Free hosting tiers sleep when idle. Pinging on page load wakes the server
// while the student is still filling in the form. Failures are ignored.
export const wakeServer = () => fetch(BASE + "/api/health").catch(() => {});
