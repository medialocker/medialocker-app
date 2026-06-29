---
layout: home

hero:
  name: MediaLocker
  text: Documentation
  tagline: Cloud object storage built for media creators — buckets, tagging, sets, storyboards, a REST API, and short-lived presigned URLs.
  actions:
    - theme: brand
      text: Get Started
      link: /user/
    - theme: alt
      text: API Reference
      link: /developer/
    - theme: alt
      text: Self-Host
      link: /self-hosting/

features:
  - icon: 📦
    title: User Guide
    details: Get started in the dashboard — create buckets, upload media, organize with tags, sets, and storyboards, and manage usage and billing.
    link: /user/
  - icon: 🔌
    title: Developer Docs
    details: The REST API, authentication and scopes, rate limits, errors, idempotency, presigned uploads, and the MCP server for AI agents.
    link: /developer/
  - icon: 🛠
    title: Self-Hosting
    details: Deploy MediaLocker on your own infrastructure with Docker Compose, a Supabase Cloud backend, Hetzner object storage, and wildcard TLS.
    link: /self-hosting/
---

## What is MediaLocker?

MediaLocker is cloud object storage built for media creators. It provides buckets,
media tagging, sets, storyboards, and developer tools — all accessed through a REST
API and short-lived presigned URLs, with an MCP server for AI agents.

- **Bring your own access path** — drive everything from the dashboard, the REST API, or an MCP client.
- **Presigned, never proxied** — object bytes move directly between your client and storage over short-lived signed URLs.
- **Organize at scale** — tags, categories, sets (variant collections), and storyboards (clip sequences).
- **Built-in usage & billing** — per-organization quotas, usage history, and Stripe-backed capacity.
