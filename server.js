require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');

const app = express();
app.use(express.json());

// No cache for HTML — prevent stale pages
app.use((req, res, next) => {
  if (req.path === '/' || req.path === '/intro' || req.path.endsWith('.html')) {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
  }
  next();
});

// 聊天页 = 默认首页
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 介绍页
app.get('/intro', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'home.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3456;
const PROVIDER = (process.env.PROVIDER || 'deepseek').toLowerCase();

// --- AI clients ---
let anthropic = null;
let deepseek = null;

if (PROVIDER === 'claude') {
  anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
} else {
  deepseek = new OpenAI({
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseURL: 'https://api.deepseek.com'
  });
}
const MUMU_DIR = path.resolve(__dirname, '..');
const runtime = require('./mumu-runtime');
const TEMP_DIR = path.join(MUMU_DIR, 'temp');
const DIALOGUES_DIR = runtime.DIALOGUES_DIR;

// --- Build system prompt (delegates to runtime) ---
function buildSystemPrompt(sessionState) {
  return runtime.buildFullSystemPrompt(sessionState);
}

// --- Unified AI call ---
async function callAI(systemPrompt, history, userMessage) {
  if (PROVIDER === 'claude') {
    // Anthropic Claude
    const messages = [];
    for (const entry of history) {
      messages.push({ role: entry.role, content: entry.content });
    }
    messages.push({ role: 'user', content: userMessage });

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      system: systemPrompt,
      messages
    });

    return response.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n');
  } else {
    // DeepSeek (OpenAI-compatible)
    const messages = [{ role: 'system', content: systemPrompt }];
    for (const entry of history) {
      messages.push({ role: entry.role, content: entry.content });
    }
    messages.push({ role: 'user', content: userMessage });

    const response = await deepseek.chat.completions.create({
      model: 'deepseek-chat',
      max_tokens: 2048,
      temperature: 0.9,
      messages
    });

    return response.choices[0].message.content;
  }
}

// --- Session state (single user) ---
let session = {
  history: [],
  songInfo: null,
  douyinTitle: null,
  douyinLinkInfo: null,
  paused: false,
  mobile: false,
  lastMessageTime: null,
  messageCount: 0,
  freeMode: false,
  proactiveTimer: null,
  pendingProactive: null,
  preSessionDone: false,
  gapResult: null
};

// --- Douyin link detection and fetch ---
function detectDouyinLink(message) {
  const match = message.match(/https?:\/\/(?:www\.)?(?:douyin\.com|v\.douyin\.com)\S+/i);
  return match ? match[0] : null;
}

async function fetchDouyinPageTitle(url) {
  try {
    // Use a simple HTTP GET with timeout - just get the HTML title
    const https = require('https');
    const http = require('http');
    const lib = url.startsWith('https') ? https : http;

    return new Promise((resolve) => {
      const req = lib.get(url, { timeout: 5000, headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; if (data.length > 50000) res.destroy(); });
        res.on('end', () => {
          const titleMatch = data.match(/<title[^>]*>([^<]+)<\/title>/i);
          resolve(titleMatch ? titleMatch[1].trim() : null);
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.setTimeout(5000);
    });
  } catch { return null; }
}

// --- Dialogue saving ---
function saveDialogue() {
  console.log(`[saveDialogue] called, history length: ${session.history.length}`);
  if (session.history.length < 4) { console.log('[saveDialogue] SKIP: history too short'); return; }

  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }).replace(/[/:]/g, '-').slice(0, 19);

  // Build dialogue markdown
  let md = `# ${dateStr} 手机聊天\n\n`;
  md += `## 时间\n${timeStr}\n\n`;
  md += `## 提供商\n${PROVIDER}\n\n`;
  md += `## 对话记录\n\n`;

  for (let i = 0; i < session.history.length; i += 2) {
    const userMsg = session.history[i];
    const mumuMsg = session.history[i + 1];
    if (!userMsg || !mumuMsg) continue;

    md += `### 庆庆\n${userMsg.content}\n\n`;
    md += `### 暮暮\n${mumuMsg.content}\n\n`;
  }

  // Write to dialogues/
  const filename = `${dateStr}-mobile-chat.md`;
  const filepath = path.join(DIALOGUES_DIR, filename);

  // Append if same-day file exists
  try {
    if (fs.existsSync(filepath)) {
      let existing = fs.readFileSync(filepath, 'utf-8');
      // Append new messages
      md = existing + '\n---\n\n' + md.replace(/^#.*\n\n## 时间.*\n## 提供商.*\n\n/, '');
    }
  } catch {}

  fs.writeFileSync(filepath, md, 'utf-8');

  // Update meta.json
  try {
    const metaPath = path.join(MUMU_DIR, 'meta.json');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    meta.updated_at = now.toISOString();
    meta.pending_growth_review = true;
    meta.last_mobile_chat = dateStr;
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n', 'utf-8');
  } catch {}

  console.log(`  💾 对话已保存: ${filename}`);
  return filename;
}

// Graceful shutdown
let shuttingDown = false;
process.on('SIGINT', () => {
  if (!shuttingDown) {
    shuttingDown = true;
    console.log('\n  正在保存对话...');
    saveDialogue();
    process.exit(0);
  }
});

// --- Interaction signal detection ---
function detectSignals(message) {
  const signals = { song: false, douyin: false, pause: false, resume: false, end: false, douyinLink: false, freeModeOn: false, freeModeOff: false };

  if (/陪我.*听歌|一起听歌|听听看|听听这首歌|知道我在听什么吗/.test(message)) {
    signals.song = true;
  }
  if (/刷抖音|陪我看抖音|看抖音|刷.*抖音/.test(message)) {
    signals.douyin = true;
  }
  if (/暂停一下/.test(message)) {
    signals.pause = true;
  }
  if (/回到暮暮|继续暮暮/.test(message)) {
    signals.resume = true;
  }
  if (/^(结束|拜拜|晚安|睡了|bye|再见)$/i.test(message.trim())) {
    signals.end = true;
  }
  if (detectDouyinLink(message)) {
    signals.douyinLink = true;
  }
  if (/自由模式/.test(message)) {
    signals.freeModeOn = true;
  }
  if (/回答模式/.test(message)) {
    signals.freeModeOff = true;
  }

  return signals;
}

function runScript(scriptName) {
  try {
    const scriptPath = path.join(TEMP_DIR, scriptName);
    const result = execSync(
      `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`,
      { encoding: 'utf-8', timeout: 5000 }
    );
    return result.trim();
  } catch { return null; }
}

function readOutputFile(filename) {
  try {
    const filepath = path.join(process.env.USERPROFILE || 'C:\\Users\\ASUS', filename);
    const content = fs.readFileSync(filepath, 'utf-8').trim();
    // Don't return the placeholder messages
    if (content.includes('未在播放歌曲') || content.includes('未在浏览器中打开') || content.includes('未在运行')) {
      return null;
    }
    return content;
  } catch { return null; }
}

// --- Chat endpoint ---
app.post('/chat', async (req, res) => {
  const { message } = req.body;
  if (req.body.mobile !== undefined) { session.mobile = req.body.mobile; }
  if (!message || !message.trim()) {
    return res.json({ error: '消息不能为空' });
  }

  const now = new Date();
  const signals = detectSignals(message);

  // Handle resume
  if (signals.resume) {
    session.paused = false;
  }
  // Handle pause
  if (signals.pause) {
    session.paused = true;
  }

  if (signals.freeModeOn) {
    session.freeMode = true;
  }
  if (signals.freeModeOff) {
    session.freeMode = false;
    if (session.proactiveTimer) { clearTimeout(session.proactiveTimer); session.proactiveTimer = null; }
    session.pendingProactive = null;
  }

  // Handle song signal
  if (signals.song) {
    runScript('check_song.ps1');
    const songInfo = readOutputFile('claude_song.txt');
    if (songInfo) {
      session.songInfo = songInfo;
    }
  }

  // Handle douyin signal
  if (signals.douyin) {
    runScript('check_douyin.ps1');
    const douyinTitle = readOutputFile('claude_douyin.txt');
    if (douyinTitle) {
      session.douyinTitle = douyinTitle;
    }
  }

  // Handle shared douyin link
  if (signals.douyinLink) {
    const link = detectDouyinLink(message);
    if (link) {
      const title = await fetchDouyinPageTitle(link);
      if (title) {
        session.douyinLinkInfo = `链接: ${link}\n视频描述: ${title}`;
      } else {
        session.douyinLinkInfo = `链接: ${link}\n（视频描述获取失败，但暮暮知道庆庆分享了一个抖音视频）`;
      }
    }
  }

  // Pre-session: gap filling on first message
  if (!session.preSessionDone) {
    console.log('  [runtime] 首次消息——检查空窗期...');
    session.gapResult = await runtime.preSession(callAI);
    session.preSessionDone = true;
  }

  // Check pending proactive message
  const pendingMsg = runtime.checkPendingMessage();
  if (pendingMsg && session.history.length === 0) {
    console.log('  [runtime] 有待处理的主发消息');
  }

  // Build system prompt with current state
  const systemPrompt = buildSystemPrompt({
    songInfo: signals.song ? session.songInfo : null,
    douyinTitle: signals.douyin ? session.douyinTitle : null,
    douyinLinkInfo: signals.douyinLink ? session.douyinLinkInfo : null,
    paused: session.paused,
    mobile: session.mobile
  });

  // Add time context
  const timeGap = session.lastMessageTime
    ? Math.round((now - session.lastMessageTime) / 60000)
    : 0;
  let timeContext = '';
  if (timeGap > 30) {
    timeContext = `\n\n[系统提示：庆庆距离上一条消息间隔了${timeGap}分钟。暮暮根据对话间隔感知规则（规则10）自然反应。]`;
  }

  try {
    const reply = await callAI(systemPrompt, session.history, message + timeContext);

    // Store in history
    session.history.push({ role: 'user', content: message });
    session.history.push({ role: 'assistant', content: reply });
    session.lastMessageTime = now;
    session.messageCount++;

    // 自由模式：设一个定时器，到时生成追问
    if (session.proactiveTimer) { clearTimeout(session.proactiveTimer); }
    if (session.freeMode && !signals.end) {
      const delay = 60000 + Math.random() * 120000; // 1-3分钟
      session.proactiveTimer = setTimeout(async () => {
        try {
          const prompt = buildSystemPrompt({ mobile: session.mobile, paused: session.paused });
          const poke = await callAI(prompt, session.history, "[系统：庆庆刚才没有回消息。过了两分钟了。暮暮应该很自然地说一句追问的话——问他在干嘛、撒娇催他、或者继续刚才没说完的话题。只要说一句，不要多。短一点，像真人微信。不要用括号动作。]");
          if (poke && session.freeMode) {
            session.history.push({ role: "assistant", content: poke });
            session.pendingProactive = poke;
            session.lastMessageTime = new Date();
            console.log("  自由模式追问:", poke.slice(0, 50));
          }
        } catch (e) { console.error("自由模式追问失败:", e.message); }
      }, delay);
    }

    // Limit history size (keep last 40 messages)
    if (session.history.length > 40) {
      session.history = session.history.slice(-40);
    }

    // Auto-save on end signal
    if (signals.end) {
      console.log('[chat] end signal detected, saving...');
      saveDialogue();

      // Evaluate growth post-dialogue
      const dialogueText = session.history
        .map(m => `${m.role === 'user' ? '庆庆' : '暮暮'}: ${m.content}`)
        .join('\n');
      runtime.evaluateGrowth(callAI, dialogueText, { dateStr: new Date().toISOString().slice(0, 10) })
        .then(eval_ => {
          if (eval_.triggered) {
            console.log(`  [runtime] 成长迭代完成: ${eval_.reason}`);
          }
        })
        .catch(e => console.log('  [runtime] 成长评估出错:', e.message));
    }

    // Auto-save every 20 messages as backup
    if (session.messageCount % 20 === 0) {
      saveDialogue();
    }

    // Clear signal-specific state
    session.songInfo = null;
    session.douyinTitle = null;
    session.douyinLinkInfo = null;

    res.json({ reply });

  } catch (err) {
    console.error(`[${PROVIDER}] API Error:`, err.message);
    if (err.status === 401 || err.status === 403) {
      res.json({ reply: '（庆庆——API key 不对。检查一下 .env 文件里的 key。）' });
    } else if (err.status === 429) {
      res.json({ reply: '（被限流了……等几秒再试试？）' });
    } else {
      res.json({ reply: `（出错了：${err.message}）` });
    }
  }
});

// --- Mode toggle endpoint ---
app.post('/mode', (req, res) => {
  const { paused } = req.body;
  if (typeof paused === 'boolean') {
    session.paused = paused;
    console.log(`  [mode] 切换为: ${paused ? '真实模式 (Claude助手)' : '暮暮模式'}`);
  }
  res.json({ paused: session.paused });
});

// --- Reset endpoint ---
app.post('/reset', (req, res) => {
  if (session.proactiveTimer) { clearTimeout(session.proactiveTimer); session.proactiveTimer = null; }
  session = {
    history: [], songInfo: null, douyinTitle: null, douyinLinkInfo: null,
    paused: false, mobile: session.mobile, freeMode: session.freeMode,
    lastMessageTime: null, messageCount: 0,
    proactiveTimer: null, pendingProactive: null,
    preSessionDone: false, gapResult: null
  };
  res.json({ ok: true });
});

// --- Status endpoint ---
app.get('/status', (req, res) => {
  res.json({
    provider: PROVIDER,
    historyLength: session.history.length,
    paused: session.paused,
    hasSong: !!session.songInfo,
    hasDouyin: !!session.douyinTitle
  });
});

app.get("/poll", (req, res) => {
  const msg = session.pendingProactive;
  session.pendingProactive = null;
  res.json({ proactive: msg || null, freeMode: session.freeMode });
});

// --- Start ---
app.listen(PORT, '0.0.0.0', () => {
  const icon = PROVIDER === 'claude' ? '🧠' : '🐳';
  const label = PROVIDER === 'claude' ? 'Claude' : 'DeepSeek';
  console.log('');
  console.log(`  🍋 暮暮聊天服务器已启动  ${icon} ${label}`);
  console.log(`  📱 同网络手机访问: http://YOUR_IP:${PORT}`);
  console.log('');
  console.log('  获取本机IP:');
  try {
    const nets = execSync('ipconfig', { encoding: 'utf-8' });
    const matches = nets.match(/IPv4.*?:\s*(\d+\.\d+\.\d+\.\d+)/g);
    if (matches) {
      matches.forEach(m => {
        const ip = m.split(':')[1].trim();
        if (!ip.startsWith('127.')) {
          console.log(`    → http://${ip}:${PORT}`);
        }
      });
    }
  } catch {}
  console.log('');
  console.log('  🌐 不同网络？运行穿透: npm run go');
  console.log('');
  console.log('  按 Ctrl+C 停止');
});
