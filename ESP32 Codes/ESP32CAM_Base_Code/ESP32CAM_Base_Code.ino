/*
 * ═══════════════════════════════════════════════════════════
 *  Smart IoT Lab — ESP32-CAM (AI Thinker) v2
 *
 *  CHANGES from previous version:
 *  1. GET /stop_stream  — gracefully kills the stream task
 *     so /capture can run without hanging
 *  2. Stream runs in a FreeRTOS task (not inside the HTTP
 *     handler) so the HTTP thread is always free for /capture
 *
 *  Endpoints:
 *    GET /             → status page
 *    GET /capture      → single JPEG snapshot
 *    GET /stream       → MJPEG live stream
 *    GET /stop_stream  → stops the stream task (call before /capture)
 * ═══════════════════════════════════════════════════════════
 */
#include <lwip/sockets.h>
#include "esp_camera.h"
#include <WiFi.h>
#include "esp_http_server.h"

#define WIFI_SSID     "jhu"
#define WIFI_PASSWORD "passcode"
#define MSG_NOSIGNAL 0

// ── AI Thinker pin map ────────────────────────────────────
#define PWDN_GPIO_NUM   32
#define RESET_GPIO_NUM  -1
#define XCLK_GPIO_NUM    0
#define SIOD_GPIO_NUM   26
#define SIOC_GPIO_NUM   27
#define Y9_GPIO_NUM     35
#define Y8_GPIO_NUM     34
#define Y7_GPIO_NUM     39
#define Y6_GPIO_NUM     36
#define Y5_GPIO_NUM     21
#define Y4_GPIO_NUM     19
#define Y3_GPIO_NUM     18
#define Y2_GPIO_NUM      5
#define VSYNC_GPIO_NUM  25
#define HREF_GPIO_NUM   23
#define PCLK_GPIO_NUM   22

// ── MJPEG stream boundary ─────────────────────────────────
#define PART_BOUNDARY "123456789000000000000987654321"
static const char* STREAM_CONTENT_TYPE =
    "multipart/x-mixed-replace;boundary=" PART_BOUNDARY;
static const char* STREAM_BOUNDARY =
    "\r\n--" PART_BOUNDARY "\r\n";
static const char* STREAM_PART =
    "Content-Type: image/jpeg\r\nContent-Length: %u\r\n\r\n";

httpd_handle_t server = NULL;

// ── Stream task state ─────────────────────────────────────
static volatile bool stream_running  = false;  // task alive?
static volatile bool stream_stop_req = false;  // stop requested?
static int           stream_sockfd   = -1;     // raw socket

// ═══════════════════════════════════════════════════════════
//  Stream FreeRTOS task
//  Owns the raw socket. Checks stream_stop_req every frame.
//  Deletes itself when done.
// ═══════════════════════════════════════════════════════════
void streamTask(void *pvParam) {
    int sock = stream_sockfd;
    char hdr[64];

    Serial.println("[STREAM] Task started");
    stream_running  = true;
    stream_stop_req = false;

    while (!stream_stop_req) {
        camera_fb_t *fb = esp_camera_fb_get();
        if (!fb) {
            vTaskDelay(pdMS_TO_TICKS(50));
            continue;
        }

        bool ok = true;

        // boundary
        if (send(sock, STREAM_BOUNDARY, strlen(STREAM_BOUNDARY),
                 MSG_NOSIGNAL) < 0) { ok = false; }

        // part header
        if (ok) {
            int hlen = snprintf(hdr, sizeof(hdr), STREAM_PART, fb->len);
            if (send(sock, hdr, hlen, MSG_NOSIGNAL) < 0) ok = false;
        }

        // JPEG data
        if (ok) {
            if (send(sock, (const char *)fb->buf, fb->len,
                     MSG_NOSIGNAL) < 0) ok = false;
        }

        esp_camera_fb_return(fb);

        if (!ok) {
            Serial.println("[STREAM] Client disconnected");
            break;
        }

        // ~15 fps
        vTaskDelay(pdMS_TO_TICKS(66));
    }

    Serial.println("[STREAM] Task ending — closing socket");
    close(sock);
    stream_running  = false;
    stream_sockfd   = -1;
    vTaskDelete(NULL);
}

// ═══════════════════════════════════════════════════════════
//  GET /stream
//  Sends headers then hands socket to a FreeRTOS task.
//  The HTTP thread returns immediately — /capture never hangs.
// ═══════════════════════════════════════════════════════════
esp_err_t stream_handler(httpd_req_t *req) {
    if (stream_running) {
        // Already streaming — reject duplicate
        httpd_resp_set_status(req, "503 Service Unavailable");
        httpd_resp_sendstr(req, "Stream already active. Call /stop_stream first.");
        return ESP_OK;
    }

    // Send MJPEG headers before handing off the socket
    httpd_resp_set_type(req, STREAM_CONTENT_TYPE);
    httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    httpd_resp_set_hdr(req, "X-Accel-Buffering", "no");

    // Get raw socket fd — task will own this from now on
    stream_sockfd = httpd_req_to_sockfd(req);

    // Spawn task on Core 0 (HTTP server runs on Core 1)
    xTaskCreatePinnedToCore(
        streamTask, "stream_task",
        8192,          // stack
        NULL,          // no params needed — uses globals
        5,             // priority
        NULL,          // no handle needed
        0              // Core 0
    );

    // Return immediately so HTTP thread is freed
    // The task owns the socket from here; httpd must NOT touch it
    return ESP_OK;
}

// ═══════════════════════════════════════════════════════════
//  GET /stop_stream
//  Sets the stop flag, waits up to 500 ms for the task to exit,
//  then returns. /capture can be called safely after this.
// ═══════════════════════════════════════════════════════════
esp_err_t stop_stream_handler(httpd_req_t *req) {
    Serial.println("[STOP_STREAM] Request received");

    httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");

    if (!stream_running) {
        httpd_resp_set_type(req, "application/json");
        httpd_resp_sendstr(req, "{\"ok\":true,\"msg\":\"Stream was not running\"}");
        return ESP_OK;
    }

    // Signal the task to stop
    stream_stop_req = true;

    // Wait up to 600 ms for it to actually stop
    int waited = 0;
    while (stream_running && waited < 600) {
        vTaskDelay(pdMS_TO_TICKS(50));
        waited += 50;
    }

    if (stream_running) {
        Serial.println("[STOP_STREAM] Task still running after timeout");
        httpd_resp_set_type(req, "application/json");
        httpd_resp_sendstr(req,
            "{\"ok\":false,\"msg\":\"Stream task did not stop in time\"}");
        return ESP_OK;
    }

    Serial.println("[STOP_STREAM] Stream stopped OK");
    // Give the camera one frame cycle to flush its buffer
    vTaskDelay(pdMS_TO_TICKS(150));

    httpd_resp_set_type(req, "application/json");
    httpd_resp_sendstr(req, "{\"ok\":true,\"msg\":\"Stream stopped\"}");
    return ESP_OK;
}

// ═══════════════════════════════════════════════════════════
//  GET /capture  — single JPEG snapshot
//  Safe to call after /stop_stream.
// ═══════════════════════════════════════════════════════════
esp_err_t capture_handler(httpd_req_t *req) {
    Serial.println("[CAPTURE] Request");

    // If stream is still running, signal it to stop and wait up to 1.5s
    // This handles the race where /stop_stream returned before the task
    // fully exited (stream_stop_req set but stream_running still true)
    if (stream_running) {
        Serial.println("[CAPTURE] Stream still running — waiting for it to stop");
        stream_stop_req = true;
        int waited = 0;
        while (stream_running && waited < 1500) {
            vTaskDelay(pdMS_TO_TICKS(50));
            waited += 50;
        }
        if (stream_running) {
            Serial.println("[CAPTURE] Stream did not stop — proceeding anyway");
        } else {
            Serial.println("[CAPTURE] Stream stopped — proceeding");
            vTaskDelay(pdMS_TO_TICKS(150)); // flush buffer
        }
    }

    camera_fb_t *fb = NULL;
    // Up to 15 retries × 80 ms = 1200 ms max wait
    for (int i = 0; i < 15; i++) {
        fb = esp_camera_fb_get();
        if (fb) break;
        vTaskDelay(pdMS_TO_TICKS(80));
    }

    if (!fb) {
        Serial.println("[CAPTURE] Failed");
        httpd_resp_set_status(req, "503 Service Unavailable");
        httpd_resp_sendstr(req, "Camera busy");
        return ESP_FAIL;
    }

    Serial.printf("[CAPTURE] OK — %u bytes\n", fb->len);

    httpd_resp_set_type(req, "image/jpeg");
    httpd_resp_set_hdr(req, "Content-Disposition",
                       "inline; filename=snapshot.jpg");
    httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store, no-cache");

    esp_err_t res = httpd_resp_send(req,
                        (const char *)fb->buf, fb->len);
    esp_camera_fb_return(fb);
    return res;
}

// ═══════════════════════════════════════════════════════════
//  GET /  — status page
// ═══════════════════════════════════════════════════════════
esp_err_t status_handler(httpd_req_t *req) {
    String html =
        "<html><body style='font-family:monospace;"
        "background:#090e14;color:#e2eaf4;padding:2rem'>"
        "<h2 style='color:#38bdf8'>IoT Lab Camera</h2>"
        "<p>Stream: ";
    html += stream_running
        ? "<span style='color:#fbbf24'>Active</span>"
        : "<span style='color:#6b8299'>Idle</span>";
    html +=
        "</p>"
        "<p><a href='/stream'      style='color:#38bdf8'>/stream</a>"
        " — MJPEG live stream</p>"
        "<p><a href='/stop_stream' style='color:#f87171'>/stop_stream</a>"
        " — stop stream</p>"
        "<p><a href='/capture'     style='color:#38bdf8'>/capture</a>"
        " — single snapshot (call /stop_stream first)</p>"
        "<p>IP: " + WiFi.localIP().toString() + "</p>"
        "</body></html>";

    httpd_resp_set_type(req, "text/html");
    httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
    return httpd_resp_send(req, html.c_str(), html.length());
}

// ═══════════════════════════════════════════════════════════
//  Start HTTP server
// ═══════════════════════════════════════════════════════════
void startHttpServer() {
    httpd_config_t config    = HTTPD_DEFAULT_CONFIG();
    config.server_port       = 80;
    config.max_open_sockets  = 5;
    config.send_wait_timeout = 10;

    if (httpd_start(&server, &config) != ESP_OK) {
        Serial.println("[HTTP] Failed to start");
        return;
    }

    httpd_uri_t uris[] = {
        { "/capture",     HTTP_GET, capture_handler,     NULL },
        { "/stream",      HTTP_GET, stream_handler,      NULL },
        { "/stop_stream", HTTP_GET, stop_stream_handler, NULL },
        { "/",            HTTP_GET, status_handler,      NULL },
    };
    for (auto &u : uris) httpd_register_uri_handler(server, &u);

    Serial.println("[HTTP] Server started");
    Serial.println("[HTTP]   /stream       MJPEG live stream");
    Serial.println("[HTTP]   /stop_stream  stop stream");
    Serial.println("[HTTP]   /capture      JPEG snapshot");
    Serial.println("[HTTP]   /             status page");
}

// ═══════════════════════════════════════════════════════════
//  Setup
// ═══════════════════════════════════════════════════════════
void setup() {
    Serial.begin(115200);
    Serial.println("\n Smart IoT Lab — ESP32-CAM v2");

    camera_config_t config;
    config.ledc_channel = LEDC_CHANNEL_0;
    config.ledc_timer   = LEDC_TIMER_0;
    config.pin_d0       = Y2_GPIO_NUM;
    config.pin_d1       = Y3_GPIO_NUM;
    config.pin_d2       = Y4_GPIO_NUM;
    config.pin_d3       = Y5_GPIO_NUM;
    config.pin_d4       = Y6_GPIO_NUM;
    config.pin_d5       = Y7_GPIO_NUM;
    config.pin_d6       = Y8_GPIO_NUM;
    config.pin_d7       = Y9_GPIO_NUM;
    config.pin_xclk     = XCLK_GPIO_NUM;
    config.pin_pclk     = PCLK_GPIO_NUM;
    config.pin_vsync    = VSYNC_GPIO_NUM;
    config.pin_href     = HREF_GPIO_NUM;
    config.pin_sscb_sda = SIOD_GPIO_NUM;
    config.pin_sscb_scl = SIOC_GPIO_NUM;
    config.pin_pwdn     = PWDN_GPIO_NUM;
    config.pin_reset    = RESET_GPIO_NUM;
    config.xclk_freq_hz = 20000000;
    config.pixel_format = PIXFORMAT_JPEG;
    config.grab_mode    = CAMERA_GRAB_LATEST;
    config.fb_location  = CAMERA_FB_IN_PSRAM;
    config.jpeg_quality = 10;
    config.fb_count     = 2;

    if (!psramFound()) {
        config.frame_size  = FRAMESIZE_CIF;
        config.jpeg_quality = 12;
        config.fb_count    = 1;
        config.fb_location = CAMERA_FB_IN_DRAM;
    } else {
        config.frame_size = FRAMESIZE_SVGA;
    }

    if (esp_camera_init(&config) != ESP_OK) {
        Serial.println("[CAM] Init FAILED");
        return;
    }

    sensor_t *s = esp_camera_sensor_get();
    s->set_brightness(s, 1);
    s->set_contrast(s, 1);
    s->set_saturation(s, 0);
    s->set_special_effect(s, 0);
    s->set_whitebal(s, 1);
    s->set_awb_gain(s, 1);
    s->set_exposure_ctrl(s, 1);
    s->set_aec2(s, 0);
    s->set_gain_ctrl(s, 1);

    Serial.println("[CAM] Initialised");

    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    Serial.print("WiFi");
    while (WiFi.status() != WL_CONNECTED) { Serial.print("."); delay(300); }
    Serial.println(" Connected");

    Serial.println("════════════════════════════════════════");
    Serial.printf("  Stream      : http://%s/stream\n",
        WiFi.localIP().toString().c_str());
    Serial.printf("  Stop stream : http://%s/stop_stream\n",
        WiFi.localIP().toString().c_str());
    Serial.printf("  Capture     : http://%s/capture\n",
        WiFi.localIP().toString().c_str());
    Serial.println("  Set CAM_BASE_URL in ReturnPage.jsx to:");
    Serial.printf("    http://%s\n", WiFi.localIP().toString().c_str());
    Serial.println("════════════════════════════════════════");

    startHttpServer();
}

void loop() {
    delay(10000);
    Serial.printf("[CAM] Alive — IP: %s  stream:%s\n",
        WiFi.localIP().toString().c_str(),
        stream_running ? "ON" : "OFF");
}
