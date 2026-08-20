const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const dbModule = require('./database');

// Secret key for JWT (in production, use environment variable)
const JWT_SECRET = process.env.JWT_SECRET || 'coup-secret-key-change-in-production';
const JWT_EXPIRES_IN = '30d'; // Token valid for 30 days
const RESET_TOKEN_EXPIRY_MS = 60 * 60 * 1000; // Password reset links are valid for 1 hour

// Helper to get db instance
function getDb() {
  return dbModule.prepare.bind(dbModule);
}

/**
 * Register a new user
 */
function register(username, password, email = null) {
  // Validate username
  if (!username || username.length < 3 || username.length > 20) {
    return { success: false, error: 'Username must be 3-20 characters' };
  }

  // Check if username contains only alphanumeric and underscore
  if (!/^[a-zA-Z0-9_]+$/.test(username)) {
    return { success: false, error: 'Username can only contain letters, numbers, and underscores' };
  }

  // Validate password
  if (!password || password.length < 6) {
    return { success: false, error: 'Password must be at least 6 characters' };
  }

  // Check if user already exists
  const getUserByUsername = dbModule.prepare(`
    SELECT id, username, password_hash, display_name, created_at, last_login
    FROM users
    WHERE username = ? COLLATE NOCASE
  `);
  const existing = getUserByUsername.get(username);
  if (existing) {
    return { success: false, error: 'Username already taken' };
  }

  // If an email was provided, make sure no other account already uses it -
  // password reset looks accounts up by email, and a duplicate would make
  // that ambiguous for both accounts involved.
  if (email && email.trim()) {
    const existingEmail = dbModule.prepare(`
      SELECT id FROM users WHERE email = ? COLLATE NOCASE
    `).get(email.trim());
    if (existingEmail) {
      return { success: false, error: 'That email address is already in use by another account.' };
    }
  }

  try {
    // Hash password
    const salt = bcrypt.genSaltSync(10);
    const passwordHash = bcrypt.hashSync(password, salt);

    // Check if this is the first user (make them admin)
    const userCount = dbModule.prepare('SELECT COUNT(*) as count FROM users').get();
    const isFirstUser = userCount.count === 0;
    const role = isFirstUser ? 'admin' : 'user';

    // Insert user
    const insertUser = dbModule.prepare(`
      INSERT INTO users (username, password_hash, email, display_name, role)
      VALUES (?, ?, ?, ?, ?)
    `);
    const result = insertUser.run(username, passwordHash, email, username, role);
    const userId = result.lastInsertRowid;
    
    if (!userId || userId === 0) {
      throw new Error('Failed to create user');
    }
    
    if (isFirstUser) {
      console.log(`🛡️  First user '${username}' created as admin`);
    }
    
    // Create stats entry - check if already exists first
    const checkStats = dbModule.prepare(`
      SELECT user_id FROM user_stats WHERE user_id = ?
    `);
    const existingStats = checkStats.get(userId);
    
    if (!existingStats) {
      const insertUserStats = dbModule.prepare(`
        INSERT INTO user_stats (user_id)
        VALUES (?)
      `);
      insertUserStats.run(userId);
    }
    
    // Save database
    dbModule.saveDatabase();

    // Generate JWT token
    const token = jwt.sign(
      { id: userId, username: username },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    return {
      success: true,
      token,
      user: {
        id: userId,
        username: username,
        display_name: username
      }
    };
  } catch (error) {
    console.error('Registration error:', error);
    
    // More specific error messages
    if (error.message && error.message.includes('UNIQUE')) {
      return { success: false, error: 'Username already taken' };
    }
    
    return { success: false, error: 'Registration failed' };
  }
}

/**
 * Login user
 */
function login(username, password) {
  // Validate input
  if (!username || !password) {
    return { success: false, error: 'Username and password required' };
  }

  // Get user
  const getUserByUsername = dbModule.prepare(`
    SELECT id, username, password_hash, display_name, deck_preference, sound_preference, created_at, last_login
    FROM users
    WHERE username = ? COLLATE NOCASE
  `);
  const user = getUserByUsername.get(username);
  if (!user) {
    return { success: false, error: 'Invalid username or password' };
  }

  // Verify password
  const validPassword = bcrypt.compareSync(password, user.password_hash);
  if (!validPassword) {
    return { success: false, error: 'Invalid username or password' };
  }

  // Update last login
  const updateLastLogin = dbModule.prepare(`
    UPDATE users
    SET last_login = CURRENT_TIMESTAMP
    WHERE id = ?
  `);
  updateLastLogin.run(user.id);
  dbModule.saveDatabase(); // Save after update

  // Get user stats
  const getUserStats = dbModule.prepare(`
    SELECT *
    FROM user_stats
    WHERE user_id = ?
  `);
  const stats = getUserStats.get(user.id);

  // Generate JWT token
  const token = jwt.sign(
    { id: user.id, username: user.username },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );

  return {
    success: true,
    token,
    user: {
      id: user.id,
      username: user.username,
      display_name: user.display_name,
      deck_preference: user.deck_preference || 'default',
      sound_preference: user.sound_preference || 'default',
      created_at: user.created_at,
      stats: stats
    }
  };
}

/**
 * Verify JWT token
 */
function verifyToken(token) {
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    
    // Get user data
    const getUserById = dbModule.prepare(`
      SELECT id, username, display_name, deck_preference, sound_preference, avatar, created_at, last_login
      FROM users
      WHERE id = ?
    `);
    const user = getUserById.get(decoded.id);
    if (!user) {
      return { success: false, error: 'User not found' };
    }

    // Get stats
    const getUserStats = dbModule.prepare(`
      SELECT *
      FROM user_stats
      WHERE user_id = ?
    `);
    const stats = getUserStats.get(user.id);

    return {
      success: true,
      user: {
        id: user.id,
        username: user.username,
        display_name: user.display_name,
        deck_preference: user.deck_preference || 'default',
        sound_preference: user.sound_preference || 'default',
        avatar: user.avatar || '👤',
        created_at: user.created_at,
        stats: stats
      }
    };
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return { success: false, error: 'Token expired' };
    }
    return { success: false, error: 'Invalid token' };
  }
}

/**
 * Get user by ID (for game tracking)
 */
function getUserByIdSimple(userId) {
  const getUserById = dbModule.prepare(`
    SELECT id, username, display_name, created_at, last_login
    FROM users
    WHERE id = ?
  `);
  return getUserById.get(userId);
}

/**
 * Starts a password reset. Looks up the account by username or email.
 * Safe to call with arbitrary/unknown input - never throws. The caller should
 * always show the same generic response regardless of the result, so this
 * can't be used to test whether a given username/email has an account.
 *
 * Returns one of:
 *   { found: false }                          - no matching account, or the
 *                                                email matched more than one
 *                                                account (shouldn't normally
 *                                                happen, but email isn't
 *                                                enforced unique - treated as
 *                                                ambiguous rather than guessing)
 *   { found: true, email: null }               - account exists but has no
 *                                                email on file to send to
 *   { found: true, email, token, username }    - account found, a fresh
 *                                                token was generated and
 *                                                saved; caller should email it
 */
function requestPasswordReset(identifier) {
  if (!identifier || typeof identifier !== 'string') {
    return { found: false };
  }

  const trimmed = identifier.trim();
  if (!trimmed) return { found: false };

  // Try username first (exact match, case-insensitive)
  let user = dbModule.prepare(`
    SELECT id, username, email FROM users WHERE username = ? COLLATE NOCASE
  `).get(trimmed);

  // Fall back to email - but only act on it if it uniquely identifies one
  // account, since email isn't enforced unique at the database level
  if (!user) {
    const matches = dbModule.prepare(`
      SELECT id, username, email FROM users
      WHERE email = ? COLLATE NOCASE AND email IS NOT NULL AND email != ''
    `).all(trimmed);
    if (matches.length === 1) {
      user = matches[0];
    }
  }

  if (!user) {
    return { found: false };
  }

  if (!user.email) {
    return { found: true, email: null };
  }

  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + RESET_TOKEN_EXPIRY_MS).toISOString();

  dbModule.prepare(`
    UPDATE users SET reset_token_hash = ?, reset_token_expires = ? WHERE id = ?
  `).run(tokenHash, expiresAt, user.id);
  dbModule.saveDatabase();

  return { found: true, email: user.email, token: rawToken, username: user.username };
}

/**
 * Completes a password reset given the raw token from the emailed link.
 * The token itself is never stored in plaintext - only its SHA-256 hash is
 * compared against what's on file, and it's single-use (cleared on success).
 */
function resetPasswordWithToken(token, newPassword) {
  if (!token || typeof token !== 'string') {
    return { success: false, error: 'Invalid or expired reset link' };
  }

  if (!newPassword || newPassword.length < 6) {
    return { success: false, error: 'Password must be at least 6 characters' };
  }

  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

  const user = dbModule.prepare(`
    SELECT id, reset_token_expires FROM users WHERE reset_token_hash = ?
  `).get(tokenHash);

  if (!user) {
    return { success: false, error: 'Invalid or expired reset link' };
  }

  if (!user.reset_token_expires || new Date(user.reset_token_expires).getTime() < Date.now()) {
    return { success: false, error: 'This reset link has expired. Please request a new one.' };
  }

  const salt = bcrypt.genSaltSync(10);
  const passwordHash = bcrypt.hashSync(newPassword, salt);

  dbModule.prepare(`
    UPDATE users SET password_hash = ?, reset_token_hash = NULL, reset_token_expires = NULL WHERE id = ?
  `).run(passwordHash, user.id);
  dbModule.saveDatabase();

  return { success: true };
}

/**
 * Permanently deletes a user's own account after verifying their password.
 *
 * Cleans up related tables explicitly rather than relying on the schema's
 * ON DELETE CASCADE/SET NULL clauses, since this database does not have
 * SQLite foreign key enforcement turned on (those clauses are declared but
 * not actually active here).
 *
 * Known limitation: game_history stores a JSON snapshot of every player in
 * each match rather than a normalized reference to their user row, so a
 * deleted user's username and stats will still appear in the historical
 * match records of other players they've played against. This function
 * does not attempt to rewrite that historical data.
 */
function deleteAccount(userId, password) {
  const user = dbModule.prepare(`
    SELECT id, username, password_hash, role FROM users WHERE id = ?
  `).get(userId);

  if (!user) {
    return { success: false, error: 'Account not found' };
  }

  if (!password || !bcrypt.compareSync(password, user.password_hash)) {
    return { success: false, error: 'Incorrect password' };
  }

  // Don't let the last remaining admin delete themselves and leave the
  // site with no one able to moderate or manage it.
  if (user.role === 'admin') {
    const adminCount = dbModule.prepare(`
      SELECT COUNT(*) as count FROM users WHERE role = 'admin'
    `).get().count;
    if (adminCount <= 1) {
      return { success: false, error: 'You are the only admin. Promote another user to admin before deleting your account.' };
    }
  }

  dbModule.prepare(`DELETE FROM user_stats WHERE user_id = ?`).run(userId);
  dbModule.prepare(`UPDATE game_history SET winner_user_id = NULL WHERE winner_user_id = ?`).run(userId);
  dbModule.prepare(`DELETE FROM users WHERE id = ?`).run(userId);
  dbModule.saveDatabase();

  return { success: true };
}

module.exports = {
  register,
  login,
  verifyToken,
  getUserByIdSimple,
  requestPasswordReset,
  resetPasswordWithToken,
  deleteAccount,
  JWT_SECRET
};
