import { compareVersions } from '../agent-configurations/configuration-compat.util.js'
import { CURRENT_SDK_VERSION, MIN_SUPPORTED_SDK_VERSION } from './manifest-defaults.js'

/**
 * The SDK support window: which stella-ai-agent-sdk versions this STELLA runs.
 * The build (what an image has installed) and the deploy (what a manifest asks
 * for, and what the stored build has) both ask here, so the window has one rule.
 * Each returns what is wrong, for the user, or null when the version is
 * supported. Callers add what to do about it, which differs between them.
 */

export const SDK_PACKAGE = 'stella-ai-agent-sdk'

/**
 * The SDK an image was built with. Null: the build found none, or the image is
 * from before STELLA recorded it. Either way a rebuild settles it.
 */
export function builtSdkProblem(installed: string | null): string | null {
  if (!installed) {
    return `no ${SDK_PACKAGE} version is known for its build`
  }
  if (compareVersions(installed, MIN_SUPPORTED_SDK_VERSION) < 0) {
    return `it was built with ${SDK_PACKAGE} ${installed}, older than the oldest this STELLA supports (${MIN_SUPPORTED_SDK_VERSION})`
  }
  return null
}

/** The SDK a manifest asks for (`sdk.minVersion`). */
export function requestedSdkProblem(minVersion: string | null | undefined): string | null {
  if (minVersion && compareVersions(minVersion, CURRENT_SDK_VERSION) > 0) {
    return `it needs ${SDK_PACKAGE} ${minVersion}, newer than this STELLA supports (${CURRENT_SDK_VERSION})`
  }
  return null
}

export function sdkSupport() {
  return { minSupported: MIN_SUPPORTED_SDK_VERSION, current: CURRENT_SDK_VERSION }
}
