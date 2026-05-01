# Smart IoT Lab — Component Borrowing System
## Complete Setup Guide

---

## Project Structure

```
iot-lab-borrowing/
├── index.html
├── package.json
├── vite.config.js
├── tailwind.config.js
├── postcss.config.js
├── firebase.json            ← Firebase Hosting config
├── database.rules.json      ← Firebase DB security rules
└── src/
    ├── main.jsx             ← React entry point
    ├── App.jsx              ← Root component + Firebase listeners
    ├── index.css            ← All styles
    ├── firebase/
    │   └── config.js        ← Firebase initialization (EDIT THIS)
    ├── components/
    │   ├── IdleScreen.jsx   ← Waiting screen shown before login
    │   └── Navbar.jsx       ← Top bar after login
    └── pages/
        └── BorrowPage.jsx   ← Component table + borrow form
```

---

## Part 1 — Firebase Setup (Step by Step)

### Step 1: Create a Firebase Project

1. Go to https://console.firebase.google.com
2. Click **"Add project"**
3. Enter a project name like `smart-iot-lab`
4. You can disable Google Analytics (not needed)
5. Click **"Create project"** and wait

---

### Step 2: Enable Realtime Database

1. In the left sidebar, click **Build → Realtime Database**
2. Click **"Create Database"**
3. Choose your server location (pick the closest region)
4. On the security rules screen, select **"Start in test mode"** → Click **Enable**

   > Test mode allows all reads and writes without authentication.
   > This is fine for development and hardware testing.

---

### Step 3: Set Database Rules (for testing)

In the Realtime Database console, click the **Rules** tab and paste:

```json
{
  "rules": {
    ".read": true,
    ".write": true
  }
}
```

Click **Publish**.

---

### Step 4: Manually Add Sample Data

In the Realtime Database console, click the **Data** tab.

Click the **+** button next to the root node and build this structure:

```
(root)
├── users
│   └── uid123
│       └── name: "Arun"
├── components
│   ├── led
│   │   └── quantity: 120
│   ├── resistor
│   │   └── quantity: 200
│   ├── capacitor
│   │   └── quantity: 150
│   └── arduino_nano
│       └── quantity: 10
└── rfid_taps
    └── latest
        └── uid: ""
```

> Leave `rfid_taps/latest/uid` as an empty string for now.
> You'll update it later to simulate a card tap.

---

### Step 5: Get the Firebase Config

1. In Firebase Console, click the ⚙️ gear icon → **Project Settings**
2. Scroll down to **"Your apps"** section
3. Click the **Web** icon (`</>`)
4. Register the app with a nickname like `iot-lab-web`
5. Copy the `firebaseConfig` object shown

It looks like this:

```javascript
const firebaseConfig = {
  apiKey: "AIzaSy...",
  authDomain: "smart-iot-lab.firebaseapp.com",
  databaseURL: "https://smart-iot-lab-default-rtdb.firebaseio.com",
  projectId: "smart-iot-lab",
  storageBucket: "smart-iot-lab.appspot.com",
  messagingSenderId: "123456789",
  appId: "1:123456789:web:abc123"
};
```

---

### Step 6: Add Config to the Project

Open `src/firebase/config.js` and replace the placeholder values with your actual config:

```javascript
const firebaseConfig = {
  apiKey: "YOUR_ACTUAL_API_KEY",           // ← paste yours here
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  databaseURL: "https://YOUR_PROJECT-default-rtdb.firebaseio.com",
  projectId: "YOUR_PROJECT",
  storageBucket: "YOUR_PROJECT.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID",
};
```

---

## Part 2 — Running the App Locally

### Prerequisites

Make sure you have:
- **Node.js** (version 18 or later): https://nodejs.org
- **npm** (comes with Node.js)

### Install & Run

```bash
# 1. Navigate into the project folder
cd iot-lab-borrowing

# 2. Install all dependencies
npm install

# 3. Start the development server
npm run dev
```

Open your browser at: **http://localhost:5173**

You should see the **Idle Screen** with the animated RFID icon.

---

## Part 3 — Hardware Simulation (No ESP32 Needed!)

This is the most important section for testing without hardware.

### How the Login Works (Conceptually)

```
Firebase DB:  /rfid_taps/latest/uid  ←── ESP32 writes here
                        ↓
         Web app is listening 24/7 (real-time listener)
                        ↓
         When uid changes → fetch /users/{uid} → log in user
```

### How to Simulate a Card Tap

1. Open **Firebase Console → Realtime Database → Data tab**
2. Navigate to: `rfid_taps → latest`
3. Click the pencil (edit) icon next to `uid`
4. Type a user ID, for example: `uid123`
5. Press **Enter** to save

**That's it!** The web app will instantly:
- Detect the change (real-time listener fires)
- Fetch the user's name from `/users/uid123`
- Log them in and show the Borrow Page

### To Log Out and Test Again

Click the **Log Out** button in the app.
Then change `uid` in Firebase to something else (e.g. `uid456`) to log in a different user.

### To Test Multiple Users

Add more users to Firebase:

```
users/
  uid123/
    name: "Arun"
  uid456/
    name: "Priya"
  uid789/
    name: "Vikram"
```

Then write different UIDs to `/rfid_taps/latest/uid` to switch between them.

### What If the UID Has No Matching User?

The app will silently ignore it (check browser console for a warning).
This is intentional — unregistered cards should not log anyone in.

---

## Part 4 — Firebase Realtime Listener Code Explained

Here's the key code in `App.jsx` and what it does:

```javascript
// This runs once when the app starts
useEffect(() => {
  const tapRef = ref(db, "rfid_taps/latest");  // point to the path

  // onValue() subscribes to real-time changes — NO polling!
  const unsubscribe = onValue(tapRef, async (snapshot) => {
    const data = snapshot.val();       // get current value
    if (!data || !data.uid) return;    // ignore empty values

    const uid = data.uid;
    if (uid === lastUidRef.current) return;  // ignore duplicate taps

    lastUidRef.current = uid;

    // Fetch user details from /users/{uid}
    const userSnap = await get(ref(db, `users/${uid}`));
    const userData = userSnap.val();

    if (userData) {
      setUser({ uid, name: userData.name });  // triggers re-render → logged in!
    }
  });

  return () => off(tapRef);  // cleanup when component unmounts
}, []);
```

**Key points:**
- `onValue()` creates a persistent WebSocket connection — instant updates, zero polling
- Firebase SDK handles reconnection automatically
- The listener is cleaned up when the app unmounts (memory safe)

---

## Part 5 — Borrow Records Structure in Firebase

When a student submits a borrow request, this is saved to Firebase:

```
borrow_records/
  -NxAbc123DEF/                  ← auto-generated key
    user: "uid123"
    userName: "Arun"
    timestamp: 1720000000000     ← server timestamp
    items/
      led: 5
      resistor: 10
```

Each record gets a unique key using Firebase's `push()` function, which is timestamp-based and guaranteed unique even if two people submit simultaneously.

---

## Part 6 — Deploy to Firebase Hosting

### Step 1: Install Firebase CLI

```bash
npm install -g firebase-tools
```

### Step 2: Login to Firebase

```bash
firebase login
```

### Step 3: Initialize Hosting

```bash
firebase init hosting
```

Answer the prompts:
- **Which project?** → Select your `smart-iot-lab` project
- **Public directory?** → Type `dist`
- **Single-page app?** → `Yes`
- **Overwrite index.html?** → `No`

### Step 4: Build the App

```bash
npm run build
```

This creates a `dist/` folder with the production-ready files.

### Step 5: Deploy

```bash
firebase deploy
```

Your app will be live at:
`https://smart-iot-lab.web.app`

---

## Part 7 — ESP32 Integration (When Hardware Is Ready)

When you have the ESP32 + RFID reader, this is the Arduino sketch logic:

```cpp
// Pseudocode — actual library syntax may vary
#include <Firebase_ESP_Client.h>
#include <MFRC522.h>

void onCardTap(String uid) {
  // Write to Firebase Realtime Database
  Firebase.RTDB.setString(&fbdo, "/rfid_taps/latest/uid", uid);
}
```

The web app needs **no changes** — it's already listening and will respond the moment the ESP32 writes the UID.

---

## Part 8 — Future Improvements

| Feature | Description |
|---|---|
| Firebase Authentication | Replace RFID-only login with proper user accounts |
| Reduce stock on borrow | Decrease `components/{key}/quantity` when borrowed |
| Return system | Add a "Return Components" page |
| Borrow history | Show each student's past borrow records |
| Admin panel | Manage users, components, and view all records |
| Email notifications | Notify lab admin when stock is low |
| Due dates | Track when borrowed items must be returned |
| QR code fallback | Allow login via QR scan if RFID unavailable |

---

## Quick Reference

| Action | How |
|---|---|
| Simulate card tap | Firebase Console → `rfid_taps/latest/uid` → set to `uid123` |
| Add a new user | Firebase Console → `users/newuid/name` → set name |
| Add a component | Firebase Console → `components/newpart/quantity` → set number |
| View borrow records | Firebase Console → `borrow_records` |
| Run locally | `npm run dev` |
| Deploy to web | `npm run build` then `firebase deploy` |
