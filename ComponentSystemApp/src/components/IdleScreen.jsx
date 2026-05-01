// src/components/IdleScreen.jsx
import { useEffect, useRef } from "react";

export default function IdleScreen() {
  const ringRef = useRef(null);

  useEffect(() => {
    // Pulse animation via JS for the ring
    let scale = 1;
    let growing = true;
    const interval = setInterval(() => {
      if (growing) {
        scale += 0.004;
        if (scale >= 1.18) growing = false;
      } else {
        scale -= 0.004;
        if (scale <= 1) growing = true;
      }
      if (ringRef.current) {
        ringRef.current.style.transform = `scale(${scale})`;
      }
    }, 20);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="idle-screen">
      {/* Animated background grid */}
      <div className="grid-bg" />

      {/* Centered card */}
      <div className="idle-card">
        {/* Pulsing RFID icon */}
        <div className="rfid-wrapper">
          <div ref={ringRef} className="rfid-ring" />
          <div className="rfid-icon">
            <svg width="52" height="52" viewBox="0 0 52 52" fill="none">
              <rect x="6" y="14" width="28" height="20" rx="3" stroke="#38bdf8" strokeWidth="2.5" fill="none"/>
              <rect x="10" y="18" width="8" height="12" rx="1.5" fill="#38bdf8" opacity="0.8"/>
              <path d="M38 18 C42 20, 42 28, 38 30" stroke="#38bdf8" strokeWidth="2.2" strokeLinecap="round" fill="none"/>
              <path d="M41 14 C47 18, 47 30, 41 34" stroke="#38bdf8" strokeWidth="2.2" strokeLinecap="round" fill="none" opacity="0.5"/>
            </svg>
          </div>
        </div>

        <h1 className="idle-title">Smart IoT Lab</h1>
        <p className="idle-subtitle">Component Borrowing System</p>
        <div className="idle-divider" />
        <p className="idle-instruction">Tap your ID card to begin</p>
        <div className="idle-dots">
          <span /><span /><span />
        </div>
      </div>

      {/* Corner badge */}
      <div className="corner-badge">RFID Ready</div>
    </div>
  );
}
