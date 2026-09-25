---
sidebar_position: 7
title: "JSON Schema Reference"
---

# Plan JSON Schema Reference

This page documents the full plan JSON structure used by STELLA, including builder metadata, transition condition schemas, and terminal-state modeling.

## Plan Root

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `id` | `string` | Recommended | Unique plan identifier |
| `title` | `string` | Recommended | Plan name |
| `description` | `string` | No | Short summary |
| `initial_state_id` | `string` | Recommended | Entry state |
| `states` | `PlanState[]` | Yes | Conversation states |
| `system_prompt` | `string` | No | Agent persona/style |
| `language` | `string` | No | ISO 639-1 code (e.g. `de`). Fixes the session to this language: speech recognition is pinned from the first utterance and language detection is switched off. A deployment-wide `STELLA_LANGUAGE` still takes precedence. Omit for auto-detect |
| `session_context` | `SessionContext` | No | Pre-session input fields |
| `metadata` | `PlanMetadata` | No | Builder metadata and custom extensions |

## PlanState Object

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `id` | `string` | Yes | State identifier |
| `title` | `string` | Yes | State label |
| `type` | `"strict" \| "loose" \| "goal"` | Yes | Execution mode |
| `description` | `string` | No | State purpose |
| `tasks` | `PlanTask[]` | Yes | Use empty array for terminal or goal-driven states |
| `transitions` | `StateTransition[]` | No | Outgoing routing rules |
| `goal` | `StateGoal` | Only for `type: "goal"` | Goal-mode context |

## PlanTask Object

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `id` | `string` | Yes | Task identifier |
| `description` | `string` | Yes | Task title |
| `instruction` | `string` | No | Execution guidance |
| `required` | `boolean` | No | Defaults to required behavior |
| `deliverables` | `PlanDeliverable[]` | No | Data to extract |

## PlanDeliverable Object

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `key` | `string` | Yes | Deliverable key in state data |
| `type` | `"string" \| "number" \| "boolean" \| "enum"` | Yes | Value type |
| `description` | `string` | Yes | What to capture |
| `required` | `boolean` | Yes | Required or optional |
| `acceptance_criteria` | `string` | No | Validation guidance |
| `enum_values` | `string[]` | For `enum` | Allowed values |

## StateTransition Object

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `target_state_id` | `string` | Yes | Destination state |
| `condition_type` | `StateTransitionConditionType` | Yes | Condition evaluator |
| `priority` | `number` | Recommended | Lower value runs first |
| `condition_config` | `object` | Depends | Shape depends on `condition_type` |

## StateTransitionConditionType

- `all_tasks_complete`
- `turn_count_exceeded`
- `deliverable_value`
- `deliverable_value_in`
- `deliverable_value_numeric`
- `deliverable_exists`
- `all_of`
- `any_of`
- `compound`

## Condition Config Schemas

### `all_tasks_complete`

No `condition_config` is required.

### `deliverable_exists`

```json
{ "key": "referral_code" }
```

### `deliverable_value`

```json
{ "key": "membership_type", "value": "premium" }
```

### `deliverable_value_in`

```json
{ "key": "issue_type", "values": ["billing", "account"] }
```

### `deliverable_value_numeric`

Comparison form:

```json
{ "key": "urgency_score", "operator": "gte", "value": 7 }
```

Range form:

```json
{ "key": "urgency_score", "operator": "between", "min": 4, "max": 7, "inclusive": true }
```

Supported operators: `gt`, `gte`, `lt`, `lte`, `eq`, `neq`, `between`.

### `turn_count_exceeded`

```json
{ "turns": 3, "scope": "without_progress" }
```

Supported scope values: `without_progress`, `total`.

### `all_of`

```json
{
  "conditions": [
    { "condition_type": "deliverable_exists", "condition_config": { "key": "consent" } },
    { "condition_type": "deliverable_value", "condition_config": { "key": "age_verified", "value": true } }
  ]
}
```

### `any_of`

```json
{
  "conditions": [
    { "condition_type": "deliverable_exists", "condition_config": { "key": "express_checkout" } },
    { "condition_type": "deliverable_exists", "condition_config": { "key": "saved_payment_method" } }
  ]
}
```

### `compound`

```json
{
  "operator": "and",
  "conditions": [
    { "condition_type": "deliverable_exists", "condition_config": { "key": "summary_confirmed" } },
    { "condition_type": "deliverable_value", "condition_config": { "key": "approval_status", "value": "approved" } }
  ]
}
```

Supported operator values: `and`, `or`.

## SessionContext Schema

```json
{
  "fields": [
    {
      "id": "participant_name",
      "label": "Your Name",
      "type": "string",
      "required": true,
      "description": "Shown before the session starts"
    }
  ]
}
```

Field type values: `string`, `number`, `boolean`, `select`.

`select` fields can include `options` and `default_value`.

## PlanMetadata Schema

Known Plan Builder metadata shape:

```json
{
  "plan_builder": {
    "start": {
      "agent_spawn_mode": "immediate"
    },
    "canvas": {
      "state_positions": {
        "state_intake": { "x": 420, "y": 180 }
      },
      "show_end_node": true,
      "end_node_position": { "x": 1200, "y": 220 },
      "end_state_ids": ["state_farewell"]
    }
  }
}
```

### Node Position Compatibility Note

Current canonical key: `metadata.plan_builder.canvas.state_positions`.

If legacy content refers to `metadata.nodePositions`, migrate to `metadata.plan_builder.canvas.state_positions`.

## End State Modeling

A terminal end path is represented by both execution and builder metadata:

- Execution-level termination:
  - final state has no onward transition path
  - terminal state often has `transitions: []`
- Builder-level visualization:
  - terminal states can be listed in `metadata.plan_builder.canvas.end_state_ids`

## Complete Example

```json
{
  "id": "plan_support_router",
  "title": "Support Router",
  "description": "Routes conversations by category and urgency",
  "initial_state_id": "state_intake",
  "system_prompt": "You are a concise support routing assistant.",
  "session_context": {
    "fields": [
      {
        "id": "participant_name",
        "label": "Your Name",
        "type": "string",
        "required": true
      },
      {
        "id": "preferred_language",
        "label": "Preferred Language",
        "type": "select",
        "required": false,
        "options": ["English", "German", "French"],
        "default_value": "English"
      }
    ]
  },
  "states": [
    {
      "id": "state_intake",
      "title": "Intake",
      "type": "loose",
      "description": "Collect issue and urgency",
      "tasks": [
        {
          "id": "task_issue_type",
          "description": "Capture issue type",
          "required": true,
          "deliverables": [
            {
              "key": "issue_type",
              "description": "Issue category",
              "type": "enum",
              "required": true,
              "enum_values": ["billing", "technical", "account"]
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
              "description": "Urgency 1-10",
              "type": "number",
              "required": true
            }
          ]
        }
      ],
      "transitions": [
        {
          "target_state_id": "state_priority",
          "condition_type": "all_of",
          "priority": 1,
          "condition_config": {
            "conditions": [
              {
                "condition_type": "deliverable_value_in",
                "condition_config": { "key": "issue_type", "values": ["billing", "account"] }
              },
              {
                "condition_type": "deliverable_value_numeric",
                "condition_config": { "key": "urgency_score", "operator": "gte", "value": 7 }
              }
            ]
          }
        },
        {
          "target_state_id": "state_standard",
          "condition_type": "all_tasks_complete",
          "priority": 99
        }
      ]
    },
    {
      "id": "state_priority",
      "title": "Priority Handling",
      "type": "strict",
      "tasks": [],
      "transitions": [
        {
          "target_state_id": "state_farewell",
          "condition_type": "all_tasks_complete",
          "priority": 1
        }
      ]
    },
    {
      "id": "state_standard",
      "title": "Standard Handling",
      "type": "strict",
      "tasks": [],
      "transitions": [
        {
          "target_state_id": "state_farewell",
          "condition_type": "all_tasks_complete",
          "priority": 1
        }
      ]
    },
    {
      "id": "state_farewell",
      "title": "Farewell",
      "type": "strict",
      "tasks": [],
      "transitions": []
    }
  ],
  "metadata": {
    "plan_builder": {
      "start": {
        "agent_spawn_mode": "immediate"
      },
      "canvas": {
        "state_positions": {
          "state_intake": { "x": 420, "y": 180 },
          "state_priority": { "x": 760, "y": 80 },
          "state_standard": { "x": 760, "y": 280 },
          "state_farewell": { "x": 1040, "y": 180 }
        },
        "show_end_node": true,
        "end_node_position": { "x": 1280, "y": 180 },
        "end_state_ids": ["state_farewell"]
      }
    }
  }
}
```

## Related Topics

- [Plan Builder](./plan-builder.md) — Visual editing workflow and canvas behavior
- [States](./states.md) — Transition behavior and condition details
- [Examples](./examples.md) — Additional complete plan examples
