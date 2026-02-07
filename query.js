// query.js - Run SQL queries against the database
const db = require('./database');

async function runQuery() {
  await db.initDatabase();
  
  console.log('\n=== USERS ===');
  const users = db.prepare('SELECT * FROM users').all();
  console.table(users);
  
  console.log('\n=== USER STATS ===');
  const stats = db.prepare(`
    SELECT u.username, 
           s.games_played, s.games_won, s.elo_rating,
           
           -- Core stats
           s.coins_earned, s.coins_spent, s.coins_lost, s.coins_stolen,
           s.influences_lost, s.income_taken, s.coups_enacted, s.players_eliminated,
           
           -- Challenge/Bluff stats
           s.successful_challenges, s.failed_challenges,
           s.claims_defended, s.bluffs_caught, s.bluffs_succeeded,
           
           -- Action-specific stats
           s.tax_succeeded, s.tax_failed,
           s.foreignaid_accepted, s.foreignaid_denied,
           s.foreignaidblock_succeeded, s.foreignaidblock_failed,
           s.steals_blocked,
           
           -- Assassination stats
           s.assassinations_succeeded, s.assassinations_failed,
           s.contessa_succeeded, s.contessa_failed,
           
           -- Exchange/Examine stats
           s.influence_exchanged, s.influence_examined, s.influence_forced
    FROM user_stats s 
    JOIN users u ON s.user_id = u.id
    ORDER BY s.elo_rating DESC
  `).all();
  console.table(stats);
  
  console.log('\n=== GAME HISTORY (Last 5) ===');
  const history = db.prepare(`
    SELECT id, room_code, 
           (SELECT username FROM users WHERE id = winner_user_id) as winner,
           started_at, ended_at, duration_seconds
    FROM game_history 
    ORDER BY ended_at DESC 
    LIMIT 5
  `).all();
  console.table(history);
  
  console.log('\n=== LEADERBOARD (Top 10) ===');
  const leaderboard = db.prepare(`
    SELECT u.username, s.elo_rating, s.games_played, s.games_won,
           ROUND(s.games_won * 100.0 / NULLIF(s.games_played, 0), 1) as win_rate
    FROM user_stats s
    JOIN users u ON s.user_id = u.id
    ORDER BY s.elo_rating DESC
    LIMIT 10
  `).all();
  console.table(leaderboard);
  
  process.exit(0);
}

runQuery().catch(console.error);
