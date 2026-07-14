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

let client = null
let localProxyUrl = ''
let configuration = { enabled: false, proxyUrl: '' }
let operation = Promise.resolve()
const state = {
  status: 'disabled',
  qr: '',
  qrDataUrl: '',
  loadingPercent: 0,
  loadingMessage: '',
  account: null,
  lastError: '',
  updatedAt: new Date().toISOString(),
}

function updateState(patch) {
  Object.assign(state, patch, { updatedAt: new Date().toISOString() })
}

function requireInternalSecret(req, res, next) {
  if (!INTERNAL_SECRET || req.header('x-whatsapp-secret') !== INTERNAL_SECRET) {
    return res.status(401).json({ error: 'unauthorized' })
  }
  next()
}

async function postWebhook(type, payload = {}) {
  if (!WEBHOOK_URL || !INTERNAL_SECRET) return
  try {
    const response = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-whatsapp-secret': INTERNAL_SECRET,
      },
      body: JSON.stringify({ type, payload, occurredAt: new Date().toISOString() }),
      signal: AbortSignal.timeout(20000),
    })
    if (!response.ok) {
      console.error(`WhatsApp webhook failed: ${response.status} ${await response.text()}`)
    }
  } catch (error) {
    console.error('WhatsApp webhook error:', error.message)
  }
}

function serializeId(value) {
  if (!value) return ''
  if (typeof value === 'string') return value
  return value._serialized || ''
}

async function serializeMessage(message, includeMedia = false) {
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
    quotedMessageId: serializeId(message._data?.quotedStanzaID),
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
  } catch {
    payload.senderName = payload.author || payload.from
  }
  return payload
}

async function closeLocalProxy() {
  if (!localProxyUrl) return
  try {
    await proxyChain.closeAnonymizedProxy(localProxyUrl, true)
  } catch (error) {
    console.error('Failed to close local proxy:', error.message)
  } finally {
    localProxyUrl = ''
  }
}

async function destroyClient() {
  const active = client
  client = null
  if (active) {
    try {
      await active.destroy()
    } catch (error) {
      console.error('Failed to destroy WhatsApp client:', error.message)
    }
  }
  await closeLocalProxy()
}

async function clearStaleProfileLocks() {
  const profileDir = path.join(DATA_DIR, 'auth', 'session-yaerp')
  await Promise.all(['SingletonLock', 'SingletonCookie', 'SingletonSocket'].map(async (name) => {
    try {
      await fs.rm(path.join(profileDir, name), { force: true })
    } catch (error) {
      console.error(`Failed to remove stale Chromium ${name}:`, error.message)
    }
  }))
}

async function prepareProxy(proxyUrl) {
  await closeLocalProxy()
  if (!proxyUrl) return ''
  localProxyUrl = await proxyChain.anonymizeProxy(proxyUrl)
  return localProxyUrl
}

function bindClientEvents(nextClient) {
  nextClient.on('loading_screen', (percent, message) => {
    updateState({ status: 'loading', loadingPercent: Number(percent || 0), loadingMessage: message || '' })
    void postWebhook('status', { ...state, qr: undefined, qrDataUrl: undefined })
  })
  nextClient.on('qr', async (qr) => {
    const qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 360 })
    updateState({ status: 'qr', qr, qrDataUrl, lastError: '' })
    void postWebhook('status', { ...state, qr: undefined })
  })
  nextClient.on('authenticated', () => {
    updateState({ status: 'authenticated', qr: '', qrDataUrl: '', lastError: '' })
    void postWebhook('status', { ...state })
  })
  nextClient.on('auth_failure', (message) => {
    updateState({ status: 'auth_failure', lastError: String(message || 'authentication failed') })
    void postWebhook('status', { ...state })
  })
  nextClient.on('ready', () => {
    const info = nextClient.info
    updateState({
      status: 'ready',
      qr: '',
      qrDataUrl: '',
      loadingPercent: 100,
      loadingMessage: '',
      lastError: '',
      account: info ? {
        wid: serializeId(info.wid),
        pushname: info.pushname || '',
        platform: info.platform || '',
      } : null,
    })
    void postWebhook('status', { ...state })
  })
  nextClient.on('change_state', (sessionState) => {
    void postWebhook('session_state', { state: sessionState })
  })
  nextClient.on('disconnected', (reason) => {
    updateState({ status: 'disconnected', account: null, lastError: String(reason || '') })
    void postWebhook('status', { ...state })
  })
  nextClient.on('message', async (message) => {
    void postWebhook('message', await serializeMessage(message, true))
  })
  nextClient.on('message_create', async (message) => {
    if (message.fromMe) void postWebhook('message_create', await serializeMessage(message, false))
  })
  nextClient.on('message_ack', (message, ack) => {
    void postWebhook('message_ack', { id: serializeId(message.id), ack })
  })
  nextClient.on('message_revoke_everyone', (after, before) => {
    void postWebhook('message_revoke', {
      id: serializeId(after?.id),
      beforeId: serializeId(before?.id),
      chatId: after?.from || before?.from || '',
    })
  })
}

async function startClient() {
  if (!configuration.enabled) {
    updateState({ status: 'disabled', qr: '', qrDataUrl: '', account: null })
    return state
  }
  await destroyClient()
  await clearStaleProfileLocks()
  updateState({ status: 'initializing', qr: '', qrDataUrl: '', loadingPercent: 0, loadingMessage: '', lastError: '' })
  const proxyUrl = await prepareProxy(configuration.proxyUrl)
  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
  ]
  if (proxyUrl) args.push(`--proxy-server=${proxyUrl}`)

  const nextClient = new Client({
    authStrategy: new LocalAuth({ clientId: 'yaerp', dataPath: `${DATA_DIR}/auth` }),
    puppeteer: {
      headless: true,
      executablePath: CHROMIUM_PATH,
      args,
    },
  })
  client = nextClient
  bindClientEvents(nextClient)
  nextClient.initialize().catch((error) => {
    updateState({ status: 'error', lastError: error.message })
    void postWebhook('status', { ...state })
  })
  return state
}

function queueOperation(task) {
  operation = operation.then(task, task)
  return operation
}

function requireReady(req, res, next) {
  if (!client || state.status !== 'ready') return res.status(409).json({ error: 'WhatsApp is not ready' })
  next()
}

function serializeChat(chat) {
  return {
    id: serializeId(chat.id),
    name: chat.name || chat.formattedTitle || serializeId(chat.id),
    isGroup: Boolean(chat.isGroup),
    unreadCount: chat.unreadCount || 0,
    timestamp: chat.timestamp || 0,
    pinned: Boolean(chat.pinned),
    archived: Boolean(chat.archived),
    isMuted: Boolean(chat.isMuted),
  }
}

app.get('/health', (_req, res) => res.json({ ok: true, status: state.status }))
app.use(requireInternalSecret)

app.get('/status', (_req, res) => res.json({ ...state, qr: undefined }))
app.post('/configure', async (req, res, next) => {
  try {
    configuration = {
      enabled: Boolean(req.body.enabled),
      proxyUrl: String(req.body.proxyUrl || '').trim(),
    }
    if (!configuration.enabled) await queueOperation(destroyClient)
    res.json({ ok: true, configuration: { enabled: configuration.enabled, proxyConfigured: Boolean(configuration.proxyUrl) } })
  } catch (error) {
    next(error)
  }
})
app.post('/session/start', async (_req, res, next) => {
  try {
    res.json(await queueOperation(startClient))
  } catch (error) {
    updateState({ status: 'error', lastError: error.message })
    next(error)
  }
})
app.post('/session/restart', async (_req, res, next) => {
  try {
    res.json(await queueOperation(startClient))
  } catch (error) {
    updateState({ status: 'error', lastError: error.message })
    next(error)
  }
})
app.post('/session/logout', async (_req, res, next) => {
  try {
    await queueOperation(async () => {
      if (client) {
        try { await client.logout() } catch (error) { console.error('WhatsApp logout failed:', error.message) }
      }
      await destroyClient()
      updateState({ status: configuration.enabled ? 'disconnected' : 'disabled', qr: '', qrDataUrl: '', account: null, lastError: '' })
    })
    res.json(state)
  } catch (error) {
    next(error)
  }
})
app.get('/qr', (_req, res) => res.json({ status: state.status, qrDataUrl: state.qrDataUrl, updatedAt: state.updatedAt }))

app.get('/chats', requireReady, async (_req, res, next) => {
  try {
    const chats = await client.getChats()
    res.json(chats.map(serializeChat).sort((a, b) => b.timestamp - a.timestamp))
  } catch (error) { next(error) }
})
app.get('/contacts', requireReady, async (_req, res, next) => {
  try {
    const contacts = await client.getContacts()
    res.json(contacts.filter((contact) => contact.isWAContact).map((contact) => ({
      id: serializeId(contact.id),
      number: contact.number || '',
      name: contact.name || contact.pushname || contact.shortName || contact.number || '',
      isBusiness: Boolean(contact.isBusiness),
      isMyContact: Boolean(contact.isMyContact),
    })))
  } catch (error) { next(error) }
})
app.get('/chats/:chatId/messages', requireReady, async (req, res, next) => {
  try {
    const chat = await client.getChatById(req.params.chatId)
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)))
    const messages = await chat.fetchMessages({ limit })
    res.json(await Promise.all(messages.map((message) => serializeMessage(message, false))))
  } catch (error) { next(error) }
})

app.post('/messages/send', requireReady, async (req, res, next) => {
  try {
    const chatId = String(req.body.chatId || '').trim()
    if (!chatId) return res.status(400).json({ error: 'chatId is required' })
    const content = String(req.body.content || '')
    const options = {}
    if (req.body.quotedMessageId) options.quotedMessageId = String(req.body.quotedMessageId)
    let sent
    if (req.body.media?.data) {
      const media = new MessageMedia(
        req.body.media.mimetype || 'application/octet-stream',
        req.body.media.data,
        req.body.media.filename || 'attachment'
      )
      sent = await client.sendMessage(chatId, media, { ...options, caption: content, sendMediaAsDocument: Boolean(req.body.sendMediaAsDocument) })
    } else {
      if (!content) return res.status(400).json({ error: 'content or media is required' })
      sent = await client.sendMessage(chatId, content, options)
    }
    res.json(await serializeMessage(sent, false))
  } catch (error) { next(error) }
})
app.post('/messages/:messageId/reaction', requireReady, async (req, res, next) => {
  try {
    const message = await client.getMessageById(req.params.messageId)
    if (!message) return res.status(404).json({ error: 'message not found' })
    await message.react(String(req.body.reaction || ''))
    res.json({ ok: true })
  } catch (error) { next(error) }
})

app.post('/chats/:chatId/action', requireReady, async (req, res, next) => {
  try {
    const chat = await client.getChatById(req.params.chatId)
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
app.patch('/groups/:chatId', requireReady, async (req, res, next) => {
  try {
    const chat = await client.getChatById(req.params.chatId)
    if (!chat.isGroup) return res.status(400).json({ error: 'chat is not a group' })
    if (req.body.subject) await chat.setSubject(String(req.body.subject))
    if (req.body.description !== undefined) await chat.setDescription(String(req.body.description))
    res.json(serializeChat(chat))
  } catch (error) { next(error) }
})
app.post('/groups', requireReady, async (req, res, next) => {
  try {
    const title = String(req.body.title || '').trim()
    const participants = Array.isArray(req.body.participants) ? req.body.participants.map(String) : []
    if (!title || participants.length === 0) return res.status(400).json({ error: 'title and participants are required' })
    res.json(await client.createGroup(title, participants))
  } catch (error) { next(error) }
})
app.post('/groups/:chatId/participants', requireReady, async (req, res, next) => {
  try {
    const chat = await client.getChatById(req.params.chatId)
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
app.delete('/groups/:chatId/leave', requireReady, async (req, res, next) => {
  try {
    const chat = await client.getChatById(req.params.chatId)
    if (!chat.isGroup) return res.status(400).json({ error: 'chat is not a group' })
    await chat.leave()
    res.json({ ok: true })
  } catch (error) { next(error) }
})

app.use((error, _req, res, _next) => {
  console.error(error)
  res.status(500).json({ error: error.message || 'internal error' })
})

process.on('SIGTERM', async () => {
  await destroyClient()
  process.exit(0)
})

app.listen(PORT, () => console.log(`WhatsApp service listening on ${PORT}`))
