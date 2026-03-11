'use client'

import { useParams } from 'next/navigation'
import WorkbookEditorShell from '@/components/sheets/WorkbookEditorShell'

export default function WorkbookEditorIndexPage() {
  const params = useParams<{ id: string }>()
  return <WorkbookEditorShell workbookId={params.id} requestedSheetId={null} />
}
