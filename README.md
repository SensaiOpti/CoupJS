# CoupJS

An entirely (well, 99%+) AI generated web version of the social deception card game Coup. Based on my love of [secrethitler.io](https://github.com/cozuya/secret-hitler).

Seriously, I know nothing about coding at all so enter at your own risk. I can promise there won't be any of those annoying emojis, though. Not once I purge them.

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

## Non-AI Stuff

To date, the only things *not* AI generated are the fonts:

- In the default cards, I use Pfeffer Mediæval, which was made by the lovely Dr. Pfeffer and can be found [here](https://robert-pfeffer.net/schriftarten/englisch/). It was used with admiration, appreciation, awe and respect for all that the good doctor does.
- In the anime set, I use Lollipoptron which was designed by heaven castro as a derivative of KineticPlasma Fonts' Hi. Anyways, you can find it [here](https://www.fontspace.com/lollipoptron-font-f29782).