// 「うまく届かないとき」: the reasons a parcel may not be found. A draft (2026-11-07): the sentences are being
// checked against the carriers' and shops' own help pages and will be swapped in here. The screen only draws
// `items`, so a new sentence needs no change anywhere else.

import Foundation

enum DeliveryHelpText {
    static let items: [String] = [
        "ヤマト運輸など配送会社のメールを受信拒否にしていたり、お届け予定メールに登録していないと、届く日が分かりません。",
        "店のサイトで「発送のお知らせ」「お届けのお知らせ」のメールを受け取らない設定にしていると、荷物を見つけられません。店のメール設定で受け取るようにしてください。"
    ]
}
