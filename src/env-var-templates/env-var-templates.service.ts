import {
  Injectable,
  NotFoundException,
  Logger,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { EncryptionService } from './encryption.service.js';
import { CreateEnvVarTemplateDto } from './dto/create-env-var-template.dto.js';
import { UpdateEnvVarTemplateDto } from './dto/update-env-var-template.dto.js';

/**
 * Response type for env var templates (without sensitive values)
 */
export interface EnvVarTemplateResponse {
  id: string;
  userId: string;
  name: string;
  description: string | null;
  variableKeys: string[];
  agentTypeId: string;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class EnvVarTemplatesService {
  private readonly logger = new Logger(EnvVarTemplatesService.name);

  constructor(
    private prisma: PrismaService,
    private encryption: EncryptionService,
  ) {}

  /**
   * Create a new environment variable template
   */
  async create(
    userId: string,
    dto: CreateEnvVarTemplateDto,
  ): Promise<EnvVarTemplateResponse> {
    this.logger.log(
      `Creating env var template "${dto.name}" for user ${userId}`,
    );

    // Templates are always scoped to exactly one agent type; verify it exists.
    // Mirrors AgentConfigurationsService.create.
    const agentType = await this.prisma.agentType.findUnique({
      where: { id: dto.agentTypeId },
    });
    if (!agentType) {
      throw new BadRequestException(
        `Agent type with ID ${dto.agentTypeId} not found`,
      );
    }

    // Encrypt the variables
    const encryptedVariables = this.encryption.encrypt(dto.variables);

    const template = await this.prisma.envVarTemplate.create({
      data: {
        name: dto.name,
        description: dto.description,
        variables: encryptedVariables,
        agentTypeId: dto.agentTypeId,
        userId,
      },
    });

    return this.toResponse(template);
  }

  /**
   * Find all templates for a user
   */
  async findAllByUser(userId: string): Promise<EnvVarTemplateResponse[]> {
    const templates = await this.prisma.envVarTemplate.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
    });

    return templates.map((t) => this.toResponse(t));
  }

  /**
   * Find templates for a user scoped strictly to a single agent type.
   * No "generic" fallthrough — only templates whose agentTypeId matches.
   */
  async findByAgentType(
    userId: string,
    agentTypeId: string,
  ): Promise<EnvVarTemplateResponse[]> {
    const templates = await this.prisma.envVarTemplate.findMany({
      where: { userId, agentTypeId },
      orderBy: { updatedAt: 'desc' },
    });

    return templates.map((t) => this.toResponse(t));
  }

  /**
   * Assert an env var template is compatible with a target agent type.
   * Throws 404 if the template isn't owned by the user, 400 on a type mismatch.
   * Call this before persisting a templateId on an agent or resolving its vars.
   */
  async assertCompatibleWithAgentType(
    templateId: string,
    userId: string,
    agentTypeId: string,
  ): Promise<void> {
    const template = await this.findOne(templateId, userId);
    if (template.agentTypeId !== agentTypeId) {
      throw new BadRequestException(
        `Env var template ${templateId} is bound to agent type ${template.agentTypeId}, not ${agentTypeId}`,
      );
    }
  }

  /**
   * Find a single template by ID
   */
  async findOne(id: string, userId: string): Promise<EnvVarTemplateResponse> {
    const template = await this.prisma.envVarTemplate.findUnique({
      where: { id },
    });

    if (!template) {
      throw new NotFoundException(`Env var template with ID ${id} not found`);
    }

    if (template.userId !== userId) {
      throw new NotFoundException(`Env var template with ID ${id} not found`);
    }

    return this.toResponse(template);
  }

  /**
   * Update an existing template
   */
  async update(
    id: string,
    userId: string,
    dto: UpdateEnvVarTemplateDto,
  ): Promise<EnvVarTemplateResponse> {
    // Verify ownership
    await this.findOne(id, userId);

    // agentTypeId is immutable post-create (templates belong to the type they were
    // authored for); rebind via duplicate. It is intentionally absent from the DTO.
    const updateData: any = {
      name: dto.name,
      description: dto.description,
    };

    // Variable changes are MERGED into the existing (decrypted) set, not a full
    // replace. The client sends only what it changed — `variables` adds/overwrites
    // and `removeKeys` deletes — so untouched secrets keep their stored value and
    // never need to be re-entered (e.g. deleting an optional var must not force
    // re-typing OPENAI_API_KEY). The encrypted blob is only rewritten when one of
    // the two is present.
    const hasVariableChanges =
      dto.variables !== undefined || (dto.removeKeys?.length ?? 0) > 0;
    if (hasVariableChanges) {
      const existing = await this.getDecryptedVariables(id, userId);
      const merged: Record<string, string> = { ...existing };
      for (const key of dto.removeKeys ?? []) {
        delete merged[key];
      }
      for (const [key, value] of Object.entries(dto.variables ?? {})) {
        merged[key] = value;
      }
      updateData.variables = this.encryption.encrypt(merged);
    }

    // Remove undefined values
    Object.keys(updateData).forEach((key) => {
      if (updateData[key] === undefined) {
        delete updateData[key];
      }
    });

    const template = await this.prisma.envVarTemplate.update({
      where: { id },
      data: updateData,
    });

    return this.toResponse(template);
  }

  /**
   * Delete a template
   */
  async remove(id: string, userId: string): Promise<{ message: string }> {
    const template = await this.findOne(id, userId);

    this.logger.log(
      `Deleting env var template ${id} (${template.name}) for user ${userId}`,
    );

    await this.prisma.envVarTemplate.delete({
      where: { id },
    });

    return { message: 'Environment variable template deleted successfully' };
  }

  /**
   * Duplicate a template
   */
  async duplicate(
    id: string,
    userId: string,
  ): Promise<EnvVarTemplateResponse> {
    const existingTemplate = await this.prisma.envVarTemplate.findUnique({
      where: { id },
    });

    if (!existingTemplate) {
      throw new NotFoundException(`Env var template with ID ${id} not found`);
    }

    if (existingTemplate.userId !== userId) {
      throw new NotFoundException(`Env var template with ID ${id} not found`);
    }

    this.logger.log(
      `Duplicating env var template ${id} (${existingTemplate.name}) for user ${userId}`,
    );

    // Copy the encrypted variables directly (no need to decrypt/re-encrypt)
    const template = await this.prisma.envVarTemplate.create({
      data: {
        name: `${existingTemplate.name} (Copy)`,
        description: existingTemplate.description,
        variables: existingTemplate.variables,
        agentTypeId: existingTemplate.agentTypeId,
        userId,
      },
    });

    return this.toResponse(template);
  }

  /**
   * Resolve the final env var map for agent deployment.
   *
   * This is the single entry point for all env var resolution:
   *   1. Decrypt the template vars (if a templateId is given).
   *   2. Merge manualVars on top so they override template values.
   *   3. Return the merged plaintext map (for K8s secret creation).
   *
   * SECURITY: `merged` must only be written to a K8s secret — never logged or
   * returned to API clients.
   */
  async resolveEnvVars(
    templateId: string | undefined | null,
    userId: string | undefined | null,
    manualVars?: Record<string, string>,
  ): Promise<{ merged: Record<string, string> }> {
    // A template cannot be resolved without user ownership context.
    if (templateId && !userId) {
      this.logger.warn(
        `Template ${templateId} was provided without userId; refusing to resolve template vars`,
      );
      throw new BadRequestException(
        'Cannot resolve env var template without user context',
      );
    }

    // Step 1: decrypt template vars when a template is referenced.
    let templateVars: Record<string, string> = {};
    if (templateId && userId) {
      templateVars = await this.getDecryptedVariables(templateId, userId);
      this.logger.log(
        `Resolved ${Object.keys(templateVars).length} vars from template ${templateId}`,
      );
    }

    // Step 2: manual vars override template values (right-side wins in spread).
    const merged = { ...templateVars, ...(manualVars ?? {}) };

    return { merged };
  }

  /**
   * Get decrypted variables for a template
   * SECURITY: Only call this during pod creation, never expose to API
   */
  async getDecryptedVariables(
    id: string,
    userId: string,
  ): Promise<Record<string, string>> {
    const template = await this.prisma.envVarTemplate.findUnique({
      where: { id },
    });

    if (!template) {
      throw new NotFoundException(`Env var template with ID ${id} not found`);
    }

    if (template.userId !== userId) {
      throw new ForbiddenException('Access denied to this template');
    }

    return this.encryption.decrypt(template.variables);
  }

  /**
   * Validate that user has access to a template
   */
  async validateAccess(id: string, userId: string): Promise<void> {
    await this.findOne(id, userId);
  }

  /**
   * Convert database entity to safe response (without encrypted values)
   */
  private toResponse(template: {
    id: string;
    userId: string;
    name: string;
    description: string | null;
    variables: string;
    agentTypeId: string;
    createdAt: Date;
    updatedAt: Date;
  }): EnvVarTemplateResponse {
    return {
      id: template.id,
      userId: template.userId,
      name: template.name,
      description: template.description,
      variableKeys: this.encryption.getKeys(template.variables),
      agentTypeId: template.agentTypeId,
      createdAt: template.createdAt,
      updatedAt: template.updatedAt,
    };
  }
}
