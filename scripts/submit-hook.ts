// Opt-in command-hook bridge. Never writes to stdout or changes the agent's decision.
const source = process.argv[2];
const endpoint = process.env.TRACES_ENDPOINT;
const clientId = process.env.CF_ACCESS_CLIENT_ID;
const clientSecret = process.env.CF_ACCESS_CLIENT_SECRET;

try {
  if (
    !source ||
    !["claude-code", "codex", "pi"].includes(source) ||
    !endpoint ||
    !clientId ||
    !clientSecret
  ) {
    throw new Error("Missing hook configuration");
  }
  const url = new URL("/api/events", endpoint);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "localhost")) {
    throw new Error("HTTPS is required");
  }
  const raw: unknown = JSON.parse(await Bun.stdin.text());
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Expected hook event object");
  }
  const fields = raw as Record<string, unknown>;
  const sessionId = fields.session_id ?? fields.sessionId;
  const event = fields.hook_event_name ?? fields.event;
  if (typeof sessionId !== "string" || typeof event !== "string") {
    throw new Error("Missing session or event name");
  }
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "CF-Access-Client-Id": clientId,
      "CF-Access-Client-Secret": clientSecret,
    },
    body: JSON.stringify({
      id: crypto.randomUUID(),
      source,
      sessionId,
      event,
      occurredAt: new Date().toISOString(),
      raw,
    }),
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) {
    throw new Error("Trace submission failed");
  }
} catch {
  // Hooks must not block a coding agent; intentionally omit payloads and credentials from stderr.
  console.error("traces: hook submission unavailable");
}
