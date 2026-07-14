const CLIENT_ID_KEY = 'yaerp_realtime_client_id'

let fallbackClientId = ''

function createClientId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function getRealtimeClientId() {
  if (typeof window === 'undefined') return ''

  try {
    const stored = window.sessionStorage.getItem(CLIENT_ID_KEY)
    if (stored) return stored

    const clientId = createClientId()
    window.sessionStorage.setItem(CLIENT_ID_KEY, clientId)
    return clientId
  } catch {
    if (!fallbackClientId) {
      fallbackClientId = createClientId()
    }
    return fallbackClientId
  }
}
