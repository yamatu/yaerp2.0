'use client'

import { useEffect, useState, useCallback } from 'react'
import { autoSave } from '@/lib/auto-save'
import type { CellUpdate } from '@/types'

export function useAutoSave() {
  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving' | 'error'>('saved')

  useEffect(() => {
    autoSave.onSave((success, error) => {
      setSaveStatus(success ? 'saved' : 'error')
      if (error) console.error('Auto-save error:', error)
    })

    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (autoSave.hasPendingChanges()) {
        autoSave.flush()
        e.preventDefault()
      }
    }

    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
      autoSave.flush()
    }
  }, [])

  const saveChange = useCallback((change: CellUpdate) => {
    setSaveStatus('saving')
    autoSave.addChange(change)
  }, [])

  return { saveStatus, saveChange }
}
