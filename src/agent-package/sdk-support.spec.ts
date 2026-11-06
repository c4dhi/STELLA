import * as fs from 'fs'
import * as path from 'path'
import { parseSdkVersionOutput, sdkProbeArgs } from '../agent-build/agent-build.service.js'
import { CURRENT_SDK_VERSION, MIN_SUPPORTED_SDK_VERSION } from './manifest-defaults.js'
import { builtSdkProblem, requestedSdkProblem, sdkSupport } from './sdk-support.js'

// One rule for which SDKs this STELLA runs, asked by the build and the deploy.

describe('SDK support window', () => {
  it('CURRENT_SDK_VERSION is the SDK this repo ships', () => {
    const pyproject = fs.readFileSync(path.join(process.cwd(), 'agents/stella-ai-agent-sdk/pyproject.toml'), 'utf-8')
    expect(pyproject.match(/^version = "([^"]+)"/m)?.[1]).toBe(CURRENT_SDK_VERSION)
  })

  it('the floor is not above the SDK this repo ships', () => {
    expect(builtSdkProblem(CURRENT_SDK_VERSION)).toBeNull()
  })

  it('a build needs an SDK at or above the floor', () => {
    expect(builtSdkProblem(null)).toBe('no stella-ai-agent-sdk version is known for its build')
    expect(builtSdkProblem('0.0.1')).toBe(
      `it was built with stella-ai-agent-sdk 0.0.1, older than the oldest this STELLA supports (${MIN_SUPPORTED_SDK_VERSION})`,
    )
    expect(builtSdkProblem(MIN_SUPPORTED_SDK_VERSION)).toBeNull()
    expect(builtSdkProblem('99.0.0')).toBeNull()
  })

  it('refuses SDKs older than 0.10.0, which cannot read LIVEKIT_TOKEN (issue 856)', () => {
    expect(MIN_SUPPORTED_SDK_VERSION).toBe('0.10.0')
    expect(builtSdkProblem('0.9.0')).toMatch(/older than the oldest this STELLA supports/)
  })

  it('a manifest may not ask for an SDK newer than this STELLA ships', () => {
    expect(requestedSdkProblem(undefined)).toBeNull()
    expect(requestedSdkProblem(CURRENT_SDK_VERSION)).toBeNull()
    expect(requestedSdkProblem('99.0.0')).toContain('newer than this STELLA supports')
  })

  it('publishes the window', () => {
    expect(sdkSupport()).toEqual({ minSupported: MIN_SUPPORTED_SDK_VERSION, current: CURRENT_SDK_VERSION })
  })
})

describe('reading the SDK version from a built image', () => {
  it('takes the last line the probe printed', () => {
    expect(parseSdkVersionOutput('0.9.0\n')).toBe('0.9.0')
    expect(parseSdkVersionOutput('some warning\n0.10.0rc1\n')).toBe('0.10.0rc1')
  })

  it('treats anything else as no SDK', () => {
    expect(parseSdkVersionOutput('')).toBeNull()
    expect(parseSdkVersionOutput('Traceback (most recent call last):')).toBeNull()
  })
})

describe('the SDK probe container', () => {
  it('is named, so a hung one can be removed, and runs without network, capabilities or room to grow', () => {
    const args = sdkProbeArgs('stella-sdk-probe-1', 'mine:0.1.0')
    const flag = (name: string) => args[args.indexOf(name) + 1]
    expect(flag('--name')).toBe('stella-sdk-probe-1')
    expect(flag('--network')).toBe('none')
    expect(flag('--cap-drop')).toBe('ALL')
    expect(flag('--security-opt')).toBe('no-new-privileges')
    expect(args).toEqual(expect.arrayContaining(['--memory', '--pids-limit', '--rm']))
    expect(args.indexOf('mine:0.1.0')).toBeGreaterThan(args.indexOf('--entrypoint'))
  })
})
