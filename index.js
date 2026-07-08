// 阿里云 SCF Web Function 入口
const express = require('express');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');

const app = express();
app.use(express.json());

// 静态资源映射——绕过 SCF 的 Content-Disposition: attachment
const PUBLIC = path.join(__dirname, 'public');
const mimeTypes = { '.html':'text/html','.css':'text/css','.js':'application/javascript','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.ico':'image/x-icon','.svg':'image/svg+xml' };

function serveFile(filePath) {
  return (req, res) => {
    try {
      const content = fs.readFileSync(filePath);
      const ext = path.extname(filePath);
      res.type(ext).send(content);
    } catch(e) {
      res.status(404).send('Not found');
    }
  };
}

app.get('/', serveFile(path.join(PUBLIC, 'index.html')));
app.get('/intro', serveFile(path.join(PUBLIC, 'home.html')));

// 其他静态文件
app.get('/*', (req, res) => {
  const filePath = path.join(PUBLIC, req.path);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const content = fs.readFileSync(filePath);
    res.type(path.extname(filePath)).send(content);
  } else {
    // 回退到 index.html (SPA)
    const html = fs.readFileSync(path.join(PUBLIC, 'index.html'));
    res.type('html').send(html);
  }
});

const PROVIDER = (process.env.PROVIDER || 'deepseek').toLowerCase();
let anthropic = null, deepseek = null;

if (PROVIDER === 'claude') {
  anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
} else {
  deepseek = new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: 'https://api.deepseek.com' });
}

const runtime = require('./mumu-runtime');
function buildSystemPrompt(sessionState) { return runtime.buildFullSystemPrompt(sessionState); }

async function callAI(systemPrompt, history, userMessage) {
  if (PROVIDER === 'claude') {
    const messages = [...history.map(e => ({ role: e.role, content: e.content })), { role: 'user', content: userMessage }];
    const response = await anthropic.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 2048, system: systemPrompt, messages });
    return response.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  } else {
    const messages = [{ role: 'system', content: systemPrompt }, ...history.map(e => ({ role: e.role, content: e.content })), { role: 'user', content: userMessage }];
    const response = await deepseek.chat.completions.create({ model: 'deepseek-chat', max_tokens: 2048, temperature: 0.9, messages });
    return response.choices[0].message.content;
  }
}

const sessions = {};
function getSession(id) {
  if (!sessions[id]) sessions[id] = { history: [], createdAt: Date.now(), isRealMode: false };
  return sessions[id];
}

app.post('/chat', async (req, res) => {
  const { message } = req.body;
  if (!message) return res.json({ reply: '（嗯？）' });
  const session = getSession(req.ip || 'default');
  const systemPrompt = buildSystemPrompt(session);
  const reply = await callAI(systemPrompt, session.history, message);
  session.history.push({ role: 'user', content: message }, { role: 'assistant', content: reply });
  if (session.history.length > 60) session.history = session.history.slice(-60);
  res.json({ reply });
});

app.post('/mode', (req, res) => { getSession(req.ip || 'default').isRealMode = req.body.paused || false; res.json({ paused: getSession(req.ip || 'default').isRealMode }); });
app.get('/status', (req, res) => res.json({ paused: getSession(req.ip || 'default').isRealMode || false }));
app.get('/poll', (req, res) => res.json({ proactive: null }));
app.post('/reset', (req, res) => { delete sessions[req.ip || 'default']; res.json({ ok: true }); });

const port = process.env.PORT || 9000;
app.listen(port, '0.0.0.0', () => console.log('mumu server on port ' + port));

module.exports = app;
