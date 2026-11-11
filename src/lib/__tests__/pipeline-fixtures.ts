/** Made-up readings and mails for the pipeline tests (no real mail or person). */
import type { ExtractionResult } from "@/lib/extract/extract";
import type { Extraction } from "@/lib/extract/schema";
import type { InboundEmail } from "@/lib/pipeline";
import type { AdminClient } from "@/lib/supabase/admin";
import type { FakeDb } from "./fake-db";

export const USER = "00000000-0000-4000-8000-00000000000a";
export const OTHER = "00000000-0000-4000-8000-00000000000b";

export const none = { value: null, evidence: null, confidence: 0 };
export const sure = <T>(value: T) => ({ value, evidence: "根拠の行", confidence: 0.95 });

/** One reading. `category` is passed through even before the schema has it. */
export function reading(over: Partial<Extraction> & { category?: string | null } = {}): Extraction {
  return {
    relevance: "shipped",
    relevance_evidence: null,
    shop_name: "テスト店",
    shop_key: "other",
    order_number: none,
    items: [],
    package_description: none,
    total_amount: none,
    ordered_at: none,
    carrier: none,
    tracking_number: none,
    expected_date: none,
    expected_date_end: none,
    expected_window_start: none,
    expected_window_end: none,
    expected_text: null,
    requires_presence: none,
    other_orders: [],
    overall_confidence: 0.9,
    notes: null,
    category: null,
    ...over,
  } as Extraction;
}

export const item = (name: string, unit_price: number | null = null) => ({ name, quantity: 1, unit_price, evidence: name });

export function mailOf(sentAt: string, userId = USER): InboundEmail {
  return {
    userId,
    providerEmailId: null,
    messageId: null,
    from: "shop@example.test",
    fromName: null,
    subject: "テストのお知らせ",
    sentAt,
    text: "テスト本文",
    html: null,
  };
}

export function precomputed(x: Extraction): ExtractionResult {
  return { data: x, model: "test-model", truncated: false, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
}

export const asAdmin = (db: FakeDb) => db as unknown as AdminClient;

/** These existing pipeline scenarios start after the two test accounts explicitly consented. */
export function asConsentingAdmin(db: FakeDb): AdminClient {
  for (const userId of [USER, OTHER]) {
    if (!db.rows("ai_reading_consents").some((row) => row.user_id === userId)) {
      db.rows("ai_reading_consents").push({ user_id: userId, decision: "granted", decided_at: "2026-11-12T00:00:00Z", text_version: "v1" });
    }
  }
  return asAdmin(db);
}
