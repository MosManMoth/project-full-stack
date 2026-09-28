const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const path = require("path");
const fs = require("fs");
const QRCode = require("qrcode");

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

// Item IDs become file names, so only allow safe characters
const ITEM_ID_REGEX = /^[A-Za-z0-9_-]{1,100}$/;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Automatically create tables & seed sample resources on startup (with retry)
async function initDB(retries = 10, delayMs = 3000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
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
      if (parseInt(checkResources.rows[0].count, 10) === 0) {
        await pool.query(`
          INSERT INTO resources (name, type, is_active) VALUES
          ('Meeting Room 101', 'room', true),
          ('Conference Room B', 'room', true),
          ('4K Projector', 'equipment', true),
          ('Wireless Microphone Set', 'equipment', true);
        `);
      }

      console.log("PostgreSQL tables and seed data ready.");
      return;
    } catch (err) {
      console.error(`DB Init Error (attempt ${attempt}/${retries}):`, err.message);
      if (attempt < retries) await sleep(delayMs);
    }
  }
  console.error("DB initialization failed after all retries.");
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
  const { itemId, itemName, itemType } = req.body || {};

  if (!itemId || !ITEM_ID_REGEX.test(itemId)) {
    return res.status(400).json({
      error: "Invalid item ID. Use only letters, numbers, '-' and '_' (max 100 chars).",
    });
  }
  if (!itemName || !itemType) {
    return res.status(400).json({ error: "itemName and itemType are required." });
  }

  try {
    // Save the data in the database
    await pool.query(
      `INSERT INTO items (item_id, item_name, item_type)
       VALUES ($1, $2, $3)
       ON CONFLICT (item_id) DO UPDATE
       SET item_name = EXCLUDED.item_name, item_type = EXCLUDED.item_type`,
      [itemId, itemName, itemType]
    );

    // Make sure QR code directory exists
    const qrDir = path.join(__dirname, "public", "qrcodes");
    if (!fs.existsSync(qrDir)) {
      fs.mkdirSync(qrDir, { recursive: true });
    }

    // Generate QR code using the host the admin is actually using
    // (set BASE_URL in docker-compose to force a specific address, e.g. http://192.168.1.50:8000)
    const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get("host")}`;
    const qrContent = `${baseUrl}/borrow?itemId=${encodeURIComponent(itemId)}`;
    const qrFilePath = path.join(qrDir, `${itemId}.png`);
    await QRCode.toFile(qrFilePath, qrContent);

    res.json({
      ok: true,
      qrUrl: `/qrcodes/${itemId}.png`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete QR item
app.delete("/api/items/:id", async (req, res) => {
  const itemId = req.params.id;

  if (!ITEM_ID_REGEX.test(itemId)) {
    return res.status(400).json({ error: "Invalid item ID." });
  }

  try {
    await pool.query("DELETE FROM items WHERE item_id = $1", [itemId]);

    // Delete image file if exists
    const qrFilePath = path.join(__dirname, "public", "qrcodes", `${itemId}.png`);
    if (fs.existsSync(qrFilePath)) {
      fs.unlinkSync(qrFilePath);
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Record completed borrow session log
app.post("/api/borrow/stop", async (req, res) => {
  const {
    userId,
    userName,
    itemId,
    itemName,
    itemType,
    startTime,
    endTime,
    durationSeconds,
  } = req.body || {};

  if (
    !userId || !userName || !itemId || !itemName || !itemType ||
    !startTime || !endTime || !Number.isFinite(Number(durationSeconds))
  ) {
    return res.status(400).json({ ok: false, error: "Missing or invalid fields." });
  }

  try {
    await pool.query(
      `INSERT INTO borrow_logs (user_id, user_name, item_id, item_name, item_type, start_time, end_time, duration_seconds)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [userId, userName, itemId, itemName, itemType, startTime, endTime, Math.floor(Number(durationSeconds))]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Serve borrow check-in interface when QR code is scanned
app.get("/borrow", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "borrow.html"));
});

app.listen(8000, () => console.log("API: http://localhost:8000"));