import { Index, Show, createEffect, createSignal, onCleanup, onMount } from 'solid-js'
import { useThrottleFn } from 'solidjs-use'
import { generateSignature } from '@/utils/auth'
import IconClear from './icons/Clear'
import MessageItem from './MessageItem'
import ErrorMessageItem from './ErrorMessageItem'
import type { ChatMessage, ErrorMessage } from '@/types'

export default () => {
  let inputRef: HTMLTextAreaElement
  const [messageList, setMessageList] = createSignal<ChatMessage[]>([])
  const [currentError, setCurrentError] = createSignal<ErrorMessage>()
  const [currentAssistantMessage, setCurrentAssistantMessage] = createSignal('')
  const [loading, setLoading] = createSignal(false)
  const [eventSource, setEventSource] = createSignal<EventSource | null>(null)
  const [isStick, setStick] = createSignal(false)
  const maxHistoryMessages = parseInt(import.meta.env.PUBLIC_MAX_HISTORY_MESSAGES || '99')

  createEffect(() => (isStick() && smoothToBottom()))

  onMount(() => {
    let lastPostion = window.scrollY

    window.addEventListener('scroll', () => {
      const nowPostion = window.scrollY
      nowPostion < lastPostion && setStick(false)
      lastPostion = nowPostion
    })

    try {
      if (sessionStorage.getItem('messageList'))
        setMessageList(JSON.parse(sessionStorage.getItem('messageList')))

      if (localStorage.getItem('stickToBottom') === 'stick')
        setStick(true)
    } catch (err) {
      console.error(err)
    }

    window.addEventListener('beforeunload', handleBeforeUnload)
    onCleanup(() => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
    })
  })

  const handleBeforeUnload = () => {
    sessionStorage.setItem('messageList', JSON.stringify(messageList()))
    isStick() ? localStorage.setItem('stickToBottom', 'stick') : localStorage.removeItem('stickToBottom')
  }

  const handleButtonClick = async() => {
    const inputValue = inputRef.value
    if (!inputValue)
      return

    inputRef.value = ''
    setMessageList([
      ...messageList(),
      {
        role: 'user',
        content: inputValue,
      },
    ])
    requestWithLatestMessage()
    instantToBottom()
  }

  const smoothToBottom = useThrottleFn(() => {
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' })
  }, 300, false, true)

  const instantToBottom = () => {
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' })
  }

  const requestWithLatestMessage = async() => {
    setLoading(true)
    setCurrentAssistantMessage('')
    setCurrentError(null)
    const storagePassword = localStorage.getItem('pass')
    const requestMessageList = messageList().map(message => ({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: message.content }],
    })).slice(-maxHistoryMessages)
    const timestamp = Date.now()

    try {
      const response = await fetch('/api/generate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messages: requestMessageList,
          time: timestamp,
          pass: storagePassword,
          sign: await generateSignature({
            t: timestamp,
            m: requestMessageList?.[requestMessageList.length - 1]?.parts[0]?.text || '',
          }),
        }),
      })

      if (!response.ok)
        throw new Error(`HTTP error! status: ${response.status}`)

      const { sessionId } = await response.json()

      const newEventSource = new EventSource(`/api/generate?sessionId=${sessionId}`)
      setEventSource(newEventSource)

      newEventSource.onmessage = (event) => {
        const data = JSON.parse(event.data)
        const text = data.message.candidates[0].content.parts.map(part => part.text).join('')
        setCurrentAssistantMessage(prev => prev + text)
        isStick() && instantToBottom()
      }

      newEventSource.onerror = (error) => {
        console.error('EventSource failed:', error)
        newEventSource.close()
        setLoading(false)
        setCurrentError({ message: 'A connection error occurred.' })
      }

      onCleanup(() => {
        if (newEventSource)
          newEventSource.close()
      })
    } catch (e) {
      console.error(e)
      setLoading(false)
      setCurrentError({ message: e.message })
    }
    archiveCurrentMessage()
    isStick() && instantToBottom()
  }

  const archiveCurrentMessage = () => {
    if (currentAssistantMessage()) {
      setMessageList([
        ...messageList(),
        {
          role: 'assistant',
          content: currentAssistantMessage(),
        },
      ])
      setCurrentAssistantMessage('')
      setLoading(false)
      setController(null)
      // Disable auto-focus on touch devices
      if (!('ontouchstart' in document.documentElement || navigator.maxTouchPoints > 0))
        inputRef.focus()
    }
  }

  const clear = () => {
    inputRef.value = ''
    inputRef.style.height = 'auto'
    setMessageList([])
    setCurrentAssistantMessage('')
    setCurrentError(null)
  }

  const stopStreamFetch = () => {
    const currentEventSource = eventSource()
    if (currentEventSource) {
      currentEventSource.close()
      setEventSource(null)
      archiveCurrentMessage()
    }
  }

  const retryLastFetch = () => {
    if (messageList().length > 0) {
      const lastMessage = messageList()[messageList().length - 1]
      if (lastMessage.role === 'assistant')
        setMessageList(messageList().slice(0, -1))
      requestWithLatestMessage()
    }
  }

  const handleKeydown = (e: KeyboardEvent) => {
    if (e.isComposing || e.shiftKey)
      return

    if (e.key === 'Enter') {
      e.preventDefault()
      handleButtonClick()
    }
  }

  return (
    <div my-6>
      <Index each={messageList()}>
        {(message, index) => (
          <MessageItem
            role={message().role}
            message={message().content}
            showRetry={() => (message().role === 'assistant' && index === messageList().length - 1)}
            onRetry={retryLastFetch}
          />
        )}
      </Index>
      {currentAssistantMessage() && (
        <MessageItem
          role="assistant"
          message={currentAssistantMessage}
        />
      )}
      {currentError() && <ErrorMessageItem data={currentError()} onRetry={retryLastFetch} />}
      <Show
        when={!loading()}
        fallback={() => (
          <div class="gen-cb-wrapper">
            <span>AI is thinking...</span>
            <div class="gen-cb-stop" onClick={stopStreamFetch}>Stop</div>
          </div>
        )}
      >
        <div class="gen-text-wrapper">
          <textarea
            ref={inputRef!}
            onKeyDown={handleKeydown}
            placeholder="Enter something..."
            autocomplete="off"
            autofocus
            onInput={() => {
              inputRef.style.height = 'auto'
              inputRef.style.height = `${inputRef.scrollHeight}px`
            }}
            rows="1"
            class="gen-textarea"
          />
          <button onClick={handleButtonClick} gen-slate-btn>
            Send
          </button>
          <button title="Clear" onClick={clear} gen-slate-btn>
            <IconClear />
          </button>
        </div>
      </Show>
      <div class="fixed bottom-5 left-5 rounded-md hover:bg-slate/10 w-fit h-fit transition-colors active:scale-90" class:stick-btn-on={isStick()}>
        <div>
          <button class="p-2.5 text-base" title="stick to bottom" type="button" onClick={() => setStick(!isStick())}>
            <div i-ph-arrow-line-down-bold />
          </button>
        </div>
      </div>
    </div>
  )
}
