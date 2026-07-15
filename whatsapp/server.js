'use strict'

const express = require('express')
const fs = require('fs/promises')
const path = require('path')
const QRCode = require('qrcode')
const proxyChain = require('proxy-chain')
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js')

const PORT = Number(process.env.PORT || 3010)
const INTERNAL_SECRET = process.env.WHATSAPP_INTERNAL_SECRET || ''
const WEBHOOK_URL = process.env.WHATSAPP_WEBHOOK_URL || ''
const DATA_DIR = process.env.WHATSAPP_DATA_DIR || '/data'
const CHROMIUM_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium'
const MAX_WEBHOOK_MEDIA_BYTES = Number(process.env.WHATSAPP_MAX_MEDIA_BYTES || 25 * 1024 * 1024)
const CLIENT_SHUTDOWN_TIMEOUT_MS = Number(process.env.WHATSAPP_CLIENT_SHUTDOWN_TIMEOUT_MS || 10000)
const OPERATION_WAIT_TIMEOUT_MS = Number(process.env.WHATSAPP_OPERATION_WAIT_TIMEOUT_MS || 5000)
const OPERATION_TIMEOUT_MS = Number(process.env.WHATSAPP_OPERATION_TIMEOUT_MS || 30000)
const STARTUP_TIMEOUT_MS = Number(process.env.WHATSAPP_STARTUP_TIMEOUT_MS || 120000)
const INITIALIZATION_CANCEL_GRACE_MS = Number(process.env.WHATSAPP_INITIALIZATION_CANCEL_GRACE_MS || 2000)
const CHAT_LIST_CACHE_MS = Number(process.env.WHATSAPP_CHAT_LIST_CACHE_MS || 10000)
const CHAT_METADATA_CACHE_MS = Number(process.env.WHATSAPP_CHAT_METADATA_CACHE_MS || 10 * 60 * 1000)
const CHAT_METADATA_LIMIT = Number(process.env.WHATSAPP_CHAT_METADATA_LIMIT || 30)
const CHAT_METADATA_TIMEOUT_MS = Number(process.env.WHATSAPP_CHAT_METADATA_TIMEOUT_MS || 8000)

const app = express()
app.use(express.json({ limit: '40mb' }))

const sessions = new Map()
let configuration = { proxyUrl: '' }

function createState() {
  return {
    status: 'disconnected',
    qr: '',
    qrDataUrl: '',
    loadingPercent: 0,
    loadingMessage: '',
    account: null,
    lastError: '',
    updatedAt: new Date().toISOString(),
  }
}

function normalizeSessionId(value) {
  const sessionId = String(value || '').trim()
  if (!/^[-_a-zA-Z0-9]+$/.test(sessionId)) throw new Error('invalid session id')
  return sessionId
}

function getSession(value) {
  const id = normalizeSessionId(value)
  if (!sessions.has(id)) {
    sessions.set(id, {
      id,
      client: null,
      initialization: null,
      localProxyUrl: '',
      operation: Promise.resolve(),
      startupTimer: null,
      chatListPromise: null,
      chatMetadataPromise: null,
      chatCache: { items: [], loadedAt: 0, metadataLoadedAt: 0, metadata: new Map() },
      state: createState(),
    })
  }
  return sessions.get(id)
}

function updateState(session, patch) {
  Object.assign(session.state, patch, { updatedAt: new Date().toISOString() })
}

function withTimeout(promise, timeoutMs, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
  })
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer))
}

function queueOperation(session, label, task) {
  const previous = session.operation
  const current = (async () => {
    try {
      await withTimeout(previous, OPERATION_WAIT_TIMEOUT_MS, `${label} queue wait`)
    } catch (error) {
      console.error(`Previous operation did not finish (${session.id}):`, error.message)
    }
    return withTimeout(Promise.resolve().then(task), OPERATION_TIMEOUT_MS, `${label} operation`)
  })()
  session.operation = current.catch(() => undefined)
  return current
}

function clearStartupTimer(session) {
  if (session.startupTimer) clearTimeout(session.startupTimer)
  session.startupTimer = null
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function killProfileProcesses(session) {
  const profileDir = path.join(DATA_DIR, 'auth', `session-${session.id}`)
  let entries = []
  try { entries = await fs.readdir('/proc') } catch { return }
  await Promise.all(entries.filter((entry) => /^\d+$/.test(entry)).map(async (entry) => {
    const pid = Number(entry)
    if (!pid || pid === process.pid) return
    try {
      const commandLine = await fs.readFile(`/proc/${entry}/cmdline`, 'utf8')
      if (!commandLine.includes(`--user-data-dir=${profileDir}`)) return
      process.kill(pid, 'SIGKILL')
    } catch { /* Processes can exit while /proc is being scanned. */ }
  }))
}

function scheduleStartupTimer(session, client) {
  clearStartupTimer(session)
  session.startupTimer = setTimeout(() => {
    if (session.client !== client || !['initializing', 'loading', 'authenticated'].includes(session.state.status)) return
    updateState(session, { status: 'error', lastError: 'WhatsApp Web 启动超时，请重试或清除登录状态' })
    void postWebhook(session, 'status', { ...session.state })
    void destroyClient(session)
  }, STARTUP_TIMEOUT_MS)
}

function resetChatCache(session) {
  session.chatListPromise = null
  session.chatMetadataPromise = null
  session.chatCache = { items: [], loadedAt: 0, metadataLoadedAt: 0, metadata: new Map() }
}

function invalidateChatList(session) {
  session.chatCache.loadedAt = 0
}

function requireInternalSecret(req, res, next) {
  if (!INTERNAL_SECRET || req.header('x-whatsapp-secret') !== INTERNAL_SECRET) {
    return res.status(401).json({ error: 'unauthorized' })
  }
  next()
}

async function postWebhook(session, type, payload = {}) {
  if (!WEBHOOK_URL || !INTERNAL_SECRET) return
  try {
    const response = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-whatsapp-secret': INTERNAL_SECRET,
      },
      body: JSON.stringify({ sessionId: session.id, type, payload, occurredAt: new Date().toISOString() }),
      signal: AbortSignal.timeout(20000),
    })
    if (!response.ok) console.error(`WhatsApp webhook failed: ${response.status} ${await response.text()}`)
  } catch (error) {
    console.error(`WhatsApp webhook error (${session.id}):`, error.message)
  }
}

function serializeId(value) {
  if (!value) return ''
  if (typeof value === 'string') return value
  return value._serialized || ''
}

async function safeProfilePic(client, contactId) {
  if (!contactId) return ''
  try { return await client.getProfilePicUrl(contactId) || '' } catch { return '' }
}

async function serializeMessage(session, message, includeMedia = false, includeContact = true) {
  const payload = {
    id: serializeId(message.id),
    chatId: message.fromMe ? message.to : message.from,
    from: message.from,
    to: message.to,
    author: message.author || '',
    fromMe: Boolean(message.fromMe),
    body: message.body || '',
    type: message.type || 'chat',
    timestamp: message.timestamp || Math.floor(Date.now() / 1000),
    hasMedia: Boolean(message.hasMedia),
    ack: message.ack,
    senderName: message._data?.notifyName || message._data?.sender?.pushname || '',
  }
  if (includeMedia && message.hasMedia) {
    try {
      const media = await message.downloadMedia()
      if (media?.data && Buffer.byteLength(media.data, 'base64') <= MAX_WEBHOOK_MEDIA_BYTES) {
        payload.media = {
          data: media.data,
          mimetype: media.mimetype || 'application/octet-stream',
          filename: media.filename || message._data?.filename || `whatsapp-${payload.timestamp}`,
        }
      } else if (media?.data) {
        payload.mediaSkipped = 'media_too_large'
      }
    } catch (error) {
      payload.mediaSkipped = error.message
    }
  }
  if (includeContact) {
    try {
      const contact = await message.getContact()
      payload.senderName = contact.pushname || contact.name || contact.shortName || contact.number || payload.author || payload.from
      payload.senderNumber = contact.number || ''
      payload.senderProfilePicUrl = await safeProfilePic(session.client, serializeId(contact.id))
    } catch {
      payload.senderName = payload.author || payload.from
    }
  } else if (!payload.senderName) {
    payload.senderName = payload.author || payload.from
  }
  if (message.hasQuotedMsg) {
    try {
      const quoted = await message.getQuotedMessage()
      if (quoted) {
        payload.quotedMessageId = serializeId(quoted.id)
        payload.quotedMessageBody = quoted.body || quoted._data?.caption || ''
        payload.quotedMessageFromMe = Boolean(quoted.fromMe)
        try {
          const quotedContact = await quoted.getContact()
          payload.quotedMessageSenderName = quoted.fromMe
            ? (session.state.account?.pushname || '你')
            : (quotedContact.pushname || quotedContact.name || quotedContact.shortName || quotedContact.number || quoted.author || quoted.from)
        } catch {
          payload.quotedMessageSenderName = quoted.fromMe ? (session.state.account?.pushname || '你') : (quoted.author || quoted.from || '')
        }
      }
    } catch (error) {
      payload.quotedMessageError = error.message
    }
  }
  return payload
}

async function closeLocalProxy(session) {
  if (!session.localProxyUrl) return
  try {
    await withTimeout(proxyChain.closeAnonymizedProxy(session.localProxyUrl, true), CLIENT_SHUTDOWN_TIMEOUT_MS, 'proxy shutdown')
  } catch (error) {
    console.error(`Failed to close proxy (${session.id}):`, error.message)
  } finally {
    session.localProxyUrl = ''
  }
}

async function destroyClient(session) {
  clearStartupTimer(session)
  const active = session.client
  const initialization = session.initialization
  session.client = null
  session.initialization = null
  resetChatCache(session)
  if (active) {
    if (!active.pupBrowser && initialization) {
      await Promise.race([initialization.catch(() => undefined), delay(INITIALIZATION_CANCEL_GRACE_MS)])
    }
    try {
      await withTimeout(active.destroy(), CLIENT_SHUTDOWN_TIMEOUT_MS, 'client destroy')
    } catch (error) {
      console.error(`Destroy failed (${session.id}):`, error.message)
      try {
        const browserProcess = active.pupBrowser?.process?.()
        if (browserProcess && !browserProcess.killed) browserProcess.kill('SIGKILL')
      } catch (killError) {
        console.error(`Force kill failed (${session.id}):`, killError.message)
      }
    }
  }
  await killProfileProcesses(session)
  await closeLocalProxy(session)
}

async function clearAuthProfile(session) {
  const profileDir = path.join(DATA_DIR, 'auth', `session-${session.id}`)
  try {
    await fs.rm(profileDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
  } catch (error) {
    console.error(`Auth profile cleanup failed (${session.id}):`, error.message)
    throw error
  }
}

async function migrateLegacyAdminSession(session) {
  if (session.id !== 'user-1') return
  const legacy = path.join(DATA_DIR, 'auth', 'session-yaerp')
  const target = path.join(DATA_DIR, 'auth', `session-${session.id}`)
  try {
    await fs.access(target)
  } catch {
    try { await fs.rename(legacy, target) } catch { /* No legacy session. */ }
  }
}

async function clearStaleProfileLocks(session) {
  await migrateLegacyAdminSession(session)
  const profileDir = path.join(DATA_DIR, 'auth', `session-${session.id}`)
  await Promise.all(['SingletonLock', 'SingletonCookie', 'SingletonSocket'].map(async (name) => {
    try { await fs.rm(path.join(profileDir, name), { force: true }) } catch { /* Missing locks are expected. */ }
  }))
}

async function prepareProxy(session) {
  await closeLocalProxy(session)
  if (!configuration.proxyUrl) return ''
  session.localProxyUrl = await proxyChain.anonymizeProxy(configuration.proxyUrl)
  return session.localProxyUrl
}

async function accountSnapshot(session, client) {
  const info = client.info
  if (!info) return null
  const wid = serializeId(info.wid)
  let about = ''
  try {
    const contact = await client.getContactById(wid)
    about = await contact.getAbout() || ''
  } catch { /* Privacy settings may hide the about text. */ }
  return {
    wid,
    pushname: info.pushname || '',
    platform: info.platform || '',
    profilePicUrl: await safeProfilePic(client, wid),
    about,
  }
}

function bindClientEvents(session, client) {
  const active = () => session.client === client
  client.on('loading_screen', (percent, message) => {
    if (!active()) return
    updateState(session, { status: 'loading', loadingPercent: Number(percent || 0), loadingMessage: message || '' })
    void postWebhook(session, 'status', { ...session.state, qr: undefined, qrDataUrl: undefined })
  })
  client.on('qr', async (qr) => {
    if (!active()) return
    const qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 360 })
    if (!active()) return
    clearStartupTimer(session)
    updateState(session, { status: 'qr', qr, qrDataUrl, lastError: '' })
    void postWebhook(session, 'status', { ...session.state, qr: undefined })
  })
  client.on('authenticated', () => {
    if (!active()) return
    updateState(session, { status: 'authenticated', qr: '', qrDataUrl: '', lastError: '' })
    void postWebhook(session, 'status', { ...session.state })
  })
  client.on('auth_failure', (message) => {
    if (!active()) return
    clearStartupTimer(session)
    updateState(session, { status: 'auth_failure', lastError: String(message || 'authentication failed') })
    void postWebhook(session, 'status', { ...session.state })
  })
  client.on('ready', async () => {
    if (!active()) return
    const account = await accountSnapshot(session, client)
    if (!active()) return
    clearStartupTimer(session)
    resetChatCache(session)
    updateState(session, {
      status: 'ready', qr: '', qrDataUrl: '', loadingPercent: 100, loadingMessage: '', lastError: '',
      account,
    })
    void postWebhook(session, 'status', { ...session.state })
  })
  client.on('change_state', (state) => active() && void postWebhook(session, 'session_state', { state }))
  client.on('disconnected', (reason) => {
    if (!active()) return
    clearStartupTimer(session)
    updateState(session, { status: 'disconnected', account: null, lastError: String(reason || '') })
    void postWebhook(session, 'status', { ...session.state })
  })
  client.on('message', async (message) => {
    if (!active()) return
    invalidateChatList(session)
    void postWebhook(session, 'message', await serializeMessage(session, message, true))
  })
  client.on('message_create', async (message) => {
    if (active() && message.fromMe) {
      invalidateChatList(session)
      void postWebhook(session, 'message_create', await serializeMessage(session, message, false))
    }
  })
  client.on('message_ack', (message, ack) => active() && void postWebhook(session, 'message_ack', { id: serializeId(message.id), ack }))
  client.on('message_edit', (message, newBody, previousBody) => {
    if (!active()) return
    void serializeMessage(session, message, false).then((payload) => postWebhook(session, 'message_edit', {
      ...payload, body: String(newBody || ''), previousBody: String(previousBody || ''),
    }))
  })
  client.on('message_revoke_everyone', (after, before) => active() && void postWebhook(session, 'message_revoke', {
    id: serializeId(after?.id), beforeId: serializeId(before?.id), chatId: after?.from || before?.from || '',
  }))
}

async function startSession(session) {
  await destroyClient(session)
  await clearStaleProfileLocks(session)
  updateState(session, { status: 'initializing', qr: '', qrDataUrl: '', loadingPercent: 0, loadingMessage: '', lastError: '' })
  const proxyUrl = await prepareProxy(session)
  const args = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-first-run', '--no-default-browser-check']
  if (proxyUrl) args.push(`--proxy-server=${proxyUrl}`)

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: session.id, dataPath: `${DATA_DIR}/auth` }),
    puppeteer: { headless: true, executablePath: CHROMIUM_PATH, args },
  })
  session.client = client
  bindClientEvents(session, client)
  scheduleStartupTimer(session, client)
  const initialization = client.initialize()
  session.initialization = initialization
  initialization.then(() => {
    if (session.initialization === initialization) session.initialization = null
  }).catch((error) => {
    if (session.client !== client) return
    if (session.initialization === initialization) session.initialization = null
    clearStartupTimer(session)
    updateState(session, { status: 'error', lastError: error.message })
    void postWebhook(session, 'status', { ...session.state })
    void destroyClient(session)
  })
  return session.state
}

function requireSession(req, res, next) {
  try {
    req.whatsappSession = getSession(req.params.sessionId)
    next()
  } catch (error) {
    res.status(400).json({ error: error.message })
  }
}

function requireReady(req, res, next) {
  const session = req.whatsappSession
  if (!session?.client || session.state.status !== 'ready') return res.status(409).json({ error: 'WhatsApp account is not ready' })
  next()
}

function serializeChatBasic(chat) {
  const lastMessage = chat.lastMessage
  return {
    id: serializeId(chat.id),
    name: chat.name || chat.formattedTitle || serializeId(chat.id),
    isGroup: Boolean(chat.isGroup),
    unreadCount: chat.unreadCount || 0,
    timestamp: chat.timestamp || lastMessage?.timestamp || 0,
    pinned: Boolean(chat.pinned),
    archived: Boolean(chat.archived),
    isMuted: Boolean(chat.isMuted),
    lastMessage: lastMessage?.body || '',
  }
}

function readableError(error, fallback = 'WhatsApp Web operation failed') {
  const message = String(error?.message || error || '').trim()
  return message.length > 2 ? message : fallback
}

function comparableChatId(value) {
  const serialized = serializeId(value).trim().toLowerCase()
  const [local = '', server = ''] = serialized.split('@')
  return { serialized, local: local.split(':')[0], server }
}

function chatIdMatches(left, right) {
  const a = comparableChatId(left)
  const b = comparableChatId(right)
  if (!a.serialized || !b.serialized) return false
  if (a.serialized === b.serialized) return true
  return Boolean(a.local && b.local && a.local === b.local && (!a.server || !b.server || a.server === b.server))
}

function serializeContactAsChat(contact) {
  const id = serializeId(contact.id)
  return {
    id,
    name: contact.name || contact.pushname || contact.shortName || contact.number || id,
    isGroup: false,
    unreadCount: 0,
    timestamp: 0,
    pinned: false,
    archived: false,
    isMuted: false,
    lastMessage: '',
    profilePicUrl: '',
    about: '',
    description: '',
    participantCount: 0,
  }
}

async function getContactChatFallback(session, limit) {
  const contacts = await withTimeout(session.client.getContacts(), 20000, 'get contacts')
  return contacts
    .filter((contact) => contact.isWAContact && !contact.isMe && serializeId(contact.id))
    .slice(0, limit)
    .map(serializeContactAsChat)
}

async function resolveChat(session, chatId) {
  let directError = null
  try {
    const direct = await session.client.getChatById(chatId)
    if (direct) return direct
  } catch (error) {
    directError = error
  }
  try {
    const chats = await withTimeout(session.client.getChats(), 20000, 'resolve chat list')
    const matched = chats.find((chat) => chatIdMatches(chat.id, chatId))
    if (matched) return matched
  } catch (error) {
    if (!directError) directError = error
  }
  if (directError) console.error(`Chat resolution failed (${session.id}/${chatId}):`, readableError(directError))
  return null
}

async function enrichChat(session, chat) {
  const basic = serializeChatBasic(chat)
  basic.profilePicUrl = await safeProfilePic(session.client, basic.id)
  basic.about = ''
  basic.description = ''
  basic.participantCount = 0
  if (chat.isGroup) {
    basic.description = chat.description || ''
    basic.participantCount = Array.isArray(chat.participants) ? chat.participants.length : 0
  } else {
    try {
      const contact = await chat.getContact()
      basic.about = await contact.getAbout() || ''
    } catch { /* Contact about may be private. */ }
  }
  return basic
}

function mergeChatMetadata(session, items) {
  return items.map((item) => ({ ...item, ...(session.chatCache.metadata.get(item.id) || {}) }))
}

function refreshChatMetadata(session, chats) {
  if (session.chatMetadataPromise || session.state.status !== 'ready') return session.chatMetadataPromise
  const client = session.client
  const selected = chats.slice(0, Math.max(0, CHAT_METADATA_LIMIT))
  session.chatMetadataPromise = mapWithConcurrency(selected, 2, async (chat) => {
    if (session.client !== client || session.state.status !== 'ready') return
    try {
      const enriched = await withTimeout(enrichChat(session, chat), CHAT_METADATA_TIMEOUT_MS, `chat metadata ${serializeId(chat.id)}`)
      const { id, name, isGroup, unreadCount, timestamp, pinned, archived, isMuted, lastMessage, ...metadata } = enriched
      session.chatCache.metadata.set(id, metadata)
    } catch (error) {
      console.error(`Chat metadata refresh failed (${session.id}/${serializeId(chat.id)}):`, error.message)
    }
  }).then(() => {
    if (session.client !== client) return
    session.chatCache.metadataLoadedAt = Date.now()
    session.chatCache.items = mergeChatMetadata(session, session.chatCache.items)
  }).catch((error) => {
    console.error(`Chat metadata batch failed (${session.id}):`, error.message)
  }).finally(() => {
    session.chatMetadataPromise = null
  })
  return session.chatMetadataPromise
}

async function getChatList(session, limit) {
  const now = Date.now()
  if (session.chatCache.items.length > 0 && now - session.chatCache.loadedAt < CHAT_LIST_CACHE_MS) {
    return mergeChatMetadata(session, session.chatCache.items).slice(0, limit)
  }
  if (!session.chatListPromise) {
    const client = session.client
    session.chatListPromise = withTimeout(client.getChats(), 20000, 'get chats').then(async (chats) => {
      if (session.client !== client) return []
      if (chats.length === 0) {
        const contacts = await getContactChatFallback(session, limit)
        session.chatCache.items = contacts
        session.chatCache.loadedAt = Date.now()
        return contacts
      }
      const selected = chats.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)).slice(0, Math.max(limit, 200))
      session.chatCache.items = mergeChatMetadata(session, selected.map(serializeChatBasic))
      session.chatCache.loadedAt = Date.now()
      if (Date.now() - session.chatCache.metadataLoadedAt >= CHAT_METADATA_CACHE_MS) void refreshChatMetadata(session, selected)
      return session.chatCache.items
    }).catch(async (error) => {
      if (session.chatCache.items.length === 0) {
        try {
          const contacts = await getContactChatFallback(session, limit)
          session.chatCache.items = contacts
          session.chatCache.loadedAt = Date.now()
          return contacts
        } catch (fallbackError) {
          throw new Error(`无法读取 WhatsApp 会话，请重新连接后重试：${readableError(error, readableError(fallbackError))}`)
        }
      }
      console.error(`Chat list refresh failed, serving cache (${session.id}):`, error.message)
      session.chatCache.loadedAt = Date.now()
      return session.chatCache.items
    }).finally(() => {
      session.chatListPromise = null
    })
  }
  const items = await session.chatListPromise
  return mergeChatMetadata(session, items).slice(0, limit)
}

async function mapWithConcurrency(items, limit, mapper) {
  const result = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      result[index] = await mapper(items[index], index)
    }
  })
  await Promise.all(workers)
  return result
}

app.get('/health', (_req, res) => res.json({ ok: true, sessions: sessions.size }))
app.use(requireInternalSecret)

app.post('/configure', async (req, res, next) => {
  try {
    configuration.proxyUrl = String(req.body.proxyUrl || '').trim()
    res.json({ ok: true, proxyConfigured: Boolean(configuration.proxyUrl) })
  } catch (error) { next(error) }
})
app.get('/sessions', (_req, res) => res.json(Array.from(sessions.values()).map((session) => ({ sessionId: session.id, ...session.state, qr: undefined }))))
app.get('/sessions/:sessionId/status', requireSession, (req, res) => {
  const session = req.whatsappSession
  if (!session.client && ['initializing', 'loading', 'authenticated', 'ready', 'qr'].includes(session.state.status)) {
    updateState(session, { status: 'disconnected', qr: '', qrDataUrl: '', account: null, lastError: '' })
  }
  res.json({ ...session.state, qr: undefined })
})
app.post('/sessions/:sessionId/start', requireSession, async (req, res, next) => {
  try { res.json(await queueOperation(req.whatsappSession, 'start', () => startSession(req.whatsappSession))) } catch (error) { next(error) }
})
app.post('/sessions/:sessionId/restart', requireSession, async (req, res, next) => {
  try { res.json(await queueOperation(req.whatsappSession, 'restart', () => startSession(req.whatsappSession))) } catch (error) { next(error) }
})
app.post('/sessions/:sessionId/logout', requireSession, async (req, res, next) => {
  const session = req.whatsappSession
  try {
    await queueOperation(session, 'logout', async () => {
      if (session.client?.pupPage && session.client?.pupBrowser) {
        try {
          await withTimeout(session.client.logout(), CLIENT_SHUTDOWN_TIMEOUT_MS, 'client logout')
        } catch (error) {
          console.error(`Logout failed (${session.id}):`, error.message)
        }
      }
      await destroyClient(session)
      await delay(300)
      await killProfileProcesses(session)
      await clearAuthProfile(session)
      await delay(300)
      await killProfileProcesses(session)
      await clearAuthProfile(session)
      updateState(session, { status: 'disconnected', qr: '', qrDataUrl: '', account: null, lastError: '' })
      void postWebhook(session, 'status', { ...session.state })
    })
    res.json(session.state)
  } catch (error) { next(error) }
})
app.get('/sessions/:sessionId/profile', requireSession, requireReady, async (req, res, next) => {
  try {
    const account = await accountSnapshot(req.whatsappSession, req.whatsappSession.client)
    updateState(req.whatsappSession, { account })
    res.json(account)
  } catch (error) { next(error) }
})
app.put('/sessions/:sessionId/profile/about', requireSession, requireReady, async (req, res, next) => {
  try {
    await req.whatsappSession.client.setStatus(String(req.body.about || '').slice(0, 139))
    const account = await accountSnapshot(req.whatsappSession, req.whatsappSession.client)
    updateState(req.whatsappSession, { account })
    res.json(account)
  } catch (error) { next(error) }
})

app.get('/sessions/:sessionId/chats', requireSession, requireReady, async (req, res, next) => {
  try {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit || 200)))
    res.json(await getChatList(req.whatsappSession, limit))
  } catch (error) { next(error) }
})
app.get('/sessions/:sessionId/contacts', requireSession, requireReady, async (req, res, next) => {
  try {
    const basic = req.query.basic === '1' || req.query.basic === 'true'
    const limit = Math.min(2000, Math.max(1, Number(req.query.limit || 1000)))
    const contacts = (await req.whatsappSession.client.getContacts()).filter((contact) => contact.isWAContact).slice(0, limit)
    res.json(await mapWithConcurrency(contacts, 8, async (contact) => ({
      id: serializeId(contact.id), number: contact.number || '',
      name: contact.name || contact.pushname || contact.shortName || contact.number || '',
      isBusiness: Boolean(contact.isBusiness), isMyContact: Boolean(contact.isMyContact),
      profilePicUrl: basic ? '' : await safeProfilePic(req.whatsappSession.client, serializeId(contact.id)),
    })))
  } catch (error) { next(error) }
})
app.get('/sessions/:sessionId/chats/:chatId/messages', requireSession, requireReady, async (req, res, next) => {
  try {
    const chat = await resolveChat(req.whatsappSession, req.params.chatId)
    if (!chat) return res.json([])
    const limit = Math.min(500, Math.max(1, Number(req.query.limit || 50)))
    const includeMedia = req.query.includeMedia === '1' || req.query.includeMedia === 'true'
    const messages = await chat.fetchMessages({ limit })
    if (!includeMedia) {
      return res.json(await Promise.all(messages.map((message) => serializeMessage(req.whatsappSession, message, false, false))))
    }
    const serialized = []
    for (const message of messages) {
      serialized.push(await serializeMessage(req.whatsappSession, message, true, false))
    }
    res.json(serialized)
  } catch (error) { next(error) }
})
app.post('/sessions/:sessionId/messages/send', requireSession, requireReady, async (req, res, next) => {
  try {
    const chatId = String(req.body.chatId || '').trim()
    if (!chatId) return res.status(400).json({ error: 'chatId is required' })
    const content = String(req.body.content || '')
    const options = req.body.quotedMessageId ? { quotedMessageId: String(req.body.quotedMessageId) } : {}
    let sent
    if (req.body.media?.data) {
      const media = new MessageMedia(req.body.media.mimetype || 'application/octet-stream', req.body.media.data, req.body.media.filename || 'attachment')
      sent = await req.whatsappSession.client.sendMessage(chatId, media, { ...options, caption: content, sendMediaAsDocument: Boolean(req.body.sendMediaAsDocument) })
    } else {
      if (!content) return res.status(400).json({ error: 'content or media is required' })
      sent = await req.whatsappSession.client.sendMessage(chatId, content, options)
    }
    res.json(await serializeMessage(req.whatsappSession, sent, false))
  } catch (error) { next(error) }
})
app.post('/sessions/:sessionId/messages/:messageId/reaction', requireSession, requireReady, async (req, res, next) => {
  try {
    await req.whatsappSession.client.sendReaction(req.params.messageId, String(req.body.reaction || ''))
    res.json({ ok: true })
  } catch (error) { next(error) }
})
app.put('/sessions/:sessionId/messages/:messageId', requireSession, requireReady, async (req, res, next) => {
  try {
    const content = String(req.body.content || '').trim()
    if (!content) return res.status(400).json({ error: 'content is required' })
    const message = await req.whatsappSession.client.getMessageById(req.params.messageId)
    if (!message) return res.status(404).json({ error: 'message not found' })
    const edited = await message.edit(content)
    if (!edited) return res.status(409).json({ error: 'message can no longer be edited' })
    res.json(await serializeMessage(req.whatsappSession, edited, false))
  } catch (error) { next(error) }
})
app.post('/sessions/:sessionId/chats/:chatId/action', requireSession, requireReady, async (req, res, next) => {
  try {
    const chat = await req.whatsappSession.client.getChatById(req.params.chatId)
    switch (req.body.action) {
      case 'seen': await chat.sendSeen(); invalidateChatList(req.whatsappSession); break
      case 'typing': await chat.sendStateTyping(); break
      case 'recording': await chat.sendStateRecording(); break
      case 'clear_state': await chat.clearState(); break
      case 'archive': await chat.archive(); break
      case 'unarchive': await chat.unarchive(); break
      case 'pin': await chat.pin(); break
      case 'unpin': await chat.unpin(); break
      case 'mute': await chat.mute(Number(req.body.until || -1)); break
      case 'unmute': await chat.unmute(); break
      default: return res.status(400).json({ error: 'unsupported chat action' })
    }
    res.json({ ok: true })
  } catch (error) { next(error) }
})
app.patch('/sessions/:sessionId/groups/:chatId', requireSession, requireReady, async (req, res, next) => {
  try {
    const chat = await req.whatsappSession.client.getChatById(req.params.chatId)
    if (!chat.isGroup) return res.status(400).json({ error: 'chat is not a group' })
    if (req.body.subject) await chat.setSubject(String(req.body.subject))
    if (req.body.description !== undefined) await chat.setDescription(String(req.body.description))
    res.json(await enrichChat(req.whatsappSession, chat))
  } catch (error) { next(error) }
})
app.post('/sessions/:sessionId/groups', requireSession, requireReady, async (req, res, next) => {
  try {
    const title = String(req.body.title || '').trim()
    const participants = Array.isArray(req.body.participants) ? req.body.participants.map(String) : []
    if (!title || participants.length === 0) return res.status(400).json({ error: 'title and participants are required' })
    res.json(await req.whatsappSession.client.createGroup(title, participants))
  } catch (error) { next(error) }
})
app.post('/sessions/:sessionId/groups/:chatId/participants', requireSession, requireReady, async (req, res, next) => {
  try {
    const chat = await req.whatsappSession.client.getChatById(req.params.chatId)
    if (!chat.isGroup) return res.status(400).json({ error: 'chat is not a group' })
    const participants = Array.isArray(req.body.participants) ? req.body.participants.map(String) : []
    let result
    switch (req.body.action) {
      case 'add': result = await chat.addParticipants(participants); break
      case 'remove': result = await chat.removeParticipants(participants); break
      case 'promote': result = await chat.promoteParticipants(participants); break
      case 'demote': result = await chat.demoteParticipants(participants); break
      default: return res.status(400).json({ error: 'unsupported participant action' })
    }
    res.json(result)
  } catch (error) { next(error) }
})

app.use((error, _req, res, _next) => {
  console.error(error)
  res.status(500).json({ error: readableError(error, 'WhatsApp Web 操作失败，请重新连接后重试') })
})

process.on('SIGTERM', async () => {
  await Promise.all(Array.from(sessions.values()).map((session) => destroyClient(session)))
  process.exit(0)
})

app.listen(PORT, () => console.log(`WhatsApp multi-account service listening on ${PORT}`))
