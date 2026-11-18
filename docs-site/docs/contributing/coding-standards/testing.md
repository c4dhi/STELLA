---
sidebar_position: 6
title: Testing
description: Testing standards and practices for STELLA
---

# Testing

Testing standards and practices for all STELLA components.

## Backend (NestJS)

### Running Tests

```bash
# Run all tests
npm test

# Run with coverage
npm run test:cov

# Run specific test file
npm test -- session.service.spec.ts

# Run tests in watch mode
npm run test:watch
```

### Test Structure

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { SessionService } from './session.service';
import { PrismaService } from '../prisma/prisma.service';

describe('SessionService', () => {
  let service: SessionService;
  let prisma: PrismaService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SessionService,
        {
          provide: PrismaService,
          useValue: {
            session: {
              create: jest.fn(),
              findUnique: jest.fn(),
            },
          },
        },
      ],
    }).compile();

    service = module.get<SessionService>(SessionService);
    prisma = module.get<PrismaService>(PrismaService);
  });

  describe('create', () => {
    it('should create a session with pending status', async () => {
      const dto = { projectId: 'proj-1', agentType: 'stella-agent' };
      const expected = { id: 'sess-1', ...dto, status: 'PENDING' };

      jest.spyOn(prisma.session, 'create').mockResolvedValue(expected);

      const result = await service.create(dto);

      expect(result).toEqual(expected);
      expect(prisma.session.create).toHaveBeenCalledWith({
        data: { ...dto, status: 'PENDING' },
      });
    });
  });

  describe('findOne', () => {
    it('should return session if found', async () => {
      const session = { id: 'sess-1', status: 'ACTIVE' };
      jest.spyOn(prisma.session, 'findUnique').mockResolvedValue(session);

      const result = await service.findOne('sess-1');

      expect(result).toEqual(session);
    });

    it('should throw NotFoundException if session not found', async () => {
      jest.spyOn(prisma.session, 'findUnique').mockResolvedValue(null);

      await expect(service.findOne('invalid')).rejects.toThrow(
        'Session invalid not found',
      );
    });
  });
});
```

## Frontend (React)

### Running Tests

```bash
# Run tests
npm test

# Run with coverage
npm run test:coverage

# Run in watch mode
npm run test:watch
```

### Component Testing

```tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { Message } from './Message';

describe('Message', () => {
  it('renders the message text', () => {
    render(<Message text="Hello" speaker="user" />);

    expect(screen.getByText('Hello')).toBeInTheDocument();
  });

  it('applies correct class for speaker', () => {
    const { container } = render(<Message text="Hi" speaker="assistant" />);

    expect(container.firstChild).toHaveClass('message--assistant');
  });

  it('shows timestamp when provided', () => {
    const date = new Date('2024-01-15T10:30:00');
    render(<Message text="Test" speaker="user" timestamp={date} />);

    expect(screen.getByText(/10:30/)).toBeInTheDocument();
  });
});
```

### Hook Testing

```tsx
import { renderHook, waitFor } from '@testing-library/react';
import { useSession } from './useSession';
import { api } from '../api';

jest.mock('../api');

describe('useSession', () => {
  it('fetches session data', async () => {
    const mockSession = { id: 'sess-1', status: 'ACTIVE' };
    (api.getSession as jest.Mock).mockResolvedValue(mockSession);

    const { result } = renderHook(() => useSession('sess-1'));

    expect(result.current.loading).toBe(true);

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.session).toEqual(mockSession);
    expect(result.current.error).toBeNull();
  });
});
```

## Agents (Python)

### Running Tests

```bash
# Run all tests
pytest

# Run with coverage
pytest --cov=src

# Run specific test file
pytest tests/test_agent.py

# Run specific test
pytest tests/test_agent.py::test_greeting

# Run with verbose output
pytest -v
```

### Test Structure

Test `process()` directly, with a fake model client: no room, no STT or TTS, and no API key. This tests the agent from [Getting Started](../../agent-sdk/getting-started.md), saved as `my_agent/agent.py`:

<!-- reader-package: my_agent -->

```python title="tests/test_agent.py"
"""Tests for MyAgent, without a room or a real model."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from stella_agent_sdk import AgentInput, OutputType
from my_agent.agent import MyAgent


async def _stream(*parts):
    """What the OpenAI client streams back: one delta per part."""
    for part in parts:
        yield SimpleNamespace(choices=[SimpleNamespace(delta=SimpleNamespace(content=part))])


@pytest.fixture
def agent(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test")
    agent = MyAgent()
    agent.model = "test-model"
    agent.system_prompt = "Be brief."
    agent.client.chat.completions.create = AsyncMock(return_value=_stream("Hi", " there"))
    return agent


async def _run(agent, text):
    return [o async for o in agent.process(AgentInput.text_input("s1", text))]


@pytest.mark.asyncio
async def test_the_reply_ends_with_one_final_chunk(agent):
    outputs = await _run(agent, "Hello")
    chunks = [o for o in outputs if o.type is OutputType.TEXT_CHUNK]
    assert chunks[-1].is_final and chunks[-1].content == "Hi there"
    assert [o.is_final for o in chunks].count(True) == 1


@pytest.mark.asyncio
async def test_both_sides_of_the_turn_are_remembered(agent):
    await _run(agent, "Hello")
    assert agent.history == [
        {"role": "user", "content": "Hello"},
        {"role": "assistant", "content": "Hi there"},
    ]
```

### Testing Tools

Tools are plain objects: call `execute()` with a fake in place of whatever the tool talks to. A worked example is in [Building a custom agent](../../agent-sdk/building-custom-agent.md#step-6-tests).

## Best Practices

### General

- Write tests before or alongside code (TDD/BDD)
- Test behavior, not implementation
- Use descriptive test names that explain the scenario
- Keep tests focused and independent
- Avoid testing external dependencies directly

### Coverage Goals

| Component | Target Coverage |
|-----------|-----------------|
| Backend | 80%+ |
| Frontend | 70%+ |
| Agents | 80%+ |

### What to Test

**Do test:**
- Business logic and edge cases
- Error handling
- User interactions
- API contracts

**Don't test:**
- Framework code
- Third-party libraries
- Simple getters/setters
- Implementation details
