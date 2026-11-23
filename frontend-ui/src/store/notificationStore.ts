// Notification store for real-time user notifications using Zustand
// Uses BroadcastChannel to share SSE connection across tabs (reduces HTTP connections)
import { create } from 'zustand'
import { apiClient } from '../services/ApiClient'
import { UserMessageType, type UserMessage, type UserNotificationEvent } from '../lib/api-types'
import { useToastStore } from './toastStore'

interface NotificationState {
  unreadCount: number
  messages: UserMessage[]
  isConnected: boolean
  isLoading: boolean
  error: string | null
}

interface NotificationActions {
  // Initialize SSE connection and fetch initial data
  initialize: () => void
  // Disconnect SSE
  disconnect: () => void
  // Fetch unread count (manual refresh)
  fetchUnreadCount: () => Promise<void>
  // Fetch messages (manual refresh)
  fetchMessages: (page?: number, limit?: number) => Promise<void>
  // Mark message as read
  markAsRead: (messageId: string) => Promise<void>
  // Delete message (calls API)
  deleteMessage: (messageId: string) => Promise<void>
  // Remove message from local state only (no API call)
  removeMessageFromState: (messageId: string) => void
  // Handle incoming SSE event
  handleEvent: (event: UserNotificationEvent) => void
  // Clear error
  clearError: () => void
}

// Store the cleanup function outside the store to prevent re-renders
let sseCleanup: (() => void) | null = null

// BroadcastChannel for cross-tab communication (share SSE connection)
const CHANNEL_NAME = 'stella-notifications'
let broadcastChannel: BroadcastChannel | null = null
let isLeaderTab = false
let leaderCheckTimeout: ReturnType<typeof setTimeout> | null = null

// Generate unique tab ID
const tabId = `tab-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`

// Helper function to become the SSE leader (creates actual SSE connection)
function becomeLeader(get: () => NotificationState & NotificationActions) {
  // Already a leader or already have SSE
  if (isLeaderTab || sseCleanup) {
    return
  }

  isLeaderTab = true
  console.log('[NotificationStore] Becoming SSE leader for notifications')

  // Set up SSE connection
  sseCleanup = apiClient.subscribeToUserNotifications(
    // On event - forward to other tabs
    (event) => {
      get().handleEvent(event)
      // Broadcast to other tabs
      if (broadcastChannel) {
        broadcastChannel.postMessage({ type: 'SSE_EVENT', data: event, senderId: tabId })
      }
    },
    // On error
    (error) => {
      console.error('[NotificationStore] SSE connection error:', error)
      // Attempt to reconnect after a delay
      setTimeout(() => {
        if (sseCleanup) {
          sseCleanup()
          sseCleanup = null
        }
        isLeaderTab = false
        becomeLeader(get)
      }, 5000)
    },
    // On open
    () => {
      console.log('[NotificationStore] SSE connection established (leader)')
    }
  )
}

export const useNotificationStore = create<NotificationState & NotificationActions>((set, get) => ({
  // Initial state
  unreadCount: 0,
  messages: [],
  isConnected: false,
  isLoading: false,
  error: null,

  // Actions
  initialize: () => {
    // Prevent multiple initializations
    if (broadcastChannel) {
      return
    }

    // Fetch initial data regardless of leader status
    get().fetchUnreadCount()

    // Set up BroadcastChannel for cross-tab communication
    try {
      broadcastChannel = new BroadcastChannel(CHANNEL_NAME)

      broadcastChannel.onmessage = (event) => {
        const { type, data, senderId } = event.data

        if (type === 'LEADER_PING') {
          // Another tab is checking for leader - respond if we're the leader
          if (isLeaderTab && sseCleanup) {
            broadcastChannel?.postMessage({ type: 'LEADER_PONG', senderId: tabId })
          }
        } else if (type === 'LEADER_PONG') {
          // A leader exists, we don't need to become one
          if (leaderCheckTimeout) {
            clearTimeout(leaderCheckTimeout)
            leaderCheckTimeout = null
          }
          isLeaderTab = false
          set({ isConnected: true }) // We're connected via the leader
        } else if (type === 'SSE_EVENT') {
          // Leader is forwarding an SSE event
          if (!isLeaderTab) {
            get().handleEvent(data)
          }
        } else if (type === 'LEADER_DISCONNECTED') {
          // Leader is closing, try to become the new leader
          if (!isLeaderTab) {
            becomeLeader(get)
          }
        }
      }

      // Check if a leader exists
      broadcastChannel.postMessage({ type: 'LEADER_PING', senderId: tabId })

      // Wait for response, become leader if no response
      leaderCheckTimeout = setTimeout(() => {
        becomeLeader(get)
      }, 200) // Wait 200ms for a leader response

    } catch (e) {
      // BroadcastChannel not supported, fall back to direct SSE
      console.warn('[NotificationStore] BroadcastChannel not supported, using direct SSE')
      becomeLeader(get)
    }
  },

  disconnect: () => {
    // If we're the leader, notify other tabs
    if (isLeaderTab && broadcastChannel) {
      broadcastChannel.postMessage({ type: 'LEADER_DISCONNECTED', senderId: tabId })
    }

    if (sseCleanup) {
      sseCleanup()
      sseCleanup = null
    }

    if (broadcastChannel) {
      broadcastChannel.close()
      broadcastChannel = null
    }

    if (leaderCheckTimeout) {
      clearTimeout(leaderCheckTimeout)
      leaderCheckTimeout = null
    }

    isLeaderTab = false
    set({ isConnected: false })
  },

  fetchUnreadCount: async () => {
    try {
      const response = await apiClient.getUnreadMessageCount()
      set({ unreadCount: response.count })
    } catch (error) {
      console.error('Failed to fetch unread count:', error)
    }
  },

  fetchMessages: async (page = 1, limit = 20) => {
    set({ isLoading: true, error: null })
    try {
      const response = await apiClient.getMessages({ page, limit })
      set({ messages: response.messages, isLoading: false })
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to fetch messages',
        isLoading: false,
      })
    }
  },

  markAsRead: async (messageId: string) => {
    try {
      await apiClient.markMessageAsRead(messageId)
      // Update local state
      set((state) => ({
        messages: state.messages.map((msg) =>
          msg.id === messageId ? { ...msg, read: true } : msg
        ),
        unreadCount: Math.max(0, state.unreadCount - 1),
      }))
    } catch (error) {
      console.error('Failed to mark message as read:', error)
    }
  },

  deleteMessage: async (messageId: string) => {
    try {
      await apiClient.deleteMessage(messageId)
      // Update local state
      set((state) => {
        const deletedMsg = state.messages.find((msg) => msg.id === messageId)
        return {
          messages: state.messages.filter((msg) => msg.id !== messageId),
          unreadCount: deletedMsg && !deletedMsg.read
            ? Math.max(0, state.unreadCount - 1)
            : state.unreadCount,
        }
      })
    } catch (error) {
      console.error('Failed to delete message:', error)
    }
  },

  removeMessageFromState: (messageId: string) => {
    // Remove message from local state without calling API
    // Used when backend already deletes the message (e.g., after accepting/declining invitation)
    set((state) => {
      const deletedMsg = state.messages.find((msg) => msg.id === messageId)
      return {
        messages: state.messages.filter((msg) => msg.id !== messageId),
        unreadCount: deletedMsg && !deletedMsg.read
          ? Math.max(0, state.unreadCount - 1)
          : state.unreadCount,
      }
    })
  },

  handleEvent: (event: UserNotificationEvent) => {
    switch (event.type) {
      case 'message.created':
        // Add new message to the list and update unread count
        if (event.message) {
          set((state) => ({
            messages: [event.message!, ...state.messages],
            unreadCount: event.unreadCount ?? state.unreadCount + 1,
          }))
          // A failed build deserves a toast wherever the user is, not just in
          // the inbox: this is the one message type nobody wants to miss.
          if (event.message.type === UserMessageType.AGENT_BUILD_FAILED) {
            useToastStore.getState().addToast({
              type: 'error',
              message: event.message.title,
              duration: 8000,
              ...(event.message.relatedEntityId && {
                link: { to: `/settings/agent-library?agent=${event.message.relatedEntityId}`, label: 'View build log' },
              }),
            })
          }
        }
        break

      case 'message.deleted':
        // This would need messageId in the event - for now just refresh
        get().fetchMessages()
        get().fetchUnreadCount()
        break

      case 'unread_count.changed':
        if (event.unreadCount !== undefined) {
          set({ unreadCount: event.unreadCount })
        }
        break
    }
  },

  clearError: () => set({ error: null }),
}))
