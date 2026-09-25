import {
  Injectable,
  Logger,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';
import { GeneratePlanTemplateDto } from './dto/generate-plan-template.dto';

// Canonical plan types matching stella-ai-agent-sdk/plan
interface PlanDeliverable {
  key: string;
  type: 'string' | 'number' | 'boolean' | 'enum';
  description: string;
  required: boolean;
  acceptance_criteria?: string;
  enum_values?: string[];
}

interface PlanTask {
  id: string;
  description: string;
  instruction?: string;
  required: boolean;
  deliverables: PlanDeliverable[];
}

interface StateTransition {
  target_state_id: string;
  condition_type?: string;
  priority?: number;
  condition_config?: Record<string, unknown>;
}

interface StateGoal {
  objective: string;
  context?: string;
  depth_guidance?: string;
  boundaries?: string;
  success_description?: string;
  deliverables?: PlanDeliverable[];
}

interface PlanState {
  id: string;
  title: string;
  type: 'strict' | 'loose' | 'goal';
  description?: string;
  tasks: PlanTask[];
  transitions?: StateTransition[];
  goal?: StateGoal;
}

interface PlanContent {
  id: string;
  title: string;
  description?: string;
  initial_state_id?: string;
  states: PlanState[];
  metadata?: Record<string, unknown>;
  system_prompt?: string;
  // ISO 639-1 code the conversation is conducted in. Pins STT transcription for
  // the session; omitted/"auto" falls back to per-utterance detection, which is
  // unreliable on short turns and translates rather than mis-hears when wrong.
  language?: string;
}

export interface GeneratePlanTemplateResponse {
  content: PlanContent;
  suggestedName: string;
  suggestedDescription: string;
}

@Injectable()
export class PlanGeneratorService {
  private readonly logger = new Logger(PlanGeneratorService.name);
  private readonly openai: OpenAI | null = null;

  constructor(private configService: ConfigService) {
    const apiKey = this.configService.get<string>(
      'OPENAI_PLAN_GENERATOR_API_KEY',
    );
    if (apiKey) {
      this.openai = new OpenAI({ apiKey });
      this.logger.log('Plan Generator initialized with OpenAI');
    } else {
      this.logger.warn(
        'OPENAI_PLAN_GENERATOR_API_KEY not configured - plan generation disabled',
      );
    }
  }

  async generate(
    dto: GeneratePlanTemplateDto,
  ): Promise<GeneratePlanTemplateResponse> {
    if (!this.openai) {
      throw new InternalServerErrorException(
        'Plan generation is not configured. Please set OPENAI_PLAN_GENERATOR_API_KEY.',
      );
    }

    const systemPrompt = this.buildSystemPrompt();
    const userPrompt = this.buildUserPrompt(dto);

    try {
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.7,
        max_tokens: 4000,
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new InternalServerErrorException('Empty response from OpenAI');
      }

      const parsed = JSON.parse(content) as GeneratePlanTemplateResponse;
      return this.validateAndNormalizeResponse(parsed);
    } catch (error) {
      this.logger.error('Plan generation failed', error);
      if (error instanceof SyntaxError) {
        throw new InternalServerErrorException('Failed to parse AI response');
      }
      if (error instanceof InternalServerErrorException) {
        throw error;
      }
      throw new InternalServerErrorException(
        'Failed to generate plan. Please try again.',
      );
    }
  }

  private buildSystemPrompt(): string {
    return `You are an expert at designing structured conversation plans for AI voice agents.
Your task is to generate a PlanContent JSON structure based on user descriptions.

IMPORTANT CONCEPT HIERARCHY:
- STATE = A distinct phase in the conversation (e.g., "Greeting", "Questions", "Farewell")
- TASK = A granular to-do item within a state (e.g., "Learn the user's name", "Ask about workout frequency")
- DELIVERABLE = A single data variable that a task produces (e.g., "user_name", "workout_frequency")

Think of it like this:
- States are like chapters in a conversation
- Tasks are individual questions or micro-goals (usually 1 deliverable per task)
- Deliverables are the actual data points/variables collected

STATE TYPES — choose carefully based on the conversational intent:
- "strict": Tasks are completed sequentially, one at a time. Use for: tutorials, games, guided flows where order matters.
- "loose": Tasks can be completed in any order, agent chooses. Use for: surveys, intake forms, structured data collection.
- "goal": Agent has a NATURAL CONVERSATION toward an objective. Tasks are invisible to the agent — it sees information gaps instead. Use for: coaching, interviews, therapy, discovery conversations, any state where natural dialogue matters more than task execution. REQUIRES a "goal" object.

When using type "goal", you MUST include a "goal" object on the state. Deliverables go DIRECTLY on the goal object (NOT inside tasks). The "tasks" array should be empty for goal states. The agent will also automatically discover and capture relevant insights that weren't pre-defined.
{
  "goal": {
    "objective": "What the conversation should achieve",
    "context": "Background the AI needs to understand the domain",
    "depth_guidance": "How deep to probe — when to accept answers vs push further",
    "boundaries": "What topics to avoid (covered elsewhere or out of scope)",
    "success_description": "What a well-conducted version of this phase looks like",
    "deliverables": [
      {
        "key": "variable_name",
        "description": "What this captures",
        "type": "string",
        "required": true,
        "acceptance_criteria": "What constitutes a valid answer"
      }
    ]
  }
}

The structure must follow this exact schema:
{
  "content": {
    "id": "plan_<unique_id>",
    "title": "Plan name",
    "description": "Brief description of the plan purpose",
    "initial_state_id": "state_<first_state_id>",
    "states": [
      {
        "id": "state_<unique_id>",
        "title": "State Name",
        "type": "strict" | "loose" | "goal",
        "description": "What this phase accomplishes",
        "goal": { ... },
        "tasks": [
          {
            "id": "task_<unique_id>",
            "description": "What to ask/do (for strict/loose states only — goal states use goal.deliverables instead)",
            "instruction": "How to ask it (optional)",
            "required": true | false,
            "deliverables": [
              {
                "key": "variable_name",
                "description": "What this captures",
                "type": "string" | "number" | "boolean" | "enum",
                "required": true | false,
                "acceptance_criteria": "What constitutes a valid, complete answer. Include concrete examples of good and bad answers.",
                "enum_values": ["option1", "option2"]
              }
            ]
          }
        ],
        "transitions": [
          {
            "target_state_id": "state_<target_id>",
            "condition_type": "all_tasks_complete" | "goal_achieved" | "turn_count_exceeded" | "deliverable_value" | "deliverable_value_in" | "deliverable_value_numeric" | "deliverable_exists" | "all_of" | "any_of" | "compound",
            "priority": 1,
            "condition_config": {}
          }
        ]
      }
    ],
    "system_prompt": "AI agent persona description",
    "metadata": {}
  },
  "suggestedName": "Short plan name (max 50 chars)",
  "suggestedDescription": "Brief description (1-2 sentences)"
}

EXAMPLE 1 — Structured plan with strict/loose states:

{
  "content": {
    "id": "plan_fitness_checkin",
    "title": "Fitness Activity Check-in",
    "description": "A brief conversation to learn about someone's exercise habits",
    "initial_state_id": "state_greeting",
    "states": [
      {
        "id": "state_greeting",
        "title": "Greeting",
        "type": "strict",
        "description": "Welcome the user and get their name",
        "tasks": [
          {
            "id": "task_welcome",
            "description": "Greet and ask for name",
            "instruction": "Warmly greet the user and ask what they'd like to be called",
            "required": true,
            "deliverables": [
              {
                "key": "user_name",
                "description": "User's preferred name",
                "type": "string",
                "required": true,
                "acceptance_criteria": "A real name or nickname the user wants to be called. E.g. 'Sarah', 'Mike', 'Dr. Johnson'. Reject generic non-answers like 'nobody' or 'doesn't matter'."
              }
            ]
          }
        ]
      },
      {
        "id": "state_fitness_questions",
        "title": "Fitness Activity",
        "type": "loose",
        "description": "Learn about the user's exercise habits",
        "tasks": [
          {
            "id": "task_workout_type",
            "description": "Ask about preferred exercise",
            "instruction": "Ask what type of exercise they enjoy most",
            "required": true,
            "deliverables": [
              {
                "key": "preferred_exercise",
                "description": "Type of exercise they prefer",
                "type": "enum",
                "required": true,
                "enum_values": ["Running", "Swimming", "Gym/Weights", "Yoga", "Team Sports", "Other"],
                "acceptance_criteria": "Must be a specific activity type. If user says 'cardio', probe for which specific cardio activity."
              }
            ]
          },
          {
            "id": "task_frequency",
            "description": "Ask about workout frequency",
            "required": true,
            "deliverables": [
              {
                "key": "weekly_frequency",
                "description": "Times per week they exercise",
                "type": "number",
                "required": true,
                "acceptance_criteria": "A specific number between 0-7. If they say 'a few times' or 'sometimes', pin down the exact number."
              }
            ]
          },
          {
            "id": "task_goals",
            "description": "Ask about fitness goals",
            "required": false,
            "deliverables": [
              {
                "key": "fitness_goal",
                "description": "Their main fitness objective",
                "type": "string",
                "required": false,
                "acceptance_criteria": "A specific, measurable goal. E.g. 'Lose 10kg by summer', 'Run a marathon in under 4 hours'. Reject vague answers like 'get healthier' or 'be more fit' — probe for specifics."
              }
            ]
          }
        ]
      },
      {
        "id": "state_farewell",
        "title": "Farewell",
        "type": "strict",
        "description": "Thank the user and close the conversation",
        "tasks": [
          {
            "id": "task_thank_and_close",
            "description": "Thank user and say goodbye",
            "instruction": "Summarize what you learned, thank them, and wish them well",
            "required": true,
            "deliverables": []
          }
        ]
      }
    ],
    "system_prompt": "You are a friendly fitness coach conducting a quick check-in. Be encouraging and enthusiastic about exercise. Use casual, supportive language.",
    "language": "en"
  },
  "suggestedName": "Fitness Activity Check-in",
  "suggestedDescription": "A brief conversation to learn about someone's exercise habits and fitness goals."
}

EXAMPLE 2 — Goal-oriented plan for natural conversation:

{
  "content": {
    "id": "plan_coaching_session",
    "title": "Life Coaching Discovery",
    "description": "A natural coaching conversation to understand the client's current situation and aspirations",
    "initial_state_id": "state_rapport",
    "states": [
      {
        "id": "state_rapport",
        "title": "Build Rapport",
        "type": "goal",
        "description": "Establish a warm connection and understand who the client is",
        "goal": {
          "objective": "Build genuine rapport and learn who the client is as a person",
          "context": "This is a first coaching session. The client may be nervous or unsure what to expect.",
          "depth_guidance": "Let the conversation breathe. Don't rush to collect information. If they share something personal, acknowledge it before moving on. Accept brief answers for name/role but probe gently on what brought them here.",
          "boundaries": "Don't dive into problems or goals yet — this phase is about connection, not assessment.",
          "success_description": "The client feels heard and comfortable. You know their name, what they do, and have a sense of what prompted them to seek coaching.",
          "deliverables": [
            {
              "key": "client_name",
              "description": "Client's preferred name",
              "type": "string",
              "required": true,
              "acceptance_criteria": "Their preferred first name or nickname."
            },
            {
              "key": "client_role",
              "description": "What they do professionally or how they spend their time",
              "type": "string",
              "required": true,
              "acceptance_criteria": "A brief description of their work or life situation. E.g. 'marketing manager at a startup', 'retired teacher', 'stay-at-home parent'. One sentence is fine."
            },
            {
              "key": "coaching_trigger",
              "description": "What prompted them to seek coaching",
              "type": "string",
              "required": true,
              "acceptance_criteria": "A genuine reason, not just 'I thought it would be good'. Should reveal some emotional or situational driver. E.g. 'I got promoted and feel overwhelmed', 'going through a divorce', 'feeling stuck in my career for 2 years'."
            }
          ]
        },
        "tasks": []
      },
      {
        "id": "state_exploration",
        "title": "Explore Aspirations",
        "type": "goal",
        "description": "Understand what the client wants to change or achieve",
        "goal": {
          "objective": "Discover what the client truly wants — not just surface goals but underlying desires and values",
          "context": "You've built initial rapport. The client is now more comfortable sharing.",
          "depth_guidance": "Push past surface-level goals. If they say 'I want to be happier', ask what happiness looks like for them specifically. Use open questions. Reflect back what you hear to confirm understanding. Aim for 2-3 exchanges per deliverable, not one-shot extraction.",
          "boundaries": "Don't offer solutions or advice yet. This is about understanding, not fixing. Don't diagnose or label their situation.",
          "success_description": "You understand 1-2 concrete things they want to change, why those matter to them, and what's been getting in the way.",
          "deliverables": [
            {
              "key": "primary_goal",
              "description": "The main thing they want to change or achieve",
              "type": "string",
              "required": true,
              "acceptance_criteria": "A specific, personally meaningful goal. Must go beyond surface level. E.g. 'I want to set boundaries at work so I can be present with my kids' not just 'better work-life balance'."
            },
            {
              "key": "underlying_value",
              "description": "The value or need driving their goal",
              "type": "string",
              "required": false,
              "acceptance_criteria": "A core value or emotional need. E.g. 'autonomy', 'being a good parent', 'feeling competent'. This may emerge naturally — don't force it."
            },
            {
              "key": "main_obstacle",
              "description": "The primary barrier to their goal",
              "type": "string",
              "required": true,
              "acceptance_criteria": "A specific obstacle, not a vague complaint. E.g. 'My manager expects me to be available 24/7 and I can't say no' not just 'work is stressful'."
            }
          ]
        },
        "tasks": []
      },
      {
        "id": "state_closing",
        "title": "Closing",
        "type": "strict",
        "description": "Summarize and close the session warmly",
        "tasks": [
          {
            "id": "task_close",
            "description": "Reflect back and close",
            "instruction": "Summarize the key themes you heard, validate their courage in sharing, and close warmly",
            "required": true,
            "deliverables": []
          }
        ]
      }
    ],
    "system_prompt": "You are a warm, experienced life coach conducting a discovery session. Listen more than you speak. Use reflective listening. Be genuinely curious about their experience. Never judge or prescribe — your role is to understand."
  },
  "suggestedName": "Life Coaching Discovery",
  "suggestedDescription": "A natural coaching conversation to understand the client's situation, aspirations, and obstacles."
}

EXAMPLE 3 — Conditional branching transitions:

{
  "content": {
    "id": "plan_support_router",
    "title": "Support Triage Flow",
    "description": "Route users based on issue type and urgency",
    "initial_state_id": "state_intake",
    "states": [
      {
        "id": "state_intake",
        "title": "Intake",
        "type": "loose",
        "description": "Collect routing signals",
        "tasks": [
          {
            "id": "task_issue_type",
            "description": "Capture issue type",
            "required": true,
            "deliverables": [
              {
                "key": "issue_type",
                "description": "Category of issue",
                "type": "enum",
                "required": true,
                "enum_values": ["billing", "technical", "account"],
                "acceptance_criteria": "Must map to one of the listed categories."
              }
            ]
          },
          {
            "id": "task_urgency_score",
            "description": "Capture urgency score",
            "required": true,
            "deliverables": [
              {
                "key": "urgency_score",
                "description": "Urgency from 1 to 10",
                "type": "number",
                "required": true,
                "acceptance_criteria": "A number between 1 and 10."
              }
            ]
          }
        ],
        "transitions": [
          {
            "target_state_id": "state_priority_queue",
            "condition_type": "all_of",
            "priority": 1,
            "condition_config": {
              "conditions": [
                {
                  "condition_type": "deliverable_value_in",
                  "condition_config": {
                    "key": "issue_type",
                    "values": ["billing", "account"]
                  }
                },
                {
                  "condition_type": "deliverable_value_numeric",
                  "condition_config": {
                    "key": "urgency_score",
                    "operator": "gte",
                    "value": 7
                  }
                }
              ]
            }
          },
          {
            "target_state_id": "state_standard_queue",
            "condition_type": "all_tasks_complete",
            "priority": 99
          }
        ]
      },
      {
        "id": "state_priority_queue",
        "title": "Priority Queue",
        "type": "strict",
        "description": "Handle urgent requests first",
        "tasks": []
      },
      {
        "id": "state_standard_queue",
        "title": "Standard Queue",
        "type": "strict",
        "description": "Handle normal priority requests",
        "tasks": []
      }
    ],
    "system_prompt": "You are a calm support triage assistant. Gather facts clearly and route deterministically."
  },
  "suggestedName": "Support Triage Flow",
  "suggestedDescription": "Routes users by issue category and urgency."
}

EXAMPLE 4 — Branching with explicit fallback path:

{
  "content": {
    "id": "plan_intake_router",
    "title": "Onboarding Intake Router",
    "description": "Route users into onboarding, escalation, or standard follow-up based on responses",
    "initial_state_id": "state_initial_assessment",
    "states": [
      {
        "id": "state_initial_assessment",
        "title": "Initial Assessment",
        "type": "loose",
        "description": "Collect account status, intent, and urgency",
        "tasks": [
          {
            "id": "task_account_status",
            "description": "Capture account status",
            "required": true,
            "deliverables": [
              {
                "key": "account_status",
                "description": "Current customer account state",
                "type": "enum",
                "required": true,
                "enum_values": ["new", "active", "blocked"],
                "acceptance_criteria": "Must resolve to one of: new, active, blocked. Reject unclear answers like 'kind of active' without clarification."
              }
            ]
          },
          {
            "id": "task_request_intent",
            "description": "Capture request intent",
            "required": true,
            "deliverables": [
              {
                "key": "intent",
                "description": "What the user wants to do",
                "type": "enum",
                "required": true,
                "enum_values": ["setup_help", "technical_issue", "billing_question"],
                "acceptance_criteria": "Must map to setup_help, technical_issue, or billing_question."
              }
            ]
          },
          {
            "id": "task_urgency",
            "description": "Capture urgency score",
            "required": true,
            "deliverables": [
              {
                "key": "urgency_score",
                "description": "Urgency from 1 to 10",
                "type": "number",
                "required": true,
                "acceptance_criteria": "Integer from 1 to 10. Reject values outside range."
              }
            ]
          }
        ],
        "transitions": [
          {
            "target_state_id": "state_escalation",
            "condition_type": "any_of",
            "priority": 1,
            "condition_config": {
              "conditions": [
                {
                  "condition_type": "deliverable_value",
                  "condition_config": { "key": "account_status", "value": "blocked" }
                },
                {
                  "condition_type": "deliverable_value_numeric",
                  "condition_config": { "key": "urgency_score", "operator": "gte", "value": 8 }
                }
              ]
            }
          },
          {
            "target_state_id": "state_guided_onboarding",
            "condition_type": "deliverable_value",
            "priority": 5,
            "condition_config": { "key": "account_status", "value": "new" }
          },
          {
            "target_state_id": "state_standard_followup",
            "condition_type": "all_tasks_complete",
            "priority": 99
          }
        ]
      },
      {
        "id": "state_escalation",
        "title": "Escalation",
        "type": "strict",
        "description": "Collect details and route to senior support",
        "tasks": []
      },
      {
        "id": "state_guided_onboarding",
        "title": "Guided Onboarding",
        "type": "strict",
        "description": "Help new users complete setup confidently",
        "tasks": []
      },
      {
        "id": "state_standard_followup",
        "title": "Standard Follow-up",
        "type": "strict",
        "description": "Handle normal requests with standard workflow",
        "tasks": []
      }
    ],
    "system_prompt": "You are a practical onboarding specialist. Ask clear questions, classify intent accurately, and route users to the right next step without over-talking."
  },
  "suggestedName": "Onboarding Intake Router",
  "suggestedDescription": "Routes users to escalation, onboarding, or standard flow using explicit branching transitions."
}

Guidelines:
1. REQUIRED FIELDS: Always include id, title, description, and initial_state_id in content
2. STATES = conversation phases (typically 2-4 states)
3. TASKS = granular to-dos, usually ONE question per task. Only used in strict/loose states. Goal states use goal.deliverables instead.
4. DELIVERABLES = individual variables. In strict/loose states: nested inside tasks (usually 1 per task). In goal states: placed directly on the goal object.
5. STATE TYPE selection:
   - Use "strict" when order matters (games, tutorials, onboarding). Deliverables go inside tasks.
   - Use "loose" when questions can be asked in any order (surveys, intake forms). Deliverables go inside tasks.
   - Use "goal" when natural conversation matters most (coaching, interviews, therapy, discovery). Deliverables go on the goal object. Tasks array should be empty. The agent will also discover additional insights beyond the defined deliverables.
6. Keep plans SHORT and focused - this is for brief voice conversations
7. Use appropriate types: string (open text), number (counts), boolean (yes/no), enum (choices)
8. Generate snake_case keys for deliverables: user_name, workout_frequency, etc.
9. ALWAYS include acceptance_criteria for deliverables — describe what constitutes a valid answer, include concrete examples of good AND bad answers
10. ALWAYS generate a system_prompt with:
    - Clear role (e.g., "You are a friendly fitness coach...")
    - Communication style (casual, professional, enthusiastic, etc.)
    - 2-3 sentences max
10b. ALWAYS set "language" to the ISO 639-1 code you wrote the plan in — if the
    instructions and system_prompt are German, set "language": "de". This pins
    speech recognition for the session. Omitting it leaves the language to be
    guessed per utterance from under a second of audio, which is how a German
    plan ends up transcribed (and answered) in English.
11. For goal states, the "goal" object is critical — it tells the AI HOW to conduct the conversation, not just WHAT to collect
12. TRANSITIONS:
    - Always include transitions for each non-terminal state.
    - Always set an explicit numeric priority.
    - Lower priority number is evaluated first.
    - For goal states, use ONLY "goal_achieved", "deliverable_exists", or "deliverable_value".
    - Never use "all_tasks_complete" for goal states.
    - For strict/loose states, never use "goal_achieved".
    - Keep fallback transitions last (typically "all_tasks_complete" with a high priority value for strict/loose states).
    - For branching plans, include at least one state with 2+ outgoing transitions that have distinct priorities.
    - For branching plans, include an explicit fallback path (usually "all_tasks_complete" with high priority like 99).
    - Keep fallback transitions last (typically "all_tasks_complete" with a high priority value).
13. CONDITION CONFIG PATTERNS:
    - "deliverable_value": { "key": "...", "value": ... }
    - "deliverable_value_in": { "key": "...", "values": [ ... ] }
    - "deliverable_value_numeric": { "key": "...", "operator": "gt|gte|lt|lte|eq|neq|between", "value": n } OR { "key": "...", "operator": "between", "min": n, "max": n, "inclusive": true|false }
    - "deliverable_exists": { "key": "..." }
    - "goal_achieved": {} (no config required, goal states only)
    - "turn_count_exceeded": { "turns": n, "scope": "without_progress" | "total" }
    - "all_of": { "conditions": [ { "condition_type": "...", "condition_config": { ... } }, ... ] }
    - "any_of": { "conditions": [ { "condition_type": "...", "condition_config": { ... } }, ... ] }
    - "compound": { "operator": "and" | "or", "conditions": [ ... ] }

Respond ONLY with valid JSON matching the schema above.`;
  }

  private buildUserPrompt(dto: GeneratePlanTemplateDto): string {
    let prompt = `Generate a structured plan for the following:\n\n${dto.prompt}`;
    if (dto.context) {
      prompt += `\n\nAdditional context: ${dto.context}`;
    }
    return prompt;
  }

  private validateAndNormalizeResponse(
    response: GeneratePlanTemplateResponse,
  ): GeneratePlanTemplateResponse {
    // Ensure all IDs are proper UUIDs (don't rely on AI-generated IDs)
    if (!response.content?.states) {
      throw new InternalServerErrorException(
        'Invalid response structure: missing states',
      );
    }

    // Generate proper UUIDs for all plan elements
    response.content.id = uuidv4();
    response.content.title =
      response.content.title || response.suggestedName || 'Generated Plan';
    response.content.description =
      response.content.description || response.suggestedDescription || '';

    // First pass: Create mapping from old state IDs to new UUIDs
    const stateIdMap = new Map<string, string>();
    for (const state of response.content.states) {
      const oldId = state.id || '';
      const newId = uuidv4();
      stateIdMap.set(oldId, newId);
    }

    // Second pass: Update states with new IDs and fix transition references
    response.content.states = response.content.states.map((state) => ({
      ...state,
      id: stateIdMap.get(state.id || '') || uuidv4(),
      title: state.title || 'Untitled State',
      type: state.type || 'loose',
      // Preserve and normalize goal object for goal-type states
      goal: state.type === 'goal' && state.goal ? {
        objective: state.goal.objective || '',
        context: state.goal.context,
        depth_guidance: state.goal.depth_guidance,
        boundaries: state.goal.boundaries,
        success_description: state.goal.success_description,
        deliverables: (state.goal.deliverables || []).map((del) => ({
          ...del,
          key: del.key || `deliverable_${uuidv4().slice(0, 8)}`,
          description: del.description || 'Unnamed deliverable',
          type: del.type || 'string',
          required: del.required ?? true,
        })),
      } : undefined,
      tasks: (state.tasks || []).map((task) => ({
        ...task,
        id: uuidv4(), // Always use UUID for task IDs
        description: task.description || 'Untitled Task',
        required: task.required ?? true,
        deliverables: (task.deliverables || []).map((del) => ({
          ...del,
          // Keep deliverable keys as snake_case identifiers (not UUIDs)
          // These are used as variable names, so should be meaningful
          key: del.key || `deliverable_${uuidv4().slice(0, 8)}`,
          description: del.description || 'Unnamed deliverable',
          type: del.type || 'string',
          required: del.required ?? true,
        })),
      })),
      // Update transition target_state_ids to use new UUIDs
      transitions: (state.transitions || []).map((trans) => ({
        ...trans,
        target_state_id:
          stateIdMap.get(trans.target_state_id) || trans.target_state_id,
      })),
    }));

    // Set initial_state_id to first state if not provided
    if (
      !response.content.initial_state_id &&
      response.content.states.length > 0
    ) {
      response.content.initial_state_id = response.content.states[0].id;
    }

    // Auto-generate transitions if missing
    // Each state (except the last) gets a transition to the next state
    response.content.states = response.content.states.map((state, index) => {
      // If state already has transitions, keep them
      if (state.transitions && state.transitions.length > 0) {
        return state;
      }

      // If this is the last state, no transition needed
      if (index === response.content.states.length - 1) {
        return { ...state, transitions: [] };
      }

      // Generate default transition to next state
      const nextStateId = response.content.states[index + 1].id;
      return {
        ...state,
        transitions: [
          {
            target_state_id: nextStateId,
            condition_type: state.type === 'goal' ? 'goal_achieved' : 'all_tasks_complete',
            priority: 1,
          },
        ],
      };
    });

    this.logger.log(
      `Generated transitions for ${response.content.states.length} states`,
    );

    // Ensure we have suggested name and description
    response.suggestedName = response.suggestedName || 'Generated Plan';
    response.suggestedDescription =
      response.suggestedDescription || 'AI-generated plan template';

    return response;
  }
}
