# CLAUDE.md - Project Context for AI Assistants

This file contains important context about the STELLA backend project for AI assistants working on this codebase.

## Project Structure

- **Backend**: NestJS application in `src/`
- **Frontend**: React application in `frontend-ui/`
- **Database**: PostgreSQL with Prisma ORM
- **Deployment**: Kubernetes (K8s) via scripts in `scripts/` and manifests in `k8s/`

## Agent Platform Standards (read before changing agents, deploy, upload, SDK or the wizard)

`agent.yaml` is the single source of truth for an agent; STELLA has no agent-specific code. The full rules, and which module owns which concern, are in `docs-site/docs/contributing/coding-standards/agent-platform.md`. In short:
- Behaviour that differs between agents is a manifest declaration, never `if (slug === …)`. The only slug in `src/` is in `src/agents/default-agent-type.ts`.
- Every declaration is enforced on deploy, restart and wake; anything undeclared is refused, not ignored.
- One owner per concern: extend it (`agent-manifest.schema.ts`, `manifest-normalizer.ts`, `manifest-mapper.ts`, `manifest-defaults.ts`, `agent-requirements.ts`, `deploy-request.ts`), never copy it.
- Pure logic in plain functions; services only fetch, call and persist. Defaults are set once and pinned by specs.

## Database & Prisma Migrations

### CRITICAL: Schema Change Workflow

When modifying `prisma/schema.prisma`, you MUST create a migration file:

```bash
# 1. Make changes to prisma/schema.prisma

# 2. Create migration file AND apply locally:
npm run db:migrate:dev -- --name description_of_change

# 3. Commit BOTH:
#    - prisma/schema.prisma
#    - prisma/migrations/<timestamp>_description_of_change/migration.sql
```

### Why This Matters

- `prisma generate` only generates the TypeScript client - it does NOT update the database
- `prisma db push` updates the database but does NOT create migration files
- `prisma migrate deploy` (used in production) only applies existing migration files

If you use `db push` without creating a migration file, the schema change will NOT be applied during deployment, causing runtime errors.

### Automatic Migration Deployment

Migrations are automatically applied:
- **Local development**: `npm run start:dev` runs `prestart:dev` which executes `prisma migrate deploy`
- **K8s deployment**: The `run-migrations` init container runs `prisma migrate deploy`

### If Schema Gets Out of Sync

If the database schema doesn't match and you've already applied changes with `db push`:

```bash
# 1. Create the migration file manually in prisma/migrations/<timestamp>_name/migration.sql

# 2. Mark it as already applied:
DATABASE_URL="postgresql://..." npx prisma migrate resolve --applied <migration_name>

# 3. Verify:
DATABASE_URL="postgresql://..." npx prisma migrate status
```

## Authentication & Authorization

### JWT Strategy
- Located in `src/auth/strategies/jwt.strategy.ts`
- Supports both user tokens and participant tokens
- User payload includes: `userId`, `email`, `name`, `isSystemAdmin`, `projectIds`, `projectRoles`

### Guards
- `JwtAuthGuard` - Global guard for authentication
- `ProjectAccessGuard` - Checks user has access to a project
- `SystemAdminGuard` - Checks `isSystemAdmin` flag for admin-only endpoints

## Admin Dashboard

System administrators (`isSystemAdmin: true`) can access `/settings/admin` which provides:
- Real-time platform metrics via SSE
- Server performance monitoring (CPU/RAM/GPU)
- Session activity visualization
- User management

To make a user a system admin:
```sql
UPDATE "User" SET "isSystemAdmin" = true WHERE email = 'admin@example.com';
```

## SSE (Server-Sent Events) Pattern

SSE endpoints use query parameter for auth token (EventSource doesn't support headers):
```typescript
// Backend: Token extracted in JwtAuthGuard from ?token= query param
@Sse('endpoint')
streamData(): Observable<MessageEvent> { ... }

// Frontend: Pass token in URL
const url = `${baseUrl}/endpoint?token=${encodeURIComponent(token)}`
const eventSource = new EventSource(url)
```

## Key File Locations

| Component | Path |
|-----------|------|
| Prisma Schema | `prisma/schema.prisma` |
| Migrations | `prisma/migrations/` |
| JWT Strategy | `src/auth/strategies/jwt.strategy.ts` |
| Auth Guards | `src/auth/guards/` |
| Admin Module | `src/admin/` |
| API Client | `frontend-ui/src/services/ApiClient.ts` |
| API Types | `frontend-ui/src/lib/api-types.ts` |
| Settings Page | `frontend-ui/src/pages/SettingsPage.tsx` |
| Plan Generator Prompt | `src/plan-templates/plan-generator.service.ts` |
| Plan Builder Docs | `docs-site/docs/plan-structure/plan-builder.md` |
| Transition Conditions Docs | `docs-site/docs/plan-structure/states.md` |
| Plan Builder Images | `docs-site/assets/img/` |
| K8s Manifests | `k8s/` |
| Deploy Script | `scripts/lib/deploy.sh` |

## Common Commands

```bash
# Database
npm run db:migrate:dev -- --name change_name  # Create & apply migration
npm run db:migrate                             # Apply pending migrations
npm run db:push                                # Sync schema (dev only, no migration file)
npm run db:generate                            # Generate Prisma client

# Development
npm run start:dev                              # Start with hot reload
npm run build                                  # Build for production

# Deployment
./scripts/start-k8s.sh                         # Full K8s deployment
```
