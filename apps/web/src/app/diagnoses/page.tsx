'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { api } from '@/lib/api'
import type { DiagnosisListItem } from '@/lib/api'
import { emptyDiagnosisDefinition } from '@/lib/diagnosis-template'
import Header from '@/components/layout/header'

function formatRelative(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  const diffMin = Math.floor((Date.now() - d.getTime()) / 60000)
  if (diffMin < 1) return 'たった今'
  if (diffMin < 60) return `${diffMin}分前`
  if (diffMin < 60 * 24) return `${Math.floor(diffMin / 60)}時間前`
  if (diffMin < 60 * 24 * 7) return `${Math.floor(diffMin / (60 * 24))}日前`
  return d.toLocaleDateString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit' })
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

type CreateMode = 'template' | 'json'

export default function DiagnosesPage() {
  const router = useRouter()
  const [items, setItems] = useState<DiagnosisListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [modalOpen, setModalOpen] = useState(false)
  const [mode, setMode] = useState<CreateMode>('template')
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [jsonText, setJsonText] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState('')
  const [createErrors, setCreateErrors] = useState<string[]>([])

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await api.diagnoses.list()
      if (res.success) setItems(res.data)
      else setError('診断の読み込みに失敗しました')
    } catch {
      setError('診断の読み込みに失敗しました')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const openModal = () => {
    setMode('template')
    setName('')
    setSlug('')
    setJsonText('')
    setCreateError('')
    setCreateErrors([])
    setModalOpen(true)
  }

  const handleCreate = async () => {
    setCreateError('')
    setCreateErrors([])
    if (!name.trim()) {
      setCreateError('名前を入力してください')
      return
    }

    let definition: unknown
    if (mode === 'template') {
      definition = emptyDiagnosisDefinition(name.trim())
    } else {
      try {
        definition = JSON.parse(jsonText)
      } catch {
        setCreateError('JSON の構文が正しくありません')
        return
      }
    }

    setCreating(true)
    try {
      // 貼り付け JSON は先に検証してエラーを日本語で提示する (POST 400 は throw されるため)。
      if (mode === 'json') {
        const vres = await api.diagnoses.validate(definition)
        if (vres.success && !vres.data.valid) {
          setCreateErrors(vres.data.errors)
          setCreateError('定義が不正です。以下を修正してください。')
          setCreating(false)
          return
        }
      }
      const res = await api.diagnoses.create({
        name: name.trim(),
        slug: slug.trim() || null,
        definition: definition as ReturnType<typeof emptyDiagnosisDefinition>,
      })
      if (res.success) {
        setModalOpen(false)
        router.push(`/diagnoses/detail?id=${res.data.id}`)
      } else {
        if (res.errors && res.errors.length > 0) setCreateErrors(res.errors)
        setCreateError(res.error ?? '作成に失敗しました')
      }
    } catch {
      setCreateError('作成に失敗しました（slug の重複などをご確認ください）')
    } finally {
      setCreating(false)
    }
  }

  const handleToggleActive = async (id: string, current: boolean) => {
    try {
      const res = await api.diagnoses.update(id, { isActive: !current })
      if (res.success) {
        setItems((prev) => prev.map((it) => (it.id === id ? { ...it, isActive: !current } : it)))
      }
    } catch {
      setError('ステータスの変更に失敗しました')
    }
  }

  return (
    <div>
      <Header
        title="診断"
        description="診断コンテンツの作成・編集と回答の分析"
        action={
          <button
            onClick={openModal}
            className="px-4 py-2 min-h-[44px] text-sm font-medium text-white rounded-lg transition-opacity hover:opacity-90"
            style={{ backgroundColor: '#06C755' }}
          >
            + 新規作成
          </button>
        }
      />

      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>
      )}

      {loading ? (
        <div className="text-sm text-gray-400">読み込み中...</div>
      ) : items.length === 0 ? (
        <div className="bg-white rounded-lg border border-gray-200 p-8 text-center text-gray-400 text-sm">
          診断がまだありません。「新規作成」から追加してください。
        </div>
      ) : (
        <div className="bg-white rounded-lg border border-gray-200 overflow-x-auto">
          <table className="w-full min-w-[760px]">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase whitespace-nowrap">名前</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase whitespace-nowrap">slug</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase whitespace-nowrap">状態</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase whitespace-nowrap">回答数</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase whitespace-nowrap">最終回答</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase whitespace-nowrap">更新</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {items.map((it) => (
                <tr
                  key={it.id}
                  onClick={() => router.push(`/diagnoses/detail?id=${it.id}`)}
                  className="hover:bg-gray-50 cursor-pointer"
                >
                  <td className="px-4 py-3 text-sm font-medium text-gray-900 whitespace-nowrap">{it.name}</td>
                  <td className="px-4 py-3 text-sm text-gray-500 whitespace-nowrap font-mono">{it.slug || '—'}</td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        handleToggleActive(it.id, it.isActive)
                      }}
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${
                        it.isActive
                          ? 'bg-green-50 text-green-700 hover:bg-green-100'
                          : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                      }`}
                      title="クリックで切り替え"
                    >
                      <span className={`w-1.5 h-1.5 rounded-full ${it.isActive ? 'bg-green-500' : 'bg-gray-400'}`} />
                      {it.isActive ? '有効' : '無効'}
                    </button>
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-700 text-right tabular-nums whitespace-nowrap">{it.submitCount}</td>
                  <td className="px-4 py-3 text-xs text-gray-400 whitespace-nowrap">{formatRelative(it.lastSubmittedAt)}</td>
                  <td className="px-4 py-3 text-xs text-gray-400 whitespace-nowrap">{formatDateTime(it.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40" onClick={() => setModalOpen(false)} aria-hidden />
          <div className="relative bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
            <div className="sticky top-0 bg-white border-b border-gray-200 px-5 py-4 flex items-center justify-between">
              <h3 className="text-base font-semibold text-gray-900">診断を新規作成</h3>
              <button onClick={() => setModalOpen(false)} className="text-gray-400 hover:text-gray-600 text-lg leading-none" aria-label="閉じる">
                ×
              </button>
            </div>

            <div className="p-5 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">名前</label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="例: 清潔感診断"
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">slug（任意・URL に使用）</label>
                <input
                  value={slug}
                  onChange={(e) => setSlug(e.target.value)}
                  placeholder="例: cleanliness"
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm font-mono"
                />
              </div>

              <div>
                <div className="block text-sm font-medium text-gray-700 mb-2">作成方法</div>
                <div className="flex gap-2">
                  <button
                    onClick={() => setMode('template')}
                    className={`flex-1 rounded-lg border px-3 py-2 text-sm text-left transition-colors ${
                      mode === 'template' ? 'border-[#06C755] bg-[#F1FBF5] text-[#06C755]' : 'border-gray-200 hover:border-gray-300'
                    }`}
                  >
                    <div className="font-medium">空の雛形で作成</div>
                    <div className="text-xs text-gray-400 mt-0.5">1軸1問の最小構成から始める</div>
                  </button>
                  <button
                    onClick={() => setMode('json')}
                    className={`flex-1 rounded-lg border px-3 py-2 text-sm text-left transition-colors ${
                      mode === 'json' ? 'border-[#06C755] bg-[#F1FBF5] text-[#06C755]' : 'border-gray-200 hover:border-gray-300'
                    }`}
                  >
                    <div className="font-medium">JSON を貼り付けて作成</div>
                    <div className="text-xs text-gray-400 mt-0.5">既存の定義 JSON を読み込む</div>
                  </button>
                </div>
              </div>

              {mode === 'json' && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">定義 JSON</label>
                  <textarea
                    value={jsonText}
                    onChange={(e) => setJsonText(e.target.value)}
                    rows={10}
                    spellCheck={false}
                    placeholder='{ "meta": { ... }, "axes": [ ... ], ... }'
                    className="w-full rounded-md border border-gray-300 px-3 py-2 text-xs font-mono"
                  />
                </div>
              )}

              {createError && <div className="text-sm text-rose-600">{createError}</div>}
              {createErrors.length > 0 && (
                <ul className="text-xs text-rose-600 list-disc pl-5 space-y-0.5 max-h-40 overflow-y-auto">
                  {createErrors.map((er, i) => (
                    <li key={i}>{er}</li>
                  ))}
                </ul>
              )}
            </div>

            <div className="sticky bottom-0 bg-white border-t border-gray-200 px-5 py-4 flex justify-end gap-2">
              <button onClick={() => setModalOpen(false)} className="px-4 py-2 text-sm rounded-lg border border-gray-200 hover:bg-gray-50">
                キャンセル
              </button>
              <button
                onClick={handleCreate}
                disabled={creating}
                className="px-4 py-2 text-sm font-medium text-white rounded-lg transition-opacity hover:opacity-90 disabled:opacity-50"
                style={{ backgroundColor: '#06C755' }}
              >
                {creating ? '作成中...' : '作成する'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
