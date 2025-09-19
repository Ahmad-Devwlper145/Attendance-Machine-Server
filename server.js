const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware to parse JSON bodies
app.use(express.json());


// Usage Of Server
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    console.log('Headers:', JSON.stringify(req.headers, null, 2));
    console.log('Body:', JSON.stringify(req.body, null, 2));
    next();
});




// Basic route
app.get('/', (req, res) => {
    res.json({
        message: 'Welcome to Tiny Biometric Attendance Machine Server',
        status: 200,
        serStatus: 'Server is running successfully!',
        timestamp: new Date().toISOString()
    });
});




// Basic route
app.get('/tst', (req, res) => {
    res.json({
        status:200,
        message: 'TST Path',
    });
});




// Start the server
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});

module.exports = app;