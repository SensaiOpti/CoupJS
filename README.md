# CoupJS
An entirely (well, 99%+) AI generated web version of the social deception card game Coup. Based on my love of [secrethitler.io](https://github.com/cozuya/secret-hitler).

Seriously, I know nothing about coding at all so enter at your own risk. I've done my best to remove em-dashes and emojis (kinda; they're nice for achievements).

## Non-AI Stuff
There are a handful of items that are not AI generated. I've listed them below with extreme praise and thanks to their creator:

- In the default cards, I use a font called Pfeffer Mediæval, which was made by the lovely Dr. Pfeffer and can be found [here](https://robert-pfeffer.net/schriftarten/englisch/). It was used with admiration, appreciation, awe and respect for all that the good doctor does.
- In the anime card set, I use a font called [Lollipoptron](https://www.fontspace.com/lollipoptron-font-f29782) which was designed by heaven castro as a derivative of KineticPlasma Fonts' Hi. A mouthful!
- In the pixel card set, I use a font called [PixelMplus](https://fontmeme.com/fonts/pixelmplus-font/) by the heroic Itou Hiroki. A font that evokes a feeling of nostalgia.
- In the minimalist card set, the font [Rothenburg Decorative](https://www.fontspace.com/rothenburg-decorative-font-f56110) is used, with much love and care. Well done to the designer, Dieter Steffmann.
- For several portrait avatars, images from [SecretHitler.io](https://github.com/cozuya/secret-hitler) are used. In fact, this whole project is really a love letter to what that team has done.

## Technologies Used

### Backend
- **Node.js** - JavaScript runtime environment
- **Express.js** - Web application framework for building RESTful APIs
- **Socket.IO** - Real-time bidirectional event-based communication
- **SQL.js** - SQLite compiled to WebAssembly, running in the browser
- **bcryptjs** - Password hashing library for secure authentication
- **jsonwebtoken (JWT)** - JSON Web Token for stateless authentication

### Frontend
- **HTML/CSS/JavaScript** - Static pages served by Express

### Database
- **SQLite (via SQL.js)** - Embedded SQL database that runs directly in the browser

### More Info the AI Wanted Me to Tell You
- **Real-time multiplayer** - WebSocket-based game communication
- **Authentication system** - User registration, login, and JWT verification
- **Card game mechanics** - Full implementation of Coup rules including the Inquisitor variant
  - Well, duh. I don't...I dunno why it wants you to know this, as if it is isn't the bare minimum as to what you'd expect from this.

## Installation

```bash
npm install
```

## Running the Application

```bash
npm start
```

## Configuration
Everything below is set via environment variables. Nothing here is required to get a basic instance running, though you should definitely read through this if you plan to expose it to the internet.

### `TRUST_PROXY` - if you're behind a reverse proxy, CDN, or tunnel
By default, this app trusts **no** proxy headers at all - it uses the raw TCP connection address as the client's IP, which is the correct, safe choice if you're just running `node server.js` (or a Docker container) with nothing in front of it. IP addresses matter here for rate limiting (login attempts, room passwords, etc.) and IP bans, so getting this setting right matters once something *is* in front of Node - otherwise every visitor can end up sharing the same apparent IP (breaking rate limits/bans for everyone at once), or worse, a visitor can just set the header themselves and claim to be anyone.

Set `TRUST_PROXY` to:
- **`cloudflare`** - if you're serving this through Cloudflare, whether via a standard Cloudflare-proxied ("orange cloud") domain or a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) (`cloudflared`). This trusts Cloudflare's own `CF-Connecting-IP` header, which is simpler and more reliable than counting proxy hops.
- **A number**, e.g. `1` or `2` - for any other reverse proxy/CDN setup. Use `1` if there's a single reverse proxy (nginx, your host's load balancer) directly in front of Node. Use `2` if there's a CDN in front of *that* reverse proxy, and so on - it should match how many hops of infrastructure you control and trust to have appended their own observed address to `X-Forwarded-For`.

**Whichever mode you use, make sure Node's port isn't *also* reachable directly** (bypassing the proxy/tunnel) - otherwise an attacker can hit that path and set these headers themselves, same as if `TRUST_PROXY` were never set. A Cloudflare Tunnel is safe by default here since it never opens an inbound port at all.

### `JWT_SECRET` - required for real deployments
Falls back to a hardcoded placeholder if unset, which is fine for trying things out locally but must **not** be used for anything public - anyone who knows the placeholder can forge a valid login for any account. Set it to a long, random string.

### Email (password reset)
See the comment block at the top of `email.js` for the SMTP-related environment variables. If these aren't set, "forgot password" links are only logged to the server console instead of emailed - fine for local testing, but means anyone who can read your server's logs can reset any account's password, so make sure real SMTP credentials are configured before letting the public register.

### First Time Use / Administrators
The first created user account is an administrator...a super one! This super admin has access to special privileges. I **strongly advise** you, as the one hosting this, to create an admin user prior to allowing others to register. 

All admin users:
- Have access to the Admin Panel page, where they can see a list of users
- Can timeout and ban specific users. (Or undo any of these actions!)
- Can access moderation logs to see any recent actions performed by other admins.

Additionally, the super admin is able to promote users to be administrators.

Please note that administrators cannot be timed out nor banned. Be careful who you promote!

## Customization
### Updating Cards
You can add in more folders for your own custom cards. Simply create a folder in `CoupJS/public/images/cards/` and name it whatever you like. Inside that folder, include a PNG of each character, as well as one for the back:

| Image name | Actual card |
|---|---|
| `ambassador.png` | Ambassador |
| `assassin.png` | Assassin |
| `back.png` | Card back / face down card |
| `captain.png` | Captain |
| `contessa.png` | Contessa |
| `duke.png` | Duke |
| `inquisitor.png` | Inquisitor |

If you don't have one of these cards available, it will fallback to the equivalent image in the default set.

### Updating Sounds
Similar to cards above, you can add in more folders for your own custom sounds. Create a folder in `CoupJS/public/sounds` and name it whatever you like. Inside it, include an MP3 file of the following:

| Sound name | When it plays |
|---|---|
| `action.mp3` | Any action is taken |
| `block.mp3` | Someone declares a block |
| `challenge.mp3` | Someone issues a challenge |
| `coins.mp3` | Coins are gained |
| `countdown.mp3` | 3-2-1 countdown before the game starts |
| `deal.mp3` | Cards dealt at game start |
| `eliminate.mp3` | A player is fully eliminated |
| `fail.mp3` | A challenge fails / bluff caught |
| `gameover.mp3` | Everyone else's end-game sound |
| `lose-influence.mp3` | Plays alongside `reveal.mp3` |
| `notification.mp3` | General notification blip |
| `reveal.mp3` | A player reveals/loses a card |
| `success.mp3` | An action/claim succeeds |
| `tick.mp3` | Countdown-timer ticks (last 3 seconds of a decision) |
| `victory.mp3` | Winner's end-game sound |
| `your-turn.mp3` | It becomes your turn |

If you don't have one of these sounds available, the equivalent sound from the default set will play instead. If there's no equivalent sound there, then it will use a syntheized tone as its last ditch effort to play a sound.

You can dictate an icon for the sound pack by putting a PNG file at `CoupJS/public/images/sound-icons`; if the name of that file matches exactly with a sound pack, it will be the icon for it.
