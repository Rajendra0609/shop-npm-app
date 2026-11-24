import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

function formatCurrency(value) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

function App() {
  const [products, setProducts] = useState([]);
  const [cart, setCart] = useState({});
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [editing, setEditing] = useState(null);
  const [checkoutIdempotencyKey, setCheckoutIdempotencyKey] = useState(() => window.crypto.randomUUID());

  async function loadProducts() {
    setLoading(true);
    const response = await fetch("/api/products");
    if (!response.ok) throw new Error("Could not load products");
    setProducts(await response.json());
    setLoading(false);
  }

  useEffect(() => {
    loadProducts().catch((error) => {
      setMessage(error.message);
      setLoading(false);
    });
  }, []);

  const cartItems = useMemo(
    () => products
      .filter((product) => cart[product.id])
      .map((product) => ({ ...product, quantity: cart[product.id] })),
    [products, cart]
  );

  const total = cartItems.reduce((sum, item) => sum + item.price * item.quantity, 0);

  function addToCart(product) {
    if (product.stock < 1) return;
    setCart((current) => ({
      ...current,
      [product.id]: Math.min((current[product.id] || 0) + 1, product.stock)
    }));
  }

  async function checkout() {
    setMessage("");
    const idempotencyKey = checkoutIdempotencyKey;
    const response = await fetch("/api/checkout", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey
      },
      body: JSON.stringify({
        items: cartItems.map((item) => ({ productId: item.id, quantity: item.quantity }))
      })
    });
    const result = await response.json();
    if (!response.ok) {
      setMessage(result.error);
      return;
    }
    setCart({});
    setCheckoutIdempotencyKey(window.crypto.randomUUID());
    setMessage(`Order ${result.id} confirmed for ${formatCurrency(result.total)}.`);
    await loadProducts();
  }

  async function updateProduct(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const patch = {
      name: form.get("name").trim(),
      description: form.get("description").trim(),
      price: Number(form.get("price")),
      stock: Number(form.get("stock")),
      category: form.get("category").trim()
    };

    const response = await fetch(`/api/products/${editing.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch)
    });
    const result = await response.json();
    if (!response.ok) {
      setMessage(result.error);
      return;
    }
    setEditing(null);
    setMessage(`${result.name} updated.`);
    await loadProducts();
  }

  return (
    <main>
      <header className="topbar">
        <div>
          <p className="eyebrow">Production shop</p>
          <h1>Checkout Supply</h1>
        </div>
        <span className="cart-count">Cart · {cartItems.reduce((sum, item) => sum + item.quantity, 0)}</span>
      </header>

      {message && <div className="notice" role="status">{message}</div>}

      {loading ? (
        <p className="state">Loading catalog...</p>
      ) : (
        <section className="layout">
          <div className="catalog">
            {products.map((product) => (
              <article className="product" key={product.id}>
                <div className="product-art" aria-hidden="true">{product.category.slice(0, 1)}</div>
                <div className="product-body">
                  <div>
                    <p className="category">{product.category}</p>
                    <h2>{product.name}</h2>
                  </div>
                  <p className="description">{product.description}</p>
                  <div className="product-footer">
                    <strong>{formatCurrency(product.price)}</strong>
                    <span>{product.stock} in stock</span>
                  </div>
                  <div className="actions">
                    <button type="button" onClick={() => addToCart(product)} disabled={product.stock < 1}>
                      Add to cart
                    </button>
                    <button className="secondary" type="button" onClick={() => setEditing(product)}>
                      Update
                    </button>
                  </div>
                </div>
              </article>
            ))}
          </div>

          <aside className="cart">
            <h2>Your cart</h2>
            {cartItems.length === 0 ? (
              <p className="empty">No items yet.</p>
            ) : (
              <>
                {cartItems.map((item) => (
                  <div className="cart-row" key={item.id}>
                    <span>{item.name} × {item.quantity}</span>
                    <strong>{formatCurrency(item.price * item.quantity)}</strong>
                  </div>
                ))}
                <div className="total">
                  <span>Total</span>
                  <strong>{formatCurrency(total)}</strong>
                </div>
                <button className="checkout" type="button" onClick={checkout}>Confirm checkout</button>
              </>
            )}
          </aside>
        </section>
      )}

      {editing && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setEditing(null)}>
          <form className="modal" onSubmit={updateProduct} onMouseDown={(event) => event.stopPropagation()}>
            <h2>Update {editing.name}</h2>
            <label>Name<input name="name" defaultValue={editing.name} required /></label>
            <label>Description<textarea name="description" defaultValue={editing.description} required /></label>
            <div className="form-grid">
              <label>Price<input name="price" type="number" min="0" step="0.01" defaultValue={editing.price} required /></label>
              <label>Stock<input name="stock" type="number" min="0" step="1" defaultValue={editing.stock} required /></label>
            </div>
            <label>Category<input name="category" defaultValue={editing.category} required /></label>
            <div className="modal-actions">
              <button type="button" className="secondary" onClick={() => setEditing(null)}>Cancel</button>
              <button type="submit">Save update</button>
            </div>
          </form>
        </div>
      )}
    </main>
  );
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
