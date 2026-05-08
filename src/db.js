const fs = require("node:fs");
const path = require("node:path");
const sqlite3 = require("sqlite3");

class AppDatabase {
  constructor(filePath) {
    this.filePath = filePath;
    this.db = null;
  }

  async init() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.db = new sqlite3.Database(this.filePath);

    await this.run("PRAGMA journal_mode = WAL;");
    await this.run("PRAGMA synchronous = NORMAL;");
    await this.run("PRAGMA busy_timeout = 5000;");

    await this.run(`
      CREATE TABLE IF NOT EXISTS horses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        number INTEGER NOT NULL UNIQUE,
        name TEXT NOT NULL,
        color TEXT NOT NULL DEFAULT '#3b82f6',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await this.run(`
      CREATE TABLE IF NOT EXISTS race_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        status TEXT NOT NULL DEFAULT 'idle',
        lap INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await this.run(`
      CREATE TABLE IF NOT EXISTS polls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        question TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        closed_at TEXT
      );
    `);

    await this.run(`
      CREATE TABLE IF NOT EXISTS poll_options (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        poll_id INTEGER NOT NULL,
        option_key TEXT NOT NULL,
        option_label TEXT NOT NULL,
        votes INTEGER NOT NULL DEFAULT 0,
        UNIQUE(poll_id, option_key),
        FOREIGN KEY(poll_id) REFERENCES polls(id)
      );
    `);

    await this.run(`
      INSERT OR IGNORE INTO race_state (id, status, lap) VALUES (1, 'idle', 0);
    `);
  }

  run(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, function onRun(err) {
        if (err) {
          reject(err);
          return;
        }
        resolve({ changes: this.changes, lastID: this.lastID });
      });
    });
  }

  get(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.get(sql, params, (err, row) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(row || null);
      });
    });
  }

  all(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(rows || []);
      });
    });
  }

  async close() {
    if (!this.db) {
      return;
    }
    await new Promise((resolve, reject) => {
      this.db.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  async getHorses() {
    return this.all(
      "SELECT id, number, name, color, updated_at FROM horses ORDER BY number ASC;"
    );
  }

  async createHorse(payload) {
    const number = Number(payload.number);
    const name = String(payload.name || "").trim();
    const color = String(payload.color || "#3b82f6");

    if (!Number.isInteger(number) || number <= 0) {
      throw new Error("Horse number must be a positive integer.");
    }
    if (!name) {
      throw new Error("Horse name is required.");
    }

    const result = await this.run(
      `
      INSERT INTO horses (number, name, color, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP);
      `,
      [number, name, color]
    );

    return this.get(
      "SELECT id, number, name, color, updated_at FROM horses WHERE id = ?;",
      [result.lastID]
    );
  }

  async updateHorse(id, payload) {
    const horseId = Number(id);
    const existing = await this.get("SELECT id FROM horses WHERE id = ?;", [horseId]);
    if (!existing) {
      throw new Error("Horse not found.");
    }

    const number = Number(payload.number);
    const name = String(payload.name || "").trim();
    const color = String(payload.color || "#3b82f6");
    if (!Number.isInteger(number) || number <= 0) {
      throw new Error("Horse number must be a positive integer.");
    }
    if (!name) {
      throw new Error("Horse name is required.");
    }

    await this.run(
      `
      UPDATE horses
      SET number = ?, name = ?, color = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?;
      `,
      [number, name, color, horseId]
    );
    return this.get(
      "SELECT id, number, name, color, updated_at FROM horses WHERE id = ?;",
      [horseId]
    );
  }

  async removeHorse(id) {
    const horseId = Number(id);
    const result = await this.run("DELETE FROM horses WHERE id = ?;", [horseId]);
    return result.changes > 0;
  }

  async getRaceState() {
    return this.get("SELECT status, lap, updated_at FROM race_state WHERE id = 1;");
  }

  async setRaceState(status, lap) {
    await this.run(
      `
      UPDATE race_state
      SET status = ?, lap = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = 1;
      `,
      [status, lap]
    );
    return this.getRaceState();
  }

  async createPoll(question, options) {
    const cleanedQuestion = String(question || "").trim();
    const normalizedOptions = options
      .map((option) => String(option || "").trim())
      .filter((option) => option.length > 0);

    if (!cleanedQuestion) {
      throw new Error("Poll question is required.");
    }
    if (normalizedOptions.length < 2) {
      throw new Error("At least two options are required.");
    }

    await this.run("BEGIN;");
    let pollId;
    try {
      const insertedPoll = await this.run(
        "INSERT INTO polls (question, status) VALUES (?, 'active');",
        [cleanedQuestion]
      );
      pollId = insertedPoll.lastID;

      for (let index = 0; index < normalizedOptions.length; index += 1) {
        const optionLabel = normalizedOptions[index];
        const optionKey = `option-${index + 1}`;
        await this.run(
          `
          INSERT INTO poll_options (poll_id, option_key, option_label, votes)
          VALUES (?, ?, ?, 0);
          `,
          [pollId, optionKey, optionLabel]
        );
      }

      await this.run("COMMIT;");
    } catch (error) {
      await this.run("ROLLBACK;");
      throw error;
    }

    return this.getPollById(pollId);
  }

  async closeActivePoll() {
    const activePoll = await this.getActivePoll();
    if (!activePoll) {
      return null;
    }
    await this.run(
      `
      UPDATE polls
      SET status = 'closed', closed_at = CURRENT_TIMESTAMP
      WHERE id = ?;
      `,
      [activePoll.id]
    );
    return this.getPollById(activePoll.id);
  }

  async getPollById(pollId) {
    const poll = await this.get(
      `
      SELECT id, question, status, created_at, closed_at
      FROM polls
      WHERE id = ?;
      `,
      [pollId]
    );
    if (!poll) {
      return null;
    }

    const options = await this.all(
      `
      SELECT option_key, option_label, votes
      FROM poll_options
      WHERE poll_id = ?
      ORDER BY id ASC;
      `,
      [pollId]
    );
    return { ...poll, options };
  }

  async getActivePoll() {
    const active = await this.get(
      `
      SELECT id
      FROM polls
      WHERE status = 'active'
      ORDER BY id DESC
      LIMIT 1;
      `
    );
    if (!active) {
      return null;
    }
    return this.getPollById(active.id);
  }

  async vote(pollId, optionKey) {
    const targetPoll = await this.getPollById(pollId);
    if (!targetPoll || targetPoll.status !== "active") {
      throw new Error("Poll is not active.");
    }

    const voteResult = await this.run(
      `
      UPDATE poll_options
      SET votes = votes + 1
      WHERE poll_id = ? AND option_key = ?;
      `,
      [pollId, optionKey]
    );
    if (voteResult.changes === 0) {
      throw new Error("Invalid voting option.");
    }

    return this.getPollById(pollId);
  }
}

function createDatabase(dbPath) {
  return new AppDatabase(dbPath);
}

module.exports = { createDatabase };
