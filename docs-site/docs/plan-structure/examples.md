---
sidebar_position: 5
title: "Examples"
---

# Plan Examples

This page provides complete, copy-pasteable plan examples for common use cases.

:::note Personas, since 1.3.0
A plan no longer carries a `system_prompt` or a `voice`. Who the agent is lives in a [persona](../agents/personas.md), chosen when deploying. Saving a plan with either field is rejected. A plan can still name the agent with persona variables such as `{{persona.name}}`.
:::

## Linear Flow Example

Use this pattern when every state should move forward in a single direction, with no branching paths.

```json
{
  "id": "linear-check-in",
  "title": "Linear Check-In Flow",
  "description": "A straightforward greeting -> intake -> close flow",
  "initial_state_id": "state_greeting",
  "states": [
    {
      "id": "state_greeting",
      "title": "Greeting",
      "type": "sequential",
      "description": "Open the conversation and capture the user's name",
      "tasks": [
        {
          "id": "task_name",
          "description": "Capture preferred name",
          "required": true,
          "deliverables": [
            {
              "key": "user_name",
              "type": "string",
              "description": "User's preferred name",
              "required": true
            }
          ]
        }
      ],
      "transitions": [
        {
          "target_state_id": "state_intake",
          "condition_type": "all_tasks_complete",
          "priority": 1
        }
      ]
    },
    {
      "id": "state_intake",
      "title": "Intake",
      "type": "flexible",
      "description": "Capture the user's primary request",
      "tasks": [
        {
          "id": "task_request",
          "description": "Capture request",
          "required": true,
          "deliverables": [
            {
              "key": "primary_request",
              "type": "string",
              "description": "What the user needs help with",
              "required": true
            }
          ]
        }
      ],
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
      "type": "sequential",
      "description": "Close politely and end the session",
      "tasks": [
        {
          "id": "task_close",
          "description": "Provide short closing message",
          "required": true,
          "deliverables": []
        }
      ],
      "transitions": [
        {
          "target_state_id": "__end__",
          "condition_type": "all_tasks_complete",
          "priority": 0
        }
      ]
    }
  ],
  "metadata": {
    "plan_builder": {
      "start": {
        "agent_spawn_mode": "immediate"
      },
      "canvas": {
        "show_end_node": true,
        "end_state_ids": ["state_farewell"],
        "state_positions": {}
      }
    }
  }
}
```

- Each non-terminal state has exactly one outgoing transition.
- Transition ordering is simple (`priority: 1`), with final handoff to `__end__`.
- End-node metadata marks `state_farewell` as the terminal visual state.

## Branching Flow Example

Use this pattern when one intake state should route to different paths based on user data.

```json
{
  "id": "branching-support-triage",
  "title": "Branching Support Triage",
  "description": "Routes users into priority, strategy, or closure states",
  "initial_state_id": "state_intake",
  "states": [
    {
      "id": "state_intake",
      "title": "Intake",
      "type": "flexible",
      "description": "Collect issue type, urgency, and support preference",
      "tasks": [
        {
          "id": "task_issue_type",
          "description": "Capture issue type",
          "required": true,
          "deliverables": [
            {
              "key": "issue_type",
              "type": "enum",
              "required": true,
              "description": "Issue category",
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
              "type": "number",
              "required": true,
              "description": "Urgency from 1 to 10"
            }
          ]
        },
        {
          "id": "task_support_preference",
          "description": "Capture support preference",
          "required": true,
          "deliverables": [
            {
              "key": "support_preference",
              "type": "enum",
              "required": true,
              "description": "Preferred support mode",
              "enum_values": ["quick_tips", "grounding_exercise", "deeper_explanation", "just_listen"]
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
          "target_state_id": "state_strategy",
          "condition_type": "any_of",
          "priority": 5,
          "condition_config": {
            "conditions": [
              {
                "condition_type": "deliverable_value_in",
                "condition_config": {
                  "key": "support_preference",
                  "values": ["grounding_exercise", "quick_tips"]
                }
              },
              {
                "condition_type": "deliverable_value_numeric",
                "condition_config": {
                  "key": "urgency_score",
                  "operator": "lt",
                  "value": 4
                }
              }
            ]
          }
        },
        {
          "target_state_id": "state_closure",
          "condition_type": "all_tasks_complete",
          "priority": 99
        }
      ]
    },
    {
      "id": "state_priority",
      "title": "Priority Queue",
      "type": "sequential",
      "description": "Handle urgent users first",
      "tasks": [],
      "transitions": [
        {
          "target_state_id": "state_closure",
          "condition_type": "all_tasks_complete",
          "priority": 1
        }
      ]
    },
    {
      "id": "state_strategy",
      "title": "Coping Strategy",
      "type": "flexible",
      "description": "Offer targeted coping options",
      "tasks": [],
      "transitions": [
        {
          "target_state_id": "state_closure",
          "condition_type": "all_tasks_complete",
          "priority": 1
        }
      ]
    },
    {
      "id": "state_closure",
      "title": "Closure",
      "type": "sequential",
      "description": "Summarize and close",
      "tasks": [],
      "transitions": [
        {
          "target_state_id": "__end__",
          "condition_type": "all_tasks_complete",
          "priority": 0
        }
      ]
    }
  ],
  "metadata": {
    "plan_builder": {
      "start": {
        "agent_spawn_mode": "immediate"
      },
      "canvas": {
        "show_end_node": true,
        "end_state_ids": ["state_closure"],
        "state_positions": {}
      }
    }
  }
}
```

- `state_intake` has multiple outgoing transitions with clear priority order.
- Priority `99` acts as a deterministic fallback when specific conditions do not match.
- All paths converge at `state_closure`, then transition to `__end__`.

## Circular Flow with Guard Example

Use this pattern when a state may need repeated clarification, but must still exit safely.

```json
{
  "id": "circular-clarification-flow",
  "title": "Circular Clarification with Guard",
  "description": "Loops for clarification and exits through a guard transition when progress stalls",
  "initial_state_id": "state_collect",
  "states": [
    {
      "id": "state_collect",
      "title": "Collect Request",
      "type": "flexible",
      "description": "Capture initial request and confidence",
      "tasks": [
        {
          "id": "task_request",
          "description": "Capture request summary",
          "required": true,
          "deliverables": [
            {
              "key": "request_summary",
              "type": "string",
              "required": true,
              "description": "User's request in one sentence"
            }
          ]
        },
        {
          "id": "task_confidence",
          "description": "Capture confidence score",
          "required": true,
          "deliverables": [
            {
              "key": "confidence_score",
              "type": "number",
              "required": true,
              "description": "How clear the user feels from 1 to 10"
            }
          ]
        }
      ],
      "transitions": [
        {
          "target_state_id": "state_clarify",
          "condition_type": "all_tasks_complete",
          "priority": 1
        }
      ]
    },
    {
      "id": "state_clarify",
      "title": "Clarify",
      "type": "flexible",
      "description": "Clarify details until enough signal is captured",
      "tasks": [
        {
          "id": "task_needs_clarification",
          "description": "Capture whether more clarification is needed",
          "required": true,
          "deliverables": [
            {
              "key": "needs_clarification",
              "type": "boolean",
              "required": true,
              "description": "Whether another clarification round is needed"
            }
          ]
        }
      ],
      "transitions": [
        {
          "target_state_id": "state_guard_exit",
          "condition_type": "turn_count_exceeded",
          "priority": 1,
          "condition_config": {
            "scope": "without_progress",
            "turns": 3
          }
        },
        {
          "target_state_id": "state_clarify",
          "condition_type": "deliverable_value",
          "priority": 5,
          "condition_config": {
            "key": "needs_clarification",
            "value": true
          }
        },
        {
          "target_state_id": "state_resolution",
          "condition_type": "all_tasks_complete",
          "priority": 99
        }
      ]
    },
    {
      "id": "state_guard_exit",
      "title": "Guard Exit",
      "type": "sequential",
      "description": "Exit path when the loop exceeds safe retry limits",
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
      "id": "state_resolution",
      "title": "Resolution",
      "type": "sequential",
      "description": "Provide final recommendation",
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
      "type": "sequential",
      "description": "Close the conversation",
      "tasks": [],
      "transitions": [
        {
          "target_state_id": "__end__",
          "condition_type": "all_tasks_complete",
          "priority": 0
        }
      ]
    }
  ],
  "metadata": {
    "plan_builder": {
      "start": {
        "agent_spawn_mode": "immediate"
      },
      "canvas": {
        "show_end_node": true,
        "end_state_ids": ["state_farewell"],
        "state_positions": {}
      }
    }
  }
}
```

- `state_clarify` intentionally loops when `needs_clarification = true`.
- Guard transition (`turn_count_exceeded`, priority `1`) breaks potential infinite loops.
- Both normal and guarded paths converge to `state_farewell`, then transition to `__end__`.

## Simple Greeting Flow

A minimal three-state conversation: greeting, data collection, and farewell.

```json
{
  "id": "simple-greeting",
  "title": "Simple Greeting Flow",
  "description": "Basic conversation with greeting and farewell",
  "initial_state_id": "greeting",
  "states": [
    {
      "id": "greeting",
      "title": "Greeting",
      "type": "loose",
      "description": "Welcome the user and learn their name",
      "tasks": [
        {
          "id": "welcome",
          "description": "Welcome User",
          "instruction": "Warmly greet the user and introduce yourself as Stella. Ask for their name in a friendly way.",
          "required": true,
          "deliverables": [
            {
              "key": "user_name",
              "type": "string",
              "description": "The user's name",
              "required": true,
              "acceptance_criteria": "Any name the user provides"
            }
          ]
        }
      ],
      "transitions": [
        {
          "target_state_id": "main_conversation",
          "condition_type": "all_tasks_complete",
          "priority": 1
        }
      ]
    },
    {
      "id": "main_conversation",
      "title": "Main Conversation",
      "type": "loose",
      "description": "Help the user with their request",
      "tasks": [
        {
          "id": "understand_need",
          "description": "Understand User Need",
          "instruction": "Ask the user how you can help them today. Listen to their request and acknowledge it.",
          "required": true,
          "deliverables": [
            {
              "key": "user_request",
              "type": "string",
              "description": "What the user wants help with",
              "required": true
            }
          ]
        }
      ],
      "transitions": [
        {
          "target_state_id": "farewell",
          "condition_type": "all_tasks_complete",
          "priority": 1
        }
      ]
    },
    {
      "id": "farewell",
      "title": "Farewell",
      "type": "strict",
      "description": "Say goodbye",
      "tasks": [
        {
          "id": "goodbye",
          "description": "Say Goodbye",
          "instruction": "Thank the user by name for their time. Wish them well and let them know they can return anytime.",
          "required": true,
          "deliverables": []
        }
      ],
      "transitions": []
    }
  ]
}
```

## Fitness Check-In

A health-focused plan that collects fitness metrics using various deliverable types.

```json
{
  "id": "fitness-checkin",
  "title": "Daily Fitness Check-In",
  "description": "Collect daily fitness metrics and provide encouragement",
  "initial_state_id": "greeting",
  "session_context": {
    "fields": [
      {
        "id": "participant_name",
        "label": "Your Name",
        "type": "string",
        "required": true
      },
      {
        "id": "fitness_goal",
        "label": "Primary Fitness Goal",
        "type": "select",
        "required": true,
        "options": ["Weight Loss", "Muscle Gain", "General Fitness", "Training for Event"]
      }
    ]
  },
  "states": [
    {
      "id": "greeting",
      "title": "Welcome",
      "type": "loose",
      "description": "Greet and set the tone for check-in",
      "tasks": [
        {
          "id": "daily_greeting",
          "description": "Daily Greeting",
          "instruction": "Greet the user enthusiastically for their check-in. Reference their fitness goal if available from session context.",
          "required": true,
          "deliverables": []
        }
      ],
      "transitions": [
        {
          "target_state_id": "activity_check",
          "condition_type": "all_tasks_complete",
          "priority": 1
        }
      ]
    },
    {
      "id": "activity_check",
      "title": "Activity Check",
      "type": "strict",
      "description": "Collect activity metrics",
      "tasks": [
        {
          "id": "exercise_done",
          "description": "Exercise Check",
          "instruction": "Ask if they exercised today. Be supportive regardless of answer.",
          "required": true,
          "deliverables": [
            {
              "key": "exercised_today",
              "type": "boolean",
              "description": "Whether the user exercised today",
              "required": true
            }
          ]
        },
        {
          "id": "exercise_details",
          "description": "Exercise Details",
          "instruction": "If they exercised, ask about the type and duration. If not, skip to next task.",
          "required": false,
          "deliverables": [
            {
              "key": "exercise_type",
              "type": "enum",
              "description": "Type of exercise performed",
              "required": false,
              "enum_values": ["cardio", "strength", "flexibility", "sports", "walking", "other"]
            },
            {
              "key": "exercise_duration_minutes",
              "type": "number",
              "description": "Duration of exercise in minutes",
              "required": false,
              "acceptance_criteria": "Positive number representing minutes"
            }
          ]
        },
        {
          "id": "steps",
          "description": "Step Count",
          "instruction": "Ask about their step count for the day. It's okay if they don't track steps.",
          "required": true,
          "deliverables": [
            {
              "key": "step_count",
              "type": "number",
              "description": "Number of steps taken today",
              "required": false,
              "acceptance_criteria": "Positive integer"
            }
          ]
        }
      ],
      "transitions": [
        {
          "target_state_id": "nutrition_check",
          "condition_type": "all_tasks_complete",
          "priority": 1
        }
      ]
    },
    {
      "id": "nutrition_check",
      "title": "Nutrition Check",
      "type": "loose",
      "description": "Quick nutrition check-in",
      "tasks": [
        {
          "id": "water_intake",
          "description": "Hydration Check",
          "instruction": "Ask about water intake. Encourage good hydration habits.",
          "required": true,
          "deliverables": [
            {
              "key": "water_glasses",
              "type": "number",
              "description": "Glasses of water consumed",
              "required": true,
              "acceptance_criteria": "Number between 0 and 20",
              "examples": ["8", "5", "10"]
            }
          ]
        },
        {
          "id": "meal_quality",
          "description": "Meal Quality",
          "instruction": "Ask how they would rate their eating today on a simple scale.",
          "required": true,
          "deliverables": [
            {
              "key": "meal_quality_rating",
              "type": "enum",
              "description": "Self-assessment of eating quality",
              "required": true,
              "enum_values": ["great", "good", "okay", "poor"]
            }
          ]
        }
      ],
      "transitions": [
        {
          "target_state_id": "summary",
          "condition_type": "all_tasks_complete",
          "priority": 1
        }
      ]
    },
    {
      "id": "summary",
      "title": "Summary & Motivation",
      "type": "strict",
      "description": "Summarize and encourage",
      "tasks": [
        {
          "id": "provide_summary",
          "description": "Daily Summary",
          "instruction": "Summarize what they reported today. Highlight positives and provide one encouraging tip for tomorrow. Keep it brief and upbeat.",
          "required": true,
          "deliverables": []
        }
      ],
      "transitions": []
    }
  ]
}
```

## Customer Support Flow

A customer support plan with conditional routing based on issue type.

```json
{
  "id": "customer-support",
  "title": "Customer Support Flow",
  "description": "Route customers to appropriate support based on issue type",
  "initial_state_id": "intake",
  "states": [
    {
      "id": "intake",
      "title": "Customer Intake",
      "type": "strict",
      "description": "Identify customer and categorize issue",
      "tasks": [
        {
          "id": "identify_customer",
          "description": "Identify Customer",
          "instruction": "Greet the customer professionally and ask for their name and account or order number.",
          "required": true,
          "deliverables": [
            {
              "key": "customer_name",
              "type": "string",
              "description": "Customer's name",
              "required": true
            },
            {
              "key": "account_number",
              "type": "string",
              "description": "Account or order number",
              "required": false,
              "acceptance_criteria": "Alphanumeric identifier"
            }
          ]
        },
        {
          "id": "categorize_issue",
          "description": "Categorize Issue",
          "instruction": "Ask the customer to briefly describe their issue. Determine if it's billing, technical, or general inquiry.",
          "required": true,
          "deliverables": [
            {
              "key": "issue_summary",
              "type": "string",
              "description": "Brief description of the issue",
              "required": true
            },
            {
              "key": "issue_category",
              "type": "enum",
              "description": "Category of the issue",
              "required": true,
              "enum_values": ["billing", "technical", "general"]
            }
          ]
        }
      ],
      "transitions": [
        {
          "target_state_id": "billing_support",
          "condition_type": "deliverable_value",
          "priority": 1,
          "condition_config": {
            "deliverable_key": "issue_category",
            "expected_value": "billing"
          }
        },
        {
          "target_state_id": "technical_support",
          "condition_type": "deliverable_value",
          "priority": 1,
          "condition_config": {
            "deliverable_key": "issue_category",
            "expected_value": "technical"
          }
        },
        {
          "target_state_id": "general_support",
          "condition_type": "all_tasks_complete",
          "priority": 10
        }
      ]
    },
    {
      "id": "billing_support",
      "title": "Billing Support",
      "type": "strict",
      "description": "Handle billing-related issues",
      "tasks": [
        {
          "id": "billing_details",
          "description": "Get Billing Details",
          "instruction": "Ask about the specific billing concern: incorrect charge, refund request, payment issue, or billing cycle question.",
          "required": true,
          "deliverables": [
            {
              "key": "billing_issue_type",
              "type": "enum",
              "description": "Specific type of billing issue",
              "required": true,
              "enum_values": ["incorrect_charge", "refund_request", "payment_issue", "billing_question"]
            },
            {
              "key": "amount_in_question",
              "type": "number",
              "description": "Dollar amount if applicable",
              "required": false
            }
          ]
        },
        {
          "id": "billing_resolution",
          "description": "Provide Resolution Path",
          "instruction": "Based on the issue type, explain the resolution process. For refunds, explain the timeline. For incorrect charges, explain the review process.",
          "required": true,
          "deliverables": [
            {
              "key": "resolution_accepted",
              "type": "boolean",
              "description": "Whether customer accepts the proposed resolution",
              "required": true
            }
          ]
        }
      ],
      "transitions": [
        {
          "target_state_id": "closing",
          "condition_type": "all_tasks_complete",
          "priority": 1
        }
      ]
    },
    {
      "id": "technical_support",
      "title": "Technical Support",
      "type": "strict",
      "description": "Handle technical issues",
      "tasks": [
        {
          "id": "technical_details",
          "description": "Gather Technical Details",
          "instruction": "Ask about the technical issue: what product/service, what's happening, any error messages, and when it started.",
          "required": true,
          "deliverables": [
            {
              "key": "product_name",
              "type": "string",
              "description": "Product or service with the issue",
              "required": true
            },
            {
              "key": "error_message",
              "type": "string",
              "description": "Any error messages seen",
              "required": false
            },
            {
              "key": "issue_start",
              "type": "string",
              "description": "When the issue started",
              "required": false
            }
          ]
        },
        {
          "id": "troubleshooting",
          "description": "Basic Troubleshooting",
          "instruction": "Walk through basic troubleshooting: restart, clear cache, check connection. Ask if they've tried these steps.",
          "required": true,
          "deliverables": [
            {
              "key": "troubleshooting_tried",
              "type": "boolean",
              "description": "Whether basic troubleshooting was attempted",
              "required": true
            },
            {
              "key": "issue_resolved",
              "type": "boolean",
              "description": "Whether the issue was resolved",
              "required": true
            }
          ]
        }
      ],
      "transitions": [
        {
          "target_state_id": "escalation",
          "condition_type": "deliverable_value",
          "priority": 1,
          "condition_config": {
            "deliverable_key": "issue_resolved",
            "expected_value": false
          }
        },
        {
          "target_state_id": "closing",
          "condition_type": "all_tasks_complete",
          "priority": 10
        }
      ]
    },
    {
      "id": "general_support",
      "title": "General Support",
      "type": "loose",
      "description": "Handle general inquiries",
      "tasks": [
        {
          "id": "answer_inquiry",
          "description": "Answer Inquiry",
          "instruction": "Address the customer's general question or request. Provide helpful information and ask if they need anything else.",
          "required": true,
          "deliverables": [
            {
              "key": "inquiry_addressed",
              "type": "boolean",
              "description": "Whether the inquiry was addressed",
              "required": true
            }
          ]
        }
      ],
      "transitions": [
        {
          "target_state_id": "closing",
          "condition_type": "all_tasks_complete",
          "priority": 1
        }
      ]
    },
    {
      "id": "escalation",
      "title": "Escalation",
      "type": "strict",
      "description": "Escalate unresolved issues",
      "tasks": [
        {
          "id": "collect_escalation_details",
          "description": "Collect Escalation Details",
          "instruction": "Let the customer know you'll escalate to a specialist. Collect their preferred contact method and best time to reach them.",
          "required": true,
          "deliverables": [
            {
              "key": "contact_method",
              "type": "enum",
              "description": "Preferred contact method for follow-up",
              "required": true,
              "enum_values": ["email", "phone", "callback"]
            },
            {
              "key": "contact_info",
              "type": "string",
              "description": "Contact information",
              "required": true
            },
            {
              "key": "best_time",
              "type": "string",
              "description": "Best time to reach them",
              "required": false
            }
          ]
        }
      ],
      "transitions": [
        {
          "target_state_id": "closing",
          "condition_type": "all_tasks_complete",
          "priority": 1
        }
      ]
    },
    {
      "id": "closing",
      "title": "Closing",
      "type": "strict",
      "description": "Close the conversation",
      "tasks": [
        {
          "id": "satisfaction_check",
          "description": "Satisfaction Check",
          "instruction": "Ask if there's anything else you can help with. If not, thank them for contacting support.",
          "required": true,
          "deliverables": [
            {
              "key": "additional_help_needed",
              "type": "boolean",
              "description": "Whether they need additional help",
              "required": true
            }
          ]
        },
        {
          "id": "farewell",
          "description": "Farewell",
          "instruction": "Thank the customer by name for their time. Wish them well.",
          "required": true,
          "deliverables": []
        }
      ],
      "transitions": []
    }
  ]
}
```

## Tips for Building Plans

### Start Simple

Begin with a basic three-state flow (greeting → main → farewell), then add complexity.

### Use Meaningful IDs

```json
// Good
"id": "collect_medical_history"

// Avoid
"id": "task_3"
```

### Match Mode to Purpose

- **STRICT** for sequential forms, compliance workflows
- **LOOSE** for natural conversations, discovery

### Test Transitions

Verify your transition conditions work correctly:
- Test the "happy path"
- Test conditional branches
- Test edge cases (missing data, unexpected values)

### Keep Instructions Clear

Write instructions as if briefing the assistant:
- What to do
- How to handle edge cases
- What tone to use
