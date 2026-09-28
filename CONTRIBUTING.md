# 🤝 Contributing to STELLA

Thank you for your interest in contributing to STELLA! This document provides guidelines and information for contributors.

## 🧭 Two ways to contribute

**Building your own agent?** You probably don't need this repository at all. The
STELLA Agent SDK is published on PyPI, so you can build and deploy an agent on
the platform from your own project:

```bash
pip install stella-ai-agent-sdk
```

See the [SDK README](agents/stella-ai-agent-sdk/README.md) to get started. Your
agent stays yours — it lives in your repository, on your own schedule.

**Improving STELLA itself?** That's what the rest of this document is about —
the platform, the frontend, the services, or the SDK.

## 🚀 Getting Started

### 📋 Prerequisites

- Node.js 20+
- Python 3.11+
- Docker and kubectl
- A Kubernetes cluster (local like minikube/kind or remote)

### 🔧 Development Setup

1. **Clone the repository**

   ```bash
   git clone https://github.com/c4dhi/STELLA.git
   cd STELLA
   ```

2. **Set up environment variables**

   ```bash
   cp .env.example .env
   # Edit .env with your API keys
   ```

3. **Install dependencies**

   ```bash
   # Backend
   npm install

   # Frontend
   cd frontend-ui && npm install
   ```

4. **Start development servers**

   ```bash
   # Start everything with Kubernetes
   ./scripts/start-k8s.sh

   # Or for local development
   npm run dev
   ```

## 💡 How to Contribute

### 🐛 Reporting Bugs

1. Check if the bug has already been reported in [Issues](https://github.com/c4dhi/STELLA/issues)
2. If not, create a new issue using the bug report template
3. Include as much detail as possible:
   - Steps to reproduce
   - Expected vs actual behavior
   - Environment details
   - Relevant logs

### ✨ Suggesting Features

1. Check existing [Issues](https://github.com/c4dhi/STELLA/issues) for similar requests
2. Create a new issue using the feature request template
3. Describe the use case and proposed solution

### 📝 Submitting Code

1. **Fork the repository** and create a new branch

   ```bash
   git checkout -b feature/your-feature-name
   # or
   git checkout -b fix/your-bug-fix
   ```

   Branch from `main`, and open your pull request against `main`. See
   [Where your change goes](#-where-your-change-goes) for what happens next.

2. **Make your changes**

   - Follow the code style guidelines
   - Add tests where applicable
   - Update documentation if needed

3. **Test your changes**

   ```bash
   npm test
   npm run lint
   npm run build
   ```

4. **Commit your changes**

   - Use clear, descriptive commit messages
   - Reference related issues

   ```bash
   git commit -m "feat: add voice activity detection to agent SDK

   - Implement VAD using Silero
   - Add configuration options
   - Update documentation

   Fixes #123"
   ```

5. **Push and create a Pull Request**

   ```bash
   git push origin feature/your-feature-name
   ```

   Then create a PR on GitHub using the pull request template.

## 🚚 Where your change goes

Once your pull request is open, you don't need to cut a release, tag anything, or
ask for a deploy. Getting it merged is the whole job — shipping is automatic.

### The journey of a change

1. **You open a pull request** against `main`.

2. **Automated checks run.** Depending on what you touched, these cover agent
   validation, unit tests, agent startup, a database seed round-trip, and a docs
   build. They need to pass.

3. **A maintainer reviews it.** Every pull request needs approval from a code
   owner before it can merge — see [CODEOWNERS](.github/CODEOWNERS).

4. **It merges, and it ships.** Merging to `main` deploys to production
   automatically, within minutes. There is no separate release step and no
   manual promotion.

That last point is worth repeating, because it surprises people: **on this
project, merging is releasing.** If your change is risky, or you'd like to see it
running before real users do, say so in the pull request — a maintainer can route
it through the test environment first.

### The two long-lived branches

| Branch | What it is |
|--------|------------|
| `main` | Production. What study participants are using right now. |
| `development` | The test environment, for work that needs a trial run first. |

Both deploy themselves when something lands on them. Contributors normally only
ever target `main`.

### Two things release on their own schedule

Almost everything ships the moment it merges. Two exceptions:

- **The Agent SDK** is published separately to PyPI, because a version number
  there is permanent and can never be reused. Your SDK change merges to `main`
  like anything else, and a maintainer publishes it when it's ready to go out.
  Don't bump the version yourself — just mention in your pull request if the
  change should go out promptly.

- **The STELLA version number** (on the README badge and in `CITATION.cff`) is
  bumped by maintainers when a batch of work is worth marking, and for **study
  cuts** — frozen, citeable versions, so the exact software behind a published
  paper stays reproducible. See [RELEASING.md](RELEASING.md).

### What this means for you

- **Don't** add version bumps or changelog entries to your pull request.
  Maintainers handle those.
- **Do** write a clear pull request description. It becomes the public record of
  why the change exists, and it feeds the generated release notes.
- **Do** flag anything needing a migration, a config change, or a coordinated
  rollout. Because merging deploys, there's no window to catch it afterwards.

## 🎨 Code Style

### TypeScript/JavaScript

- Use TypeScript for all new code
- Follow the existing code style (enforced by ESLint)
- Use meaningful variable and function names
- Add JSDoc comments for public APIs

### Python (Agent SDK)

- Follow PEP 8 style guidelines
- Use type hints
- Add docstrings for public functions and classes
- Use `black` for formatting

### Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` New feature
- `fix:` Bug fix
- `docs:` Documentation changes
- `style:` Code style changes (formatting, etc.)
- `refactor:` Code refactoring
- `test:` Adding or updating tests
- `chore:` Maintenance tasks

## 📁 Project Structure

```
STELLA/
├── src/                        # Backend (NestJS), one directory per feature module
│   ├── auth/                   # Authentication and guards
│   ├── agents/                 # Agent lifecycle
│   ├── sessions/               # Session management
│   └── ...                     # admin, projects, livekit, metrics, and more
├── frontend-ui/                # React frontend
├── agents/
│   ├── stella-ai-agent-sdk/    # The Python SDK (published to PyPI)
│   ├── stella-v2-agent/        # Full-featured agent
│   └── stella-light-agent/     # Lighter agent
├── stt-service/                # Speech-to-text service
├── tts-service/                # Text-to-speech service
├── prisma/                     # Database schema and migrations
├── k8s/                        # Kubernetes manifests
├── scripts/                    # Deployment scripts
└── docs-site/                  # Documentation (Docusaurus)
```

## 🧪 Testing

### Backend Tests

```bash
npm test
npm run test:coverage
```

### Frontend Tests

```bash
cd frontend-ui
npm test
```

### Agent Tests

```bash
cd agents/stella-ai-agent-sdk
python -m pytest
```

Python 3.10 or newer. The other agents under `agents/` have their own suites, run
the same way.

## 📚 Documentation

- Documentation is in `docs-site/` using Docusaurus
- Run locally: `cd docs-site && npm start`
- Update docs when adding/changing features

## 🆘 Getting Help

- Check the [documentation](https://c4dhi.github.io/STELLA/)
- Ask in [Discussions](https://github.com/c4dhi/STELLA/discussions)
- Join our community chat (if available)

## 📄 License

By contributing, you agree that your contributions will be licensed under the project's license.
