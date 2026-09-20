// fixtures/papers-real.json に expected（人手ラベル）を付ける。
//
// **このラベルは Claude が要旨を読んで付けたもので、当該分野の研究者の判断ではない。**
// tier A / C は判断が割れにくいが、tier B は割れうるので confidence を併記する。
// 実運用の判断に使う前に、利用者本人がラベルを見直すこと。
//
// 判断基準（プロジェクト概要から）:
//   「(a) 分子物性予測の GNN、(b) 少数データでの転移学習・事前学習、
//     (c) 較正された不確実性 のいずれかを、このプロジェクトに適用できる形で進めるか」
//
//   node label-real.mjs

import { readFileSync, writeFileSync } from 'node:fs';

const PATH = 'fixtures/papers-real.json';
const doc = JSON.parse(readFileSync(PATH, 'utf8'));

// id -> [expected, confidence, 理由]
const LABELS = {
  // tier A: 分子物性予測そのもの。判断は割れない
  r01: ['useful', 'high', '分子物性予測 GNN の説明可能性。対象タスクが一致'],
  r02: ['useful', 'high', 'GNN の転移学習で高コスト測定を補う。(a)(b) に直撃'],
  r03: ['useful', 'high', '分子物性予測の GNN アーキテクチャ'],
  r04: ['useful', 'high', '分子物性予測 GNN の自己解釈'],
  r05: ['useful', 'high', '対照学習による分子物性予測の事前学習'],
  r06: ['useful', 'high', 'GNN による分子物性（イオン液体）予測'],
  r07: ['useful', 'high', '分子物性予測の GNN 表現学習'],
  r08: ['useful', 'high', '分子グラフ GNN による物性予測'],
  r09: ['useful', 'high', '分子物性予測の標準的実装。実務で参照する'],
  r10: ['useful', 'high', '分子基盤モデルの転移。(b) に直撃'],
  r11: ['useful', 'high', 'GNN＋転移学習による分子物性予測'],
  r12: ['useful', 'high', 'ラベル希少下の転移学習。(b) に直撃'],
  r13: ['useful', 'high', '低忠実度データからの知識転移で GNN 改善。(b) に直撃'],
  r14: ['useful', 'high', 'コスト制約下の転移学習による分子物性予測'],

  // tier B: 境界。ここが本番
  r15: ['excluded', 'high', 'GNN だが対象は属性付きネットワークの異常検知'],
  r16: ['excluded', 'high', 'GNN だが対象はソーシャル推薦'],
  r17: ['excluded', 'medium', '転移＋対照学習で手法は近いが、対象はソーシャル推薦'],
  r18: ['excluded', 'high', 'GNN だが対象は Web3 の取引予測'],
  r19: ['excluded', 'medium', 'GNN＋ドメイン適応だが対象は感染症の社会ネットワーク'],
  r20: ['excluded', 'medium', '不確実性定量だが対象は画像分類。(c) と手法は重なる'],
  r21: ['excluded', 'medium', '不確実性定量だが対象は医用画像分類'],
  r22: ['excluded', 'medium', 'アンサンブルの較正は (c) に近いが対象は医用画像分割'],
  r23: ['excluded', 'medium', '較正改善だが対象は心臓 MRI 分類'],
  r24: ['excluded', 'high', '不確実性定量だが対象は肺がん画像'],
  r25: ['excluded', 'medium', '創薬ドメインは重なるが LLM の総説で物性予測ではない'],
  r26: ['excluded', 'medium', '同上。LLM の総説'],
  r27: ['excluded', 'medium', '化学ツール連携の LLM。物性予測の手法ではない'],
  r28: ['excluded', 'medium', 'LLM 創薬の入門総説'],
  r29: ['excluded', 'medium', 'LLM 創薬の総説'],
  r30: ['excluded', 'medium', '分子だが原子間ポテンシャルによる MD。タスクが違う'],
  r31: ['excluded', 'medium', '同上。MD シミュレーションの高速化'],
  r32: ['useful', 'low', '不確実性駆動の能動学習。対象は原子間ポテンシャルだが (c) の枠組みが適用しうる'],
  r33: ['excluded', 'medium', 'GNN＋分子だが並列アルゴリズムの話で物性予測ではない'],
  r34: ['excluded', 'high', '原子間ポテンシャルの総説。力学特性で対象が違う'],
  r35: ['excluded', 'low', 'few-shot／MAML の汎用手法。分野非依存で適用可能性はあるが直接ではない'],
  r36: ['excluded', 'high', 'few-shot だが対象は脳腫瘍 MRI'],
  r37: ['useful', 'high', '分子（イオン液体）の毒性を few-shot／メタ学習で予測。(a)(b) に合致'],
  r38: ['excluded', 'high', '少数データ GNN だが対象は艦載車両の任務信頼性'],

  // tier C: 明確に無関係
  r39: ['excluded', 'high', '銀河形態の分類'],
  r40: ['excluded', 'high', '銀河形態のカタログ'],
  r41: ['excluded', 'high', '銀河カタログ'],
  r42: ['excluded', 'high', '電波銀河の形態分類'],
  r43: ['excluded', 'high', 'ロボット操作の強化学習'],
  r44: ['excluded', 'high', 'ロボット操作の強化学習'],
  r45: ['excluded', 'high', '双腕ロボット制御'],
  r46: ['excluded', 'high', '手術ロボットの Sim-to-Real'],
  r47: ['excluded', 'high', '機械翻訳'],
  r48: ['excluded', 'high', '機械翻訳'],
  r49: ['excluded', 'high', '機械翻訳の総説'],
  r50: ['excluded', 'high', '多言語機械翻訳'],
};

let missing = 0;
for (const p of doc.papers) {
  const l = LABELS[p.id];
  if (!l) {
    console.error(`ラベル未設定: ${p.id} ${p.title}`);
    missing++;
    continue;
  }
  [p.expected, p.label_confidence, p.label_note] = l;
}
if (missing) process.exit(1);

doc._labeling = {
  by: 'Claude（要旨を読んで付与）。当該分野の研究者による判断ではない',
  criterion:
    '(a) 分子物性予測の GNN / (b) 少数データでの転移学習・事前学習 / (c) 較正された不確実性 のいずれかを、このプロジェクトに適用できる形で進めるか',
  caveat: 'tier B のラベルは割れうる。confidence=low の 2 件は特に揺れる。集計時は分けて読むこと',
};

writeFileSync(PATH, JSON.stringify(doc, null, 2), 'utf8');

const count = (f) => doc.papers.filter(f).length;
console.log(`useful ${count((p) => p.expected === 'useful')} / excluded ${count((p) => p.expected === 'excluded')}（計 ${doc.papers.length}）`);
for (const t of ['A', 'B', 'C']) {
  const ps = doc.papers.filter((p) => p.tier === t);
  console.log(
    `  tier ${t}: ${ps.length} 件 useful=${ps.filter((p) => p.expected === 'useful').length} ` +
      `confidence low=${ps.filter((p) => p.label_confidence === 'low').length} medium=${ps.filter((p) => p.label_confidence === 'medium').length}`,
  );
}
console.log(`wrote ${PATH}`);
