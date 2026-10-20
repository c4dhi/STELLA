---
sidebar_position: 2
title: "States"
---

# States

States represent distinct phases of a conversation. Each state contains tasks to complete and defines rules for transitioning to other states.

## State Properties

| Property | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `id` | `string` | Yes | — | Unique identifier for this state |
| `title` | `string` | Yes | — | Display name for the state |
| `type` | `string` | No | `"loose"` | Execution mode (`strict` or `loose`) |
| `description` | `string` | No | `""` | Purpose of this state |
| `tasks` | `array` | No | `[]` | Tasks to complete in this state |
| `transitions` | `array` | No | `[]` | Rules for moving to other states |

## Execution Modes

The `type` field determines how the agent processes tasks within the state.

### STRICT Mode

Sequential task processing — one task at a time, in order.

```json
{
  "id": "medical-intake",
  "title": "Medical Intake",
  "type": "strict",
  "tasks": [
    { "id": "symptoms", "description": "Collect symptoms" },
    { "id": "duration", "description": "Collect duration" },
    { "id": "medications", "description": "Collect medications" }
  ]
}
```

**Characteristics:**
- Tasks execute in array order (symptoms → duration → medications)
- Agent completes one task before moving to the next
- User cannot skip ahead
- Ensures all prerequisite information is collected

**Best for:**
- Medical or legal intake forms
- Step-by-step wizards
- Processes requiring specific order
- Compliance-sensitive workflows

### LOOSE Mode

Flexible task processing — agent chooses naturally based on conversation flow.

```json
{
  "id": "general-inquiry",
  "title": "General Inquiry",
  "type": "loose",
  "tasks": [
    { "id": "topic", "description": "Understand topic of interest" },
    { "id": "preferences", "description": "Learn user preferences" },
    { "id": "budget", "description": "Determine budget range" }
  ]
}
```

**Characteristics:**
- Agent can address tasks in any order
- Natural conversation flow
- User can provide information proactively
- Agent adapts to user's responses

**Best for:**
- Customer support conversations
- Sales discovery calls
- General information gathering
- Exploratory conversations

### GOAL Mode

A natural conversation towards an objective. The agent is not shown a task list; it sees what is still missing towards the goal and asks for it in its own words.

```json
{
  "id": "explore-routine",
  "title": "Daily Routine",
  "type": "goal",
  "tasks": [],
  "goal": {
    "objective": "Understand what a normal day looks like for the participant",
    "success_description": "We know when they get up, what fills the morning, and what they look forward to",
    "deliverables": [
      { "key": "morning_routine", "description": "What the participant does in the morning", "required": true }
    ]
  },
  "transitions": [
    { "target_state_id": "wrap-up", "condition_type": "goal_achieved" }
  ]
}
```

**How a goal step ends (since 1.4.0):**
- The goal is the state's one task. The agent closes it when the success description is met, or gives it up when the participant declines the subject or asks to move on. The outcome is kept for this state only.
- Before it closes or gives up the goal, a separate check has to agree, quoting the participant's own words. Small talk, a vague "maybe", or a required answer still marked unconfirmed does not reach a goal.
- Closing is refused while a required deliverable of the state is missing. If the state's routes read deliverables, one matching route is enough; when none matches, any one of their keys is asked for.
- A closed goal whose routes match nothing moves on to the next state in plan order. The stuck-state safety net still releases a goal step that makes no progress, and records it as skipped.
- Insights the agent notices beyond the declared deliverables are kept (up to 25 per session) but don't count as progress.
- A goal state's `tasks` stay empty. Tasks left over from switching a state from flexible to goal are a known issue ([#770](https://github.com/c4dhi/STELLA/issues/770)).

**Best for:**
- Coaching and reflective conversations
- Interviews where the conversation should feel open
- Discovery, where the order of topics doesn't matter

## Comparison Table

| Aspect | STRICT | LOOSE | GOAL |
|--------|--------|-------|------|
| Task Order | Sequential | Flexible | No task list, gaps towards a goal |
| User Control | Limited | High | High |
| Conversation Feel | Structured | Natural | Open conversation |
| Skip Tasks | Not allowed | Agent decides | The goal can be given up, after a check |
| Use Case | Forms, intake | Discovery, support | Coaching, interviews |

## State Transitions

Transitions define when and how to move from one state to another.

### Transition Properties

| Property | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `target_state_id` | `string` | Yes | — | State to transition to |
| `condition_type` | `string` | No | `"all_tasks_complete"` | Type of condition to evaluate |
| `priority` | `number` | No | `1` | Lower = higher priority |
| `condition_config` | `object` | No | `{}` | Additional condition parameters |

### Condition Types

The state machine supports the following `condition_type` values:

| Condition Type | Purpose | Added In |
|----------------|---------|----------|
| `all_tasks_complete` | Transition once every task in the current state has been addressed (completed or skipped) | Existing |
| `goal_achieved` | Transition once a goal state's goal has been closed or given up (the default for `type: "goal"`; ends through the state's own task since 1.4.0) | Existing |
| `deliverable_exists` | Transition when a deliverable key has been collected | Existing |
| `deliverable_value` | Transition when a deliverable equals a specific value | Existing |
| `turn_count_exceeded` | Guardrail transition based on turn count | Ticket 5 |
| `deliverable_value_in` | Transition when a deliverable matches one of several values | Ticket 5 |
| `deliverable_value_numeric` | Numeric comparison (`gt`, `gte`, `lt`, `lte`, `eq`, `neq`, `between`) | Ticket 5 |
| `all_of` | Composite AND over nested child conditions | Ticket 5 |
| `any_of` | Composite OR over nested child conditions | Ticket 5 |
| `compound` | Composite with explicit operator (`and` or `or`) | Ticket 5 |

### Existing Conditions

#### `all_tasks_complete`

Transitions once **every** task in the current state — required *and* optional — has been addressed (completed or skipped). A task with deliverables is addressed automatically when its required deliverables are collected (or, for an all-optional task, once every declared deliverable is collected); a deliverable-less task must be completed or skipped explicitly. A newly entered state is never vacuously complete. See [Task Completion](./tasks.md#task-completion) for the full rules.

```json
{
  "target_state_id": "review",
  "condition_type": "all_tasks_complete",
  "priority": 1
}
```

#### `deliverable_exists`

Transitions when a deliverable key has any collected value.

```json
{
  "target_state_id": "has_referral",
  "condition_type": "deliverable_exists",
  "priority": 1,
  "condition_config": {
    "key": "referral_code"
  }
}
```

#### `deliverable_value`

Transitions when a deliverable equals a specific value.

```json
{
  "target_state_id": "premium_support",
  "condition_type": "deliverable_value",
  "priority": 1,
  "condition_config": {
    "key": "membership_type",
    "value": "premium"
  }
}
```

### New Conditions from Ticket 5

#### `turn_count_exceeded`

Transitions when turn counters cross a threshold. Use this for fallback routing when users get stuck.

```json
{
  "target_state_id": "clarify_or_handoff",
  "condition_type": "turn_count_exceeded",
  "priority": 5,
  "condition_config": {
    "turns": 3,
    "scope": "without_progress"
  }
}
```

- `scope: "without_progress"` tracks consecutive turns without completing work
- `scope: "total"` tracks total turns in the current state

#### `deliverable_value_in`

Transitions when a deliverable value is in an allowed set.

```json
{
  "target_state_id": "high_priority_queue",
  "condition_type": "deliverable_value_in",
  "priority": 2,
  "condition_config": {
    "key": "issue_category",
    "values": ["billing_error", "payment_failed", "account_locked"]
  }
}
```

#### `deliverable_value_numeric`

Transitions when a numeric deliverable satisfies a comparison rule.

Example 1: threshold check

```json
{
  "target_state_id": "urgent_path",
  "condition_type": "deliverable_value_numeric",
  "priority": 1,
  "condition_config": {
    "key": "risk_score",
    "operator": "gte",
    "value": 8
  }
}
```

Example 2: range check

```json
{
  "target_state_id": "moderate_path",
  "condition_type": "deliverable_value_numeric",
  "priority": 2,
  "condition_config": {
    "key": "risk_score",
    "operator": "between",
    "min": 4,
    "max": 7,
    "inclusive": true
  }
}
```

#### `all_of`

Transitions only when all child conditions are true.

```json
{
  "target_state_id": "eligible_fast_track",
  "condition_type": "all_of",
  "priority": 1,
  "condition_config": {
    "conditions": [
      {
        "condition_type": "deliverable_exists",
        "condition_config": { "key": "consent" }
      },
      {
        "condition_type": "deliverable_value",
        "condition_config": { "key": "age_verified", "value": true }
      }
    ]
  }
}
```

#### `any_of`

Transitions when at least one child condition is true.

```json
{
  "target_state_id": "expedited_checkout",
  "condition_type": "any_of",
  "priority": 1,
  "condition_config": {
    "conditions": [
      {
        "condition_type": "deliverable_exists",
        "condition_config": { "key": "express_checkout" }
      },
      {
        "condition_type": "deliverable_exists",
        "condition_config": { "key": "saved_payment_method" }
      }
    ]
  }
}
```

#### `compound`

Composite condition with explicit logical operator.

```json
{
  "target_state_id": "ready_to_close",
  "condition_type": "compound",
  "priority": 1,
  "condition_config": {
    "operator": "and",
    "conditions": [
      {
        "condition_type": "deliverable_exists",
        "condition_config": { "key": "summary_confirmed" }
      },
      {
        "condition_type": "deliverable_value",
        "condition_config": { "key": "approval_status", "value": "approved" }
      }
    ]
  }
}
```

## UI and JSON Support

The visual Plan Builder currently exposes three condition types in the edge editor:

- `all_tasks_complete`
- `deliverable_exists`
- `deliverable_value`

Advanced conditions from Ticket 5 are supported in plan JSON and runtime evaluation. They can be authored directly in JSON today.

### Transition Priority

When multiple transition conditions are satisfied, the transition with the lowest `priority` value wins.

```json
{
  "transitions": [
    {
      "target_state_id": "emergency",
      "condition_type": "deliverable_value",
      "priority": 1,
      "condition_config": {
        "key": "urgency",
        "value": "emergency"
      }
    },
    {
      "target_state_id": "standard-flow",
      "condition_type": "all_tasks_complete",
      "priority": 10
    }
  ]
}
```

In this example:
- If `urgency` equals `"emergency"`, go to `emergency` state (priority 1)
- Otherwise, when all tasks complete, go to `standard-flow` (priority 10)

## Complete State Example

```json
{
  "id": "customer-intake",
  "title": "Customer Intake",
  "type": "strict",
  "description": "Collect essential customer information before routing",
  "tasks": [
    {
      "id": "identify",
      "description": "Identify Customer",
      "instruction": "Ask for the customer's name and account number",
      "required": true,
      "deliverables": [
        {
          "key": "customer_name",
          "type": "string",
          "required": true
        },
        {
          "key": "account_number",
          "type": "string",
          "required": true
        }
      ]
    },
    {
      "id": "classify",
      "description": "Classify Issue",
      "instruction": "Determine the type of issue: billing, technical, or general",
      "required": true,
      "deliverables": [
        {
          "key": "issue_type",
          "type": "enum",
          "enum_values": ["billing", "technical", "general"],
          "required": true
        }
      ]
    }
  ],
  "transitions": [
    {
      "target_state_id": "billing-support",
      "condition_type": "deliverable_value",
      "priority": 1,
      "condition_config": {
        "key": "issue_type",
        "value": "billing"
      }
    },
    {
      "target_state_id": "technical-support",
      "condition_type": "deliverable_value",
      "priority": 1,
      "condition_config": {
        "key": "issue_type",
        "value": "technical"
      }
    },
    {
      "target_state_id": "general-support",
      "condition_type": "all_tasks_complete",
      "priority": 10
    }
  ]
}
```

## State Flow Diagram

A typical conversation flows through multiple states:

```
┌─────────────┐
│   Greeting  │  (loose) - Welcome user, collect name
└──────┬──────┘
       │ all_tasks_complete
       ▼
┌─────────────┐
│   Intake    │  (strict) - Collect required information
└──────┬──────┘
       │ deliverable_value (based on issue_type)
       ▼
┌─────────────────────────────────────┐
│  Billing │ Technical │   General   │
└────┬─────┴─────┬─────┴──────┬──────┘
     │           │            │
     └───────────┼────────────┘
                 │ all_tasks_complete
                 ▼
          ┌─────────────┐
          │   Farewell  │  (strict) - Close conversation
          └─────────────┘
```

## Next Steps

- [Tasks](./tasks.md) — Learn about task configuration
- [Deliverables](./deliverables.md) — Configure data collection
- [Examples](./examples.md) — See complete plan examples
