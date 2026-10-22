---
sidebar_position: 4
title: "Authentication"
---

# Authentication

STELLA uses JWT-based authentication to secure API endpoints and manage user access to projects.

## Overview

The authentication system provides:

- **User registration and login** with email/password
- **JWT tokens** for stateless authentication
- **Role-based access control** via project memberships
- **Global route protection** with public route exceptions

## Architecture

```
src/
├── auth/
│   ├── auth.module.ts           # Auth module configuration
│   ├── auth.service.ts          # Signup, login, password hashing
│   ├── auth.controller.ts       # Auth endpoints
│   ├── dto/
│   │   ├── signup.dto.ts        # Signup validation
│   │   └── login.dto.ts         # Login validation
│   ├── strategies/
│   │   └── jwt.strategy.ts      # JWT validation
│   └── guards/
│       ├── jwt-auth.guard.ts    # Route protection
│       └── project-access.guard.ts  # Project-level access
├── common/
│   └── decorators/
│       ├── current-user.decorator.ts  # Extract user from request
│       └── public.decorator.ts        # Mark routes as public
```

## Database Schema

See [Database Schema](../architecture/database.md) for the complete data model. Key models for authentication:

### User Model

```prisma
model User {
  id          String   @id @default(uuid())
  email       String   @unique
  password    String   // bcrypt hashed
  name        String
  createdAt   DateTime @default(now())

  projectMemberships ProjectMembership[]
}
```

### Project Membership

```prisma
model ProjectMembership {
  id        String     @id @default(uuid())
  userId    String
  projectId String
  role      MemberRole @default(MEMBER)

  user      User       @relation(fields: [userId], references: [id])
  project   Project    @relation(fields: [projectId], references: [id])

  @@unique([userId, projectId])
}

enum MemberRole {
  OWNER
  ADMIN
  MEMBER
}
```

## API Endpoints

### Public Endpoints

These endpoints don't require authentication:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/auth/signup` | POST | Register a new user |
| `/auth/login` | POST | Authenticate and get token |
| `/health` | GET | Health check |
| `/` | GET | Root endpoint |

### Protected Endpoints

All other endpoints require a valid JWT token:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/auth/me` | GET | Get current user info |
| `/projects` | GET | List user's projects |
| `/projects` | POST | Create a new project |
| `/projects/:id` | GET | Get project details |
| `/sessions/:id` | GET | Get session details |

Anything inside a project (the project itself, its sessions and their messages, transcripts, agents and invitations) also requires the signed-in user to be a member of that project. System admins are no exception. A request for something in another project is refused with 403 (routes that name the project) or 404 (routes that name a session, agent or invitation inside it).

## Usage

### 1. Sign Up

```bash
curl -X POST http://localhost:3000/auth/signup \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com",
    "password": "SecurePass123!",
    "name": "John Doe"
  }'
```

**Response:**

```json
{
  "user": {
    "id": "uuid",
    "email": "user@example.com",
    "name": "John Doe",
    "createdAt": "2025-10-03T..."
  },
  "token": "eyJhbGciOiJIUzI1NiIs..."
}
```

### 2. Log In

```bash
curl -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com",
    "password": "SecurePass123!"
  }'
```

### 3. Use Token in Requests

```bash
curl http://localhost:3000/auth/me \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIs..."
```

**Response:**

```json
{
  "id": "uuid",
  "email": "user@example.com",
  "name": "John Doe",
  "createdAt": "2025-10-03T...",
  "projectMemberships": []
}
```

### 4. Create Project with Auth

```bash
curl -X POST http://localhost:3000/projects \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "My Project"}'
```

## Frontend Integration

### Store Token After Login

```typescript
const { token } = await api.post('/auth/signup', {
  email: 'user@example.com',
  password: 'SecurePass123!',
  name: 'John Doe'
});

localStorage.setItem('jwt', token);
```

### Include Token in Requests

```typescript
const api = {
  async get(path: string) {
    const token = localStorage.getItem('jwt');
    const response = await fetch(`${API_URL}${path}`, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });
    return response.json();
  },

  async post(path: string, data: any) {
    const token = localStorage.getItem('jwt');
    const response = await fetch(`${API_URL}${path}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(data)
    });
    return response.json();
  }
};
```

## Security Features

| Feature | Status | Notes |
|---------|--------|-------|
| Password hashing | Implemented | bcrypt with 12 rounds |
| JWT tokens | Implemented | 7-day expiration |
| Global authentication | Implemented | All routes protected by default |
| Role-based access | Implemented | Via ProjectMembership |
| Input validation | Implemented | On all DTOs |
| Token blacklist | Not implemented | For logout functionality |
| Rate limiting | Not implemented | Recommended for production |
| Password strength | Basic | Minimum length only |

## Configuration

### Environment Variables

```bash
# JWT Configuration
JWT_SECRET=your-secret-key-here
JWT_EXPIRATION=7d
```

### Database Migration

After modifying the schema:

```bash
# Create and apply migration
npx prisma migrate dev --name add_authentication

# Regenerate Prisma client
npx prisma generate
```

## Project Access Control

When creating a project, the user automatically becomes the OWNER:

```typescript
// In projects.service.ts
async create(userId: string, createProjectDto: CreateProjectDto) {
  return this.prisma.project.create({
    data: {
      ...createProjectDto,
      memberships: {
        create: {
          userId,
          role: 'OWNER',
        },
      },
    },
  });
}
```

Filter projects by user access:

```typescript
async findAll(userId: string) {
  const memberships = await this.prisma.projectMembership.findMany({
    where: { userId },
    select: { projectId: true },
  });

  const projectIds = memberships.map(m => m.projectId);

  return this.prisma.project.findMany({
    where: {
      id: { in: projectIds },
    },
  });
}
```

## Migration Strategy

### Option A: Gradual Rollout

1. Make auth optional initially (remove global guard)
2. Allow time for clients to update
3. Enable auth enforcement after migration period

### Option B: Immediate Enforcement

1. Deploy with auth enabled
2. Provide migration guide
3. Create default admin user for existing deployments

## Future Enhancements

- Password reset via email
- Refresh tokens with rotation
- Email verification
- MFA/2FA support
- OAuth integration (Google, GitHub)
- Rate limiting on auth endpoints
- API keys for programmatic access

## See Also

- [Database Schema](../architecture/database.md) - Complete data model
- [Frontend Integration](../integration/frontend.md)
- [Environment Variables](../architecture/environment-variables.md)
