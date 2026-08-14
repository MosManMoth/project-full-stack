const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());

app.use(express.static(path.join(__dirname, "public")));

const pool = new Pool({
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER || "app",
  password: process.env.DB_PASSWORD || "app",
  database: process.env.DB_NAME || "reservation_db",
});

app.get("/health", async (req, res) => {
  const r = await pool.query("SELECT NOW() as now");
  res.json({ ok: true, now: r.rows[0].now });
});

app.get("/resources", async (req, res) => {
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
});

app.listen(8000, () => console.log("API: http://localhost:8000"));