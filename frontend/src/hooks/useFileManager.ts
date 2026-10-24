'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import api from '@/lib/api'
import { subscribeDataChanged } from '@/lib/dataEvents'
import { setReturnTarget } from '@/lib/returnNavigation'
import type { Folder, FolderContents } from '@/types'

function folderFromUrl(): number | null {
  if (typeof window === 'undefined') return null
  const value = Number(new URLSearchParams(window.location.search).get('folder'))
  return Number.isInteger(value) && value > 0 ? value : null
}

/**
 * syncUrl keeps the open folder in the page address (?folder=) and as the
 * return target, so leaving a workbook or pressing back lands in that folder.
 */
export function useFileManager({ syncUrl = false }: { syncUrl?: boolean } = {}) {
  const [currentFolderId, setCurrentFolderId] = useState<number | null>(null)
  const [contents, setContents] = useState<FolderContents>({ folders: [], workbooks: [] })
  const [breadcrumb, setBreadcrumb] = useState<Folder[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const loadContents = useCallback(async (folderId: number | null, silent = false) => {
    if (!silent) setLoading(true)
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
      if (!silent) setLoading(false)
    }
  }, [])

  // Resolves to false when the folder does not exist or is not visible.
  const loadBreadcrumb = useCallback(async (folderId: number | null) => {
    if (folderId === null) {
      setBreadcrumb([])
      return true
    }
    try {
      const res = await api.get<Folder[]>(`/folders/${folderId}/breadcrumb`)
      setBreadcrumb(res.data ?? [])
      return res.code === 0
    } catch {
      setBreadcrumb([])
      return true
    }
  }, [])

  const navigateTo = useCallback(
    async (folderId: number | null) => {
      setCurrentFolderId(folderId)
      if (syncUrl) {
        const url = new URL(window.location.href)
        if (folderId === null) url.searchParams.delete('folder')
        else url.searchParams.set('folder', String(folderId))
        const target = url.pathname + url.search
        window.history.replaceState(window.history.state, '', target + url.hash)
        setReturnTarget(target)
      }
      const [, opened] = await Promise.all([loadContents(folderId), loadBreadcrumb(folderId)])
      // A remembered folder that was deleted or is no longer shared.
      if (!opened && syncUrl && folderId !== null) await navigateToRef.current(null)
    },
    [loadContents, loadBreadcrumb, syncUrl]
  )

  const navigateToRef = useRef(navigateTo)
  navigateToRef.current = navigateTo

  const refresh = useCallback(() => {
    return navigateTo(currentFolderId)
  }, [currentFolderId, navigateTo])

  useEffect(() => {
    void navigateTo(syncUrl ? folderFromUrl() : null)
  }, [navigateTo, syncUrl])

  useEffect(() => subscribeDataChanged((detail) => {
    if (!detail.resourcesChanged) return
    void loadContents(currentFolderId, true)
  }), [currentFolderId, loadContents])

  const createFolder = useCallback(
    async (name: string) => {
      const response = await api.post('/folders', {
        name,
        parent_id: currentFolderId,
      })
      if (response.code !== 0) {
        throw new Error(response.message || '新建文件夹失败')
      }
      await refresh()
    },
    [currentFolderId, refresh]
  )

  const renameFolder = useCallback(
    async (folderId: number, newName: string) => {
      const response = await api.put(`/folders/${folderId}`, { name: newName })
      if (response.code !== 0) {
        throw new Error(response.message || '重命名文件夹失败')
      }
      await refresh()
    },
    [refresh]
  )

  const deleteFolder = useCallback(
    async (folderId: number) => {
      const response = await api.delete(`/folders/${folderId}`)
      if (response.code !== 0) {
        throw new Error(response.message || '删除文件夹失败')
      }
      await refresh()
    },
    [refresh]
  )

  const moveWorkbook = useCallback(
    async (workbookId: number, targetFolderId: number | null) => {
      const response = await api.put(`/workbooks/${workbookId}/move`, {
        folder_id: targetFolderId,
      })
      if (response.code !== 0) {
        throw new Error(response.message || '移动工作簿失败')
      }
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
