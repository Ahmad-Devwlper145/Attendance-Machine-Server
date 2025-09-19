/**
 * Aiface Biometric Attendance Server
 *
 * Single POST endpoint: /api
 * Handles device commands: reg, sendlog, checklive, senduser
 *
 * Data persisted into JSON files: data/devices.json, data/logs.json, data/users.json
 *
 * HTTPS support: looks for certs in ./certs/server.key and ./certs/server.crt (or .pem). If missing,
 * server will fall back to HTTP and print instructions to create self-signed certs.
 *
 * Usage:
 *  - npm init -y
 *  - npm i express cors helmet dotenv fs-extra morgan
 *  - create certs/ and data/ directories (server will create data files automatically)
 *  - node server.js
 *
 * Response format:
 *  { ret: <cmd>, result: <true|false>, cloudtime: <ISO timestamp>, ...cmd-specific fields... }
 *
 * Author: Generated for Ahmad Genius (requested)
 */

import express from "express";
import fs from "fs/promises";
import fsSync from "fs";
import https from "https";
import http from "http";
import path from "path";
import cors from "cors";
import helmet from "helmet";
import dotenv from "dotenv";
import morgan from "morgan";

/* ---------------------------
   Config & Environment
   --------------------------- */
dotenv.config();
const DEFAULT_PORT = 3000;
const PORT = parseInt(process.env.PORT, 10) || DEFAULT_PORT;
const DATA_DIR = path.resolve(process.cwd(), "data");
const CERT_DIR = path.resolve(process.cwd(), "certs");
const DEVICES_FILE = path.join(DATA_DIR, "devices.json");
const LOGS_FILE = path.join(DATA_DIR, "logs.json");
const USERS_FILE = path.join(DATA_DIR, "users.json");

/* ---------------------------
   Utilities
   --------------------------- */

/**
 * Get current cloud time in ISO and epoch milliseconds
 */
function getCloudTime() {
  const now = new Date();
  return { iso: now.toISOString(), epoch: now.getTime() };
}

/**
 * Safe JSON read - returns defaultValue if file missing/corrupt
 */
async function readJsonSafe(filePath, defaultValue) {
  try {
    const exists = fsSync.existsSync(filePath);
    if (!exists) return defaultValue;
    const raw = await fs.readFile(filePath, "utf8");
    if (!raw) return defaultValue;
    return JSON.parse(raw);
  } catch (err) {
    console.error(`[readJsonSafe] failed reading ${filePath}:`, err);
    return defaultValue;
  }
}

/**
 * Write JSON atomically (write to tmp then rename)
 */
async function writeJsonSafe(filePath, obj) {
  const tmp = `${filePath}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2), "utf8");
  await fs.rename(tmp, filePath);
}

/**
 * Ensure data directory and files exist
 */
async function ensureDataFiles() {
  try {
    if (!fsSync.existsSync(DATA_DIR)) {
      await fs.mkdir(DATA_DIR, { recursive: true });
      console.log(`[startup] Created data directory: ${DATA_DIR}`);
    }
    if (!fsSync.existsSync(DEVICES_FILE)) await writeJsonSafe(DEVICES_FILE, []);
    if (!fsSync.existsSync(LOGS_FILE)) await writeJsonSafe(LOGS_FILE, []);
    if (!fsSync.existsSync(USERS_FILE)) await writeJsonSafe(USERS_FILE, []);
  } catch (err) {
    console.error("[ensureDataFiles] Error creating data files:", err);
    throw err;
  }
}

/**
 * Simple validation helper
 */
function requireFields(obj, fields) {
  const missing = [];
  for (const f of fields) if (!(f in obj)) missing.push(f);
  return missing;
}

/* ---------------------------
   Logging helpers
   --------------------------- */

/**
 * Format timestamp for console logs
 */
function nowForLog() {
  return new Date().toISOString();
}

/**
 * Wrap res.send to capture outgoing responses for logging
 */
function responseLoggerMiddleware(req, res, next) {
  const oldSend = res.send;
  res.send = function (body) {
    try {
      // attempt to parse body for nicer log when stringified
      const parsed = typeof body === "string" ? body : JSON.stringify(body);
      console.log(`[response ${nowForLog()}] ${req.method} ${req.originalUrl} -> ${res.statusCode}\n${parsed}`);
    } catch (err) {
      console.log(`[response ${nowForLog()}] (unable to format body)`);
    }
    return oldSend.call(this, body);
  };
  next();
}

/* ---------------------------
   Command Handlers (modular)
   --------------------------- */

/**
 * Handler: Registration (cmd: "reg")
 * Device sends its info (serial number, model, capacities...)
 * We store device registration data and send success + cloudtime + nosenduser:true
 */
async function handleReg(reqBody) {
  // expected payload example (device dependent):
  // { cmd: "reg", SN: "ABCD1234", Model: "Aiface X100", Capacities: {...}, ... }
  const required = ["SN"];
  const missing = requireFields(reqBody, required);
  if (missing.length) {
    return { status: 400, body: { error: `Missing required fields: ${missing.join(", ")}` } };
  }

  const devices = await readJsonSafe(DEVICES_FILE, []);
  const existingIndex = devices.findIndex((d) => d.SN === reqBody.SN);

  const record = {
    SN: reqBody.SN,
    model: reqBody.Model || reqBody.model || null,
    capacities: reqBody.Capacities || reqBody.capacities || null,
    ip: reqBody.ip || reqBody.IP || null,
    raw: reqBody,
    registeredAt: getCloudTime().iso,
  };

  if (existingIndex >= 0) {
    // update
    devices[existingIndex] = { ...devices[existingIndex], ...record };
  } else {
    devices.push(record);
  }

  await writeJsonSafe(DEVICES_FILE, devices);

  // Response per spec: include nosenduser: true
  const { iso } = getCloudTime();
  return {
    status: 200,
    body: {
      ret: "reg",
      result: true,
      cloudtime: iso,
      nosenduser: true,
      message: "Device registered successfully",
    },
  };
}

/**
 * Handler: Attendance Logs (cmd: "sendlog")
 * Device posts attendance records: enrollid, timestamp, verification mode, temperature, image data
 * We'll accept either single object or array logs
 */
async function handleSendLog(reqBody) {
  // sample device payload:
  // { cmd:"sendlog", logs: [ { enrollid: "1001", timestamp:"2025-09-18T10:00:00", verifyMode: "1", temp: 36.5, image: "<base64>" }, ... ] }
  const logsContainer = reqBody.logs || reqBody.log || reqBody.data || null;
  if (!logsContainer) {
    return { status: 400, body: { error: "Missing logs array (logs)" } };
  }

  const logsArray = Array.isArray(logsContainer) ? logsContainer : [logsContainer];
  if (!logsArray.length) {
    return { status: 400, body: { error: "No log entries provided" } };
  }

  const existing = await readJsonSafe(LOGS_FILE, []);
  const storedEntries = [];

  for (const l of logsArray) {
    // validate minimal fields
    const required = ["enrollid", "timestamp"];
    const missing = requireFields(l, required);
    if (missing.length) {
      // skip invalid entries, but continue
      console.warn(`[handleSendLog] skipping log - missing: ${missing.join(", ")}`);
      continue;
    }

    // simple access rule example:
    // Deny if temperature present and >= 38.0
    const temperature = l.temp ?? l.temperature ?? null;
    let access = 1; // 1 = allow, 0 = deny
    if (temperature !== null && !isNaN(parseFloat(temperature)) && parseFloat(temperature) >= 38.0) {
      access = 0;
    }

    const entry = {
      enrollid: String(l.enrollid),
      timestamp: l.timestamp,
      verifyMode: l.verifyMode ?? l.verify_mode ?? null,
      temperature,
      image: l.image ?? null, // store raw base64 if provided (beware size)
      deviceSN: reqBody.SN || null,
      serverReceivedAt: getCloudTime().iso,
      access,
      raw: l,
    };

    existing.push(entry);
    storedEntries.push(entry);
  }

  await writeJsonSafe(LOGS_FILE, existing);

  // response: success, log count, access (if mixed entries we'll return overall summary)
  const { iso } = getCloudTime();
  const allowedCount = storedEntries.filter((e) => e.access === 1).length;
  const deniedCount = storedEntries.length - allowedCount;
  return {
    status: 200,
    body: {
      ret: "sendlog",
      result: true,
      cloudtime: iso,
      log_count: storedEntries.length,
      allowed: allowedCount,
      denied: deniedCount,
      message: "Logs received",
    },
  };
}

/**
 * Handler: Heartbeat (cmd: "checklive")
 * Device sends periodic status; respond with success & time
 */
async function handleCheckLive(reqBody) {
  const { iso } = getCloudTime();
  // Optionally update device last seen
  try {
    const devices = await readJsonSafe(DEVICES_FILE, []);
    if (reqBody.SN) {
      const idx = devices.findIndex((d) => d.SN === reqBody.SN);
      if (idx >= 0) {
        devices[idx].lastSeen = iso;
        devices[idx].rawLast = reqBody;
        await writeJsonSafe(DEVICES_FILE, devices);
      } else {
        // not registered yet; do not error, just log
        console.log(`[checklive] heartbeat from unknown device SN=${reqBody.SN}`);
      }
    }
  } catch (err) {
    console.warn("[handleCheckLive] updating device lastSeen failed:", err);
  }

  return {
    status: 200,
    body: {
      ret: "checklive",
      result: true,
      cloudtime: iso,
      message: "alive",
    },
  };
}

/**
 * Handler: User Data (cmd: "senduser")
 * New user registrations from device keypad: fingerprint, card, password, etc.
 */
async function handleSendUser(reqBody) {
  // sample: { cmd:"senduser", user: { id:"1001", name:"Alice", password:"1234", card:"abcd", fingerprint: "<base64>" } }
  const userObj = reqBody.user || reqBody.users || null;
  if (!userObj) return { status: 400, body: { error: "Missing user payload (user/users)" } };

  const usersFile = await readJsonSafe(USERS_FILE, []);
  const newUsers = Array.isArray(userObj) ? userObj : [userObj];
  const added = [];

  for (const u of newUsers) {
    if (!u.id && !u.userid && !u.enrollid) {
      console.warn("[handleSendUser] skipping user missing id");
      continue;
    }
    const uid = u.id ?? u.userid ?? u.enrollid;
    const existingIdx = usersFile.findIndex((x) => String(x.id) === String(uid));

    const record = {
      id: String(uid),
      name: u.name ?? u.username ?? null,
      password: u.password ?? null,
      card: u.card ?? null,
      fingerprint: u.fingerprint ?? null,
      deviceSN: reqBody.SN || null,
      createdAt: getCloudTime().iso,
      raw: u,
    };

    if (existingIdx >= 0) {
      usersFile[existingIdx] = { ...usersFile[existingIdx], ...record, updatedAt: getCloudTime().iso };
    } else {
      usersFile.push(record);
    }
    added.push(record);
  }

  await writeJsonSafe(USERS_FILE, usersFile);
  const { iso } = getCloudTime();
  return {
    status: 200,
    body: {
      ret: "senduser",
      result: true,
      cloudtime: iso,
      added: added.length,
      message: "Users processed successfully",
    },
  };
}

/* ---------------------------
   Command Router
   --------------------------- */
async function routeCommand(req, res) {
  try {
    const body = req.body;
    if (!body || typeof body !== "object") {
      return res.status(400).send({
        ret: null,
        result: false,
        cloudtime: getCloudTime().iso,
        error: "Invalid or missing JSON body",
      });
    }

    const cmd = body.cmd;
    if (!cmd) {
      return res.status(400).send({
        ret: null,
        result: false,
        cloudtime: getCloudTime().iso,
        error: "Missing 'cmd' property",
      });
    }

    // Normalise cmd to string
    const cmdStr = String(cmd).trim().toLowerCase();

    // Each handler returns object: { status, body } or throws
    let handlerResult;
    switch (cmdStr) {
      case "reg":
        handlerResult = await handleReg(body);
        break;
      case "sendlog":
        handlerResult = await handleSendLog(body);
        break;
      case "checklive":
        handlerResult = await handleCheckLive(body);
        break;
      case "senduser":
        handlerResult = await handleSendUser(body);
        break;
      default:
        return res.status(400).send({
          ret: cmdStr,
          result: false,
          cloudtime: getCloudTime().iso,
          error: `Unknown cmd: ${cmdStr}`,
        });
    }

    // handlerResult.body is the response body
    return res.status(handlerResult.status).json(handlerResult.body);
  } catch (err) {
    console.error("[routeCommand] Unhandled error:", err);
    return res.status(500).json({
      ret: null,
      result: false,
      cloudtime: getCloudTime().iso,
      error: "Internal server error",
    });
  }
}

/* ---------------------------
   Server Setup & Middleware
   --------------------------- */

async function startServer() {
  await ensureDataFiles();

  const app = express();

  // Basic security headers
  app.use(helmet());

  // Allow CORS from anywhere by default (adjust in production)
  app.use(cors());

  // JSON parser
  app.use(express.json({ limit: "10mb" })); // increase if necessary for images

  // Request logging (morgan)
  app.use(
    morgan(function (tokens, req, res) {
      return [
        `[req ${nowForLog()}]`,
        tokens.method(req, res),
        tokens.url(req, res),
        tokens.status(req, res),
        tokens["response-time"](req, res) + "ms",
        "-",
        tokens.res(req, res, "content-length"),
      ].join(" ");
    })
  );

  // Response logger wrapper
  app.use(responseLoggerMiddleware);

  // single endpoint
  app.post("/api", routeCommand);

  // health check
  app.get("/health", (req, res) =>
    res.json({ status: "ok", cloudtime: getCloudTime().iso })
  );

  // 404
  app.use((req, res) => {
    res.status(404).json({ ret: null, result: false, cloudtime: getCloudTime().iso, error: "Not found" });
  });

  // global error handler
  app.use((err, req, res, next) => {
    console.error("[global error handler]", err);
    res.status(500).json({ ret: null, result: false, cloudtime: getCloudTime().iso, error: "Server error" });
  });

  // HTTPS attempt
  const keyPath = path.join(CERT_DIR, "server.key");
  const certPath = path.join(CERT_DIR, "server.crt");

  let server;
  if (fsSync.existsSync(keyPath) && fsSync.existsSync(certPath)) {
    console.log(`[startup] TLS certs found in ${CERT_DIR}, starting HTTPS server on port ${PORT}`);
    const key = fsSync.readFileSync(keyPath);
    const cert = fsSync.readFileSync(certPath);
    server = https.createServer({ key, cert }, app).listen(PORT, () => {
      console.log(`[startup ${nowForLog()}] HTTPS server listening on port ${PORT}`);
    });
  } else {
    // Fallback to HTTP but give clear instructions for generating certs
    console.warn(`[startup] TLS certs not found in ${CERT_DIR}. Starting HTTP server on port ${PORT}.`);
    console.warn(`[startup] To enable HTTPS, place 'server.key' and 'server.crt' (PEM) in ${CERT_DIR}.`);
    console.warn(`[startup] Example self-signed (for testing only):`);
    console.warn(`  mkdir -p ${CERT_DIR}`);
    console.warn(`  openssl req -x509 -newkey rsa:4096 -nodes -keyout ${CERT_DIR}/server.key -out ${CERT_DIR}/server.crt -days 365 -subj "/CN=localhost"`);
    server = http.createServer(app).listen(PORT, () => {
      console.log(`[startup ${nowForLog()}] HTTP server listening on port ${PORT}`);
    });
  }

  // graceful shutdown
  const shutdown = (signal) => {
    return async () => {
      console.log(`[shutdown ${nowForLog()}] Received ${signal}. Closing server...`);
      server.close(() => {
        console.log(`[shutdown ${nowForLog()}] Server closed. Exiting process.`);
        process.exit(0);
      });
      // if still not closed in 5s, force exit
      setTimeout(() => {
        console.warn("[shutdown] Forcing exit.");
        process.exit(1);
      }, 5000).unref();
    };
  };

  process.on("SIGINT", shutdown("SIGINT"));
  process.on("SIGTERM", shutdown("SIGTERM"));
  process.on("uncaughtException", (err) => {
    console.error("[uncaughtException]", err);
  });
  process.on("unhandledRejection", (reason) => {
    console.error("[unhandledRejection]", reason);
  });
}

/* ---------------------------
   Launch
   --------------------------- */
startServer().catch((err) => {
  console.error("[startup] Failed to start server:", err);
  process.exit(1);
});
