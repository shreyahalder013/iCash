# iCash — Enterprise Biometric Banking Platform

A high-security, full-stack biometric digital banking platform built with **Node.js, Express.js, PostgreSQL, Prisma ORM, Argon2/Bcrypt credential hashing, secure HTTP-only session management, Appwrite Cloud SDK, FaceAPI.js biometric neural vectors, and Python Flask OpenCV + dlib Real-Time Anti-Spoofing Liveness Detection**.

---

## 🏛️ System Architecture

```text
                    ┌────────────────────────────────────────────────────────┐
                    │                 iCash Web Application                  │
                    │        (HTML5 / Vanilla CSS / Three.js Canvas)         │
                    └───────────┬───────────────────────────────┬────────────┘
                                │ HTTPS                         │ WebSocket / HTTP
                                ▼                               ▼
        ┌───────────────────────────────────┐    ┌───────────────────────────────────┐
        │      Express REST API Gateway     │    │  Python Liveness Detection Server │
        │ (Helmet, Rate Limit, CORS, Auth)  │    │      (OpenCV + dlib 68-EAR)       │
        └───────────────┬───────────────────┘    └─────────────────┬─────────────────┘
                        │                                          │ Real-time Frame
                        │                                          │ Eye-Blink State
         ┌──────────────┼──────────────┬──────────────┐            ▼
         ▼              ▼              ▼              ▼    ┌─────────────────────────┐
┌────────────────┐ ┌──────────┐ ┌────────────┐ ┌─────────┐ │  Anti-Spoofing Engine  │
│ Authentication │ │ Accounts │ │Transactions│ │Biometric│ │  (Photo/Screen Spoof    │
│(JWT & Cookies, │ │ (Multi-  │ │  (Transfers│ │ Vector  │ │   Rejection Guard)      │
│ Bcrypt Hashing)│ │  Portfolio││   & POS)   │ │ Engine) │ └─────────────────────────┘
└────────┬───────┘ └────┬─────┘ └──────┬─────┘ └───┬─────┘
         │              │              │           │
         └──────────────┴──────┬───────┴───────────┘
                               │
                               ▼
                ┌──────────────────────────────┐
                │          Prisma ORM          │
                │   (Atomic ACID Transactions) │
                └──────────────┬───────────────┘
                               │
                               ▼
                ┌──────────────────────────────┐
                │     PostgreSQL Database      │
                │  (Users, Accounts, Balances, │
                │   Transactions, Audit Logs)  │
                └──────────────────────────────┘
```

---

## 🚀 Key Features

### 1. 👁️ Biometric Authentication & Real-Time Liveness (Anti-Spoofing)

- **128D Neural Face Vectors**: Fast, client-side neural descriptor extraction using MobileNet/SSD Mobilenet via `face-api.js`.
- **OpenCV + dlib Real-Time Blink Liveness Server**: Dedicated Python microservice running on port `5001`. Calculates **Eye Aspect Ratio (EAR)** on streaming video frames (`open -> closed -> open`), blocking photo/screen replay spoofing.
- **Multi-Face Guard**: Automatically alerts and halts transactions if multiple faces appear in the camera frame.
- **Resilient Fallbacks**: If the camera is unavailable or the Python server is offline, securely falls back to PIN authentication or on-device landmark analysis.

### 2. 🔐 Multi-Tier Security & Compliance

- **Cryptographic Credential Security**: Passwords and PINs are hashed using **bcrypt / Argon2** (12 rounds). Plaintext credentials and raw Aadhaar numbers are **never** stored.
- **Masked Aadhaar Privacy (UIDAI Principle)**: Compliant with data minimization standards by storing only `aadhaar_last4`, `aadhaar_verified`, and a cryptographic hash.
- **Emergency Duress Protocol**: Entering a registered emergency PIN unlocks the account while covertly dispatching a `DURESS_ALERT` security event with `CRITICAL` severity to the audit log.
- **Automatic Account Lockout**: Accounts are automatically locked after 5 consecutive failed PIN attempts.

### 3. 💳 Digital Banking & Portfolio Management

- **Multi-Account Portfolios**: Create, link, view, and manage multiple savings, current, and digital wallets with instant primary account switching.
- **ACID Atomic Transfers**: Instant money transfers executed in isolated database transactions (`prisma.$transaction`) with balance validations and idempotency checks.
- **Point of Sale (POS) Billing**: Dynamic checkout references with real-time merchant invoice tracking.
- **Senior Assisted Banking**: Registered senior citizens can delegate withdrawal privileges to designated relatives using dynamic 5-minute time-bound OTPs.
- **Permanent Account Deletion ("Delete Account")**: Self-service danger zone feature in Settings & Profile requiring 4-digit PIN re-verification to perform a permanent cascading deletion of personal records and balances.

### 4. 📧 Email Verification System 

- **Registration Code Delivery**: Generates a secure 6-digit numeric verification token with a 24-hour expiration window upon user registration.
- **Dual API Compatibility**: Supports base route `/auth` (direct 1-to-1 compatibility with `zahid-afridi/EmailVerfication`) as well as standard enterprise `/api/auth`.
- **Nodemailer Transport & Dev Mock**: Automated SMTP delivery with instant fallback to visible console dispatch in local/test development.
- **HTML Email Templates**: Sleek, responsive HTML email templates for initial code dispatch (`Verification_Email_Template`) and successful verification celebration (`Welcome_Email_Template`).
- **Interactive Verification UI**: Profile drawer interactive badge and 6-digit code modal with automatic code dispatch, instant verification, and resend support.

---

## 📁 Project Structure

```text
iCash/
├── frontend/                     # Modern Vanilla Web Application
│   ├── index.html                # User, Merchant & Admin portal interface
│   ├── script.js                 # UI controller, routing & state management
│   ├── biometric.js              # Real-time face scanner & liveness frame streamer
│   ├── api.js                    # Centralized REST API & Liveness client
│   ├── lib/
│   │   └── appwrite.js           # Appwrite Web SDK client configuration
│   └── style.css                 # Dark-mode aesthetic banking design system
├── backend/                      # Node.js & Express REST Backend
│   ├── src/
│   │   ├── controllers/          # Auth, Accounts, Transactions, Biometric controllers
│   │   ├── routes/               # REST API route definitions
│   │   ├── middleware/           # Auth, RBAC, Rate-limiting, Zod Validation
│   │   ├── services/             # Atomic business logic, SMS provider & queries
│   │   ├── utils/                # Token signing, Bcrypt, and Zod schemas
│   │   ├── prisma.js             # Prisma ORM singleton instance
│   │   └── server.js             # Express application entrypoint
│   ├── prisma/
│   │   ├── schema.prisma         # Relational database models
│   │   └── seed.js               # Initial administrative database seeder
│   ├── tests/                    # Jest + Supertest automated test suites
│   ├── docker-compose.yml        # PostgreSQL container setup
│   └── package.json
├── package.json                  # Root scripts (build, dev, test)
└── README.md
```

---

## 🛠️ Setup & Running

### 1. Prerequisites

- **Node.js** >= 18.0
- **PostgreSQL** or Docker (for database)

---

### 2. Install Dependencies

```bash
npm install
cd backend && npm install && cd ..
```

---

### 3. Database Setup

1. Start PostgreSQL (or run Docker Compose):

```bash
cd backend
docker compose up -d
```

2. Initialize and push schema:

```bash
npm run prisma:push
npm run prisma:seed
```

For production deployments, apply checked-in migrations instead:

```bash
npx prisma migrate deploy --schema=backend/prisma/schema.prisma
```

To enable hosted AI responses for the Financial Copilot, configure:

```bash
OPENAI_API_KEY=your_openai_api_key_here
OPENAI_MODEL=gpt-4o-mini
```

Without an API key, the Copilot uses a clearly labelled local, transaction-grounded summary so the feature remains usable during development.

---

### 4. Running the Servers

#### A. Start the Banking Application (Frontend + Express API):

```bash
npm run dev
# App will run on http://localhost:4000
```

---

## 🧪 Automated Testing

Run the full backend automated test suite:

```bash
npm test
```

### Test Coverage Includes:

- **`tests/auth.test.js`**: User registration, duplicate prevention, Aadhaar lookup, PIN login, emergency duress alert logging, 5-attempt brute-force lockout, and PIN-confirmed permanent account deletion.
- **`tests/accounts.test.js`**: Account portfolio creation, primary account switching, multi-tenant deletion boundaries.
- **`tests/transactions.test.js`**: Atomic balance deductions, instant deposits, insufficient balance guard, statement queries.
- **`tests/security.test.js`**: Rate-limiting, multi-face alerts, audit log validation.
- **`tests/rbac.test.js`**: Role-based access enforcement for User, Merchant, and Admin routes.

---

## 📡 REST API Reference

### Authentication & Identity (`/api/auth`)

| Method   | Endpoint                  | Description                                       | Auth      |
| :------- | :------------------------ | :------------------------------------------------ | :-------- |
| `POST`   | `/api/auth/register` (or `/auth/register`)       | Register user (Full KYC or `{name, email, password}`) | Public    |
| `POST`   | `/api/auth/verify-email` (or `/auth/verifyEmail`)| Verify email address with 6-digit code `{code}`       | Public / Auth |
| `POST`   | `/api/auth/resend-verification`                  | Resend 6-digit email verification code                | Public / Auth |
| `GET`    | `/api/auth/verification-status`                  | Check current email verification status               | Protected |
| `POST`   | `/api/auth/login-aadhaar`                        | Lookup account by last 4 digits of Aadhaar            | Public    |
| `POST`   | `/api/auth/login-pin`                            | Login with PIN (Standard or Duress Emergency PIN)     | Public    |
| `POST`   | `/api/auth/logout`                               | Terminate session and clear HTTP-only cookies         | Protected |
| `GET`    | `/api/auth/me`                                   | Fetch authenticated profile and linked accounts       | Protected |
| `DELETE` | `/api/auth/me`                                   | Permanently delete account (Requires 4-digit PIN)     | Protected |

### Accounts (`/api/accounts`)

| Method   | Endpoint            | Description                             | Auth      |
| :------- | :------------------ | :-------------------------------------- | :-------- |
| `GET`    | `/api/accounts`     | List user's linked bank accounts        | Protected |
| `POST`   | `/api/accounts`     | Link new bank account                   | Protected |
| `PATCH`  | `/api/accounts/:id` | Update account or toggle primary status | Protected |
| `DELETE` | `/api/accounts/:id` | Unlink bank account                     | Protected |

### Transactions & POS (`/api/transactions`)

| Method | Endpoint                              | Description                                  | Auth      |
| :----- | :------------------------------------ | :------------------------------------------- | :-------- |
| `GET`  | `/api/transactions`                   | Filter and paginate user transaction history | Protected |
| `POST` | `/api/transactions`                   | Execute atomic fund transfer                 | Protected |
| `POST` | `/api/transactions/topup`             | Instant demo wallet top-up                   | Protected |
| `POST` | `/api/transactions/delegate/generate` | Generate senior citizen withdrawal OTP       | Protected |
| `POST` | `/api/transactions/delegate/claim`    | Disburse delegated cash withdrawal           | Public    |

### AI Financial Copilot (`/api/v2/ai`)

| Method | Endpoint             | Description                                   | Auth      |
| :----- | :------------------- | :-------------------------------------------- | :-------- |
| `POST` | `/api/v2/ai/chat`    | Ask a transaction-grounded finance question   | Protected |
| `GET`  | `/api/v2/ai/history` | Read the authenticated user's Copilot history | Protected |

The chat request body is `{ "message": "Why did I spend so much this month?" }`. Conversation records and transaction context are strictly scoped to the authenticated user.

### Intelligent Finance APIs (`/api/v2`)

- `PATCH /api/v2/transactions/:id/category` — correct an automatically assigned category.
- `GET /api/v2/fraud/:transactionId` — retrieve a user-scoped fraud risk analysis.
- `GET /api/v2/analytics/forecast` — project balance and daily cash flow.
- `GET /api/v2/health/score` — return a 0–100 financial health score, grade, and insights.
- `POST /api/v2/receipt/scan` — upload a JPEG/PNG/WEBP/TIFF receipt as `receipt` multipart data.
- `POST /api/v2/splits/groups` and related `/api/v2/splits` routes — create groups, split expenses, optimize debts, and settle payments.
- `GET /api/v2/merchant/dashboard` and `/api/v2/merchant/analytics` — merchant revenue and customer metrics.
- `GET /api/v2/savings/challenges`, `POST /api/v2/savings/challenges/:id/join`, and `GET /api/v2/savings/progress` — savings challenges and progress.
- `GET /api/v2/notifications` — authenticated notification inbox with read-state endpoints.
- `GET /api/v2/subscriptions/detect` — detect recurring payments from the user's transaction history.
- `GET /api/v2/subscriptions` — list persisted subscription reminders.

All v2 endpoints use the existing HTTP-only session authentication and preserve the original `/api` routes.

Fraud scores are returned on a documented 0–100 scale with `LOW`, `MEDIUM`, `HIGH`, or
`CRITICAL` risk levels. New Prisma migrations include reward badges, subscription reminders,
and the score precision update; apply them with `npx prisma migrate deploy` in production.

### Liveness Detection Microservice (`http://localhost:5001`)

| Method | Endpoint           | Description                                      |
| :----- | :----------------- | :----------------------------------------------- |
| `GET`  | `/health`          | Health status and active sessions                |
| `POST` | `/liveness/start`  | Initialize a new liveness session                |
| `POST` | `/liveness/frame`  | Analyze video frame and compute Eye Aspect Ratio |
| `GET`  | `/liveness/status` | Query verification state (`live: true/false`)    |
| `POST` | `/liveness/reset`  | Terminate session and clean up memory            |

---

## 🔒 Security Best Practices Implemented

1. **Zero Secret Leakage**: `password_hash`, `pin_hash`, and `emergency_pin_hash` are stripped from all API responses via Zod schemas and service interceptors.
2. **HTTP-only Cookie Authentication**: Session tokens are transmitted via `HttpOnly`, `SameSite=Lax` cookies, preventing XSS token harvesting.
3. **Database Cascading Deletion**: Account deletion completely purges all sensitive biometric descriptors, accounts, and session data in atomic transactions.
4. **Anti-Replay Liveness Guard**: Real-time eye-blink tracking protects against printed photos, videos, and screen spoofing.

---

## 📄 License

MIT License. Developed for enterprise biometric banking and financial digital security.
