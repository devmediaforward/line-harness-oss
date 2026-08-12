import { getIdToken, getLiffId } from './liff-auth.js';

const BASE = import.meta.env.VITE_API_BASE ?? '';

export interface MenuItem {
  id: string;
  name: string;
  category_label: string | null;
  description: string | null;
  duration_minutes: number;
  buffer_after_minutes: number;
  base_price: number;
  sort_order: number;
}

export interface StaffItem {
  id: string;
  display_name: string;
  role: string | null;
  profile_image_url: string | null;
  bio: string | null;
  is_designation_optional: number;
  price: number;
  duration_minutes: number;
}

export interface AvailabilityResponse {
  by_staff: Array<{
    staff_id: string;
    display_name: string;
    slots: Array<{ date: string; start: string; end: string }>;
  }>;
}

export interface BookingHistoryItem {
  id: string;
  starts_at: string;
  status: string;
  customer_note?: string | null;
  menu_name: string;
  staff_name: string;
  profile_image_url: string | null;
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${getIdToken()}`, ...extra };
}

async function get<T>(path: string): Promise<T> {
  const url = new URL(`${BASE}${path}`, window.location.origin);
  url.searchParams.set('liffId', getLiffId());
  const res = await fetch(url.toString(), { headers: authHeaders() });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json();
}

async function post<T>(path: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
  const url = new URL(`${BASE}${path}`, window.location.origin);
  url.searchParams.set('liffId', getLiffId());
  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json', ...headers }),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    let parsed: unknown = null;
    try { parsed = JSON.parse(text); } catch { /* keep raw */ }
    const err = new Error(`API ${res.status}`) as Error & { status: number; body: unknown };
    err.status = res.status;
    err.body = parsed ?? text;
    throw err;
  }
  return res.json();
}

// ============================================================
// Event booking types
// ============================================================

export interface EventDetail {
  id: string;
  name: string;
  venue_name: string | null;
  venue_url: string | null;
  image_url: string | null;
  description: string | null;
  description_centered: number;
  max_bookings_per_friend: number | null;
  requires_approval: number;
  cancel_deadline_hours_before: number | null;
}

export interface EventSlot {
  id: string;
  event_id: string;
  starts_at: string;
  ends_at: string;
  capacity: number | null;
  is_active: number;
  active_count: number;
  remaining: number | null;
}

export interface EventBookingMine {
  id: string;
  event_id: string;
  status: string;
  customer_note: string | null;
  event_name: string;
  event_image_url: string | null;
  venue_name: string | null;
  venue_url: string | null;
  cancel_deadline_hours_before: number | null;
  slot_starts_at: string;
  slot_ends_at: string;
}

// ============================================================
// Diagnosis types
//   回答用定義 (GET /api/liff/diagnoses/:slug) と
//   結果スナップショット (@line-crm/shared の DiagnosisResult をミラー) 。
//   LIFF アプリは @line-crm/shared に依存しない方針のためローカル定義する。
// ============================================================

export interface DiagnosisMeta {
  name: string;
  description: string;
}

export interface DiagnosisAxis {
  id: string;
  label: string;
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
  direction: 'worry' | 'good';
  worryTag: string | null;
}

/** intro.rankPreview の1件（価格・配点は含まない）。 */
export interface DiagnosisIntroRankPreview {
  rank: string;
  title: string;
  subcopy?: string;
  /** ランク到達に必要な点数（表示用の閾値。設問ごとの配点ではない） */
  minScore?: number;
  imageUrl?: string;
}

/** 診断前画面の表示内容（定義JSON の intro ブロック・任意）。 */
export interface DiagnosisIntro {
  catchCopy?: string;
  subCopy?: string;
  aboutLines?: string[];
  rankPreview?: DiagnosisIntroRankPreview[];
  /** rank -> 透過キャラ画像URL（ヒーロー用） */
  heroImages?: Record<string, string>;
}

/** GET /api/liff/diagnoses/:slug のレスポンス（採点・価格戦略は含まない）。 */
export interface DiagnosisDefinitionForLiff {
  meta: DiagnosisMeta;
  axes: DiagnosisAxis[];
  answerScale: DiagnosisAnswerScale;
  questions: DiagnosisQuestion[];
  intro?: DiagnosisIntro;
}

export type DiagnosisGradeKey = 'keep' | 'almost' | 'warn';

export interface DiagnosisResultAxisScore {
  axisId: string;
  label: string;
  score: number;
  grade: DiagnosisGradeKey;
}

export interface DiagnosisResultTag {
  tag: string;
  axisId: string;
  point?: number;
}

export interface DiagnosisResultCard {
  axisId: string;
  title: string;
  /** 税抜価格。価格未設定のカード（価格未確定のメニュー）では欠落する */
  priceExTax?: number;
  /** 税込価格。priceExTax が無いカードでは欠落する（0 円ではなく「価格なし」） */
  priceInTax?: number;
  priceSuffix: string;
  reason: string;
  extras: string[];
  notes: string[];
  appeal?: string;
  /** 割引後の税込価格（定義に discount がある場合のみ焼き込まれる） */
  discountedPriceInTax?: number;
}

/** おすすめカードの割引表示設定（definition.resultPage.discount のスナップショット）。 */
export interface DiagnosisResultDiscount {
  rate: number;
  badgeLabel?: string;
  conditionLabel?: string;
  notice?: string;
}

/** 予約導線（definition.resultPage.booking のスナップショット）。 */
export interface DiagnosisResultBooking {
  url: string;
  label?: string;
  subText?: string;
}

export interface DiagnosisResultAxisMessage {
  axisId: string;
  message: string;
}

export interface DiagnosisResultWeakPoint {
  axisId: string;
  label: string;
  text: string | null;
}

/** diagnosis_submissions.result に保存されるスナップショット。 */
export interface DiagnosisResult {
  cleanPoints: Record<string, number>;
  axisScores: DiagnosisResultAxisScore[];
  weakestAxes: string[];
  totalScore: number;
  rank: string;
  rankTitle: string;
  rankSubcopy: string;
  rankBody: string;
  tags: DiagnosisResultTag[];
  cards: DiagnosisResultCard[];
  axisMessages: DiagnosisResultAxisMessage[];
  droppedCards: string[];
  emptyState: boolean;
  // 表示用スナップショット（definition 由来・任意。無い場合はビュー側で汎用定数へフォールバック）
  diagnosisName?: string;
  weakPointHeading?: string;
  weakPoints?: DiagnosisResultWeakPoint[];
  softCta?: { text: string; subText?: string };
  minorNotice?: string;
  emptyStateTexts?: { message: string; cta?: string };
  /** 該当ランクのキャラクター画像URL（R6・任意。https:// のみ）。 */
  rankImageUrl?: string;
  /** 割引表示の設定（I4・任意）。cards[].discountedPriceInTax と対で使う。 */
  discount?: DiagnosisResultDiscount;
  /** 予約導線（I5・任意）。 */
  booking?: DiagnosisResultBooking;
}

/** POST submissions / GET submissions/:sid の共通レスポンス。 */
export interface DiagnosisSubmissionResponse {
  submissionId: string;
  result: DiagnosisResult;
  shareUrl: string;
}

export const api = {
  menus: () => get<{ menus: MenuItem[] }>('/api/liff/booking/menus'),
  staffOf: (menuId: string) =>
    get<{ staff: StaffItem[] }>(`/api/liff/booking/menus/${menuId}/staff`),
  availability: (menuId: string, staffId: string | undefined, from: string, to: string) => {
    const qs = new URLSearchParams({ menu_id: menuId, from, to });
    if (staffId) qs.set('staff_id', staffId);
    return get<AvailabilityResponse>(`/api/liff/booking/availability?${qs}`);
  },
  // Worker 側で id_token を verify するので lineUserId は body に入れない。
  createRequest: (
    body: { menu_id: string; staff_id: string; starts_at: string; customer_note?: string },
    idempotencyKey: string,
  ) =>
    post<{ booking_id: string; status: string }>(
      '/api/liff/booking/requests',
      body,
      { 'Idempotency-Key': idempotencyKey },
    ),
  me: () => get<{ upcoming: BookingHistoryItem[]; past: BookingHistoryItem[] }>('/api/liff/booking/me'),

  // ===== Event booking =====
  getEvent: (id: string) => get<EventDetail>(`/api/liff/events/${id}`),
  getEventSlots: (id: string) => get<{ items: EventSlot[] }>(`/api/liff/events/${id}/slots`),
  createEventBooking: (
    eventId: string,
    body: { slot_id: string; customer_note?: string | null },
    idempotencyKey: string,
  ) =>
    post<{ id: string; status: string }>(
      `/api/liff/events/${eventId}/bookings`,
      body,
      { 'Idempotency-Key': idempotencyKey },
    ),
  myEventBookings: (tab: 'upcoming' | 'past') =>
    get<{ items: EventBookingMine[] }>(`/api/liff/events/me?tab=${tab}`),
  cancelMyEventBooking: (bookingId: string) =>
    post<{ ok: true }>(`/api/liff/events/me/${bookingId}/cancel`, {}),

  // ===== Diagnosis =====
  getDiagnosis: (slug: string) =>
    get<DiagnosisDefinitionForLiff>(`/api/liff/diagnoses/${encodeURIComponent(slug)}`),
  // requestId は再送冪等キー(同じ値の再送は二重保存・二重副作用を防ぐ)。
  submitDiagnosis: (slug: string, answers: Record<string, number>, requestId?: string) =>
    post<DiagnosisSubmissionResponse>(
      `/api/liff/diagnoses/${encodeURIComponent(slug)}/submissions`,
      { answers, requestId },
    ),
  getDiagnosisSubmission: (sid: string) =>
    get<DiagnosisSubmissionResponse>(`/api/liff/diagnoses/submissions/${encodeURIComponent(sid)}`),
};
