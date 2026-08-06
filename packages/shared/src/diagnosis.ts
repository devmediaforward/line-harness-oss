// =============================================================================
// 診断 (Diagnoses) — 定義JSON スキーマ型 と 結果スナップショット型
//
// 03_definition-schema.md / 02_data-model.md 準拠。
// エンジン(apps/worker/src/services/diagnosis/engine.ts)と
// バリデータ(validate.ts)が参照するドメイン型。DB 行型は @line-crm/db 側に
// 別途定義する(forms と同じ分離方針)。
// =============================================================================

// -----------------------------------------------------------------------------
// 定義: トップレベル
// -----------------------------------------------------------------------------

/** 設問の採点方向。worry=逆転(当てはまるほど悪い) / good=そのまま */
export type DiagnosisDirection = 'worry' | 'good';

/** ◎○△ の内部キー */
export type AxisGradeKey = 'keep' | 'almost' | 'warn';

export interface DiagnosisMeta {
  name: string;
  description: string;
}

export interface DiagnosisAxis {
  id: string;
  label: string;
  /** レーダー等の短縮ラベル(任意) */
  shortLabel?: string;
}

export interface DiagnosisAnswerScale {
  min: number;
  max: number;
  labels: string[];
}

export interface DiagnosisQuestion {
  id: string;
  axisId: string;
  text: string;
  direction: DiagnosisDirection;
  /** タグを付けない設問は null */
  worryTag: string | null;
}

export interface DiagnosisAxisGrade {
  /** しきい値下限。warn は null(フォールバック) */
  min: number | null;
  label: string;
  meaning: string;
}

export interface DiagnosisAxisGrades {
  keep: DiagnosisAxisGrade;
  almost: DiagnosisAxisGrade;
  warn: DiagnosisAxisGrade;
}

export interface DiagnosisRank {
  rank: string;
  /** 下限点。0 始まりの昇順で記述 */
  min: number;
  title: string;
  subcopy: string;
  body: string;
}

export interface DiagnosisScoring {
  /** clean_point がこの値以下でタグ付与 */
  tagThreshold: number;
  /** 付与時に clean_point 値も保持するタグ */
  severityTags: string[];
  /** タグ合算(推奨解決の前処理)。source -> target */
  tagMerges: Record<string, string>;
  axisGrades: DiagnosisAxisGrades;
  ranks: DiagnosisRank[];
}

// -----------------------------------------------------------------------------
// 条件DSL (if)
// -----------------------------------------------------------------------------

export type DiagnosisCondition =
  | { hasTag: string }
  | { hasAnyTag: string[] }
  | { hasTagWithPoint: { tag: string; point: number } }
  | { spansGroups: { groupA: string[]; groupB: string[]; minTags: number } }
  | { always: true }
  | { and: DiagnosisCondition[] }
  | { not: DiagnosisCondition }
  | { cardsPresent: string[] };

// -----------------------------------------------------------------------------
// おすすめ解決 (recommendation)
// -----------------------------------------------------------------------------

export interface LookupTableRow {
  /** タグ名の集合(順不同) */
  key: string[];
  title: string;
  priceExTax: number;
  /** 含まれるおまけ部位 */
  extras: string[];
}

export interface LookupSpecialTag {
  mode: 'appeal';
  /** カードが出るとき添える訴求文 */
  appealText: string;
  /** 部位タグ0件でこれだけ立った場合の axisMessages 用文 */
  soloMessage: string;
}

export interface LookupResolver {
  type: 'lookup';
  /** キーとして使うタグ */
  keyTags: string[];
  /** キー外タグの扱い。tag -> 設定 */
  specialTags?: Record<string, LookupSpecialTag>;
  /** 2^n - 1 行。全非空部分集合を網羅 */
  table: LookupTableRow[];
  /** 理由文(デフォルト) */
  reasonTemplate: string;
  /** key に含まれるタグを記述順に探し最初に該当した文を優先(任意) */
  reasonByTag?: Record<string, string>;
  /** {parts}=指定部位, {extras}=おまけ部位 */
  extrasTemplate: string;
}

export interface ResolverCard {
  title: string;
  priceExTax: number;
  /** "＋" 付きメニュー用(任意) */
  priceSuffix?: string;
  reason: string;
}

export interface DiagnosisConditionalNote {
  if: DiagnosisCondition;
  note: string;
}

export interface DiagnosisHomecareAdvice {
  if: DiagnosisCondition;
  advice: string;
}

export interface PriorityRule {
  id: string;
  if: DiagnosisCondition;
  /** 固定カード。明示的にカード無しの場合は null */
  card?: ResolverCard | null;
  /** 立っている該当タグごとのカード(記述順で最初の1つ) */
  cardByTag?: Record<string, ResolverCard>;
  conditionalNotes?: DiagnosisConditionalNote[];
  /** 最初にマッチした助言文を reason に付加 */
  homecareAdvice?: DiagnosisHomecareAdvice[];
}

export interface PriorityRulesResolver {
  type: 'priorityRules';
  rules: PriorityRule[];
}

export type DiagnosisResolver = LookupResolver | PriorityRulesResolver;

export interface DiagnosisNoteRule {
  if: DiagnosisCondition;
  /** 最初に「採用カードが存在する」軸へ添付 */
  attachTo: string[];
  note: string;
}

export interface DiagnosisRecommendation {
  /** 全体最大カード枚数 */
  maxTotal: number;
  /** 軸あたり最大(v1では常に1) */
  maxPerAxis: number;
  /** axisId -> リゾルバ */
  resolvers: Record<string, DiagnosisResolver>;
  /** クロス販促注記(カード枠は増やさない) */
  noteRules: DiagnosisNoteRule[];
}

// -----------------------------------------------------------------------------
// 結果ページ / シェア / 副作用
// -----------------------------------------------------------------------------

export interface DiagnosisSoftCta {
  text: string;
  subText: string;
}

/**
 * 立ちタグ 0 件のときに 1 枚だけ提案するカード(任意)。悩みが無い人にも次の一手を
 * 出すための枠で、通常のおすすめカードと同じ経路(税込計算・割引)に載る。
 */
export interface DiagnosisEmptyStateCard {
  /** どの軸の提案として扱うか。定義の axes に存在する id。 */
  axisId: string;
  title: string;
  priceExTax: number;
  /** "＋" 付きメニュー用。省略時は空文字。 */
  priceSuffix?: string;
  reason: string;
  /**
   * このカードを出す総合点の下限(任意・省略時は下限なし)。悩みタグは「設問の
   * 清潔度が閾値以下」で立つため、立ちタグ 0 件は満点とは限らない(中位の点でも
   * 起こりうる)。上位者だけに出したいときはここで絞る。
   */
  minScore?: number;
}

export interface DiagnosisEmptyState {
  message: string;
  cta: string;
  /** 悩みが無い人向けの提案カード(任意)。無ければ従来どおり文言のみ。 */
  card?: DiagnosisEmptyStateCard;
}

/**
 * おすすめカードの割引表示(任意)。割引率も文言も定義JSON側に置く。
 * 二重価格表示のため conditionLabel を各価格の直下に出す(景表法配慮)。
 */
export interface DiagnosisDiscount {
  /** 割引率。0 < rate < 1 */
  rate: number;
  /** 「NN%OFF」等のバッジ文言 */
  badgeLabel?: string;
  /** 各価格の直下に出す適用条件 */
  conditionLabel?: string;
  /** おすすめセクション冒頭に出す注記 */
  notice?: string;
}

/** 結果ページ・Flex から開く予約導線(任意)。 */
export interface DiagnosisBooking {
  /** 予約先URL。https:// のみ */
  url: string;
  /** ボタン文言(無ければ表示側の汎用既定文言) */
  label?: string;
  /** ボタンに添える一言 */
  subText?: string;
}

export interface DiagnosisResultPage {
  /** 税込価格 = round(priceExTax * (1+taxRate)) */
  taxRate: number;
  weakPointHeading: string;
  /** axisId -> △軸の一言 */
  weakPointTexts: Record<string, string>;
  softCta: DiagnosisSoftCta;
  minorNotice: string;
  emptyState: DiagnosisEmptyState;
  /** rank -> ランク別キャラクター画像URL(任意)。https:// のみ。結果ヒーローの主役 */
  rankImages?: Record<string, string>;
  /** おすすめカードの割引表示(任意) */
  discount?: DiagnosisDiscount;
  /** 予約導線(任意) */
  booking?: DiagnosisBooking;
}

export interface DiagnosisShare {
  enabled: boolean;
  /** rank -> OG画像URL。空文字は未設定 */
  ogImages: Record<string, string>;
  ogTitleTemplate: string;
  ogDescription: string;
  addFriendUrl: string;
  liffUrl: string;
  shareText: string;
}

export interface DiagnosisSideEffects {
  sendResultMessage: boolean;
  addTags: boolean;
  enrollScenarioId: string | null;
  saveToMetadata: boolean;
}

// -----------------------------------------------------------------------------
// 診断前(イントロ)画面
// -----------------------------------------------------------------------------

/** イントロのランク紹介1件。価格・配点は載せない(LIFF に露出するため)。 */
export interface DiagnosisIntroRankPreview {
  /** scoring.ranks に存在するランク名 */
  rank: string;
  title: string;
  subcopy?: string;
  /**
   * 診断前画面に「NN点以上」と表示するためのランク閾値(scoring.ranks[].min と同値)。
   * 設問ごとの配点ではないため LIFF に露出してよい(価格戦略・採点ロジックを含まない)。
   */
  minScore?: number;
  /** ランク紹介行のキャラ画像URL。https:// のみ */
  imageUrl?: string;
}

/**
 * 診断前画面の表示内容(任意)。LIFF 定義API がそのまま返すため、
 * 価格・配点・推奨ロジックに関わる値は絶対に入れないこと。
 */
export interface DiagnosisIntro {
  /** 無ければ meta.name */
  catchCopy?: string;
  /** 無ければ meta.description */
  subCopy?: string;
  /** 「この診断について」の本文行 */
  aboutLines?: string[];
  /** ランク紹介(降順表示はビュー側で行う) */
  rankPreview?: DiagnosisIntroRankPreview[];
  /** rank -> 透過キャラ画像URL(ヒーロー用)。https:// のみ */
  heroImages?: Record<string, string>;
}

/** diagnoses.definition に格納する定義JSON全体 */
export interface DiagnosisDefinition {
  meta: DiagnosisMeta;
  axes: DiagnosisAxis[];
  answerScale: DiagnosisAnswerScale;
  questions: DiagnosisQuestion[];
  scoring: DiagnosisScoring;
  recommendation: DiagnosisRecommendation;
  resultPage: DiagnosisResultPage;
  share: DiagnosisShare;
  sideEffects: DiagnosisSideEffects;
  /** 診断前画面の表示内容(任意)。LIFF 定義APIで返す唯一の追加ブロック */
  intro?: DiagnosisIntro;
}

// -----------------------------------------------------------------------------
// 回答
// -----------------------------------------------------------------------------

/** questionId -> 回答値(answerScale.min..max の整数) */
export type DiagnosisAnswers = Record<string, number>;

// -----------------------------------------------------------------------------
// 結果スナップショット (02_data-model.md)
// -----------------------------------------------------------------------------

export interface ResultAxisScore {
  axisId: string;
  label: string;
  /** 表示用スコア(小数第2位まで) */
  score: number;
  grade: AxisGradeKey;
}

export interface ResultTag {
  tag: string;
  axisId: string;
  /** 重症度保持タグのみ */
  point?: number;
}

export interface ResultCard {
  axisId: string;
  title: string;
  priceExTax: number;
  priceInTax: number;
  /** "＋" 付きメニュー用。無い場合は空文字 */
  priceSuffix: string;
  reason: string;
  /** 含まれるおまけ部位(体毛のみ)。無い場合は空配列 */
  extras: string[];
  /** クロス販促注記・敏感肌注記など。無い場合は空配列 */
  notes: string[];
  /** 自己処理トラブル訴求文(該当時のみ) */
  appeal?: string;
  /** 割引後の税込価格 = floor(priceInTax * (1 - discount.rate))。discount 未設定なら省略 */
  discountedPriceInTax?: number;
}

export interface ResultAxisMessage {
  axisId: string;
  message: string;
}

/** △(warn)軸の弱点情報。text は resultPage.weakPointTexts 由来(無ければ null)。 */
export interface ResultWeakPoint {
  axisId: string;
  label: string;
  text: string | null;
}

/** ソフトCTA(resultPage.softCta のスナップショット)。 */
export interface ResultSoftCta {
  text: string;
  subText?: string;
}

/** 空状態の文言(resultPage.emptyState のスナップショット)。 */
export interface ResultEmptyStateTexts {
  message: string;
  cta?: string;
}

/** エンジン出力 = diagnosis_submissions.result に保存するスナップショット */
export interface DiagnosisResult {
  /** questionId -> 清潔感ポイント(1..5) */
  cleanPoints: Record<string, number>;
  /** 定義の axes 順 */
  axisScores: ResultAxisScore[];
  /** 低い順(同点タイブレーク適用済み) */
  weakestAxes: string[];
  /** 0..100 整数 */
  totalScore: number;
  rank: string;
  rankTitle: string;
  rankSubcopy: string;
  rankBody: string;
  /** 立った悩みタグ(合算処理後) */
  tags: ResultTag[];
  /** 採用されたおすすめ(最大 maxTotal 枚・並び順どおり) */
  cards: ResultCard[];
  /** カードにならないメッセージ(自己処理単独 等) */
  axisMessages: ResultAxisMessage[];
  /** 枚数制限で落ちた軸(統計・デバッグ用) */
  droppedCards: string[];
  /** タグ0件の空状態フラグ */
  emptyState: boolean;

  // ---------------------------------------------------------------------------
  // 表示用スナップショット(02 データモデル: definition を再参照せず結果ページ・
  // 共有ページ・Flex を再構成できるよう、表示に必要な definition 由来文言を焼き込む)。
  // すべて任意(後方互換)。definition 側に該当値が無い場合は省略される。
  // ---------------------------------------------------------------------------

  /** 診断名(definition.meta.name)。共有ページのフッター等に使用 */
  diagnosisName?: string;
  /** △軸セクションの見出し(resultPage.weakPointHeading) */
  weakPointHeading?: string;
  /** grade=warn の軸を weakestAxes 順に。text は resultPage.weakPointTexts[axisId](無ければ null) */
  weakPoints?: ResultWeakPoint[];
  /** ソフトCTA(resultPage.softCta) */
  softCta?: ResultSoftCta;
  /** 未成年注記(resultPage.minorNotice) */
  minorNotice?: string;
  /** 空状態の文言(resultPage.emptyState) */
  emptyStateTexts?: ResultEmptyStateTexts;
  /** 該当ランクのキャラクター画像URL(resultPage.rankImages[rank]。無ければ省略) */
  rankImageUrl?: string;
  /** 割引表示の設定(resultPage.discount)。cards[].discountedPriceInTax と対で使う */
  discount?: DiagnosisDiscount;
  /** 予約導線(resultPage.booking)。結果ページ・Flex はこれだけを見る */
  booking?: DiagnosisBooking;
}
