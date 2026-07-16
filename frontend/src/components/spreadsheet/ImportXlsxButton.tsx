'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Download, Upload } from 'lucide-react'
import api from '@/lib/api'
import type { ApiResponse, Sheet, Workbook } from '@/types'

export interface ImportResponse {
  sheet: Sheet
  sheet_id: number
  imported_rows: number
  attachment_id?: number
  attachment_url?: string
}

export interface WorkbookImportResponse {
  workbook: Workbook
  first_sheet_id: number
  imported_rows: number
  imported_sheets: number
  attachment_id?: number
  attachment_url?: string
}

interface UploadWorkbookXlsxOptions {
  onProgress?: (progress: number) => void
  folderId?: number | null
  workbookName?: string
}

interface Props {
  workbookId: string | number
  canImport: boolean
  onImported?: () => Promise<void> | void
  onError?: (message: string) => void
}

export const EXCEL_IMPORT_EXTENSIONS = ['.xlsx', '.xlsm', '.xls', '.xltx', '.xltm'] as const
export const EXCEL_IMPORT_FORMATS_LABEL = 'XLSX、XLSM、XLS、XLTX、XLTM'
export const EXCEL_IMPORT_ACCEPT = [
  ...EXCEL_IMPORT_EXTENSIONS,
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel.sheet.macroEnabled.12',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.template',
  'application/vnd.ms-excel.template.macroEnabled.12',
].join(',')

const EXCEL_IMPORT_MAX_BYTES = 20 * 1024 * 1024

export function getExcelImportExtension(filename: string) {
  const normalized = filename.trim().toLowerCase()
  return EXCEL_IMPORT_EXTENSIONS.find((extension) => normalized.endsWith(extension)) || null
}

export function isSupportedExcelImportFile(file: Pick<File, 'name'>) {
  return getExcelImportExtension(file.name) !== null
}

export function stripExcelImportExtension(filename: string) {
  const extension = getExcelImportExtension(filename)
  return extension ? filename.slice(0, -extension.length) : filename
}

export function ensureExcelDownloadFilename(filename: string) {
  return getExcelImportExtension(filename) ? filename : `${filename}.xlsx`
}

async function prepareExcelImportUpload(file: File) {
  const extension = getExcelImportExtension(file.name)
  if (!extension) {
    throw new Error(`仅支持 ${EXCEL_IMPORT_FORMATS_LABEL} 格式。`)
  }
  if (file.size > EXCEL_IMPORT_MAX_BYTES) {
    throw new Error('文件大小不能超过 20MB。')
  }
  if (extension !== '.xls') {
    return { importFile: file, sourceFile: null as File | null }
  }

  try {
    const XLSX = await import('xlsx')
    const source = await file.arrayBuffer()
    const workbook = XLSX.read(source, {
      type: 'array',
      cellDates: true,
      cellFormula: true,
      cellStyles: true,
    })
    if (workbook.SheetNames.length === 0) {
      throw new Error('文件中没有可导入的工作表。')
    }
    const converted = XLSX.write(workbook, {
      type: 'array',
      bookType: 'xlsx',
      compression: true,
      cellStyles: true,
    }) as ArrayBuffer
    const importFile = new File(
      [converted],
      `${stripExcelImportExtension(file.name)}.xlsx`,
      { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
    )
    if (importFile.size > EXCEL_IMPORT_MAX_BYTES) {
      throw new Error('旧版 Excel 转换后超过 20MB，无法导入。')
    }
    return { importFile, sourceFile: file }
  } catch (error) {
    if (error instanceof Error && (error.message.includes('20MB') || error.message.includes('工作表'))) {
      throw error
    }
    throw new Error('无法解析该 XLS 文件，请确认文件未损坏或未加密。')
  }
}

function parseFilenameFromDisposition(disposition: string | null, fallback: string) {
  if (!disposition) return fallback

  const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i)
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1])
    } catch {
      return utf8Match[1]
    }
  }

  const plainMatch = disposition.match(/filename="?([^";]+)"?/i)
  return plainMatch?.[1] || fallback
}

function triggerBrowserDownload(blob: Blob, filename: string) {
  const url = window.URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  window.URL.revokeObjectURL(url)
}

export async function uploadWorkbookXlsx(
  workbookId: string | number,
  file: File,
  options: UploadWorkbookXlsxOptions = {}
) {
  const prepared = await prepareExcelImportUpload(file)

  const token = typeof window === 'undefined' ? null : localStorage.getItem('access_token')
  const formData = new FormData()
  formData.append('file', prepared.importFile)
  if (prepared.sourceFile) {
    formData.append('source_file', prepared.sourceFile)
  }
  options.onProgress?.(0)

  const responseText = await new Promise<string>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `/api/workbooks/${workbookId}/import/xlsx`)
    if (token) {
      xhr.setRequestHeader('Authorization', `Bearer ${token}`)
    }

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return
      options.onProgress?.(Math.round((event.loaded / event.total) * 100))
    }

    xhr.onload = () => resolve(xhr.responseText)
    xhr.onerror = () => reject(new Error('Upload failed. Check your network connection and try again.'))
    xhr.onabort = () => reject(new Error('Upload was cancelled.'))
    xhr.send(formData)
  })

  const payload = JSON.parse(responseText) as ApiResponse<ImportResponse> & { data?: ImportResponse & { row?: number } }
  if (payload.code !== 0 || !payload.data?.sheet_id) {
    const rowMessage = payload.data && 'row' in payload.data && payload.data.row
      ? ` (error row: ${payload.data.row})`
      : ''
    throw new Error(`${payload.message || 'Import failed. Please try again later.'}${rowMessage}`)
  }

  options.onProgress?.(100)
  return payload.data
}

export async function uploadNewWorkbookXlsx(
  file: File,
  options: UploadWorkbookXlsxOptions = {}
) {
  const prepared = await prepareExcelImportUpload(file)

  const token = typeof window === 'undefined' ? null : localStorage.getItem('access_token')
  const formData = new FormData()
  formData.append('file', prepared.importFile)
  if (prepared.sourceFile) {
    formData.append('source_file', prepared.sourceFile)
  }
  if (options.folderId !== undefined && options.folderId !== null) {
    formData.append('folder_id', String(options.folderId))
  }
  if (options.workbookName?.trim()) {
    formData.append('workbook_name', options.workbookName.trim())
  }
  options.onProgress?.(0)

  const responseText = await new Promise<string>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/api/workbooks/import/xlsx')
    if (token) {
      xhr.setRequestHeader('Authorization', `Bearer ${token}`)
    }

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return
      options.onProgress?.(Math.round((event.loaded / event.total) * 100))
    }

    xhr.onload = () => resolve(xhr.responseText)
    xhr.onerror = () => reject(new Error('Upload failed. Check your network connection and try again.'))
    xhr.onabort = () => reject(new Error('Upload was cancelled.'))
    xhr.send(formData)
  })

  const payload = JSON.parse(responseText) as ApiResponse<WorkbookImportResponse> & { data?: WorkbookImportResponse & { row?: number } }
  if (payload.code !== 0 || !payload.data?.workbook?.id) {
    const rowMessage = payload.data && 'row' in payload.data && payload.data.row
      ? ` (error row: ${payload.data.row})`
      : ''
    throw new Error(`${payload.message || 'Import failed. Please try again later.'}${rowMessage}`)
  }

  options.onProgress?.(100)
  return payload.data
}

export default function ImportXlsxButton({ workbookId, canImport, onImported, onError }: Props) {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [uploading, setUploading] = useState(false)
  const [downloadingTemplate, setDownloadingTemplate] = useState(false)
  const [progress, setProgress] = useState(0)

  const reportError = (message: string) => {
    onError?.(message)
  }

  const handleTemplateDownload = async () => {
    setDownloadingTemplate(true)
    reportError('')
    try {
      const res = await api.download('/sheets/template')
      if (!res.ok) {
        let message = 'Failed to download template.'
        try {
          const payload = await res.json() as ApiResponse<unknown>
          if (payload.message) {
            message = payload.message
          }
        } catch {
          // Ignore JSON parse errors for non-JSON responses.
        }
        throw new Error(message)
      }

      const blob = await res.blob()
      const filename = parseFilenameFromDisposition(res.headers.get('content-disposition'), 'sheet_import_template.xlsx')
      triggerBrowserDownload(blob, filename)
    } catch (error) {
      reportError(error instanceof Error ? error.message : 'Failed to download template.')
    } finally {
      setDownloadingTemplate(false)
    }
  }

  const handleFileUpload = async (file: File) => {
    if (!canImport) {
      reportError('当前账号没有导入 Excel 的权限。')
      return
    }

    setUploading(true)
    setProgress(0)
    reportError('')

    try {
      const result = await uploadWorkbookXlsx(workbookId, file, {
        onProgress: setProgress,
      })
      await onImported?.()
      router.push(`/sheets/${workbookId}/${result.sheet_id}`)
    } catch (error) {
      reportError(error instanceof Error ? error.message : 'Import failed. Please try again later.')
    } finally {
      setUploading(false)
      setTimeout(() => setProgress(0), 400)
      if (inputRef.current) {
        inputRef.current.value = ''
      }
    }
  }

  return (
    <>
      <div className="group relative">
        <span className="pointer-events-none absolute right-12 top-1/2 z-10 -translate-y-1/2 whitespace-nowrap rounded-lg bg-slate-900 px-2.5 py-1.5 text-xs font-medium text-white opacity-0 shadow-lg transition group-hover:opacity-100 group-focus-within:opacity-100">下载 Excel 导入模板</span>
        <button
          type="button"
          onClick={handleTemplateDownload}
          disabled={downloadingTemplate || uploading}
          className="flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 shadow-lg transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
          title="下载 Excel 导入模板"
          aria-label="下载 Excel 导入模板"
        >
          <Download className="h-4 w-4" />
        </button>
      </div>
      <div className="group relative">
        <span className="pointer-events-none absolute right-12 top-1/2 z-10 -translate-y-1/2 whitespace-nowrap rounded-lg bg-slate-900 px-2.5 py-1.5 text-xs font-medium text-white opacity-0 shadow-lg transition group-hover:opacity-100 group-focus-within:opacity-100">导入 Excel 工作表</span>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={!canImport || uploading || downloadingTemplate}
          className="relative flex h-10 w-10 items-center justify-center rounded-full border border-indigo-200 bg-indigo-50 text-indigo-700 shadow-lg transition hover:bg-indigo-100 disabled:cursor-not-allowed disabled:opacity-50"
          title="导入 Excel 工作表"
          aria-label="导入 Excel 工作表"
        >
          <Upload className="h-4 w-4" />
          <input
            ref={inputRef}
            type="file"
            accept={EXCEL_IMPORT_ACCEPT}
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) {
                void handleFileUpload(file)
              }
            }}
          />
        </button>
      </div>
      {uploading && (
        <div className="w-40 rounded-2xl border border-slate-200 bg-white/95 px-3 py-2 shadow-lg backdrop-blur">
          <div className="flex items-center justify-between text-[11px] font-semibold text-slate-600">
            <span>Importing</span>
            <span>{progress}%</span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-200">
            <div className="h-full rounded-full bg-indigo-500 transition-all duration-200" style={{ width: `${progress}%` }} />
          </div>
        </div>
      )}
    </>
  )
}
