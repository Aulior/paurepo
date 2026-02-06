import express from "express";
import sqlite3 from "sqlite3";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import os from "os";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Database setup with absolute path
const dbPath = join(__dirname, "faq.db");
console.log("📁 Database path:", dbPath);

// Check file permissions
fs.stat(dbPath, (err, stats) => {
    if (err) {
        console.log("📁 Database file will be created");
    } else {
        console.log("📁 Existing database:", {
            size: `${(stats.size / 1024).toFixed(2)} KB`,
            permissions: stats.mode.toString(8),
            modified: stats.mtime
        });
    }
});

const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
    if (err) {
        console.error("❌ Database connection error:", err.message);
        console.error("❌ Full error:", err);
    } else {
        console.log("✅ Connected to SQLite database");
        db.run("PRAGMA journal_mode = WAL"); // Enable Write-Ahead Logging
        db.run("PRAGMA foreign_keys = ON"); // Enable foreign keys
    }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Logging middleware
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
    next();
});

// Serve static files
app.use(express.static(__dirname));


// Routes
function normalizeCategory(category) {
    if (!category) return "";

    return category
        .split(",")
        .map(t => t.trim())
        .filter(Boolean)
        .join(",");
}

app.get("/", (req, res) => {
    res.sendFile(join(__dirname, "index.html"));
});

// Initialize database with fresh table
db.serialize(() => {
    console.log("🔄 Initializing database...");

    // Create table with proper error handling
    const createTableSQL = `
        CREATE TABLE IF NOT EXISTS faq (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            question TEXT NOT NULL,
            answer TEXT NOT NULL,
            category TEXT DEFAULT '',
            created_at TEXT DEFAULT '',
            updated_at TEXT DEFAULT ''
        )
    `;

    db.run(createTableSQL, function (err) {
        if (err) {
            console.error("❌ CREATE TABLE error:", err.message);
            console.error("❌ SQL:", createTableSQL);
        } else {
            console.log("✅ FAQ table ready");

            // Test if table is writable
            const testNow = new Date().toISOString();
            const testSQL = `INSERT INTO faq (question, answer, created_at, updated_at) VALUES (?, ?, ?, ?)`;

            db.run(testSQL, ["Test question", "Test answer", testNow, testNow], function (testErr) {
                if (testErr) {
                    console.error("❌ Test insert failed:", testErr.message);
                    console.error("❌ Test SQL:", testSQL);
                } else {
                    console.log(`✅ Test insert successful, ID: ${this.lastID}`);

                    // Clean up test data
                    db.run("DELETE FROM faq WHERE question = 'Test question'", (delErr) => {
                        if (delErr) {
                            console.error("❌ Cleanup failed:", delErr.message);
                        } else {
                            console.log("✅ Test data cleaned up");
                        }
                    });
                }
            });
        }
    });
});

// Debug routes
app.get("/api/debug/schema", (req, res) => {
    db.all("PRAGMA table_info(faq)", [], (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
        } else {
            res.json({
                table: "faq",
                columns: rows,
                count: rows.length
            });
        }
    });
});

app.get("/api/debug/tables", (req, res) => {
    db.all("SELECT name FROM sqlite_master WHERE type='table'", [], (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
        } else {
            res.json({ tables: rows });
        }
    });
});

// API Routes
app.get("/api/faq", (req, res) => {
    db.all("SELECT * FROM faq ORDER BY id DESC", [], (err, rows) => {
        if (err) {
            console.error("❌ GET /api/faq error:", err.message);
            return res.status(500).json({ error: "Database error", details: err.message });
        }
        const cleanRows = rows.map(r => ({
            ...r,
            category: normalizeCategory(r.category)
        }));

        res.json(cleanRows);

    });
});

app.post("/api/faq", (req, res) => {
    console.log("📥 POST /api/faq body:", JSON.stringify(req.body, null, 2));

    const { question, answer, category } = req.body;

    // Validation
    if (!question || !answer) {
        return res.status(400).json({
            error: "Validation failed",
            message: "Question and answer are required"
        });
    }

    const now = new Date().toISOString();
    const cleanCategory = normalizeCategory(category);

    const params = [
        String(question).trim(),
        String(answer).trim(),
        cleanCategory,
        now,
        now
    ];


    console.log("📝 Executing SQL with params:", params);

    const sql = `INSERT INTO faq (question, answer, category, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`;

    db.run(sql, params, function (err) {
        if (err) {
            console.error("❌ SQL Error Details:");
            console.error("   Message:", err.message);
            console.error("   Code:", err.code);
            console.error("   SQL:", sql);
            console.error("   Params:", params);

            return res.status(500).json({
                error: "Insert failed",
                details: err.message,
                sql: sql,
                params: params
            });
        }

        console.log(`✅ FAQ inserted successfully, ID: ${this.lastID}`);

        // Return the newly created FAQ
        db.get("SELECT * FROM faq WHERE id = ?", [this.lastID], (err, row) => {
            if (err) {
                res.json({
                    success: true,
                    id: this.lastID,
                    message: "FAQ created but could not retrieve details"
                });
            } else {
                res.json({
                    success: true,
                    id: this.lastID,
                    data: row
                });
            }
        });
    });
});

app.delete("/api/faq/:id", (req, res) => {
    const { id } = req.params;

    if (!id) {
        return res.status(400).json({ error: "ID is required" });
    }

    const sql = "DELETE FROM faq WHERE id = ?";

    db.run(sql, [id], function (err) {
        if (err) {
            console.error("❌ DELETE error:", err.message);
            return res.status(500).json({ error: "Delete failed" });
        }

        if (this.changes === 0) {
            return res.status(404).json({ error: "FAQ not found" });
        }

        console.log(`🗑️ FAQ deleted, ID: ${id}`);
        res.json({ success: true, id });
    });
});

app.put("/api/faq/:id", (req, res) => {
    const { id } = req.params;
    const { question, answer, category } = req.body;

    if (!id || !question || !answer) {
        return res.status(400).json({
            error: "Validation failed",
            message: "ID, question, and answer are required"
        });
    }

    const now = new Date().toISOString();
    const cleanCategory = normalizeCategory(category);

    const sql = `
        UPDATE faq
        SET question = ?, answer = ?, category = ?, updated_at = ?
        WHERE id = ?
    `;

    const params = [
        String(question).trim(),
        String(answer).trim(),
        cleanCategory,
        now,
        id
    ];

    console.log("✏️ UPDATE FAQ:", params);

    db.run(sql, params, function (err) {
        if (err) {
            console.error("❌ UPDATE error:", err.message);
            return res.status(500).json({ error: "Update failed" });
        }

        if (this.changes === 0) {
            return res.status(404).json({ error: "FAQ not found" });
        }

        // Return updated row
        db.get("SELECT * FROM faq WHERE id = ?", [id], (err, row) => {
            if (err) {
                return res.json({ success: true, id });
            }
            res.json({
                success: true,
                id,
                data: row
            });
        });
    });
});

// Other routes remain the same...

// Start server
app.listen(PORT, () => {
    console.log(`\n🚀 Server started successfully!`);
    console.log(`=========================================`);
    console.log(`🌐 URL: http://localhost:${PORT}`);
    console.log(`📁 Database: ${dbPath}`);
    console.log(`=========================================\n`);

    console.log("📋 Available routes:");
    console.log("   GET  /                 - Main page");
    console.log("   GET  /api/faq          - List all FAQs");
    console.log("   POST /api/faq          - Create new FAQ");
    console.log("   GET  /api/debug/schema - Check table schema");
    console.log("   GET  /api/debug/tables - List all tables");
});