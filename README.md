# CoupJS
An entirely (well, 99%+) AI generated web version of the social deception card game Coup. Based on my love of [secrethitler.io](https://github.com/cozuya/secret-hitler).

Seriously, I know nothing about coding at all so enter at your own risk. I can promise there won't be any of those annoying emojis, though. Not once I purge them.

## Non-AI Stuff
There are a handful of items that are not AI generated. I've listed them below with extreme praise and thanks to their creator:

- In the default cards, I use a font called Pfeffer Mediæval, which was made by the lovely Dr. Pfeffer and can be found [here](https://robert-pfeffer.net/schriftarten/englisch/). It was used with admiration, appreciation, awe and respect for all that the good doctor does.
- In the anime card set, I use a font called [Lollipoptron](https://www.fontspace.com/lollipoptron-font-f29782) which was designed by heaven castro as a derivative of KineticPlasma Fonts' Hi. A mouthful!
- In the pixel card set, I use a font called [PixelMplus](https://fontmeme.com/fonts/pixelmplus-font/) by the heroic Itou Hiroki. A font that evokes a feeling of nostalgia.
- In the minimalist card set, the font [Rothenburg Decorative](https://www.fontspace.com/rothenburg-decorative-font-f56110) is used, with much love and care. Well done to the designer, Dieter Steffmann.

## Technologies Used

### Backend
- **Node.js** - JavaScript runtime environment
- **Express.js** - Web application framework for building RESTful APIs
- **Socket.IO** - Real-time bidirectional event-based communication
- **SQL.js** - SQLite compiled to WebAssembly, running in the browser
- **bcryptjs** - Password hashing library for secure authentication
- **jsonwebtoken (JWT)** - JSON Web Token for stateless authentication

### Frontend
- **React** - UI library for building interactive components
- **TypeScript** - Superset of JavaScript that adds static typing
- **lucide-react** - Lightweight icon library for React applications

### Database
- **SQLite (via SQL.js)** - Embedded SQL database that runs directly in the browser

### Key Features
- **Real-time multiplayer** - WebSocket-based game communication
- **Authentication system** - User registration, login, and JWT verification
- **Game state management** - React hooks for state management (useState, useEffect, useRef)
- **Card game mechanics** - Full implementation of Coup rules including the Inquisitor variant

## Installation

```bash
npm install
```

## Running the Application

```bash
npm start
```

### First Time Use / Administrators
The first created user account is an administrator...a super one! This super admin has access to special privileges. I **strongly advise** you, as the one hosting this, to create an admin user prior to allowing others to register. 

All admin users:
- Have access to the Admin Panel page, where they can see a list of users
- Can timeout and ban specific users. (Or undo any of these actions!)
- Can access moderation logs to see any recent actions performed by other admins.

Additionally, the super admin is able to promote users to be administrators.

Please note that administrators cannot be timed out nor banned. Be careful who you promote!

### Updating Cards
You can add in more folders for your own custom cards. Simply create a folder in `CoupJS/public/images/cards/` and name it whatever you like. Inside that folder, include a PNG of each character, as well as one for the back:

- ambassador.png
- assassin.png
- back.png
- captain.png
- contessa.png
- duke.png
- inquisitor.png

### Updating Sounds
Similar to cards above, you can add in more folders for your own custom sounds. Create a folder in `CoupJS/public/sounds` and name it whatever you like. Inside it, include an MP3 file of the following:

- countdown.mp3
- deal.mp3
- eliminate.mp3
- gameover.mp3
- lose-influence.mp3
- reveal.mp3
- victory.mp3

If you don't have one of these sounds available, the equivalent sound from the default set will play instead.
