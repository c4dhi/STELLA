import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { CreatePlanTemplateDto } from './dto/create-plan-template.dto.js';
import { UpdatePlanTemplateDto } from './dto/update-plan-template.dto.js';

@Injectable()
export class PlanTemplatesService {
  private readonly logger = new Logger(PlanTemplatesService.name);

  constructor(private prisma: PrismaService) {}

  async create(userId: string, dto: CreatePlanTemplateDto) {
    this.logger.log(`Creating plan template "${dto.name}" for user ${userId}`);

    return this.prisma.planTemplate.create({
      data: {
        ...dto,
        userId,
      },
    });
  }

  async findAllByUser(userId: string) {
    return this.prisma.planTemplate.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async findOne(id: string, userId: string) {
    const template = await this.prisma.planTemplate.findUnique({
      where: { id },
    });

    if (!template) {
      throw new NotFoundException(`Plan template with ID ${id} not found`);
    }

    if (template.userId !== userId) {
      throw new NotFoundException(`Plan template with ID ${id} not found`);
    }

    return template;
  }

  async update(id: string, userId: string, dto: UpdatePlanTemplateDto) {
    // Verify ownership
    await this.findOne(id, userId);

    return this.prisma.planTemplate.update({
      where: { id },
      data: dto,
    });
  }

  async remove(id: string, userId: string) {
    // Verify ownership
    const template = await this.findOne(id, userId);

    this.logger.log(
      `Deleting plan template ${id} (${template.name}) for user ${userId}`,
    );

    await this.prisma.planTemplate.delete({
      where: { id },
    });

    return { message: 'Plan template deleted successfully' };
  }

  async duplicate(id: string, userId: string) {
    const template = await this.findOne(id, userId);

    this.logger.log(
      `Duplicating plan template ${id} (${template.name}) for user ${userId}`,
    );

    return this.prisma.planTemplate.create({
      data: {
        name: `${template.name} (Copy)`,
        description: template.description,
        content: template.content as Prisma.InputJsonValue,
        userId,
      },
    });
  }
}
