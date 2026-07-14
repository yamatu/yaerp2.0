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
      localProxyUrl: '',
      operation: Promise.resolve(),
      state: createState(),
    })
  }
  return sessions.get(id)
}

function updateState(session, patch) {
  Object.assign(session.state, patch, { updatedAt: new Date().toISOString() })
}

function queueOperation(session, task) {
  session.operation = session.operation.then(task, task)
  return session.operation
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

async function serializeMessage(session, message, includeMedia = false) {
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
  try {
    const contact = await message.getContact()
    payload.senderName = contact.pushname || contact.name || contact.shortName || contact.number || payload.author || payload.from
    payload.senderNumber = contact.number || ''
    payload.senderProfilePicUrl = await safeProfilePic(session.client, serializeId(contact.id))
  } catch {
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
    await proxyChain.closeAnonymizedProxy(session.localProxyUrl, true)
  } catch (error) {
    console.error(`Failed to close proxy (${session.id}):`, error.message)
  } finally {
    session.localProxyUrl = ''
  }
}

async function destroyClient(session) {
  const active = session.client
  session.client = null
  if (active) {
    try { await active.destroy() } catch (error) { console.error(`Destroy failed (${session.id}):`, error.message) }
  }
  await closeLocalProxy(session)
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
    updateState(session, { status: 'auth_failure', lastError: String(message || 'authentication failed') })
    void postWebhook(session, 'status', { ...session.state })
  })
  client.on('ready', async () => {
    if (!active()) return
    updateState(session, {
      status: 'ready', qr: '', qrDataUrl: '', loadingPercent: 100, loadingMessage: '', lastError: '',
      account: await accountSnapshot(session, client),
    })
    void postWebhook(session, 'status', { ...session.state })
  })
  client.on('change_state', (state) => active() && void postWebhook(session, 'session_state', { state }))
  client.on('disconnected', (reason) => {
    if (!active()) return
    updateState(session, { status: 'disconnected', account: null, lastError: String(reason || '') })
    void postWebhook(session, 'status', { ...session.state })
  })
  client.on('message', async (message) => active() && void postWebhook(session, 'message', await serializeMessage(session, message, true)))
  client.on('message_create', async (message) => {
    if (active() && message.fromMe) void postWebhook(session, 'message_create', await serializeMessage(session, message, false))
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
  client.initialize().catch((error) => {
    if (session.client !== client) return
    updateState(session, { status: 'error', lastError: error.message })
    void postWebhook(session, 'status', { ...session.state })
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
app.get('/sessions/:sessionId/status', requireSession, (req, res) => res.json({ ...req.whatsappSession.state, qr: undefined }))
app.post('/sessions/:sessionId/start', requireSession, async (req, res, next) => {
  try { res.json(await queueOperation(req.whatsappSession, () => startSession(req.whatsappSession))) } catch (error) { next(error) }
})
app.post('/sessions/:sessionId/restart', requireSession, async (req, res, next) => {
  try { res.json(await queueOperation(req.whatsappSession, () => startSession(req.whatsappSession))) } catch (error) { next(error) }
})
app.post('/sessions/:sessionId/logout', requireSession, async (req, res, next) => {
  const session = req.whatsappSession
  try {
    await queueOperation(session, async () => {
      if (session.client) {
        try { await session.client.logout() } catch (error) { console.error(`Logout failed (${session.id}):`, error.message) }
      }
      await destroyClient(session)
      updateState(session, { status: 'disconnected', qr: '', qrDataUrl: '', account: null, lastError: '' })
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
    const chats = await req.whatsappSession.client.getChats()
    const limit = Math.min(500, Math.max(1, Number(req.query.limit || 200)))
    const selected = chats.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)).slice(0, limit)
    res.json(await mapWithConcurrency(selected, 8, (chat) => enrichChat(req.whatsappSession, chat)))
  } catch (error) { next(error) }
})
app.get('/sessions/:sessionId/contacts', requireSession, requireReady, async (req, res, next) => {
  try {
    const contacts = (await req.whatsappSession.client.getContacts()).filter((contact) => contact.isWAContact)
    res.json(await mapWithConcurrency(contacts, 8, async (contact) => ({
      id: serializeId(contact.id), number: contact.number || '',
      name: contact.name || contact.pushname || contact.shortName || contact.number || '',
      isBusiness: Boolean(contact.isBusiness), isMyContact: Boolean(contact.isMyContact),
      profilePicUrl: await safeProfilePic(req.whatsappSession.client, serializeId(contact.id)),
    })))
  } catch (error) { next(error) }
})
app.get('/sessions/:sessionId/chats/:chatId/messages', requireSession, requireReady, async (req, res, next) => {
  try {
    const chat = await req.whatsappSession.client.getChatById(req.params.chatId)
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)))
    res.json(await Promise.all((await chat.fetchMessages({ limit })).map((message) => serializeMessage(req.whatsappSession, message, false))))
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
      case 'seen': await chat.sendSeen(); break
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
  res.status(500).json({ error: error.message || 'internal error' })
})

process.on('SIGTERM', async () => {
  await Promise.all(Array.from(sessions.values()).map((session) => destroyClient(session)))
  process.exit(0)
})

app.listen(PORT, () => console.log(`WhatsApp multi-account service listening on ${PORT}`))
