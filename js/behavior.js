/**
 * behavior.js — Cognivex Continuous Behavioral Authentication
 *
 * Responsibilities:
 *   1. Collect raw browser events (keydown/keyup, mousemove, scroll)
 *   2. Every 30 s, POST a snapshot to /session/snapshot
 *   3. Handle risk responses: LOW → continue, MEDIUM → OTP dialog,
 *      HIGH → force logout, GRACE_PERIOD → show timer in status bar
 *   4. On logout/unload, POST to /session/end (with sendBeacon fallback)
 *
 * Backend routes consumed:
 *   POST /session/snapshot  — { user_id, session_id, key_events, mouse_events, scroll_events, summary }
 *   POST /session/end       — { user_id, session_id }
 *   POST /verify-otp        — { user_id, session_id, otp_code }
 *
 * FIX 1: scroll events now use key "y" (not "scrollY") to match
 *         what feature_extractor.py reads: e.get("y")
 * FIX 2: mouse throttle tightened to 50 ms (was 200 ms) so the
 *         backend has enough data points for avg_mouse_speed /
 *         mouse_move_variance calculations
 * FIX 3: SESSION_ID no longer stored in localStorage — it is a
 *         login-scoped in-memory value; storing it in localStorage
 *         caused stale IDs to persist across logouts
 * FIX 4: snapshot is not sent when otpPending is true even on
 *         visibilitychange (previously only the timer check was guarded)
 * FIX 5: isSending guard now also prevents the timer from queuing a
 *         second concurrent flush
 */

console.log("🔐 Cognivex behavior.js loaded");

// ── Configuration ──────────────────────────────────────────────────────────
const BACKEND_URL        = "http://localhost:8000";
const SNAPSHOT_INTERVAL  = 30_000;   // 30 seconds
const MOUSE_THROTTLE_MS  = 50;       // FIX 2: was 200 ms

// ── State ──────────────────────────────────────────────────────────────────
let keyEvents    = [];
let mouseEvents  = [];
let scrollEvents = [];

let userId          = null;
let SESSION_ID      = crypto.randomUUID();   // FIX 3: in-memory only
let snapshotTimer   = null;
let isSending       = false;
let otpPending      = false;
let sessionEndSent  = false;
let snapshotsSent   = 0;
let lastMouseTime   = 0;
let monitoringActive = true;

console.log("🆔 Session ID:", SESSION_ID);


// ══════════════════════════════════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════════════════════════════════

/**
 * Wait for window.supabaseClient + window.supabaseHelper to be ready,
 * resolve the user ID, then start event collection and the 30-s timer.
 */
async function initBehaviorTracking() {
    console.log("⏳ Waiting for Supabase auth...");

    const MAX_ATTEMPTS = 50;
    let attempts = 0;

    return new Promise((resolve) => {
        const poll = setInterval(async () => {
            attempts++;

            if (window.supabaseClient && window.supabaseHelper) {
                clearInterval(poll);
                userId = await window.supabaseHelper.getUserId();

                if (userId) {
                    console.log("✅ User ID:", userId);
                    setupEventListeners();
                    startSnapshotTimer();
                    resolve(true);
                } else {
                    console.error("❌ Could not resolve user ID — monitoring disabled");
                    resolve(false);
                }

            } else if (attempts >= MAX_ATTEMPTS) {
                clearInterval(poll);
                console.error("❌ Supabase/Auth never became ready — monitoring disabled");
                resolve(false);
            }
        }, 100);
    });
}


// ══════════════════════════════════════════════════════════════════════════
// EVENT COLLECTION
// ══════════════════════════════════════════════════════════════════════════

function setupEventListeners() {
    // ── Keyboard ────────────────────────────────────────────────────────
    document.addEventListener("keydown", (e) => {
        if (!monitoringActive) return;
        keyEvents.push({ type: "keydown", key: e.key, timestamp: new Date().toISOString() });
    });

    document.addEventListener("keyup", (e) => {
        if (!monitoringActive) return;
        keyEvents.push({ type: "keyup", key: e.key, timestamp: new Date().toISOString() });
    });

    // ── Mouse ────────────────────────────────────────────────────────────
    // FIX 2: throttle at 50 ms so backend gets enough points per 30-s window
    document.addEventListener("mousemove", (e) => {
        if (!monitoringActive) return;
        const now = Date.now();
        if (now - lastMouseTime < MOUSE_THROTTLE_MS) return;
        lastMouseTime = now;
        mouseEvents.push({
            type: "MOVE",
            x:    e.clientX,
            y:    e.clientY,
            timestamp: new Date().toISOString(),
        });
    }, { passive: true });

    document.addEventListener("click", (e) => {
        if (!monitoringActive) return;
        mouseEvents.push({
            type:      "CLICK",
            x:         e.clientX,
            y:         e.clientY,
            element:   e.target.tagName,
            timestamp: new Date().toISOString(),
        });
    });

    // ── Scroll ───────────────────────────────────────────────────────────
    // FIX 1: key is "y" (not "scrollY") — feature_extractor.py reads e.get("y")
    window.addEventListener("scroll", () => {
        if (!monitoringActive) return;
        scrollEvents.push({
            type:      "SCROLL",
            y:         window.scrollY,   // FIX 1
            timestamp: new Date().toISOString(),
        });
    }, { passive: true });

    console.log("✅ Event listeners active");
}


// ══════════════════════════════════════════════════════════════════════════
// SNAPSHOT TIMER
// ══════════════════════════════════════════════════════════════════════════

function startSnapshotTimer() {
    snapshotTimer = setInterval(() => {
        // FIX 4 + FIX 5: skip if OTP in progress OR a send is already running
        if (otpPending || isSending) return;

        const total = keyEvents.length + mouseEvents.length + scrollEvents.length;
        if (total === 0) return;

        console.log(`⏱️ 30-s tick — ${total} events buffered`);
        sendSnapshot();
    }, SNAPSHOT_INTERVAL);
}


// ══════════════════════════════════════════════════════════════════════════
// SEND SNAPSHOT
// ══════════════════════════════════════════════════════════════════════════

async function sendSnapshot() {
    if (isSending || !monitoringActive) return;

    const total = keyEvents.length + mouseEvents.length + scrollEvents.length;
    if (total === 0) return;

    isSending = true;

    // Drain buffers atomically before the async fetch
    const ke = keyEvents.splice(0);
    const me = mouseEvents.splice(0);
    const se = scrollEvents.splice(0);

    try {
        // Lazy-resolve user ID in case it wasn't ready on init
        if (!userId) {
            userId = await window.supabaseHelper?.getUserId();
        }
        if (!userId) {
            // Put events back so they're included in the next window
            keyEvents.unshift(...ke);
            mouseEvents.unshift(...me);
            scrollEvents.unshift(...se);
            return;
        }

        const payload = {
            user_id:       userId,
            session_id:    SESSION_ID,
            key_events:    ke,
            mouse_events:  me,
            scroll_events: se,
            summary: {
                total_keys:    ke.length,
                total_moves:   me.filter(e => e.type === "MOVE").length,
                total_clicks:  me.filter(e => e.type === "CLICK").length,
                total_scrolls: se.filter(e => e.type === "SCROLL").length,
                total_events:  ke.length + me.length + se.length,
                timestamp:     new Date().toISOString(),
            },
        };

        console.log("📤 Sending snapshot:", payload.summary);

        const resp = await fetch(`${BACKEND_URL}/session/snapshot`, {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify(payload),
        });

        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

        const result = await resp.json();
        console.log("📥 Snapshot response:", result);
        snapshotsSent++;

        handleRiskResponse(result);

    } catch (err) {
        console.error("❌ Snapshot failed:", err.message);
        // Restore events to the front of the buffers for next window
        keyEvents.unshift(...ke);
        mouseEvents.unshift(...me);
        scrollEvents.unshift(...se);
    } finally {
        isSending = false;
    }
}


// ══════════════════════════════════════════════════════════════════════════
// RISK RESPONSE HANDLER
// ══════════════════════════════════════════════════════════════════════════

function handleRiskResponse(result) {
    const dot  = document.querySelector(".status-dot");
    const text = document.querySelector(".status-indicator span:last-child");

    switch (result.status) {
        case "OK":
        case "COLLECTING_DATA":
            _setStatus(dot, text, "#10b981", "Session Active — Behavioral Monitoring Enabled");
            break;

        case "GRACE_PERIOD":
            _setStatus(dot, text, "#3b82f6",
                `Grace Period Active — ${result.remaining_minutes} min remaining (scoring paused)`);
            console.log(
                `%c[GRACE PERIOD] ${result.remaining_minutes} min remaining — scoring paused`,
                "background:#1e3a5f;color:#60a5fa;font-weight:bold;padding:2px 6px;border-radius:3px"
            );
            break;

        case "OTP_REQUIRED":
            console.warn("⚠️ MEDIUM risk — OTP required");
            _setStatus(dot, text, "#f59e0b", "Identity Verification Required");
            showOTPDialog(result.session_id);
            break;

        case "SESSION_TERMINATED":
            console.error("🚨 HIGH risk — session terminated");
            _setStatus(dot, text, "#ef4444", "Session Terminated — Anomaly Detected");
            forceLogout("Behavioral anomaly detected. Session terminated for security.");
            break;

        default:
            console.warn("Unknown status:", result.status);
    }
}

function _setStatus(dot, text, color, message) {
    if (dot)  dot.style.background = color;
    if (text) text.textContent     = message;
}


// ══════════════════════════════════════════════════════════════════════════
// OTP DIALOG
// ══════════════════════════════════════════════════════════════════════════

function showOTPDialog(sessionId) {
    otpPending = true;

    // Create modal on first call, reuse on subsequent calls
    let modal = document.getElementById("otpModal");
    if (!modal) {
        modal = document.createElement("div");
        modal.id = "otpModal";
        modal.innerHTML = `
        <div class="otp-overlay">
            <div class="otp-dialog">
                <div class="otp-icon">🔐</div>
                <h3>Identity Verification</h3>
                <p class="otp-subtext">
                    A 6-digit verification code has been sent to your registered email address.
                </p>

                <div class="otp-input-group">
                    <input type="text" id="otpInput" maxlength="6"
                           placeholder="• • • • • •"
                           autocomplete="one-time-code"
                           inputmode="numeric"
                           pattern="[0-9]*" />
                </div>

                <button id="otpSubmitBtn" class="btn btn-primary otp-btn">Verify Identity</button>
                <p id="otpError" class="otp-error"></p>

                <div class="otp-footer">
                    <span>Code expires in </span>
                    <span id="otpCountdown" class="otp-countdown">300</span>
                    <span>s</span>
                    <div class="otp-progress-bar">
                        <div id="otpProgressFill" class="otp-progress-fill"></div>
                    </div>
                </div>
            </div>
        </div>`;
        document.body.appendChild(modal);
    }

    // Reset state every time the dialog opens
    modal.style.display = "block";
    const input     = document.getElementById("otpInput");
    const errorEl   = document.getElementById("otpError");
    const submitBtn = document.getElementById("otpSubmitBtn");
    input.value       = "";
    errorEl.textContent = "";

    // Numeric-only guard
    input.oninput = () => { input.value = input.value.replace(/\D/g, ""); };

    // Countdown timer (5 min)
    const TOTAL = 300;
    let seconds = TOTAL;
    const countdownEl   = document.getElementById("otpCountdown");
    const progressFill  = document.getElementById("otpProgressFill");
    if (countdownEl)  countdownEl.textContent = seconds;
    if (progressFill) progressFill.style.width = "100%";

    const countdown = setInterval(() => {
        seconds--;
        if (countdownEl)  countdownEl.textContent = seconds;
        if (progressFill) progressFill.style.width = `${(seconds / TOTAL) * 100}%`;
        if (seconds <= 0) {
            clearInterval(countdown);
            closeOTPDialog();
            forceLogout("OTP expired. Session terminated.");
        }
    }, 1000);

    // Submit handler
    const doSubmit = async () => {
        const code = input.value.trim();
        if (!code || code.length < 6) {
            errorEl.textContent = "Please enter the complete 6-digit code.";
            return;
        }

        submitBtn.disabled    = true;
        submitBtn.textContent = "Verifying…";
        errorEl.textContent   = "";

        try {
            const resp = await fetch(`${BACKEND_URL}/verify-otp`, {
                method:  "POST",
                headers: { "Content-Type": "application/json" },
                body:    JSON.stringify({ user_id: userId, session_id: sessionId, otp_code: code }),
            });

            const result = await resp.json();
            console.log("OTP result:", result);

            if (result.status === "OTP_VERIFIED") {
                clearInterval(countdown);
                closeOTPDialog();
                const dot  = document.querySelector(".status-dot");
                const text = document.querySelector(".status-indicator span:last-child");
                _setStatus(dot, text, "#3b82f6",
                    `Grace Period Started — ${result.grace_period_minutes} min (scoring paused)`);
            } else {
                clearInterval(countdown);
                closeOTPDialog();
                forceLogout("Verification failed. Session terminated.");
            }
        } catch (err) {
            console.error("OTP verification error:", err);
            errorEl.textContent = "Verification error. Please try again.";
        } finally {
            submitBtn.disabled    = false;
            submitBtn.textContent = "Verify Identity";
        }
    };

    submitBtn.onclick = doSubmit;
    input.onkeydown   = (e) => { if (e.key === "Enter") doSubmit(); };
}

function closeOTPDialog() {
    const modal = document.getElementById("otpModal");
    if (modal) modal.style.display = "none";
    otpPending = false;
}


// ══════════════════════════════════════════════════════════════════════════
// FORCE LOGOUT
// ══════════════════════════════════════════════════════════════════════════

function forceLogout(reason) {
    monitoringActive = false;
    if (snapshotTimer) clearInterval(snapshotTimer);

    alert(reason);

    if (window.authHandler?.logout) {
        window.authHandler.logout();
    } else {
        window.location.href = "index.html";
    }
}


// ══════════════════════════════════════════════════════════════════════════
// SESSION END  (called explicitly on logout, also on unload)
// ══════════════════════════════════════════════════════════════════════════

async function sendSessionEnd() {
    if (sessionEndSent) {
        console.log("Session-end already sent.");
        return { status: "ALREADY_SENT" };
    }
    sessionEndSent   = true;
    monitoringActive = false;
    if (snapshotTimer) clearInterval(snapshotTimer);

    // Flush any remaining buffered events first
    try {
        await sendSnapshot();
    } catch (e) {
        console.warn("Final snapshot flush failed:", e.message);
    }

    // Nothing was ever sent — no feature rows to aggregate on the backend
    if (snapshotsSent === 0) {
        console.log("No snapshots sent — skipping session-end.");
        return { status: "NO_DATA" };
    }

    if (!userId) {
        try { userId = await window.supabaseHelper?.getUserId(); } catch (_) {}
    }
    if (!userId) {
        console.error("Cannot send session-end: no user ID");
        return { status: "NO_USER" };
    }

    const body = JSON.stringify({ user_id: userId, session_id: SESSION_ID });

    try {
        const controller = new AbortController();
        const timeout    = setTimeout(() => controller.abort(), 8000);

        const resp = await fetch(`${BACKEND_URL}/session/end`, {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body,
            signal:  controller.signal,
        });
        clearTimeout(timeout);

        const result = await resp.json();
        console.log("✅ Session-end:", result);
        return result;

    } catch (err) {
        // sendBeacon fallback for page-unload races
        console.warn("Session-end fetch failed — using beacon:", err.message);
        navigator.sendBeacon(
            `${BACKEND_URL}/session/end`,
            new Blob([body], { type: "application/json" })
        );
        return { status: "BEACON_SENT" };
    }
}


// ══════════════════════════════════════════════════════════════════════════
// PAGE LIFECYCLE HOOKS
// ══════════════════════════════════════════════════════════════════════════

// Flush on tab hide — but not during OTP challenge (FIX 4)
document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && !otpPending) {
        sendSnapshot();
    }
});

// Best-effort beacon on hard close
window.addEventListener("beforeunload", () => {
    if (userId && SESSION_ID && !sessionEndSent && snapshotsSent > 0) {
        sessionEndSent = true;
        const body = JSON.stringify({ user_id: userId, session_id: SESSION_ID });
        navigator.sendBeacon(
            `${BACKEND_URL}/session/end`,
            new Blob([body], { type: "application/json" })
        );
    }
});


// ══════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ══════════════════════════════════════════════════════════════════════════

window.sendSessionEnd       = sendSessionEnd;
window.flushBehaviorData    = sendSnapshot;
window.getCurrentSessionId  = () => SESSION_ID;

// ── Bootstrap ──────────────────────────────────────────────────────────────
if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initBehaviorTracking);
} else {
    initBehaviorTracking();
}