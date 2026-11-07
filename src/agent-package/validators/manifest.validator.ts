import { Injectable } from '@nestjs/common'
import { parseAgentManifestYaml, type ManifestSchemaParseResult } from '../schemas/agent-manifest.schema.js'

@Injectable()
export class ManifestValidator {
  /** Thin injectable adapter around the canonical parser so all entrypoints share identical rules. */
  validate(content: string): ManifestSchemaParseResult {
    return parseAgentManifestYaml(content)
  }
}
