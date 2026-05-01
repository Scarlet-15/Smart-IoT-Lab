// server.js
// ═══════════════════════════════════════════════════════════
//  Smart IoT Lab — Vision Verification Backend  v2
//
//  WHY THIS VERSION:
//  Roboflow serverless workflow URLs do NOT include
//  Access-Control-Allow-Origin headers, so they cannot be
//  called directly from a browser (CORS blocked).
//  All Roboflow calls now happen here on the server where
//  CORS does not apply.
//
//  Routes:
//    POST /scan            ← NEW: frontend sends recordKey,
//                            server fetches snapshot from camera,
//                            calls Roboflow, returns annotated
//                            image + counts + match result,
//                            and updates Firebase
//    POST /verify          ← legacy: frontend sends image blob
//                            (kept for compatibility)
//    GET  /health          ← liveness check
// ═══════════════════════════════════════════════════════════

require("dotenv").config();

const express = require("express");
const cors    = require("cors");
const multer  = require("multer");
const axios   = require("axios");
const admin   = require("firebase-admin");

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Allow all origins (frontend on localhost:5173, deployed URL etc.) ──
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "20mb" }));

// ── Multer for legacy /verify ──────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024 },
});

// ── Firebase Admin ────────────────────────────────────────
const serviceAccount = require("./serviceAccountKey.json");
admin.initializeApp({
  credential:  admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DATABASE_URL,
});
const db = admin.database();

// ── Config ────────────────────────────────────────────────
const ROBOFLOW_API_KEY      = process.env.ROBOFLOW_API_KEY || "6SxfEl4C7C04JBGrOpjd";
const ROBOFLOW_WORKFLOW_URL =
  "https://serverless.roboflow.com/mhanjhus-workspace/workflows/detect-count-and-visualize-4";
const CAM_BASE_URL          = process.env.CAM_BASE_URL || "http://10.168.190.91";
const CAM_STOP_URL          = `${CAM_BASE_URL}/stop_stream`;
const CAM_CAPTURE_URL       = `${CAM_BASE_URL}/capture`;

// ── Class name normaliser ─────────────────────────────────
const CLASS_MAP = {
  resistor: "resistor", Resistor: "resistor", resistance: "resistor",
  led: "led", LED: "led", diode: "led",
  capacitor: "capacitor", Capacitor: "capacitor",
};
function normalise(raw) { return CLASS_MAP[raw] || raw.toLowerCase(); }

// ── Call Roboflow workflow with base64 image ──────────────
// Returns { detected, visualizedImageUrl, raw }
async function callRoboflow(imageBuffer) {
  const base64 = imageBuffer.toString("base64");

  const response = await axios.post(
    ROBOFLOW_WORKFLOW_URL,
    {
      api_key: ROBOFLOW_API_KEY,
      inputs: { image: { type: "base64", value: base64 } },
    },
    {
      headers: { "Content-Type": "application/json" },
      timeout: 60_000,
    }
  );

  const output = response.data?.outputs?.[0] ?? response.data;

  // Annotated image
  const visualBase64 =
    output?.output_image?.value ??
    output?.visualization?.value ??
    output?.annotated_image?.value ??
    null;
  const visualizedImageUrl = visualBase64
    ? `data:image/jpeg;base64,${visualBase64}`
    : null;

  // Detection counts
  const rawCounts =
    output?.count ?? output?.counts ?? output?.class_counts ?? null;
  const rawPreds =
    output?.predictions?.predictions ?? output?.predictions ?? [];

  const detected = {};
  if (rawCounts && typeof rawCounts === "object") {
    for (const [raw, qty] of Object.entries(rawCounts)) {
      const k = normalise(raw);
      detected[k] = (detected[k] || 0) + Number(qty);
    }
  } else if (Array.isArray(rawPreds) && rawPreds.length > 0) {
    for (const p of rawPreds) {
      const k = normalise(p.class ?? p.class_name ?? "unknown");
      detected[k] = (detected[k] || 0) + 1;
    }
  }

  return { detected, visualizedImageUrl, raw: response.data };
}

// ── Compare detected vs expected ─────────────────────────
function buildMismatches(expected, detected) {
  const mismatches = [];
  for (const [k, expQty] of Object.entries(expected)) {
    const detQty = detected[k] || 0;
    if (detQty !== expQty) mismatches.push({ component: k, expected: expQty, detected: detQty });
  }
  for (const [k, detQty] of Object.entries(detected)) {
    if (!(k in expected) && detQty > 0)
      mismatches.push({ component: k, expected: 0, detected: detQty });
  }
  return mismatches;
}

// ════════════════════════════════════════════════════════════
//  POST /scan   ← PRIMARY endpoint (replaces frontend Roboflow call)
//
//  Body (JSON): { recordKey: "..." }
//
//  Flow:
//  1. Fetch return_record from Firebase (get expected items)
//  2. Call /stop_stream on camera
//  3. Fetch /capture from camera (with retries)
//  4. Send image to Roboflow workflow (server-side — no CORS)
//  5. Compare result vs expected
//  6. Update Firebase status ("verified" or "mismatch")
//  7. Return full result including annotated image to frontend
// ════════════════════════════════════════════════════════════
app.post("/scan", async (req, res) => {
  const { recordKey } = req.body;
  if (!recordKey) {
    return res.status(400).json({ success: false, error: "recordKey is required" });
  }

  console.log(`\n[/scan] recordKey: ${recordKey}`);

  try {
    // ── 1. Get expected items from Firebase ───────────────
    const snap = await db.ref(`return_records/${recordKey}`).get();
    if (!snap.exists()) {
      return res.status(404).json({ success: false, error: "Return record not found" });
    }
    const record   = snap.val();
    const expected = record.items || {};
    console.log("[/scan] Expected:", expected);

    // ── 2. Stop the camera stream ─────────────────────────
    console.log("[/scan] Stopping camera stream…");
    try {
      await axios.get(CAM_STOP_URL, { timeout: 5_000 });
      await new Promise(r => setTimeout(r, 300)); // buffer flush
    } catch (e) {
      console.warn("[/scan] stop_stream failed (non-fatal):", e.message);
    }

    // ── 3. Capture snapshot from camera (with 3 retries) ──
    console.log("[/scan] Capturing snapshot…");
    let imageBuffer = null;
    let lastCamErr  = null;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const camRes = await axios.get(
          `${CAM_CAPTURE_URL}?t=${Date.now()}`,
          { responseType: "arraybuffer", timeout: 15_000 }
        );
        imageBuffer = Buffer.from(camRes.data);
        console.log(`[/scan] Snapshot captured: ${imageBuffer.length} bytes (attempt ${attempt})`);
        break;
      } catch (e) {
        lastCamErr = e.message;
        console.warn(`[/scan] Capture attempt ${attempt} failed: ${e.message}`);
        if (attempt < 3) await new Promise(r => setTimeout(r, 800));
      }
    }

    if (!imageBuffer) {
      return res.status(502).json({
        success: false,
        error: `Camera capture failed after 3 attempts: ${lastCamErr}`,
      });
    }

    // ── 4. Call Roboflow ──────────────────────────────────
    console.log("[/scan] Calling Roboflow…");
    const { detected, visualizedImageUrl } = await callRoboflow(imageBuffer);
    console.log("[/scan] Detected:", detected);

    // ── 5. Compare ────────────────────────────────────────
    const mismatches = buildMismatches(expected, detected);
    const match      = mismatches.length === 0;

    // ── 6. Update Firebase ────────────────────────────────
    await db.ref(`return_records/${recordKey}`).update({
      status:            match ? "verified" : "mismatch",
      detected,
      mismatches:        match ? [] : mismatches,
      verifiedAt:        Date.now(),
    });

    console.log(`[/scan] Result: ${match ? "MATCH ✓" : "MISMATCH ✗"}`);

    // ── 7. Return to frontend ─────────────────────────────
    return res.json({
      success:           true,
      match,
      expected,
      detected,
      mismatches,
      visualizedImageUrl, // annotated image as base64 data-URL
      message:           match
        ? "Components verified — box will open"
        : "Component count mismatch",
    });

  } catch (err) {
    console.error("[/scan] Error:", err.message);
    try {
      await db.ref(`return_records/${recordKey}`).update({
        status:      "verify_error",
        verifyError: err.message,
      });
    } catch (_) {}
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ════════════════════════════════════════════════════════════
//  POST /verify  (legacy — frontend sends image blob)
//  Kept for compatibility. Internally calls same Roboflow logic.
// ════════════════════════════════════════════════════════════
app.post("/verify", upload.single("image"), async (req, res) => {
  console.log("\n[/verify] Request received");

  if (!req.file) return res.status(400).json({ success: false, error: "No image uploaded" });
  const { recordKey } = req.body;
  if (!recordKey) return res.status(400).json({ success: false, error: "recordKey is required" });

  try {
    const snap = await db.ref(`return_records/${recordKey}`).get();
    if (!snap.exists()) return res.status(404).json({ success: false, error: "Record not found" });

    const expected = snap.val().items || {};
    console.log("[/verify] Expected:", expected);

    console.log("[/verify] Calling Roboflow…");
    const { detected, visualizedImageUrl } = await callRoboflow(req.file.buffer);
    console.log("[/verify] Detected:", detected);

    const mismatches = buildMismatches(expected, detected);
    const match      = mismatches.length === 0;

    await db.ref(`return_records/${recordKey}`).update({
      status:     match ? "verified" : "mismatch",
      detected,
      mismatches: match ? [] : mismatches,
      verifiedAt: Date.now(),
    });

    return res.json({ success: true, match, expected, detected, mismatches, visualizedImageUrl });

  } catch (err) {
    console.error("[/verify] Error:", err.message);
    try {
      await db.ref(`return_records/${recordKey}`).update({ status: "verify_error", verifyError: err.message });
    } catch (_) {}
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /health ───────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("═══════════════════════════════════════");
  console.log("  IoT Lab Vision Backend  v2");
  console.log(`  http://localhost:${PORT}`);
  console.log(`  Camera: ${CAM_BASE_URL}`);
  console.log("═══════════════════════════════════════");
});
