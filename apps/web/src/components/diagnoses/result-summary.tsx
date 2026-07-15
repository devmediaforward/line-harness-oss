'use client'

import type { DiagnosisResult, AxisGradeKey } from '@line-crm/shared'

// ◎○△ の表示 (grade ラベルはスナップショットに無いため定数。LIFF 側 DiagnosisResultView と同トーン)
const GRADE_DISPLAY: Record<AxisGradeKey, { symbol: string; label: string; color: string }> = {
  keep: { symbol: '◎', label: 'キープ', color: '#16a34a' },
  almost: { symbol: '○', label: 'あと少し', color: '#ca8a04' },
  warn: { symbol: '△', label: '要注意', color: '#dc2626' },
}

/** DiagnosisResult スナップショットを整形表示する (テスト実行 / 回答詳細で共用)。 */
export default function ResultSummary({ result }: { result: DiagnosisResult }) {
  const axisScores = result.axisScores ?? []
  const tags = result.tags ?? []
  const cards = result.cards ?? []
  const axisMessages = result.axisMessages ?? []

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4">
        <div className="flex items-baseline gap-1.5">
          <span className="text-3xl font-bold text-gray-900">{result.rank ?? '—'}</span>
          {result.rankTitle && <span className="text-sm text-gray-500">{result.rankTitle}</span>}
        </div>
        <div className="flex items-baseline gap-1">
          <span className="text-2xl font-bold text-gray-900 tabular-nums">{result.totalScore ?? 0}</span>
          <span className="text-xs text-gray-400">点</span>
        </div>
        {result.emptyState && (
          <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-500">空状態</span>
        )}
      </div>

      <div>
        <div className="text-[11px] text-gray-400 uppercase tracking-wide mb-1.5">軸スコア</div>
        {axisScores.length === 0 ? (
          <div className="text-sm text-gray-400">—</div>
        ) : (
          <ul className="space-y-1">
            {axisScores.map((a) => {
              const g = GRADE_DISPLAY[a.grade] ?? { symbol: '', label: '', color: '#6b7280' }
              return (
                <li key={a.axisId} className="flex items-center justify-between text-sm">
                  <span className="text-gray-700">{a.label || a.axisId}</span>
                  <span className="flex items-center gap-2">
                    <span className="font-medium" style={{ color: g.color }}>
                      {g.symbol} {g.label}
                    </span>
                    <span className="tabular-nums text-gray-500 min-w-[3ch] text-right">{a.score?.toFixed(1)}</span>
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <div>
        <div className="text-[11px] text-gray-400 uppercase tracking-wide mb-1.5">悩みタグ</div>
        {tags.length === 0 ? (
          <div className="text-sm text-gray-400">なし</div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {tags.map((t) => (
              <span key={t.tag} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-rose-50 border border-rose-100 text-xs text-rose-700">
                {t.tag}
                {typeof t.point === 'number' && <span className="text-rose-400 tabular-nums">{t.point}</span>}
              </span>
            ))}
          </div>
        )}
      </div>

      <div>
        <div className="text-[11px] text-gray-400 uppercase tracking-wide mb-1.5">おすすめカード</div>
        {cards.length === 0 ? (
          <div className="text-sm text-gray-400">なし</div>
        ) : (
          <ul className="space-y-2">
            {cards.map((c, i) => (
              <li key={i} className="rounded-lg border border-gray-200 p-3">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-sm font-medium text-gray-900">{c.title}</span>
                  <span className="text-sm text-gray-700 tabular-nums whitespace-nowrap">
                    {c.priceInTax != null ? `¥${c.priceInTax.toLocaleString()}` : `¥${c.priceExTax?.toLocaleString?.() ?? c.priceExTax}`}
                    {c.priceSuffix}
                  </span>
                </div>
                {c.reason && <p className="mt-1 text-xs text-gray-500 whitespace-pre-wrap">{c.reason}</p>}
                {c.extras && c.extras.length > 0 && (
                  <p className="mt-1 text-[11px] text-gray-400">おまけ: {c.extras.join(', ')}</p>
                )}
                {c.notes && c.notes.length > 0 && (
                  <ul className="mt-1 text-[11px] text-amber-600 list-disc pl-4">
                    {c.notes.map((n, ni) => (
                      <li key={ni}>{n}</li>
                    ))}
                  </ul>
                )}
                {c.appeal && <p className="mt-1 text-[11px] text-emerald-600">{c.appeal}</p>}
              </li>
            ))}
          </ul>
        )}
      </div>

      {axisMessages.length > 0 && (
        <div>
          <div className="text-[11px] text-gray-400 uppercase tracking-wide mb-1.5">メッセージ</div>
          <ul className="space-y-1 text-sm text-gray-600">
            {axisMessages.map((m, i) => (
              <li key={i} className="whitespace-pre-wrap">{m.message}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
