---
sidebar_position: 4
title: Kubernetes Orchestration
description: How STELLA manages agent pods in Kubernetes
---

# Kubernetes Orchestration

STELLA uses Kubernetes to dynamically deploy and manage AI agent pods. Each conversation session gets its own isolated pod with dedicated resources.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Kubernetes Cluster                       │
│  ┌────────────────────────────────────────────────────────┐ │
│  │                  Namespace: ai-agents                   │ │
│  │                                                         │ │
│  │  ┌─────────────┐  Manages   ┌──────────────────────┐   │ │
│  │  │   Backend   │──────────▶ │    Agent Pods        │   │ │
│  │  │  (NestJS)   │            │  ┌────┐ ┌────┐ ┌───┐ │   │ │
│  │  └─────────────┘            │  │Pod1│ │Pod2│ │...│ │   │ │
│  │        │                    │  └────┘ └────┘ └───┘ │   │ │
│  │        │                    └──────────────────────┘   │ │
│  │        │                                               │ │
│  │        ▼                                               │ │
│  │  ┌─────────────┐            ┌──────────────────────┐   │ │
│  │  │  Secrets    │            │   ConfigMaps         │   │ │
│  │  │  (per pod)  │            │   (shared config)    │   │ │
│  │  └─────────────┘            └──────────────────────┘   │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

## Pod Lifecycle

### 1. Session Created

When a session is created, the backend prepares the Kubernetes resources:

```typescript
// Backend creates session
async createSession(dto: CreateSessionDto) {
  // 1. Create session record in database
  const session = await this.prisma.session.create({
    data: {
      projectId: dto.projectId,
      agentType: dto.agentType,
      status: 'PENDING'
    }
  });

  // 2. Create Kubernetes secret with credentials
  await this.k8s.createSecret(session.id, {
    LIVEKIT_URL: process.env.LIVEKIT_URL,
    LIVEKIT_API_KEY: process.env.LIVEKIT_API_KEY,
    LIVEKIT_API_SECRET: process.env.LIVEKIT_API_SECRET,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    ROOM_NAME: session.roomName,
    SESSION_ID: session.id
  });

  // 3. Create agent pod
  await this.k8s.createAgentPod(session.id, dto.agentType);

  return session;
}
```

### 2. Pod Specification

Agent pods are created with specific resource requirements:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: agent-{session-id}
  namespace: ai-agents
  labels:
    app: stella-agent
    session: {session-id}
    agent-type: stella-agent
spec:
  containers:
  - name: agent
    image: ghcr.io/c4dhi/stella-agent:latest
    envFrom:
    - secretRef:
        name: agent-secret-{session-id}
    resources:
      requests:
        cpu: "250m"
        memory: "512Mi"
      limits:
        cpu: "1000m"
        memory: "2Gi"
    livenessProbe:
      httpGet:
        path: /health
        port: 8080
      initialDelaySeconds: 30
      periodSeconds: 10
    readinessProbe:
      httpGet:
        path: /ready
        port: 8080
      initialDelaySeconds: 5
      periodSeconds: 5
  restartPolicy: Never
  terminationGracePeriodSeconds: 30
```

### 3. Pod Monitoring

The backend watches pod status changes:

```typescript
// Watch for pod status changes
k8sWatch.watch(
  '/api/v1/namespaces/ai-agents/pods',
  { labelSelector: 'app=stella-agent' },
  (type, pod) => {
    const sessionId = pod.metadata.labels.session;

    switch (type) {
      case 'MODIFIED':
        if (pod.status.phase === 'Running') {
          // Pod is ready, update session status
          this.updateSessionStatus(sessionId, 'ACTIVE');
        }
        break;

      case 'DELETED':
        // Pod was deleted, clean up session
        this.handlePodDeleted(sessionId);
        break;
    }
  }
);
```

### 4. Session Termination

When a session ends, resources are cleaned up:

```typescript
async endSession(sessionId: string) {
  // 1. Update session status
  await this.prisma.session.update({
    where: { id: sessionId },
    data: { status: 'ENDING' }
  });

  // 2. Delete the pod (triggers graceful shutdown)
  await this.k8s.deleteNamespacedPod(
    `agent-${sessionId}`,
    'ai-agents'
  );

  // 3. Delete the secret
  await this.k8s.deleteNamespacedSecret(
    `agent-secret-${sessionId}`,
    'ai-agents'
  );

  // 4. Mark session as ended
  await this.prisma.session.update({
    where: { id: sessionId },
    data: {
      status: 'ENDED',
      endedAt: new Date()
    }
  });
}
```

## Resource Management

### Resource Limits by Agent Type

| Agent Type | CPU Request | CPU Limit | Memory Request | Memory Limit |
|-----------|------------|-----------|----------------|--------------|
| stella-agent | 250m | 1000m | 512Mi | 2Gi |
| stella-light | 100m | 500m | 256Mi | 1Gi |
| echo-agent | 50m | 250m | 128Mi | 512Mi |

### Namespace Quotas

Limit total resources in the namespace:

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: ai-agents-quota
  namespace: ai-agents
spec:
  hard:
    requests.cpu: "10"
    requests.memory: 20Gi
    limits.cpu: "20"
    limits.memory: 40Gi
    pods: "50"
```

### Limit Ranges

Set default resource limits for pods:

```yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: ai-agents-limits
  namespace: ai-agents
spec:
  limits:
  - default:
      cpu: "500m"
      memory: 1Gi
    defaultRequest:
      cpu: "100m"
      memory: "256Mi"
    type: Container
```

## Pod Security

### Secret Management

Secrets are created per-session and contain:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: agent-secret-{session-id}
  namespace: ai-agents
type: Opaque
data:
  LIVEKIT_URL: {base64-encoded}
  LIVEKIT_API_KEY: {base64-encoded}
  LIVEKIT_API_SECRET: {base64-encoded}
  OPENAI_API_KEY: {base64-encoded}
  ROOM_NAME: {base64-encoded}
  SESSION_ID: {base64-encoded}
```

An uploaded agent's secret holds `LIVEKIT_TOKEN` instead of `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET`: a token the backend signs for that session's room and the agent's own identity, valid for 24 hours. With the key and secret, an agent could sign itself into any room, so only the built-in agents get them. A restart or an auto-pause wake creates a new pod with a new token.

### Security Context

Pods run with restricted permissions:

```yaml
spec:
  securityContext:
    runAsNonRoot: true
    runAsUser: 1000
    fsGroup: 1000
  containers:
  - name: agent
    securityContext:
      allowPrivilegeEscalation: false
      readOnlyRootFilesystem: true
      capabilities:
        drop:
        - ALL
```

### Network Policies

Restrict network access for agent pods:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: agent-network-policy
  namespace: ai-agents
spec:
  podSelector:
    matchLabels:
      app: stella-agent
  policyTypes:
  - Egress
  egress:
  # Allow DNS
  - to:
    - namespaceSelector: {}
    ports:
    - protocol: UDP
      port: 53
  # Allow LiveKit
  - to:
    - ipBlock:
        cidr: 0.0.0.0/0
    ports:
    - protocol: TCP
      port: 443
    - protocol: UDP
      port: 443
  # Allow OpenAI API
  - to:
    - ipBlock:
        cidr: 0.0.0.0/0
    ports:
    - protocol: TCP
      port: 443
```

## Scaling Considerations

### Horizontal Pod Autoscaling

While each session has its own pod, you can use HPA for shared services:

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: backend-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: session-management-server
  minReplicas: 2
  maxReplicas: 10
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
```

### Node Affinity

Ensure agent pods run on appropriate nodes:

```yaml
spec:
  affinity:
    nodeAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        nodeSelectorTerms:
        - matchExpressions:
          - key: workload-type
            operator: In
            values:
            - ai-agents
```

## Monitoring

### Pod Metrics

Expose metrics for monitoring:

```python
# In agent code
from prometheus_client import Counter, Histogram

messages_processed = Counter(
    'agent_messages_processed_total',
    'Total messages processed',
    ['agent_type', 'session_id']
)

response_latency = Histogram(
    'agent_response_latency_seconds',
    'Response generation latency',
    ['agent_type']
)
```

### Health Checks

Implement health endpoints:

```python
from fastapi import FastAPI

app = FastAPI()

@app.get("/health")
async def health():
    return {"status": "healthy"}

@app.get("/ready")
async def ready():
    if agent.is_connected():
        return {"status": "ready"}
    return Response(status_code=503)
```

## Next Steps

- [Session Lifecycle](./session-lifecycle.md) - Session states
- [Deployment Guide](../deployment/kubernetes.md) - Production deployment
- [Monitoring](../deployment/monitoring.md) - Observability setup
