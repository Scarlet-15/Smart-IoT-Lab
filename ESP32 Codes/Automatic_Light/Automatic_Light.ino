// ── Smart Lab Auto Light System (PIR Based + Countdown) ──

// PIR Pins
#define PIR1 13
#define PIR2 12
#define PIR3 14

// LED Pins
#define LED1 25
#define LED2 26
#define LED3 27

// ⏱️ TIMEOUT (Demo = 10 sec)
#define TIMEOUT 10000  

unsigned long lastMotion1 = 0;
unsigned long lastMotion2 = 0;
unsigned long lastMotion3 = 0;

bool ledState1 = false;
bool ledState2 = false;
bool ledState3 = false;

// For countdown printing
int lastPrintSec1 = -1;
int lastPrintSec2 = -1;
int lastPrintSec3 = -1;

void setup() {
  Serial.begin(115200);

  pinMode(PIR1, INPUT_PULLDOWN);
  pinMode(PIR2, INPUT_PULLDOWN);
  pinMode(PIR3, INPUT_PULLDOWN);

  pinMode(LED1, OUTPUT);
  pinMode(LED2, OUTPUT);
  pinMode(LED3, OUTPUT);

  Serial.println("🔥 Smart Lab Auto Light System Ready");
  Serial.println("⏳ Waiting for PIR calibration (30 sec)...");
  delay(30000);
}

void loop() {

  unsigned long currentTime = millis();

  // ================= DESK 1 =================
  if (digitalRead(PIR1) == HIGH) {
    lastMotion1 = currentTime;
    lastPrintSec1 = -1; // reset countdown

    if (!ledState1) {
      digitalWrite(LED1, HIGH);
      ledState1 = true;
      Serial.println("🟢 Desk1 Occupied → LED ON");
    }
  }

  if (ledState1) {
    int remaining = (TIMEOUT - (currentTime - lastMotion1)) / 1000;

    if (remaining >= 0 && remaining != lastPrintSec1) {
      Serial.print("Desk1: No motion → OFF in ");
      Serial.print(remaining);
      Serial.println(" sec");
      lastPrintSec1 = remaining;
    }

    if (currentTime - lastMotion1 > TIMEOUT) {
      digitalWrite(LED1, LOW);
      ledState1 = false;
      Serial.println("🔴 Desk1 Empty → LED OFF");
    }
  }

  // ================= DESK 2 =================
  if (digitalRead(PIR2) == HIGH) {
    lastMotion2 = currentTime;
    lastPrintSec2 = -1;

    if (!ledState2) {
      digitalWrite(LED2, HIGH);
      ledState2 = true;
      Serial.println("🟢 Desk2 Occupied → LED ON");
    }
  }

  if (ledState2) {
    int remaining = (TIMEOUT - (currentTime - lastMotion2)) / 1000;

    if (remaining >= 0 && remaining != lastPrintSec2) {
      Serial.print("Desk2: No motion → OFF in ");
      Serial.print(remaining);
      Serial.println(" sec");
      lastPrintSec2 = remaining;
    }

    if (currentTime - lastMotion2 > TIMEOUT) {
      digitalWrite(LED2, LOW);
      ledState2 = false;
      Serial.println("🔴 Desk2 Empty → LED OFF");
    }
  }

  // ================= DESK 3 =================
  if (digitalRead(PIR3) == HIGH) {
    lastMotion3 = currentTime;
    lastPrintSec3 = -1;

    if (!ledState3) {
      digitalWrite(LED3, HIGH);
      ledState3 = true;
      Serial.println("🟢 Desk3 Occupied → LED ON");
    }
  }

  if (ledState3) {
    int remaining = (TIMEOUT - (currentTime - lastMotion3)) / 1000;

    if (remaining >= 0 && remaining != lastPrintSec3) {
      Serial.print("Desk3: No motion → OFF in ");
      Serial.print(remaining);
      Serial.println(" sec");
      lastPrintSec3 = remaining;
    }

    if (currentTime - lastMotion3 > TIMEOUT) {
      digitalWrite(LED3, LOW);
      ledState3 = false;
      Serial.println("🔴 Desk3 Empty → LED OFF");
    }
  }

  delay(200);
}