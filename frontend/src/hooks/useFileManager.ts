'use client'

import { useCallback, useEffect, useState } from 'react'
import api from '@/lib/api'
import type { Folder, FolderContents } from '@/types'

export function useFileManager() {
  const [currentFolderId, setCurrentFolderId] = useState<number | null>(null)
  const [contents, setContents] = useState<FolderContents>({ folders: [], workbooks: [] })
  const [breadcrumb, setBreadcrumb] = useState<Folder[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const loadContents = useCallback(async (folderId: number | null) => {
    setLoading(true)
    setError('')
    try {
      const params = folderId !== null ? `?parent_id=${folderId}` : ''
      const res = await api.get<FolderContents>(`/folders${params}`)
      setContents(res.data ?? { folders: [], workbooks: [] })
    } catch (err) {
      console.error('Failed to load folder contents:', err)
      setContents({ folders: [], workbooks: [] })
      setError('加载文件夹内容失败')
    } finally {
      setLoading(false)
    }
  }, [])

  const loadBreadcrumb = useCallback(async (folderId: number | null) => {
    if (folderId === null) {
      setBreadcrumb([])
      return
    }
    try {
      const res = await api.get<Folder[]>(`/folders/${folderId}/breadcrumb`)
      setBreadcrumb(res.data ?? [])
    } catch {
      setBreadcrumb([])
    }
  }, [])

  const navigateTo = useCallback(
    async (folderId: number | null) => {
      setCurrentFolderId(folderId)
      await Promise.all([loadContents(folderId), loadBreadcrumb(folderId)])
    },
    [loadContents, loadBreadcrumb]
  )

  const refresh = useCallback(() => {
    return navigateTo(currentFolderId)
  }, [currentFolderId, navigateTo])

  useEffect(() => {
    navigateTo(null)
  }, [navigateTo])

  const createFolder = useCallback(
    async (name: string) => {
      await api.post('/folders', {
        name,
        parent_id: currentFolderId,
      })
      await refresh()
    },
    [currentFolderId, refresh]
  )

  const renameFolder = useCallback(
    async (folderId: number, newName: string) => {
      await api.put(`/folders/${folderId}`, { name: newName })
      await refresh()
    },
    [refresh]
  )

  const deleteFolder = useCallback(
    async (folderId: number) => {
      await api.delete(`/folders/${folderId}`)
      await refresh()
    },
    [refresh]
  )

  const moveWorkbook = useCallback(
    async (workbookId: number, targetFolderId: number | null) => {
      await api.put(`/workbooks/${workbookId}/move`, {
        folder_id: targetFolderId,
      })
      await refresh()
    },
    [refresh]
  )

  return {
    currentFolderId,
    contents,
    breadcrumb,
    loading,
    error,
    navigateTo,
    refresh,
    createFolder,
    renameFolder,
    deleteFolder,
    moveWorkbook,
  }
}
