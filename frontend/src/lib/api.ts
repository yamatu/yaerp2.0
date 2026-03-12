import type { ApiResponse, TokenResponse } from '@/types'

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

  download(endpoint: string, options: RequestInit = {}) {
    return this.requestRaw(endpoint, options)
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
