const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

let db = null;
const dbPath = path.join(__dirname, 'coup.db');

// Initialize database
async function initDatabase() {
  const SQL = await initSqlJs();
  
  // Load existing database or create new one
  if (fs.existsSync(dbPath)) {
    const buffer = fs.readFileSync(dbPath);
    db = new SQL.Database(buffer);
    console.log('Database loaded from file');
  } else {
    db = new SQL.Database();
    console.log('New database created');
  }

  // Create tables
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      email TEXT,
      display_name TEXT NOT NULL,
      deck_preference TEXT DEFAULT 'default',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_login DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  
  // Add deck_preference column if it doesn't exist (for existing databases)
  try {
    db.run(`ALTER TABLE users ADD COLUMN deck_preference TEXT DEFAULT 'default'`);
  } catch (e) {
    // Column already exists, ignore
  }
  
  // Add privacy_settings column if it doesn't exist
  try {
    db.run(`ALTER TABLE users ADD COLUMN privacy_settings TEXT DEFAULT '{}'`);
  } catch (e) {
    // Column already exists, ignore
  }
  
  // Add bio column if it doesn't exist
  try {
    db.run(`ALTER TABLE users ADD COLUMN bio TEXT DEFAULT ''`);
  } catch (e) {
    // Column already exists, ignore
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS user_stats (
      user_id INTEGER PRIMARY KEY,
      games_played INTEGER DEFAULT 0,
      games_won INTEGER DEFAULT 0,
      elo_rating INTEGER DEFAULT 1200,
      
      -- Core stats
      coins_earned INTEGER DEFAULT 0,
      coins_spent INTEGER DEFAULT 0,
      coins_lost INTEGER DEFAULT 0,
      coins_stolen INTEGER DEFAULT 0,
      influences_lost INTEGER DEFAULT 0,
      income_taken INTEGER DEFAULT 0,
      coups_enacted INTEGER DEFAULT 0,
      players_eliminated INTEGER DEFAULT 0,
      
      -- Challenge/Bluff stats
      successful_challenges INTEGER DEFAULT 0,
      failed_challenges INTEGER DEFAULT 0,
      claims_defended INTEGER DEFAULT 0,
      bluffs_caught INTEGER DEFAULT 0,
      bluffs_succeeded INTEGER DEFAULT 0,
      
      -- Action-specific stats
      tax_succeeded INTEGER DEFAULT 0,
      tax_failed INTEGER DEFAULT 0,
      foreignaid_accepted INTEGER DEFAULT 0,
      foreignaid_denied INTEGER DEFAULT 0,
      foreignaidblock_succeeded INTEGER DEFAULT 0,
      foreignaidblock_failed INTEGER DEFAULT 0,
      steals_blocked INTEGER DEFAULT 0,
      
      -- Assassination stats
      assassinations_succeeded INTEGER DEFAULT 0,
      assassinations_failed INTEGER DEFAULT 0,
      contessa_succeeded INTEGER DEFAULT 0,
      contessa_failed INTEGER DEFAULT 0,
      
      -- Exchange/Examine stats
      influence_exchanged INTEGER DEFAULT 0,
      influence_examined INTEGER DEFAULT 0,
      influence_forced INTEGER DEFAULT 0,
      
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS game_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_code TEXT NOT NULL,
      winner_user_id INTEGER,
      player_data TEXT NOT NULL,
      game_settings TEXT NOT NULL,
      started_at DATETIME NOT NULL,
      ended_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      duration_seconds INTEGER,
      FOREIGN KEY (winner_user_id) REFERENCES users(id) ON DELETE SET NULL
    );
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_username ON users(username);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_elo_rating ON user_stats(elo_rating DESC);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_game_history_date ON game_history(ended_at DESC);`);

  db.run(`
    CREATE TABLE IF NOT EXISTS achievement_unlocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      achievement_id TEXT NOT NULL,
      unlocked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, achievement_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_achievement_unlocks ON achievement_unlocks(user_id);`);

  console.log('Database initialized successfully');
  saveDatabase();
}

// Save database to file
function saveDatabase() {
  if (db) {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(dbPath, buffer);
  }
}

// Wrapper functions for prepared statements
function prepare(sql) {
  return {
    run: function(...params) {
      const stmt = db.prepare(sql);
      stmt.bind(params);
      stmt.step();
      
      // Get last insert rowid
      let lastId = 0;
      try {
        const result = db.exec("SELECT last_insert_rowid() as id");
        if (result && result[0] && result[0].values && result[0].values[0]) {
          lastId = result[0].values[0][0];
        }
      } catch (e) {
        console.error('Error getting last insert rowid:', e);
      }
      
      const info = {
        changes: db.getRowsModified(),
        lastInsertRowid: lastId
      };
      stmt.free();
      return info;
    },
    get: function(...params) {
      const stmt = db.prepare(sql);
      stmt.bind(params);
      let result = null;
      if (stmt.step()) {
        const columns = stmt.getColumnNames();
        const values = stmt.get();
        result = {};
        columns.forEach((col, idx) => {
          result[col] = values[idx];
        });
      }
      stmt.free();
      return result;
    },
    all: function(...params) {
      const results = [];
      const stmt = db.prepare(sql);
      stmt.bind(params);
      while (stmt.step()) {
        const columns = stmt.getColumnNames();
        const values = stmt.get();
        const row = {};
        columns.forEach((col, idx) => {
          row[col] = values[idx];
        });
        results.push(row);
      }
      stmt.free();
      return results;
    }
  };
}

// Transaction wrapper
function transaction(fn) {
  return function(...args) {
    let transactionStarted = false;
    try {
      db.run('BEGIN TRANSACTION');
      transactionStarted = true;
      const result = fn(...args);
      db.run('COMMIT');
      saveDatabase();
      return result;
    } catch (error) {
      if (transactionStarted) {
        try {
          db.run('ROLLBACK');
        } catch (rollbackError) {
          console.error('Rollback error:', rollbackError);
        }
      }
      throw error;
    }
  };
}

// Export database interface
module.exports = {
  initDatabase,
  prepare,
  transaction,
  saveDatabase,
  get db() { return db; }
};
