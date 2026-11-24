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
  // Every --from=<ref> on a real COPY line, not just the first.
  private readonly copyFromFlagPattern = /--from=(\S+)/gi
  // --mount=type=bind,from=<ref>,... on a RUN (or COPY) line pulls an image too.
  private readonly mountFlagPattern = /--mount=(\S+)/gi
  // A heredoc redirection opened on an instruction line, e.g. `<<EOF`, `<<-'EOF'`.
  private readonly heredocMarkerPattern = /<<-?~?(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g
  // Only RUN, COPY and ADD read heredocs in real Docker; anything else (e.g. a
  // LABEL value that happens to contain "<<") must never open one.
  private readonly heredocCapableInstructionPattern = /^[ \t]*(RUN|COPY|ADD)\b/i
  // Real Docker/BuildKit heredoc-opening is pickier than our marker regex (no
  // word-boundary or quoting awareness) - so instead of replicating that
  // grammar exactly, any line *treated* as heredoc body that still looks
  // like a real FROM or a from= reference fails the upload outright. That
  // holds whether our heredoc detection turns out looser or stricter than
  // Docker's.
  private readonly hiddenFromLikePattern = /^[ \t]*FROM\b/i
  private readonly hiddenFromAttrPattern = /\bfrom=/i
  // The `# escape=` parser directive changes Docker's continuation character
  // away from backslash - refused outright rather than honoured, since an
  // unhandled one would let a "\"-continued line hide a real instruction.
  private readonly escapeDirectivePattern = /^[ \t]*#[ \t]*escape[ \t]*=/im
  // The `# syntax=` directive picks the BuildKit frontend image that builds
  // the file - anything but the standard docker/dockerfile frontend can make
  // the allowlist irrelevant, so only that one is accepted.
  private readonly syntaxDirectivePattern = /^[ \t]*#[ \t]*syntax[ \t]*=[ \t]*(\S+)/im
  private readonly allowedSyntaxDirectivePattern = /^docker\/dockerfile(:[\w.-]+)?$/i
  // Only an explicit docker.io/index.docker.io + library/ prefix is the same
  // image as the bare name; any other host (or a Docker Hub user/org
  // namespace, which looks the same shape) is a different image and must
  // never be normalized away.
  private readonly officialRegistryPrefixPattern = /^(?:index\.docker\.io|docker\.io)\/library\//i

  // Dangerous patterns that are blocked - always checked against the raw
  // file content, heredoc bodies included, since these are red flags no
  // matter where they appear.
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

  // Patterns that trigger warnings - also checked against the raw content.
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

    if (this.escapeDirectivePattern.test(content)) {
      errors.push('Dockerfile parser directives (# escape=) are not supported')
    }

    const syntaxMatch = content.match(this.syntaxDirectivePattern)
    if (syntaxMatch && !this.allowedSyntaxDirectivePattern.test(syntaxMatch[1])) {
      errors.push('Dockerfile parser directives (# syntax=) must name docker/dockerfile, or be omitted')
    }

    const { lines: logicalLines, unclosedHeredoc, hiddenFromLikeLine } = this.toLogicalLines(content)
    const logicalContent = logicalLines.join('\n')

    if (unclosedHeredoc) {
      errors.push('Dockerfile has an unclosed heredoc')
    }

    if (hiddenFromLikeLine) {
      errors.push('Dockerfile has a heredoc body that looks like a FROM instruction or an image reference')
    }

    const { stages, externalImageRefs } = this.parseStagesAndCopies(logicalLines)

    if (stages.length === 0) {
      errors.push('No FROM instruction found in Dockerfile')
    }

    // Every external image a build actually pulls from - every stage's own
    // FROM, every COPY --from, and every --mount=...,from= that isn't just
    // referencing an earlier stage - must be on the allowlist.
    const externalImages = [...stages.filter((s) => s.isExternal).map((s) => s.rawImage), ...externalImageRefs]
    for (const image of externalImages) {
      if (!this.isAllowedBaseImage(image)) {
        errors.push(`Base image "${image}" is not in the allowed list. Allowed: ${SUPPORTED_BASE_IMAGES.join(', ')}`)
      }
    }

    const baseImage = this.resolveFinalImage(stages)

    // Check for blocked patterns - against the raw content, so a dangerous
    // command hidden inside a real heredoc body is still caught.
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
   * heredoc body passed to RUN/COPY/ADD. A heredoc that never closes marks
   * the whole file unclosedHeredoc, since everything after it is ambiguous.
   */
  private toLogicalLines(content: string): {
    lines: string[]
    unclosedHeredoc: boolean
    hiddenFromLikeLine: boolean
  } {
    const rawLines = content.split('\n')
    const logical: string[] = []
    let current: string | null = null
    let pendingHeredocDelimiters: string[] = []
    let hiddenFromLikeLine = false

    const closeLogicalLine = (line: string) => {
      logical.push(line)
      if (this.heredocCapableInstructionPattern.test(line)) {
        pendingHeredocDelimiters = this.findHeredocDelimiters(line)
      }
    }

    for (const rawLine of rawLines) {
      if (pendingHeredocDelimiters.length > 0) {
        if (rawLine.trim() === pendingHeredocDelimiters[0]) {
          pendingHeredocDelimiters.shift()
        } else if (this.hiddenFromLikePattern.test(rawLine) || this.hiddenFromAttrPattern.test(rawLine)) {
          hiddenFromLikeLine = true
        }
        continue
      }

      if (current !== null) {
        current += '\n' + rawLine
        if (!this.endsWithContinuation(rawLine)) {
          closeLogicalLine(current)
          current = null
        }
        continue
      }

      const trimmedStart = rawLine.trimStart()
      if (trimmedStart === '' || trimmedStart.startsWith('#')) {
        continue
      }

      if (this.endsWithContinuation(rawLine)) {
        current = rawLine
      } else {
        closeLogicalLine(rawLine)
      }
    }
    if (current !== null) {
      logical.push(current)
    }

    return { lines: logical, unclosedHeredoc: pendingHeredocDelimiters.length > 0, hiddenFromLikeLine }
  }

  private endsWithContinuation(line: string): boolean {
    return /\\[ \t]*$/.test(line)
  }

  private findHeredocDelimiters(logicalLine: string): string[] {
    return [...logicalLine.matchAll(this.heredocMarkerPattern)].map((match) => match[2])
  }

  /**
   * Walk the logical lines once, collecting every build stage (in order,
   * with its alias if any) and every external image reference from a
   * COPY --from or a --mount=...,from= - "external" meaning it isn't just a
   * reference to an earlier stage's name or index.
   */
  private parseStagesAndCopies(logicalLines: string[]): {
    stages: Stage[]
    externalImageRefs: string[]
  } {
    const stages: Stage[] = []
    const externalImageRefs: string[] = []
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

      if (/^[ \t]*COPY\b/i.test(line)) {
        for (const match of line.matchAll(this.copyFromFlagPattern)) {
          if (!isKnownStageRef(match[1])) {
            externalImageRefs.push(match[1])
          }
        }
      }

      for (const ref of this.findMountFromImages(line)) {
        if (!isKnownStageRef(ref)) {
          externalImageRefs.push(ref)
        }
      }
    }

    return { stages, externalImageRefs }
  }

  private findMountFromImages(logicalLine: string): string[] {
    const refs: string[] = []
    for (const match of logicalLine.matchAll(this.mountFlagPattern)) {
      for (const attr of match[1].split(',')) {
        const fromMatch = attr.match(/^from=(.+)$/i)
        if (fromMatch) {
          refs.push(fromMatch[1])
        }
      }
    }
    return refs
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
    const normalizedImage = image.replace(this.officialRegistryPrefixPattern, '')

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
    return /^[ \t]*(ENTRYPOINT|CMD)\s+/im.test(content)
  }
}
