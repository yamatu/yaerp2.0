import type { WhatsAppChat } from '@/types'

export function normalizeWhatsAppSearchText(value: unknown) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase('zh-CN').trim()
}

export function compactWhatsAppSearchText(value: unknown) {
  return normalizeWhatsAppSearchText(value)
    .replace(/@(c|g)\.us$/i, '')
    .replace(/[^\p{L}\p{N}]+/gu, '')
}

export function matchesWhatsAppSearch(values: unknown[], query: string) {
  const keyword = normalizeWhatsAppSearchText(query)
  if (!keyword) return true
  const terms = keyword.split(/\s+/).filter(Boolean)
  const searchable = values.map(normalizeWhatsAppSearchText).join(' ')
  const compactSearchable = values.map(compactWhatsAppSearchText).join(' ')
  return terms.every((term) => {
    const compactTerm = compactWhatsAppSearchText(term)
    return searchable.includes(term) || (compactTerm !== '' && compactSearchable.includes(compactTerm))
  })
}

export function matchesWhatsAppChat(chat: WhatsAppChat, query: string) {
  return matchesWhatsAppSearch([
    chat.name,
    chat.id,
    chat.description,
    chat.about,
    chat.lastMessage,
    ...(chat.searchAliases || []),
  ], query)
}
