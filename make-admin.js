const db = require('./database');

async function makeAdmin(username) {
  await db.initDatabase();
  
  const user = db.prepare('SELECT id, username, role FROM users WHERE username = ?').get(username);
  
  if (!user) {
    console.log(`User '${username}' not found`);
    return;
  }
  
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run('admin', user.id);
  db.saveDatabase();
  
  console.log(`✓ ${username} is now an admin!`);
  process.exit(0);
}

// Replace with your actual username
makeAdmin('your_username_here');

// To run this, open the terminal and run:
// node make-admin.js