import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  AgentReviewCard,
  canConfirm,
  decisionsFor,
  declarationsOf,
  formatPackageSize,
} from './AgentReviewSection'
import type { AgentReviewDetail, AgentReviewItem, DeployRequirements } from '../../lib/api-types'
import { AgentValidationStatus } from '../../lib/api-types'

const requirements: DeployRequirements = {
  persona: true,
  plans: { required: false, modes: ['plan', 'companion'] },
  configurator: null,
  env: {
    required: ['OPENAI_API_KEY'],
    optional: [{ name: 'TTS_SPEED' }, { name: 'STELLA_LANGUAGE' }],
  },
  connectors: [
    { slot: 'questions', kind: 'mcp', required: true, label: 'Interview questions', requiredTools: [] },
  ],
  configSchema: null,
  defaultConfig: {},
  sdkMinVersion: '0.9.0',
}

const pending: AgentReviewItem = {
  lastBuild: {
    id: 'b1',
    status: 'failed',
    imageName: null,
    errorMessage: 'pip install failed',
    startedAt: '2026-11-01T10:05:00Z',
    completedAt: null,
  },
  id: 'at1',
  slug: 'my-agent',
  name: 'My agent',
  description: 'Asks about your day',
  icon: '🤖',
  version: '1.2.0',
  authorName: 'Ada',
  authorEmail: 'ada@x.test',
  resourceGpu: true,
  packageSize: 2_500_000,
  validationStatus: AgentValidationStatus.PENDING,
  validationNotes: null,
  validatedAt: null,
  createdAt: '2026-11-01T10:00:00Z',
  sdkVersion: '0.10.0',
  capabilities: ['voice', 'plans'],
  requirements,
  manifestError: null,
  owner: { id: 'u1', email: 'owner@x.test', name: 'Olga' },
}

const noop = () => {}
const render = (over: Partial<Parameters<typeof AgentReviewCard>[0]> = {}) =>
  renderToStaticMarkup(
    <AgentReviewCard
      agent={pending}
      isDark={false}
      expanded={false}
      detail={null}
      decision={null}
      text=""
      busy={false}
      onToggleDetails={noop}
      onStart={noop}
      onText={noop}
      onConfirm={noop}
      onCancel={noop}
      {...over}
    />,
  )

describe('decisionsFor', () => {
  it('offers both for a pending upload, and the other way round once reviewed', () => {
    expect(decisionsFor(AgentValidationStatus.PENDING)).toEqual(['approve', 'reject'])
    expect(decisionsFor(AgentValidationStatus.APPROVED)).toEqual(['reject'])
    expect(decisionsFor(AgentValidationStatus.REJECTED)).toEqual(['approve'])
  })
})

describe('canConfirm', () => {
  it('needs a reason to reject, but no notes to approve', () => {
    expect(canConfirm('reject', '   ')).toBe(false)
    expect(canConfirm('reject', 'Opens a shell')).toBe(true)
    expect(canConfirm('approve', '')).toBe(true)
  })
})

describe('formatPackageSize', () => {
  it('reads bytes as KB or MB, and nothing when unknown', () => {
    expect(formatPackageSize(2_500_000)).toBe('2.4 MB')
    expect(formatPackageSize(12_000)).toBe('12 KB')
    expect(formatPackageSize(null)).toBeNull()
  })
})

describe('declarationsOf', () => {
  it('reads what the manifest asks of a deployment, in plain words', () => {
    expect(declarationsOf(requirements)).toEqual([
      ['Keys it needs', 'OPENAI_API_KEY'],
      ['Settings', '2 optional'],
      ['Connectors', 'Interview questions (required)'],
      ['Persona', 'Yes'],
      ['Plans', 'plan or companion, optional'],
    ])
  })

  it('leaves out what the manifest does not declare', () => {
    const bare: DeployRequirements = {
      ...requirements,
      persona: false,
      plans: null,
      env: { required: [], optional: [] },
      connectors: [],
    }
    expect(declarationsOf(bare)).toEqual([])
  })
})

describe('AgentReviewCard', () => {
  it('leads with the build status, then who uploaded what', () => {
    const html = render()
    expect(html.indexOf('Build failed')).toBeLessThan(html.indexOf('My agent'))
    expect(html).toContain('pip install failed')
    expect(html).toContain('v1.2.0')
    expect(html).toContain('my-agent')
    expect(html).toContain('Olga')
    expect(html).toContain('owner@x.test')
    expect(html).toContain('SDK 0.10.0')
    expect(html).toContain('Needs GPU')
    expect(html).toContain('2.4 MB')
    expect(html).toContain('OPENAI_API_KEY')
    expect(html).toContain('Interview questions (required)')
    expect(html).toContain('>Approve<')
    expect(html).toContain('>Reject<')
  })

  it('says so when it never built, or the manifest cannot be read', () => {
    const html = render({
      agent: { ...pending, lastBuild: null, requirements: null, manifestError: 'metadata: expected object' },
    })
    expect(html).toContain('Not built yet')
    expect(html).toContain('metadata: expected object')
  })

  it('asks for a reason before rejecting, and keeps Confirm off while it is blank', () => {
    const html = render({ decision: 'reject', text: '' })
    expect(html).toContain('Reason, shown to the uploader (required)')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Reject agent<\/button>/)
  })

  it('takes optional notes when approving', () => {
    const html = render({ decision: 'approve', text: '' })
    expect(html).toContain('Notes for the uploader (optional)')
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Approve agent<\/button>/)
  })

  it('shows the earlier decision and offers to withdraw an approval', () => {
    const html = render({
      agent: {
        ...pending,
        validationStatus: AgentValidationStatus.APPROVED,
        validationNotes: 'Checked the Dockerfile',
        validatedAt: '2026-11-02T09:00:00Z',
      },
    })
    expect(html).toContain('Checked the Dockerfile')
    expect(html).toContain('>Reject<')
    expect(html).not.toContain('>Approve<')
  })

  it('opens the builds, resources and capabilities on request', () => {
    const detail: AgentReviewDetail = {
      ...pending,
      resourceCpu: '500m',
      resourceMemory: '1Gi',
      sdkMinVersion: '0.9.0',
      tags: [],
      buildLogs: [
        pending.lastBuild!,
        { id: 'b0', status: 'success', imageName: 'img:1', errorMessage: null, startedAt: '2026-10-30T10:00:00Z', completedAt: null },
      ],
    }
    const html = render({ expanded: true, detail })
    expect(html).toContain('voice, plans')
    expect(html).toContain('500m')
    expect(html).toContain('1Gi')
    expect(html).toContain('>Built<')
    expect(html).not.toContain('>success<')
  })
})
