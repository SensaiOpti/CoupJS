const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const os = require('os');
const { Worker } = require('worker_threads');
const dbModule = require('./database');

// Secret key for JWT (in production, use environment variable)
const JWT_SECRET = process.env.JWT_SECRET || 'coup-secret-key-change-in-production';
const JWT_EXPIRES_IN = '30d'; // Token valid for 30 days
const RESET_TOKEN_EXPIRY_MS = 60 * 60 * 1000; // Password reset links are valid for 1 hour

// --- Password hashing, off the main thread ----------------------------------
// bcrypt is deliberately slow (~75 ms per check here). Done on the main thread
// it freezes EVERYTHING - every game, every chat message - for that long, and
// bcryptjs's own "async" mode doesn't help: it only pauses every ~100 ms, so a
// burst of 20 logins froze the whole server for about 1.5 seconds. The work is
// done in a small pool of worker threads instead, so a flood of login attempts
// can slow down logins but not the games in progress.
const MAX_PASSWORD_LENGTH = 72; // bcrypt silently ignores anything past 72 bytes
const BCRYPT_WORKER_SOURCE = `
  const { parentPort } = require('worker_threads');
  const bcrypt = require(${JSON.stringify(require.resolve('bcryptjs'))});
  parentPort.on('message', ({ id, op, a, b }) => {
    try {
      parentPort.postMessage({ id, result: op === 'hash' ? bcrypt.hashSync(a, 10) : bcrypt.compareSync(a, b) });
    } catch (error) {
      parentPort.postMessage({ id, error: String((error && error.message) || error) });
    }
  });
`;
const POOL_SIZE = Math.max(1, Math.min(2, (os.cpus().length || 2) - 1));
const MAX_PENDING_PASSWORD_JOBS = 400; // beyond this, say "busy" rather than queue without limit
const passwordWorkers = new Array(POOL_SIZE).fill(null);
const pendingPasswordJobs = new Map(); // job id -> { resolve, reject, worker }
let nextPasswordWorker = 0;
let nextPasswordJobId = 1;

function spawnPasswordWorker(index) {
  const worker = new Worker(BCRYPT_WORKER_SOURCE, { eval: true });
  worker.unref(); // never keep the process alive just for these
  worker.on('message', ({ id, result, error }) => {
    const job = pendingPasswordJobs.get(id);
    if (!job) return;
    pendingPasswordJobs.delete(id);
    if (error) job.reject(new Error(error)); else job.resolve(result);
  });
  const onStopped = (error) => {
    if (passwordWorkers[index] === worker) passwordWorkers[index] = null; // a fresh one starts on the next job
    for (const [id, job] of pendingPasswordJobs) {
      if (job.worker === worker) {
        pendingPasswordJobs.delete(id);
        job.reject(error instanceof Error ? error : new Error('Password worker stopped'));
      }
    }
  };
  worker.on('error', onStopped);
  worker.on('exit', () => onStopped(new Error('Password worker exited')));
  passwordWorkers[index] = worker;
  return worker;
}

function runPasswordJob(op, a, b) {
  if (pendingPasswordJobs.size >= MAX_PENDING_PASSWORD_JOBS) {
    return Promise.reject(Object.assign(new Error('Too many password checks in progress'), { code: 'PASSWORD_BUSY' }));
  }
  let worker;
  try {
    const index = nextPasswordWorker++ % POOL_SIZE;
    worker = passwordWorkers[index] || spawnPasswordWorker(index);
  } catch (error) {
    // Worker threads unavailable for some reason: still work, one at a time, on the main thread
    console.error('Password worker unavailable, falling back to the main thread:', error.message);
    return new Promise((resolve) => setImmediate(() => resolve(op === 'hash' ? bcrypt.hashSync(a, 10) : bcrypt.compareSync(a, b))));
  }
  return new Promise((resolve, reject) => {
    const id = nextPasswordJobId++;
    pendingPasswordJobs.set(id, { resolve, reject, worker });
    worker.postMessage({ id, op, a, b });
  });
}

function hashPassword(password) { return runPasswordJob('hash', password); }
function comparePassword(password, hash) { return runPasswordJob('compare', password, hash); }

// Checked against when a username doesn't exist, so "no such user" takes as long
// as "wrong password" and response time can't be used to find out who has an account.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('not-a-real-password-just-for-timing', 10);

// Helper to get db instance
function getDb() {
  return dbModule.prepare.bind(dbModule);
}

// Signs a JWT for a given account. Centralized so every caller embeds the
// same payload shape (in particular, tokenVersion - see verifyToken()) and
// so anything that needs to issue a fresh token, like change-password below,
// doesn't have to duplicate the secret/expiry/payload details separately.
function signToken(userId, username, tokenVersion) {
  return jwt.sign(
    { id: userId, username: username, tokenVersion: tokenVersion || 0 },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

/**
 * Register a new user
 */
async function register(username, password, email = null) {
  if (typeof username !== 'string' || typeof password !== 'string') {
    return { success: false, error: 'Username and password required' };
  }
  if (email !== null && email !== undefined && typeof email !== 'string') {
    return { success: false, error: 'Invalid email address' };
  }

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
  if (password.length > MAX_PASSWORD_LENGTH) {
    return { success: false, error: `Password must be ${MAX_PASSWORD_LENGTH} characters or fewer` };
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
    // Hash password (on a worker thread - see hashPassword)
    const passwordHash = await hashPassword(password);

    // The hash took a moment, during which someone else could have registered the
    // same email. Everything from here to the insert runs without pausing.
    if (email && email.trim()) {
      const emailTakenNow = dbModule.prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE').get(email.trim());
      if (emailTakenNow) {
        return { success: false, error: 'That email address is already in use by another account.' };
      }
    }

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
    const token = signToken(userId, username, 0); // 0 matches the token_version column's default for a fresh row

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
    if (error && error.code === 'PASSWORD_BUSY') throw error; // let the route answer "busy"

    // Two people picking the same name at the same moment: the database lets only
    // one in. That's expected, not an error worth a stack trace in the log.
    if (error && error.message && error.message.includes('UNIQUE')) {
      return { success: false, error: 'Username already taken' };
    }

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
async function login(username, password) {
  // Validate input
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    return { success: false, error: 'Username and password required' };
  }

  // Get user
  const getUserByUsername = dbModule.prepare(`
    SELECT id, username, password_hash, display_name, deck_preference, sound_preference, token_version, created_at, last_login
    FROM users
    WHERE username = ? COLLATE NOCASE
  `);
  const user = getUserByUsername.get(username);
  if (!user) {
    await comparePassword(password, DUMMY_PASSWORD_HASH); // same delay as a real check
    return { success: false, error: 'Invalid username or password' };
  }

  // Verify password
  const validPassword = await comparePassword(password, user.password_hash);
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
  const token = signToken(user.id, user.username, user.token_version);

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
      SELECT id, username, display_name, deck_preference, sound_preference, avatar, token_version, created_at, last_login
      FROM users
      WHERE id = ?
    `);
    const user = getUserById.get(decoded.id);
    if (!user) {
      return { success: false, error: 'User not found' };
    }

    // Reject tokens issued before the account's most recent password
    // change. JWTs are otherwise self-contained and would stay valid for
    // their full lifetime (30 days) regardless of what happens to the
    // account afterward - this is what makes "change your password" actually
    // invalidate a stolen token instead of just adding a second valid one.
    // Tokens signed before this check existed have no tokenVersion claim at
    // all; treating that as 0 (rather than rejecting outright) means
    // deploying this doesn't force everyone to re-log-in immediately - only
    // accounts that have actually changed their password since get bumped
    // past 0, which is exactly when their old tokens should stop working.
    if ((decoded.tokenVersion || 0) !== (user.token_version || 0)) {
      return { success: false, error: 'Session expired due to a password change. Please log in again.' };
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
async function resetPasswordWithToken(token, newPassword) {
  if (!token || typeof token !== 'string') {
    return { success: false, error: 'Invalid or expired reset link' };
  }

  if (typeof newPassword !== 'string' || newPassword.length < 6) {
    return { success: false, error: 'Password must be at least 6 characters' };
  }
  if (newPassword.length > MAX_PASSWORD_LENGTH) {
    return { success: false, error: `Password must be ${MAX_PASSWORD_LENGTH} characters or fewer` };
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

  const passwordHash = await hashPassword(newPassword);

  // Bump token_version so any previously-issued tokens for this account stop
  // working immediately - this reset flow exists precisely for "someone else
  // may have my password", so an attacker's existing session needs to die
  // the moment the password changes, not up to 30 days later.
  const updated = dbModule.prepare(`
    UPDATE users
    SET password_hash = ?, reset_token_hash = NULL, reset_token_expires = NULL, token_version = token_version + 1
    WHERE id = ? AND reset_token_hash = ?
  `).run(passwordHash, user.id, tokenHash);

  // The hash took a moment; if the same link was used twice at once, only one
  // of the two requests may succeed (the link is single-use).
  if (updated.changes === 0) {
    return { success: false, error: 'Invalid or expired reset link' };
  }
  dbModule.saveDatabase();

  return { success: true, userId: user.id };
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
async function deleteAccount(userId, password) {
  const user = dbModule.prepare(`
    SELECT id, username, password_hash, role FROM users WHERE id = ?
  `).get(userId);

  if (!user) {
    return { success: false, error: 'Account not found' };
  }

  if (typeof password !== 'string' || !password || !(await comparePassword(password, user.password_hash))) {
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
  hashPassword,
  comparePassword,
  signToken,
  JWT_SECRET
};
