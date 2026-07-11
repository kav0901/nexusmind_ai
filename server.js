require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { GoogleGenAI } = require('@google/genai');

const app = express();
const port = process.env.PORT || 3000;

mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('✓ MongoDB Connected Successfully'))
    .catch(err => console.error('✗ MongoDB Connection Error:', err));

// UPDATED: User Schema with Full Name and Email Validation
const UserSchema = new mongoose.Schema({
    fullName: { type: String, required: true },
    username: { 
        type: String, 
        required: true, 
        unique: true,
        match: [/^\S+@\S+\.\S+$/, 'Please use a valid email address.'] 
    },
    password: { type: String, required: true }
});
const User = mongoose.model('User', UserSchema);

const ChatLogSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    mode: String,
    userPrompt: String,
    aiResponse: String,
    timestamp: { type: Date, default: Date.now }
});
const ChatLog = mongoose.model('ChatLog', ChatLogSchema);

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

app.use(express.static('./'));
app.use(express.json({ limit: '10mb' }));

const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (token == null) return res.status(401).json({ error: "Access Denied" });

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: "Invalid Token" });
        req.user = user;
        next();
    });
};

// UPDATED: Signup Route (Requires Full Name)
app.post('/api/auth/signup', async (req, res) => {
    try {
        const { fullName, username, password } = req.body;
        if (!fullName || !username || !password) return res.status(400).json({ error: "All fields are required." });
        
        const existingUser = await User.findOne({ username });
        if (existingUser) return res.status(400).json({ error: "Email already registered." });

        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = await User.create({ fullName, username, password: hashedPassword });
        
        const token = jwt.sign({ id: newUser._id, username: newUser.username }, process.env.JWT_SECRET);
        res.json({ token, username: newUser.username, fullName: newUser.fullName });
    } catch (err) { 
        if (err.name === 'ValidationError') return res.status(400).json({ error: "Please enter a valid email address (e.g., name@domain.com)." });
        res.status(500).json({ error: "Signup failed." }); 
    }
});

// UPDATED: Login Route (Returns Full Name to UI)
app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const user = await User.findOne({ username });
        if (!user) return res.status(400).json({ error: "User not found." });

        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) return res.status(400).json({ error: "Invalid password." });

        const token = jwt.sign({ id: user._id, username: user.username }, process.env.JWT_SECRET);
        res.json({ token, username: user.username, fullName: user.fullName });
    } catch (err) { res.status(500).json({ error: "Login failed." }); }
});

app.get('/api/history', authenticateToken, async (req, res) => {
    try {
        const { mode } = req.query;
        const filter = { userId: req.user.id };
        if (mode) filter.mode = mode;
        
        const history = await ChatLog.find(filter).sort({ timestamp: -1 }).limit(30);
        res.json(history);
    } catch (err) { res.status(500).json({ error: "Failed to fetch history" }); }
});

app.post('/api/chat', authenticateToken, async (req, res) => {
    const { message, mode, file } = req.body;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    try {
        let systemPrompt = "";
        if (mode === "classroom") systemPrompt = "Act as an interactive tutor. Explain foundational Mathematics and Science concepts simply at a Class 8 level. If the user uploads an image, analyze it carefully. Always end by asking a progressive quiz question.";
        else if (mode === "career") systemPrompt = "Act as a technical interviewer. The user is practicing Data Structures, Algorithms, and C++ logic. If they upload a screenshot of code, debug it and provide constructive feedback.";
        else if (mode === "resume") systemPrompt = "Act as a multilingual career bridge. The user will describe work experience or upload a resume. Translate it to English, format it into highly professional resume bullet points, and generate a brief roadmap of free upskilling resources.";

        const fullPrompt = `${systemPrompt}\n\nUser: ${message}\nAI:`;
        
        let requestContents = [fullPrompt];
        if (file && file.data && file.mimeType) {
            requestContents.push({ inlineData: { data: file.data, mimeType: file.mimeType } });
        }

        const responseStream = await ai.models.generateContentStream({
            model: "gemini-3.5-flash",
            contents: requestContents
        });

        let fullAiResponse = "";

        for await (const chunk of responseStream) {
            if (chunk.text) {
                fullAiResponse += chunk.text;
                res.write(`data: ${JSON.stringify({ text: chunk.text })}\n\n`);
            }
        }
        
        try {
            await ChatLog.create({
                userId: req.user.id,
                mode: mode,
                userPrompt: message || "[File Uploaded]",
                aiResponse: fullAiResponse
            });
        } catch (dbError) { console.error("Database save failed:", dbError); }

        res.write(`data: [DONE]\n\n`);
        res.end();
    } catch (error) {
        res.write(`data: ${JSON.stringify({ error: `Connection Error: ${error.message}` })}\n\n`);
        res.end();
    }
});

app.listen(port, () => console.log(`Server running at http://localhost:${port}`));
