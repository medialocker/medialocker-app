# Scaling Considerations

Guidance for scaling MediaLocker beyond a single-node deployment.

## When to Scale

| Metric | Single Node Limit | Action |
|---|---|---|
| Total objects | — | Storage scales with Hetzner Object Storage, not local drives |
| Total storage | — | Storage scales with Hetzner Object Storage, not local drives |
| API requests | 500 req/s | Scale API horizontally |
| Concurrent uploads | 100+ | Scale API (object bytes go browser→Hetzner via presigned URLs) |
| Organization count | 5,000+ | Move to a larger Supabase Cloud compute tier |

## Object Storage

Object storage is managed by Hetzner Object Storage, so there is nothing to scale at the deployment level — capacity and durability are handled by the provider. Uploads and downloads go directly between the client and Hetzner via presigned URLs, so they never flow through your compute nodes. Run the worker in the same Hetzner region as the bucket data to keep derivative generation fast.

## API Horizontal Scaling

Scale the API service behind Caddy load balancing:

```yaml
api-1:
  build:
    context: .
    dockerfile: apps/api/Dockerfile

api-2:
  build:
    context: .
    dockerfile: apps/api/Dockerfile

# Caddy load balancing:
api.medialocker.io {
    reverse_proxy api-1:3001 api-2:3001 {
        lb_policy round_robin
    }
}
```

## Postgres Scaling (Supabase Cloud)

Postgres is managed by Supabase Cloud, so there is nothing to tune on the host — no `shared_buffers`, no self-hosted PgBouncer. Scale the database by:

1. **Upgrading the Supabase Cloud plan / compute tier** to add CPU, RAM, and IOPS.
2. **Adding read replicas** through the Supabase dashboard for read-heavy workloads (on supported plans).

### Mind the pooler connection budget

The app already connects through the Supabase **transaction pooler (port `6543`)**. Each of `api`, `worker`, and `mcp` opens its own pool, and every additional replica multiplies that. The pooler enforces a connection limit tied to your compute tier — keep the **sum of all `api` + `worker` + `mcp` pool sizes** under that budget as you scale horizontally, and raise the compute tier (which raises the connection limit) before you run out.

## Redis Scaling

### Redis Sentinel

For high availability:
- 3+ Redis nodes (1 primary, 2+ replicas)
- Sentinel monitors and handles failover

### Redis Cluster

For horizontal scaling of cache:
- Multiple shards across nodes
- Automatic data partitioning

## Worker Scaling

Scale background workers by running multiple instances:

```yaml
worker:
  deploy:
    replicas: 3  # Process more concurrent jobs
```

Each worker polls the same Redis queues — jobs are processed once.

## Caching Strategy

| Layer | Technology | TTL |
|---|---|---|
| API responses | Redis | 60s |
| Media metadata | Redis | 300s |
| Presigned URLs | Redis | URL expiry |

## Monitoring at Scale

Recommended monitoring stack for scaled deployments:

| Metric | Tool | Dashboard |
|---|---|---|
| System metrics | Prometheus + Node Exporter | Grafana |
| Application metrics | OTEL → Prometheus | Grafana |
| Logs | Loki + Promtail | Grafana |
| Postgres | Supabase Cloud observability | Supabase dashboard |
| Redis | redis_exporter | Grafana |

## Load Testing

Before scaling, load test to identify bottlenecks:

```bash
# Using k6 for load testing
k6 run --vus 100 --duration 5m load-test.js
```

Key metrics to watch:
- API latency (p50, p95, p99)
- Error rate
- CPU/memory utilization
- Database connection count
- Redis hit rate
