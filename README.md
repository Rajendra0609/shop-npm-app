# Shop npm application

A small production-style shop with a React frontend and an Express/Postgres backend. It includes product listing, cart, checkout, stock reduction, and product updates.

## Architecture

The application uses three separate containers:

| Container | Image | Host port |
|---|---|---|
| PostgreSQL | `postgres:16` | Internal only |
| Backend | `shop-backend:local` | `8080` |
| Frontend | `shop-frontend:local` | `5173` |

The frontend sends `/api/*` requests to the backend through Nginx.

## Run locally with npm

```powershell
cd shop-npm-app
npm install
npm run dev
```

- Frontend: http://localhost:5173
- Backend: http://localhost:8080
- Health: http://localhost:8080/api/healthz

Without `DATABASE_URL`, the backend uses in-memory data. This is useful for local development and resets when the process restarts.

## Run all three services with Docker

No npm installation is required inside the host application directory:

```powershell
npm run docker:up
```

Or run Compose directly:

```powershell
docker compose up --build
```

Open http://localhost:5173.

Stop the containers while keeping database data:

```powershell
npm run docker:down
```

Remove the containers and PostgreSQL volume:

```powershell
npm run docker:clean
```

Build the two npm application images separately:

```powershell
docker build -f backend/Dockerfile -t shop-backend:local .
docker build -f frontend/Dockerfile -t shop-frontend:local .
```

## API

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/healthz` | Service health |
| GET | `/api/products` | List products |
| PATCH | `/api/products/:id` | Update name, description, price, stock, or category |
| POST | `/api/checkout` | Confirm an order and reduce stock |

## Test and build

```powershell
npm test
npm run build
npm start
```

## Production hardening included

- `SHOP_API_TOKEN` and `SHOP_API_USERS` protect product updates and provide a basic checkout user mapping.
- `Idempotency-Key` on checkout replay prevents duplicate orders and stock reduction.
- PostgreSQL schema changes are applied from versioned SQL files in `backend/migrations`.
- `/api/healthz`, `/api/readyz`, and `/metrics` support liveness, readiness, and Prometheus scraping.
- JSON request logs include request IDs and optional `traceparent` propagation.
- Per-IP rate limiting is enabled by default and can be configured with `RATE_LIMIT_*`.
- Optional mutual TLS termination can be enabled with `TLS_CERT_PATH` and `TLS_KEY_PATH`.
- Database SSL can be enabled with `DATABASE_SSL=true`.
- Kubernetes resources include NetworkPolicies, PDBs, HPA, RBAC, quota, backup CronJob, Ingress, and a ServiceMonitor.

In production, set `SHOP_REQUIRE_API_AUTH=true`, provide a secret-bearing environment, and replace the Compose
password with a secret manager or Sealed Secret. Do not commit real API tokens or database passwords.
