# Cognivex Behavioral Biometrics

[Features](#features) | [Architecture Overview](#architecture-overview) | [Installation](#installation) | [Running the App](#running-the-app) | [Contributors](#contributors)

This project implements a behavioral biometrics system with browser-based event collection, server-side feature extraction, adaptive risk scoring, and OTP-based step-up verification. It combines deterministic session handling with a lightweight anomaly detection pipeline to support continuous authentication.

---

## Features

- **Behavioral event capture:** keyboard, mouse, and scroll activity collected in the browser
- **Snapshot-based scoring:** periodic 30-second behavioral snapshots sent to the backend
- **Server-side feature extraction:** raw events are converted into numeric features in `backend/feature_extractor.py`
- **Adaptive risk handling:** low, medium, and high-risk outcomes with OTP escalation for suspicious sessions
- **OTP verification flow:** Gmail SMTP-based challenge/response for step-up authentication
- **Session lifecycle control:** explicit session end handling on logout and page unload
- **Supabase-backed persistence:** user/session data stored and retrieved from Supabase

---

## Architecture Overview

- **Frontend:** static HTML/CSS/JavaScript
- **Behavior monitor:** `js/behavior.js`
- **Backend:** FastAPI
- **Feature extraction:** `backend/feature_extractor.py`
- **Risk engine:** `backend/model_engine.py`
- **Session handling:** `backend/session_controller.py`
- **OTP flow:** `backend/otp_controller.py`
- **Database:** Supabase
- **Model:** IsolationForest anomaly detection

---

## Installation

### Prerequisites

- Python 3.11+
- Supabase project and service key
- Gmail account with an app password for OTP email delivery

### Backend Setup

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

Create `backend/.env` with:

```env
SUPABASE_URL=your_supabase_url
SUPABASE_ANON_KEY=your_supabase_anon_key
SUPABASE_SERVICE_KEY=your_supabase_service_key
SMTP_USER=your_gmail_address
SMTP_PASSWORD=your_gmail_app_password
```

The frontend now loads Supabase settings from `http://localhost:8000/frontend-config.js`, which is generated from these backend env vars.

### Frontend Setup

Open `index.html`, `signup.html`, or `dashboard.html` from a local web server or via your editor preview.

---

## Running the App

Start the backend API from the project root:

```powershell
uvicorn backend.main:app --reload --host 127.0.0.1 --port 8000
```

Main API routes:

- `POST /session/snapshot`
- `POST /session/end`
- `POST /verify-otp`
- `GET /health`
- `GET /status/{user_id}`

---

## Contributors

Contributions are welcome!

- Fork the repository
- Create a new branch
- Submit a pull request

---

## Notes

- `requirements.txt` is trimmed to the project-specific runtime dependencies
- `behavior.js` is the active frontend monitoring script
- Feature math happens on the server, not in the browser
