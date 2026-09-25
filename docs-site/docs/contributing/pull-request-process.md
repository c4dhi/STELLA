---
sidebar_position: 4
title: Pull Request Process
description: How to submit and review pull requests
---

# Pull Request Process

This guide covers how to submit a pull request (PR) and what to expect during the review process.

## Before Submitting

### 1. Sync with Upstream

```bash
# Fetch latest changes
git fetch upstream

# Rebase your branch
git rebase upstream/main
```

### 2. Run Tests

```bash
# Backend tests
npm test

# Frontend tests
cd frontend-ui && npm test

# Agent tests
cd agents/stella-ai-agent-sdk && python -m pytest
```

### 3. Check Formatting

```bash
# Backend
npm run lint
npm run format:check

# Python
black --check agents/
pylint agents/
```

### 4. Update Documentation

If your changes affect:
- API endpoints → Update Swagger docs
- Configuration → Update README or docs
- New features → Add documentation page

## Creating a Pull Request

### Branch Naming

```
<type>/<short-description>

Examples:
feature/custom-tts-provider
fix/session-cleanup-error
docs/streaming-guide
refactor/simplify-audio-pipeline
```

### PR Title

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(agents): add support for ElevenLabs TTS
fix(backend): handle WebSocket disconnection gracefully
docs: add contributing guide
```

### PR Description Template

```markdown
## Summary

Brief description of the changes.

## Changes

- Added X feature
- Fixed Y bug
- Updated Z documentation

## Testing

Describe how you tested the changes:

- [ ] Unit tests pass
- [ ] Manual testing completed
- [ ] Tested on Kubernetes

## Screenshots (if applicable)

Add screenshots for UI changes.

## Related Issues

Closes #123
```

## Review Process

### 1. Automated Checks

When you open a PR, automated checks run:

| Check | Description |
|-------|-------------|
| CI Build | Compile and build all components |
| Tests | Run unit and integration tests |
| Linting | Check code style |
| Type Check | TypeScript/mypy type checking |

All checks must pass before merge.

### 2. Code Review

A maintainer will review your PR. They may:

- **Approve**: Ready to merge
- **Request changes**: Need modifications
- **Comment**: Questions or suggestions

### 3. Responding to Feedback

```bash
# Make requested changes
git add .
git commit -m "address review feedback"

# Push to update PR
git push
```

If you need to rebase:

```bash
# Rebase on latest main
git fetch upstream
git rebase upstream/main

# Force push (only on your feature branch!)
git push --force-with-lease
```

### 4. Merge

Once approved:
- Maintainer merges the PR
- Your branch is deleted
- Changes appear in `main`

## Review Guidelines

If you're reviewing PRs, consider:

### Code Quality

- [ ] Code is readable and well-structured
- [ ] Functions are focused and not too long
- [ ] No unnecessary complexity
- [ ] Appropriate error handling

### Testing

- [ ] New code has tests
- [ ] Tests cover edge cases
- [ ] Tests are readable

### Documentation

- [ ] Public APIs are documented
- [ ] Complex logic has comments
- [ ] README updated if needed

### Security

- [ ] No secrets in code
- [ ] Input validation present
- [ ] No SQL injection risks

## Common Issues

### CI Failures

```bash
# Check CI logs for the specific error

# Common fixes:

# Lint errors
npm run lint:fix

# Test failures
npm test -- --verbose

# Type errors
npx tsc --noEmit
```

### Merge Conflicts

```bash
# Update your branch
git fetch upstream
git rebase upstream/main

# Resolve conflicts in each file
# Then continue
git add .
git rebase --continue

# Push updated branch
git push --force-with-lease
```

### Large PRs

If your PR is large, consider:

1. **Split into smaller PRs**: Easier to review
2. **Add context**: Explain why it's large
3. **Create an issue first**: Discuss the approach

## PR Best Practices

### Do

- Keep PRs focused on one thing
- Write clear commit messages
- Respond to feedback promptly
- Test your changes thoroughly
- Update documentation

### Don't

- Mix unrelated changes
- Force push to shared branches
- Ignore CI failures
- Submit without testing
- Leave stale PRs open

## After Merge

1. **Delete your branch**: Keep the repo clean
2. **Update local main**: `git checkout main && git pull`
3. **Celebrate**: Your contribution is live!

## Getting Help

- **Stuck on an issue?** Comment on the PR
- **Need clarification?** Ask the reviewer
- **CI issues?** Check the logs first

## Next Steps

- [Release Process](./release-process.md) - How releases work
- [Coding Standards](./coding-standards/index.md) - Style guide
