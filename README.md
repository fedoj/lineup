# Lineup

Team lineup, fair rotation and season tracking. First app on a shared
TypeScript platform designed to host many small apps.

## Stack

| Layer | Technology |
|---|---|
| Web | React 18 + TypeScript + Vite |
| API | Azure Functions v4 (TypeScript) |
| Database | Azure Database for PostgreSQL Flexible Server |
| Hosting | Azure Static Web Apps |
| IaC | Bicep |
| CI/CD | GitHub Actions with OIDC federation |
| Mobile (planned) | Capacitor wrapper for Play Store / App Store |

## Layout

```
apps/web/          React front end
api/               Azure Functions HTTP API
packages/shared/   Types + entitlement engine, reused by every future app
infra/             Bicep templates
db/migrations/     SQL schema
```

## Environments

| Branch | Deploys to | Database | How code lands |
|---|---|---|---|
| `dev` | `lineup-dev-webapp` | `lineup-dev` | direct push |
| `main` | `lineup-prd-webapp` | `lineup-prd` | pull request only |

## Local development

```bash
npm ci
npm run build --workspace packages/shared

# API (requires Azure Functions Core Tools)
cd api && npm start

# Web, in a second terminal
npm run dev --workspace apps/web
```

Create `api/local.settings.json`:

```json
{
  "IsEncrypted": false,
  "Values": {
    "FUNCTIONS_WORKER_RUNTIME": "node",
    "AzureWebJobsStorage": "",
    "DATABASE_URL": "postgres://user:pass@host:5432/lineup-dev?sslmode=require",
    "PAYWALL_ENABLED": "false",
    "APP_ENV": "local"
  }
}
```

## Pricing model

Capacity tiers scale 4x. `PAYWALL_ENABLED=false` treats every account as
unlimited, so the product can launch free and enable billing later without
a code change.

| Tier | Teams | Games | One-time |
|---|---|---|---|
| Free | 1 | 20 | $0 |
| Club | 4 | 80 | $9.99 |
| League | 16 | 320 | $39.99 |
| Region | 64 | 1,280 | $159.99 |

## Deployment authentication

GitHub Actions authenticates to Azure with **OIDC federated credentials**.
No client secret is stored and nothing expires. The Static Web Apps deploy
token is fetched at run time via the Azure CLI rather than kept as a
repository secret.

Repository **variables** (not secrets — these values are not sensitive):

- `AZURE_CLIENT_ID`
- `AZURE_TENANT_ID`
- `AZURE_SUBSCRIPTION_ID`
