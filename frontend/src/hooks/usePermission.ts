'use client'

import { useState, useEffect } from 'react'
import type { PermissionMatrix } from '@/types'
import { api } from '@/lib/api'

export function usePermission(sheetId: number) {
  const [permissions, setPermissions] = useState<PermissionMatrix | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function fetch() {
      if (!sheetId) return
      setLoading(true)
      try {
        const res = await api.get<PermissionMatrix>(`/sheets/${sheetId}/permissions`)
        if (res.code === 0 && res.data) {
          setPermissions(res.data)
        } else {
          setPermissions(null)
        }
      } catch {
        setPermissions(null)
      } finally {
        setLoading(false)
      }
    }
    fetch()
  }, [sheetId])

  const canEditCell = (col: string, row?: number): boolean => {
    if (!permissions) return false
    if (!permissions.sheet.canEdit) return false

    // Check cell-specific permission
    if (row !== undefined) {
      const cellKey = `${row}:${col}`
      if (permissions.cells[cellKey] === 'read') return false
      if (permissions.cells[cellKey] === 'none') return false
    }

    // Check column permission
    const colPerm = permissions.columns[col]
    if (colPerm === 'read' || colPerm === 'none') return false

    return true
  }

  const canViewColumn = (col: string): boolean => {
    if (!permissions) return false
    if (!permissions.sheet.canView) return false
    const colPerm = permissions.columns[col]
    return colPerm !== 'none'
  }

  const isColumnReadOnly = (col: string): boolean => {
    if (!permissions) return true
    const colPerm = permissions.columns[col]
    return colPerm === 'read'
  }

  return {
    permissions,
    loading,
    canEditCell,
    canViewColumn,
    isColumnReadOnly,
  }
}
