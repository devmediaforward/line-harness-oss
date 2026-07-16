'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { api } from '@/lib/api'
import type { DiagnosisDetail, DiagnosisStats } from '@/lib/api'
import StatsTab from '@/components/diagnoses/stats-tab'
import BasicSettingsTab from '@/components/diagnoses/basic-settings-tab'
import QuestionsTab from '@/components/diagnoses/questions-tab'
import AdvancedTab from '@/components/diagnoses/advanced-tab'
import SubmissionsTab from '@/components/diagnoses/submissions-tab'

type TabKey = 'stats' | 'basic' | 'questions' | 'advanced' | 'submissions'

const TABS: { key: TabKey; label: string }[] = [
  { key: 'stats', label: '統計' },
  { key: 'basic', label: '基本設定' },
  { key: 'questions', label: '設問' },
  { key: 'advanced', label: '上級設定' },
  { key: 'submissions', label: '回答一覧' },
]

export default function DiagnosisDetailClient({ diagnosisId }: { diagnosisId: string }) {
  const router = useRouter()
  const [detail, setDetail] = useState<DiagnosisDetail | null>(null)
  const [stats, setStats] = useState<DiagnosisStats | null>(null)
  const [statsLoading, setStatsLoading] = useState(false)
  const [statsError, setStatsError] = useState('')
  const [scenarios, setScenarios] = useState<{ id: string; name: string }[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [activeTab, setActiveTab] = useState<TabKey>('stats')
  const [deleting, setDeleting] = useState(false)
  // 統計は初回に統計タブがアクティブになった時のみ取得(保存やタブ切替では再取得しない)。
  const statsRequestedRef = useRef(false)
  // 診断切替後に旧リクエストの遅延応答が届いても無視するための世代カウンタ。
  const statsGenRef = useRef(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    Promise.all([
      api.diagnoses.get(diagnosisId).catch(() => null),
      api.scenarios.list().catch(() => null),
    ]).then(([detailRes, scenRes]) => {
      if (cancelled) return
      if (detailRes && detailRes.success) setDetail(detailRes.data)
      else setError('診断の読み込みに失敗しました')
      if (scenRes && scenRes.success) setScenarios(scenRes.data.map((s) => ({ id: s.id, name: s.name })))
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [diagnosisId])

  // 診断が切り替わったら統計を破棄し、次にタブがアクティブになった時に再取得させる。
  // 世代カウンタを進め、旧診断向けリクエストの遅延応答が届いても上書きさせない。
  useEffect(() => {
    statsGenRef.current += 1
    statsRequestedRef.current = false
    setStats(null)
    setStatsError('')
  }, [diagnosisId])

  const loadStats = useCallback(() => {
    const gen = statsGenRef.current
    setStatsLoading(true)
    setStatsError('')
    api.diagnoses
      .stats(diagnosisId)
      .then((r) => {
        if (gen !== statsGenRef.current) return
        if (r.success) setStats(r.data)
        else setStatsError('統計の読み込みに失敗しました')
      })
      .catch(() => {
        if (gen !== statsGenRef.current) return
        setStatsError('統計の読み込みに失敗しました')
      })
      .finally(() => {
        if (gen !== statsGenRef.current) return
        setStatsLoading(false)
      })
  }, [diagnosisId])

  // 統計タブが初めてアクティブになった時に一度だけ取得。以降は「再読み込み」ボタンで明示更新。
  useEffect(() => {
    if (activeTab === 'stats' && !statsRequestedRef.current) {
      statsRequestedRef.current = true
      loadStats()
    }
  }, [activeTab, loadStats])

  const handleSaved = useCallback((updated: DiagnosisDetail) => {
    setDetail(updated)
  }, [])

  const handleDelete = async () => {
    if (!confirm('この診断を削除しますか？回答もすべて削除されます。')) return
    setDeleting(true)
    try {
      const res = await api.diagnoses.delete(diagnosisId)
      if (res.success) router.push('/diagnoses')
      else setError('削除に失敗しました')
    } catch {
      setError('削除に失敗しました')
    } finally {
      setDeleting(false)
    }
  }

  if (loading) {
    return <div className="p-8 text-center text-sm text-gray-400">読み込み中...</div>
  }
  if (error || !detail) {
    return (
      <div className="p-8 text-center">
        <p className="text-sm text-rose-600 mb-4">{error || '診断が見つかりません'}</p>
        <Link href="/diagnoses" className="text-sm text-[#06C755] hover:underline">
          ← 診断一覧に戻る
        </Link>
      </div>
    )
  }

  return (
    <div>
      <div className="mb-6">
        <Link href="/diagnoses" className="text-xs text-gray-400 hover:text-gray-600">
          ← 診断一覧
        </Link>
        <div className="mt-2 flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold text-gray-900 tracking-tight">{detail.name}</h1>
              <span
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${
                  detail.isActive ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-500'
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${detail.isActive ? 'bg-green-500' : 'bg-gray-400'}`} />
                {detail.isActive ? '有効' : '無効'}
              </span>
            </div>
            <p className="mt-1 text-sm text-gray-500">
              {detail.slug ? <span className="font-mono">{detail.slug}</span> : <span className="text-gray-300">slug 未設定</span>}
              <span className="mx-2 text-gray-300">·</span>
              回答 {detail.submitCount} 件
              <span className="mx-2 text-gray-300">·</span>
              定義 v{detail.definitionVersion}
            </p>
          </div>
          <button
            onClick={handleDelete}
            disabled={deleting}
            className="shrink-0 px-3 py-2 text-sm rounded-lg border border-rose-200 text-rose-600 hover:bg-rose-50 disabled:opacity-50"
          >
            {deleting ? '削除中...' : '削除'}
          </button>
        </div>
      </div>

      <div className="border-b border-gray-200 mb-6">
        <nav className="flex gap-1 overflow-x-auto">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setActiveTab(t.key)}
              className={`px-4 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 transition-colors ${
                activeTab === t.key
                  ? 'border-[#06C755] text-[#06C755]'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </div>

      {activeTab === 'stats' && (
        <StatsTab
          stats={stats}
          definition={detail.definition}
          loading={statsLoading}
          error={statsError}
          onReload={loadStats}
        />
      )}
      {activeTab === 'basic' && <BasicSettingsTab detail={detail} scenarios={scenarios} onSaved={handleSaved} />}
      {activeTab === 'questions' && <QuestionsTab detail={detail} onSaved={handleSaved} />}
      {activeTab === 'advanced' && <AdvancedTab detail={detail} onSaved={handleSaved} />}
      {activeTab === 'submissions' && <SubmissionsTab diagnosisId={diagnosisId} definition={detail.definition} />}
    </div>
  )
}
