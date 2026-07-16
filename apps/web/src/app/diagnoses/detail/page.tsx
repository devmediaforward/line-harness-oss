'use client'

import { useSearchParams } from 'next/navigation'
import DiagnosisDetailClient from './diagnosis-detail-client'

export default function DiagnosisDetailPage() {
  const searchParams = useSearchParams()
  const id = searchParams.get('id')
  if (!id) {
    return <div className="p-8 text-center text-sm text-gray-500">診断 ID が指定されていません</div>
  }
  return <DiagnosisDetailClient diagnosisId={id} />
}
