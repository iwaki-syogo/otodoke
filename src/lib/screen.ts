import { emailBodyText, stripInvisible } from "@/lib/text/html-to-text";

/**
 * Free check that runs before Claude, so ads and newsletters cost nothing.
 *
 * It looks only at what a mail says, never at who sent it: a sender allowlist would
 * drop every shop the user buys from for the first time. When unsure it lets the mail
 * through, because a wrongly dropped parcel is worse than one wasted Claude call.
 */
export interface ScreenInput {
  subject: string;
  text: string | null;
  html: string | null;
}

export interface ScreenResult {
  pass: boolean;
  reason: string;
  /** Dropped, but something in it looks like a notice. Worth a cheap second look. */
  borderline: boolean;
}

/** A label that a transaction mail has and an ad does not. */
const TRANSACTION_ID =
  /注文番号|受注番号|注文ID|オーダーID|注文コード|ご注文No|伝票番号|送り状|お問い?合わせ番号|追跡番号|荷物番号|配送番号|order\s*(number|no\.?|id|#)|tracking\s*(number|no\.?|id|#)/i;

/** The subject says something happened to an order or a parcel. */
const EVENT_SUBJECT =
  /注文|購入|発送|出荷|配達|配送|お届け|到着|荷物|再配達|不在|受取|キャンセル|返金|決済完了|定期おトク便|直送|your order|order confirm|shipped|shipping|delivered|delivery|out for delivery|tracking/i;

/** The body says the same in sentence form, for mails whose subject is generic. */
const EVENT_BODY =
  /ご注文(ありがとう|を受け付け|を承り|いただき)|発送(いたしました|しました|完了)|出荷(いたしました|しました|完了)|お届け予定|配達予定|到着予定|配達完了|持ち帰りました|処方箋確認|決済完了|thank you for your order|has shipped|has been delivered/i;

/** A completed event in the subject. Amazon adds "おすすめ" to a real cancellation notice. */
const DONE_SUBJECT = /(キャンセル|発送|出荷|配達|返金)(され|いた|し)?(まし|済み)/;

/** Mass mail says how to stop receiving it. */
const BULK_MARKER = /配信停止|配信解除|配信の停止|メルマガ|メールマガジン|購読解除|購読の解除|配信を停止|配信をご希望|unsubscribe/i;

/** Wording of a promotion rather than a notice. */
const PROMO_SUBJECT = /クーポン|キャンペーン|セール|SALE|OFF|％|%|ポイント|プレゼント|おすすめ|当たる|限定|新商品|新着|特集|ランキング|抽選|開催/i;

export function screenMail(mail: ScreenInput): ScreenResult {
  const subject = stripInvisible(mail.subject ?? "");
  const body = emailBodyText(mail.text, mail.html);
  if (!subject.trim() && !body.trim()) return { pass: true, reason: "empty: nothing to judge", borderline: false };

  const hasId = TRANSACTION_ID.test(subject) || TRANSACTION_ID.test(body);
  const eventInSubject = EVENT_SUBJECT.test(subject);
  const eventInBody = EVENT_BODY.test(body);
  const bulk = BULK_MARKER.test(body);
  const promo = PROMO_SUBJECT.test(subject);

  if (DONE_SUBJECT.test(subject)) return { pass: true, reason: "subject states a completed event", borderline: false };
  if (eventInBody && !promo) return { pass: true, reason: "body states an order or delivery event", borderline: false };
  if (hasId && !bulk) return { pass: true, reason: "has an order or tracking label", borderline: false };
  if (hasId && eventInSubject && !promo) return { pass: true, reason: "label and event subject in a mail with an unsubscribe note", borderline: false };
  if (eventInSubject && !bulk && !promo) return { pass: true, reason: "subject names an event", borderline: false };
  return {
    pass: false,
    reason: bulk ? "mass mail with no order or tracking evidence" : "no order or delivery evidence",
    borderline: hasId || eventInBody || (eventInSubject && !promo),
  };
}
