'use client'

import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'

export type UserPreferenceValidator<T> = (value: unknown) => value is T

function userPreferenceStorageKey(userId: number | null | undefined, name: string) {
  return `yaerp:ui-preference:${userId || 'guest'}:${name}`
}

export function isBooleanPreference(value: unknown): value is boolean {
  return typeof value === 'boolean'
}

export function isNullablePositiveIntegerPreference(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isInteger(value) && value > 0)
}

export function useUserPreference<T>(
  userId: number | null | undefined,
  name: string,
  defaultValue: T,
  validate: UserPreferenceValidator<T>
): [T, Dispatch<SetStateAction<T>>, boolean] {
  const storageKey = useMemo(() => userPreferenceStorageKey(userId, name), [name, userId])
  const defaultValueRef = useRef(defaultValue)
  const validateRef = useRef(validate)
  const [value, setValue] = useState(defaultValue)
  const [loadedStorageKey, setLoadedStorageKey] = useState<string | null>(null)

  defaultValueRef.current = defaultValue
  validateRef.current = validate

  useEffect(() => {
    let nextValue = defaultValueRef.current
    try {
      const raw = window.localStorage.getItem(storageKey)
      if (raw !== null) {
        const parsed: unknown = JSON.parse(raw)
        if (validateRef.current(parsed)) nextValue = parsed
      }
    } catch {
      nextValue = defaultValueRef.current
    }
    setValue(nextValue)
    setLoadedStorageKey(storageKey)
  }, [storageKey])

  useEffect(() => {
    if (loadedStorageKey !== storageKey) return
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(value))
    } catch {
      // UI preferences are optional; keep the current in-memory value.
    }
  }, [loadedStorageKey, storageKey, value])

  return [value, setValue, loadedStorageKey === storageKey]
}
