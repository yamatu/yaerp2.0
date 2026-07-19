const RETURN_TARGET_KEY = 'yaerp:navigation:return-target'

interface ReturnTargetRecord {
  target: string
  expiresAt: number
}

export function setReturnTarget(target: string, ttlMs = 12 * 60 * 60 * 1000) {
  if (typeof window === 'undefined' || !target.startsWith('/')) return
  const record: ReturnTargetRecord = { target, expiresAt: Date.now() + ttlMs }
  window.sessionStorage.setItem(RETURN_TARGET_KEY, JSON.stringify(record))
}

export function getReturnTarget(fallback = '/') {
  if (typeof window === 'undefined') return fallback
  try {
    const raw = window.sessionStorage.getItem(RETURN_TARGET_KEY)
    if (!raw) return fallback
    const record = JSON.parse(raw) as Partial<ReturnTargetRecord>
    if (!record.target?.startsWith('/') || !record.expiresAt || record.expiresAt < Date.now()) {
      window.sessionStorage.removeItem(RETURN_TARGET_KEY)
      return fallback
    }
    return record.target
  } catch {
    return fallback
  }
}

export function consumeReturnTarget(fallback = '/') {
  const target = getReturnTarget(fallback)
  if (typeof window !== 'undefined') window.sessionStorage.removeItem(RETURN_TARGET_KEY)
  return target
}
