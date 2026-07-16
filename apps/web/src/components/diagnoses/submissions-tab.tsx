'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import type { DiagnosisDefinition } from '@line-crm/shared'
import { api } from '@/lib/api'
import type { DiagnosisSubmissionSummary, DiagnosisSubmissionDetail } from '@/lib/api'
import ResultSummary from './result-summary'

const PAGE_SIZE = 20
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? ''

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function shareUrlOf(token: string | null): string | null {
  if (!token || !API_URL) return null
  return `${API_URL.replace(/\/$/, '')}/d/${token}`
}

function csvCell(v: string | number | null): string {
  const s = v === null || v === undefined ? '' : String(v)
  // 数式インジェクション対策: = + - @ / タブ / CR で始まる値は先頭に ' を付けて無害化してから、
  // 既存の CSV エスケープ(ダブルクオートで囲み、内部の " を "" へ)を適用する。
  const guarded = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s
  return `"${guarded.replace(/"/g, '""')}"`
}

export default function SubmissionsTab({
  diagnosisId,
  definition,
}: {
  diagnosisId: string
  definition: DiagnosisDefinition
}) {
  const [rows, setRows] = useState<DiagnosisSubmissionSummary[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)

  const [detailSub, setDetailSub] = useState<DiagnosisSubmissionDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

  const questionText = useMemo(() => {
    const m = new Map<string, string>()
    for (const q of definition.questions ?? []) m.set(q.id, q.text)
    return m
  }, [definition])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    api.diagnoses
      .submissions(diagnosisId, { limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE })
      .then((res) => {
        if (cancelled) return
        if (res.success) {
          setRows(res.data)
          setTotal(res.pagination.total)
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [diagnosisId, page])

  const openDetail = useCallback(
    async (sid: string) => {
      setDetailLoading(true)
      setDetailSub(null)
      try {
        const res = await api.diagnoses.submission(diagnosisId, sid)
        if (res.success) setDetailSub(res.data)
      } catch {
        /* silent */
      } finally {
        setDetailLoading(false)
      }
    },
    [diagnosisId],
  )

  const exportCsv = () => {
    const header = ['日時', '友だち名', 'ランク', '総合点', '共有リンク']
    const lines = [header.map(csvCell).join(',')]
    for (const r of rows) {
      lines.push(
        [
          csvCell(formatDateTime(r.createdAt)),
          csvCell(r.friendName ?? '不明'),
          csvCell(r.rank),
          csvCell(r.totalScore),
          csvCell(shareUrlOf(r.shareToken) ?? ''),
        ].join(','),
      )
    }
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `diagnosis-submissions-${diagnosisId}-p${page}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm text-gray-500">{loading ? '読み込み中...' : `全 ${total} 件`}</span>
        <button
          onClick={exportCsv}
          disabled={rows.length === 0}
          className="px-3 py-1.5 text-xs rounded-lg border border-gray-200 hover:bg-gray-50 disabled:opacity-40"
        >
          CSV（表示中のページ）
        </button>
      </div>

      {loading ? (
        <div className="bg-white rounded-lg border border-gray-200 p-8 text-center text-gray-400 text-sm">読み込み中...</div>
      ) : rows.length === 0 ? (
        <div className="bg-white rounded-lg border border-gray-200 p-8 text-center text-gray-400 text-sm">回答がありません</div>
      ) : (
        <>
          <div className="bg-white rounded-lg border border-gray-200 overflow-x-auto">
            <table className="w-full min-w-[720px]">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase whitespace-nowrap">日時</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase whitespace-nowrap">友だち名</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase whitespace-nowrap">ランク</th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase whitespace-nowrap">総合点</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase whitespace-nowrap">共有リンク</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rows.map((r) => {
                  const url = shareUrlOf(r.shareToken)
                  return (
                    <tr key={r.id} onClick={() => openDetail(r.id)} className="hover:bg-gray-50 cursor-pointer">
                      <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">{formatDateTime(r.createdAt)}</td>
                      <td className="px-4 py-3 text-sm font-medium text-gray-900 whitespace-nowrap">{r.friendName || '不明'}</td>
                      <td className="px-4 py-3 text-sm text-gray-700 whitespace-nowrap">{r.rank ?? '—'}</td>
                      <td className="px-4 py-3 text-sm text-gray-700 text-right tabular-nums whitespace-nowrap">{r.totalScore ?? '—'}</td>
                      <td className="px-4 py-3 text-xs whitespace-nowrap">
                        {url ? (
                          <a
                            href={url}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="text-[#06C755] hover:underline"
                          >
                            開く ↗
                          </a>
                        ) : (
                          <span className="text-gray-300">—</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between mt-4">
              <p className="text-xs text-gray-400">
                {(page - 1) * PAGE_SIZE + 1}〜{Math.min(page * PAGE_SIZE, total)} 件 / 全 {total} 件
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page === 1}
                  className="px-3 py-1.5 text-sm rounded-lg border border-gray-200 disabled:opacity-30 hover:bg-gray-50"
                >
                  前へ
                </button>
                <span className="px-3 py-1.5 text-sm text-gray-500">
                  {page} / {totalPages}
                </span>
                <button
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page === totalPages}
                  className="px-3 py-1.5 text-sm rounded-lg border border-gray-200 disabled:opacity-30 hover:bg-gray-50"
                >
                  次へ
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {(detailSub || detailLoading) && (
        <div className="fixed inset-0 z-40 flex justify-end">
          <div className="absolute inset-0 bg-black/30" onClick={() => setDetailSub(null)} aria-hidden />
          <aside className="relative h-full w-full max-w-md bg-white shadow-xl overflow-y-auto">
            <div className="sticky top-0 bg-white border-b border-gray-200 px-5 py-4 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-gray-900">回答詳細</h3>
              <button
                onClick={() => setDetailSub(null)}
                className="text-gray-400 hover:text-gray-600 text-lg leading-none"
                aria-label="閉じる"
              >
                ×
              </button>
            </div>

            <div className="p-5 space-y-5">
              {detailLoading ? (
                <div className="text-sm text-gray-400">読み込み中...</div>
              ) : detailSub ? (
                <>
                  <div>
                    <div className="text-[11px] text-gray-400 uppercase tracking-wide mb-1">送信日時</div>
                    <div className="text-sm text-gray-700">{formatDateTime(detailSub.createdAt)}</div>
                  </div>

                  <div>
                    <div className="text-[11px] text-gray-400 uppercase tracking-wide mb-2">結果スナップショット</div>
                    <ResultSummary result={detailSub.result} />
                  </div>

                  <div>
                    <div className="text-[11px] text-gray-400 uppercase tracking-wide mb-2">回答値</div>
                    <dl className="space-y-2">
                      {Object.entries(detailSub.answers).map(([qid, val]) => (
                        <div key={qid} className="grid grid-cols-1 gap-0.5">
                          <dt className="text-[11px] text-gray-500">
                            <span className="font-mono">{qid}</span>
                            {questionText.get(qid) ? ` · ${questionText.get(qid)}` : ''}
                          </dt>
                          <dd className="text-sm text-gray-900 tabular-nums">{val}</dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                </>
              ) : null}
            </div>
          </aside>
        </div>
      )}
    </div>
  )
}
