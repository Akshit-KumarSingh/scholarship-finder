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
export const sendChat = (message, history) => post("/api/chat", { message, history });
export const getSchemes = () => fetch(BASE + "/api/schemes").then((r) => r.json());
