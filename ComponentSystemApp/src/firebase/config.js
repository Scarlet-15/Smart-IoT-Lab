// src/firebase/config.js
// ─────────────────────────────────────────────────────────────
//  STEP 1: Replace every value below with YOUR Firebase project
//          settings (Firebase Console → Project Settings → SDK)
// ─────────────────────────────────────────────────────────────
import { initializeApp } from "firebase/app";
import { getDatabase } from "firebase/database";

const firebaseConfig = {
  apiKey: "AIzaSyD1YJKEo8WobR58O2HSuEqC93DoEX5_muM",
  authDomain: "smartlabdatabase.firebaseapp.com",
  databaseURL: "https://smartlabdatabase-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "smartlabdatabase",
  storageBucket: "smartlabdatabase.firebasestorage.app",
  messagingSenderId: "856773959651",
  appId: "1:856773959651:web:638728361457ad309ecad6"
};

const app = initializeApp(firebaseConfig);
export const db = getDatabase(app);
