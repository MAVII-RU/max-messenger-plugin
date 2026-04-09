#!/usr/bin/env bun
/**
 * MAX Messenger channel plugin for Claude Code.
 *
 * MCP server that bridges MAX (VK) Bot API to Claude Code sessions.
 *
 * MAX API: https://dev.max.ru/docs-api
 * Base URL: https://platform-api.max.ru
 * Auth: Header Authorization: <token>
 * Rate limit: 30 rps
 *
 * Install:
 *   1. Copy this folder to ~/.claude/plugins/local/max-messenger/
 *   2. Create ~/.claude/channels/max/.env with MAX_BOT_TOKEN=your_token
 *   3. Create ~/.claude/channels/max/access.json (see below)
 *   4. Add to ~/.claude/settings.json: "mcpServers": { "max-messenger": ... }
 *   5. Start claude with --channels flag or add to MCP config
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import {
  readFileSync, writeFileSync, mkdirSync, statSync,
  chmodSync, realpathSync, existsSync,
} from 'fs'
import { homedir } from 'os'
import { join, sep } from 'path'

// ============ Config ============
const STATE_DIR = process.env.MAX_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'max')
const ACCESS_FILE = join(STATE_DIR, 'access.json')
const ENV_FILE = join(STATE_DIR, '.env')
const INBOX_DIR = join(STATE_DIR, 'inbox')

// Ensure directories exist
mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
mkdirSync(INBOX_DIR, { recursive: true, mode: 0o700 })

// Load .env into process.env (real env wins)
try {
  chmodSync(ENV_FILE, 0o600)
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch {}

const TOKEN = process.env.MAX_BOT_TOKEN
if (!TOKEN) {
  process.stderr.write(
    `max channel: MAX_BOT_TOKEN required\n` +
    `  set in ${ENV_FILE}\n` +
    `  format: MAX_BOT_TOKEN=your_token_here\n`,
  )
  process.exit(1)
}

const MAX_API = 'https://platform-api.max.ru'
const TEXT_CHUNK_LIMIT = 4000
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024

// Safety nets — keep polling alive on transient errors
process.on('unhandledRejection', err => {
  process.stderr.write(`max channel: unhandled rejection: ${err}\n`)
})
process.on('uncaughtException', err => {
  process.stderr.write(`max channel: uncaught exception: ${err}\n`)
})

// ============ Access control ============
type Access = {
  dmPolicy: 'open' | 'allowlist' | 'disabled'
  allowFrom: string[]
  groups: Record<string, { allowFrom: string[] }>
}

function defaultAccess(): Access {
  return { dmPolicy: 'open', allowFrom: [], groups: {} }
}

function loadAccess(): Access {
  try {
    const raw = readFileSync(ACCESS_FILE, 'utf8')
    const parsed = JSON.parse(raw) as Partial<Access>
    return {
      dmPolicy: parsed.dmPolicy ?? 'open',
      allowFrom: parsed.allowFrom ?? [],
      groups: parsed.groups ?? {},
    }
  } catch {
    return defaultAccess()
  }
}

function assertAllowedChat(chatId: string): void {
  const access = loadAccess()
  if (access.dmPolicy === 'open') return
  if (access.allowFrom.includes(chatId)) return
  if (chatId in access.groups) return
  throw new Error(`chat ${chatId} is not allowlisted — add to access.json`)
}

function isAllowedSender(senderId: string): boolean {
  const access = loadAccess()
  if (access.dmPolicy === 'disabled') return false
  if (access.dmPolicy === 'open') return true
  return access.allowFrom.includes(senderId)
}

// Refuse to send the plugin's own state files (token, access config)
function assertSendable(f: string): void {
  let real: string, stateReal: string
  try {
    real = realpathSync(f)
    stateReal = realpathSync(STATE_DIR)
  } catch { return }
  const inbox = join(stateReal, 'inbox')
  if (real.startsWith(stateReal + sep) && !real.startsWith(inbox + sep)) {
    throw new Error(`refusing to send channel state: ${f}`)
  }
}

// ============ MAX API ============
async function maxApiCall(method: string, path: string, body?: any, timeout: number = 60000): Promise<any> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)

  try {
    const opts: RequestInit = {
      method,
      headers: {
        'Authorization': TOKEN!,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    }
    if (body) opts.body = JSON.stringify(body)

    const res = await fetch(`${MAX_API}${path}`, opts)
    const text = await res.text()
    try {
      return JSON.parse(text)
    } catch {
      return { raw: text, status: res.status }
    }
  } finally {
    clearTimeout(timer)
  }
}

async function sendMessage(chatId: string, text: string, replyTo?: string): Promise<any> {
  const body: any = { text, format: 'markdown' }
  if (replyTo) body.link = { type: 'reply', mid: replyTo }
  return maxApiCall('POST', `/messages?chat_id=${chatId}`, body)
}

async function editMessage(messageId: string, text: string): Promise<any> {
  return maxApiCall('PUT', `/messages?message_id=${messageId}`, { text })
}

// Split long text at paragraph/line/space boundaries
function chunkText(text: string, limit: number = TEXT_CHUNK_LIMIT): string[] {
  if (text.length <= limit) return [text]
  const chunks: string[] = []
  let rest = text
  while (rest.length > 0) {
    if (rest.length <= limit) { chunks.push(rest); break }
    const para = rest.lastIndexOf('\n\n', limit)
    const line = rest.lastIndexOf('\n', limit)
    const space = rest.lastIndexOf(' ', limit)
    const cut = para > limit / 2 ? para
      : line > limit / 2 ? line
      : space > 0 ? space
      : limit
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  return chunks
}

// ============ MCP Server ============
const mcp = new Server(
  { name: 'max-messenger', version: '1.0.0' },
  {
    capabilities: {
      tools: {},
      experimental: {
        'claude/channel': {},
      },
    },
    instructions: [
      'The sender reads MAX Messenger, not this session. Anything you want them to see must go through the reply tool — your transcript output never reaches their chat.',
      '',
      'Messages from MAX arrive as <channel source="max-messenger" chat_id="..." message_id="..." user="..." user_id="..." ts="...">.',
      'Reply with the reply tool — pass chat_id back. Use reply_to (set to a message_id) only when quoting an earlier message.',
      '',
      'reply accepts text up to 4000 chars per message (auto-chunked if longer).',
      'Use edit_message for interim progress updates — edits don\'t push-notify.',
      'When a long task completes, send a new reply so the user\'s device pings.',
      '',
      "MAX Bot API exposes no history or search — you only see messages as they arrive.",
      "If you need earlier context, ask the user to paste or summarize.",
    ].join('\n'),
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description:
        'Reply in MAX Messenger. Pass chat_id from the inbound message. Text is auto-chunked at 4000 chars.',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string' },
          text: { type: 'string' },
          reply_to: {
            type: 'string',
            description: 'Message ID (mid) to reply to. Omit for a normal message.',
          },
        },
        required: ['chat_id', 'text'],
      },
    },
    {
      name: 'edit_message',
      description:
        'Edit a message the bot previously sent. Edits don\'t trigger push notifications — send a new reply when a long task completes.',
      inputSchema: {
        type: 'object',
        properties: {
          message_id: { type: 'string', description: 'The mid of the message to edit.' },
          text: { type: 'string' },
        },
        required: ['message_id', 'text'],
      },
    },
    {
      name: 'send_file',
      description:
        'Send a file to a MAX chat by uploading it. Pass an absolute file path. Max 50MB.',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string' },
          file_path: {
            type: 'string',
            description: 'Absolute path to the file to send.',
          },
          caption: {
            type: 'string',
            description: 'Optional text caption to accompany the file.',
          },
        },
        required: ['chat_id', 'file_path'],
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>
  try {
    switch (req.params.name) {
      case 'reply': {
        const chat_id = args.chat_id as string
        const text = args.text as string
        const reply_to = args.reply_to as string | undefined
        assertAllowedChat(chat_id)

        const chunks = chunkText(text)
        const sentIds: string[] = []

        for (let i = 0; i < chunks.length; i++) {
          const r = await sendMessage(chat_id, chunks[i], i === 0 ? reply_to : undefined)
          const mid = r?.message?.body?.mid || ''
          if (mid) sentIds.push(mid)
        }

        const result = sentIds.length === 1
          ? `sent (id: ${sentIds[0]})`
          : `sent ${sentIds.length} parts (ids: ${sentIds.join(', ')})`
        return { content: [{ type: 'text', text: result }] }
      }

      case 'edit_message': {
        const message_id = args.message_id as string
        const text = args.text as string
        await editMessage(message_id, text)
        return { content: [{ type: 'text', text: `edited (id: ${message_id})` }] }
      }

      case 'send_file': {
        const chat_id = args.chat_id as string
        const file_path = args.file_path as string
        const caption = args.caption as string | undefined
        assertAllowedChat(chat_id)
        assertSendable(file_path)

        const st = statSync(file_path)
        if (st.size > MAX_ATTACHMENT_BYTES) {
          throw new Error(`file too large: ${file_path} (${(st.size / 1024 / 1024).toFixed(1)}MB, max 50MB)`)
        }

        const fileData = readFileSync(file_path)
        const fileName = file_path.split('/').pop() || 'file'

        // Step 1: Request upload URL from MAX
        const uploadRes = await maxApiCall('POST', `/uploads?type=file`)
        if (!uploadRes?.url) {
          throw new Error(`upload request failed: ${JSON.stringify(uploadRes)}`)
        }

        // Step 2: Upload file to the provided URL
        const formData = new FormData()
        formData.append('data', new Blob([fileData]), fileName)
        const uploadResponse = await fetch(uploadRes.url, {
          method: 'POST',
          body: formData,
        })

        if (!uploadResponse.ok) {
          throw new Error(`file upload failed: HTTP ${uploadResponse.status}`)
        }

        const uploadResult = await uploadResponse.json().catch(() => null)

        // Step 3: Send message with file attachment
        if (uploadResult?.token) {
          // Attach via token
          const body: any = {
            text: caption || '',
            attachments: [{ type: 'file', payload: { token: uploadResult.token } }],
          }
          await maxApiCall('POST', `/messages?chat_id=${chat_id}`, body)
        } else {
          // Fallback: send as text with file name
          await sendMessage(chat_id, caption ? `📎 ${caption} (${fileName})` : `📎 ${fileName}`)
        }

        return { content: [{ type: 'text', text: `file sent: ${fileName}` }] }
      }

      default:
        return {
          content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }],
          isError: true,
        }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      content: [{ type: 'text', text: `${req.params.name} failed: ${msg}` }],
      isError: true,
    }
  }
})

// ============ Connect MCP transport ============
await mcp.connect(new StdioServerTransport())

// ============ Polling ============
let botUserId = 0
let botName = ''
let pollingMarker: number | null = null
let shuttingDown = false

async function startPolling(): Promise<void> {
  // Identify the bot
  try {
    const me = await maxApiCall('GET', '/me')
    if (!me?.user_id) {
      process.stderr.write(`max channel: /me returned unexpected data: ${JSON.stringify(me)}\n`)
      return
    }
    botUserId = me.user_id
    botName = me.name || 'MAX Bot'
    process.stderr.write(`max channel: polling as ${botName} (id: ${botUserId})\n`)
  } catch (e) {
    process.stderr.write(`max channel: /me failed — check token: ${e}\n`)
    return
  }

  // Long-poll loop
  const poll = async () => {
    if (shuttingDown) return

    try {
      let path = '/updates?timeout=25&types=message_created'
      if (pollingMarker) path += `&marker=${pollingMarker}`
      const result = await maxApiCall('GET', path, undefined, 35000)

      if (result.marker) pollingMarker = result.marker

      for (const update of result.updates || []) {
        if (update.update_type !== 'message_created') continue
        const msg = update.message
        if (!msg) continue
        // Skip our own messages
        if (msg.sender?.user_id === botUserId) continue

        const senderId = String(msg.sender?.user_id || '')
        const chatId = String(msg.recipient?.chat_id || '')
        const senderName = msg.sender?.name || 'Unknown'
        const text = msg.body?.text || ''
        const messageId = String(msg.body?.mid || '')
        const timestamp = update.timestamp || Math.floor(Date.now() / 1000)

        // Access check
        if (!isAllowedSender(senderId)) {
          process.stderr.write(`max channel: dropped message from non-allowed sender ${senderId}\n`)
          continue
        }

        process.stderr.write(`max channel: << ${senderName} (${senderId}): ${text.substring(0, 80)}\n`)

        // Typing indicator (fire-and-forget)
        maxApiCall('POST', `/chats/${chatId}/actions`, { action: 'typing_on' }).catch(() => {})

        // Deliver to Claude Code session
        mcp.notification({
          method: 'notifications/claude/channel',
          params: {
            content: text || '(empty message)',
            meta: {
              chat_id: chatId,
              message_id: messageId,
              user: senderName,
              user_id: senderId,
              ts: new Date(timestamp * 1000).toISOString(),
            },
          },
        }).catch(err => {
          process.stderr.write(`max channel: failed to deliver to Claude: ${err}\n`)
        })
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      // AbortError is normal for timeout — don't log as error
      if (!msg.includes('abort')) {
        process.stderr.write(`max channel: poll error: ${msg}\n`)
      }
      await new Promise(r => setTimeout(r, 3000))
    }

    if (!shuttingDown) setTimeout(poll, 100)
  }

  poll()
}

// ============ Graceful shutdown ============
function shutdown(): void {
  if (shuttingDown) return
  shuttingDown = true
  process.stderr.write('max channel: shutting down\n')
  setTimeout(() => process.exit(0), 2000)
}
process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

// Start polling
startPolling().catch(err => {
  process.stderr.write(`max channel: polling start failed: ${err}\n`)
})
