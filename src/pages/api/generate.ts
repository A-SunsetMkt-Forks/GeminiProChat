import { startChatAndSendMessageStream } from '@/utils/openAI'
import { verifySignature } from '@/utils/auth'
import type { APIRoute } from 'astro'

const sitePassword = import.meta.env.SITE_PASSWORD || ''
const passList = sitePassword.split(',') || []

// 假设我们有一个简单的内存存储来保存会话数据
const sessions = new Map()

// 生成唯一会话ID
function createUniqueSessionId() {
  return crypto.randomUUID()
}

// 存储会话数据
function storeSessionData(sessionId, history, newMessage) {
  sessions.set(sessionId, { history, newMessage })
}

// 检查会话ID是否有效
function isValidSessionId(sessionId) {
  return sessions.has(sessionId)
}

// 获取会话数据
function getSessionData(sessionId) {
  return sessions.get(sessionId)
}

export const post: APIRoute = async(context) => {
  const body = await context.request.json()
  const { sign, time, messages, pass } = body

  if (!messages || messages.length === 0 || messages[messages.length - 1].role !== 'user') {
    return new Response(JSON.stringify({
      error: {
        message: 'Invalid message history: The last message must be from user role.',
      },
    }), { status: 400 })
  }

  if (sitePassword && !(sitePassword === pass || passList.includes(pass))) {
    return new Response(JSON.stringify({
      error: {
        message: 'Invalid password.',
      },
    }), { status: 401 })
  }

  if (import.meta.env.PROD && !await verifySignature({ t: time, m: messages[messages.length - 1].parts.map(part => part.text).join('') }, sign)) {
    return new Response(JSON.stringify({
      error: {
        message: 'Invalid signature.',
      },
    }), { status: 401 })
  }

  const sessionId = createUniqueSessionId()
  const history = messages.slice(0, -1) // All messages except the last one
  const newMessage = messages[messages.length - 1].parts.map(part => part.text).join('')
  storeSessionData(sessionId, history, newMessage)

  return new Response(JSON.stringify({ sessionId }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

export const get: APIRoute = async(context) => {
  const { searchParams } = new URL(context.request.url)
  const sessionId = searchParams.get('sessionId')

  if (!sessionId || !isValidSessionId(sessionId)) {
    return new Response(JSON.stringify({
      error: {
        message: 'Invalid session ID.',
      },
    }), { status: 400 })
  }

  const { history, newMessage } = getSessionData(sessionId)

  try {
    // Start chat and send message with streaming
    const stream = await startChatAndSendMessageStream(history, newMessage)

    const responseStream = new ReadableStream({
      async start(controller) {
        for await (const chunk of stream) {
          const text = `data: ${JSON.stringify({ message: chunk })}\n\n`
          const queue = new TextEncoder().encode(text)
          controller.enqueue(queue)
        }
        controller.close()
        sessions.delete(sessionId) // 清理会话数据
      },
    })

    return new Response(responseStream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    })
  } catch (error) {
    console.error(error)
    sessions.delete(sessionId) // 发生错误时清理会话数据
    return new Response(JSON.stringify({
      error: {
        code: error.name,
      },
    }), { status: 500 })
  }
}
