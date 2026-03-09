import type { AuthUser, TokenResponse } from '@/types'
import api from './api'

const CURRENT_USER_KEY = 'current_user'

interface TokenClaims {
  user_id: number
  username: string
  exp: number
  iat?: number
}

export function saveTokens(tokens: TokenResponse) {
  localStorage.setItem('access_token', tokens.access_token)
  localStorage.setItem('refresh_token', tokens.refresh_token)
}

export function saveCurrentUser(user: AuthUser) {
  localStorage.setItem(CURRENT_USER_KEY, JSON.stringify(user))
}

export function getAccessToken(): string | null {
  if (typeof window === 'undefined') return null
  return localStorage.getItem('access_token')
}

export function getStoredUser(): AuthUser | null {
  if (typeof window === 'undefined') return null

  const raw = localStorage.getItem(CURRENT_USER_KEY)
  if (!raw) return null

  try {
    return JSON.parse(raw) as AuthUser
  } catch {
    localStorage.removeItem(CURRENT_USER_KEY)
    return null
  }
}

export function clearTokens() {
  localStorage.removeItem('access_token')
  localStorage.removeItem('refresh_token')
  localStorage.removeItem(CURRENT_USER_KEY)
}

export function parseJWT(token: string): TokenClaims | null {
  try {
    const payload = token.split('.')[1]
    return JSON.parse(atob(payload)) as TokenClaims
  } catch {
    return null
  }
}

export function isTokenExpired(token: string | null = getAccessToken()): boolean {
  if (!token) return true

  const payload = parseJWT(token)
  if (!payload?.exp) return true

  return payload.exp * 1000 <= Date.now()
}

export function isAuthenticated(): boolean {
  const token = getAccessToken()
  return !!token && !isTokenExpired(token)
}

export function getCurrentUserClaims() {
  const token = getAccessToken()
  if (!token) return null
  return parseJWT(token)
}

export async function fetchCurrentUser(): Promise<AuthUser | null> {
  const res = await api.get<AuthUser>('/auth/me')
  if (res.code === 0 && res.data) {
    saveCurrentUser(res.data)
    return res.data
  }

  return null
}

export function hasRole(user: AuthUser | null, roleCode: string): boolean {
  return !!user?.roles?.some((role) => role.code === roleCode)
}

export function isAdmin(user: AuthUser | null): boolean {
  return hasRole(user, 'admin')
}
