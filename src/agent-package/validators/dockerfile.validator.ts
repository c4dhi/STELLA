import { Injectable, Logger } from '@nestjs/common'
import { SUPPORTED_BASE_IMAGES } from '../manifest-defaults.js'

export interface DockerfileValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
  baseImage?: string
}

interface Stage {
  /** The stage's alias from `AS <name>`, if the FROM instruction has one. */
  name: string | null
  /** The raw image token as written: could be another stage's name/index. */
  rawImage: string
  /** False when rawImage refers to an earlier stage rather than an external image. */
  isExternal: boolean
}

@Injectable()
export class DockerfileValidator {
  private readonly logger = new Logger(DockerfileValidator.name)

  // Matches a real FROM instruction: the start of a logical line (see
  // toLogicalLines), never the word "from" elsewhere in the file.
  private readonly fromLinePattern = /^[ \t]*FROM[ \t]+(?:--platform=\S+[ \t]+)?(\S+)(?:[ \t]+AS[ \t]+(\S+))?/i
  // Matches a real COPY --from=<ref>, on the same terms.
  private readonly copyFromPattern = /^[ \t]*COPY\b[\s\S]*?--from=(\S+)/i
  // A heredoc redirection opened on an instruction line, e.g. `<<EOF`, `<<-'EOF'`.
  private readonly heredocMarkerPattern = /<<-?~?(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g

  // Dangerous patterns that are blocked
  private readonly blockedPatterns = [
    { pattern: /^[ \t]*FROM[ \t]+(?:--platform=\S+[ \t]+)?scratch\b/im, message: 'FROM scratch is not allowed' },
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

    const logicalLines = this.toLogicalLines(content)
    const logicalContent = logicalLines.join('\n')

    const { stages, externalCopyFromImages } = this.parseStagesAndCopies(logicalLines)

    if (stages.length === 0) {
      errors.push('No FROM instruction found in Dockerfile')
    }

    // Every external image a build actually pulls from - every stage's own
    // FROM, and every COPY --from that isn't just copying from an earlier
    // stage - must be on the allowlist, not only the final stage's.
    const externalImages = [...stages.filter((s) => s.isExternal).map((s) => s.rawImage), ...externalCopyFromImages]
    for (const image of externalImages) {
      if (!this.isAllowedBaseImage(image)) {
        errors.push(`Base image "${image}" is not in the allowed list. Allowed: ${SUPPORTED_BASE_IMAGES.join(', ')}`)
      }
    }

    const baseImage = this.resolveFinalImage(stages)

    // Check for blocked patterns
    for (const { pattern, message } of this.blockedPatterns) {
      if (pattern.test(logicalContent)) {
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
    if (!this.hasEntrypoint(logicalContent)) {
      errors.push('Dockerfile must have an ENTRYPOINT or CMD instruction')
    }

    // Check for WORKDIR
    if (!/^[ \t]*WORKDIR[ \t]+/im.test(logicalContent)) {
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
   * Join backslash-continued lines into one, and drop heredoc body lines
   * (and their closing delimiter), so matching below only ever sees the
   * Dockerfile's real top-level instruction lines - never a FROM or
   * COPY --from that only appears inside a continued RUN's arguments or a
   * heredoc body passed to RUN.
   */
  private toLogicalLines(content: string): string[] {
    const rawLines = content.split('\n')
    const logical: string[] = []
    let current: string | null = null
    let pendingHeredocDelimiters: string[] = []

    for (const line of rawLines) {
      if (pendingHeredocDelimiters.length > 0) {
        if (line.trim() === pendingHeredocDelimiters[0]) {
          pendingHeredocDelimiters.shift()
        }
        continue
      }

      if (current !== null) {
        current += '\n' + line
        if (!this.endsWithContinuation(line)) {
          logical.push(current)
          pendingHeredocDelimiters = this.findHeredocDelimiters(current)
          current = null
        }
        continue
      }

      const trimmedStart = line.trimStart()
      if (trimmedStart === '' || trimmedStart.startsWith('#')) {
        continue
      }

      if (this.endsWithContinuation(line)) {
        current = line
      } else {
        logical.push(line)
        pendingHeredocDelimiters = this.findHeredocDelimiters(line)
      }
    }
    if (current !== null) {
      logical.push(current)
    }
    return logical
  }

  private endsWithContinuation(line: string): boolean {
    return /\\[ \t]*$/.test(line)
  }

  private findHeredocDelimiters(logicalLine: string): string[] {
    return [...logicalLine.matchAll(this.heredocMarkerPattern)].map((match) => match[2])
  }

  /**
   * Walk the logical lines once, collecting every build stage (in order,
   * with its alias if any) and every external COPY --from image - "external"
   * meaning it isn't just a reference to an earlier stage's name or index.
   */
  private parseStagesAndCopies(logicalLines: string[]): {
    stages: Stage[]
    externalCopyFromImages: string[]
  } {
    const stages: Stage[] = []
    const externalCopyFromImages: string[] = []
    const knownStageRefs = new Set<string>()
    const isKnownStageRef = (ref: string) => knownStageRefs.has(ref.toLowerCase())

    for (const line of logicalLines) {
      const fromMatch = line.match(this.fromLinePattern)
      if (fromMatch) {
        const [, rawImage, alias] = fromMatch
        stages.push({ name: alias ?? null, rawImage, isExternal: !isKnownStageRef(rawImage) })
        knownStageRefs.add(String(stages.length - 1))
        if (alias) {
          knownStageRefs.add(alias.toLowerCase())
        }
        continue
      }

      const copyMatch = line.match(this.copyFromPattern)
      if (copyMatch && !isKnownStageRef(copyMatch[1])) {
        externalCopyFromImages.push(copyMatch[1])
      }
    }

    return { stages, externalCopyFromImages }
  }

  /** The image the final stage actually runs on, resolving stage-to-stage references. */
  private resolveFinalImage(stages: Stage[]): string | null {
    if (stages.length === 0) {
      return null
    }

    let index = stages.length - 1
    let current = stages[index]
    const visited = new Set<number>()

    while (!current.isExternal) {
      if (visited.has(index)) {
        break // defend against a reference cycle
      }
      visited.add(index)

      const ref = current.rawImage.toLowerCase()
      const found = stages.findIndex((s, i) => i < index && (s.name?.toLowerCase() === ref || String(i) === ref))
      if (found === -1) {
        break
      }
      index = found
      current = stages[found]
    }

    return current.rawImage
  }

  /**
   * Check if base image is in allowed list.
   */
  private isAllowedBaseImage(image: string): boolean {
    const normalizedImage = this.stripRegistryHost(image)

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
   * Strip a registry host (and a following `library/`), never a Docker Hub
   * user/org namespace: a host has a `.` or `:` in it, or is `localhost`
   * (the same rule Docker itself uses to tell them apart), so
   * `user/python:3.12-slim` is left alone and never matches `python:3.12-slim`.
   */
  private stripRegistryHost(image: string): string {
    const firstSlash = image.indexOf('/')
    if (firstSlash === -1) {
      return image
    }

    const firstSegment = image.slice(0, firstSlash)
    const looksLikeRegistryHost =
      firstSegment === 'localhost' || firstSegment.includes('.') || firstSegment.includes(':')
    if (!looksLikeRegistryHost) {
      return image
    }

    let rest = image.slice(firstSlash + 1)
    if (rest.startsWith('library/')) {
      rest = rest.slice('library/'.length)
    }
    return rest
  }

  /**
   * Check if Dockerfile has ENTRYPOINT or CMD.
   */
  private hasEntrypoint(content: string): boolean {
    return /^[ \t]*(ENTRYPOINT|CMD)\s+/im.test(content)
  }
}
