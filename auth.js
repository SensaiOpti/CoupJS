const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const dbModule = require('./database');

// Secret key for JWT (in production, use environment variable)
const JWT_SECRET = process.env.JWT_SECRET || 'coup-secret-key-change-in-production';
const JWT_EXPIRES_IN = '30d'; // Token valid for 30 days

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
    SELECT id, username, password_hash, display_name, deck_preference, created_at, last_login
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
      SELECT id, username, display_name, deck_preference, created_at, last_login
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

module.exports = {
  register,
  login,
  verifyToken,
  getUserByIdSimple,
  JWT_SECRET
};
