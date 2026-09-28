const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());

// Serve static assets from backend/public
app.use(express.static(path.join(__dirname, "public")));

const pool = new Pool({
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER || "app",
  password: process.env.DB_PASSWORD || "app",
  database: process.env.DB_NAME || "reservation_db",
});

// Automatically create tables & seed sample resources on startup
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS resources (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        type VARCHAR(50) NOT NULL,
        is_active BOOLEAN DEFAULT true
      );

      CREATE TABLE IF NOT EXISTS items (
        item_id VARCHAR(100) PRIMARY KEY,
        item_name VARCHAR(255) NOT NULL,
        item_type VARCHAR(50) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS borrow_logs (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(100) NOT NULL,
        user_name VARCHAR(255) NOT NULL,
        item_id VARCHAR(100) NOT NULL,
        item_name VARCHAR(255) NOT NULL,
        item_type VARCHAR(50) NOT NULL,
        start_time TIMESTAMP NOT NULL,
        end_time TIMESTAMP NOT NULL,
        duration_seconds INT NOT NULL
      );
    `);

    // Seed sample resources if table is empty
    const checkResources = await pool.query("SELECT COUNT(*) FROM resources");
    if (parseInt(checkResources.rows[0].count) === 0) {
      await pool.query(`
        INSERT INTO resources (name, type, is_active) VALUES
        ('Meeting Room 101', 'room', true),
        ('Conference Room B', 'room', true),
        ('4K Projector', 'equipment', true),
        ('Wireless Microphone Set', 'equipment', true);
      `);
    }

    console.log("PostgreSQL tables and seed data ready.");
  } catch (err) {
    console.error("DB Init Error:", err);
  }
}
initDB();

// Health Check Endpoint
app.get("/health", async (req, res) => {
  try {
    const r = await pool.query("SELECT NOW() as now");
    res.json({ ok: true, now: r.rows[0].now });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Resource List Endpoint
app.get("/resources", async (req, res) => {
  try {
    const { type } = req.query;
    const params = [];
    let sql = "SELECT * FROM resources WHERE is_active = true";
    if (type) {
      params.push(type);
      sql += " AND type = $1";
    }
    sql += " ORDER BY id";
    const r = await pool.query(sql, params);
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// Get all saved QR items
app.get("/api/items", async (req, res) => {
  try {
    const r = await pool.query("SELECT * FROM items ORDER BY created_at DESC");
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add / Update QR item
app.post("/api/items", async (req, res) => {
  const { itemId, itemName, itemType } = req.body;
  try {
    await pool.query(
      `INSERT INTO items (item_id, item_name, item_type)
       VALUES ($1, $2, $3)
       ON CONFLICT (item_id) DO UPDATE 
       SET item_name = EXCLUDED.item_name, item_type = EXCLUDED.item_type`,
      [itemId, itemName, itemType]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete QR item
app.delete("/api/items/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM items WHERE item_id = $1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Record completed borrow session log
app.post("/api/borrow/stop", async (req, res) => {
  const { userId, userName, itemId, itemName, itemType, startTime, endTime, durationSeconds } = req.body;
  try {
    await pool.query(
      `INSERT INTO borrow_logs (user_id, user_name, item_id, item_name, item_type, start_time, end_time, duration_seconds)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [userId, userName, itemId, itemName, itemType, startTime, endTime, durationSeconds]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Serve borrow check-in interface when QR code is scanned
app.get("/borrow", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(8000, () => console.log("API: http://localhost:8000"));