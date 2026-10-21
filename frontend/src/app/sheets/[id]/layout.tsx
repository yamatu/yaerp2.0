'use client'

import { useParams } from 'next/navigation'
import WorkbookEditorShell from '@/components/sheets/WorkbookEditorShell'

// The shell lives in the layout so switching sheets keeps the workbook, its
// tab bar and their state mounted; only the sheet editor itself is replaced.
export default function WorkbookEditorLayout({ children }: { children: React.ReactNode }) {
  const params = useParams<{ id: string; sheetId?: string }>()
  const parsedSheetId = params.sheetId ? Number.parseInt(params.sheetId, 10) : Number.NaN

  return (
    <>
      <WorkbookEditorShell
        workbookId={params.id}
        requestedSheetId={Number.isNaN(parsedSheetId) ? null : parsedSheetId}
      />
      {children}
    </>
  )
}
