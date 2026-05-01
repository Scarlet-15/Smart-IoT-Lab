#define ENABLE_USER_AUTH
#define ENABLE_DATABASE

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <FirebaseClient.h>
#include <SPI.h>
#include <MFRC522.h>

// ── Pins ─────────────────────────────
#define SS_PIN  5
#define RST_PIN 22

MFRC522 rfid(SS_PIN, RST_PIN);

// ── WiFi & Firebase ─────────────────
#define WIFI_SSID     "jhu"
#define WIFI_PASSWORD "passcode"

#define Web_API_KEY  "AIzaSyD1YJKEo8WobR58O2HSuEqC93DoEX5_muM"
#define DATABASE_URL "https://smartlabdatabase-default-rtdb.asia-southeast1.firebasedatabase.app/"
#define USER_EMAIL   "mhanjhu15@gmail.com"
#define USER_PASS    "mhanjhu"

// ── Firebase Setup ───────────────────
void processData(AsyncResult &aResult);

UserAuth user_auth(Web_API_KEY, USER_EMAIL, USER_PASS);
FirebaseApp app;
WiFiClientSecure ssl_client;
AsyncClientClass aClient(ssl_client);
RealtimeDatabase Database;

// ── RFID Mapping ─────────────────────
struct CardMapping {
  const char* rfidUID;
  const char* firebaseUID;
};

const CardMapping cards[] = {
  { "D376FC2C", "206125004" },
  { "368B8D2",  "206125019" },
  { "CC338E2",  "206125020" },
  { "93BFEC2C", "206125001" }
};

const int CARD_COUNT = sizeof(cards) / sizeof(cards[0]);

// ── Variables ────────────────────────
bool fbReady = false;
unsigned long lastTapTime = 0;

// ────────────────────────────────────
void setup() {
  Serial.begin(115200);

  // WiFi
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Connecting WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    Serial.print(".");
    delay(300);
  }
  Serial.println("\nWiFi Connected");

  ssl_client.setInsecure();

  // Time setup
  configTime(0, 0, "pool.ntp.org", "time.nist.gov");

  Serial.print("Waiting for time sync");
  time_t now = time(nullptr);
  while (now < 100000) {
    Serial.print(".");
    delay(500);
    now = time(nullptr);
  }
  Serial.println("\nTime synced!");

  // Firebase
  initializeApp(aClient, app, getAuth(user_auth), processData, "authTask");
  app.getApp<RealtimeDatabase>(Database);
  Database.url(DATABASE_URL);

  // RFID
  SPI.begin();
  rfid.PCD_Init();

  Serial.println("System Ready");
}

// ────────────────────────────────────
void loop() {

  app.loop();

  if (!rfid.PICC_IsNewCardPresent()) return;
  if (!rfid.PICC_ReadCardSerial()) return;

  // 🔥 Duplicate protection (3 sec)
  if (millis() - lastTapTime < 3000) {
    Serial.println("Wait...");
    return;
  }
  lastTapTime = millis();

  // Read UID
  String uid = "";
  for (byte i = 0; i < rfid.uid.size; i++) {
    uid += String(rfid.uid.uidByte[i], HEX);
  }
  uid.toUpperCase();

  Serial.println("Card UID: " + uid);

  // Match UID
  String firebaseUID = "";
  for (int i = 0; i < CARD_COUNT; i++) {
    if (uid == String(cards[i].rfidUID)) {
      firebaseUID = String(cards[i].firebaseUID);
      break;
    }
  }

  if (firebaseUID == "") {
    Serial.println("Unknown Card");
    return;
  }

  // Keep old system intact
  Database.set<String>(aClient, "/rfid_taps/latest/uid", firebaseUID, processData, "RFID_TAP");

  // ─────────────────────────────
  // 🔥 SESSION LOGIC
  // ─────────────────────────────

  time_t now;
  time(&now);
  struct tm *timeinfo = localtime(&now);

  char dateStr[11];
  strftime(dateStr, sizeof(dateStr), "%Y-%m-%d", timeinfo);

  char timeStr[20];
  strftime(timeStr, sizeof(timeStr), "%H:%M:%S", timeinfo);

  String date = String(dateStr);
  String currentTime = String(timeStr);

  String basePath = "/entry_exit_log/" + firebaseUID + "/" + date;

  Serial.println("Date: " + date);
  Serial.println("Time: " + currentTime);

  // 🔹 Find session number
  int session = 1;
  while (true) {
    String path = basePath + "/session" + String(session) + "/inTime";
    String val = Database.get<String>(aClient, path);

    if (val == "" || val == "null") break;
    session++;
  }

  // First session
  if (session == 1) {
    Database.set<String>(aClient, basePath + "/session1/inTime", currentTime, processData, "IN");
    Serial.println("🟢 Session1 IN");
    return;
  }

  String lastSession = basePath + "/session" + String(session - 1);

  String lastOut = Database.get<String>(aClient, lastSession + "/outTime");

  // If OUT not set → set it
  if (lastOut == "" || lastOut == "null") {
    Database.set<String>(aClient, lastSession + "/outTime", currentTime, processData, "OUT");
    Serial.println("🔴 OUT updated");
    return;
  }

  // 🔥 Compare time difference
  struct tm t;
  strptime(lastOut.c_str(), "%H:%M:%S", &t);
  time_t lastOutTime = mktime(&t);

  double diff = difftime(now, lastOutTime);

  if (diff < 300) {
    // Same session
    Database.set<String>(aClient, lastSession + "/outTime", currentTime, processData, "UPDATE_OUT");
    Serial.println("🔁 Same session OUT updated");
  } else {
    // New session
    String newSession = basePath + "/session" + String(session);
    Database.set<String>(aClient, newSession + "/inTime", currentTime, processData, "NEW_IN");
    Serial.println("🟢 New session started");
  }

  delay(1000);
}

// ────────────────────────────────────
void processData(AsyncResult &aResult) {
  if (!aResult.isResult()) return;

  if (aResult.isError()) {
    Serial.println("Firebase Error");
  }

  if (aResult.available()) {
    Serial.println("Firebase Updated");
  }
}