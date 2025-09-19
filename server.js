/**
 * Aiface Biometric Attendance Server
 * 
 * Compatible with Aiface HTTP/HTTPS+JSON Protocol
 * Handles device registration, attendance logs, heartbeat, and user data
 * 
 * Deploy on Render.com or any Node.js hosting platform
 */

const express = require('express');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Data storage paths
const DATA_DIR = path.join(__dirname, 'data');
const DEVICES_FILE = path.join(DATA_DIR, 'devices.json');
const LOGS_FILE = path.join(DATA_DIR, 'logs.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Request logging
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.url}`);
  
  if (req.body) {
    console.log('Request Body:', JSON.stringify(req.body, null, 2));
  }
  
  // Log response
  const originalSend = res.send;
  res.send = function(body) {
    console.log(`[${timestamp}] Response:`, typeof body === 'string' ? body : JSON.stringify(body, null, 2));
    return originalSend.call(this, body);
  };
  
  next();
});

// Utility functions
function getCurrentTime() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

async function ensureDataDirectory() {
  try {
    if (!fsSync.existsSync(DATA_DIR)) {
      await fs.mkdir(DATA_DIR, { recursive: true });
    }
    
    // Initialize files if they don't exist
    const files = [DEVICES_FILE, LOGS_FILE, USERS_FILE];
    for (const file of files) {
      if (!fsSync.existsSync(file)) {
        await fs.writeFile(file, '[]', 'utf8');
      }
    }
  } catch (error) {
    console.error('Error ensuring data directory:', error);
  }
}

async function readJsonFile(filePath) {
  try {
    const data = await fs.readFile(filePath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error(`Error reading ${filePath}:`, error);
    return [];
  }
}

async function writeJsonFile(filePath, data) {
  try {
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
  } catch (error) {
    console.error(`Error writing ${filePath}:`, error);
  }
}

// Command handlers
async function handleRegistration(body) {
  console.log('Handling device registration...');
  
  const devices = await readJsonFile(DEVICES_FILE);
  const deviceData = {
    sn: body.sn,
    cpusn: body.cpusn,
    devinfo: body.devinfo,
    registeredAt: getCurrentTime(),
    lastSeen: getCurrentTime()
  };
  
  // Update or add device
  const existingIndex = devices.findIndex(device => device.sn === body.sn);
  if (existingIndex >= 0) {
    devices[existingIndex] = { ...devices[existingIndex], ...deviceData };
  } else {
    devices.push(deviceData);
  }
  
  await writeJsonFile(DEVICES_FILE, devices);
  
  return {
    ret: "reg",
    result: true,
    cloudtime: getCurrentTime(),
    nosenduser: true
  };
}

async function handleSendLog(body) {
  console.log('Handling attendance logs...');
  
  const logs = await readJsonFile(LOGS_FILE);
  const records = body.record || [];
  
  // Process each log record
  for (const record of records) {
    const logEntry = {
      sn: body.sn,
      enrollid: record.enrollid,
      time: record.time,
      mode: record.mode,
      inout: record.inout,
      event: record.event,
      temp: record.temp,
      verifymode: record.verifymode,
      image: record.image,
      receivedAt: getCurrentTime()
    };
    
    logs.push(logEntry);
  }
  
  await writeJsonFile(LOGS_FILE, logs);
  
  return {
    ret: "sendlog",
    result: true,
    count: body.count || records.length,
    logindex: body.logindex || 0,
    cloudtime: getCurrentTime(),
    access: 1, // 1 = allow access, 0 = deny
    message: "Logs received successfully"
  };
}

async function handleCheckLive(body) {
  console.log('Handling heartbeat...');
  
  // Update device last seen time
  if (body.sn) {
    const devices = await readJsonFile(DEVICES_FILE);
    const deviceIndex = devices.findIndex(device => device.sn === body.sn);
    
    if (deviceIndex >= 0) {
      devices[deviceIndex].lastSeen = getCurrentTime();
      devices[deviceIndex].lastHeartbeat = body.time || getCurrentTime();
      await writeJsonFile(DEVICES_FILE, devices);
    }
  }
  
  return {
    ret: "checklive",
    result: true,
    cloudtime: getCurrentTime()
  };
}

async function handleSendUser(body) {
  console.log('Handling user data...');
  
  const users = await readJsonFile(USERS_FILE);
  
  const userData = {
    sn: body.sn,
    enrollid: body.enrollid,
    name: body.name,
    backupnum: body.backupnum,
    admin: body.admin,
    record: body.record,
    receivedAt: getCurrentTime()
  };
  
  // Update or add user
  const existingIndex = users.findIndex(user => 
    user.enrollid === body.enrollid && user.backupnum === body.backupnum
  );
  
  if (existingIndex >= 0) {
    users[existingIndex] = { ...users[existingIndex], ...userData };
  } else {
    users.push(userData);
  }
  
  await writeJsonFile(USERS_FILE, users);
  
  return {
    ret: "senduser",
    result: true,
    cloudtime: getCurrentTime()
  };
}

async function handleSendQRCode(body) {
  console.log('Handling QR code verification...');
  
  // Simple QR code validation - you can customize this logic
  const qrCode = body.record;
  
  // Example: Allow access for specific QR codes
  const validCodes = ['123456', 'admin123', 'user456'];
  const isValid = validCodes.includes(qrCode);
  
  return {
    ret: "sendqrcode",
    sn: body.sn,
    result: true,
    access: isValid ? 1 : 0,
    enrollid: isValid ? 10 : 0,
    username: isValid ? "QR User" : "Unknown",
    message: isValid ? "Access granted" : "Access denied",
    voice: isValid ? "Welcome" : "Access denied"
  };
}

// Main API endpoint
app.post('/pub/api', async (req, res) => {
  try {
    const { cmd } = req.body;
    
    if (!cmd) {
      return res.status(400).json({
        ret: null,
        result: false,
        cloudtime: getCurrentTime(),
        error: "Missing cmd parameter"
      });
    }
    
    let response;
    
    switch (cmd.toLowerCase()) {
      case 'reg':
        response = await handleRegistration(req.body);
        break;
        
      case 'sendlog':
        response = await handleSendLog(req.body);
        break;
        
      case 'checklive':
        response = await handleCheckLive(req.body);
        break;
        
      case 'senduser':
        response = await handleSendUser(req.body);
        break;
        
      case 'sendqrcode':
        response = await handleSendQRCode(req.body);
        break;
        
      default:
        return res.status(400).json({
          ret: cmd,
          result: false,
          cloudtime: getCurrentTime(),
          error: `Unknown command: ${cmd}`
        });
    }
    
    res.json(response);
    
  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({
      ret: null,
      result: false,
      cloudtime: getCurrentTime(),
      error: "Internal server error"
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: getCurrentTime(),
    uptime: process.uptime()
  });
});

// Get stored data endpoints (for monitoring)
app.get('/devices', async (req, res) => {
  try {
    const devices = await readJsonFile(DEVICES_FILE);
    res.json(devices);
  } catch (error) {
    res.status(500).json({ error: 'Failed to read devices' });
  }
});

app.get('/logs', async (req, res) => {
  try {
    const logs = await readJsonFile(LOGS_FILE);
    // Return latest 100 logs to avoid large responses
    const recentLogs = logs.slice(-100);
    res.json(recentLogs);
  } catch (error) {
    res.status(500).json({ error: 'Failed to read logs' });
  }
});

app.get('/users', async (req, res) => {
  try {
    const users = await readJsonFile(USERS_FILE);
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: 'Failed to read users' });
  }
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'Aiface Attendance Server',
    version: '1.0.0',
    endpoints: {
      'POST /api': 'Main device communication endpoint',
      'GET /health': 'Health check',
      'GET /devices': 'View registered devices',
      'GET /logs': 'View attendance logs',
      'GET /users': 'View user data'
    }
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Endpoint not found',
    timestamp: getCurrentTime()
  });
});

// Error handler
app.use((error, req, res, next) => {
  console.error('Server Error:', error);
  res.status(500).json({
    error: 'Internal server error',
    timestamp: getCurrentTime()
  });
});

// Initialize and start server
async function startServer() {
  await ensureDataDirectory();
  
  app.listen(PORT, () => {
    console.log(`\n=== Aiface Attendance Server ===`);
    console.log(`Server running on port ${PORT}`);
    console.log(`Time: ${getCurrentTime()}`);
    console.log(`\nEndpoints:`);
    console.log(`- POST /api (main device endpoint)`);
    console.log(`- GET /health`);
    console.log(`- GET /devices`);
    console.log(`- GET /logs`);
    console.log(`- GET /users`);
    console.log(`\nReady to receive data from Aiface devices!\n`);
  });
}

startServer().catch(console.error);