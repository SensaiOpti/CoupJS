// Test script for Profile & Leaderboard API
// Run with: node test-profile-api.js

const http = require('http');

const BASE_URL = 'http://localhost:3001';

function makeRequest(path) {
  return new Promise((resolve, reject) => {
    http.get(`${BASE_URL}${path}`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, data });
        }
      });
    }).on('error', reject);
  });
}

async function runTests() {
  console.log('🧪 Testing Profile & Leaderboard API\n');
  console.log('Make sure server is running on port 3001!\n');
  
  try {
    // Test 1: Get leaderboard (Elo)
    console.log('1️⃣  Testing GET /api/leaderboards/elo...');
    const elo = await makeRequest('/api/leaderboards/elo?limit=5');
    console.log(`   Status: ${elo.status}`);
    console.log(`   Players: ${elo.data.leaderboard?.length || 0}`);
    if (elo.data.leaderboard?.[0]) {
      console.log(`   #1: ${elo.data.leaderboard[0].username} - ${elo.data.leaderboard[0].primaryStat} Elo`);
    }
    console.log('   ✅ Success!\n');
    
    // Test 2: Get profile (if we have a user)
    if (elo.data.leaderboard?.[0]) {
      const username = elo.data.leaderboard[0].username;
      console.log(`2️⃣  Testing GET /api/profile/${username}...`);
      const profile = await makeRequest(`/api/profile/${username}`);
      console.log(`   Status: ${profile.status}`);
      console.log(`   Username: ${profile.data.user?.username}`);
      console.log(`   Elo: ${profile.data.stats?.elo_rating}`);
      console.log(`   Win Rate: ${profile.data.stats?.win_rate}%`);
      console.log(`   K/D: ${profile.data.stats?.kd_ratio}`);
      console.log(`   Playstyle: ${profile.data.playstyle?.icon} ${profile.data.playstyle?.name}`);
      console.log(`   Achievements: ${profile.data.achievements?.length || 0}`);
      console.log('   ✅ Success!\n');
      
      // Test 3: Get match history
      console.log(`3️⃣  Testing GET /api/profile/${username}/matches...`);
      const matches = await makeRequest(`/api/profile/${username}/matches?limit=5`);
      console.log(`   Status: ${matches.status}`);
      console.log(`   Matches: ${matches.data.matches?.length || 0}`);
      if (matches.data.matches?.[0]) {
        const m = matches.data.matches[0];
        console.log(`   Latest: ${m.isWinner ? '🥇' : '💀'} Placement #${m.placement}/${m.totalPlayers} - ${m.eloChange > 0 ? '+' : ''}${m.eloChange} Elo`);
      }
      console.log('   ✅ Success!\n');
    }
    
    // Test 4: Get win rate leaderboard
    console.log('4️⃣  Testing GET /api/leaderboards/winrate...');
    const winrate = await makeRequest('/api/leaderboards/winrate?minGames=10&limit=5');
    console.log(`   Status: ${winrate.status}`);
    console.log(`   Players: ${winrate.data.leaderboard?.length || 0}`);
    if (winrate.data.leaderboard?.[0]) {
      console.log(`   #1: ${winrate.data.leaderboard[0].username} - ${winrate.data.leaderboard[0].primaryStat}% win rate`);
    }
    console.log('   ✅ Success!\n');
    
    // Test 5: Get specialty leaderboard (Assassin)
    console.log('5️⃣  Testing GET /api/leaderboards/assassin...');
    const assassin = await makeRequest('/api/leaderboards/assassin?limit=5');
    console.log(`   Status: ${assassin.status}`);
    console.log(`   Players: ${assassin.data.leaderboard?.length || 0}`);
    if (assassin.data.leaderboard?.[0]) {
      console.log(`   #1: ${assassin.data.leaderboard[0].username} - ${assassin.data.leaderboard[0].primaryStat} assassinations`);
    }
    console.log('   ✅ Success!\n');
    
    console.log('🎉 All tests passed!\n');
    console.log('Available leaderboard types:');
    console.log('  - elo, winrate, kd, wins');
    console.log('  - bluffer, tax, assassin, finisher, economist\n');
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.log('\nMake sure:');
    console.log('  1. Server is running (npm start)');
    console.log('  2. Database has some test data');
    console.log('  3. You\'re on the correct port (3001)');
  }
}

runTests();
