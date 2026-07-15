'use client'

import { useState, useEffect } from 'react'
import type { PermissionMatrix } from '@/types'
import { api } from '@/lib/api'

export function usePermission(sheetId: number) {
  const [permissions, setPermissions] = useState<PermissionMatrix | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true

    async function fetch() {
      if (!sheetId) {
        if (active) {
          setPermissions(null)
          setLoading(false)
        }
        return
      }

      if (active) {
        setLoading(true)
        setPermissions(null)
      }

      try {
        const res = await api.get<PermissionMatrix>(`/sheets/${sheetId}/permissions`)
        if (!active) return
        if (res.code === 0 && res.data) {
          setPermissions(res.data)
        } else {
          setPermissions(null)
        }
      } catch {
        if (active) {
          setPermissions(null)
        }
      } finally {
        if (active) {
          setLoading(false)
        }
      }
    }
    fetch()

    return () => {
      active = false
    }
  }, [sheetId])

  const canEditCell = (col: string, row?: number): boolean => {
    if (!permissions) return false
    if (!permissions.sheet.canEdit) return false

    if (row !== undefined) {
      const cellKey = `${row}:${col}`
      if (permissions.cells[cellKey]) return permissions.cells[cellKey] === 'write'

      const rowKey = `${row}`
      if (permissions.rows[rowKey]) return permissions.rows[rowKey] === 'write'
    }

    const colPerm = permissions.columns[col]
    if (colPerm) return colPerm === 'write'

    return permissions.defaultPermission ? permissions.defaultPermission === 'write' : permissions.sheet.canEdit
  }

  const canViewColumn = (col: string): boolean => {
    if (!permissions) return false
    if (!permissions.sheet.canView) return false
    const colPerm = permissions.columns[col]
    if (colPerm) return colPerm !== 'none'
    return permissions.defaultPermission ? permissions.defaultPermission !== 'none' : true
  }

  const isColumnReadOnly = (col: string): boolean => {
    if (!permissions) return true
    const colPerm = permissions.columns[col]
    if (colPerm) return colPerm !== 'write'
    return permissions.defaultPermission ? permissions.defaultPermission !== 'write' : !permissions.sheet.canEdit
  }

  return {
    permissions,
    loading,
    canEditCell,
    canViewColumn,
    isColumnReadOnly,
  }
}
