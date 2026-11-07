// Optional Claude client. If the SDK isn't installed or no credentials are set,
// every caller falls back to Pixel's offline brain, so the demo never breaks.

const MODEL = process.env.PIXEL_MODEL || "claude-opus-5-5";
const TIMEOUT_MS = Number(process.env.PIXEL_LLM_TIMEOUT_MS || 12000);

let clientPromise = null;

async function getClient() {
  if (process.env.PIXEL_OFFLINE === "1") return null;
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) return null;
  if (!clientPromise) {
    clientPromise = import("@anthropic-ai/sdk")
      .then((mod) => new mod.default({ timeout: TIMEOUT_MS, maxRetries: 0 }))
      .catch(() => {
        console.warn("[llm] @anthropic-ai/sdk not installed. Run `npm install` to enable Claude.");
        return null;
      });
  }
  return clientPromise;
}

export async function llmAvailable() {
  return (await getClient()) !== null;
}

export const modelName = MODEL;

function textOf(response) {
  if (!response || response.stop_reason === "refusal") return null;
  return response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

async function create(params) {
  const client = await getClient();
  if (!client) return null;
  const response = await client.beta.messages.create({
    model: MODEL,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    ...params,
  });
  return textOf(response);
}

/** Returns parsed JSON matching `schema`, or null on any failure. */
export async function llmJson({ system, user, schema, maxTokens = 4000 }) {
  try {
    const text = await create({
      max_tokens: maxTokens,
      output_config: { effort: "low", format: { type: "json_schema", schema } },
      system,
      messages: [{ role: "user", content: user }],
    });
    return text ? JSON.parse(text) : null;
  } catch (err) {
    console.warn("[llm] call failed, using offline brain:", err?.message || err);
    return null;
  }
}

/** Returns plain text, or null on any failure. */
export async function llmText({ system, user, maxTokens = 8000 }) {
  try {
    return await create({
      max_tokens: maxTokens,
      output_config: { effort: "low" },
      system,
      messages: [{ role: "user", content: user }],
    });
  } catch (err) {
    console.warn("[llm] call failed, using offline brain:", err?.message || err);
    return null;
  }
}
