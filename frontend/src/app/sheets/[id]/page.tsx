'use client'

import { useEffect, useState } from 'react'
import { ArrowLeft, FileSpreadsheet, Maximize2, Minimize2, Plus } from 'lucide-react'
import { useParams } from 'next/navigation'
import { AuthGuard } from '@/components/auth/AuthGuard'
import { useWorkbook } from '@/hooks/useSheet'
import UniverSheetEditor from '@/components/spreadsheet/UniverSheetEditor'
import api from '@/lib/api'

export default function WorkbookEditorPage() {
  const params = useParams<{ id: string }>()
  const id = params.id
  const { workbook, loading, error, refresh } = useWorkbook(id)
  const [activeSheetIndex, setActiveSheetIndex] = useState(0)
  const [addingSheet, setAddingSheet] = useState(false)
  const [newSheetName, setNewSheetName] = useState('')
  const [fullscreen, setFullscreen] = useState(false)
  const sheets = workbook?.sheets || []
  const activeSheet = sheets[activeSheetIndex]
  const getSheetLabel = (sheetName: string | undefined, index: number) =>
    sheetName?.trim() || `工作表 ${index + 1}`

  useEffect(() => {
    if (activeSheetIndex > Math.max(sheets.length - 1, 0)) {
      setActiveSheetIndex(Math.max(sheets.length - 1, 0))
    }
  }, [activeSheetIndex, sheets.length])

  const handleAddSheet = async () => {
    if (!newSheetName.trim()) return
    try {
      const nextIndex = sheets.length
      // Create empty sheet — no preset columns
      await api.post(`/workbooks/${id}/sheets`, {
        name: newSheetName.trim(),
        columns: [],
      })
      setNewSheetName('')
      setAddingSheet(false)
      await refresh()
      setActiveSheetIndex(nextIndex)
    } catch (err) {
      console.error('Failed to add sheet:', err)
    }
  }

  if (loading) {
    return (
      <AuthGuard>
        <div className="flex min-h-screen items-center justify-center bg-slate-50">
          <div className="text-center">
            <div className="mb-2 text-sm font-semibold uppercase tracking-widest text-sky-600">Loading</div>
            <div className="text-lg font-semibold text-slate-900">正在加载工作簿...</div>
          </div>
        </div>
      </AuthGuard>
    )
  }

  if (error || !workbook) {
    return (
      <AuthGuard>
        <div className="flex min-h-screen items-center justify-center bg-slate-50">
          <div className="text-center">
            <div className="mb-2 text-sm font-semibold uppercase tracking-widest text-rose-500">Oops</div>
            <div className="text-lg font-semibold text-slate-900">{error || '工作簿未找到'}</div>
          </div>
        </div>
      </AuthGuard>
    )
  }

  return (
    <AuthGuard>
      <div className={`flex flex-col bg-slate-50 ${fullscreen ? 'fixed inset-0 z-50' : 'h-screen'}`}>
        {/* Compact top bar */}
        <div className="flex items-center justify-between border-b border-slate-200 bg-white px-3 py-2">
          <div className="flex items-center gap-3">
            <a
              href="/"
              className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
            >
              <ArrowLeft className="h-4 w-4" />
              返回
            </a>
            <div className="h-5 w-px bg-slate-200" />
            <h1 className="text-sm font-semibold text-slate-900 truncate max-w-[300px]">
              {workbook.name}
            </h1>
          </div>

          <div className="flex items-center gap-2">
            {addingSheet ? (
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={newSheetName}
                  onChange={(e) => setNewSheetName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleAddSheet()
                    if (e.key === 'Escape') { setAddingSheet(false); setNewSheetName('') }
                  }}
                  placeholder="工作表名称"
                  className="h-8 w-40 rounded-lg border border-slate-200 bg-white px-3 text-sm outline-none focus:border-sky-300 focus:ring-1 focus:ring-sky-100"
                  autoFocus
                />
                <button type="button" onClick={handleAddSheet} className="h-8 rounded-lg bg-slate-900 px-3 text-xs font-semibold text-white hover:bg-slate-800">
                  创建
                </button>
                <button type="button" onClick={() => { setAddingSheet(false); setNewSheetName('') }} className="h-8 rounded-lg border border-slate-200 px-3 text-xs font-semibold text-slate-600 hover:bg-slate-50">
                  取消
                </button>
              </div>
            ) : (
              <button type="button" onClick={() => setAddingSheet(true)} className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800">
                <Plus className="h-3.5 w-3.5" />
                新建工作表
              </button>
            )}
            <button
              type="button"
              onClick={() => setFullscreen((v) => !v)}
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
              title={fullscreen ? '退出全屏' : '全屏'}
            >
              {fullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            </button>
          </div>
        </div>

        {/* Sheet tabs */}
        <div className="flex items-center gap-1 border-b border-slate-200 bg-slate-50 px-3 py-1 overflow-x-auto">
          {sheets.map((sheet, index) => (
            <button
              key={sheet.id}
              type="button"
              onClick={() => setActiveSheetIndex(index)}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium whitespace-nowrap transition ${
                index === activeSheetIndex
                  ? 'bg-white text-slate-900 shadow-sm ring-1 ring-slate-200'
                  : 'text-slate-500 hover:bg-white/70 hover:text-slate-700'
              }`}
            >
              <FileSpreadsheet className="h-3.5 w-3.5" />
              {getSheetLabel(sheet.name, index)}
            </button>
          ))}
          {sheets.length === 0 && (
            <span className="px-2 py-1 text-xs text-slate-400">还没有工作表</span>
          )}
        </div>

        {/* Editor area — fills all remaining space */}
        <div className="flex-1 overflow-hidden relative">
          {activeSheet ? (
            <UniverSheetEditor workbookId={id} sheet={activeSheet} />
          ) : (
            <div className="flex h-full items-center justify-center text-center">
              <div className="max-w-sm">
                <FileSpreadsheet className="mx-auto mb-4 h-12 w-12 text-slate-300" />
                <h2 className="text-xl font-semibold text-slate-900">此工作簿还没有工作表</h2>
                <p className="mt-2 text-sm text-slate-500">点击上方「新建工作表」开始使用。</p>
                <button type="button" onClick={() => setAddingSheet(true)} className="mt-6 inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800">
                  <Plus className="h-4 w-4" />
                  新建工作表
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </AuthGuard>
  )
}
