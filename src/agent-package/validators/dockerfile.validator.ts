import { Injectable, Logger } from '@nestjs/common'
import { SUPPORTED_BASE_IMAGES } from '../agent-manifest.types.js'

export interface DockerfileValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
  baseImage?: string
}

@Injectable()
export class DockerfileValidator {
  private readonly logger = new Logger(DockerfileValidator.name)

  // Dangerous patterns that are blocked
  private readonly blockedPatterns = [
    { pattern: /FROM\s+scratch/i, message: 'FROM scratch is not allowed' },
    { pattern: /--privileged/i, message: '--privileged flag is not allowed' },
    { pattern: /--cap-add/i, message: '--cap-add flag is not allowed' },
    { pattern: /curl\s+[^|]*\|\s*(ba)?sh/i, message: 'Piping curl to shell is not allowed' },
    { pattern: /wget\s+[^|]*\|\s*(ba)?sh/i, message: 'Piping wget to shell is not allowed' },
    { pattern: /\bsudo\b/i, message: 'sudo is not allowed in Dockerfile' },
    { pattern: /--security-opt/i, message: '--security-opt is not allowed' },
    { pattern: /--cap-drop=ALL.*--cap-add/i, message: 'Capability manipulation is not allowed' },
  ]

  // Patterns that trigger warnings
  private readonly warningPatterns = [
    { pattern: /apt-get\s+install[^&]*\n/i, message: 'Consider using apt-get install -y --no-install-recommends' },
    { pattern: /pip\s+install(?!.*--no-cache)/i, message: 'Consider using pip install --no-cache-dir' },
    { pattern: /COPY\s+\.\s/i, message: 'COPY . may include unnecessary files; consider using .dockerignore' },
  ]

  /**
   * Validate a Dockerfile content for security issues.
   */
  validate(content: string): DockerfileValidationResult {
    const errors: string[] = []
    const warnings: string[] = []

    if (!content || content.trim().length === 0) {
      return {
        valid: false,
        errors: ['Dockerfile is empty'],
        warnings: [],
      }
    }

    // Extract and validate base image
    const baseImage = this.extractBaseImage(content)
    if (!baseImage) {
      errors.push('No FROM instruction found in Dockerfile')
    } else if (!this.isAllowedBaseImage(baseImage)) {
      errors.push(
        `Base image "${baseImage}" is not in the allowed list. Allowed: ${SUPPORTED_BASE_IMAGES.join(', ')}`,
      )
    }

    // Check for blocked patterns
    for (const { pattern, message } of this.blockedPatterns) {
      if (pattern.test(content)) {
        errors.push(message)
      }
    }

    // Check for warning patterns
    for (const { pattern, message } of this.warningPatterns) {
      if (pattern.test(content)) {
        warnings.push(message)
      }
    }

    // Validate ENTRYPOINT or CMD exists
    if (!this.hasEntrypoint(content)) {
      errors.push('Dockerfile must have an ENTRYPOINT or CMD instruction')
    }

    // Check for WORKDIR
    if (!/WORKDIR\s+/i.test(content)) {
      warnings.push('Consider adding WORKDIR for clarity')
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      baseImage: baseImage || undefined,
    }
  }

  /**
   * Extract the base image from FROM instruction.
   */
  private extractBaseImage(content: string): string | null {
    // Handle multi-stage builds - get the final FROM
    const fromMatches = content.match(/FROM\s+([^\s]+)/gi)
    if (!fromMatches || fromMatches.length === 0) {
      return null
    }

    // Get the last FROM (final stage)
    const lastFrom = fromMatches[fromMatches.length - 1]
    const match = lastFrom.match(/FROM\s+([^\s]+)/i)
    if (!match) {
      return null
    }

    // Remove AS alias if present
    let image = match[1]
    const asIndex = image.toLowerCase().indexOf(' as ')
    if (asIndex !== -1) {
      image = image.substring(0, asIndex)
    }

    return image.trim()
  }

  /**
   * Check if base image is in allowed list.
   */
  private isAllowedBaseImage(image: string): boolean {
    // Normalize image name (remove registry prefix if present)
    const normalizedImage = image.replace(/^[^/]+\//, '')

    return SUPPORTED_BASE_IMAGES.some((allowed) => {
      // Exact match
      if (normalizedImage === allowed) return true

      // Match with tag variations (e.g., python:3.11 matches python:3.11-slim)
      const [name, tag] = normalizedImage.split(':')
      const [allowedName, allowedTag] = allowed.split(':')

      if (name !== allowedName) return false

      // If tag starts with allowed tag version
      if (tag && allowedTag && tag.startsWith(allowedTag.split('-')[0])) {
        return true
      }

      return false
    })
  }

  /**
   * Check if Dockerfile has ENTRYPOINT or CMD.
   */
  private hasEntrypoint(content: string): boolean {
    return /^(ENTRYPOINT|CMD)\s+/im.test(content)
  }
}
