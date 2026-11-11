import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { requireEnv } from "@/lib/env";
import { TRIAGE_TIMEOUT_MS } from "@/lib/unread";
import { emailBodyText } from "@/lib/text/html-to-text";

/** The second check for mail the free rules were unsure about. Cheap and short on purpose. */
const TRIAGE_MODEL = "claude-haiku-5-5";
const TRIAGE_CHARS = 3000;

const Verdict = z.object({
  about_this_persons_purchase: z.boolean().describe("この人自身の注文・発送・配達・キャンセルの連絡なら true。広告や一般のお知らせは false"),
});

const SYSTEM = `メール 1 通が、受信者自身の買い物の連絡かどうかだけを判定します。
注文の受付、発送、配達、不在、キャンセル、返金の連絡なら true。店名や差出人を知らなくても文面で判断してください。
「最短当日出荷」「送料無料」のような宣伝、クーポン、新商品の案内、規約変更は false です。
「ご注文ありがとうございました」と書いてあっても、注文番号も商品名も金額もなく、ギフトや特典を勧めているだけなら広告なので false です。
それ以外で迷ったら true にしてください。`;

/**
 * True when the mail should go on to full reading. A failed call is NOT swallowed here: it throws,
 * and the caller (the pipeline's second look) keeps the mail, gives the allowance back when Claude
 * refused the call, and stops when Claude is unavailable.
 */
export async function isPurchaseMail(mail: { subject: string; text: string | null; html: string | null }): Promise<boolean> {
  const client = new Anthropic({ apiKey: requireEnv("ANTHROPIC_API_KEY"), maxRetries: 0, timeout: TRIAGE_TIMEOUT_MS });
  const body = emailBodyText(mail.text, mail.html).slice(0, TRIAGE_CHARS);
  const response = await client.messages.parse({
    model: TRIAGE_MODEL,
    max_tokens: 100,
    system: SYSTEM,
    messages: [{ role: "user", content: `件名: ${mail.subject}\n\n${body}` }],
    output_config: { format: zodOutputFormat(Verdict) },
  });
  return response.parsed_output?.about_this_persons_purchase ?? true;
}
