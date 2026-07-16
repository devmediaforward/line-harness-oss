'use client'

import type { DiagnosisDefinition } from '@line-crm/shared'
import type { DiagnosisStats } from '@/lib/api'

function Bar({ ratio, color = '#06C755' }: { ratio: number; color?: string }) {
  const pct = Math.max(0, Math.min(1, ratio)) * 100
  return (
    <div className="flex-1 h-2.5 rounded-full bg-gray-100 overflow-hidden">
      <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: color }} />
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-5">
      <h3 className="text-sm font-semibold text-gray-900 mb-3">{title}</h3>
      {children}
    </div>
  )
}

export default function StatsTab({
  stats,
  definition,
  loading = false,
  error = '',
  onReload,
}: {
  stats: DiagnosisStats | null
  definition: DiagnosisDefinition
  loading?: boolean
  error?: string
  onReload?: () => void
}) {
  // 初回取得の失敗でも復旧できるよう、stats が無いときも再読み込みボタンを出す。
  if (!stats) {
    return (
      <div className="space-y-3">
        {loading ? (
          <div className="text-sm text-gray-400">統計を読み込み中...</div>
        ) : (
          <div className={`text-sm ${error ? 'text-rose-600' : 'text-gray-400'}`}>
            {error || '統計はまだ読み込まれていません'}
          </div>
        )}
        {!loading && (
          <button
            onClick={onReload}
            disabled={!onReload}
            className="px-3 py-1.5 text-xs rounded-lg border border-gray-200 hover:bg-gray-50 disabled:opacity-40"
          >
            再読み込み
          </button>
        )}
      </div>
    )
  }

  const ranks = definition.scoring?.ranks ?? []
  const axes = definition.axes ?? []
  const axisLabel = (id: string) => axes.find((a) => a.id === id)?.label ?? id
  const scaleMax = definition.answerScale?.max ?? 5

  const rankMax = Math.max(1, ...ranks.map((r) => stats.rankDistribution[r.rank] ?? 0))
  const histMax = Math.max(1, ...stats.scoreHistogram.map((h) => h.count))
  const tagMax = Math.max(1, ...stats.tagCounts.map((t) => t.count))
  const cardMax = Math.max(1, ...stats.cardCounts.map((c) => c.count))

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-end">
        <button
          onClick={onReload}
          disabled={loading || !onReload}
          className="px-3 py-1.5 text-xs rounded-lg border border-gray-200 hover:bg-gray-50 disabled:opacity-40"
        >
          {loading ? '読み込み中...' : '再読み込み'}
        </button>
      </div>

      <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
        回答が50件程度たまったら、この分布を見てランク区切りを調整してください。
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <div className="text-xs text-gray-400 uppercase tracking-wide">回答数</div>
          <div className="mt-1 text-3xl font-bold text-gray-900 tabular-nums">{stats.total}</div>
        </div>
      </div>

      {stats.total === 0 ? (
        <div className="bg-white rounded-lg border border-gray-200 p-8 text-center text-gray-400 text-sm">
          まだ回答がありません。回答がたまると分布が表示されます。
        </div>
      ) : (
        <>
          <Section title="ランク分布">
            <ul className="space-y-2">
              {ranks.map((r) => {
                const count = stats.rankDistribution[r.rank] ?? 0
                return (
                  <li key={r.rank} className="flex items-center gap-3">
                    <span className="w-8 text-sm font-medium text-gray-700">{r.rank}</span>
                    <Bar ratio={count / rankMax} />
                    <span className="w-10 text-right text-sm text-gray-500 tabular-nums">{count}</span>
                  </li>
                )
              })}
            </ul>
          </Section>

          <Section title="総合点ヒストグラム（10点刻み）">
            <ul className="space-y-1.5">
              {stats.scoreHistogram.map((h) => (
                <li key={h.bucket} className="flex items-center gap-3">
                  <span className="w-14 text-xs text-gray-500 tabular-nums">{h.bucket}</span>
                  <Bar ratio={h.count / histMax} color="#3b82f6" />
                  <span className="w-10 text-right text-sm text-gray-500 tabular-nums">{h.count}</span>
                </li>
              ))}
            </ul>
          </Section>

          <Section title="軸平均">
            <ul className="space-y-2">
              {stats.axisAverages.map((a) => (
                <li key={a.axisId} className="flex items-center gap-3">
                  <span className="flex-1 text-sm text-gray-700 truncate">{axisLabel(a.axisId)}</span>
                  <div className="w-32">
                    <Bar ratio={a.avg / scaleMax} color="#8b5cf6" />
                  </div>
                  <span className="w-12 text-right text-sm text-gray-500 tabular-nums">{a.avg.toFixed(2)}</span>
                </li>
              ))}
            </ul>
          </Section>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            <Section title="タグ出現数">
              {stats.tagCounts.length === 0 ? (
                <div className="text-sm text-gray-400">なし</div>
              ) : (
                <ul className="space-y-2">
                  {stats.tagCounts.map((t) => (
                    <li key={t.tag} className="flex items-center gap-3">
                      <span className="flex-1 text-sm text-gray-700 truncate">{t.tag}</span>
                      <div className="w-28">
                        <Bar ratio={t.count / tagMax} color="#ec4899" />
                      </div>
                      <span className="w-10 text-right text-sm text-gray-500 tabular-nums">{t.count}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            <Section title="カード採用数">
              {stats.cardCounts.length === 0 ? (
                <div className="text-sm text-gray-400">なし</div>
              ) : (
                <ul className="space-y-2">
                  {stats.cardCounts.map((c) => (
                    <li key={c.title} className="flex items-center gap-3">
                      <span className="flex-1 text-sm text-gray-700 truncate">{c.title}</span>
                      <div className="w-28">
                        <Bar ratio={c.count / cardMax} color="#f59e0b" />
                      </div>
                      <span className="w-10 text-right text-sm text-gray-500 tabular-nums">{c.count}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          </div>
        </>
      )}
    </div>
  )
}
