'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { AlertCircle, ImagePlus, Lock, X } from 'lucide-react'
import type { IWorkbookData, IWorksheetData } from '@univerjs/core'
import { createUniver, defaultTheme, LocaleType } from '@univerjs/presets'
import { UniverSheetsCorePreset } from '@univerjs/preset-sheets-core'
import UniverPresetSheetsCoreZhCN from '@univerjs/preset-sheets-core/locales/zh-CN'
import api from '@/lib/api'
import { buildUniverWorkbookData, deriveColumnsFromUniverSheet } from '@/lib/univer-sheet'
import { parseSheetConfig } from '@/lib/spreadsheet'
import type { Row, Sheet } from '@/types'

interface Props {
  workbookId: string | number
  sheet: Sheet
}

interface GalleryImage {
  id: number
  filename: string
  url: string
  size: number
}

function wrapWorksheetData(
  workbookId: string | number,
  sheet: Sheet,
  worksheetData: Partial<IWorksheetData>,
  locale: IWorkbookData['locale']
): IWorkbookData {
  const sheetKey = worksheetData.id || `sheet-${sheet.id}`
  return {
    id: `workbook-${workbookId}-sheet-${sheet.id}`,
    name: sheet.name || 'Workbook',
    appVersion: '0.5.0',
    locale,
    styles: {},
    sheetOrder: [sheetKey],
    sheets: {
      [sheetKey]: {
        ...worksheetData,
        id: sheetKey,
        name: worksheetData.name || sheet.name || 'Sheet1',
      },
    },
  }
}

export default function UniverSheetEditor({ workbookId, sheet }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latestSheetRef = useRef(sheet)
  const univerApiRef = useRef<ReturnType<typeof createUniver> | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showImagePicker, setShowImagePicker] = useState(false)
  const [galleryImages, setGalleryImages] = useState<GalleryImage[]>([])
  const [loadingGallery, setLoadingGallery] = useState(false)

  useEffect(() => { latestSheetRef.current = sheet }, [sheet])

  // Stable sheet.id for mount — ONLY re-mount when sheet.id changes
  const sheetId = sheet.id

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    let disposed = false
    let cleanup: (() => void) | null = null

    const mount = async () => {
      setLoading(true)
      setError('')
      try {
        // Read the latest sheet data from the ref, not from closure
        const currentSheet = latestSheetRef.current
        const config = parseSheetConfig(currentSheet.config)
        const localeCode = 'zh-CN' as IWorkbookData['locale']
        let workbookData: IWorkbookData

        if (config.univerSheetData && typeof config.univerSheetData === 'object') {
          workbookData = wrapWorksheetData(
            workbookId, currentSheet,
            config.univerSheetData as Partial<IWorksheetData>,
            localeCode
          )
        } else {
          const rowsRes = await api.get<Row[]>(`/sheets/${currentSheet.id}/data`)
          const rows = rowsRes.code === 0 && Array.isArray(rowsRes.data) ? rowsRes.data : []
          workbookData = buildUniverWorkbookData(workbookId, currentSheet, rows, localeCode)
        }

        if (disposed || !containerRef.current) return

        // CRITICAL: Ensure the container has actual pixel dimensions before
        // Univer tries to read offsetHeight. If flex layout hasn't resolved
        // yet (e.g. 0px), wait one frame.
        const ensureHeight = () =>
          new Promise<void>((resolve) => {
            const check = () => {
              if (containerRef.current && containerRef.current.offsetHeight > 0) {
                resolve()
              } else {
                requestAnimationFrame(check)
              }
            }
            check()
          })

        await ensureHeight()
        if (disposed || !containerRef.current) return

        containerRef.current.innerHTML = ''

        const localeKey = LocaleType.ZH_CN
        const univerResult = createUniver({
          locale: localeKey,
          theme: defaultTheme,
          locales: { [localeKey]: UniverPresetSheetsCoreZhCN },
          presets: [
            UniverSheetsCorePreset({
              container: containerRef.current,
              header: true,
              toolbar: true,
              formulaBar: true,
              contextMenu: true,
              footer: false,
            }),
          ],
        })

        const { univer, univerAPI } = univerResult
        univerApiRef.current = univerResult

        const workbookApi = univerAPI.createUniverSheet(workbookData)
        workbookApi.setEditable(true)
        if (!disposed) setLoading(false)

        const persistSnapshot = async () => {
          const snap = latestSheetRef.current
          const saved = workbookApi.save()
          const savedSheetId = saved.sheetOrder[0]
          const savedSheet = saved.sheets[savedSheetId] as Partial<IWorksheetData>
          if (!savedSheet) return
          const nextColumns = deriveColumnsFromUniverSheet(savedSheet, snap.columns || [])
          const currentConfig = parseSheetConfig(snap.config)
          await api.put(`/sheets/${snap.id}`, {
            name: savedSheet.name || snap.name,
            sort_order: snap.sort_order,
            columns: nextColumns,
            frozen: snap.frozen || { row: 0, col: 0 },
            config: { ...currentConfig, univerSheetData: savedSheet },
          })
        }

        const schedulePersist = () => {
          if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
          saveTimerRef.current = setTimeout(() => {
            persistSnapshot().catch((e) => console.error('Failed to persist Univer snapshot:', e))
          }, 900)
        }

        const disposable = workbookApi.onCommandExecuted(() => schedulePersist())

        cleanup = () => {
          disposable.dispose()
          if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null }
          univerApiRef.current = null
          ;(univer as { dispose?: () => void }).dispose?.()
        }
      } catch (mountError) {
        console.error('Failed to initialize Univer sheet:', mountError)
        if (!disposed) { setError('Univer 工作表初始化失败，请稍后重试。'); setLoading(false) }
      }
    }

    mount()
    return () => { disposed = true; cleanup?.() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheetId, workbookId])

  // Gallery image picker
  const openImagePicker = useCallback(async () => {
    setShowImagePicker(true)
    setLoadingGallery(true)
    try {
      const res = await api.get<{ list: GalleryImage[]; total: number }>(
        '/attachments/images?page=1&size=50'
      )
      if (res.code === 0 && res.data) {
        setGalleryImages(res.data.list || [])
      }
    } catch (err) {
      console.error('Failed to load gallery:', err)
    } finally {
      setLoadingGallery(false)
    }
  }, [])

  const insertImageToCell = useCallback((img: GalleryImage) => {
    const result = univerApiRef.current
    if (!result) return

    const { univerAPI } = result
    try {
      // Use Facade API to set value in the currently selected cell
      // getActiveWorkbook → getActiveSheet → getSelection → getActiveRange
      const wb = univerAPI.getActiveWorkbook?.()
      const ws = wb?.getActiveSheet?.()
      const sel = ws?.getSelection?.()
      const range = sel?.getActiveRange?.()
      if (range) {
        const row = range.getRow()
        const col = range.getColumn()
        const cell = ws!.getRange(row, col, row, col)
        cell?.setValue?.(`[IMG:${img.url}:${img.filename}]`)
      } else {
        // Fallback: set A1 if no selection
        ws?.getRange?.(0, 0, 0, 0)?.setValue?.(`[IMG:${img.url}:${img.filename}]`)
      }
    } catch (e) {
      console.error('Failed to insert image to cell:', e)
      // Fallback: just copy the URL to clipboard
      navigator.clipboard?.writeText?.(img.url)
      alert('已复制图片链接到剪贴板，请粘贴到单元格中。')
    }

    setShowImagePicker(false)
  }, [])

  // Handle direct file upload from picker
  const handleDirectUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const res = await api.upload(file)
      if (res.code === 0 && res.data) {
        // Get the URL for the uploaded file
        const urlRes = await api.get<{ url: string }>(`/files/${res.data.id}`)
        if (urlRes.code === 0 && urlRes.data) {
          insertImageToCell({
            id: res.data.id,
            filename: file.name,
            url: urlRes.data.url,
            size: file.size,
          })
        }
      }
    } catch (err) {
      console.error('Upload failed:', err)
    }
    e.target.value = ''
  }, [insertImageToCell])

  if (error) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center">
        <div className="max-w-md space-y-3">
          <AlertCircle className="mx-auto h-10 w-10 text-rose-500" />
          <h2 className="text-xl font-semibold text-slate-900">{error}</h2>
        </div>
      </div>
    )
  }

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%', position: 'relative' }} />

      {/* Floating image insert button */}
      <button
        type="button"
        onClick={openImagePicker}
        className="absolute right-3 bottom-3 z-20 flex h-10 w-10 items-center justify-center rounded-full bg-slate-900 text-white shadow-lg transition hover:bg-slate-800"
        title="插入图片"
      >
        <ImagePlus className="h-5 w-5" />
      </button>

      {/* Image picker modal */}
      {showImagePicker && (
        <div
          className="absolute inset-0 z-30 flex items-center justify-center bg-black/40 backdrop-blur-sm"
          onClick={() => setShowImagePicker(false)}
        >
          <div
            className="relative w-full max-w-2xl max-h-[80%] flex flex-col rounded-2xl bg-white shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
              <h3 className="text-sm font-semibold text-slate-900">选择图片插入到当前单元格</h3>
              <div className="flex items-center gap-2">
                <label className="cursor-pointer inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800">
                  <ImagePlus className="h-3.5 w-3.5" />
                  上传新图片
                  <input
                    type="file"
                    accept="image/*"
                    onChange={handleDirectUpload}
                    className="hidden"
                  />
                </label>
                <button
                  type="button"
                  onClick={() => setShowImagePicker(false)}
                  className="flex h-7 w-7 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            {/* Gallery grid */}
            <div className="flex-1 overflow-y-auto p-4">
              {loadingGallery ? (
                <div className="flex h-40 items-center justify-center text-sm text-slate-500">
                  正在加载图库...
                </div>
              ) : galleryImages.length === 0 ? (
                <div className="flex h-40 flex-col items-center justify-center text-center">
                  <ImagePlus className="mb-2 h-8 w-8 text-slate-300" />
                  <p className="text-sm text-slate-500">还没有图片，请先上传。</p>
                </div>
              ) : (
                <div className="grid grid-cols-4 gap-3">
                  {galleryImages.map((img) => (
                    <button
                      key={img.id}
                      type="button"
                      onClick={() => insertImageToCell(img)}
                      className="group relative aspect-square overflow-hidden rounded-xl border border-slate-200 bg-slate-50 transition hover:border-sky-400 hover:ring-2 hover:ring-sky-100"
                    >
                      <img
                        src={img.url}
                        alt={img.filename}
                        className="h-full w-full object-cover"
                        loading="lazy"
                      />
                      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent p-2 opacity-0 transition group-hover:opacity-100">
                        <p className="truncate text-[10px] text-white">{img.filename}</p>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {loading && (
        <div className="flex items-center justify-center bg-white/90 backdrop-blur-sm" style={{ position: 'absolute', inset: 0, zIndex: 10 }}>
          <div className="text-center">
            <div className="mb-3 text-sm font-semibold uppercase tracking-[0.24em] text-sky-600">Univer</div>
            <div className="text-lg font-semibold text-slate-900">正在启动电子表格引擎...</div>
          </div>
        </div>
      )}
    </div>
  )
}
