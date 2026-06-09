// ============================
// EVENT COLLECTOR MODULE
// ============================
// Responsibility: collect raw browser events and send them to the server
// every 30 seconds as a snapshot. NO feature math here.
// All feature extraction happens server-side in feature_extractor.py.

console.log("📡 Event collector module loaded");

// ── Buffers ───────────────────────────────────────────────────────────────
let keyBuffer    = [];
let mouseBuffer  = [];
let scrollBuffer = [];

// ── Session ID ────────────────────────────────────────────────────────────
function generateSessionId() {
    return 'session_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

let currentSessionId = generateSessionId();

// ── Listeners ─────────────────────────────────────────────────────────────

document.addEventListener("keydown", (e) => {
    keyBuffer.push({
        type:      "keydown",
        key:       e.key,          // browser standard: "Backspace", "Enter", "a", etc.
        timestamp: new Date().toISOString(),
    });
});

document.addEventListener("keyup", (e) => {
    keyBuffer.push({
        type:      "keyup",
        key:       e.key,
        timestamp: new Date().toISOString(),
    });
});

// Throttle mousemove to at most 1 event per 50ms to avoid flooding
let lastMouseTime = 0;
document.addEventListener("mousemove", (e) => {
    const now = Date.now();
    if (now - lastMouseTime < 50) return;
    lastMouseTime = now;

    mouseBuffer.push({
        type:      "MOVE",
        x:         e.clientX,
        y:         e.clientY,
        timestamp: new Date().toISOString(),
    });
});

document.addEventListener("scroll", () => {
    scrollBuffer.push({
        type:      "SCROLL",
        y:         window.scrollY,
        timestamp: new Date().toISOString(),
    });
}, { passive: true });

// ── Snapshot sender ───────────────────────────────────────────────────────

async function sendSnapshot() {
    // Don't send empty snapshots
    if (keyBuffer.length === 0 && mouseBuffer.length === 0 && scrollBuffer.length === 0) {
        return;
    }

    const snapshot = {
        session_id:    currentSessionId,
        key_events:    [...keyBuffer],
        mouse_events:  [...mouseBuffer],
        scroll_events: [...scrollBuffer],
        captured_at:   new Date().toISOString(),
    };

    // Clear buffers immediately so new events go into the next window
    keyBuffer    = [];
    mouseBuffer  = [];
    scrollBuffer = [];

    try {
        const response = await fetch("/api/behavior/snapshot", {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify(snapshot),
        });

        if (!response.ok) {
            console.warn("Snapshot send failed:", response.status);
            return;
        }

        const result = await response.json();
        console.log("📤 Snapshot sent | risk:", result.risk_level);

        // Handle risk response from server
        handleRiskResponse(result);

    } catch (err) {
        console.error("Snapshot error:", err);
    }
}

// ── Risk response handler ─────────────────────────────────────────────────
// Adjust this to match your app's OTP / session termination UI logic.

function handleRiskResponse(result) {
    if (!result || !result.risk_level) return;

    if (result.risk_level === "MEDIUM" || result.status === "OTP_REQUIRED") {
        // Trigger OTP challenge in your app
        console.warn("⚠️ MEDIUM risk — OTP required");
        window.dispatchEvent(new CustomEvent("behavior:otp_required", { detail: result }));
    }

    if (result.risk_level === "HIGH" || result.status === "SESSION_TERMINATED") {
        // Force logout / session termination
        console.error("🚨 HIGH risk — session terminated");
        window.dispatchEvent(new CustomEvent("behavior:session_terminated", { detail: result }));
    }
}

// ── Session end ───────────────────────────────────────────────────────────

async function endSession() {
    // Send any remaining buffered events first
    await sendSnapshot();

    try {
        await fetch("/api/behavior/session-end", {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({ session_id: currentSessionId }),
        });
        console.log("✅ Session end sent:", currentSessionId);
    } catch (err) {
        console.error("Session end error:", err);
    }
}

// ── Reset (e.g. after login) ──────────────────────────────────────────────

function resetSession() {
    keyBuffer    = [];
    mouseBuffer  = [];
    scrollBuffer = [];
    currentSessionId = generateSessionId();
    console.log("🔄 Session reset, new ID:", currentSessionId);
}

// ── 30-second window timer ────────────────────────────────────────────────
const SNAPSHOT_INTERVAL_MS = 30_000;
setInterval(sendSnapshot, SNAPSHOT_INTERVAL_MS);

// Send session end on page unload (best-effort)
window.addEventListener("beforeunload", () => {
    endSession();
});

// ── Exports ───────────────────────────────────────────────────────────────
window.endBehaviorSession = endSession;
window.resetBehaviorSession = resetSession;
window.getCurrentSessionId = () => currentSessionId;

console.log("✅ Event collector ready | session:", currentSessionId);