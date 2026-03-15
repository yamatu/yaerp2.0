'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Download, Upload } from 'lucide-react'
import api from '@/lib/api'
import type { ApiResponse, Sheet } from '@/types'

export interface ImportResponse {
  sheet: Sheet
  sheet_id: number
  imported_rows: number
  attachment_id?: number
  attachment_url?: string
}

interface UploadWorkbookXlsxOptions {
  onProgress?: (progress: number) => void
}

interface Props {
  workbookId: string | number
  canImport: boolean
  onImported?: () => Promise<void> | void
  onError?: (message: string) => void
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
  if (!file.name.toLowerCase().endsWith('.xlsx')) {
    throw new Error('Only .xlsx files are supported.')
  }
  if (file.size > 20 * 1024 * 1024) {
    throw new Error('File size must be 20MB or smaller.')
  }

  const token = typeof window === 'undefined' ? null : localStorage.getItem('access_token')
  const formData = new FormData()
  formData.append('file', file)
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
      reportError('Current account does not have permission to import XLSX.')
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
      <button
        type="button"
        onClick={handleTemplateDownload}
        disabled={downloadingTemplate || uploading}
        className="flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 shadow-lg transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
        title="Download Import Template"
      >
        <Download className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={!canImport || uploading || downloadingTemplate}
        className="relative flex h-10 w-10 items-center justify-center rounded-full border border-indigo-200 bg-indigo-50 text-indigo-700 shadow-lg transition hover:bg-indigo-100 disabled:cursor-not-allowed disabled:opacity-50"
        title="Import XLSX"
      >
        <Upload className="h-4 w-4" />
        <input
          ref={inputRef}
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) {
              void handleFileUpload(file)
            }
          }}
        />
      </button>
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
