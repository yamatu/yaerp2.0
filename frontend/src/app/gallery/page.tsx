'use client'

import { useEffect, useState, useRef, useCallback } from 'react'
import {
  ArrowLeft,
  Download,
  ImagePlus,
  Images,
  Trash2,
  X,
  ZoomIn,
} from 'lucide-react'
import { AuthGuard } from '@/components/auth/AuthGuard'
import api from '@/lib/api'
import { getStoredUser, isAdmin } from '@/lib/auth'
import type { AuthUser } from '@/types'

interface ImageItem {
  id: number
  filename: string
  mime_type: string
  size: number
  uploader_id: number
  created_at: string
  url: string
}

export default function GalleryPage() {
  const [images, setImages] = useState<ImageItem[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [preview, setPreview] = useState<ImageItem | null>(null)
  const [deleting, setDeleting] = useState<number | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [profile] = useState<AuthUser | null>(getStoredUser())
  const admin = isAdmin(profile)
  const pageSize = 20

  const fetchImages = useCallback(async (p: number) => {
    setLoading(true)
    try {
      const res = await api.get<{ list: ImageItem[]; total: number; page: number; size: number }>(
        `/attachments/images?page=${p}&size=${pageSize}`
      )
      if (res.code === 0 && res.data) {
        setImages(res.data.list || [])
        setTotal(res.data.total)
      }
    } catch (err) {
      console.error('Failed to load images:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchImages(page)
  }, [page, fetchImages])

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files?.length) return
    setUploading(true)
    try {
      for (let i = 0; i < files.length; i++) {
        await api.upload(files[i])
      }
      await fetchImages(page)
    } catch (err) {
      console.error('Upload failed:', err)
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const handleDelete = async (id: number) => {
    if (!confirm('确定要删除这张图片吗？此操作不可恢复。')) return
    setDeleting(id)
    try {
      await api.delete(`/attachments/${id}`)
      await fetchImages(page)
    } catch (err) {
      console.error('Delete failed:', err)
    } finally {
      setDeleting(null)
    }
  }

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  const totalPages = Math.ceil(total / pageSize)

  return (
    <AuthGuard>
      <div className="min-h-screen bg-[linear-gradient(180deg,#f8fafc_0%,#eff6ff_100%)]">
        {/* Header */}
        <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
          <div className="mb-8 flex items-center justify-between">
            <div className="flex items-center gap-4">
              <a
                href="/"
                className="inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm text-slate-500 transition hover:bg-white/80 hover:text-slate-900"
              >
                <ArrowLeft className="h-4 w-4" />
                返回首页
              </a>
              <div className="h-6 w-px bg-slate-200" />
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-900 text-white">
                  <Images className="h-5 w-5" />
                </div>
                <div>
                  <h1 className="text-lg font-bold text-slate-900">图库</h1>
                  <p className="text-xs text-slate-500">
                    共 {total} 张图片
                  </p>
                </div>
              </div>
            </div>

            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-50"
            >
              <ImagePlus className="h-4 w-4" />
              {uploading ? '上传中...' : '上传图片'}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              onChange={handleUpload}
              className="hidden"
            />
          </div>

          {/* Grid */}
          {loading && images.length === 0 ? (
            <div className="flex min-h-[400px] items-center justify-center">
              <div className="text-center">
                <div className="mb-2 text-sm font-semibold uppercase tracking-widest text-sky-600">
                  Loading
                </div>
                <div className="text-lg font-semibold text-slate-900">
                  正在加载图库...
                </div>
              </div>
            </div>
          ) : images.length === 0 ? (
            <div className="flex min-h-[400px] items-center justify-center">
              <div className="text-center">
                <Images className="mx-auto mb-4 h-16 w-16 text-slate-300" />
                <h2 className="text-xl font-semibold text-slate-900">
                  还没有图片
                </h2>
                <p className="mt-2 text-sm text-slate-500">
                  点击右上角「上传图片」开始使用。
                </p>
              </div>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
                {images.map((img) => (
                  <div
                    key={img.id}
                    className="group relative overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-sm transition hover:shadow-md"
                  >
                    <div className="aspect-square overflow-hidden bg-slate-100">
                      <img
                        src={img.url}
                        alt={img.filename}
                        className="h-full w-full object-cover transition group-hover:scale-105"
                        loading="lazy"
                      />
                    </div>
                    {/* Hover overlay */}
                    <div className="absolute inset-0 flex items-end bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-0 transition group-hover:opacity-100">
                      <div className="flex w-full items-center justify-between p-3">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-xs font-medium text-white">
                            {img.filename}
                          </p>
                          <p className="text-[10px] text-white/70">
                            {formatSize(img.size)}
                          </p>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => setPreview(img)}
                            className="flex h-7 w-7 items-center justify-center rounded-lg bg-white/20 text-white backdrop-blur-sm transition hover:bg-white/30"
                            title="预览"
                          >
                            <ZoomIn className="h-3.5 w-3.5" />
                          </button>
                          <a
                            href={img.url}
                            download={img.filename}
                            target="_blank"
                            rel="noreferrer"
                            className="flex h-7 w-7 items-center justify-center rounded-lg bg-white/20 text-white backdrop-blur-sm transition hover:bg-white/30"
                            title="下载"
                          >
                            <Download className="h-3.5 w-3.5" />
                          </a>
                          {admin && (
                            <button
                              type="button"
                              onClick={() => handleDelete(img.id)}
                              disabled={deleting === img.id}
                              className="flex h-7 w-7 items-center justify-center rounded-lg bg-rose-500/80 text-white backdrop-blur-sm transition hover:bg-rose-600 disabled:opacity-50"
                              title="删除"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="mt-8 flex items-center justify-center gap-2">
                  <button
                    type="button"
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={page <= 1}
                    className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 transition hover:bg-white disabled:opacity-40"
                  >
                    上一页
                  </button>
                  <span className="px-3 text-sm text-slate-500">
                    {page} / {totalPages}
                  </span>
                  <button
                    type="button"
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    disabled={page >= totalPages}
                    className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 transition hover:bg-white disabled:opacity-40"
                  >
                    下一页
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        {/* Preview Modal */}
        {preview && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
            onClick={() => setPreview(null)}
          >
            <div
              className="relative max-h-[90vh] max-w-[90vw]"
              onClick={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                onClick={() => setPreview(null)}
                className="absolute -right-3 -top-3 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-white text-slate-700 shadow-lg transition hover:bg-slate-100"
              >
                <X className="h-4 w-4" />
              </button>
              <img
                src={preview.url}
                alt={preview.filename}
                className="max-h-[85vh] max-w-full rounded-2xl object-contain shadow-2xl"
              />
              <div className="mt-3 text-center">
                <p className="text-sm font-medium text-white">{preview.filename}</p>
                <p className="text-xs text-white/60">{formatSize(preview.size)}</p>
              </div>
            </div>
          </div>
        )}
      </div>
    </AuthGuard>
  )
}
