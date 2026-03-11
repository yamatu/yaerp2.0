'use client'

import { useParams } from 'next/navigation'
import WorkbookEditorShell from '@/components/sheets/WorkbookEditorShell'

export default function WorkbookEditorSheetPage() {
  const params = useParams<{ id: string; sheetId: string }>()
  const parsedSheetId = Number.parseInt(params.sheetId, 10)

  return (
    <WorkbookEditorShell
      workbookId={params.id}
      requestedSheetId={Number.isNaN(parsedSheetId) ? null : parsedSheetId}
    />
  )
}
