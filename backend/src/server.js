import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import pg from "pg";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";

dotenv.config();

const { Pool } = pg;
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== "false" } : false
    })
  : null;

const initialProducts = [
  { id: 1, name: "Cloud Field Notes", description: "A durable notebook for incident timelines.", price: 18, stock: 24, category: "Office" },
  { id: 2, name: "Operator Keycaps", description: "Mechanical keycaps for focused engineering.", price: 32, stock: 15, category: "Tools" },
  { id: 3, name: "Readiness Lamp", description: "A warm desk lamp for late-night game days.", price: 45, stock: 8, category: "Office" },
  { id: 4, name: "Canary Tee", description: "Soft cotton tee with a tiny canary mascot.", price: 28, stock: 30, category: "Apparel" }
];

let memoryProducts = initialProducts.map((product) => ({ ...product }));
let nextProductId = initialProducts.length + 1;
let nextOrderId = 1001;
const memoryOrders = [];
const memoryIdempotency = new Map();
const metrics = {
  requests: new Map(),
  errors: new Map(),
  activeRequests: 0,
  checkouts: 0,
  idempotentCheckouts: 0,
  checkoutErrors: 0,
  durations: []
};

function structuredLog(level, message, fields = {}) {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    message,
    service: "shop-backend",
    ...fields
  }));
}

function incrementMetric(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

function getRequestId(request) {
  return request.get("x-request-id") || crypto.randomUUID();
}

function getConfiguredTokens() {
  const userTokens = (process.env.SHOP_API_USERS || "")
    .split(",")
    .map((mapping) => mapping.trim().split(":")[0])
    .filter(Boolean);
  return [process.env.SHOP_API_TOKEN, process.env.SHOP_API_TOKENS, ...userTokens]
    .filter(Boolean)
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
}

function requireAdmin(request, response) {
  const tokens = getConfiguredTokens();
  const authorization = request.get("authorization") || "";
  const suppliedToken = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!tokens.length) {
    if (process.env.NODE_ENV === "production" || process.env.SHOP_REQUIRE_API_AUTH === "true") {
      response.status(503).json({ error: "API authentication is not configured" });
      return false;
    }
    return true;
  }
  const suppliedHash = crypto.createHash("sha256").update(suppliedToken).digest();
  const authenticated = tokens.some((token) => {
    const tokenHash = crypto.createHash("sha256").update(token).digest();
    return crypto.timingSafeEqual(suppliedHash, tokenHash);
  });
  if (!authenticated) {
    response.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

function getAuthenticatedUser(request) {
  const authorization = request.get("authorization") || "";
  const suppliedToken = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const mappings = (process.env.SHOP_API_USERS || "")
    .split(",")
    .map((mapping) => mapping.trim())
    .filter(Boolean);

  for (const mapping of mappings) {
    const separator = mapping.indexOf(":");
    if (separator < 0) continue;
    const token = mapping.slice(0, separator).trim();
    const userId = mapping.slice(separator + 1).trim();
    const suppliedHash = crypto.createHash("sha256").update(suppliedToken).digest();
    const tokenHash = crypto.createHash("sha256").update(token).digest();
    if (crypto.timingSafeEqual(suppliedHash, tokenHash)) return userId;
  }
  return null;
}

function hashCheckout(items) {
  return crypto.createHash("sha256").update(JSON.stringify(items)).digest("hex");
}

function createRateLimiter(limit = 100, windowMs = 60_000) {
  const requests = new Map();
  return function rateLimit(request, response, next) {
    if (process.env.RATE_LIMIT_ENABLED === "false") return next();
    const now = Date.now();
    const key = request.ip || request.socket.remoteAddress || "unknown";
    const timestamps = (requests.get(key) || []).filter((timestamp) => now - timestamp < windowMs);
    timestamps.push(now);
    requests.set(key, timestamps);
    if (timestamps.length > limit) {
      response.set("Retry-After", String(Math.ceil(windowMs / 1000)));
      return response.status(429).json({ error: "Too many requests" });
    }
    next();
  };
}

async function ensureDatabase() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const migrationsPath = fileURLToPath(new URL("../migrations/", import.meta.url));
  const migrationFiles = fs.readdirSync(migrationsPath)
    .filter((file) => file.endsWith(".sql"))
    .sort();

  for (const file of migrationFiles) {
    const version = file.replace(/\.sql$/, "");
    const applied = await pool.query(
      "SELECT 1 FROM schema_migrations WHERE version = $1",
      [version]
    );
    if (applied.rows.length) continue;

    const sql = fs.readFileSync(`${migrationsPath}/${file}`, "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (version) VALUES ($1)",
        [version]
      );
      await client.query("COMMIT");
      structuredLog("info", "Database migration applied", { version });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  const result = await pool.query("SELECT COUNT(*)::int AS count FROM products");
  if (result.rows[0].count === 0) {
    for (const product of initialProducts) {
      await pool.query(
        "INSERT INTO products (id, name, description, price, stock, category) VALUES ($1,$2,$3,$4,$5,$6)",
        [product.id, product.name, product.description, product.price, product.stock, product.category]
      );
    }
  }
}

async function getProducts() {
  if (pool) {
    const result = await pool.query("SELECT * FROM products ORDER BY id");
    return result.rows.map((row) => ({ ...row, price: Number(row.price) }));
  }
  return memoryProducts.map((product) => ({ ...product }));
}

async function getProduct(id) {
  if (pool) {
    const result = await pool.query("SELECT * FROM products WHERE id = $1", [id]);
    if (!result.rows[0]) return null;
    return { ...result.rows[0], price: Number(result.rows[0].price) };
  }
  return memoryProducts.find((product) => product.id === id) ?? null;
}

async function getOrder(id, userId) {
  if (!userId) return null;
  if (pool) {
    const result = await pool.query(
      "SELECT * FROM orders WHERE id = $1 AND user_id = $2",
      [id, userId]
    );
    if (!result.rows[0]) return null;
    return {
      ...result.rows[0],
      id: Number(result.rows[0].id),
      total: Number(result.rows[0].total)
    };
  }
  const order = memoryOrders.find((candidate) => candidate.id === id);
  if (!order) return null;
  if (userId && order.userId !== userId) return null;
  return { ...order };
}

async function updateProduct(id, patch) {
  const allowed = ["name", "description", "price", "stock", "category"];
  const fields = Object.keys(patch).filter((key) => allowed.includes(key));
  if (!fields.length) return getProduct(id);

  if (pool) {
    const values = fields.map((key) => patch[key]);
    const assignments = fields.map((key, index) => `${key} = $${index + 2}`).join(", ");
    const result = await pool.query(
      `UPDATE products SET ${assignments} WHERE id = $1 RETURNING *`,
      [id, ...values]
    );
    if (!result.rows[0]) return null;
    return { ...result.rows[0], price: Number(result.rows[0].price) };
  }

  const product = memoryProducts.find((item) => item.id === id);
  if (!product) return null;
  for (const key of fields) product[key] = patch[key];
  return { ...product };
}

async function createOrder(items, idempotencyKey = null, userId = null) {
  const requestHash = hashCheckout(items);

  if (idempotencyKey) {
    if (pool) {
      const existing = await pool.query(
        "SELECT id, items, total, status, request_hash FROM orders WHERE idempotency_key = $1",
        [idempotencyKey]
      );
      if (existing.rows[0]) {
        if (existing.rows[0].request_hash !== requestHash) {
          return { error: "Idempotency key was already used with a different checkout", status: 409 };
        }
        return {
          order: {
            id: Number(existing.rows[0].id),
            items: existing.rows[0].items,
            total: Number(existing.rows[0].total),
            status: existing.rows[0].status
          },
          replayed: true
        };
      }
    } else {
      const existing = memoryIdempotency.get(idempotencyKey);
      if (existing) {
        if (existing.requestHash !== requestHash) {
          return { error: "Idempotency key was already used with a different checkout", status: 409 };
        }
        return { order: { ...existing.order }, replayed: true };
      }
    }
  }

  const products = await getProducts();
  const normalizedItems = [];

  for (const item of items) {
    const product = products.find((candidate) => candidate.id === item.productId);
    if (!product) return { error: "One or more products do not exist", status: 400 };
    if (!Number.isInteger(item.quantity) || item.quantity < 1) {
      return { error: "Quantity must be a positive integer", status: 400 };
    }
    if (product.stock < item.quantity) {
      return { error: `Only ${product.stock} units of ${product.name} are available`, status: 409 };
    }
    normalizedItems.push({
      productId: product.id,
      name: product.name,
      quantity: item.quantity,
      unitPrice: product.price
    });
  }

  const total = normalizedItems.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);

  if (pool) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const item of normalizedItems) {
        const result = await client.query(
          "UPDATE products SET stock = stock - $1 WHERE id = $2 AND stock >= $1",
          [item.quantity, item.productId]
        );
        if (result.rowCount !== 1) throw new Error("Inventory changed while checkout was in progress");
      }
      const orderIdResult = await client.query("SELECT COALESCE(MAX(id), 1000) + 1 AS id FROM orders");
      const orderId = Number(orderIdResult.rows[0].id);
      await client.query(
        "INSERT INTO orders (id, items, total, status, user_id, idempotency_key, request_hash) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [orderId, JSON.stringify(normalizedItems), total, "confirmed", userId, idempotencyKey, requestHash]
      );
      await client.query("COMMIT");
      return { order: { id: orderId, items: normalizedItems, total, status: "confirmed" } };
    } catch (error) {
      await client.query("ROLLBACK");
      return { error: error.message, status: 409 };
    } finally {
      client.release();
    }
  }

  for (const item of normalizedItems) {
    const product = memoryProducts.find((candidate) => candidate.id === item.productId);
    product.stock -= item.quantity;
  }
  const order = { id: nextOrderId++, items: normalizedItems, total, status: "confirmed", userId };
  memoryOrders.push(order);
  if (idempotencyKey) memoryIdempotency.set(idempotencyKey, { order: { ...order }, requestHash });
  return { order };
}

export function createApp() {
  const app = express();
  if (process.env.TRUST_PROXY === "true") app.set("trust proxy", 1);
  app.disable("x-powered-by");
  const allowedOrigins = (process.env.CORS_ORIGIN || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  app.use(cors({
    origin: allowedOrigins.length
      ? (origin, callback) => callback(null, !origin || allowedOrigins.includes(origin))
      : (process.env.NODE_ENV === "production" ? false : true)
  }));
  app.use(express.json({ limit: "32kb" }));
  app.use((request, response, next) => {
    const requestId = getRequestId(request);
    const traceparent = request.get("traceparent");
    response.set("x-request-id", requestId);
    if (traceparent) response.set("traceparent", traceparent);
    request.requestId = requestId;
    request.traceparent = traceparent;
    metrics.activeRequests += 1;
    const startedAt = process.hrtime.bigint();
    response.once("finish", () => {
      metrics.activeRequests -= 1;
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      metrics.durations.push(durationMs);
      if (metrics.durations.length > 1000) metrics.durations.shift();
      incrementMetric(metrics.requests, `${request.method} ${request.route?.path || request.path} ${response.statusCode}`);
      if (response.statusCode >= 400) incrementMetric(metrics.errors, `${response.statusCode}`);
      structuredLog(response.statusCode >= 500 ? "error" : "info", "request completed", {
        requestId,
        traceparent: traceparent || null,
        method: request.method,
        path: request.path,
        status: response.statusCode,
        durationMs: Number(durationMs.toFixed(2))
      });
    });
    next();
  });
  app.use(createRateLimiter(
    Number(process.env.RATE_LIMIT_REQUESTS || 100),
    Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000)
  ));

  app.get("/api/healthz", (_request, response) => {
    response.json({ status: "OK", service: "shop-backend" });
  });

  app.get("/api/readyz", async (_request, response) => {
    try {
      if (pool) await pool.query("SELECT 1");
      response.json({ status: "OK", database: pool ? "connected" : "memory" });
    } catch (error) {
      response.status(503).json({ status: "NOT_READY", database: "unavailable" });
    }
  });

  app.get("/metrics", (_request, response) => {
    const requestLines = [];
    for (const [key, value] of metrics.requests) {
      const match = key.match(/^(\S+) (\S+) (\d+)$/);
      if (!match) continue;
      requestLines.push(`shop_http_requests_total{method="${match[1]}",path="${match[2]}",status="${match[3]}"} ${value}`);
    }
    const errorLines = [];
    for (const [status, value] of metrics.errors) {
      errorLines.push(`shop_http_errors_total{status="${status}"} ${value}`);
    }
    const averageDuration = metrics.durations.length
      ? metrics.durations.reduce((sum, value) => sum + value, 0) / metrics.durations.length
      : 0;
    response.type("text/plain").send([
      "# HELP shop_http_requests_total HTTP requests handled",
      "# TYPE shop_http_requests_total counter",
      ...requestLines,
      "# HELP shop_http_errors_total HTTP error responses",
      "# TYPE shop_http_errors_total counter",
      ...errorLines,
      "# HELP shop_http_active_requests HTTP requests currently in progress",
      "# TYPE shop_http_active_requests gauge",
      `shop_http_active_requests ${metrics.activeRequests}`,
      "# HELP shop_http_request_duration_ms_average Average request duration",
      "# TYPE shop_http_request_duration_ms_average gauge",
      `shop_http_request_duration_ms_average ${averageDuration.toFixed(2)}`,
      "# HELP shop_checkouts_total Checkout attempts",
      "# TYPE shop_checkouts_total counter",
      `shop_checkouts_total ${metrics.checkouts}`,
      "# HELP shop_idempotent_checkouts_total Replayed idempotent checkouts",
      "# TYPE shop_idempotent_checkouts_total counter",
      `shop_idempotent_checkouts_total ${metrics.idempotentCheckouts}`,
      "# HELP shop_checkout_errors_total Checkout errors",
      "# TYPE shop_checkout_errors_total counter",
      `shop_checkout_errors_total ${metrics.checkoutErrors}`,
      ""
    ].join("\n"));
  });

  app.get("/api/products", async (_request, response, next) => {
    try {
      response.json(await getProducts());
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/orders/:id", async (request, response, next) => {
    try {
      const id = Number(request.params.id);
      if (!Number.isInteger(id)) return response.status(400).json({ error: "Invalid order id" });
      const userId = getAuthenticatedUser(request);
      if (!userId) return response.status(401).json({ error: "Unauthorized" });
      const order = await getOrder(id, userId);
      if (!order) return response.status(404).json({ error: "Order not found" });
      response.json(order);
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/products/:id", async (request, response, next) => {
    try {
      if (!requireAdmin(request, response)) return;
      const id = Number(request.params.id);
      if (!Number.isInteger(id)) return response.status(400).json({ error: "Invalid product id" });
      if (request.body.price !== undefined && (!Number.isFinite(Number(request.body.price)) || Number(request.body.price) < 0)) {
        return response.status(400).json({ error: "Price must be zero or greater" });
      }
      if (request.body.stock !== undefined && (!Number.isInteger(request.body.stock) || request.body.stock < 0)) {
        return response.status(400).json({ error: "Stock must be a non-negative integer" });
      }
      const product = await updateProduct(id, request.body);
      if (!product) return response.status(404).json({ error: "Product not found" });
      response.json(product);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/checkout", async (request, response, next) => {
    try {
      const items = request.body?.items;
      if (!Array.isArray(items) || items.length === 0) {
        return response.status(400).json({ error: "Checkout requires at least one item" });
      }
      metrics.checkouts += 1;
      const idempotencyKey = request.get("idempotency-key");
      if (idempotencyKey && idempotencyKey.length > 128) {
        return response.status(400).json({ error: "Idempotency key must be 128 characters or fewer" });
      }
      const result = await createOrder(items, idempotencyKey || null, getAuthenticatedUser(request));
      if (result.replayed) metrics.idempotentCheckouts += 1;
      if (result.error) return response.status(result.status).json({ error: result.error });
      response.status(201).json(result.order);
    } catch (error) {
      metrics.checkoutErrors += 1;
      next(error);
    }
  });

  app.use((error, _request, response, _next) => {
    structuredLog("error", "Unhandled request error", {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
    response.status(500).json({ error: "Internal server error" });
  });

  return app;
}

export async function start() {
  await ensureDatabase();
  const app = createApp();
  const port = Number(process.env.PORT || 8080);
  const useTls = Boolean(process.env.TLS_CERT_PATH && process.env.TLS_KEY_PATH);
  let server;
  if (useTls) {
    server = https.createServer({
      cert: fs.readFileSync(process.env.TLS_CERT_PATH),
      key: fs.readFileSync(process.env.TLS_KEY_PATH)
    }, app);
  } else {
    server = http.createServer(app);
  }
  server.listen(port, "0.0.0.0", () => {
    structuredLog("info", "Shop backend listening", {
      port,
      protocol: useTls ? "https" : "http"
    });
  });

  const shutdown = () => {
    server.close(async () => {
      if (pool) await pool.end();
      process.exit(0);
    });
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  return server;
}

if (process.argv[1]?.endsWith("server.js")) {
  start().catch((error) => {
    structuredLog("fatal", "Failed to start shop backend", {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
    process.exit(1);
  });
}
