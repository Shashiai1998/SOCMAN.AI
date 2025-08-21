# Multi-Platform Ads Manager (scaffold)

Overview
- Centralize metrics from Google Ads, Meta (Facebook/Instagram) Ads, LinkedIn Ads, etc.
- Connect provider accounts via OAuth, store (encrypted) tokens, fetch metrics in background jobs and display consolidated dashboard & emailed reports.

Stack
- Next.js (TypeScript) — frontend + API routes
- PostgreSQL + Prisma — relational storage
- Redis + BullMQ — background fetching & scheduling
- NextAuth — user auth
- Deploy: Vercel + Railway/Render/Fly

Quick start (local)
1. Copy .env.example -> .env and fill values.
2. Install:
   - pnpm install (or npm install)
3. Setup DB:
   - pnpm prisma migrate dev --name init
4. Start Redis (or use hosted) and set REDIS_URL
5. Start dev server:
   - pnpm dev
6. Start worker in separate terminal:
   - pnpm run worker

Project structure (selected)
- prisma/                  -- Prisma schema
- src/pages/api/           -- API routes (auth, connectors, metrics)
- src/pages/index.tsx      -- Dashboard (client view)
- src/lib/                 -- DB, encryption, provider clients
- src/worker/              -- background fetcher using BullMQ

Important notes
- Do not store raw provider tokens in plaintext in production. Use KMS/HSM. This scaffold uses symmetric encryption for demonstration.
- Provider SDKs require you to register apps and set redirect URIs.
- Each provider has its own API & rate limits — implement backoff and per-account scheduling.

If you want, I can:
- Implement Google Ads connector with OAuth + example metrics query.
- Implement Meta Ads connector and sample insights fetching.
- Build a customizable report UI & email sender.

Tell me which provider to implement first and I’ll produce concrete connector code next.