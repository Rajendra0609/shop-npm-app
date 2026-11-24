import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/server.js";

test("health endpoint returns OK", async () => {
  const server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;

  const response = await fetch(`http://127.0.0.1:${port}/api/healthz`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "OK", service: "shop-backend" });

  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("product update and checkout are handled", async () => {
  const server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;
  const headers = { "content-type": "application/json" };

  const updateResponse = await fetch(`http://127.0.0.1:${port}/api/products/1`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ price: 20, stock: 10 })
  });
  assert.equal(updateResponse.status, 200);
  const updated = await updateResponse.json();
  assert.equal(updated.price, 20);
  assert.equal(updated.stock, 10);

  const checkoutResponse = await fetch(`http://127.0.0.1:${port}/api/checkout`, {
    method: "POST",
    headers,
    body: JSON.stringify({ items: [{ productId: 1, quantity: 2 }] })
  });
  assert.equal(checkoutResponse.status, 201);
  const order = await checkoutResponse.json();
  assert.equal(order.status, "confirmed");
  assert.equal(order.total, 40);

  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("checkout is replayed safely with an idempotency key", async () => {
  const server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;
  const headers = {
    "content-type": "application/json",
    "idempotency-key": "checkout-test-key"
  };
  const body = JSON.stringify({ items: [{ productId: 2, quantity: 1 }] });

  const first = await fetch(`http://127.0.0.1:${port}/api/checkout`, {
    method: "POST",
    headers,
    body
  });
  assert.equal(first.status, 201);

  const replay = await fetch(`http://127.0.0.1:${port}/api/checkout`, {
    method: "POST",
    headers,
    body
  });
  assert.equal(replay.status, 201);
  assert.deepEqual(await replay.json(), await first.json());

  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("different idempotency payload is rejected", async () => {
  const server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;
  const headers = {
    "content-type": "application/json",
    "idempotency-key": "same-key-different-payload"
  };

  const first = await fetch(`http://127.0.0.1:${port}/api/checkout`, {
    method: "POST",
    headers,
    body: JSON.stringify({ items: [{ productId: 3, quantity: 1 }] })
  });
  assert.equal(first.status, 201);

  const conflict = await fetch(`http://127.0.0.1:${port}/api/checkout`, {
    method: "POST",
    headers,
    body: JSON.stringify({ items: [{ productId: 3, quantity: 2 }] })
  });
  assert.equal(conflict.status, 409);

  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("readiness and metrics endpoints are available", async () => {
  const server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;

  const readiness = await fetch(`http://127.0.0.1:${port}/api/readyz`);
  assert.equal(readiness.status, 200);
  assert.equal((await readiness.json()).database, "memory");

  const metrics = await fetch(`http://127.0.0.1:${port}/metrics`);
  assert.equal(metrics.status, 200);
  assert.match(await metrics.text(), /shop_http_active_requests/);

  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});
