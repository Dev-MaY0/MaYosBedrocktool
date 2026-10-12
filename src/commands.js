// =====================================================================
//  スラッシュコマンドの一覧（/setup/ で Discord に登録します）
//  制作: MaYo (mayo01297)  二次配布禁止
// =====================================================================
const SUB = 1, STRING = 3, INTEGER = 4, USER = 6;

export const COMMANDS = [
  {
    name: "vc",
    description: "Minecraft 近接VC",
    contexts: [0],          // サーバーの中だけ
    integration_types: [0],
    options: [
      {
        type: SUB, name: "setup", description: "【管理者】近接VC用のVCを作って、接続キーを出します",
        options: [{ type: INTEGER, name: "rooms", description: "最初に作る近接VCの数（1〜20、ふだんは4）", min_value: 1, max_value: 20, required: false }],
      },
      {
        type: SUB, name: "link", description: "自分の Discord とマイクラのアカウントを紐付けます",
        options: [{ type: STRING, name: "gamertag", description: "マイクラの名前（ゲーム中の人は候補から選べます）", required: true, max_length: 32, autocomplete: true }],
      },
      {
        type: SUB, name: "unlink", description: "紐付けを外します（管理者は、ほかの人の紐付けも外せます）",
        options: [{ type: USER, name: "user", description: "【管理者】外す人", required: false }],
      },
      { type: SUB, name: "status", description: "近接VCの様子（つながっているか・だれがどこにいるか）を見ます" },
      {
        type: SUB, name: "distance", description: "【管理者】声が届く距離（ブロック）を変えます",
        options: [{ type: INTEGER, name: "blocks", description: "4〜128（ふだんは20）", min_value: 4, max_value: 128, required: true }],
      },
      { type: SUB, name: "reset", description: "【管理者】全員をロビーに戻します" },
      { type: SUB, name: "key", description: "【管理者】接続キーと /wsserver のコマンドをもう一度見ます" },
      { type: SUB, name: "rekey", description: "【管理者】接続キーを作り直します（前のキーは使えなくなります）" },
      {
        type: SUB, name: "addon", description: "近接VCアドオンのファイルをもらいます",
        options: [{ type: STRING, name: "type", description: "遊ぶ場所", required: false,
          choices: [{ name: "ワールド用（ふつうはこちら）", value: "world" }, { name: "BDS用【管理者】", value: "bds" }] }],
      },
    ],
  },
];
