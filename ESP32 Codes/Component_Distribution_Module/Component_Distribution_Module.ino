/*
 * ═══════════════════════════════════════════════════════════
 *  Smart IoT Lab — Main ESP32 v5 (ML-enhanced return)
 *
 *  CHANGE from v4:
 *  Return flow now waits for status = "verified"
 *  (set by Node.js backend after Roboflow confirms components)
 *  instead of "pending". The web app no longer directly
 *  opens the box — the backend does after ML verification.
 *
 *  Borrow flow: unchanged (pending → open → user_collected → close)
 *  Return flow: verified → open → user_placed → close
 *
 *  Motor: LED→GPIO25  Resistor→GPIO26
 *  RFID:  SDA→5 SCK→18 MOSI→23 MISO→19 RST→22
 * ═══════════════════════════════════════════════════════════
 */

#define ENABLE_USER_AUTH
#define ENABLE_DATABASE

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <FirebaseClient.h>
#include <SPI.h>
#include <MFRC522.h>
#include <ESP32Servo.h>

#define SS_PIN         5
#define RST_PIN        22
#define MOTOR_LED      25
#define MOTOR_RESISTOR 26
#define SERVO_CLOSED   0
#define SERVO_OPEN     180

#define WIFI_SSID     "jhu"
#define WIFI_PASSWORD "passcode"
#define Web_API_KEY   "AIzaSyD1YJKEo8WobR58O2HSuEqC93DoEX5_muM"
#define DATABASE_URL  "https://smartlabdatabase-default-rtdb.asia-southeast1.firebasedatabase.app/"
#define USER_EMAIL    "mhanjhu15@gmail.com"
#define USER_PASS     "mhanjhu"

void processData(AsyncResult &aResult);
UserAuth user_auth(Web_API_KEY, USER_EMAIL, USER_PASS);
FirebaseApp app;
WiFiClientSecure ssl_client;
using AsyncClient = AsyncClientClass;
AsyncClient aClient(ssl_client);
RealtimeDatabase Database;

MFRC522 rfid(SS_PIN, RST_PIN);
Servo   servoLED;
Servo   servoResistor;

struct Items { int led = 0; int resistor = 0; bool isEmpty() { return led == 0 && resistor == 0; } };

// ── State machine ─────────────────────────────────────────
enum State {
  S_IDLE,
  // Borrow
  S_BORROW_OPEN_MOTORS, S_BORROW_SET_BOX_OPEN,
  S_BORROW_WAIT_COLLECTED, S_BORROW_CLOSE_MOTORS,
  S_BORROW_SET_CLOSED, S_BORROW_UPDATE_LIST,
  S_BORROW_DELETE, S_BORROW_DONE,
  // Return — starts at VERIFIED (backend confirmed ML match)
  S_RETURN_OPEN_MOTORS, S_RETURN_SET_BOX_OPEN,
  S_RETURN_WAIT_PLACED, S_RETURN_CLOSE_MOTORS,
  S_RETURN_SET_CLOSED, S_RETURN_DELETE, S_RETURN_DONE,
};

State  currentState   = S_IDLE;
String activeRecKey   = "";
String activeUserUID  = "";
String activeUserName = "";
Items  activeItems;

unsigned long motorStartMs  = 0;
unsigned long lastPollMs    = 0;
unsigned long actionStartMs = 0;
unsigned long deletionTimer = 0;

const unsigned long MOTOR_MOVE_MS   = 1000;
const unsigned long POLL_MS         = 2000;
const unsigned long ACTION_TIMEOUT  = 120000;
const unsigned long DELETE_DELAY_MS = 8000;

struct Card { const char* rfidUID; const char* fbUID; };
const Card cards[] = {
  { "D376FC2C", "206125004" },
  { "368B8D2",  "206125019" },
};
const int CARD_COUNT = sizeof(cards) / sizeof(cards[0]);

bool   fbReady   = false;
String lastUID   = "";

unsigned long lastBorrowPoll = 0;
unsigned long lastReturnPoll = 0;
const unsigned long RECORD_POLL_MS = 3000;

String g_fetchedStatus = "";
bool   g_statusFetched = false;

// ── Firebase helpers ──────────────────────────────────────
void fbSetStr(const String &path, const String &val) {
  Database.set<String>(aClient, path, val, processData, "SET");
}
void fbSetInt(const String &path, int val) {
  Database.set<int>(aClient, path, val, processData, "SET");
}
void fbDelete(const String &path) {
  Database.remove(aClient, path, processData, "DEL");
}
void fbGetStatus(const String &path) {
  g_statusFetched = false;
  Database.get(aClient, path, processData, false, "GET_STATUS");
}

// ── Motor helpers ─────────────────────────────────────────
void openMotors(Items &it) {
  if (it.led > 0)      { Serial.println("[MOTOR] LED OPEN");      servoLED.write(SERVO_OPEN); }
  if (it.resistor > 0) { Serial.println("[MOTOR] Resistor OPEN"); servoResistor.write(SERVO_OPEN); }
  motorStartMs = millis();
}
void closeMotors(Items &it) {
  if (it.led > 0)      { Serial.println("[MOTOR] LED CLOSE");      servoLED.write(SERVO_CLOSED); }
  if (it.resistor > 0) { Serial.println("[MOTOR] Resistor CLOSE"); servoResistor.write(SERVO_CLOSED); }
  motorStartMs = millis();
}
bool motorDone() { return millis() - motorStartMs >= MOTOR_MOVE_MS; }

// ── Parse helpers ─────────────────────────────────────────
// Borrow: look for "pending" | Return: look for "verified"
bool hasTriggerStatus(const String &p, const String &task) {
  if (task == "BORROW_POLL")
    return p.indexOf("\"status\":\"pending\"") != -1 || p.indexOf("\"status\": \"pending\"") != -1;
  if (task == "RETURN_POLL")
    return p.indexOf("\"status\":\"verified\"") != -1 || p.indexOf("\"status\": \"verified\"") != -1;
  return false;
}

String extractStr(const String &p, const String &field) {
  String n = "\"" + field + "\":\"";
  int i = p.indexOf(n); if (i == -1) return "";
  int s = i + n.length(), e = p.indexOf("\"", s);
  return (e == -1) ? "" : p.substring(s, e);
}

String extractRecordKey(const String &p) {
  int s = p.indexOf("\"") + 1, e = p.indexOf("\"", s);
  return (s <= 0 || e <= s) ? "" : p.substring(s, e);
}

Items parseItems(const String &p) {
  Items it;
  auto rd = [&](const String &f, int fl) -> int {
    int i = p.indexOf(f); if (i == -1) return 0;
    int s = i + fl;
    while (s < (int)p.length() && p[s] == ' ') s++;
    int e = s;
    while (e < (int)p.length() && isDigit(p[e])) e++;
    return p.substring(s, e).toInt();
  };
  it.led      = rd("\"led\":",      6);
  it.resistor = rd("\"resistor\":", 11);
  return it;
}

// ═══════════════════════════════════════════════════════════
void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("\n Smart IoT Lab v5");

  servoLED.attach(MOTOR_LED);
  servoResistor.attach(MOTOR_RESISTOR);
  servoLED.write(SERVO_CLOSED);
  servoResistor.write(SERVO_CLOSED);

  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("WiFi");
  while (WiFi.status() != WL_CONNECTED) { Serial.print("."); delay(300); }
  Serial.println(" " + WiFi.localIP().toString());

  ssl_client.setInsecure();
  configTime(0, 0, "pool.ntp.org", "time.nist.gov");
  Serial.print("NTP");
  while (time(nullptr) < 100000) { Serial.print("."); delay(100); }
  Serial.println(" OK");

  initializeApp(aClient, app, getAuth(user_auth), processData, "authTask");
  app.getApp<RealtimeDatabase>(Database);
  Database.url(DATABASE_URL);

  SPI.begin();
  rfid.PCD_Init();
  delay(500);
  Serial.println("Ready.");
}

// ═══════════════════════════════════════════════════════════
void loop() {
  app.loop(); // ← must be first, every iteration

  if (app.ready() && !fbReady) { fbReady = true; Serial.println("✓ Firebase ready!"); }

  // ── RFID ──────────────────────────────────────────────
  if (currentState == S_IDLE && fbReady &&
      rfid.PICC_IsNewCardPresent() && rfid.PICC_ReadCardSerial()) {
    String uid = "";
    for (byte i = 0; i < rfid.uid.size; i++) uid += String(rfid.uid.uidByte[i], HEX);
    uid.toUpperCase();
    String fuid = "";
    for (int i = 0; i < CARD_COUNT; i++) if (uid == cards[i].rfidUID) { fuid = cards[i].fbUID; break; }
    if (fuid.isEmpty()) { Serial.println("Unknown card."); }
    else if (fuid != lastUID) {
      lastUID = fuid;
      Database.set<String>(aClient, "/rfid_taps/latest/uid", fuid, processData, "RFID");
    }
    rfid.PICC_HaltA(); rfid.PCD_StopCrypto1();
  }

  // ── Poll for records (only when idle) ─────────────────
  if (currentState == S_IDLE && fbReady) {
    if (millis() - lastBorrowPoll > RECORD_POLL_MS) {
      lastBorrowPoll = millis();
      Database.get(aClient, "/borrow_records",  processData, false, "BORROW_POLL");
    }
    if (millis() - lastReturnPoll > RECORD_POLL_MS + 1500) {
      lastReturnPoll = millis();
      // ← Return now polls for "verified" (set by backend after ML check)
      Database.get(aClient, "/return_records",  processData, false, "RETURN_POLL");
    }
  }

  // ═══════════════════════════════════════════════════════
  //  STATE MACHINE
  // ═══════════════════════════════════════════════════════
  switch (currentState) {
    case S_IDLE: break;

    // ── BORROW ────────────────────────────────────────────
    case S_BORROW_OPEN_MOTORS:
      openMotors(activeItems);
      currentState = S_BORROW_SET_BOX_OPEN;
      break;

    case S_BORROW_SET_BOX_OPEN:
      if (!motorDone()) break;
      Serial.println("[STATE] borrow → box_open");
      fbSetStr(String("/borrow_records/") + activeRecKey + "/status", "box_open");
      actionStartMs = millis(); lastPollMs = 0;
      currentState = S_BORROW_WAIT_COLLECTED;
      break;

    case S_BORROW_WAIT_COLLECTED:
      if (millis() - lastPollMs > POLL_MS) {
        lastPollMs = millis();
        fbGetStatus(String("/borrow_records/") + activeRecKey + "/status");
      }
      if (g_statusFetched) {
        g_statusFetched = false;
        if (g_fetchedStatus == "user_collected") {
          Serial.println("[STATE] user_collected!");
          currentState = S_BORROW_CLOSE_MOTORS;
        }
      }
      if (millis() - actionStartMs > ACTION_TIMEOUT) { currentState = S_BORROW_CLOSE_MOTORS; }
      break;

    case S_BORROW_CLOSE_MOTORS:
      closeMotors(activeItems);
      currentState = S_BORROW_SET_CLOSED;
      break;

    case S_BORROW_SET_CLOSED:
      if (!motorDone()) break;
      Serial.println("[STATE] borrow → closed");
      fbSetStr(String("/borrow_records/") + activeRecKey + "/status", "closed");
      currentState = S_BORROW_UPDATE_LIST;
      break;

    case S_BORROW_UPDATE_LIST: {
      String base = String("/borrow_list/") + activeUserUID + "/";
      if (activeItems.led > 0)      fbSetInt(base + "led",      activeItems.led);
      if (activeItems.resistor > 0) fbSetInt(base + "resistor", activeItems.resistor);
      deletionTimer = millis();
      currentState = S_BORROW_DELETE;
      break;
    }

    case S_BORROW_DELETE:
      if (millis() - deletionTimer < DELETE_DELAY_MS) break;
      fbDelete(String("/borrow_records/") + activeRecKey);
      currentState = S_BORROW_DONE;
      break;

    case S_BORROW_DONE:
      Serial.println("[DONE] Borrow complete.");
      lastUID = ""; currentState = S_IDLE;
      break;

    // ── RETURN (starts after ML verification) ─────────────
    case S_RETURN_OPEN_MOTORS:
      openMotors(activeItems);
      currentState = S_RETURN_SET_BOX_OPEN;
      break;

    case S_RETURN_SET_BOX_OPEN:
      if (!motorDone()) break;
      Serial.println("[STATE] return → box_open");
      fbSetStr(String("/return_records/") + activeRecKey + "/status", "box_open");
      actionStartMs = millis(); lastPollMs = 0;
      currentState = S_RETURN_WAIT_PLACED;
      break;

    case S_RETURN_WAIT_PLACED:
      if (millis() - lastPollMs > POLL_MS) {
        lastPollMs = millis();
        fbGetStatus(String("/return_records/") + activeRecKey + "/status");
      }
      if (g_statusFetched) {
        g_statusFetched = false;
        if (g_fetchedStatus == "user_placed") {
          Serial.println("[STATE] user_placed!");
          currentState = S_RETURN_CLOSE_MOTORS;
        }
      }
      if (millis() - actionStartMs > ACTION_TIMEOUT) { currentState = S_RETURN_CLOSE_MOTORS; }
      break;

    case S_RETURN_CLOSE_MOTORS:
      closeMotors(activeItems);
      currentState = S_RETURN_SET_CLOSED;
      break;

    case S_RETURN_SET_CLOSED:
      if (!motorDone()) break;
      Serial.println("[STATE] return → closed");
      fbSetStr(String("/return_records/") + activeRecKey + "/status", "closed");
      deletionTimer = millis();
      currentState = S_RETURN_DELETE;
      break;

    case S_RETURN_DELETE:
      if (millis() - deletionTimer < DELETE_DELAY_MS) break;
      fbDelete(String("/return_records/") + activeRecKey);
      currentState = S_RETURN_DONE;
      break;

    case S_RETURN_DONE:
      Serial.println("[DONE] Return complete.");
      lastUID = ""; currentState = S_IDLE;
      break;
  }
}

// ═══════════════════════════════════════════════════════════
//  FIREBASE CALLBACK
// ═══════════════════════════════════════════════════════════
void processData(AsyncResult &aResult) {
  if (!aResult.isResult()) return;
  if (aResult.isError()) {
    int c = aResult.error().code();
    if (c != -404 && c != 404 && c != -118)
      Firebase.printf("[ERR] %s: %s (%d)\n", aResult.uid().c_str(), aResult.error().message().c_str(), c);
    return;
  }
  if (!aResult.available()) return;

  String task    = String(aResult.uid().c_str());
  String payload = String(aResult.c_str());

  if (task == "GET_STATUS") {
    String v = payload; v.replace("\"",""); v.trim();
    g_fetchedStatus = v; g_statusFetched = true;
    Serial.printf("[POLL] status='%s'\n", v.c_str());
    return;
  }
  if (task == "SET" || task == "DEL" || task == "RFID") return;

  if (task == "BORROW_POLL") {
    if (payload.length() < 5 || payload == "null") return;
    if (!hasTriggerStatus(payload, "BORROW_POLL")) return;
    if (currentState != S_IDLE) return;
    activeRecKey   = extractRecordKey(payload);
    activeUserUID  = extractStr(payload, "user");
    activeUserName = extractStr(payload, "userName");
    activeItems    = parseItems(payload);
    if (activeRecKey.isEmpty() || activeUserUID.isEmpty() || activeItems.isEmpty()) return;
    Serial.printf("\n[BORROW] %s led=%d resistor=%d\n", activeUserName.c_str(), activeItems.led, activeItems.resistor);
    fbSetStr(String("/borrow_records/") + activeRecKey + "/status", "processing");
    currentState = S_BORROW_OPEN_MOTORS;
    return;
  }

  if (task == "RETURN_POLL") {
    if (payload.length() < 5 || payload == "null") return;
    // ← Key change: trigger on "verified" not "pending"
    if (!hasTriggerStatus(payload, "RETURN_POLL")) return;
    if (currentState != S_IDLE) return;
    activeRecKey  = extractRecordKey(payload);
    activeUserUID = extractStr(payload, "user");
    activeItems   = parseItems(payload);
    if (activeRecKey.isEmpty() || activeUserUID.isEmpty() || activeItems.isEmpty()) return;
    Serial.printf("\n[RETURN verified] %s led=%d resistor=%d\n", activeUserUID.c_str(), activeItems.led, activeItems.resistor);
    // Don't change status here — backend already set "verified"
    // Go straight to opening the motor
    currentState = S_RETURN_OPEN_MOTORS;
    return;
  }
}
