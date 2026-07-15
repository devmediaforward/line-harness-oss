'use client'

import { useMemo, useState } from 'react'
import type { DiagnosisDefinition, DiagnosisRank } from '@line-crm/shared'
import { api } from '@/lib/api'
import type { DiagnosisDetail } from '@/lib/api'

type ScenarioOpt = { id: string; name: string }

function Card({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-5">
      <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
      {description && <p className="mt-0.5 text-xs text-gray-400">{description}</p>}
      <div className="mt-4">{children}</div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-gray-600 mb-1">{label}</span>
      {children}
    </label>
  )
}

const inputCls = 'w-full rounded-md border border-gray-300 px-3 py-2 text-sm'

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="flex items-center justify-between w-full py-2"
    >
      <span className="text-sm text-gray-700">{label}</span>
      <span className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${checked ? 'bg-[#06C755]' : 'bg-gray-300'}`}>
        <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${checked ? 'translate-x-6' : 'translate-x-1'}`} />
      </span>
    </button>
  )
}

export default function BasicSettingsTab({
  detail,
  scenarios,
  onSaved,
}: {
  detail: DiagnosisDetail
  scenarios: ScenarioOpt[]
  onSaved: (updated: DiagnosisDetail) => void
}) {
  const def = detail.definition
  const axes = def.axes ?? []

  const [name, setName] = useState(detail.name)
  const [slug, setSlug] = useState(detail.slug ?? '')
  const [isActive, setIsActive] = useState(detail.isActive)

  const [ranks, setRanks] = useState<DiagnosisRank[]>(() =>
    (def.scoring?.ranks ?? []).map((r) => ({ ...r })),
  )
  const [keepMin, setKeepMin] = useState<number>(def.scoring?.axisGrades?.keep?.min ?? 0)
  const [almostMin, setAlmostMin] = useState<number>(def.scoring?.axisGrades?.almost?.min ?? 0)

  const [weakPointHeading, setWeakPointHeading] = useState(def.resultPage?.weakPointHeading ?? '')
  const [weakPointTexts, setWeakPointTexts] = useState<Record<string, string>>(
    () => ({ ...(def.resultPage?.weakPointTexts ?? {}) }),
  )
  const [softCtaText, setSoftCtaText] = useState(def.resultPage?.softCta?.text ?? '')
  const [softCtaSubText, setSoftCtaSubText] = useState(def.resultPage?.softCta?.subText ?? '')
  const [minorNotice, setMinorNotice] = useState(def.resultPage?.minorNotice ?? '')
  const [emptyMessage, setEmptyMessage] = useState(def.resultPage?.emptyState?.message ?? '')
  const [emptyCta, setEmptyCta] = useState(def.resultPage?.emptyState?.cta ?? '')

  const [shareEnabled, setShareEnabled] = useState(def.share?.enabled ?? false)
  const [ogImages, setOgImages] = useState<Record<string, string>>(() => ({ ...(def.share?.ogImages ?? {}) }))
  const [ogTitleTemplate, setOgTitleTemplate] = useState(def.share?.ogTitleTemplate ?? '')
  const [ogDescription, setOgDescription] = useState(def.share?.ogDescription ?? '')
  const [addFriendUrl, setAddFriendUrl] = useState(def.share?.addFriendUrl ?? '')
  const [liffUrl, setLiffUrl] = useState(def.share?.liffUrl ?? '')
  const [shareText, setShareText] = useState(def.share?.shareText ?? '')

  const [sendResultMessage, setSendResultMessage] = useState(def.sideEffects?.sendResultMessage ?? false)
  const [addTags, setAddTags] = useState(def.sideEffects?.addTags ?? false)
  const [enrollScenarioId, setEnrollScenarioId] = useState<string | null>(def.sideEffects?.enrollScenarioId ?? null)
  const [saveToMetadata, setSaveToMetadata] = useState(def.sideEffects?.saveToMetadata ?? false)

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [errors, setErrors] = useState<string[]>([])
  const [savedFlash, setSavedFlash] = useState(false)

  // ランク区切りの即時バリデーション (先頭 min=0 / min 昇順)
  const rankError = useMemo(() => {
    if (ranks.length === 0) return 'ランクを1つ以上設定してください'
    if (ranks[0].min !== 0) return '先頭ランクの下限点は 0 である必要があります'
    for (let i = 1; i < ranks.length; i++) {
      if (!(ranks[i].min > ranks[i - 1].min)) return 'ランクの下限点は昇順（小さい順）にしてください'
    }
    return ''
  }, [ranks])

  const thresholdError = useMemo(() => {
    if (!(keepMin > almostMin)) return '◎しきい値は ○しきい値より大きい必要があります'
    return ''
  }, [keepMin, almostMin])

  const updateRank = (i: number, patch: Partial<DiagnosisRank>) => {
    setRanks((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  }
  const addRank = () => {
    const lastMin = ranks.length > 0 ? ranks[ranks.length - 1].min : -1
    setRanks((prev) => [...prev, { rank: '', min: lastMin + 1, title: '', subcopy: '', body: '' }])
  }
  const removeRank = (i: number) => setRanks((prev) => prev.filter((_, idx) => idx !== i))

  const handleSave = async () => {
    setError('')
    setErrors([])
    setSavedFlash(false)
    if (rankError || thresholdError) {
      setError(rankError || thresholdError)
      return
    }

    const merged: DiagnosisDefinition = {
      ...def,
      scoring: {
        ...def.scoring,
        ranks: ranks.map((r) => ({
          rank: r.rank,
          min: r.min,
          title: r.title,
          subcopy: r.subcopy,
          body: r.body,
        })),
        axisGrades: {
          ...def.scoring.axisGrades,
          keep: { ...def.scoring.axisGrades.keep, min: keepMin },
          almost: { ...def.scoring.axisGrades.almost, min: almostMin },
        },
      },
      resultPage: {
        ...def.resultPage,
        weakPointHeading,
        weakPointTexts,
        softCta: { text: softCtaText, subText: softCtaSubText },
        minorNotice,
        emptyState: { message: emptyMessage, cta: emptyCta },
      },
      share: {
        ...def.share,
        enabled: shareEnabled,
        ogImages,
        ogTitleTemplate,
        ogDescription,
        addFriendUrl,
        liffUrl,
        shareText,
      },
      sideEffects: {
        ...def.sideEffects,
        sendResultMessage,
        addTags,
        enrollScenarioId,
        saveToMetadata,
      },
    }

    setSaving(true)
    try {
      const vres = await api.diagnoses.validate(merged)
      if (vres.success && !vres.data.valid) {
        setErrors(vres.data.errors)
        setError('定義の検証でエラーが出ました。修正してください。')
        setSaving(false)
        return
      }
      const res = await api.diagnoses.update(detail.id, {
        name: name.trim(),
        slug: slug.trim() || null,
        isActive,
        definition: merged,
      })
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
    <div className="space-y-5">
      <Card title="基本情報">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="名前">
            <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
          </Field>
          <Field label="slug（URL に使用）">
            <input value={slug} onChange={(e) => setSlug(e.target.value)} className={`${inputCls} font-mono`} />
          </Field>
        </div>
        <div className="mt-2 max-w-xs">
          <Toggle checked={isActive} onChange={setIsActive} label="この診断を有効にする" />
        </div>
      </Card>

      <Card title="ランク区切り" description="総合点の下限点でランクを切り替えます。先頭は 0、以降は昇順で。">
        <div className="space-y-3">
          {ranks.map((r, i) => (
            <div key={i} className="rounded-lg border border-gray-200 p-3 space-y-2">
              <div className="flex items-center gap-2">
                <input
                  value={r.rank}
                  onChange={(e) => updateRank(i, { rank: e.target.value })}
                  placeholder="ランク名 (例: S)"
                  className="w-28 rounded-md border border-gray-300 px-2 py-1.5 text-sm font-medium"
                />
                <div className="flex items-center gap-1">
                  <span className="text-xs text-gray-400">下限点</span>
                  <input
                    type="number"
                    value={Number.isFinite(r.min) ? r.min : 0}
                    onChange={(e) => updateRank(i, { min: e.target.value === '' ? 0 : Number(e.target.value) })}
                    className="w-20 rounded-md border border-gray-300 px-2 py-1.5 text-sm tabular-nums"
                  />
                </div>
                <button
                  onClick={() => removeRank(i)}
                  className="ml-auto text-xs text-rose-500 hover:text-rose-700"
                  disabled={ranks.length <= 1}
                >
                  削除
                </button>
              </div>
              <input
                value={r.title}
                onChange={(e) => updateRank(i, { title: e.target.value })}
                placeholder="タイトル"
                className={inputCls}
              />
              <input
                value={r.subcopy}
                onChange={(e) => updateRank(i, { subcopy: e.target.value })}
                placeholder="サブコピー"
                className={inputCls}
              />
              <textarea
                value={r.body}
                onChange={(e) => updateRank(i, { body: e.target.value })}
                placeholder="本文"
                rows={2}
                className={inputCls}
              />
            </div>
          ))}
          <button onClick={addRank} className="text-sm text-[#06C755] hover:underline">
            + ランクを追加
          </button>
          {rankError && <div className="text-xs text-rose-600">{rankError}</div>}
        </div>
      </Card>

      <Card title="◎○△ しきい値" description="軸スコアの評価しきい値（下限）。△ は残り全て（フォールバック）です。">
        <div className="grid grid-cols-2 gap-4 max-w-sm">
          <Field label="◎ キープ（keep.min）">
            <input
              type="number"
              value={keepMin}
              onChange={(e) => setKeepMin(e.target.value === '' ? 0 : Number(e.target.value))}
              className={`${inputCls} tabular-nums`}
            />
          </Field>
          <Field label="○ あと少し（almost.min）">
            <input
              type="number"
              value={almostMin}
              onChange={(e) => setAlmostMin(e.target.value === '' ? 0 : Number(e.target.value))}
              className={`${inputCls} tabular-nums`}
            />
          </Field>
        </div>
        {thresholdError && <div className="mt-2 text-xs text-rose-600">{thresholdError}</div>}
      </Card>

      <Card title="結果ページの文言">
        <div className="space-y-4">
          <Field label="弱点セクションの見出し">
            <input value={weakPointHeading} onChange={(e) => setWeakPointHeading(e.target.value)} className={inputCls} />
          </Field>
          <div>
            <span className="block text-xs font-medium text-gray-600 mb-1">弱点テキスト（軸ごと）</span>
            <div className="space-y-2">
              {axes.map((ax) => (
                <div key={ax.id} className="flex items-center gap-2">
                  <span className="w-32 shrink-0 text-xs text-gray-500 truncate">{ax.label || ax.id}</span>
                  <input
                    value={weakPointTexts[ax.id] ?? ''}
                    onChange={(e) => setWeakPointTexts((prev) => ({ ...prev, [ax.id]: e.target.value }))}
                    placeholder="△ のときの一言"
                    className={inputCls}
                  />
                </div>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="ソフトCTA テキスト">
              <input value={softCtaText} onChange={(e) => setSoftCtaText(e.target.value)} className={inputCls} />
            </Field>
            <Field label="ソフトCTA サブテキスト">
              <input value={softCtaSubText} onChange={(e) => setSoftCtaSubText(e.target.value)} className={inputCls} />
            </Field>
          </div>
          <Field label="未成年注記">
            <input value={minorNotice} onChange={(e) => setMinorNotice(e.target.value)} className={inputCls} />
          </Field>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="空状態メッセージ">
              <input value={emptyMessage} onChange={(e) => setEmptyMessage(e.target.value)} className={inputCls} />
            </Field>
            <Field label="空状態 CTA">
              <input value={emptyCta} onChange={(e) => setEmptyCta(e.target.value)} className={inputCls} />
            </Field>
          </div>
        </div>
      </Card>

      <Card title="シェア設定">
        <div className="space-y-4">
          <div className="max-w-xs">
            <Toggle checked={shareEnabled} onChange={setShareEnabled} label="シェアを有効にする" />
          </div>
          <div>
            <span className="block text-xs font-medium text-gray-600 mb-1">OG画像URL（ランク別）</span>
            <div className="space-y-2">
              {ranks.map((r) => (
                <div key={r.rank || Math.random()} className="flex items-center gap-2">
                  <span className="w-12 shrink-0 text-xs font-medium text-gray-500">{r.rank || '—'}</span>
                  <input
                    type="url"
                    value={ogImages[r.rank] ?? ''}
                    onChange={(e) => setOgImages((prev) => ({ ...prev, [r.rank]: e.target.value }))}
                    placeholder="https://..."
                    className={`${inputCls} font-mono text-xs`}
                  />
                </div>
              ))}
            </div>
          </div>
          <Field label="OGタイトルテンプレート（{score} / {rankTitle} が使えます）">
            <input value={ogTitleTemplate} onChange={(e) => setOgTitleTemplate(e.target.value)} className={inputCls} />
          </Field>
          <Field label="OG説明文">
            <input value={ogDescription} onChange={(e) => setOgDescription(e.target.value)} className={inputCls} />
          </Field>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="友だち追加 URL">
              <input value={addFriendUrl} onChange={(e) => setAddFriendUrl(e.target.value)} className={`${inputCls} font-mono text-xs`} />
            </Field>
            <Field label="LIFF URL">
              <input value={liffUrl} onChange={(e) => setLiffUrl(e.target.value)} className={`${inputCls} font-mono text-xs`} />
            </Field>
          </div>
          <Field label="シェアテキスト">
            <textarea value={shareText} onChange={(e) => setShareText(e.target.value)} rows={2} className={inputCls} />
          </Field>
        </div>
      </Card>

      <Card title="副作用" description="回答完了時に実行する処理。">
        <div className="max-w-md divide-y divide-gray-100">
          <Toggle checked={sendResultMessage} onChange={setSendResultMessage} label="結果メッセージを送信する" />
          <Toggle checked={addTags} onChange={setAddTags} label="悩みタグを友だちに付与する" />
          <Toggle checked={saveToMetadata} onChange={setSaveToMetadata} label="rank / score をメタデータに保存する" />
          <div className="py-3">
            <span className="block text-xs font-medium text-gray-600 mb-1">シナリオに登録する</span>
            <select
              value={enrollScenarioId ?? ''}
              onChange={(e) => setEnrollScenarioId(e.target.value || null)}
              className={inputCls}
            >
              <option value="">登録しない</option>
              {scenarios.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      </Card>

      {error && <div className="text-sm text-rose-600">{error}</div>}
      {errors.length > 0 && (
        <ul className="text-xs text-rose-600 list-disc pl-5 space-y-0.5 max-h-48 overflow-y-auto">
          {errors.map((er, i) => (
            <li key={i}>{er}</li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-3">
        <button
          onClick={handleSave}
          disabled={saving || !!rankError || !!thresholdError}
          className="px-5 py-2.5 text-sm font-medium text-white rounded-lg transition-opacity hover:opacity-90 disabled:opacity-50"
          style={{ backgroundColor: '#06C755' }}
        >
          {saving ? '保存中...' : '保存する'}
        </button>
        <span className="text-xs text-gray-400">
          保存すると definition のバージョンが上がります（現在 v{detail.definitionVersion}）
        </span>
        {savedFlash && <span className="text-xs text-[#06C755]">保存しました</span>}
      </div>
    </div>
  )
}
