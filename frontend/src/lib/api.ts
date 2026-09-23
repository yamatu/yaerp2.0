import type { ApiResponse, TokenResponse } from '@/types'
import { getRealtimeClientId } from './realtimeClient'

const API_BASE = process.env.NEXT_PUBLIC_API_URL || '/api'

class ApiClient {
  private getToken(): string | null {
    if (typeof window === 'undefined') return null
    return localStorage.getItem('access_token')
  }

  private buildHeaders(options: RequestInit = {}): Record<string, string> {
    const headers: Record<string, string> = {
      ...((options.headers as Record<string, string>) || {}),
    }
    const clientId = getRealtimeClientId()
    if (clientId && !headers['X-Client-Id']) {
      headers['X-Client-Id'] = clientId
    }
    if (options.body && !(options.body instanceof FormData) && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json'
    }
    return headers
  }

  private async requestRaw(endpoint: string, options: RequestInit = {}): Promise<Response> {
    const token = this.getToken()
    const headers = this.buildHeaders(options)
    if (token) {
      headers['Authorization'] = `Bearer ${token}`
    }

    const res = await fetch(`${API_BASE}${endpoint}`, {
      ...options,
      headers,
    })

    if (res.status === 401) {
      const refreshed = await this.refreshToken()
      if (refreshed) {
        const retryHeaders = this.buildHeaders(options)
        const nextToken = this.getToken()
        if (nextToken) {
          retryHeaders['Authorization'] = `Bearer ${nextToken}`
        }
        return fetch(`${API_BASE}${endpoint}`, {
          ...options,
          headers: retryHeaders,
        })
      }

      if (typeof window !== 'undefined') {
        localStorage.removeItem('access_token')
        localStorage.removeItem('refresh_token')
        localStorage.removeItem('current_user')
        window.location.href = '/login'
      }
    }

    return res
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<ApiResponse<T>> {
    const res = await this.requestRaw(endpoint, options)
    return res.json()
  }

  private async refreshToken(): Promise<boolean> {
    const refreshToken = typeof window !== 'undefined'
      ? localStorage.getItem('refresh_token')
      : null
    if (!refreshToken) return false

    try {
      const res = await fetch(`${API_BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refreshToken }),
      })
      if (!res.ok) return false
      const data: ApiResponse<TokenResponse> = await res.json()
      if (data.code === 0 && data.data) {
        localStorage.setItem('access_token', data.data.access_token)
        localStorage.setItem('refresh_token', data.data.refresh_token)
        return true
      }
      return false
    } catch {
      return false
    }
  }

  get<T>(endpoint: string) {
    return this.request<T>(endpoint)
  }

  post<T>(endpoint: string, body?: unknown) {
    return this.request<T>(endpoint, {
      method: 'POST',
      body: body ? JSON.stringify(body) : undefined,
    })
  }

  put<T>(endpoint: string, body?: unknown) {
    return this.request<T>(endpoint, {
      method: 'PUT',
      body: body ? JSON.stringify(body) : undefined,
    })
  }

  delete<T>(endpoint: string) {
    return this.request<T>(endpoint, { method: 'DELETE' })
  }

  form<T>(endpoint: string, body: FormData, method: 'POST' | 'PUT' = 'POST') {
    return this.request<T>(endpoint, { method, body })
  }

  download(endpoint: string, options: RequestInit = {}) {
    return this.requestRaw(endpoint, options)
  }

  /**
   * Consume a Server-Sent Events endpoint. Every `data:` payload is JSON decoded
   * and handed to onEvent in arrival order.
   *
   * Returns a promise that resolves when the server closes the stream. Pass a
   * signal to cancel the turn; the reader is released so the backend agent loop
   * sees the closed connection and stops.
   */
  async stream(
    endpoint: string,
    body: unknown,
    onEvent: (event: unknown) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const res = await this.requestRaw(endpoint, {
      method: 'POST',
      body: JSON.stringify(body ?? {}),
      headers: { Accept: 'text/event-stream' },
      signal,
    })

    if (!res.ok || !res.body) {
      // Validation errors are returned as plain JSON before the stream starts.
      let message = `请求失败 (${res.status})`
      try {
        const payload = await res.json()
        if (payload && typeof payload.message === 'string') message = payload.message
      } catch {
        // keep the status based message
      }
      throw new Error(message)
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let completed = false

    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        // SSE frames are separated by a blank line.
        let separator = buffer.indexOf('\n\n')
        while (separator !== -1) {
          const frame = buffer.slice(0, separator)
          buffer = buffer.slice(separator + 2)
          separator = buffer.indexOf('\n\n')

          for (const line of frame.split('\n')) {
            const trimmed = line.trim()
            if (!trimmed.startsWith('data:')) continue
            const payload = trimmed.slice(5).trim()
            if (!payload || payload === '[DONE]') continue
            let event: { type?: string; error?: string }
            try {
              event = JSON.parse(payload)
            } catch {
              throw new Error('智能体返回了损坏的流事件')
            }
            onEvent(event)
            if (event.type === 'agent_end') completed = true
            if (event.type === 'error') throw new Error(event.error || '智能体执行失败')
          }
        }
      }
      if (!completed) throw new Error('智能体连接意外中断，操作可能仅部分完成')
    } finally {
      reader.releaseLock()
    }
  }

  async upload(file: File): Promise<ApiResponse<{ id: number; url: string }>> {
    const token = this.getToken()
    const formData = new FormData()
    formData.append('file', file)

    const res = await fetch(`${API_BASE}/upload`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: formData,
    })
    return res.json()
  }
}

export const api = new ApiClient()
export default api
