// src/App.jsx
import { useEffect, useState, useRef } from "react";
import { db } from "./firebase/config";
import { ref, onValue, off, get } from "firebase/database";
import IdleScreen from "./components/IdleScreen";
import Navbar from "./components/Navbar";
import BorrowPage from "./pages/BorrowPage";
import ReturnPage from "./pages/ReturnPage";
import { getDatabase, set } from "firebase/database";
import "./index.css";

export default function App() {
  const [user, setUser] = useState(null);
  const [components, setComponents] = useState({});
  const [borrowList, setBorrowList] = useState({});
  const [page, setPage] = useState("borrow");
  const [loginAnim, setLoginAnim] = useState(false);
  const lastUidRef = useRef(null);

  // 1. Listen to RFID taps
  useEffect(() => {
    const tapRef = ref(db, "rfid_taps/latest");
    onValue(tapRef, async (snapshot) => {
      const data = snapshot.val();
      if (!data || !data.uid) return;
      const uid = data.uid;
      if (uid === lastUidRef.current) return;
      lastUidRef.current = uid;
      try {
        const userSnap = await get(ref(db, `users/${uid}`));
        const userData = userSnap.val();
        if (userData) {
          const blSnap = await get(ref(db, `borrow_list/${uid}`));
          const blData = blSnap.val() || {};
          setLoginAnim(true);
          setTimeout(() => {
            setUser({ uid, name: userData.name });
            setBorrowList(blData);
            setPage("borrow");
            setLoginAnim(false);
          }, 600);
        }
      } catch (err) {
        console.error("Login error:", err);
      }
    });
    return () => off(ref(db, "rfid_taps/latest"));
  }, []);

  // 2. Live component stock
  useEffect(() => {
    const compRef = ref(db, "components");
    onValue(compRef, (snap) => setComponents(snap.val() || {}));
    return () => off(compRef);
  }, []);

  // 3. Live borrow_list for current user
  useEffect(() => {
    if (!user) return;
    const blRef = ref(db, `borrow_list/${user.uid}`);
    onValue(blRef, (snap) => setBorrowList(snap.val() || {}));
    return () => off(blRef);
  }, [user]);

  const handleLogout = async () => {
    const db = getDatabase();

    try {
      // Clear UID in Firebase
      await set(ref(db, "rfid_taps/latest/uid"), "");

      console.log("RFID UID reset successful");
    } catch (error) {
      console.error("Error resetting UID:", error);
    }

    // Clear local app state
    lastUidRef.current = null;
    setUser(null);
    setBorrowList({});
    setPage("borrow");
  };

  return (
    <div className={`app-root ${loginAnim ? "login-flash" : ""}`}>
      {!user ? (
        <IdleScreen />
      ) : (
        <>
          <Navbar
            user={user}
            page={page}
            onNavigate={setPage}
            onLogout={handleLogout}
            hasBorrows={Object.keys(borrowList).length > 0}
          />
          {page === "borrow" ? (
            <BorrowPage
              user={user}
              components={components}
              borrowList={borrowList}
              onLogout={handleLogout}
            />
          ) : (
            <ReturnPage
              user={user}
              borrowList={borrowList}
              onLogout={handleLogout}
              onBack={() => setPage("borrow")}
            />
          )}
        </>
      )}
    </div>
  );
}
