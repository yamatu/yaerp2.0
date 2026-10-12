'use client'

import { useEffect, useState, useRef, useCallback, useMemo, type MouseEvent as ReactMouseEvent } from 'react'
import {
  ArrowLeft,
  Camera,
  Check,
  CheckSquare,
  Download,
  FolderCog,
  FlipHorizontal2,
  FlipVertical2,
  FolderInput,
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
import { FilePreviewModal, type FilePreviewItem } from '@/components/ui/FilePreviewModal'
import { MOBILE_QUERY, useBodyClass, useHistoryLayer, useLongPress, useMediaQuery } from '@/hooks/useMobileGestures'
import type { AuthUser, GalleryDirectory, GalleryDirectoryAccess, GalleryImage, User } from '@/types'

interface GalleryImagesMoveResult {
  directory_id: number
  moved_count: number
  duplicates_removed: number
}

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
  const [selectedImageIds, setSelectedImageIds] = useState<number[]>([])
  const [moveDirectoryId, setMoveDirectoryId] = useState('')
  const [movingImages, setMovingImages] = useState(false)
  const [selectingAllImages, setSelectingAllImages] = useState(false)
  const [moveError, setMoveError] = useState('')
  const [moveNotice, setMoveNotice] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const cameraInputRef = useRef<HTMLInputElement>(null)
  const [whatsAppResource, setWhatsAppResource] = useState<WhatsAppSendResource | null>(null)

  // Phones: a plain photo grid. Long press (or "选择") enters selection mode,
  // where taps toggle photos and a bar above the tab bar holds the actions.
  const isPhone = useMediaQuery(MOBILE_QUERY)
  const [selectMode, setSelectMode] = useState(false)
  const [directorySheetOpen, setDirectorySheetOpen] = useState(false)
  const phoneSelecting = isPhone && (selectMode || selectedImageIds.length > 0)
  const exitSelection = useCallback(() => {
    setSelectMode(false)
    setSelectedImageIds([])
    setMoveDirectoryId('')
    setMoveError('')
  }, [])
  const closeDirectorySheet = useCallback(() => setDirectorySheetOpen(false), [])
  useHistoryLayer(phoneSelecting, exitSelection)
  // The selection bar uses the corner where the AI launcher floats.
  useBodyClass('fab-hidden', phoneSelecting)
  useHistoryLayer(isPhone && directorySheetOpen, closeDirectorySheet)
  const imageLongPress = useLongPress<GalleryImage>((image) => {
    if (!image.can_manage || movingImages) return
    setSelectMode(true)
    setMoveError('')
    setMoveNotice('')
    setSelectedImageIds((current) => current.includes(image.id) ? current : [...current, image.id])
  })

  const [profile] = useState<AuthUser | null>(getStoredUser())
  const admin = isAdmin(profile)
  const pageSize = 20
  const selectedDirectory = directories.find((directory) => String(directory.id) === selectedDirectoryId) || null
  const selectedImageIdSet = useMemo(() => new Set(selectedImageIds), [selectedImageIds])
  const movablePageImageIds = useMemo(() => images.filter((image) => image.can_manage).map((image) => image.id), [images])
  const allMovablePageImagesSelected = movablePageImageIds.length > 0 && movablePageImageIds.every((id) => selectedImageIdSet.has(id))
  const editableMoveDirectories = useMemo(() => directories.filter((directory) => directory.can_edit && String(directory.id) !== selectedDirectoryId), [directories, selectedDirectoryId])
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

  const galleryImagesPath = useCallback((targetPage: number, size: number) => {
    const directoryParam = selectedDirectoryId ? `&directory_id=${selectedDirectoryId}` : ''
    return `/attachments/images?page=${targetPage}&size=${size}${directoryParam}`
  }, [selectedDirectoryId])

  const fetchImages = useCallback(async (p: number) => {
    setLoading(true)
    try {
      const res = await api.get<{ list: GalleryImage[]; total: number; page: number; size: number }>(
        galleryImagesPath(p, pageSize)
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
  }, [galleryImagesPath])

  useEffect(() => {
    fetchImages(page)
  }, [page, fetchImages])

  useEffect(() => {
    fetchDirectories()
  }, [fetchDirectories])

  useEffect(() => {
    setSelectedImageIds([])
    setMoveDirectoryId('')
    setMoveError('')
    setMoveNotice('')
  }, [selectedDirectoryId])

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.target
    // Copy first: clearing the input below empties the live FileList.
    const files = Array.from(input.files || [])
    if (!files.length) return
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
      input.value = ''
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
      setSelectedImageIds((current) => current.filter((imageId) => imageId !== id))
      await fetchImages(page)
    } catch (err) {
      console.error('Delete failed:', err)
    } finally {
      setDeleting(null)
    }
  }

  const toggleImageSelection = (image: GalleryImage) => {
    if (!image.can_manage || movingImages) return
    setMoveError('')
    setMoveNotice('')
    setSelectedImageIds((current) => current.includes(image.id)
      ? current.filter((id) => id !== image.id)
      : [...current, image.id])
  }

  const toggleCurrentPageSelection = () => {
    if (movablePageImageIds.length === 0 || movingImages) return
    setMoveError('')
    setMoveNotice('')
    setSelectedImageIds((current) => {
      const next = new Set(current)
      if (allMovablePageImagesSelected) {
        movablePageImageIds.forEach((id) => next.delete(id))
      } else {
        movablePageImageIds.forEach((id) => next.add(id))
      }
      return Array.from(next)
    })
  }

  const selectAllMovableImages = async () => {
    if (selectingAllImages || movingImages || total === 0) return
    setSelectingAllImages(true)
    setMoveError('')
    setMoveNotice('')
    try {
      const ids: number[] = []
      let targetPage = 1
      let expectedTotal = total
      do {
        const res = await api.get<{ list: GalleryImage[]; total: number; page: number; size: number }>(galleryImagesPath(targetPage, 100))
        if (res.code !== 0 || !res.data) {
          throw new Error(res.message || '读取图库图片失败')
        }
        expectedTotal = res.data.total
        res.data.list.forEach((image) => {
          if (image.can_manage && ids.length < 5000) ids.push(image.id)
        })
        targetPage += 1
      } while ((targetPage - 1) * 100 < expectedTotal && ids.length < 5000)
      setSelectedImageIds(Array.from(new Set(ids)))
      if (ids.length >= 5000 && expectedTotal > ids.length) {
        setMoveNotice(`单次最多移动 5000 张图片，已选择前 ${ids.length} 张可移动图片。`)
      } else if (ids.length < expectedTotal) {
        setMoveNotice(`已选择 ${ids.length} 张可移动图片，另有 ${expectedTotal - ids.length} 张仅可查看。`)
      }
    } catch (error) {
      setMoveError(error instanceof Error ? error.message : '全选图片失败')
    } finally {
      setSelectingAllImages(false)
    }
  }

  const handleMoveImages = async () => {
    if (selectedImageIds.length === 0 || !moveDirectoryId || movingImages) return
    const targetDirectory = directories.find((directory) => String(directory.id) === moveDirectoryId)
    if (!targetDirectory?.can_edit) {
      setMoveError('请选择有编辑权限的目标目录')
      return
    }
    setMovingImages(true)
    setMoveError('')
    setMoveNotice('')
    try {
      const res = await api.put<GalleryImagesMoveResult>('/gallery/images/move', {
        attachment_ids: selectedImageIds,
        directory_id: targetDirectory.id,
      })
      if (res.code !== 0 || !res.data) {
        setMoveError(res.message || '移动图片失败')
        return
      }
      const movedCount = res.data.moved_count - res.data.duplicates_removed
      setMoveNotice(`已将 ${Math.max(0, movedCount)} 张图片移动到「${targetDirectory.name}」${res.data.duplicates_removed > 0 ? `，并合并 ${res.data.duplicates_removed} 张重复图片` : ''}。`)
      setSelectedImageIds([])
      setMoveDirectoryId('')
      await Promise.all([fetchImages(page), fetchDirectories()])
    } catch {
      setMoveError('移动图片失败')
    } finally {
      setMovingImages(false)
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

  // The shared viewer works on a plain item list; the open image stays visible
  // even when a filter removed it from the current page.
  const previewItems = useMemo<FilePreviewItem[]>(() => {
    const toItem = (image: GalleryImage): FilePreviewItem => ({
      key: String(image.id),
      name: image.filename,
      url: image.url,
      mimeType: image.mime_type,
      size: image.size,
      meta: `上传者：${image.uploader_name || `用户 #${image.uploader_id}`}`,
    })
    if (preview && !images.some((image) => image.id === preview.id)) return [toItem(preview)]
    return images.map(toItem)
  }, [images, preview])
  const previewIndex = preview ? images.findIndex((image) => image.id === preview.id) : -1
  const closePreview = useCallback(() => {
    if (transformingImage) return
    setPreview(null)
    setTransformError('')
  }, [transformingImage])

  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  useEffect(() => {
    if (!loading && page > totalPages) setPage(totalPages)
  }, [loading, page, totalPages])

  return (
    <AuthGuard>
      <div className="min-h-screen bg-[linear-gradient(180deg,#f8fafc_0%,#eff6ff_100%)]">
        {/* Header */}
        <div className={`mx-auto max-w-7xl px-2 sm:px-6 md:py-8 ${phoneSelecting ? 'pb-40' : 'pb-6'}`}>
          <div className="sticky top-0 z-30 -mx-2 mb-2 flex items-center justify-between gap-2 border-b border-slate-200 bg-white/95 px-2 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))] backdrop-blur sm:-mx-6 sm:px-6 md:static md:mx-0 md:mb-6 md:border-0 md:bg-transparent md:p-0 md:backdrop-blur-none">
            <div className="flex min-w-0 items-center gap-2 md:gap-4">
              <a
                href="/"
                className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-xl px-2.5 text-sm text-slate-500 transition hover:bg-white/80 hover:text-slate-900 md:px-3"
                aria-label="返回首页"
              >
                <ArrowLeft className="h-4 w-4" />
                <span className="hidden md:inline">返回首页</span>
              </a>
              <div className="hidden h-6 w-px bg-slate-200 md:block" />
              <div className="flex min-w-0 items-center gap-3">
                <div className="hidden h-10 w-10 items-center justify-center rounded-xl bg-slate-900 text-white md:flex">
                  <Images className="h-5 w-5" />
                </div>
                <div className="min-w-0">
                  <h1 className="text-lg font-bold text-slate-900">图库</h1>
                  <p className="truncate text-xs text-slate-500">
                    {uploading ? '正在上传...' : `共 ${total} 张图片`}
                  </p>
                </div>
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-1 md:gap-2">
              <button
                type="button"
                onClick={() => { if (phoneSelecting) exitSelection(); else setSelectMode(true) }}
                disabled={movablePageImageIds.length === 0 && !phoneSelecting}
                className={`inline-flex h-10 items-center gap-1.5 rounded-xl px-3 text-sm font-medium transition disabled:opacity-40 md:hidden ${phoneSelecting ? 'bg-sky-600 text-white' : 'text-slate-600 active:bg-slate-100'}`}
              >
                <CheckSquare className="h-4 w-4" />
                {phoneSelecting ? '完成' : '选择'}
              </button>
              <button
                type="button"
                onClick={() => cameraInputRef.current?.click()}
                disabled={uploading}
                className="inline-flex h-10 w-10 items-center justify-center rounded-xl text-slate-700 transition active:bg-slate-100 disabled:opacity-50 md:hidden"
                title="拍照上传"
                aria-label="拍照上传"
              >
                <Camera className="h-5 w-5" />
              </button>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                className="inline-flex h-10 w-10 items-center justify-center gap-2 rounded-xl bg-slate-900 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-50 md:w-auto md:px-4"
                title="从相册或文件上传图片"
                aria-label="上传图片"
              >
                {uploading ? <RefreshCw className="h-4 w-4 animate-spin" /> : <ImagePlus className="h-5 w-5 md:h-4 md:w-4" />}
                <span className="hidden md:inline">{uploading ? '上传中...' : '上传图片'}</span>
              </button>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              onChange={handleUpload}
              className="hidden"
            />
            <input
              ref={cameraInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              onChange={handleUpload}
              className="hidden"
            />
          </div>

          {/* Phones: directory picker plus a sheet for the management actions. */}
          <div className="mb-2 flex items-center gap-2 md:hidden">
            <select
              value={selectedDirectoryId}
              onChange={(event) => {
                setSelectedDirectoryId(event.target.value)
                setPage(1)
                setDirectoryError('')
              }}
              className="h-10 min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 text-base text-slate-700 outline-none focus:border-sky-300"
              aria-label="图库目录"
            >
              <option value="">全部图片</option>
              {directories.map((directory) => (
                <option key={directory.id} value={directory.id}>
                  {directory.channel_id ? '频道 / ' : ''}{directory.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => setDirectorySheetOpen(true)}
              className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-600 active:bg-slate-50"
              title="目录管理"
              aria-label="目录管理"
            >
              <FolderCog className="h-5 w-5" />
            </button>
          </div>

          <div
            className={`${directorySheetOpen ? 'fixed inset-0 z-[90] flex items-end bg-slate-950/40' : 'hidden'} md:static md:z-auto md:mb-8 md:block md:bg-transparent`}
            onClick={() => setDirectorySheetOpen(false)}
          >
          <div
            className="grid w-full gap-3 rounded-t-2xl bg-white p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-sm md:grid-cols-[220px_minmax(0,1fr)_140px_auto_auto] md:rounded-lg md:border md:border-slate-200 md:p-3"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between md:hidden">
              <div>
                <div className="text-base font-semibold text-slate-900">目录管理</div>
                <div className="mt-0.5 text-xs text-slate-500">当前：{selectedDirectory ? selectedDirectory.name : '全部图片'}</div>
              </div>
              <button type="button" onClick={() => setDirectorySheetOpen(false)} className="inline-flex h-10 w-10 items-center justify-center rounded-lg text-slate-400 active:bg-slate-100" aria-label="关闭"><X className="h-5 w-5" /></button>
            </div>
            <select
              value={selectedDirectoryId}
              onChange={(event) => {
                setSelectedDirectoryId(event.target.value)
                setPage(1)
                setDirectoryError('')
              }}
              className="hidden h-10 rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-600 outline-none focus:border-sky-300 md:block"
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
              className="h-11 min-w-0 rounded-xl border border-slate-200 bg-white px-3 text-base outline-none focus:border-sky-300 md:h-10 md:text-sm"
            />
            <button
              type="button"
              onClick={() => void handleCreateDirectory()}
              disabled={!newDirectoryName.trim() || creatingDirectory}
              className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 md:h-10"
            >
              <FolderPlus className="h-4 w-4" />
              新建目录
            </button>
            <button
              type="button"
              onClick={() => { if (selectedDirectory) { setDirectorySheetOpen(false); void openDirectoryAccess(selectedDirectory) } }}
              disabled={!selectedDirectory?.can_manage}
              className="inline-flex h-11 items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40 md:h-10"
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
                className="inline-flex h-11 items-center justify-center gap-2 rounded-lg border border-rose-200 bg-white px-3 text-sm font-semibold text-rose-600 transition hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-40 md:h-10"
                title={selectedDirectory ? '删除当前图库目录，图片会保留' : '请先选择要删除的目录'}
              >
                <Trash2 className="h-4 w-4" />
                {deletingDirectory ? '删除中...' : '删除目录'}
              </button>
            )}
            {directoryError && <div className="md:col-span-full rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{directoryError}</div>}
          </div>
          </div>

          {(images.length > 0 || selectedImageIds.length > 0) && (
            <div className={`${phoneSelecting ? 'fixed inset-x-0 bottom-[var(--mobile-tabbar-offset)] z-40 flex rounded-none border-x-0 border-b-0 shadow-[0_-6px_16px_rgba(15,23,42,0.08)]' : 'hidden'} flex-col gap-2 border border-slate-200 bg-white p-3 md:static md:z-auto md:mb-5 md:flex md:gap-3 md:rounded-lg md:border md:shadow-sm lg:flex-row lg:items-center lg:justify-between`}>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={toggleCurrentPageSelection}
                  disabled={movablePageImageIds.length === 0 || movingImages}
                  className={`inline-flex h-10 items-center gap-2 rounded-lg border px-3 text-sm font-medium transition md:h-9 ${allMovablePageImagesSelected ? 'border-sky-300 bg-sky-50 text-sky-700' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'} disabled:cursor-not-allowed disabled:opacity-40`}
                >
                  <span className={`flex h-4 w-4 items-center justify-center rounded border ${allMovablePageImagesSelected ? 'border-sky-500 bg-sky-500 text-white' : 'border-slate-300'}`}>
                    {allMovablePageImagesSelected && <Check className="h-3 w-3" />}
                  </span>
                  {allMovablePageImagesSelected ? '取消本页' : '全选本页'}
                </button>
                <button
                  type="button"
                  onClick={() => void selectAllMovableImages()}
                  disabled={selectingAllImages || movingImages || total === 0}
                  className="inline-flex h-10 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-sm font-medium text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40 md:h-9"
                >
                  {selectingAllImages ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Images className="h-4 w-4" />}
                  {selectingAllImages ? '正在全选...' : selectedDirectory ? '全选当前目录' : '全选全部图片'}
                </button>
                <span className={`rounded-lg px-2.5 py-1.5 text-xs font-semibold ${selectedImageIds.length > 0 ? 'bg-sky-50 text-sky-700' : 'bg-slate-100 text-slate-500'}`}>
                  已选 {selectedImageIds.length} 张
                </span>
              </div>

              <div className="flex min-w-0 items-center gap-2">
                <select
                  value={moveDirectoryId}
                  onChange={(event) => { setMoveDirectoryId(event.target.value); setMoveError(''); setMoveNotice('') }}
                  disabled={editableMoveDirectories.length === 0 || movingImages}
                  className="h-10 min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-600 outline-none focus:border-sky-300 md:h-9 md:w-56 md:flex-none"
                  aria-label="选择图片目标目录"
                >
                  <option value="">选择目标目录</option>
                  {editableMoveDirectories.map((directory) => (
                    <option key={directory.id} value={directory.id}>{directory.channel_id ? '频道 / ' : ''}{directory.name}</option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => void handleMoveImages()}
                  disabled={selectedImageIds.length === 0 || !moveDirectoryId || movingImages}
                  className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40 md:h-9"
                >
                  {movingImages ? <RefreshCw className="h-4 w-4 animate-spin" /> : <FolderInput className="h-4 w-4" />}
                  {movingImages ? '移动中...' : '移动图片'}
                </button>
                <button
                  type="button"
                  onClick={() => { setSelectedImageIds([]); setMoveDirectoryId(''); setMoveError(''); setMoveNotice('') }}
                  disabled={selectedImageIds.length === 0 || movingImages}
                  className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-slate-200 text-slate-400 transition hover:bg-slate-50 hover:text-slate-700 disabled:opacity-40 md:h-9 md:w-9"
                  title="清除图片选择"
                  aria-label="清除图片选择"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}

          {moveError && <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{moveError}</div>}
          {moveNotice && <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{moveNotice}</div>}

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
            <div className="flex min-h-[50dvh] items-center justify-center md:min-h-[400px]">
              <div className="text-center">
                <Images className="mx-auto mb-4 h-16 w-16 text-slate-300" />
                <h2 className="text-xl font-semibold text-slate-900">
                  还没有图片
                </h2>
                <p className="mt-2 text-sm text-slate-500">
                  <span className="md:hidden">点右上角拍照，或从相册选择图片上传。</span>
                  <span className="hidden md:inline">点击右上角「上传图片」开始使用。</span>
                </p>
              </div>
            </div>
          ) : (
            <>
              {/* Phones get an edge-to-edge photo grid; the card details and
                  per-image actions live in the full-screen viewer instead. */}
              <div className="-mx-2 grid grid-cols-3 gap-0.5 sm:mx-0 sm:gap-2 md:grid-cols-4 md:gap-4 lg:grid-cols-5">
                {images.map((img) => (
                  <div
                    key={img.id}
                    {...imageLongPress.bind(img)}
                    onContextMenu={(event) => { if (isPhone) event.preventDefault() }}
                    className={`group relative overflow-hidden bg-white transition [-webkit-touch-callout:none] md:rounded-lg md:border md:shadow-sm md:hover:shadow-md ${selectedImageIdSet.has(img.id) ? 'md:border-sky-400 md:ring-2 md:ring-sky-100' : 'md:border-slate-200/80 md:hover:border-sky-200'}`}
                  >
                    {img.can_manage ? (
                      <button type="button" onClick={() => toggleImageSelection(img)} className={`absolute left-1.5 top-1.5 z-10 h-7 w-7 items-center justify-center rounded-full border shadow-sm transition md:left-2 md:top-2 md:inline-flex md:h-8 md:w-8 md:rounded-lg ${phoneSelecting ? 'pointer-events-none inline-flex' : 'hidden'} ${selectedImageIdSet.has(img.id) ? 'border-sky-500 bg-sky-500 text-white' : 'border-white/80 bg-white/95 text-slate-400 hover:text-sky-600'}`} title={selectedImageIdSet.has(img.id) ? '取消选择图片' : '选择图片'} aria-label={`${selectedImageIdSet.has(img.id) ? '取消选择' : '选择'} ${img.filename}`}>
                        {selectedImageIdSet.has(img.id) && <Check className="h-4 w-4" />}
                      </button>
                    ) : (
                      <span className={`absolute left-1.5 top-1.5 z-10 h-7 w-7 items-center justify-center rounded-full bg-white/95 text-slate-400 shadow-sm md:left-2 md:top-2 md:inline-flex md:h-8 md:w-8 md:rounded-lg ${phoneSelecting ? 'inline-flex' : 'hidden'}`} title="仅可查看，不能移动"><LockKeyhole className="h-3.5 w-3.5" /></span>
                    )}
                    {img.can_manage && <button type="button" onClick={(event) => openRename(img, event)} className="absolute right-2 top-2 z-10 hidden h-8 w-8 items-center justify-center rounded-lg bg-white/95 text-slate-600 shadow-sm transition hover:text-sky-600 md:inline-flex" title="重命名图片">
                      <Pencil className="h-3.5 w-3.5" />
                    </button>}
                    <button
                      type="button"
                      onClick={() => {
                        if (phoneSelecting) {
                          toggleImageSelection(img)
                          return
                        }
                        setPreview(img)
                        setTransformError('')
                      }}
                      className="block aspect-square w-full select-none overflow-hidden bg-slate-100 text-left"
                      title="查看图片"
                    >
                      <img
                        src={img.thumbnail_url || imageThumbnailUrl(img.url, 320)}
                        alt={img.filename}
                        draggable={false}
                        className={`h-full w-full object-cover transition [-webkit-touch-callout:none] md:group-hover:scale-105 ${phoneSelecting && selectedImageIdSet.has(img.id) ? 'scale-90 rounded-lg opacity-80' : ''}`}
                        loading="lazy"
                      />
                    </button>
                    <div className="hidden p-2 sm:p-3 md:block">
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
                <div className="mt-4 flex items-center justify-center gap-2 md:mt-8">
                  <button
                    type="button"
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={page <= 1}
                    className="h-10 rounded-xl border border-slate-200 bg-white px-4 text-sm font-medium text-slate-600 transition hover:bg-white disabled:opacity-40"
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
                    className="h-10 rounded-xl border border-slate-200 bg-white px-4 text-sm font-medium text-slate-600 transition hover:bg-white disabled:opacity-40"
                  >
                    下一页
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        {accessDirectory && (
          <div className="fixed inset-0 z-[95] flex items-end justify-center bg-slate-950/40 p-0 sm:items-center sm:p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) setAccessDirectory(null) }}>
            <div className="flex max-h-[92dvh] sm:max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-t-2xl sm:rounded-lg bg-white shadow-2xl pb-[env(safe-area-inset-bottom)] sm:pb-0">
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
          <FilePreviewModal
            items={previewItems}
            index={previewIndex >= 0 ? previewIndex : 0}
            onIndexChange={(next) => {
              if (transformingImage || previewIndex < 0) return
              const target = images[next]
              if (target) {
                setPreview(target)
                setTransformError('')
              }
            }}
            onClose={closePreview}
            dimmed={Boolean(transformingImage)}
            errorMessage={transformError || undefined}
            showDownload={false}
            zIndexClass="z-[100]"
            footer={
              <>
                <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/5 p-1">
                  <button type="button" onClick={() => void handleTransformImage('rotate-left')} disabled={Boolean(transformingImage)} className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-white/80 transition hover:bg-white/10 hover:text-white disabled:opacity-40" title="向左旋转并保存" aria-label="向左旋转并保存"><RotateCcw className="h-4 w-4" /></button>
                  <button type="button" onClick={() => void handleTransformImage('rotate-right')} disabled={Boolean(transformingImage)} className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-white/80 transition hover:bg-white/10 hover:text-white disabled:opacity-40" title="向右旋转并保存" aria-label="向右旋转并保存"><RotateCw className="h-4 w-4" /></button>
                  <button type="button" onClick={() => void handleTransformImage('flip-horizontal')} disabled={Boolean(transformingImage)} className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-white/80 transition hover:bg-white/10 hover:text-white disabled:opacity-40" title="水平翻转并保存" aria-label="水平翻转并保存"><FlipHorizontal2 className="h-4 w-4" /></button>
                  <button type="button" onClick={() => void handleTransformImage('flip-vertical')} disabled={Boolean(transformingImage)} className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-white/80 transition hover:bg-white/10 hover:text-white disabled:opacity-40" title="垂直翻转并保存" aria-label="垂直翻转并保存"><FlipVertical2 className="h-4 w-4" /></button>
                </div>
                {transformingImage && <span className="inline-flex h-9 items-center gap-2 px-2 text-xs text-white/75"><RefreshCw className="h-3.5 w-3.5 animate-spin" />{imageTransformLabel(transformingImage)}并保存中...</span>}
                {/* Per-image actions that the phone grid no longer shows on each tile. */}
                <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/5 p-1 md:hidden">
                  {preview.can_manage && <button type="button" onClick={() => openRename(preview)} className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-white/80" title="重命名图片" aria-label="重命名图片"><Pencil className="h-4 w-4" /></button>}
                  <button type="button" onClick={() => { const image = preview; closePreview(); setWhatsAppResource({ attachmentId: image.id, title: image.filename, defaultContent: image.filename }) }} disabled={Boolean(transformingImage)} className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-emerald-300 disabled:opacity-40" title="发送到 WhatsApp" aria-label="发送到 WhatsApp"><MessageCircle className="h-4 w-4" /></button>
                  {admin && <button type="button" onClick={() => { const image = preview; closePreview(); void handleDelete(image.id) }} disabled={Boolean(transformingImage) || deleting === preview.id} className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-rose-300 disabled:opacity-40" title="删除图片" aria-label="删除图片"><Trash2 className="h-4 w-4" /></button>}
                </div>
                <a href={downloadURL(preview)} download={preview.filename} className="inline-flex h-10 shrink-0 items-center gap-2 rounded-lg bg-white px-3 text-sm font-semibold text-slate-800 transition hover:bg-slate-100 md:h-9"><Download className="h-4 w-4" /><span className="max-[380px]:hidden">下载图片</span></a>
              </>
            }
          />
        )}

        {renaming && (
          <div className="fixed inset-0 z-[120] flex items-end justify-center bg-slate-950/35 p-0 sm:items-center sm:p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) setRenaming(null) }}>
            <div className="w-full max-w-md rounded-t-2xl sm:rounded-lg bg-white shadow-2xl max-h-[92dvh] overflow-y-auto sm:max-h-none sm:overflow-visible pb-[env(safe-area-inset-bottom)] sm:pb-0">
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
