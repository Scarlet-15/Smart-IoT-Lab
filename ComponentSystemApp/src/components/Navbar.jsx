// src/components/Navbar.jsx
export default function Navbar({ user, page, onNavigate, onLogout, hasBorrows }) {
  return (
    <nav className="navbar">
      <div className="navbar-inner">
        <div className="navbar-logo">
          <span className="logo-dot" />
          <span>IoT Lab</span>
        </div>

        <div className="navbar-tabs">
          <button
            className={"tab-btn" + (page === "borrow" ? " active" : "")}
            onClick={() => onNavigate("borrow")}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M20 12V22H4V12" /><path d="M22 7H2v5h20V7z" /><path d="M12 22V7" />
              <path d="M12 7H7.5a2.5 2.5 0 010-5C11 2 12 7 12 7z" />
              <path d="M12 7h4.5a2.5 2.5 0 000-5C13 2 12 7 12 7z" />
            </svg>
            Borrow
          </button>
          <button
            className={"tab-btn" + (page === "return" ? " active" : "") + (hasBorrows ? " has-badge" : "")}
            onClick={() => onNavigate("return")}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="1 4 1 10 7 10" />
              <path d="M3.51 15a9 9 0 102.13-9.36L1 10" />
            </svg>
            Return
            {hasBorrows && <span className="tab-badge" />}
          </button>
        </div>

        <div className="navbar-user">
          <div className="user-avatar">
            {user.name ? user.name[0].toUpperCase() : "?"}
          </div>
          <div className="user-info">
            <span className="user-label">Logged in as</span>
            <span className="user-name">{user.name}</span>
          </div>
          <button onClick={onLogout} className="logout-btn">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
            Log Out
          </button>
        </div>
      </div>
    </nav>
  );
}
