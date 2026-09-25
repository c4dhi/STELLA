---
sidebar_position: 4
title: "Deliverables"
---

# Deliverables

Deliverables are specific pieces of information that the agent collects from users during tasks. They define what data to extract, how to validate it, and whether it's required.

## Deliverable Properties

| Property | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `key` | `string` | Yes | — | Variable name (snake_case recommended) |
| `type` | `string` | No | `"string"` | Data type: `string`, `number`, `boolean`, `enum` |
| `description` | `string` | No | `""` | What information to collect |
| `required` | `boolean` | No | `true` | Must be collected |
| `acceptance_criteria` | `string` | No | `""` | Validation rules |
| `examples` | `array` | No | `[]` | Example values |
| `enum_values` | `array` | No | `null` | Valid options for enum type |

## Deliverable Types

### `string`

Free-form text input. The most common type.

```json
{
  "key": "full_name",
  "type": "string",
  "description": "User's full legal name",
  "required": true,
  "acceptance_criteria": "Must include first and last name",
  "examples": ["John Smith", "Maria Garcia-Lopez"]
}
```

### `number`

Numeric values (integers or decimals).

```json
{
  "key": "age",
  "type": "number",
  "description": "User's age in years",
  "required": true,
  "acceptance_criteria": "Must be between 18 and 120",
  "examples": ["25", "42", "67"]
}
```

```json
{
  "key": "weight_kg",
  "type": "number",
  "description": "Weight in kilograms",
  "required": false,
  "acceptance_criteria": "Positive number, can include decimals",
  "examples": ["70.5", "85", "62.3"]
}
```

### `boolean`

True/false values. Useful for yes/no questions.

```json
{
  "key": "has_insurance",
  "type": "boolean",
  "description": "Whether the user has health insurance",
  "required": true,
  "examples": ["true", "false"]
}
```

```json
{
  "key": "agrees_to_terms",
  "type": "boolean",
  "description": "User agreement to terms and conditions",
  "required": true,
  "acceptance_criteria": "Must be true to proceed"
}
```

### `enum`

Selection from predefined options. Requires `enum_values` array.

```json
{
  "key": "preferred_time",
  "type": "enum",
  "description": "Preferred appointment time",
  "required": true,
  "enum_values": ["morning", "afternoon", "evening"],
  "examples": ["morning"]
}
```

```json
{
  "key": "urgency_level",
  "type": "enum",
  "description": "How urgent is this request",
  "required": true,
  "enum_values": ["low", "medium", "high", "emergency"],
  "acceptance_criteria": "Agent should help user determine appropriate level"
}
```

## Status Tracking

During conversation execution, each deliverable has a status:

| Status | Description |
|--------|-------------|
| `pending` | Not yet collected |
| `partial` | Mentioned but not confirmed: the participant said something that answers it in passing. The value is stored and readable, and the agent brings it back to check it (at most one per turn) instead of treating it as settled or asking it cold. Setting the deliverable again without `unconfirmed` completes it |
| `completed` | Successfully collected and validated |
| `skipped` | Not collected — either an optional deliverable the user declined, or any deliverable (required or optional) whose owning task was skipped |

### Status Flow

```
┌─────────────┐
│   pending   │  Initial state
└──────┬──────┘
       │ User provides response
       ▼
┌─────────────┐
│   partial   │  Response needs clarification
└──────┬──────┘
       │ User provides complete response
       ▼
┌─────────────┐
│  completed  │  Successfully collected
└─────────────┘

Or, when not collected:

┌─────────────┐
│   pending   │
└──────┬──────┘
       │ User declines (optional), or the owning task is skipped
       ▼
┌─────────────┐
│   skipped   │  Not collected
└─────────────┘
```

## Property Deep Dive

### `key`

The identifier used to store and reference the collected value. Use descriptive snake_case names.

```json
{"key": "user_email"}
{"key": "appointment_date"}
{"key": "pain_level_1_to_10"}
```

**Best practices:**
- Use snake_case: `first_name` not `firstName` or `FirstName`
- Be descriptive: `preferred_contact_method` not `pcm`
- Avoid generic names: `user_age` not `data1`

### `description`

Human-readable description of what to collect. Helps the agent understand context.

```json
{
  "key": "symptoms",
  "description": "Primary symptoms the patient is experiencing, including duration and severity"
}
```

### `acceptance_criteria`

Validation rules the collected value should meet. The agent uses this to determine if a response is acceptable.

```json
{
  "key": "phone_number",
  "acceptance_criteria": "Must be a valid US phone number with 10 digits, can include area code"
}
```

```json
{
  "key": "date_of_birth",
  "acceptance_criteria": "Must be a valid date in the past, format MM/DD/YYYY or natural language"
}
```

### `examples`

Sample values that guide the agent in understanding the expected format.

```json
{
  "key": "email",
  "examples": ["user@example.com", "john.doe@company.org"]
}
```

```json
{
  "key": "appointment_preference",
  "type": "enum",
  "enum_values": ["in-person", "video", "phone"],
  "examples": ["video"]
}
```

## Complete Examples

### Contact Information Deliverables

```json
{
  "deliverables": [
    {
      "key": "full_name",
      "type": "string",
      "description": "User's full name",
      "required": true,
      "acceptance_criteria": "Must include first and last name",
      "examples": ["Jane Doe", "John Smith Jr."]
    },
    {
      "key": "email",
      "type": "string",
      "description": "Email address for confirmations",
      "required": true,
      "acceptance_criteria": "Valid email format",
      "examples": ["jane@example.com"]
    },
    {
      "key": "phone",
      "type": "string",
      "description": "Phone number",
      "required": false,
      "acceptance_criteria": "10+ digits with optional country code",
      "examples": ["+1-555-123-4567"]
    }
  ]
}
```

### Health Screening Deliverables

```json
{
  "deliverables": [
    {
      "key": "has_symptoms",
      "type": "boolean",
      "description": "Whether the patient has any symptoms",
      "required": true
    },
    {
      "key": "symptom_description",
      "type": "string",
      "description": "Description of symptoms",
      "required": false,
      "acceptance_criteria": "Only required if has_symptoms is true"
    },
    {
      "key": "pain_level",
      "type": "number",
      "description": "Pain level on scale of 1-10",
      "required": false,
      "acceptance_criteria": "Integer between 1 and 10",
      "examples": ["3", "7", "10"]
    },
    {
      "key": "urgency",
      "type": "enum",
      "description": "How urgent is the care needed",
      "required": true,
      "enum_values": ["routine", "soon", "urgent", "emergency"]
    }
  ]
}
```

### Appointment Booking Deliverables

```json
{
  "deliverables": [
    {
      "key": "preferred_date",
      "type": "string",
      "description": "Preferred appointment date",
      "required": true,
      "acceptance_criteria": "Valid date in the future",
      "examples": ["next Monday", "January 15th", "2024-01-15"]
    },
    {
      "key": "time_preference",
      "type": "enum",
      "description": "Preferred time of day",
      "required": true,
      "enum_values": ["early-morning", "morning", "afternoon", "evening"]
    },
    {
      "key": "visit_type",
      "type": "enum",
      "description": "Type of appointment",
      "required": true,
      "enum_values": ["in-person", "video", "phone"]
    },
    {
      "key": "special_requirements",
      "type": "string",
      "description": "Any accessibility or special requirements",
      "required": false,
      "examples": ["wheelchair accessible", "interpreter needed"]
    }
  ]
}
```

## Best Practices

### Naming Conventions

| Good | Avoid |
|------|-------|
| `user_email` | `email1`, `e` |
| `appointment_date` | `date`, `appt` |
| `pain_level_1_to_10` | `pain`, `level` |

### Acceptance Criteria

Write criteria that help the agent validate responses:

```json
// Good - specific and actionable
{
  "acceptance_criteria": "Must be a valid US zip code (5 digits or 5+4 format)"
}

// Avoid - vague
{
  "acceptance_criteria": "Valid format"
}
```

### Examples

Provide diverse examples that cover edge cases:

```json
// Good - shows variety
{
  "examples": ["John Smith", "Maria Garcia-Lopez", "J. Robert Oppenheimer III"]
}

// Avoid - repetitive
{
  "examples": ["John Smith", "Jane Smith"]
}
```

## Next Steps

- [Examples](./examples.md) — See complete plan examples with deliverables in context
