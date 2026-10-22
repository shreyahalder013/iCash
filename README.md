# iCash Banking 🏦

A modern, high-security banking web application featuring cryptographic face biometric authentication, anti-spoofing liveness verification, PIN login, emergency duress alerts, transaction management, and an accessible senior-friendly mode. Powered by an Express.js backend with Supabase PostgreSQL persistence and an automatic in-memory fallback.

---

## 🌟 Key Features

- 🔐 **Dual-Factor Biometrics & PIN** — Fast registration and authentication via 128-dimensional facial embedding vectors or 4–6 digit PIN.
- 👁️ **Anti-Spoofing & Liveness HUD** — Dynamic challenge-response protocol (eye blinks, head turns) using Eye Aspect Ratio (EAR) and facial landmark tracking to defeat photo/video replay attacks.
- 🚨 **Emergency Duress PIN** — Covert duress code that grants access to an emergency disguised session (limited/decoy view, no money movement) while immediately dispatching a stealth alert to authorities and emergency contacts.
- 💸 **Transfers & ATM Services** — Send money, request funds via QR/UPI, and simulate secure ATM cash withdrawals with step-up authentication.
- 📊 **Transaction History & Analytics** — Searchable, filterable ledger with categorized expense visualizations.
- 👴 **Senior Mode** — High-contrast, large-typography, simplified interface with extra confirmations and enlarged touch targets for elderly accessibility.
- 🛡️ **Audit Logging & Security Events** — Real-time event auditing capturing logins, policy violations, and suspicious access attempts.
- 🔄 **Resilient Database Layer** — Connects to Supabase PostgreSQL in production and automatically falls back to an in-memory data store when database credentials are not configured.

---

## 🛠️ Tech Stack

| Layer               | Technologies                                                                                                                                 |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **Frontend**        | Vanilla HTML5, CSS3, ES6+ JavaScript, WebRTC Camera Stream                                                                                   |
| **Biometrics & AI** | [face-api.js](https://github.com/justadudewhohacks/face-api.js/) (Tiny Face Detector, 68-Point Facial Landmarks, 128-d Face Recognition Net) |
| **Backend**         | Node.js 20+, Express.js, `express-session` (connect-pg-simple), `cors`, `helmet`, `argon2`, `zod`, `express-rate-limit`                       |
| **Database**        | PostgreSQL via Supabase (`pg` connection pool) with Resilient In-Memory Fallback; RLS enabled                                                |
| **Deployment**      | Render, Docker, or any Node.js hosting platform                                                                                              |

---

## 📂 Project Structure

```
iCash-Bank-main/
├── index.html              # Landing page & authentication gateway (hash router SPA)
├── .env.example            # Template for environment configuration
├── css/
│   └── style.css           # Application stylesheets (incl. Senior Mode overrides)
├── js/                     # Client-side JavaScript modules (vanilla ES6+)
│   ├── app.js              # Core application state, router, helpers, navbar, modal, toast
│   ├── landing.js          # Landing page interaction
│   ├── login.js            # PIN & face login handling
│   ├── register.js         # User onboarding & face enrollment wizard
│   ├── dashboard.js        # Main account dashboard
│   ├── send.js             # Money transfer workflow (server-calculated fee)
│   ├── receive.js          # Receive money & QR code (demo QR)
│   ├── withdraw.js         # ATM cardless withdrawal simulation
│   ├── history.js          # Transaction ledger & filtering
│   ├── analytics.js        # Spending breakdown charts (Chart.js)
│   ├── security.js         # Security audit log UI
│   ├── profile.js          # User settings & emergency contacts
│   ├── face-scanner.js     # Biometric camera scanner (MediaPipe + face-api.js)
│   └── atm.js              # ATM locator & simulation
├── models/                 # Pretrained weights for face-api.js (local, no CDN)
├── server/
│   ├── server.js           # Express API server & biometric challenge-response handlers
│   ├── db.js               # Dual-mode database layer (Supabase PostgreSQL + In-Memory)
│   └── logger.js           # Structured logger (Pino)
├── supabase/
│   └── schema.sql          # SQL schema with RLS policies, CHECK constraints
├── package.json            # Project dependencies & startup scripts
├── vitest.config.js        # Test configuration
└── server/*.test.js        # Vitest + Supertest integration tests
```

---

## 🚀 Quickstart & Local Development

### Prerequisites

- [Node.js](https://nodejs.org/) (v20.12 or later recommended)
- `npm` (included with Node.js) or `yarn`
- Modern web browser with camera permissions enabled (for facial recognition)

### 1. Clone & Install

```bash
git clone https://github.com/your-username/iCash-Bank.git
cd iCash-Bank-main
npm install
# or: yarn install
```

### 2. Configure Environment (Optional)

The application includes an **automatic in-memory mode**; it runs out of the box with zero external database configuration required.

To connect your own **Supabase PostgreSQL** database:

1. Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```
2. Populate the connection variables:

   ```env
   # Server settings
   PORT=3000
   NODE_ENV=development
   SESSION_SECRET=your-random-secret-key

   # Option A — Individual parameters (recommended)
   PG_HOST=aws-0-ap-south-1.pooler.supabase.com
   PG_PORT=5432
   PG_USER=postgres.your-project-ref
   PG_PASSWORD=your-db-password
   PG_DATABASE=postgres

   # Option B — Pooled connection string
   SUPABASE_DB_URL=postgresql://postgres.your-ref:your-password@aws-0-ap-south-1.pooler.supabase.com:5432/postgres

   # Demo seed (only in development)
   # ALLOW_DEMO_SEED=true
   # DEMO_NORMAL_PIN=your-pin
   # DEMO_EMERGENCY_PIN=your-emergency-pin

   # Face match threshold (Euclidean distance, 0.55 default)
   FACE_MATCH_THRESHOLD=0.55
   ```

3. Run `supabase/schema.sql` inside your Supabase project's **SQL Editor** to create the required tables with RLS policies.

### 3. Start the Server

```bash
npm run dev
# or: npm start
# or: yarn dev
```

The server starts on `http://localhost:3000`.

---

## 🖥️ Application Interfaces

Once the server is running, access the interfaces in your browser:

- **Landing & Auth Gateway:** [http://localhost:3000/](http://localhost:3000/) (hash router: `#landing`, `#login`, `#register`, `#dashboard`, etc.)

---

## 🌐 API Reference

### Health & Session

| Method | Route          | Description                      | Auth Required |
| ------ | -------------- | -------------------------------- | :-----------: |
| `GET`  | `/api/health`  | Health check and server status   |      No       |
| `GET`  | `/api/session` | Validate server session validity |      No       |

### Biometric Challenge-Response Authentication

| Method | Route                           | Description                                                                      | Auth Required |
| ------ | ------------------------------- | -------------------------------------------------------------------------------- | :-----------: |
| `POST` | `/api/auth/biometric/challenge` | Generate randomized anti-replay liveness challenge (`blink`, `turn`, etc.)       |      No       |
| `POST` | `/api/auth/biometric/verify`    | Verify 128-d live face descriptor, EAR eye dynamics, and complete authentication |      No       |
| `POST` | `/api/auth/biometric/enroll`    | Register or update 128-d face embedding for an account                           | PIN / Session |

### Standard Authentication & Profile

| Method | Route           | Description                                               | Auth Required |
| ------ | --------------- | --------------------------------------------------------- | :-----------: |
| `POST` | `/api/register` | Register new user account + optional biometric enrollment |      No       |
| `POST` | `/api/login`    | Authenticate using Normal or Emergency PIN                |      No       |
| `POST` | `/api/logout`   | Terminate session and clear cookies                       |      Yes      |
| `GET`  | `/api/user`     | Get profile, current balance, and account state           |      Yes      |
| `PUT`  | `/api/user`     | Update user profile, contact details, or senior mode      |      Yes      |

### Step-Up Authentication

| Method | Route                 | Description                                      | Auth Required |
| ------ | --------------------- | ------------------------------------------------ | :-----------: |
| `POST` | `/api/auth/step-up`   | Single-use token (2 min TTL) bound to session+amount+recipient | Yes |
| `POST` | `/api/auth/verify-pin` | Verify PIN without session creation (for step-up) | Yes |

### Banking & Transactions

| Method | Route               | Description                                                  | Auth Required |
| ------ | ------------------- | ------------------------------------------------------------ | :-----------: |
| `GET`  | `/api/balance`      | Retrieve current account balance                             |      Yes      |
| `GET`  | `/api/transactions` | Query transactions (supports `?type=`, `?date=`, `?search=`) |      Yes      |
| `POST` | `/api/transactions` | Record withdrawal (type `out` only; atomic debit + ledger)   |      Yes      |
| `POST` | `/api/transfer`     | Transfer funds (atomic, requires step-up token)              |      Yes      |
| `POST` | `/api/transfer/fee` | Server-calculated transfer fee (0.5%, min ₹1, max ₹100)      |      Yes      |

### Security Audit

| Method | Route         | Description                                 | Auth Required |
| ------ | ------------- | ------------------------------------------- | :-----------: |
| `GET`  | `/api/events` | Retrieve account security events and alerts |      Yes      |
| `POST` | `/api/events` | Log client security warning or anomaly      |      Yes      |

---

## ☁️ Deploying to Render

1. Push your repository to GitHub.
2. In [Render](https://render.com), create a new **Web Service**.
3. Configure the build parameters:
   - **Environment:** `Node`
   - **Build Command:** `npm install` (or `yarn install`)
   - **Start Command:** `npm start` (or `yarn start`)
4. Add environment variables in Render's dashboard:
   - `PG_HOST`
   - `PG_PORT` (`5432` or `6543`)
   - `PG_USER`
   - `PG_PASSWORD`
   - `PG_DATABASE`
   - `SESSION_SECRET`
   - `NODE_ENV=production`
   - `FACE_MATCH_THRESHOLD=0.55`

> **Note:** If connecting to Supabase via Render, use an alphanumeric database password without URI-reserved characters (`@`, `#`, `%`), or configure individual `PG_*` parameters.

---

## 🛠️ Troubleshooting

- **Webcam permission denied:** Ensure your browser has granted webcam permissions to `http://localhost:4000`. Chrome blocks camera access on unencrypted connections unless accessed via `localhost` or `127.0.0.1`.
- **Face not recognized:** Ensure good lighting and face visibility. You can adjust the match threshold via `FACE_MATCH_THRESHOLD` in `.env` (default is `0.55`).
- **PostgreSQL connection refused:** If Supabase is offline or credentials are missing, check server console output. The server automatically falls back to the in-memory store so you can continue testing immediately.
- **Biometric models fail to load:** Ensure all 6 model files exist in `models/` (`*.bin` + `*_manifest.json`). The app will show a clear error if any file is missing.

---

## 📄 License

MIT License. See [LICENSE](LICENSE) for details.