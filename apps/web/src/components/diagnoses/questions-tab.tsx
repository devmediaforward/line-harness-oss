'use client'

import { useMemo, useState } from 'react'
import type { DiagnosisDefinition, DiagnosisQuestion, DiagnosisDirection } from '@line-crm/shared'
import { api } from '@/lib/api'
import type { DiagnosisDetail } from '@/lib/api'

const inputCls = 'w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm'

export default function QuestionsTab({
  detail,
  onSaved,
}: {
  detail: DiagnosisDetail
  onSaved: (updated: DiagnosisDetail) => void
}) {
  const def = detail.definition
  const axes = def.axes ?? []
  const hasSubmissions = detail.submitCount > 0

  const [questions, setQuestions] = useState<DiagnosisQuestion[]>(() =>
    (def.questions ?? []).map((q) => ({ ...q })),
  )
  const [originalIds] = useState<string[]>(() => (def.questions ?? []).map((q) => q.id))

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [errors, setErrors] = useState<string[]>([])
  const [savedFlash, setSavedFlash] = useState(false)

  const currentIds = useMemo(() => new Set(questions.map((q) => q.id)), [questions])
  const idChangeWarning = hasSubmissions && originalIds.some((oid) => !currentIds.has(oid))

  const update = (i: number, patch: Partial<DiagnosisQuestion>) => {
    setQuestions((prev) => prev.map((q, idx) => (idx === i ? { ...q, ...patch } : q)))
  }
  const move = (i: number, dir: -1 | 1) => {
    setQuestions((prev) => {
      const next = [...prev]
      const j = i + dir
      if (j < 0 || j >= next.length) return prev
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })
  }
  const remove = (i: number) => setQuestions((prev) => prev.filter((_, idx) => idx !== i))
  const add = () => {
    const n = questions.length + 1
    let id = `q${n}`
    const existing = new Set(questions.map((q) => q.id))
    let k = n
    while (existing.has(id)) {
      k++
      id = `q${k}`
    }
    setQuestions((prev) => [
      ...prev,
      { id, axisId: axes[0]?.id ?? '', text: '', direction: 'worry', worryTag: null },
    ])
  }

  // validate API のメッセージを設問 id ごとに振り分ける (行単位表示)。
  const errorsByQuestion = useMemo(() => {
    const map = new Map<string, string[]>()
    const general: string[] = []
    for (const er of errors) {
      const matched = questions.find((q) => q.id && er.includes(`"${q.id}"`))
      if (matched) {
        const arr = map.get(matched.id) ?? []
        arr.push(er)
        map.set(matched.id, arr)
      } else {
        general.push(er)
      }
    }
    return { map, general }
  }, [errors, questions])

  const handleSave = async () => {
    setError('')
    setErrors([])
    setSavedFlash(false)

    const merged: DiagnosisDefinition = {
      ...def,
      questions: questions.map((q) => ({
        id: q.id,
        axisId: q.axisId,
        text: q.text,
        direction: q.direction,
        worryTag: q.worryTag && q.worryTag.trim() !== '' ? q.worryTag : null,
      })),
    }

    setSaving(true)
    try {
      const vres = await api.diagnoses.validate(merged)
      if (vres.success && !vres.data.valid) {
        setErrors(vres.data.errors)
        setError('設問の検証でエラーが出ました。各行を修正してください。')
        setSaving(false)
        return
      }
      const res = await api.diagnoses.update(detail.id, { definition: merged })
      if (res.success) {
        onSaved(res.data)
        setSavedFlash(true)
      } else {
        if (res.errors) setErrors(res.errors)
        setError(res.error ?? '保存に失敗しました')
      }
    } catch {
      setError('保存に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      {idChangeWarning && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          この診断には既に回答があります。設問 ID を変更・削除すると、過去の回答（answers）と設問の対応が取れなくなります。ご注意ください。
        </div>
      )}

      <div className="space-y-3">
        {questions.map((q, i) => {
          const rowErrors = errorsByQuestion.map.get(q.id) ?? []
          const idChanged = hasSubmissions && originalIds.includes(q.id) === false && i < originalIds.length
          return (
            <div key={i} className="bg-white rounded-lg border border-gray-200 p-3">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-xs text-gray-400 w-6">{i + 1}</span>
                <div className="flex items-center gap-1">
                  <span className="text-xs text-gray-400">ID</span>
                  <input
                    value={q.id}
                    onChange={(e) => update(i, { id: e.target.value })}
                    className="w-24 rounded-md border border-gray-300 px-2 py-1.5 text-sm font-mono"
                  />
                </div>
                <div className="ml-auto flex items-center gap-1">
                  <button onClick={() => move(i, -1)} disabled={i === 0} className="px-2 py-1 text-xs rounded border border-gray-200 disabled:opacity-30 hover:bg-gray-50">
                    ↑
                  </button>
                  <button onClick={() => move(i, 1)} disabled={i === questions.length - 1} className="px-2 py-1 text-xs rounded border border-gray-200 disabled:opacity-30 hover:bg-gray-50">
                    ↓
                  </button>
                  <button onClick={() => remove(i)} className="px-2 py-1 text-xs rounded border border-rose-200 text-rose-600 hover:bg-rose-50">
                    削除
                  </button>
                </div>
              </div>
              {idChanged && (
                <div className="mb-2 text-[11px] text-amber-600">この設問の ID が変更されています</div>
              )}
              <input
                value={q.text}
                onChange={(e) => update(i, { text: e.target.value })}
                placeholder="質問文"
                className={`${inputCls} mb-2`}
              />
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <label className="block">
                  <span className="block text-[11px] text-gray-500 mb-0.5">軸</span>
                  <select value={q.axisId} onChange={(e) => update(i, { axisId: e.target.value })} className={inputCls}>
                    {axes.map((ax) => (
                      <option key={ax.id} value={ax.id}>
                        {ax.label || ax.id}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="block text-[11px] text-gray-500 mb-0.5">採点方向</span>
                  <select
                    value={q.direction}
                    onChange={(e) => update(i, { direction: e.target.value as DiagnosisDirection })}
                    className={inputCls}
                  >
                    <option value="worry">worry（逆転・当てはまるほど悪い）</option>
                    <option value="good">good（そのまま）</option>
                  </select>
                </label>
                <label className="block">
                  <span className="block text-[11px] text-gray-500 mb-0.5">worryTag（任意）</span>
                  <input
                    value={q.worryTag ?? ''}
                    onChange={(e) => update(i, { worryTag: e.target.value })}
                    placeholder="タグを付けない場合は空"
                    className={inputCls}
                  />
                </label>
              </div>
              {rowErrors.length > 0 && (
                <ul className="mt-2 text-[11px] text-rose-600 list-disc pl-4 space-y-0.5">
                  {rowErrors.map((er, ei) => (
                    <li key={ei}>{er}</li>
                  ))}
                </ul>
              )}
            </div>
          )
        })}
        <button onClick={add} className="text-sm text-[#06C755] hover:underline">
          + 設問を追加
        </button>
      </div>

      {error && <div className="text-sm text-rose-600">{error}</div>}
      {errorsByQuestion.general.length > 0 && (
        <ul className="text-xs text-rose-600 list-disc pl-5 space-y-0.5 max-h-48 overflow-y-auto">
          {errorsByQuestion.general.map((er, i) => (
            <li key={i}>{er}</li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-3">
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-5 py-2.5 text-sm font-medium text-white rounded-lg transition-opacity hover:opacity-90 disabled:opacity-50"
          style={{ backgroundColor: '#06C755' }}
        >
          {saving ? '保存中...' : '保存する'}
        </button>
        <span className="text-xs text-gray-400">保存すると definition のバージョンが上がります（現在 v{detail.definitionVersion}）</span>
        {savedFlash && <span className="text-xs text-[#06C755]">保存しました</span>}
      </div>
    </div>
  )
}
