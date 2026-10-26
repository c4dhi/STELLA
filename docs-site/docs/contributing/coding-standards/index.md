---
sidebar_position: 1
title: Overview
description: Code style and conventions for STELLA
---

# Coding Standards

Consistent code style makes the codebase easier to read and maintain. This guide covers our standards for all STELLA components.

## Quick Reference

| Component | Language | Style Guide | Formatter |
|-----------|----------|-------------|-----------|
| Backend | TypeScript | [Airbnb](https://github.com/airbnb/javascript) | Prettier |
| Agents | Python | [PEP 8](https://pep8.org/) | Black |
| Frontend | React/TS | [React TS Cheatsheet](https://react-typescript-cheatsheet.netlify.app/) | Prettier |

## Standards by Component

### [TypeScript (Backend)](./typescript.md)

NestJS backend code conventions including:
- Formatting with Prettier
- Linting with ESLint
- Naming conventions
- Service and DTO examples

### [Python (Agents)](./python.md)

Python agent code conventions including:
- Formatting with Black
- Linting with Pylint
- Type checking with mypy
- Agent and tool examples

### [React (Frontend)](./react.md)

React frontend code conventions including:
- Linting with oxlint
- Component structure
- File organization
- Custom hooks patterns

### [Git & Commits](./git.md)

Version control best practices including:
- Branch naming conventions
- Conventional commit format
- Commit message guidelines
- Git workflow and tips

### [Testing](./testing.md)

Testing standards for all components:
- Backend testing with Jest
- Frontend testing
- Agent testing with pytest

## General Principles

1. **Consistency over preference** - Follow existing patterns in the codebase
2. **Readability over cleverness** - Write code that's easy to understand
3. **Document the why** - Comments should explain reasoning, not what
4. **Test what matters** - Focus on behavior, not implementation details
5. **Small, focused changes** - Each PR should do one thing well
