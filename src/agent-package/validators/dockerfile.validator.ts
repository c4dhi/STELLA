import { Injectable, Logger } from '@nestjs/common'
import { DockerfileParser, type Copy, type Dockerfile, type From, type Run } from 'dockerfile-ast'
import { SUPPORTED_BASE_IMAGES } from '../manifest-defaults.js'

export interface DockerfileValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
  baseImage?: string
}

interface Stage {
  name: string | null
  rawImage: string
  isExternal: boolean
}

@Injectable()
export class DockerfileValidator {
  private readonly logger = new Logger(DockerfileValidator.name)

  // BuildKit's own directive-name grammar: letters and digits only.
  private readonly directiveNamePattern = /^[a-zA-Z][a-zA-Z0-9]*$/
  private readonly allowedSyntaxDirectivePattern = /^docker\/dockerfile(:[\w.-]+)?$/i
  private readonly officialRegistryPrefixPattern = /^(?:index\.docker\.io|docker\.io)\/library\//i

  // Heredoc bodies are deliberately treated as opaque, untrusted text, scanned
  // on the raw lines rather than through either parser's heredoc grammar: the
  // real BuildKit grammar recognizes heredoc openers that dockerfile-ast does
  // not (a word-glued or quoted "<<EOF" still opens one for real Docker), so
  // trusting a parser's own heredoc boundaries here would reopen the bypass
  // #210 closed. This stays fail-closed regardless of what either parser's
  // heredoc rules turn out to be.
  private readonly heredocCapableInstructionPattern = /^[ \t]*(RUN|COPY|ADD)\b/i
  private readonly heredocMarkerPattern = /<<-?~?(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g
  private readonly hiddenFromLikePattern = /^[ \t]*FROM\b/i
  private readonly hiddenFromAttrPattern = /\bfrom=/i

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

  private readonly warningPatterns = [
    { pattern: /apt-get\s+install[^&]*\n/i, message: 'Consider using apt-get install -y --no-install-recommends' },
    { pattern: /pip\s+install(?!.*--no-cache)/i, message: 'Consider using pip install --no-cache-dir' },
    { pattern: /COPY\s+\.\s/i, message: 'COPY . may include unnecessary files; consider using .dockerignore' },
  ]

  validate(content: string): DockerfileValidationResult {
    const errors: string[] = []
    const warnings: string[] = []

    if (!content || content.trim().length === 0) {
      return { valid: false, errors: ['Dockerfile is empty'], warnings: [] }
    }

    let dockerfile: Dockerfile
    try {
      dockerfile = DockerfileParser.parse(content)
    } catch (error) {
      return { valid: false, errors: [`Dockerfile could not be parsed: ${(error as Error).message}`], warnings: [] }
    }

    for (const directive of dockerfile.getDirectives()) {
      // dockerfile-ast's own directive-name matching is looser than BuildKit's
      // (letters/digits only): it reads an ordinary leading comment like
      // "# ELIAS-Interviewer, built by ... (context = root)." as a directive
      // named "ELIAS-Interviewer,". Anything that isn't shaped like a real
      // directive name is not one to BuildKit either, so it is left as the
      // plain comment it is, not refused.
      if (!this.directiveNamePattern.test(directive.getName())) {
        continue
      }
      const name = directive.getName().toLowerCase()
      if (name === 'syntax') {
        if (!this.allowedSyntaxDirectivePattern.test(directive.getValue())) {
          errors.push('Dockerfile parser directives (# syntax=) must name docker/dockerfile, or be omitted')
        }
      } else {
        errors.push(`Dockerfile parser directives (# ${name}=) are not supported`)
      }
    }

    const { unclosedHeredoc, hiddenFromLikeLine } = this.scanHeredocsForHiddenInstructions(content)

    if (unclosedHeredoc) {
      errors.push('Dockerfile has an unclosed heredoc')
    }

    if (hiddenFromLikeLine) {
      errors.push(
        'Dockerfile has a heredoc body that looks like a FROM instruction or an image reference. ' +
          "If this is Python's `from … import …`, move it into a script file and COPY it in instead.",
      )
    }

    const { stages, externalImageRefs } = this.parseStagesAndCopies(dockerfile)

    if (stages.length === 0) {
      errors.push('No FROM instruction found in Dockerfile')
    }

    const externalImages = [...stages.filter((s) => s.isExternal).map((s) => s.rawImage), ...externalImageRefs]
    for (const image of externalImages) {
      if (!this.isAllowedBaseImage(image)) {
        errors.push(`Base image "${image}" is not in the allowed list. Allowed: ${SUPPORTED_BASE_IMAGES.join(', ')}`)
      }
    }

    const baseImage = this.resolveFinalImage(stages)

    for (const { pattern, message } of this.blockedPatterns) {
      if (pattern.test(content)) {
        errors.push(message)
      }
    }

    for (const { pattern, message } of this.warningPatterns) {
      if (pattern.test(content)) {
        warnings.push(message)
      }
    }

    const keywords = dockerfile.getInstructions().map((i) => i.getKeyword())

    if (!keywords.includes('ENTRYPOINT') && !keywords.includes('CMD')) {
      errors.push('Dockerfile must have an ENTRYPOINT or CMD instruction')
    }

    if (!keywords.includes('WORKDIR')) {
      warnings.push('Consider adding WORKDIR for clarity')
    }

    return { valid: errors.length === 0, errors, warnings, baseImage: baseImage || undefined }
  }

  /**
   * Walks the parsed instructions in document order, collecting every build
   * stage (FROM) and every external image reference (COPY --from, RUN
   * --mount=...,from=...) that does not resolve to an earlier stage. Forward
   * references (a name not yet declared) fall through to the allowlist check
   * like any other external image, matching real Docker, which refuses them.
   */
  private parseStagesAndCopies(dockerfile: Dockerfile): { stages: Stage[]; externalImageRefs: string[] } {
    const stages: Stage[] = []
    const externalImageRefs: string[] = []
    const knownStageRefs = new Set<string>()
    const isKnownStageRef = (ref: string) => knownStageRefs.has(ref.toLowerCase())

    for (const instruction of dockerfile.getInstructions()) {
      switch (instruction.getKeyword()) {
        case 'FROM': {
          const from = instruction as From
          // A FROM with no image at all never matches the allowlist, so it
          // is refused rather than treated as a pass-through.
          const rawImage = from.getImage() ?? ''
          const alias = from.getBuildStage()
          stages.push({ name: alias ?? null, rawImage, isExternal: !isKnownStageRef(rawImage) })
          knownStageRefs.add(String(stages.length - 1))
          if (alias) {
            knownStageRefs.add(alias.toLowerCase())
          }
          break
        }
        case 'COPY': {
          const copy = instruction as Copy
          for (const ref of this.findFlagValues(copy.getFlags(), 'from')) {
            if (!isKnownStageRef(ref)) {
              externalImageRefs.push(ref)
            }
          }
          break
        }
        case 'RUN': {
          const run = instruction as Run
          for (const ref of this.findMountFromImages(run.getFlags())) {
            if (!isKnownStageRef(ref)) {
              externalImageRefs.push(ref)
            }
          }
          break
        }
        default:
          break
      }
    }

    return { stages, externalImageRefs }
  }

  /** Every value of `--<name>=<value>` among a Dockerfile instruction's flags. */
  private findFlagValues(flags: { toString(): string }[], name: string): string[] {
    const pattern = new RegExp(`^--${name}=(.+)$`, 'i')
    const values: string[] = []
    for (const flag of flags) {
      const match = flag.toString().match(pattern)
      if (match) {
        values.push(match[1])
      }
    }
    return values
  }

  /** The image named by `from=` inside each `--mount=...` flag on a RUN instruction. */
  private findMountFromImages(flags: { toString(): string }[]): string[] {
    const refs: string[] = []
    for (const mount of this.findFlagValues(flags, 'mount')) {
      for (const attr of mount.split(',')) {
        const fromMatch = attr.match(/^from=(.+)$/i)
        if (fromMatch) {
          refs.push(fromMatch[1])
        }
      }
    }
    return refs
  }

  /**
   * Scans the raw lines for a heredoc opened after a RUN/COPY/ADD instruction
   * (joining `\`-continued lines first), and flags two things, independent of
   * whether either parser would call it a heredoc: a body line that looks
   * like a FROM instruction or a `from=`/`--from=` attribute, and a heredoc
   * that is never closed.
   */
  private scanHeredocsForHiddenInstructions(content: string): { unclosedHeredoc: boolean; hiddenFromLikeLine: boolean } {
    const rawLines = content.split('\n')
    let current: string | null = null
    let pendingHeredocDelimiters: string[] = []
    let hiddenFromLikeLine = false

    const closeLogicalLine = (line: string) => {
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

    return { unclosedHeredoc: pendingHeredocDelimiters.length > 0, hiddenFromLikeLine }
  }

  private endsWithContinuation(line: string): boolean {
    return /\\[ \t]*$/.test(line)
  }

  private findHeredocDelimiters(logicalLine: string): string[] {
    return [...logicalLine.matchAll(this.heredocMarkerPattern)].map((match) => match[2])
  }

  private resolveFinalImage(stages: Stage[]): string | null {
    if (stages.length === 0) {
      return null
    }
    let index = stages.length - 1
    let current = stages[index]
    const visited = new Set<number>()
    while (!current.isExternal) {
      if (visited.has(index)) {
        break
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

  private isAllowedBaseImage(image: string): boolean {
    const normalizedImage = image.replace(this.officialRegistryPrefixPattern, '')
    return SUPPORTED_BASE_IMAGES.some((allowed) => {
      if (normalizedImage === allowed) return true
      const [name, tag] = normalizedImage.split(':')
      const [allowedName, allowedTag] = allowed.split(':')
      if (name !== allowedName) return false
      if (tag && allowedTag && tag.startsWith(allowedTag.split('-')[0])) {
        return true
      }
      return false
    })
  }
}
