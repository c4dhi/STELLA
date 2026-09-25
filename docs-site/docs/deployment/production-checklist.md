---
sidebar_position: 2
title: Production Checklist
description: Ensure your STELLA deployment is production-ready
---

# Production Checklist

Use this checklist to verify your STELLA deployment is ready for production.

## Security

### Authentication & Authorization

- [ ] **API authentication enabled** - Secure all endpoints
- [ ] **LiveKit tokens validated** - Verify token signatures
- [ ] **HTTPS enabled** - TLS certificates configured
- [ ] **CORS configured** - Only allow trusted origins
- [ ] **Rate limiting enabled** - Prevent abuse

### Secrets Management

- [ ] **No hardcoded secrets** - All secrets in environment variables
- [ ] **Kubernetes secrets used** - Not ConfigMaps for sensitive data
- [ ] **Secret rotation plan** - Process to rotate API keys
- [ ] **Minimal permissions** - Least privilege principle

### Network Security

- [ ] **Network policies** - Restrict pod-to-pod communication
- [ ] **Ingress secured** - TLS termination at ingress
- [ ] **Internal services private** - Only expose what's needed

## Infrastructure

### Kubernetes

- [ ] **Resource limits set** - CPU and memory for all pods
- [ ] **Health checks configured** - Liveness and readiness probes
- [ ] **Pod disruption budgets** - Maintain availability
- [ ] **Horizontal Pod Autoscaler** - Scale backend on demand
- [ ] **Node affinity** - Agents on appropriate nodes

### Database

- [ ] **Backups configured** - Regular automated backups
- [ ] **Backup testing** - Restore tested periodically
- [ ] **Connection pooling** - PgBouncer or similar
- [ ] **Replication** - High availability setup
- [ ] **Monitoring** - Query performance tracked

### Storage

- [ ] **Persistent volumes** - Data survives restarts
- [ ] **Storage class appropriate** - SSD for database
- [ ] **Backup storage** - Separate from primary

## Monitoring

### Metrics

- [ ] **Prometheus configured** - Scraping all services
- [ ] **Key metrics defined**:
  - Request latency
  - Error rates
  - Active sessions
  - Agent pod count
  - Database connections

### Logging

- [ ] **Structured logging** - JSON format
- [ ] **Log aggregation** - Centralized logging (ELK, Loki)
- [ ] **Log retention policy** - Storage management
- [ ] **Sensitive data filtered** - No secrets in logs

### Alerting

- [ ] **Alert rules defined**:
  - High error rate
  - Service down
  - High latency
  - Resource exhaustion
- [ ] **Alert channels configured** - Slack, PagerDuty, etc.
- [ ] **Runbooks created** - Response procedures

### Tracing

- [ ] **Distributed tracing** - Jaeger or similar
- [ ] **Trace sampling** - Balance detail and cost
- [ ] **Cross-service correlation** - Request IDs

## Performance

### Latency

- [ ] **Response time targets** - P50, P95, P99 defined
- [ ] **CDN configured** - Static assets cached
- [ ] **Database indexes** - Optimized queries
- [ ] **Connection reuse** - HTTP keep-alive

### Capacity

- [ ] **Load testing completed** - Know your limits
- [ ] **Simultaneous sessions within limits** - About 10 per server today (see the known limitation in the [Production Deployment Guide](./production.md))
- [ ] **Capacity planning** - Growth projections
- [ ] **Graceful degradation** - Behavior under load

## Reliability

### High Availability

- [ ] **Multi-replica deployment** - No single points of failure
- [ ] **Cross-zone deployment** - Survive zone failure
- [ ] **Database HA** - Primary/replica setup

### Disaster Recovery

- [ ] **Recovery plan documented** - Steps to restore
- [ ] **RTO defined** - Recovery time objective
- [ ] **RPO defined** - Recovery point objective
- [ ] **DR testing** - Regular drills

### Rollback

- [ ] **Rollback procedure** - Quick version revert
- [ ] **Blue-green or canary** - Safe deployment strategy
- [ ] **Feature flags** - Gradual rollout

## Operations

### Documentation

- [ ] **Architecture documented** - System diagrams
- [ ] **Runbooks created** - Operational procedures
- [ ] **On-call rotation** - Response coverage

### Maintenance

- [ ] **Update procedure** - Zero-downtime updates
- [ ] **Dependency updates** - Security patches
- [ ] **Certificate renewal** - Automated if possible

## Configuration Reference

### Production Environment Variables

```bash
# Application
NODE_ENV=production
LOG_LEVEL=info

# Database
DATABASE_URL=postgresql://user:pass@db:5432/stella?sslmode=require
DATABASE_POOL_SIZE=20

# LiveKit
LIVEKIT_URL=wss://livekit.yourdomain.com
LIVEKIT_API_KEY=your-api-key
LIVEKIT_API_SECRET=your-api-secret

# Security
JWT_SECRET=your-secure-jwt-secret
CORS_ORIGINS=https://yourdomain.com

# Monitoring
OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4318
```

### Resource Recommendations

| Service | CPU Request | CPU Limit | Memory Request | Memory Limit |
|---------|------------|-----------|----------------|--------------|
| Backend | 500m | 2000m | 512Mi | 2Gi |
| Frontend | 100m | 500m | 128Mi | 512Mi |
| PostgreSQL | 500m | 2000m | 1Gi | 4Gi |
| stella-agent | 250m | 1000m | 512Mi | 2Gi |

## Pre-Launch Checklist

### Final Verification

- [ ] All environment variables set correctly
- [ ] SSL certificates valid and not expiring soon
- [ ] DNS configured and propagated
- [ ] Monitoring dashboards accessible
- [ ] Alert notifications working
- [ ] Backup recovery tested
- [ ] Load test results acceptable
- [ ] Security scan completed
- [ ] Documentation reviewed and updated

### Launch Day

- [ ] Team aware of launch time
- [ ] On-call coverage confirmed
- [ ] Communication channels ready
- [ ] Rollback procedure understood
- [ ] Monitoring dashboards open

## Next Steps

- [Monitoring](./monitoring.md) - Set up observability
- [Kubernetes Deployment](./kubernetes.md) - Deployment guide
