import { Injectable, Logger } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { AgentType, AgentValidationStatus } from '@prisma/client'

export interface AgentTypeInfo {
  id: string
  slug: string
  name: string
  description: string
  icon: string | null
  version: string
  isBuiltIn: boolean
  /** Superseded but still deployable; the gallery demotes it. */
  deprecated: boolean
  deprecationNote: string | null
  capabilities: string[]
  defaultConfig: Record<string, unknown>  // Default config for this agent type
  configSchema: Record<string, unknown> | null  // JSON Schema for agent config (includes x-stella-* extensions)
  pipelineSchema: Record<string, unknown> | null  // Pipeline topology + configurable slots
  // Agent-declared default experts (config/experts/*.json). Null for non-expert agents.
  expertDefaults: Record<string, unknown>[] | null
}

@Injectable()
export class AgentTypeService {
  private readonly logger = new Logger(AgentTypeService.name)

  constructor(private prisma: PrismaService) {}

  /**
   * Get all approved agent types for display in the gallery
   */
  async findAll(): Promise<AgentType[]> {
    return this.prisma.agentType.findMany({
      where: { validationStatus: AgentValidationStatus.APPROVED },
      // Deprecated last: the gallery should lead with what to pick, not with
      // what is being retired. Still returned — existing deployments reference
      // these rows and must stay reproducible.
      orderBy: [{ deprecated: 'asc' }, { isBuiltIn: 'desc' }, { name: 'asc' }],
    })
  }

  /**
   * Find an agent type by its unique slug
   */
  async findBySlug(slug: string): Promise<AgentType | null> {
    return this.prisma.agentType.findUnique({ where: { slug } })
  }

  /**
   * Find an agent type by its UUID
   */
  async findById(id: string): Promise<AgentType | null> {
    return this.prisma.agentType.findUnique({ where: { id } })
  }

  /**
   * Get all agent types formatted for the frontend gallery
   */
  async getAgentTypesForGallery(): Promise<AgentTypeInfo[]> {
    const types = await this.findAll()

    return types.map((t) => ({
      id: t.id,
      slug: t.slug,
      name: t.name,
      description: t.description,
      icon: t.icon,
      version: t.version,
      isBuiltIn: t.isBuiltIn,
      deprecated: t.deprecated,
      deprecationNote: t.deprecationNote,
      capabilities: (t.capabilities as string[]) || [],
      defaultConfig: (t.defaultConfig as Record<string, unknown>) || {},
      configSchema: (t.configSchema as Record<string, unknown>) || null,
      pipelineSchema: (t.pipelineSchema as Record<string, unknown>) || null,
      expertDefaults: (t.expertDefaults as Record<string, unknown>[]) || null,
    }))
  }
}
