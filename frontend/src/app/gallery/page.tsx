'use client'

import { useEffect, useState, useRef, useCallback, type MouseEvent as ReactMouseEvent } from 'react'
import {
  ArrowLeft,
  Download,
  FlipHorizontal2,
  FlipVertical2,
  FolderPlus,
  Globe2,
  ImagePlus,
  Images,
  LockKeyhole,
  MessageCircle,
  Pencil,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Search,
  ShieldCheck,
  Trash2,
  UsersRound,
  X,
  ZoomIn,
} from 'lucide-react'
import { AuthGuard } from '@/components/auth/AuthGuard'
import { WhatsAppSendDialog, type WhatsAppSendResource } from '@/components/whatsapp/WhatsAppSendDialog'
import api from '@/lib/api'
import { getStoredUser, isAdmin } from '@/lib/auth'
import { imageThumbnailUrl, imageTransformLabel, transformRemoteImage, type ImageTransform } from '@/lib/imageTransform'
import type { AuthUser, GalleryDirectory, GalleryDirectoryAccess, GalleryImage, User } from '@/types'

export default function GalleryPage() {
  const [images, setImages] = useState<GalleryImage[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [preview, setPreview] = useState<GalleryImage | null>(null)
  const [transformingImage, setTransformingImage] = useState<ImageTransform | null>(null)
  const [transformError, setTransformError] = useState('')
  const [deleting, setDeleting] = useState<number | null>(null)
  const [renaming, setRenaming] = useState<GalleryImage | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [savingRename, setSavingRename] = useState(false)
  const [renameError, setRenameError] = useState('')
  const [directories, setDirectories] = useState<GalleryDirectory[]>([])
  const [selectedDirectoryId, setSelectedDirectoryId] = useState('')
  const [newDirectoryName, setNewDirectoryName] = useState('')
  const [creatingDirectory, setCreatingDirectory] = useState(false)
  const [deletingDirectory, setDeletingDirectory] = useState(false)
  const [directoryError, setDirectoryError] = useState('')
  const [accessDirectory, setAccessDirectory] = useState<GalleryDirectory | null>(null)
  const [directoryAccess, setDirectoryAccess] = useState<GalleryDirectoryAccess | null>(null)
  const [accessUsers, setAccessUsers] = useState<User[]>([])
  const [accessUserSearch, setAccessUserSearch] = useState('')
  const [loadingAccess, setLoadingAccess] = useState(false)
  const [savingAccess, setSavingAccess] = useState(false)
  const [accessError, setAccessError] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [whatsAppResource, setWhatsAppResource] = useState<WhatsAppSendResource | null>(null)

  const [profile] = useState<AuthUser | null>(getStoredUser())
  const admin = isAdmin(profile)
  const pageSize = 20
  const selectedDirectory = directories.find((directory) => String(directory.id) === selectedDirectoryId) || null
  const filteredAccessUsers = accessUsers.filter((user) => {
    const keyword = accessUserSearch.trim().toLowerCase()
    return !keyword || user.username.toLowerCase().includes(keyword) || user.email.toLowerCase().includes(keyword)
  })

  const fetchDirectories = useCallback(async () => {
    try {
      const res = await api.get<GalleryDirectory[]>('/gallery/directories')
      setDirectories(res.code === 0 && res.data ? res.data : [])
    } catch {
      setDirectories([])
    }
  }, [])

  const fetchImages = useCallback(async (p: number) => {
    setLoading(true)
    try {
      const directoryParam = selectedDirectoryId ? `&directory_id=${selectedDirectoryId}` : ''
      const res = await api.get<{ list: GalleryImage[]; total: number; page: number; size: number }>(
        `/attachments/images?page=${p}&size=${pageSize}${directoryParam}`
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
  }, [selectedDirectoryId])

  useEffect(() => {
    fetchImages(page)
  }, [page, fetchImages])

  useEffect(() => {
    fetchDirectories()
  }, [fetchDirectories])

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files?.length) return
    setUploading(true)
    try {
      for (let i = 0; i < files.length; i++) {
        const formData = new FormData()
        formData.append('file', files[i])
        if (selectedDirectoryId) {
          formData.append('gallery_directory_id', selectedDirectoryId)
        }
        await api.download('/gallery/upload', { method: 'POST', body: formData })
      }
      await fetchImages(page)
    } catch (err) {
      console.error('Upload failed:', err)
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const handleCreateDirectory = async () => {
    if (!newDirectoryName.trim() || creatingDirectory) return
    setCreatingDirectory(true)
    setDirectoryError('')
    try {
      const res = await api.post<GalleryDirectory>('/gallery/directories', { name: newDirectoryName.trim() })
      if (res.code === 0 && res.data) {
        setNewDirectoryName('')
        setSelectedDirectoryId(String(res.data.id))
        setPage(1)
        await fetchDirectories()
      }
    } finally {
      setCreatingDirectory(false)
    }
  }

  const handleDeleteDirectory = async () => {
    if (!admin || !selectedDirectory || deletingDirectory) return
    if (!window.confirm(`确定删除图库目录“${selectedDirectory.name}”吗？目录中的图片不会被删除，会继续保留在“全部图片”中。`)) return
    setDeletingDirectory(true)
    setDirectoryError('')
    try {
      const res = await api.delete(`/gallery/directories/${selectedDirectory.id}`)
      if (res.code !== 0) {
        setDirectoryError(res.message || '删除图库目录失败')
        return
      }
      setSelectedDirectoryId('')
      setPage(1)
      await fetchDirectories()
    } catch {
      setDirectoryError('删除图库目录失败')
    } finally {
      setDeletingDirectory(false)
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

  const openDirectoryAccess = async (directory: GalleryDirectory) => {
    setAccessDirectory(directory)
    setDirectoryAccess(null)
    setAccessUsers([])
    setAccessUserSearch('')
    setAccessError('')
    setLoadingAccess(true)
    try {
      const [accessRes, usersRes] = await Promise.all([
        api.get<GalleryDirectoryAccess>(`/gallery/directories/${directory.id}/access`),
        api.get<User[]>('/users/shareable'),
      ])
      if (accessRes.code !== 0 || !accessRes.data) {
        setAccessError(accessRes.message || '加载目录权限失败')
        return
      }
      setDirectoryAccess(accessRes.data)
      setAccessUsers(usersRes.code === 0 && usersRes.data ? usersRes.data : [])
    } catch {
      setAccessError('加载目录权限失败')
    } finally {
      setLoadingAccess(false)
    }
  }

  const updateDirectoryUserAccess = (userId: number, level: 'none' | 'view' | 'edit') => {
    setDirectoryAccess((current) => {
      if (!current) return current
      const viewIds = current.view_user_ids.filter((id) => id !== userId)
      const editIds = current.edit_user_ids.filter((id) => id !== userId)
      if (level === 'view') viewIds.push(userId)
      if (level === 'edit') editIds.push(userId)
      return { ...current, view_user_ids: viewIds, edit_user_ids: editIds }
    })
  }

  const saveDirectoryAccess = async () => {
    if (!accessDirectory || !directoryAccess || savingAccess) return
    setSavingAccess(true)
    setAccessError('')
    try {
      const res = await api.put<GalleryDirectoryAccess>(`/gallery/directories/${accessDirectory.id}/access`, {
        visibility: directoryAccess.visibility,
        view_user_ids: directoryAccess.view_user_ids,
        edit_user_ids: directoryAccess.edit_user_ids,
      })
      if (res.code !== 0 || !res.data) {
        setAccessError(res.message || '保存目录权限失败')
        return
      }
      setDirectoryAccess(res.data)
      await fetchDirectories()
      setAccessDirectory(null)
    } catch {
      setAccessError('保存目录权限失败')
    } finally {
      setSavingAccess(false)
    }
  }

  const openRename = (image: GalleryImage, event?: ReactMouseEvent) => {
    event?.preventDefault()
    event?.stopPropagation()
    setRenaming(image)
    setRenameValue(image.filename)
    setRenameError('')
  }

  const handleRename = async () => {
    if (!renaming || !renameValue.trim() || savingRename) return
    setSavingRename(true)
    setRenameError('')
    try {
      const res = await api.put<GalleryImage>(`/gallery/images/${renaming.id}/name`, { filename: renameValue.trim() })
      if (res.code !== 0 || !res.data) {
        setRenameError(res.message || '重命名失败')
        return
      }
      const renamed = res.data
      setImages((current) => current.map((image) => image.id === renamed.id ? renamed : image))
      setPreview((current) => current?.id === renamed.id ? renamed : current)
      setRenaming(null)
    } catch {
      setRenameError('重命名失败')
    } finally {
      setSavingRename(false)
    }
  }

  const handleTransformImage = async (transform: ImageTransform) => {
    if (!preview || transformingImage) return
    setTransformingImage(transform)
    setTransformError('')
    try {
      const file = await transformRemoteImage(preview.url, preview.filename, preview.mime_type, transform)
      const formData = new FormData()
      formData.append('file', file)
      const res = await api.form<GalleryImage>(`/gallery/images/${preview.id}/content`, formData, 'PUT')
      if (res.code !== 0 || !res.data) {
        setTransformError(res.message || `${imageTransformLabel(transform)}失败`)
        return
      }
      const updated = res.data
      setImages((current) => current.map((image) => image.id === updated.id ? updated : image))
      setPreview(updated)
    } catch (error) {
      setTransformError(error instanceof Error ? error.message : `${imageTransformLabel(transform)}失败`)
    } finally {
      setTransformingImage(null)
    }
  }

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  const downloadURL = (image: GalleryImage) => `${image.url}${image.url.includes('?') ? '&' : '?'}download=1`

  const totalPages = Math.ceil(total / pageSize)

  return (
    <AuthGuard>
      <div className="min-h-screen bg-[linear-gradient(180deg,#f8fafc_0%,#eff6ff_100%)]">
        {/* Header */}
        <div className="mx-auto max-w-7xl px-3 py-5 sm:px-6 sm:py-8">
          <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
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
              className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-50 sm:w-auto"
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

          <div className="mb-8 grid gap-3 rounded-lg border border-slate-200 bg-white p-3 shadow-sm md:grid-cols-[220px_minmax(0,1fr)_140px_auto_auto]">
            <select
              value={selectedDirectoryId}
              onChange={(event) => {
                setSelectedDirectoryId(event.target.value)
                setPage(1)
                setDirectoryError('')
              }}
              className="h-10 rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-600 outline-none focus:border-sky-300"
            >
              <option value="">全部图片</option>
              {directories.map((directory) => (
                <option key={directory.id} value={directory.id}>
                  {directory.channel_id ? '频道 / ' : ''}{directory.name}
                  {directory.visibility === 'private' ? ' / 私有' : directory.visibility === 'public' ? ' / 全员' : ' / 频道成员'}
                </option>
              ))}
            </select>
            <input
              value={newDirectoryName}
              onChange={(event) => setNewDirectoryName(event.target.value)}
              placeholder="新建图库目录，例如：销售频道素材"
              className="h-10 rounded-xl border border-slate-200 bg-white px-3 text-sm outline-none focus:border-sky-300"
            />
            <button
              type="button"
              onClick={() => void handleCreateDirectory()}
              disabled={!newDirectoryName.trim() || creatingDirectory}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <FolderPlus className="h-4 w-4" />
              新建目录
            </button>
            <button
              type="button"
              onClick={() => { if (selectedDirectory) void openDirectoryAccess(selectedDirectory) }}
              disabled={!selectedDirectory?.can_manage}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
              title={selectedDirectory?.can_manage ? '管理当前目录权限' : '选择你可以管理的目录'}
            >
              <ShieldCheck className="h-4 w-4" />
              目录权限
            </button>
            {admin && (
              <button
                type="button"
                onClick={() => void handleDeleteDirectory()}
                disabled={!selectedDirectory || deletingDirectory}
                className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-rose-200 bg-white px-3 text-sm font-semibold text-rose-600 transition hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-40"
                title={selectedDirectory ? '删除当前图库目录，图片会保留' : '请先选择要删除的目录'}
              >
                <Trash2 className="h-4 w-4" />
                {deletingDirectory ? '删除中...' : '删除目录'}
              </button>
            )}
            {directoryError && <div className="md:col-span-full rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{directoryError}</div>}
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
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 sm:gap-4 md:grid-cols-4 lg:grid-cols-5">
                {images.map((img) => (
                  <div
                    key={img.id}
                    className="group relative overflow-hidden rounded-lg border border-slate-200/80 bg-white shadow-sm transition hover:border-sky-200 hover:shadow-md"
                  >
                    <button type="button" onClick={(event) => openRename(img, event)} className="absolute right-2 top-2 z-10 inline-flex h-8 w-8 items-center justify-center rounded-lg bg-white/95 text-slate-600 shadow-sm transition hover:text-sky-600" title="重命名图片">
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button type="button" onClick={() => { setPreview(img); setTransformError('') }} className="block aspect-square w-full overflow-hidden bg-slate-100 text-left" title="查看图片">
                      <img
                        src={img.thumbnail_url || imageThumbnailUrl(img.url, 320)}
                        alt={img.filename}
                        className="h-full w-full object-cover transition group-hover:scale-105"
                        loading="lazy"
                      />
                    </button>
                    <div className="p-2 sm:p-3">
                      <p className="truncate text-xs font-semibold text-slate-800">{img.filename}</p>
                      <p className="mt-1 truncate text-[11px] text-slate-500">上传者：{img.uploader_name || `用户 #${img.uploader_id}`}</p>
                      <span className="mt-1.5 block text-[10px] text-slate-400">{formatSize(img.size)}</span>
                      <div className={`mt-2 grid gap-1.5 ${admin ? 'grid-cols-4' : 'grid-cols-3'}`}>
                        <button type="button" onClick={() => { setPreview(img); setTransformError('') }} className="flex h-8 w-full items-center justify-center rounded-lg border border-slate-200 text-slate-500 transition hover:border-sky-200 hover:bg-sky-50 hover:text-sky-600" title="查看大图" aria-label={`查看 ${img.filename}`}><ZoomIn className="h-3.5 w-3.5" /></button>
                        <a href={downloadURL(img)} download={img.filename} className="flex h-8 w-full items-center justify-center rounded-lg border border-slate-200 text-slate-500 transition hover:border-emerald-200 hover:bg-emerald-50 hover:text-emerald-600" title="下载原图" aria-label={`下载原图 ${img.filename}`}><Download className="h-3.5 w-3.5" /></a>
                        <button type="button" onClick={() => setWhatsAppResource({ attachmentId: img.id, title: img.filename, defaultContent: img.filename })} className="flex h-8 w-full items-center justify-center rounded-lg border border-emerald-200 text-emerald-600 transition hover:bg-emerald-50" title="发送到 WhatsApp" aria-label={`发送 ${img.filename} 到 WhatsApp`}><MessageCircle className="h-3.5 w-3.5" /></button>
                        {admin && <button type="button" onClick={() => handleDelete(img.id)} disabled={deleting === img.id} className="flex h-8 w-full items-center justify-center rounded-lg border border-rose-200 text-rose-500 transition hover:bg-rose-50 hover:text-rose-700 disabled:opacity-50" title="删除图片" aria-label={`删除 ${img.filename}`}><Trash2 className="h-3.5 w-3.5" /></button>}
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

        {accessDirectory && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/40 p-3 sm:p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) setAccessDirectory(null) }}>
            <div className="flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg bg-white shadow-2xl">
              <div className="flex items-center justify-between border-b border-slate-200 px-4 py-4 sm:px-5">
                <div className="min-w-0">
                  <div className="truncate text-base font-semibold text-slate-900">目录权限 · {accessDirectory.name}</div>
                  <div className="mt-1 text-xs text-slate-400">管理员或目录所有者可以配置可见范围和编辑人员</div>
                </div>
                <button type="button" onClick={() => setAccessDirectory(null)} className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100" title="关闭"><X className="h-4 w-4" /></button>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">
                {loadingAccess ? (
                  <div className="flex h-64 items-center justify-center text-sm text-slate-400">正在加载权限...</div>
                ) : directoryAccess ? (
                  <div className="space-y-5">
                    <section>
                      <div className="mb-2 text-sm font-semibold text-slate-800">默认可见范围</div>
                      <div className={`grid gap-2 rounded-lg bg-slate-100 p-1 ${accessDirectory.channel_id ? 'grid-cols-3' : 'grid-cols-2'}`}>
                        <button type="button" onClick={() => setDirectoryAccess((current) => current ? { ...current, visibility: 'private' } : current)} className={`flex min-h-10 items-center justify-center gap-2 rounded-lg px-2 text-sm font-medium transition ${directoryAccess.visibility === 'private' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}><LockKeyhole className="h-4 w-4" />仅指定人员</button>
                        {accessDirectory.channel_id && <button type="button" onClick={() => setDirectoryAccess((current) => current ? { ...current, visibility: 'channel' } : current)} className={`flex min-h-10 items-center justify-center gap-2 rounded-lg px-2 text-sm font-medium transition ${directoryAccess.visibility === 'channel' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}><UsersRound className="h-4 w-4" />频道成员</button>}
                        <button type="button" onClick={() => setDirectoryAccess((current) => current ? { ...current, visibility: 'public' } : current)} className={`flex min-h-10 items-center justify-center gap-2 rounded-lg px-2 text-sm font-medium transition ${directoryAccess.visibility === 'public' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}><Globe2 className="h-4 w-4" />全部员工</button>
                      </div>
                      <p className="mt-2 text-xs leading-5 text-slate-400">指定人员权限优先；“可编辑”人员同时拥有查看、上传、保存和重命名权限。</p>
                    </section>

                    <section>
                      <div className="mb-2 flex items-center justify-between gap-3">
                        <div className="text-sm font-semibold text-slate-800">指定员工权限</div>
                        <span className="text-xs text-slate-400">{directoryAccess.view_user_ids.length + directoryAccess.edit_user_ids.length} 人已授权</span>
                      </div>
                      <label className="flex h-10 items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 text-sm text-slate-500 focus-within:border-sky-300 focus-within:bg-white">
                        <Search className="h-4 w-4 shrink-0" />
                        <input value={accessUserSearch} onChange={(event) => setAccessUserSearch(event.target.value)} placeholder="搜索员工姓名或邮箱" className="min-w-0 flex-1 bg-transparent outline-none" />
                      </label>
                      <div className="mt-3 max-h-72 overflow-y-auto rounded-lg border border-slate-200">
                        {filteredAccessUsers.length === 0 ? (
                          <div className="p-8 text-center text-sm text-slate-400">没有匹配的员工</div>
                        ) : filteredAccessUsers.map((user) => {
                          const level = directoryAccess.edit_user_ids.includes(user.id)
                            ? 'edit'
                            : directoryAccess.view_user_ids.includes(user.id) ? 'view' : 'none'
                          return (
                            <div key={user.id} className="flex items-center gap-3 border-b border-slate-100 px-3 py-2.5 last:border-b-0">
                              <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-slate-100 text-xs font-semibold text-slate-600">{user.avatar ? <img src={user.avatar} alt="" className="h-full w-full object-cover" /> : user.username.slice(0, 2).toUpperCase()}</div>
                              <div className="min-w-0 flex-1">
                                <div className="truncate text-sm font-medium text-slate-800">{user.username}</div>
                                <div className="truncate text-xs text-slate-400">{user.email}</div>
                              </div>
                              <select value={level} onChange={(event) => updateDirectoryUserAccess(user.id, event.target.value as 'none' | 'view' | 'edit')} className="h-9 shrink-0 rounded-lg border border-slate-200 bg-white px-2 text-sm text-slate-600 outline-none focus:border-sky-300">
                                <option value="none">不授权</option>
                                <option value="view">可查看</option>
                                <option value="edit">可编辑</option>
                              </select>
                            </div>
                          )
                        })}
                      </div>
                    </section>
                  </div>
                ) : (
                  <div className="flex h-64 items-center justify-center text-sm text-rose-600">{accessError || '无法加载目录权限'}</div>
                )}
                {accessError && directoryAccess && <div className="mt-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{accessError}</div>}
              </div>

              <div className="flex items-center justify-end gap-2 border-t border-slate-200 px-4 py-4 sm:px-5">
                <button type="button" onClick={() => setAccessDirectory(null)} className="h-9 rounded-lg border border-slate-200 px-4 text-sm text-slate-600 hover:bg-slate-50">取消</button>
                <button type="button" onClick={() => void saveDirectoryAccess()} disabled={!directoryAccess || savingAccess} className="h-9 rounded-lg bg-slate-900 px-4 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-50">{savingAccess ? '保存中...' : '保存权限'}</button>
              </div>
            </div>
          </div>
        )}

        {/* Preview Modal */}
        {preview && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
            onClick={() => {
              if (transformingImage) return
              setPreview(null)
              setTransformError('')
            }}
          >
            <div
              className="relative flex max-h-[92vh] w-[min(94vw,1100px)] flex-col items-center"
              onClick={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                onClick={() => { setPreview(null); setTransformError('') }}
                disabled={Boolean(transformingImage)}
                className="absolute -right-3 -top-3 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-white text-slate-700 shadow-lg transition hover:bg-slate-100 disabled:opacity-40"
              >
                <X className="h-4 w-4" />
              </button>
              <img
                src={preview.url}
                alt={preview.filename}
                className="max-h-[72vh] max-w-full rounded-lg object-contain shadow-2xl"
              />
              <div className="mt-3 flex w-full max-w-2xl flex-col items-stretch gap-2 rounded-lg bg-black/35 px-3 py-2.5 text-left backdrop-blur-sm sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                <div className="min-w-0 sm:flex-1">
                  <p className="truncate text-sm font-medium text-white">{preview.filename}</p>
                  <p className="mt-0.5 truncate text-xs text-white/60">上传者：{preview.uploader_name || `用户 #${preview.uploader_id}`} · {formatSize(preview.size)}</p>
                </div>
                <div className="flex w-full items-center justify-between gap-1 sm:w-auto sm:justify-end sm:gap-1.5">
                  <button type="button" onClick={() => void handleTransformImage('rotate-left')} disabled={Boolean(transformingImage)} className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-white/80 transition hover:bg-white/10 hover:text-white disabled:opacity-40" title="向左旋转并保存" aria-label="向左旋转并保存"><RotateCcw className="h-4 w-4" /></button>
                  <button type="button" onClick={() => void handleTransformImage('rotate-right')} disabled={Boolean(transformingImage)} className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-white/80 transition hover:bg-white/10 hover:text-white disabled:opacity-40" title="向右旋转并保存" aria-label="向右旋转并保存"><RotateCw className="h-4 w-4" /></button>
                  <button type="button" onClick={() => void handleTransformImage('flip-horizontal')} disabled={Boolean(transformingImage)} className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-white/80 transition hover:bg-white/10 hover:text-white disabled:opacity-40" title="水平翻转并保存" aria-label="水平翻转并保存"><FlipHorizontal2 className="h-4 w-4" /></button>
                  <button type="button" onClick={() => void handleTransformImage('flip-vertical')} disabled={Boolean(transformingImage)} className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-white/80 transition hover:bg-white/10 hover:text-white disabled:opacity-40" title="垂直翻转并保存" aria-label="垂直翻转并保存"><FlipVertical2 className="h-4 w-4" /></button>
                  <a href={downloadURL(preview)} download={preview.filename} className="inline-flex h-9 shrink-0 items-center gap-2 rounded-lg bg-white px-3 text-sm font-semibold text-slate-800 transition hover:bg-slate-100"><Download className="h-4 w-4" />下载图片</a>
                </div>
              </div>
              {(transformingImage || transformError) && (
                <div className={`mt-2 flex min-h-8 items-center gap-2 rounded-lg px-3 text-xs ${transformError ? 'bg-rose-500/20 text-rose-100' : 'bg-white/10 text-white/75'}`}>
                  {transformingImage && <RefreshCw className="h-3.5 w-3.5 animate-spin" />}
                  {transformError || (transformingImage ? `${imageTransformLabel(transformingImage)}并保存中...` : '')}
                </div>
              )}
            </div>
          </div>
        )}

        {renaming && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/35 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) setRenaming(null) }}>
            <div className="w-full max-w-md rounded-lg bg-white shadow-2xl">
              <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
                <div>
                  <div className="text-base font-semibold text-slate-900">重命名图片</div>
                  <div className="mt-1 text-xs text-slate-400">图库和频道消息中的文件名会同步更新</div>
                </div>
                <button type="button" onClick={() => setRenaming(null)} className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700" title="关闭"><X className="h-4 w-4" /></button>
              </div>
              <div className="p-5">
                <label className="block">
                  <span className="mb-1.5 block text-xs font-medium text-slate-600">图片名称</span>
                  <input autoFocus value={renameValue} onChange={(event) => setRenameValue(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void handleRename() }} className="h-10 w-full rounded-lg border border-slate-200 px-3 text-sm outline-none focus:border-sky-300" />
                </label>
                <div className="mt-2 text-xs text-slate-400">不填写扩展名时会保留原图片扩展名。</div>
                {renameError && <div className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{renameError}</div>}
              </div>
              <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-4">
                <button type="button" onClick={() => setRenaming(null)} className="h-9 rounded-lg border border-slate-200 px-4 text-sm text-slate-600 hover:bg-slate-50">取消</button>
                <button type="button" onClick={() => void handleRename()} disabled={savingRename || !renameValue.trim()} className="h-9 rounded-lg bg-sky-600 px-4 text-sm font-semibold text-white hover:bg-sky-700 disabled:opacity-50">{savingRename ? '保存中...' : '保存名称'}</button>
              </div>
            </div>
          </div>
        )}
      </div>
        <WhatsAppSendDialog open={Boolean(whatsAppResource)} resource={whatsAppResource} onClose={() => setWhatsAppResource(null)} />
      </AuthGuard>
  )
}
