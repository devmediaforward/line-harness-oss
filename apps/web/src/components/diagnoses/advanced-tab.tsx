'use client'

import { useState, useEffect, useRef } from 'react'
import type { DiagnosisResult } from '@line-crm/shared'
import { api } from '@/lib/api'
import type { DiagnosisDetail } from '@/lib/api'
import ResultSummary from './result-summary'

type ValidState = 'unknown' | 'valid' | 'invalid'

export default function AdvancedTab({
  detail,
  onSaved,
}: {
  detail: DiagnosisDetail
  onSaved: (updated: DiagnosisDetail) => void
}) {
  const [jsonText, setJsonText] = useState(() => JSON.stringify(detail.definition, null, 2))
  const [validState, setValidState] = useState<ValidState>('unknown')
  const [validErrors, setValidErrors] = useState<string[]>([])
  const [validating, setValidating] = useState(false)

  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [savedFlash, setSavedFlash] = useState(false)

  // テスト実行
  const questions = detail.definition.questions ?? []
  const scaleMin = detail.definition.answerScale?.min ?? 1
  const scaleMax = detail.definition.answerScale?.max ?? 5
  const mid = Math.round((scaleMin + scaleMax) / 2)
  const [answers, setAnswers] = useState<Record<string, number>>(() => {
    const init: Record<string, number> = {}
    for (const q of questions) init[q.id] = scaleMin
    return init
  })
  const [previewResult, setPreviewResult] = useState<DiagnosisResult | null>(null)
  const [previewError, setPreviewError] = useState('')
  const [previewing, setPreviewing] = useState(false)

  // JSON 保存で definition が変わると definitionVersion が上がる。テスト実行の回答セットは
  // 旧設問 id のまま残るため、バージョン変化を検知して新しい definition.questions から作り直す。
  const lastVersionRef = useRef(detail.definitionVersion)
  useEffect(() => {
    if (lastVersionRef.current === detail.definitionVersion) return
    lastVersionRef.current = detail.definitionVersion
    const nextMin = detail.definition.answerScale?.min ?? 1
    const rebuilt: Record<string, number> = {}
    for (const q of detail.definition.questions ?? []) rebuilt[q.id] = nextMin
    setAnswers(rebuilt)
  }, [detail.definitionVersion, detail.definition])

  const onEdit = (v: string) => {
    setJsonText(v)
    setValidState('unknown')
    setValidErrors([])
    setSavedFlash(false)
  }

  const handleValidate = async () => {
    setValidErrors([])
    let parsed: unknown
    try {
      parsed = JSON.parse(jsonText)
    } catch (e) {
      setValidState('invalid')
      setValidErrors([`JSON 構文エラー: ${(e as Error).message}`])
      return
    }
    setValidating(true)
    try {
      const res = await api.diagnoses.validate(parsed)
      if (res.success) {
        if (res.data.valid) {
          setValidState('valid')
          setValidErrors([])
        } else {
          setValidState('invalid')
          setValidErrors(res.data.errors)
        }
      } else {
        setValidState('invalid')
        setValidErrors(['検証に失敗しました'])
      }
    } catch {
      setValidState('invalid')
      setValidErrors(['検証に失敗しました'])
    } finally {
      setValidating(false)
    }
  }

  const handleSave = async () => {
    setSaveError('')
    setSavedFlash(false)
    let parsed: unknown
    try {
      parsed = JSON.parse(jsonText)
    } catch {
      setSaveError('JSON の構文が正しくありません')
      return
    }
    setSaving(true)
    try {
      const res = await api.diagnoses.update(detail.id, {
        definition: parsed as DiagnosisDetail['definition'],
      })
      if (res.success) {
        onSaved(res.data)
        setSavedFlash(true)
        setJsonText(JSON.stringify(res.data.definition, null, 2))
      } else {
        setSaveError(res.error ?? '保存に失敗しました')
      }
    } catch {
      setSaveError('保存に失敗しました（定義が不正な可能性があります）')
    } finally {
      setSaving(false)
    }
  }

  const setAllAnswers = (v: number) => {
    setAnswers(() => {
      const next: Record<string, number> = {}
      for (const q of questions) next[q.id] = v
      return next
    })
  }

  const handlePreview = async () => {
    setPreviewError('')
    setPreviewResult(null)
    setPreviewing(true)
    try {
      const res = await api.diagnoses.preview(detail.id, answers)
      if (res.success) setPreviewResult(res.data.result)
      else setPreviewError(res.error ?? 'テスト実行に失敗しました')
    } catch {
      setPreviewError('テスト実行に失敗しました（保存済みの定義を確認してください）')
    } finally {
      setPreviewing(false)
    }
  }

  return (
    <div className="space-y-5">
      <div className="bg-white rounded-lg border border-gray-200 p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-gray-900">定義 JSON</h3>
          <div className="flex items-center gap-2">
            {validState === 'valid' && <span className="text-xs text-[#06C755]">✓ 検証OK</span>}
            {validState === 'invalid' && <span className="text-xs text-rose-600">検証エラーあり</span>}
            <button
              onClick={handleValidate}
              disabled={validating}
              className="px-3 py-1.5 text-sm rounded-lg border border-gray-200 hover:bg-gray-50 disabled:opacity-50"
            >
              {validating ? '検証中...' : '検証'}
            </button>
            <button
              onClick={handleSave}
              disabled={saving || validState !== 'valid'}
              title={validState !== 'valid' ? '先に「検証」で問題がないことを確認してください' : ''}
              className="px-4 py-1.5 text-sm font-medium text-white rounded-lg hover:opacity-90 disabled:opacity-50"
              style={{ backgroundColor: '#06C755' }}
            >
              {saving ? '保存中...' : '保存する'}
            </button>
          </div>
        </div>

        <textarea
          value={jsonText}
          onChange={(e) => onEdit(e.target.value)}
          rows={22}
          spellCheck={false}
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-xs font-mono leading-relaxed"
          style={{ tabSize: 2 }}
        />

        <div className="mt-2 flex items-center gap-3">
          <span className="text-xs text-gray-400">
            保存すると definition のバージョンが上がります（現在 v{detail.definitionVersion}）
          </span>
          {savedFlash && <span className="text-xs text-[#06C755]">保存しました</span>}
        </div>
        {saveError && <div className="mt-2 text-sm text-rose-600">{saveError}</div>}

        {validErrors.length > 0 && (
          <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 p-3">
            <div className="text-xs font-medium text-rose-700 mb-1">検証結果（{validErrors.length} 件）</div>
            <ul className="text-xs text-rose-600 list-disc pl-5 space-y-0.5 max-h-56 overflow-y-auto">
              {validErrors.map((er, i) => (
                <li key={i}>{er}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="bg-white rounded-lg border border-gray-200 p-5">
        <h3 className="text-sm font-semibold text-gray-900 mb-1">テスト実行</h3>
        <p className="text-xs text-gray-400 mb-3">
          保存済みの定義に対して採点エンジンを実行します（保存・副作用なし）。JSON を編集した場合は先に保存してください。
        </p>

        <div className="flex flex-wrap items-center gap-2 mb-4">
          <span className="text-xs text-gray-500">プリセット:</span>
          <button onClick={() => setAllAnswers(scaleMin)} className="px-3 py-1.5 text-xs rounded-lg border border-gray-200 hover:bg-gray-50">
            全部 {scaleMin}
          </button>
          <button onClick={() => setAllAnswers(mid)} className="px-3 py-1.5 text-xs rounded-lg border border-gray-200 hover:bg-gray-50">
            全部 {mid}
          </button>
          <button onClick={() => setAllAnswers(scaleMax)} className="px-3 py-1.5 text-xs rounded-lg border border-gray-200 hover:bg-gray-50">
            全部 {scaleMax}
          </button>
        </div>

        {questions.length === 0 ? (
          <div className="text-sm text-gray-400">設問がありません</div>
        ) : (
          <div className="space-y-2 mb-4">
            {questions.map((q) => (
              <div key={q.id} className="flex items-center gap-3">
                <span className="w-16 shrink-0 text-xs font-mono text-gray-500">{q.id}</span>
                <span className="flex-1 text-sm text-gray-700 truncate">{q.text}</span>
                <input
                  type="number"
                  min={scaleMin}
                  max={scaleMax}
                  value={answers[q.id] ?? scaleMin}
                  onChange={(e) => {
                    const v = Number(e.target.value)
                    setAnswers((prev) => ({ ...prev, [q.id]: Number.isFinite(v) ? v : scaleMin }))
                  }}
                  className="w-20 rounded-md border border-gray-300 px-2 py-1.5 text-sm tabular-nums"
                />
              </div>
            ))}
          </div>
        )}

        <button
          onClick={handlePreview}
          disabled={previewing || questions.length === 0}
          className="px-4 py-2 text-sm font-medium text-white rounded-lg hover:opacity-90 disabled:opacity-50"
          style={{ backgroundColor: '#06C755' }}
        >
          {previewing ? '実行中...' : 'テスト実行'}
        </button>

        {previewError && <div className="mt-3 text-sm text-rose-600">{previewError}</div>}
        {previewResult && (
          <div className="mt-4 rounded-lg border border-gray-200 p-4">
            <ResultSummary result={previewResult} />
          </div>
        )}
      </div>
    </div>
  )
}
