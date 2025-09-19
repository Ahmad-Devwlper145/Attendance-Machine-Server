const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware to parse JSON bodies
app.use(express.json());

// Basic route
app.get('/', (req, res) => {
    res.json({
        message: 'Welcome to Tiny Biometric Attendance Machine Server',
        status: 'Server is running successfully!',
        timestamp: new Date().toISOString()
    });
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

// Sample API endpoint for attendance
app.get('/api/attendance', (req, res) => {
    res.json({
        message: 'Attendance endpoint',
        data: []
    });
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
    console.log(`Health check available at http://localhost:${PORT}/health`);
});

module.exports = app;