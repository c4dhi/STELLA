import { describe, expect, it, beforeEach } from 'vitest'
import { useNotificationStore } from './notificationStore'
import { useToastStore } from './toastStore'
import { UserMessageType, type UserMessage } from '../lib/api-types'

const buildFailedMessage: UserMessage = {
  id: 'msg1',
  type: UserMessageType.AGENT_BUILD_FAILED,
  title: 'Build failed: My Agent',
  body: 'Docker build failed: boom',
  read: false,
  createdAt: new Date().toISOString(),
  relatedEntityId: 'agent1',
  relatedEntityType: 'AgentType',
}

const invitationMessage: UserMessage = {
  id: 'msg2',
  type: UserMessageType.PROJECT_INVITATION,
  title: 'Invitation to collaborate on "Study"',
  body: 'Someone invited you.',
  read: false,
  createdAt: new Date().toISOString(),
  relatedEntityId: 'invite1',
  relatedEntityType: 'ProjectInvitation',
}

beforeEach(() => {
  useToastStore.setState({ toasts: [] })
  useNotificationStore.setState({ messages: [], unreadCount: 0 })
})

describe('notificationStore: a failed build also shows as a toast', () => {
  it('adds an error toast linking to the agent library for a build-failure message', () => {
    useNotificationStore.getState().handleEvent({
      type: 'message.created',
      userId: 'u1',
      message: buildFailedMessage,
      unreadCount: 1,
      timestamp: new Date().toISOString(),
    })

    const toasts = useToastStore.getState().toasts
    expect(toasts).toHaveLength(1)
    expect(toasts[0]).toMatchObject({
      type: 'error',
      message: 'Build failed: My Agent',
      link: { to: '/settings/agent-library?agent=agent1', label: 'View build log' },
    })
  })

  it('still adds the message to the inbox state', () => {
    useNotificationStore.getState().handleEvent({
      type: 'message.created',
      userId: 'u1',
      message: buildFailedMessage,
      unreadCount: 1,
      timestamp: new Date().toISOString(),
    })

    expect(useNotificationStore.getState().messages).toHaveLength(1)
    expect(useNotificationStore.getState().unreadCount).toBe(1)
  })

  it('does not toast for other message types, such as a project invitation', () => {
    useNotificationStore.getState().handleEvent({
      type: 'message.created',
      userId: 'u1',
      message: invitationMessage,
      unreadCount: 1,
      timestamp: new Date().toISOString(),
    })

    expect(useToastStore.getState().toasts).toHaveLength(0)
    expect(useNotificationStore.getState().messages).toHaveLength(1)
  })
})
