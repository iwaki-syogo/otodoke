import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { env, requireEnv } from "@/lib/env";
import { EXTRACT_SYSTEM_PROMPT, buildUserMessage, type EmailForPrompt } from "./prompt";
import { ExtractionSchema, storableInt, type Extraction } from "./schema";

export interface ExtractionResult {
  data: Extraction;
  model: string;
  truncated: boolean;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  };
  /** Set when the model declined; `data` is then a safe "unrelated" placeholder. */
  refused?: boolean;
}

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: requireEnv("ANTHROPIC_API_KEY") });
  return client;
}

const EMPTY_FIELD = { value: null, evidence: null, confidence: 0 } as const;

/** Where a reading has whole numbers: an amount (the only `value` that is a number) and an item's quantity and price. */
const WHOLE_NUMBER_KEYS = new Set(["value", "quantity", "unit_price"]);

/**
 * Reads the model's answer. A whole number the database cannot store (below 0, above
 * 2,147,483,647, or past 2^53, which the schema check itself refuses) would fail the mail on
 * every delivery Resend retries, each one a paid call. So it is read as unknown (null) before the
 * check; its evidence and confidence stay.
 */
export function readAnswer(content: string): Extraction {
  const answer: unknown = JSON.parse(content, (key, value) => (typeof value === "number" && WHOLE_NUMBER_KEYS.has(key) ? storableInt(value) : value));
  return ExtractionSchema.parse(answer);
}

/** The model is held to the same JSON schema as before; only the reading of its answer is ours. */
const OUTPUT_FORMAT = { ...zodOutputFormat(ExtractionSchema), parse: readAnswer };

function unrelatedPlaceholder(notes: string): Extraction {
  return {
    relevance: "unrelated",
    relevance_evidence: null,
    shop_name: null,
    shop_key: null,
    order_number: { ...EMPTY_FIELD },
    items: [],
    category: null,
    package_description: { ...EMPTY_FIELD },
    total_amount: { ...EMPTY_FIELD },
    ordered_at: { ...EMPTY_FIELD },
    carrier: { ...EMPTY_FIELD },
    tracking_number: { ...EMPTY_FIELD },
    expected_date: { ...EMPTY_FIELD },
    expected_date_end: { ...EMPTY_FIELD },
    expected_window_start: { ...EMPTY_FIELD },
    expected_window_end: { ...EMPTY_FIELD },
    expected_text: null,
    requires_presence: { ...EMPTY_FIELD },
    other_orders: [],
    overall_confidence: 0,
    notes,
  };
}

/**
 * Ask Claude to classify and structure one email. Uses structured outputs so the
 * result always validates against `ExtractionSchema`.
 */
export async function extractEmail(email: EmailForPrompt): Promise<ExtractionResult> {
  const { OTODOKE_MODEL: model, OTODOKE_EXTRACT_EFFORT: effort } = env();
  const { text, truncated } = buildUserMessage(email);

  const response = await getClient().messages.parse({
    model,
    // A mail listing many orders carries an evidence line per value; 8000 cut one off mid-answer.
    max_tokens: 16000,
    system: [{ type: "text", text: EXTRACT_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: text }],
    output_config: { format: OUTPUT_FORMAT, effort },
  });

  const usage = {
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
    cache_read_input_tokens: response.usage.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: response.usage.cache_creation_input_tokens ?? 0,
  };

  if (response.stop_reason === "refusal") {
    return {
      data: unrelatedPlaceholder("モデルがこのメールの処理を辞退しました"),
      model,
      truncated,
      usage,
      refused: true,
    };
  }
  if (!response.parsed_output) {
    throw new Error(`Extraction returned no parsable output (stop_reason=${response.stop_reason})`);
  }
  return { data: response.parsed_output, model, truncated, usage };
}
