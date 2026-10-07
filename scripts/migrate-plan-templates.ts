/**
 * Migration script to convert PlanTemplate content from frontend format to canonical agent format.
 *
 * Frontend format used:
 * - state.label -> state.title
 * - state.execution_mode: 'sequential'|'flexible' -> state.type: 'strict'|'loose'
 * - task.label -> task.description
 * - task.description -> task.instruction
 * - deliverable.id -> deliverable.key
 * - deliverable.label -> deliverable.description
 * - deliverable.description -> deliverable.acceptance_criteria
 * - deliverable.enumValues -> deliverable.enum_values
 * - systemPrompt -> system_prompt
 *
 * Run with: npx ts-node scripts/migrate-plan-templates.ts
 */

import { PrismaClient, Prisma } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg'

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

// Type definitions for the old frontend format
interface FrontendDeliverable {
  id?: string;
  key?: string;
  label?: string;
  description?: string;
  type: string;
  required: boolean;
  enumValues?: string[];
  enum_values?: string[];
  examples?: string[];
  acceptance_criteria?: string;
}

interface FrontendTask {
  id: string;
  label?: string;
  description?: string;
  instruction?: string;
  required: boolean;
  deliverables: FrontendDeliverable[];
}

interface FrontendState {
  id: string;
  label?: string;
  title?: string;
  execution_mode?: 'sequential' | 'flexible';
  type?: 'strict' | 'loose';
  description?: string;
  tasks: FrontendTask[];
  transitions?: unknown[];
}

interface FrontendPlanContent {
  states: FrontendState[];
  metadata?: Record<string, unknown>;
  systemPrompt?: string;
  system_prompt?: string;
  sessionContext?: unknown;
  session_context?: unknown;
  [key: string]: unknown; // Index signature for JSON compatibility
}

// Type definitions for canonical agent format
interface AgentDeliverable {
  key: string;
  type: string;
  description: string;
  required: boolean;
  acceptance_criteria?: string;
  enum_values?: string[];
  examples?: string[];
}

interface AgentTask {
  id: string;
  description: string;
  instruction?: string;
  required: boolean;
  deliverables: AgentDeliverable[];
}

interface AgentState {
  id: string;
  title: string;
  type: 'strict' | 'loose';
  description?: string;
  tasks: AgentTask[];
  transitions?: unknown[];
}

interface AgentPlanContent {
  states: AgentState[];
  metadata?: Record<string, unknown>;
  system_prompt?: string;
  session_context?: unknown;
}

/**
 * Detect if a plan is in frontend format
 */
function isFrontendFormat(content: FrontendPlanContent): boolean {
  if (!content.states || !Array.isArray(content.states) || content.states.length === 0) {
    return false;
  }

  const firstState = content.states[0];

  // Check for frontend-specific fields
  if (firstState.label !== undefined) return true;
  if (firstState.execution_mode !== undefined) return true;

  // Check tasks for frontend format
  if (firstState.tasks && firstState.tasks.length > 0) {
    const firstTask = firstState.tasks[0];
    if (firstTask.label !== undefined) return true;

    // Check deliverables for frontend format
    if (firstTask.deliverables && firstTask.deliverables.length > 0) {
      const firstDeliverable = firstTask.deliverables[0];
      if (firstDeliverable.id !== undefined && firstDeliverable.key === undefined) return true;
      if (firstDeliverable.label !== undefined) return true;
      if (firstDeliverable.enumValues !== undefined) return true;
    }
  }

  // Check for systemPrompt (camelCase)
  if (content.systemPrompt !== undefined && content.system_prompt === undefined) return true;

  return false;
}

/**
 * Migrate a deliverable from frontend to agent format
 */
function migrateDeliverable(d: FrontendDeliverable): AgentDeliverable {
  return {
    key: d.key || d.id || `deliverable_${Date.now()}`,
    type: d.type || 'string',
    description: d.description || d.label || '',
    required: d.required ?? true,
    acceptance_criteria: d.acceptance_criteria || (d.label ? d.description : undefined),
    enum_values: d.enum_values || d.enumValues,
    examples: d.examples,
  };
}

/**
 * Migrate a task from frontend to agent format
 */
function migrateTask(t: FrontendTask): AgentTask {
  return {
    id: t.id,
    description: t.description || t.label || '',
    instruction: t.instruction || (t.label ? t.description : undefined),
    required: t.required ?? true,
    deliverables: (t.deliverables || []).map(migrateDeliverable),
  };
}

/**
 * Migrate a state from frontend to agent format
 */
function migrateState(s: FrontendState): AgentState {
  // Map execution_mode to type
  let stateType: 'strict' | 'loose' = 'loose';
  if (s.type) {
    stateType = s.type;
  } else if (s.execution_mode) {
    stateType = s.execution_mode === 'sequential' ? 'strict' : 'loose';
  }

  return {
    id: s.id,
    title: s.title || s.label || 'Untitled State',
    type: stateType,
    description: s.description,
    tasks: (s.tasks || []).map(migrateTask),
    transitions: s.transitions,
  };
}

/**
 * Migrate full plan content from frontend to agent format
 */
function migratePlanContent(content: FrontendPlanContent): AgentPlanContent {
  return {
    states: (content.states || []).map(migrateState),
    metadata: content.metadata,
    system_prompt: content.system_prompt || content.systemPrompt,
    session_context: content.session_context || content.sessionContext,
  };
}

async function main() {
  console.log('🔄 Starting PlanTemplate migration...\n');

  try {
    // Fetch all plan templates
    const templates = await prisma.planTemplate.findMany();
    console.log(`📋 Found ${templates.length} plan templates\n`);

    let migratedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;

    for (const template of templates) {
      const content = template.content as FrontendPlanContent;

      if (!content || !content.states) {
        console.log(`⏭️  Skipping "${template.name}" (${template.id}): No content or states`);
        skippedCount++;
        continue;
      }

      if (!isFrontendFormat(content)) {
        console.log(`✅ Already migrated: "${template.name}" (${template.id})`);
        skippedCount++;
        continue;
      }

      try {
        const migratedContent = migratePlanContent(content);

        await prisma.planTemplate.update({
          where: { id: template.id },
          data: { content: migratedContent as unknown as Prisma.InputJsonValue },
        });

        console.log(`🔄 Migrated: "${template.name}" (${template.id})`);
        migratedCount++;
      } catch (err) {
        console.error(`❌ Error migrating "${template.name}" (${template.id}):`, err);
        errorCount++;
      }
    }

    console.log('\n📊 Migration Summary:');
    console.log(`   ✅ Migrated: ${migratedCount}`);
    console.log(`   ⏭️  Skipped: ${skippedCount}`);
    console.log(`   ❌ Errors: ${errorCount}`);
    console.log('\n✨ Migration complete!');

  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
