// src/pages/BorrowPage.jsx
import { useState, useEffect, useRef } from "react";
import { db } from "../firebase/config";
import { ref, set, onValue, off, serverTimestamp } from "firebase/database";

const LAB_COMPONENTS = ["led", "resistor"];

export default function BorrowPage({ user, components, borrowList, onLogout }) {
  const [quantities, setQuantities] = useState({});
  const [errorMsg, setErrorMsg] = useState("");
  const [showConfirm, setShowConfirm] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Flow steps:
  // null → "writing" → "waiting_open" → "box_open" → "closing" → "done"
  const [step, setStep] = useState(null);
  const [borrowedItems, setBorrowedItems] = useState([]);
  const recordKeyRef = useRef(null);

  const hasPending = Object.keys(borrowList).length > 0;

  // ── Listen for ESP32 status updates on the borrow record ──
  useEffect(() => {
    if (!recordKeyRef.current) return;

    const recRef = ref(db, `borrow_records/${recordKeyRef.current}`);

    const unsubscribe = onValue(recRef, (snap) => {
      const data = snap.val();
      if (!data) return;

      console.log("Firebase status:", data.status); // DEBUG

      if (data.status === "box_open") setStep("box_open");
      if (data.status === "closed") setStep("done");
    });

    return () => off(recRef);
  }, [recordKeyRef.current]); // re-subscribe when writing starts

  const handleQtyChange = (key, value) => {
    setErrorMsg("");
    const parsed = parseInt(value, 10);
    setQuantities(prev => ({ ...prev, [key]: isNaN(parsed) || parsed < 0 ? "" : parsed }));
  };

  const items = LAB_COMPONENTS
    .filter(k => quantities[k] && parseInt(quantities[k]) > 0)
    .map(k => ({ key: k, qty: parseInt(quantities[k]) }));

  const handleSubmitClick = () => {
    setErrorMsg("");
    if (items.length === 0) { setErrorMsg("Please enter at least one quantity."); return; }
    for (const { key, qty } of items) {
      const avail = components[key]?.quantity ?? 0;
      if (qty > avail) { setErrorMsg(`"${key}" requested (${qty}) exceeds available stock (${avail}).`); return; }
    }
    setShowConfirm(true);
  };

  // ── Step 1: Write borrow_record with status "pending" ─────
  // ESP32 sees "pending" → rotates motor to OPEN → sets "box_open"
  const handleConfirm = async () => {
    setSubmitting(true);
    const itemsObj = {};
    items.forEach(({ key, qty }) => { itemsObj[key] = qty; });
    const recKey = `${user.uid}_${Date.now()}`;
    recordKeyRef.current = recKey;
    setBorrowedItems(items);
    try {
      await set(ref(db, `borrow_records/${recKey}`), {
        user: user.uid, userName: user.name,
        items: itemsObj, status: "pending",
        timestamp: serverTimestamp(),
      });
      setSubmitting(false);
      setShowConfirm(false);
      setStep("waiting_open"); // Show "Opening box..." spinner
    } catch (err) {
      setSubmitting(false);
      setErrorMsg("Failed to submit. Check Firebase connection.");
      console.error(err);
    }
  };

  // ── Step 2: User clicks "Component Collected" ─────────────
  // Web app tells ESP32 to close the box via "user_collected" status
  const handleCollected = async () => {
    setStep("closing"); // Show "Closing box..." spinner
    try {
      await set(ref(db, `borrow_records/${recordKeyRef.current}/status`), "user_collected");
      // ESP32 reads "user_collected" → rotates motor to CLOSED → sets "closed"
      // The onValue listener above will advance step to "done" when ESP32 confirms
    } catch (err) {
      console.error("Error signalling collection:", err);
      // Fallback: go to done anyway
      setStep("done");
    }
  };

  // ── Step 3: Done — auto logout ────────────────────────────
  const handleDone = () => {
    onLogout();
  };

  // ─────────────────────────────────────────────────────────
  return (
    <>
      {/* ══ WAITING FOR BOX TO OPEN ═════════════════════════ */}
      {step === "waiting_open" && (
        <div className="modal-overlay">
          <div className="modal-card dispense-card">
            <div className="dispense-anim-wrap">
              <div className="dispense-ring" />
              <div className="dispense-ring ring2" />
              <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="var(--cyan)" strokeWidth="1.8">
                <rect x="2" y="7" width="20" height="14" rx="2" />
                <path d="M16 21V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v16" />
              </svg>
            </div>
            <p className="dispense-title">Opening Box…</p>
            <p className="dispense-sub">Please wait while the motor opens the component box.</p>
            <div className="dispense-items">
              {borrowedItems.map(({ key, qty }) => (
                <div key={key} className="dispense-item-row">
                  <span className="comp-dot" />
                  <span>{key.charAt(0).toUpperCase() + key.slice(1)}</span>
                  <span className="modal-item-qty">× {qty}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ══ BOX IS OPEN — COLLECT COMPONENTS ════════════════ */}
      {step === "box_open" && (
        <div className="modal-overlay">
          <div className="modal-card">
            <div className="modal-header">
              <div className="modal-icon" style={{ background: "rgba(74,222,128,0.1)", borderColor: "rgba(74,222,128,0.3)", color: "var(--green)" }}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </div>
              <h3 className="modal-title">Box is Open!</h3>
              <p className="modal-sub">Collect your components from the box, then press the button below. The box will close automatically.</p>
            </div>
            <div className="modal-items">
              <p className="modal-items-label">Collect the following:</p>
              <ul className="modal-item-list">
                {borrowedItems.map(({ key, qty }) => (
                  <li key={key} className="modal-item-row">
                    <span className="modal-item-name"><span className="comp-dot" />{key.charAt(0).toUpperCase() + key.slice(1)}</span>
                    <span className="modal-item-qty">× {qty}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="modal-actions">
              <button className="modal-btn-confirm collected-btn" onClick={handleCollected}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                Component Collected — Close Box
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ══ BOX CLOSING ══════════════════════════════════════ */}
      {step === "closing" && (
        <div className="modal-overlay">
          <div className="modal-card dispense-card">
            <div className="dispense-anim-wrap">
              <div className="dispense-ring" style={{ borderColor: "rgba(74,222,128,0.4)" }} />
              <div className="dispense-ring ring2" style={{ borderColor: "rgba(74,222,128,0.2)" }} />
              <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="var(--green)" strokeWidth="1.8">
                <rect x="2" y="7" width="20" height="14" rx="2" />
                <path d="M16 21V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v16" />
              </svg>
            </div>
            <p className="dispense-title" style={{ color: "var(--green)" }}>Closing Box…</p>
            <p className="dispense-sub">Please wait while the box closes securely.</p>
          </div>
        </div>
      )}

      {/* ══ ALL DONE ═════════════════════════════════════════ */}
      {step === "done" && (
        <div className="modal-overlay">
          <div className="modal-card">
            <div className="modal-success">
              <div className="modal-success-icon">
                <svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </div>
              <p className="modal-success-title">Enjoy your components!</p>
              <p className="modal-success-sub" style={{ marginBottom: "1.5rem" }}>The box has been closed. Have a great session!</p>
              <button className="modal-btn-confirm" style={{ width: "100%", padding: "0.85rem" }} onClick={handleDone}>
                Done — Log Out
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ══ CONFIRM BORROW MODAL ════════════════════════════ */}
      {showConfirm && (
        <div className="modal-overlay" onClick={!submitting ? () => setShowConfirm(false) : undefined}>
          <div className="modal-card" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-icon">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
              </div>
              <h3 className="modal-title">Confirm Borrow Request</h3>
              <p className="modal-sub">Please review your items before confirming.</p>
            </div>
            <div className="modal-items">
              <p className="modal-items-label">Items to be borrowed:</p>
              <ul className="modal-item-list">
                {items.map(({ key, qty }) => (
                  <li key={key} className="modal-item-row">
                    <span className="modal-item-name"><span className="comp-dot" />{key.charAt(0).toUpperCase() + key.slice(1)}</span>
                    <span className="modal-item-qty">× {qty}</span>
                  </li>
                ))}
              </ul>
              <div className="modal-user-line">Borrowing as <strong>{user.name}</strong></div>
            </div>
            <div className="modal-actions">
              <button className="modal-btn-cancel" onClick={() => setShowConfirm(false)} disabled={submitting}>Cancel</button>
              <button className="modal-btn-confirm" onClick={handleConfirm} disabled={submitting}>
                {submitting
                  ? <span className="btn-loading"><span className="spinner" /> Submitting…</span>
                  : <><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12" /></svg> Yes, Proceed</>
                }
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ══ MAIN PAGE ════════════════════════════════════════ */}
      <div className="borrow-page">
        <div className="borrow-container">

          {hasPending && !step && (
            <div className="pending-banner">
              <div className="pending-icon">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
                </svg>
              </div>
              <div>
                <p className="pending-title">You have components yet to be returned</p>
                <p className="pending-sub">
                  {Object.entries(borrowList).map(([k, v]) =>
                    `${k.charAt(0).toUpperCase() + k.slice(1)}: ${v}`
                  ).join(" · ")}
                </p>
              </div>
            </div>
          )}

          <div className="borrow-header">
            <h2 className="borrow-title">Borrow Components</h2>
            <p className="borrow-sub">Enter the quantity you need, then submit your request.</p>
          </div>

          <div className="table-wrapper">
            <table className="comp-table">
              <thead>
                <tr>
                  <th>Component</th><th>Available</th><th>Quantity to Borrow</th>
                </tr>
              </thead>
              <tbody>
                {LAB_COMPONENTS.map(key => {
                  const avail = components[key]?.quantity ?? 0;
                  const req = parseInt(quantities[key]) || 0;
                  const over = req > avail;
                  return (
                    <tr key={key} className={over ? "row-error" : ""}>
                      <td className="comp-name"><span className="comp-dot" />{key.charAt(0).toUpperCase() + key.slice(1)}</td>
                      <td><span className={`stock-badge ${avail < 10 ? "low" : ""}`}>{avail}</span></td>
                      <td>
                        <input type="number" min="0" max={avail}
                          value={quantities[key] || ""}
                          onChange={e => handleQtyChange(key, e.target.value)}
                          placeholder="0"
                          className={`qty-input ${over ? "qty-error" : ""}`}
                        />
                        {over && <span className="qty-warn">Exceeds stock</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {errorMsg && (
            <div className="alert alert-error">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              {errorMsg}
            </div>
          )}

          <button onClick={handleSubmitClick} className="submit-btn">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M22 2L11 13" /><path d="M22 2L15 22 11 13 2 9l20-7z" />
            </svg>
            Submit Borrow Request
          </button>
        </div>
      </div>
    </>
  );
}
