// src/pages/ReturnPage.jsx  v6
// KEY CHANGE: Roboflow is no longer called from the browser.
// The frontend sends { recordKey } to POST /scan on the backend.
// The backend stops the stream, captures, calls Roboflow,
// and returns the annotated image + match result in one response.
// This eliminates the CORS error entirely.
import { useState, useEffect, useRef, useCallback } from "react";
import { db } from "../firebase/config";
import { ref, set, remove, onValue, off, serverTimestamp } from "firebase/database";

const BACKEND_URL = "http://10.168.190.31:3001";
const CAM_BASE_URL = "http://10.168.190.91";
const CAM_STREAM_URL = `${CAM_BASE_URL}/stream`;

// Timeouts
const SCAN_TIMEOUT_MS = 90_000; // 90s total for stop+capture+roboflow

// Fetch with AbortController timeout
async function fetchWithTimeout(url, options = {}, timeoutMs = 30_000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, { ...options, signal: controller.signal });
        clearTimeout(timer);
        return res;
    } catch (err) {
        clearTimeout(timer);
        if (err.name === "AbortError") {
            throw new Error(`TIMEOUT: No response from ${new URL(url).pathname} after ${timeoutMs / 1000}s`);
        }
        throw err;
    }
}

// Class normaliser (mirrors server-side CLASS_MAP)
const CLASS_MAP = {
    resistor: "resistor", resistance: "resistor", Resistor: "resistor",
    led: "led", LED: "led", diode: "led",
    capacitor: "capacitor", Capacitor: "capacitor",
};
function normaliseClass(raw) { return CLASS_MAP[raw] || raw.toLowerCase(); }

export default function ReturnPage({ user, borrowList, onLogout, onBack }) {
    const [returnQtys, setReturnQtys] = useState({});
    const [errorMsg, setErrorMsg] = useState("");
    const [showConfirm, setShowConfirm] = useState(false);
    const [submitting, setSubmitting] = useState(false);

    // null → "place_in_tray" → "scanning" → "scan_result"
    //      → "waiting_open" → "box_open" → "closing" → "done"
    const [step, setStep] = useState(null);
    const [returnedItems, setReturnedItems] = useState([]);
    const [scanResult, setScanResult] = useState(null);
    const [timedOut, setTimedOut] = useState(null);

    const [camError, setCamError] = useState(false);
    const [streamReady, setStreamReady] = useState(false);
    const streamImgRef = useRef(null);
    const recordKeyRef = useRef(null);
    const refreshTimerRef = useRef(null);

    const borrowEntries = Object.entries(borrowList);

    // ── Firebase listener for ESP32 box status ────────────
    useEffect(() => {
        if (!recordKeyRef.current) return;
        if (!["waiting_open", "box_open", "closing"].includes(step)) return;
        const recRef = ref(db, `return_records/${recordKeyRef.current}`);
        onValue(recRef, snap => {
            const data = snap.val();
            if (!data) return;
            if (data.status === "box_open") setStep("box_open");
            if (data.status === "closed") setStep("done");
        });
        return () => off(recRef);
    }, [step]);

    // ── Snapshot polling fallback (when MJPEG blocked) ────
    const startPollingFallback = useCallback(() => {
        if (refreshTimerRef.current) return;
        refreshTimerRef.current = setInterval(async () => {
            try {
                const res = await fetch(`${CAM_BASE_URL}/capture?t=${Date.now()}`);
                if (!res.ok) return;
                const blob = await res.blob();
                const url = URL.createObjectURL(blob);
                if (streamImgRef.current) {
                    const old = streamImgRef.current.src;
                    streamImgRef.current.src = url;
                    if (old.startsWith("blob:")) URL.revokeObjectURL(old);
                }
            } catch (_) { }
        }, 800);
    }, []);

    const stopPollingFallback = useCallback(() => {
        if (refreshTimerRef.current) {
            clearInterval(refreshTimerRef.current);
            refreshTimerRef.current = null;
        }
    }, []);

    useEffect(() => () => stopPollingFallback(), [stopPollingFallback]);

    useEffect(() => {
        if (step === "place_in_tray") {
            setCamError(false);
            setStreamReady(false);
            stopPollingFallback();
        }
        if (step !== "place_in_tray") stopPollingFallback();
    }, [step, stopPollingFallback]);

    const handleQtyChange = (key, value) => {
        setErrorMsg("");
        const parsed = parseInt(value, 10);
        setReturnQtys(prev => ({ ...prev, [key]: isNaN(parsed) || parsed < 0 ? "" : parsed }));
    };

    const items = borrowEntries
        .filter(([k]) => returnQtys[k] && parseInt(returnQtys[k]) > 0)
        .map(([k]) => ({ key: k, qty: parseInt(returnQtys[k]) }));

    const handleReturnClick = () => {
        setErrorMsg("");
        if (items.length === 0) { setErrorMsg("Please select at least one component to return."); return; }
        for (const { key, qty } of items) {
            const owned = borrowList[key] ?? 0;
            if (qty > owned) { setErrorMsg(`You only borrowed ${owned} "${key}", cannot return ${qty}.`); return; }
        }
        setShowConfirm(true);
    };

    const handleConfirmReturn = async () => {
        setSubmitting(true);
        const itemsObj = {};
        items.forEach(({ key, qty }) => { itemsObj[key] = qty; });
        const recKey = `${user.uid}_${Date.now()}`;
        recordKeyRef.current = recKey;
        setReturnedItems(items);
        try {
            await set(ref(db, `return_records/${recKey}`), {
                user: user.uid, userName: user.name,
                items: itemsObj, status: "awaiting_scan",
                timestamp: serverTimestamp(),
            });
            setSubmitting(false);
            setShowConfirm(false);
            setStep("place_in_tray");
        } catch (err) {
            setSubmitting(false);
            setErrorMsg("Failed to submit. Check Firebase connection.");
        }
    };

    // ════════════════════════════════════════════════════════
    //  SCAN — sends recordKey to backend POST /scan
    //  Backend does: stop_stream → capture → Roboflow → Firebase
    //  Frontend receives: { match, detected, expected,
    //                       mismatches, visualizedImageUrl }
    //  No Roboflow call in browser → no CORS error
    // ════════════════════════════════════════════════════════
    const handleCaptureAndScan = async () => {
        setStep("scanning");
        setScanResult(null);
        setTimedOut(null);

        let response;
        try {
            response = await fetchWithTimeout(
                `${BACKEND_URL}/scan`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ recordKey: recordKeyRef.current }),
                },
                SCAN_TIMEOUT_MS
            );
        } catch (err) {
            // Network or timeout error reaching backend
            const isTimeout = err.message.startsWith("TIMEOUT");
            setTimedOut({
                phase: isTimeout ? "backend_timeout" : "backend_unreachable",
                message: isTimeout
                    ? "The scan took too long to complete."
                    : `Could not reach backend: ${err.message}`,
                retryFn: () => { setTimedOut(null); handleCaptureAndScan(); },
            });
            setStep("place_in_tray");
            return;
        }

        let result;
        try {
            result = await response.json();
        } catch (_) {
            setScanResult({ error: `Backend returned non-JSON (HTTP ${response.status})` });
            setStep("scan_result");
            return;
        }

        if (!response.ok || !result.success) {
            // Backend returned an error (camera failed, Roboflow failed, etc.)
            const errMsg = result.error || `Server error (${response.status})`;
            const isCamera = errMsg.toLowerCase().includes("camera");
            setTimedOut({
                phase: "scan_error",
                message: errMsg,
                retryFn: () => { setTimedOut(null); handleCaptureAndScan(); },
            });
            setStep("place_in_tray");
            return;
        }

        // Normalise class names in detected map (server already does this,
        // but be defensive in case server version differs)
        const detected = {};
        for (const [raw, qty] of Object.entries(result.detected || {})) {
            const k = normaliseClass(raw);
            detected[k] = (detected[k] || 0) + qty;
        }

        setScanResult({
            match: result.match,
            detected,
            expected: result.expected,
            mismatches: result.mismatches || [],
            visualizedImageUrl: result.visualizedImageUrl || null,
        });
        setStep("scan_result");
    };

    const handleRetry = () => {
        setScanResult(null);
        setTimedOut(null);
        setStep("place_in_tray");
    };

    const handleChangeRequest = async () => {
        try { await remove(ref(db, `return_records/${recordKeyRef.current}`)); } catch (_) { }
        recordKeyRef.current = null;
        setScanResult(null);
        setTimedOut(null);
        setReturnQtys({});
        setStep(null);
    };

    const handlePlaced = async () => {
        setStep("closing");
        try {
            for (const { key, qty } of returnedItems) {
                const newQty = (borrowList[key] ?? 0) - qty;
                if (newQty <= 0) {
                    await remove(ref(db, `borrow_list/${user.uid}/${key}`));
                } else {
                    await set(ref(db, `borrow_list/${user.uid}/${key}`), newQty);
                }
            }
            await set(ref(db, `return_records/${recordKeyRef.current}/status`), "user_placed");
        } catch (err) {
            console.error(err);
            setStep("done");
        }
    };

    const handleDone = async () => {
        try { await remove(ref(db, `return_records/${recordKeyRef.current}`)); } catch (_) { }
        onLogout();
    };

    if (borrowEntries.length === 0) {
        return (
            <div className="borrow-page"><div className="borrow-container">
                <div className="empty-state">
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="1.5">
                        <polyline points="1 4 1 10 7 10" /><path d="M3.51 15a9 9 0 1 0 .49-3.5" />
                    </svg>
                    <p>You have no components currently borrowed.</p>
                    <button className="modal-btn-cancel" style={{ marginTop: "1rem", padding: "0.6rem 1.5rem" }} onClick={onBack}>← Back</button>
                </div>
            </div></div>
        );
    }

    return (
        <>
            {/* ══ TIMEOUT / ERROR RETRY MODAL ═════════════════════ */}
            {timedOut && (
                <div className="modal-overlay">
                    <div className="modal-card">
                        <div className="modal-header">
                            <div className="modal-icon" style={{ background: "rgba(248,113,113,0.1)", borderColor: "rgba(248,113,113,0.3)", color: "var(--red)" }}>
                                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
                                </svg>
                            </div>
                            <h3 className="modal-title" style={{ color: "var(--red)" }}>
                                {timedOut.phase === "backend_timeout" ? "Scan Timed Out" : "Scan Failed"}
                            </h3>
                            <p className="modal-sub">
                                {timedOut.message}<br />
                                <span style={{ color: "var(--text-muted)", fontSize: "0.78rem" }}>
                                    Make sure the camera and backend server are running.
                                </span>
                            </p>
                        </div>
                        <div className="modal-actions" style={{ flexDirection: "column", gap: "0.6rem" }}>
                            <button className="modal-btn-confirm scan-btn" onClick={timedOut.retryFn}>
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <polyline points="1 4 1 10 7 10" /><path d="M3.51 15a9 9 0 102.13-9.36L1 10" />
                                </svg>
                                Retry Scan
                            </button>
                            <button className="modal-btn-cancel" style={{ color: "var(--amber)", borderColor: "rgba(251,191,36,0.3)" }} onClick={handleChangeRequest}>
                                Cancel Return
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* ══ PLACE IN TRAY — live feed ════════════════════════ */}
            {step === "place_in_tray" && (
                <div className="modal-overlay">
                    <div className="modal-card" style={{ maxWidth: "520px", width: "96vw" }}>
                        <div className="modal-header" style={{ paddingBottom: "0.75rem" }}>
                            <div className="modal-icon" style={{ background: "rgba(56,189,248,0.1)", borderColor: "rgba(56,189,248,0.3)", color: "var(--cyan)" }}>
                                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z" />
                                    <circle cx="12" cy="13" r="4" />
                                </svg>
                            </div>
                            <h3 className="modal-title">Place Components in Tray</h3>
                            <p className="modal-sub">Watch the live feed to position components, then press <strong>Capture &amp; Scan</strong>.</p>
                        </div>

                        <div className="modal-items" style={{ paddingBottom: "0.5rem" }}>
                            <p className="modal-items-label">Components to place:</p>
                            <ul className="modal-item-list">
                                {returnedItems.map(({ key, qty }) => (
                                    <li key={key} className="modal-item-row">
                                        <span className="modal-item-name">
                                            <span className="comp-dot" style={{ background: "var(--amber)" }} />
                                            {key.charAt(0).toUpperCase() + key.slice(1)}
                                        </span>
                                        <span className="modal-item-qty" style={{ color: "var(--amber)", background: "rgba(251,191,36,0.08)", borderColor: "rgba(251,191,36,0.2)" }}>× {qty}</span>
                                    </li>
                                ))}
                            </ul>
                        </div>

                        {/* Live camera feed */}
                        <div style={{ position: "relative", width: "100%", aspectRatio: "4/3", background: "rgba(0,0,0,0.4)", borderRadius: "10px", overflow: "hidden", border: "1px solid rgba(56,189,248,0.25)", marginBottom: "1rem" }}>
                            {!camError && (
                                <img ref={streamImgRef} src={CAM_STREAM_URL} alt="Live camera feed"
                                    style={{ width: "100%", height: "100%", objectFit: "cover", display: streamReady ? "block" : "none" }}
                                    onLoad={() => setStreamReady(true)}
                                    onError={() => {
                                        setCamError(true);
                                        if (streamImgRef.current) streamImgRef.current.src = `${CAM_BASE_URL}/capture?t=${Date.now()}`;
                                        startPollingFallback();
                                        setStreamReady(true);
                                    }}
                                />
                            )}
                            {camError && (
                                <img ref={streamImgRef} src={`${CAM_BASE_URL}/capture?t=${Date.now()}`} alt="Camera snapshot"
                                    style={{ width: "100%", height: "100%", objectFit: "cover" }}
                                    onLoad={() => setStreamReady(true)} onError={() => setStreamReady(false)} />
                            )}
                            {!streamReady && (
                                <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "0.6rem", color: "var(--text-muted)" }}>
                                    <div className="dispense-ring" style={{ borderColor: "rgba(56,189,248,0.4)", width: 40, height: 40, borderWidth: 2 }} />
                                    <span style={{ fontSize: "0.78rem" }}>Connecting to camera…</span>
                                </div>
                            )}
                            {streamReady && (
                                <div style={{ position: "absolute", top: 8, left: 8, background: "rgba(239,68,68,0.85)", color: "#fff", fontSize: "0.65rem", fontWeight: 700, padding: "2px 7px", borderRadius: "4px", letterSpacing: "0.08em", display: "flex", alignItems: "center", gap: "5px" }}>
                                    <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#fff", animation: "livePulse 1.2s ease-in-out infinite", display: "inline-block" }} />
                                    {camError ? "SNAPSHOT" : "LIVE"}
                                </div>
                            )}
                            <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }} viewBox="0 0 100 75" preserveAspectRatio="none">
                                <path d="M5 18 L5 5 L18 5" fill="none" stroke="rgba(56,189,248,0.6)" strokeWidth="0.8" />
                                <path d="M82 5 L95 5 L95 18" fill="none" stroke="rgba(56,189,248,0.6)" strokeWidth="0.8" />
                                <path d="M5 57 L5 70 L18 70" fill="none" stroke="rgba(56,189,248,0.6)" strokeWidth="0.8" />
                                <path d="M82 70 L95 70 L95 57" fill="none" stroke="rgba(56,189,248,0.6)" strokeWidth="0.8" />
                            </svg>
                        </div>

                        <div className="tray-hint" style={{ marginBottom: "0.75rem" }}>
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
                            </svg>
                            Spread components flat. Avoid overlapping for best detection.
                        </div>

                        <div className="modal-actions" style={{ flexDirection: "column", gap: "0.6rem" }}>
                            <button className="modal-btn-confirm scan-btn" onClick={handleCaptureAndScan}>
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z" />
                                    <circle cx="12" cy="13" r="4" />
                                </svg>
                                Capture &amp; Scan Components
                            </button>
                            <button className="modal-btn-cancel" onClick={handleChangeRequest}>Cancel Return</button>
                        </div>
                    </div>
                </div>
            )}

            {/* ══ SCANNING ════════════════════════════════════════ */}
            {step === "scanning" && (
                <div className="modal-overlay">
                    <div className="modal-card dispense-card">
                        <div className="dispense-anim-wrap">
                            <div className="dispense-ring" style={{ borderColor: "rgba(56,189,248,0.4)" }} />
                            <div className="dispense-ring ring2" style={{ borderColor: "rgba(56,189,248,0.15)" }} />
                            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="var(--cyan)" strokeWidth="1.8">
                                <path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z" />
                                <circle cx="12" cy="13" r="4" />
                            </svg>
                        </div>
                        <p className="dispense-title">Analysing Components…</p>
                        <p className="dispense-sub">Stopping stream → capturing → running AI detection</p>
                        <div className="idle-dots" style={{ marginTop: "1rem" }}><span /><span /><span /></div>
                    </div>
                </div>
            )}

            {/* ══ SCAN RESULT ═════════════════════════════════════ */}
            {step === "scan_result" && (
                <div className="modal-overlay">
                    <div className="modal-card" style={{ maxWidth: "540px", width: "96vw" }}>
                        {scanResult?.error ? (
                            <>
                                <div className="modal-header">
                                    <div className="modal-icon" style={{ background: "rgba(248,113,113,0.1)", borderColor: "rgba(248,113,113,0.3)", color: "var(--red)" }}>
                                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>
                                    </div>
                                    <h3 className="modal-title" style={{ color: "var(--red)" }}>Scan Failed</h3>
                                    <p className="modal-sub">{scanResult.error}</p>
                                </div>
                                <div className="modal-actions" style={{ flexDirection: "column", gap: "0.6rem" }}>
                                    <button className="modal-btn-confirm scan-btn" onClick={handleRetry}>Try Again</button>
                                    <button className="modal-btn-cancel" onClick={handleChangeRequest}>Cancel Return</button>
                                </div>
                            </>
                        ) : (
                            <>
                                <div className="modal-header" style={{ paddingBottom: "0.6rem" }}>
                                    <div className="modal-icon" style={{ background: scanResult?.match ? "rgba(74,222,128,0.1)" : "rgba(248,113,113,0.1)", borderColor: scanResult?.match ? "rgba(74,222,128,0.3)" : "rgba(248,113,113,0.3)", color: scanResult?.match ? "var(--green)" : "var(--red)" }}>
                                        {scanResult?.match
                                            ? <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12" /></svg>
                                            : <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>}
                                    </div>
                                    <h3 className="modal-title" style={{ color: scanResult?.match ? "var(--green)" : "var(--red)" }}>
                                        {scanResult?.match ? "Components Verified ✓" : "Component Mismatch"}
                                    </h3>
                                    <p className="modal-sub">
                                        {scanResult?.match
                                            ? "All components detected correctly. The box will open shortly."
                                            : "The camera detected a different count than your request."}
                                    </p>
                                </div>

                                {scanResult?.visualizedImageUrl && (
                                    <div style={{ width: "100%", aspectRatio: "4/3", borderRadius: "10px", overflow: "hidden", border: `1px solid ${scanResult.match ? "rgba(74,222,128,0.3)" : "rgba(248,113,113,0.3)"}`, marginBottom: "0.9rem", background: "#000" }}>
                                        <img src={scanResult.visualizedImageUrl} alt="Detection result" style={{ width: "100%", height: "100%", objectFit: "contain" }} />
                                    </div>
                                )}

                                <div className="modal-items">
                                    <p className="modal-items-label">Detection results:</p>
                                    <ul className="modal-item-list">
                                        {Object.entries(scanResult?.expected || {}).map(([k, expQty]) => {
                                            const detQty = scanResult?.detected?.[k] || 0;
                                            const ok = detQty === expQty;
                                            return (
                                                <li key={k} className="modal-item-row">
                                                    <span className="modal-item-name">
                                                        <span className="comp-dot" style={{ background: ok ? "var(--green)" : "var(--red)" }} />
                                                        {k.charAt(0).toUpperCase() + k.slice(1)}
                                                    </span>
                                                    <span style={{ display: "flex", gap: "0.75rem", fontSize: "0.82rem" }}>
                                                        <span style={{ color: "var(--text-muted)" }}>Expected: <b style={{ color: "var(--text)" }}>{expQty}</b></span>
                                                        <span style={{ color: "var(--text-muted)" }}>Found: <b style={{ color: ok ? "var(--green)" : "var(--red)" }}>{detQty}</b></span>
                                                    </span>
                                                </li>
                                            );
                                        })}
                                    </ul>
                                </div>

                                <div className="modal-actions" style={{ flexDirection: "column", gap: "0.6rem" }}>
                                    {scanResult?.match ? (
                                        <button className="modal-btn-confirm" style={{ width: "100%", background: "linear-gradient(135deg,#16a34a,#15803d)" }} onClick={() => setStep("waiting_open")}>
                                            Continue — Open Box
                                        </button>
                                    ) : (
                                        <>
                                            <button className="modal-btn-confirm scan-btn" onClick={handleRetry}>
                                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="1 4 1 10 7 10" /><path d="M3.51 15a9 9 0 102.13-9.36L1 10" /></svg>
                                                Fix Tray &amp; Scan Again
                                            </button>
                                            <button className="modal-btn-cancel" style={{ color: "var(--amber)", borderColor: "rgba(251,191,36,0.3)" }} onClick={handleChangeRequest}>
                                                Change Return Quantity
                                            </button>
                                        </>
                                    )}
                                </div>
                            </>
                        )}
                    </div>
                </div>
            )}

            {/* ══ WAITING FOR BOX ═════════════════════════════════ */}
            {step === "waiting_open" && (
                <div className="modal-overlay">
                    <div className="modal-card dispense-card">
                        <div className="dispense-anim-wrap">
                            <div className="dispense-ring" style={{ borderColor: "rgba(74,222,128,0.4)" }} />
                            <div className="dispense-ring ring2" style={{ borderColor: "rgba(74,222,128,0.2)" }} />
                            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="var(--green)" strokeWidth="1.8"><polyline points="20 6 9 17 4 12" /></svg>
                        </div>
                        <p className="dispense-title" style={{ color: "var(--green)" }}>Verified! Opening Box…</p>
                        <p className="dispense-sub">Components matched. Box is opening.</p>
                    </div>
                </div>
            )}

            {/* ══ BOX OPEN ════════════════════════════════════════ */}
            {step === "box_open" && (
                <div className="modal-overlay">
                    <div className="modal-card">
                        <div className="modal-header">
                            <div className="modal-icon" style={{ background: "rgba(251,191,36,0.1)", borderColor: "rgba(251,191,36,0.3)", color: "var(--amber)" }}>
                                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>
                            </div>
                            <h3 className="modal-title">Box is Open!</h3>
                            <p className="modal-sub">Place your components inside the box, then press the button.</p>
                        </div>
                        <div className="modal-items">
                            <p className="modal-items-label">Return the following:</p>
                            <ul className="modal-item-list">
                                {returnedItems.map(({ key, qty }) => (
                                    <li key={key} className="modal-item-row">
                                        <span className="modal-item-name"><span className="comp-dot" style={{ background: "var(--amber)" }} />{key.charAt(0).toUpperCase() + key.slice(1)}</span>
                                        <span className="modal-item-qty" style={{ color: "var(--amber)", background: "rgba(251,191,36,0.08)", borderColor: "rgba(251,191,36,0.2)" }}>× {qty}</span>
                                    </li>
                                ))}
                            </ul>
                        </div>
                        <div className="modal-actions">
                            <button className="modal-btn-confirm" style={{ flex: "1 1 100%", background: "linear-gradient(135deg,#d97706,#92400e)" }} onClick={handlePlaced}>
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12" /></svg>
                                Component Placed — Close Box
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* ══ CLOSING ════════════════════════════════════════ */}
            {step === "closing" && (
                <div className="modal-overlay">
                    <div className="modal-card dispense-card">
                        <div className="dispense-anim-wrap">
                            <div className="dispense-ring" style={{ borderColor: "rgba(74,222,128,0.4)" }} />
                            <div className="dispense-ring ring2" style={{ borderColor: "rgba(74,222,128,0.2)" }} />
                            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="var(--green)" strokeWidth="1.8"><rect x="2" y="7" width="20" height="14" rx="2" /><path d="M16 21V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v16" /></svg>
                        </div>
                        <p className="dispense-title" style={{ color: "var(--green)" }}>Closing Box…</p>
                        <p className="dispense-sub">Please wait while the box closes securely.</p>
                    </div>
                </div>
            )}

            {/* ══ DONE ════════════════════════════════════════════ */}
            {step === "done" && (
                <div className="modal-overlay">
                    <div className="modal-card">
                        <div className="modal-success">
                            <div className="modal-success-icon">
                                <svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12" /></svg>
                            </div>
                            <p className="modal-success-title">Return Complete!</p>
                            <p className="modal-success-sub" style={{ marginBottom: "1.5rem" }}>The box has been closed. Thank you!</p>
                            <button className="modal-btn-confirm" style={{ width: "100%", padding: "0.85rem" }} onClick={handleDone}>Done — Log Out</button>
                        </div>
                    </div>
                </div>
            )}

            {/* ══ CONFIRM RETURN MODAL ════════════════════════════ */}
            {showConfirm && (
                <div className="modal-overlay" onClick={!submitting ? () => setShowConfirm(false) : undefined}>
                    <div className="modal-card" onClick={e => e.stopPropagation()}>
                        <div className="modal-header">
                            <div className="modal-icon" style={{ background: "rgba(251,191,36,0.1)", borderColor: "rgba(251,191,36,0.3)", color: "var(--amber)" }}>
                                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="1 4 1 10 7 10" /><path d="M3.51 15a9 9 0 1 0 .49-3.5" /></svg>
                            </div>
                            <h3 className="modal-title">Confirm Return</h3>
                            <p className="modal-sub">The camera will verify your components before the box opens.</p>
                        </div>
                        <div className="modal-items">
                            <p className="modal-items-label">Items to return:</p>
                            <ul className="modal-item-list">
                                {items.map(({ key, qty }) => (
                                    <li key={key} className="modal-item-row">
                                        <span className="modal-item-name"><span className="comp-dot" style={{ background: "var(--amber)" }} />{key.charAt(0).toUpperCase() + key.slice(1)}</span>
                                        <span className="modal-item-qty" style={{ color: "var(--amber)", background: "rgba(251,191,36,0.08)", borderColor: "rgba(251,191,36,0.2)" }}>× {qty}</span>
                                    </li>
                                ))}
                            </ul>
                            <div className="modal-user-line">Returning as <strong>{user.name}</strong></div>
                        </div>
                        <div className="modal-actions">
                            <button className="modal-btn-cancel" onClick={() => setShowConfirm(false)} disabled={submitting}>Cancel</button>
                            <button className="modal-btn-confirm" style={{ background: "linear-gradient(135deg,#d97706,#92400e)" }} onClick={handleConfirmReturn} disabled={submitting}>
                                {submitting ? <span className="btn-loading"><span className="spinner" /> Submitting…</span>
                                    : <><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12" /></svg> Yes, Return</>}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* ══ MAIN RETURN PAGE ════════════════════════════════ */}
            <div className="borrow-page">
                <div className="borrow-container">
                    <div className="borrow-header" style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap" }}>
                        <div>
                            <h2 className="borrow-title" style={{ color: "var(--amber)" }}>Return Components</h2>
                            <p className="borrow-sub">Select how many of each component you are returning. The camera will verify before opening the box.</p>
                        </div>
                        <button className="modal-btn-cancel" style={{ padding: "0.5rem 1.1rem", fontSize: "0.82rem" }} onClick={onBack}>← Back</button>
                    </div>
                    <div className="table-wrapper">
                        <table className="comp-table">
                            <thead><tr><th>Component</th><th>You Have</th><th>Quantity to Return</th></tr></thead>
                            <tbody>
                                {borrowEntries.map(([key, owned]) => {
                                    const ret = parseInt(returnQtys[key]) || 0;
                                    const over = ret > owned;
                                    return (
                                        <tr key={key} className={over ? "row-error" : ""}>
                                            <td className="comp-name"><span className="comp-dot" style={{ background: "var(--amber)" }} />{key.charAt(0).toUpperCase() + key.slice(1)}</td>
                                            <td><span className="stock-badge" style={{ color: "var(--amber)", background: "rgba(251,191,36,0.1)", borderColor: "rgba(251,191,36,0.2)" }}>{owned}</span></td>
                                            <td>
                                                <input type="number" min="0" max={owned} value={returnQtys[key] || ""} onChange={e => handleQtyChange(key, e.target.value)} placeholder="0" className={`qty-input ${over ? "qty-error" : ""}`} />
                                                {over && <span className="qty-warn">Exceeds borrowed amount</span>}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                    {errorMsg && (
                        <div className="alert alert-error">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>
                            {errorMsg}
                        </div>
                    )}
                    <button onClick={handleReturnClick} className="submit-btn" style={{ background: "linear-gradient(135deg,#d97706,#92400e)", boxShadow: "0 4px 20px rgba(251,191,36,0.2)" }}>
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="1 4 1 10 7 10" /><path d="M3.51 15a9 9 0 1 0 .49-3.5" /></svg>
                        Submit Return Request
                    </button>
                </div>
            </div>

            <style>{`
                @keyframes livePulse {
                    0%, 100% { opacity: 1; transform: scale(1); }
                    50%       { opacity: 0.4; transform: scale(0.75); }
                }
            `}</style>
        </>
    );
}
