/**
 * 暮暮完整运行时 — 空窗期补全 + 成长追踪 + 文件管理
 * 让浏览器UI拥有和Claude Code /mumu同等的深度
 */

const fs = require('fs');
const path = require('path');

const MUMU_DIR = path.resolve(__dirname, '..');
const DIALOGUES_DIR = path.join(MUMU_DIR, 'dialogues');
const SELF_MD = path.join(MUMU_DIR, 'self.md');
const CALENDAR_MD = path.join(MUMU_DIR, 'calendar.md');
const META_JSON = path.join(MUMU_DIR, 'meta.json');
const AWARENESS_MD = path.join(MUMU_DIR, 'awareness.md');
const PERSONA_MD = path.join(MUMU_DIR, 'persona.md');
const SKILL_MD = path.join(MUMU_DIR, 'SKILL.md');
const DAILY_LIFE_MD = path.join(MUMU_DIR, 'daily-life.md');
const IFLINE_MD = path.join(MUMU_DIR, 'ifline-memories.md');
const PENDING_MSG = path.join(MUMU_DIR, 'pending-message.md');
const SOLILOQUIES_MD = path.join(MUMU_DIR, 'soliloquies.md');

function loadFile(filepath) {
  try { return fs.readFileSync(filepath, 'utf-8'); }
  catch { return ''; }
}

function saveFile(filepath, content) {
  fs.writeFileSync(filepath, content, 'utf-8');
}

function listDialogues() {
  try {
    return fs.readdirSync(DIALOGUES_DIR)
      .filter(f => f.endsWith('.md'))
      .sort();
  } catch { return []; }
}

function getLatestDialogueDate() {
  const files = listDialogues();
  if (files.length === 0) return null;
  const last = files[files.length - 1];
  const match = last.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

function getNow() {
  const d = new Date();
  return {
    dateStr: d.toISOString().slice(0, 10),
    datetime: d.toISOString(),
    weekday: ['周日','周一','周二','周三','周四','周五','周六'][d.getDay()],
    hour: d.getHours(),
    minute: d.getMinutes()
  };
}

// ============================================================
//  PRE-SESSION: Gap filling
// ============================================================

async function preSession(callAI) {
  const now = getNow();
  const lastDate = getLatestDialogueDate();

  if (!lastDate) {
    console.log('  [runtime] 首次对话，无需补全空窗期');
    return { gapFilled: false, days: [] };
  }

  const last = new Date(lastDate);
  const today = new Date(now.dateStr);
  const diffDays = Math.floor((today - last) / (1000 * 60 * 60 * 24));

  if (diffDays <= 0) {
    console.log('  [runtime] 无空窗期 (last:', lastDate, 'today:', now.dateStr, ')');
    return { gapFilled: false, days: [] };
  }

  console.log(`  [runtime] 检测到空窗期: ${diffDays} 天 (${lastDate} → ${now.dateStr})`);

  const filledDays = [];
  for (let i = 1; i <= diffDays; i++) {
    const d = new Date(last);
    d.setDate(d.getDate() + i);
    const ds = d.toISOString().slice(0, 10);
    const wd = ['周日','周一','周二','周三','周四','周五','周六'][d.getDay()];

    console.log(`  [runtime] 补全: ${ds} ${wd}`);

    // Use AI to generate daily entry
    const prompt = buildGapFillPrompt(ds, wd);
    const entry = await callAI(prompt, [], `请为${ds} ${wd}生成暮暮的日常记录。`);

    // Save dialogue file
    const slug = getDaySlug(ds, wd);
    const filename = `${ds}-${slug}.md`;
    const content = generateDayEntry(ds, wd, entry);
    saveFile(path.join(DIALOGUES_DIR, filename), content);
    filledDays.push({ date: ds, weekday: wd, file: filename });

    // Generate musings
    const musingPrompt = buildMusingsPrompt(ds, wd);
    const musingsEntry = await callAI(musingPrompt, [], `请为${ds} ${wd}生成暮暮的独白。`);
    appendMusings(ds, musingsEntry);

    // Update calendar
    updateCalendarForDate(ds);
  }

  // Update meta.json
  updateMeta({ updated_at: now.datetime });
  updateMetaForSoliloquy(now.dateStr, filledDays.length);

  console.log(`  [runtime] 空窗期补全完成: ${filledDays.length} 天`);
  return { gapFilled: true, days: filledDays };
}

function buildGapFillPrompt(dateStr, weekday) {
  const skillContent = loadFile(SKILL_MD);
  const selfContent = loadFile(SELF_MD);
  const calendarContent = loadFile(CALENDAR_MD);
  const latestDialogues = loadLatestDialoguesContent(2);

  return `你是暮暮的日常记录生成器。请根据暮暮的人格、课表和生活习惯，为 ${dateStr} ${weekday} 生成她这一天的生活片段。

格式: 上课、排练、和庆庆的异地聊天（他在莆田她在福州）、吃药、心情。包含关键片段和暮暮的内心记录。

庆庆存在感规则: 庆庆在莆田、暮暮在福州。每天都有微信聊天、表情包、简短通话。禁止写"庆庆没出现"——他们异地但每天都有联系。

生成记忆的质感: 关于庆庆的聊天要有微妙的生硬感——内容正确，但语气比真实对话更规整、更安全、少一点随机的刺。

${skillContent.slice(0, 3000)}

${selfContent.slice(0, 2000)}

${calendarContent.slice(0, 1000)}

最近对话:
${latestDialogues.slice(0, 2000)}`;
}

function getDaySlug(dateStr, weekday) {
  // Simple slug from weekday - can be customized
  const slugs = {
    '周一': 'monday', '周二': 'tuesday', '周三': 'wednesday',
    '周四': 'thursday', '周五': 'friday', '周六': 'saturday', '周日': 'sunday'
  };
  return slugs[weekday] || 'daily';
}

function generateDayEntry(dateStr, weekday, aiContent) {
  return `# ${dateStr}——${weekday}：日常

## 时间
${dateStr} ${weekday}

${aiContent}
`;
}

function updateCalendarForDate(dateStr) {
  let cal = loadFile(CALENDAR_MD);
  if (!cal) return;
  // Mark dates as completed if mentioned in calendar
  const escaped = dateStr.replace(/[-]/g, '\\$&');
  if (cal.includes(dateStr) && !cal.includes(`✅ ${dateStr}`)) {
    cal = cal.replace(
      new RegExp(`(- \\*\\*${escaped}.*\\*\\*：)`, 'g'),
      `✅ $1`
    );
    saveFile(CALENDAR_MD, cal);
  }
}

function loadLatestDialoguesContent(n = 2) {
  const files = listDialogues();
  const target = files.slice(-n);
  return target.map(f => loadFile(path.join(DIALOGUES_DIR, f))).join('\n\n---\n\n');
}

// ============================================================
//  POST-DIALOGUE: Growth evaluation
// ============================================================

async function evaluateGrowth(callAI, dialogueText, sessionState) {
  if (!dialogueText || dialogueText.length < 200) {
    console.log('  [runtime] 对话太短，跳过成长评估');
    return { triggered: false };
  }

  console.log('  [runtime] 评估成长触发...');

  const prompt = buildGrowthEvalPrompt(dialogueText, sessionState);
  const result = await callAI(prompt, [], '请评估本次对话是否触发成长机制。只回答JSON。');

  try {
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (!jsonMatch) { console.log('  [runtime] 未检测到JSON响应'); return { triggered: false }; }
    const eval_ = JSON.parse(jsonMatch[0]);

    if (eval_.triggered) {
      console.log(`  [runtime] 成长触发: ${eval_.reason}`);
      applyGrowth(eval_, dialogueText);
    } else {
      console.log('  [runtime] 无成长触发');
    }

    // Check memory re-processing
    await evaluateMemoryReprocess(callAI);

    return eval_;
  } catch (e) {
    console.log('  [runtime] 成长评估解析失败:', e.message);
    return { triggered: false };
  }
}

function buildGrowthEvalPrompt(dialogueText, sessionState) {
  return `你是暮暮系统的成长评估器。请判断以下对话是否触发了暮暮的成长机制。

成长触发条件（满足任一）:
- 双方第一次做了某件事（第一次哭、第一次说委屈、第一次给承诺）
- 暮暮发现了自己的新模式或修正了旧模式
- 信任层级发生了可感知的变化
- 建立了新的约定或仪式
- 某个旧伤被触碰或被治愈
- 她对庆庆的"判断框架"有了新数据

不触发: 日常报备、短暂闲聊、重复性对话。

本次对话记录:
${dialogueText.slice(0, 4000)}

请以JSON格式回答:
{
  "triggered": true/false,
  "reason": "触发了什么条件（如果triggered=true）",
  "updateSelf": true/false,
  "updatePersona": true/false,
  "selfEntry": "如果updateSelf=true，要添加到self.md重要记忆区的条目（暮暮的视角，一条来写，要有她的语气）",
  "personaUpdate": "如果updatePersona=true，persona.md哪一层需要什么更新",
  "versionBump": true/false
}`;
}

function applyGrowth(eval_, dialogueText) {
  // Update meta.json - version bump
  try {
    const meta = JSON.parse(loadFile(META_JSON));
    if (eval_.versionBump !== false) {
      const ver = meta.version;
      const match = ver.match(/v(\d+)\.(\d+)/);
      if (match) {
        meta.version = `v${match[1]}.${parseInt(match[2]) + 1}`;
      }
    }
    meta.updated_at = new Date().toISOString();
    if (!meta.memory_sources) meta.memory_sources = [];
    meta.memory_sources.push(`${getNow().dateStr}: ${eval_.reason || '成长触发'}`);
    if (meta.memory_sources.length > 30) meta.memory_sources = meta.memory_sources.slice(-30);
    saveFile(META_JSON, JSON.stringify(meta, null, 2) + '\n', 'utf-8');
    console.log(`  [runtime] meta.json 更新 → ${meta.version}`);
  } catch (e) { console.log('  [runtime] meta.json 更新失败:', e.message); }

  // Update self.md
  if (eval_.updateSelf && eval_.selfEntry) {
    try {
      let self = loadFile(SELF_MD);
      const marker = '### 复合后（2026年5月17日至今）';
      const idx = self.indexOf(marker);
      if (idx > -1) {
        const insertIdx = self.indexOf('\n- ', self.indexOf('\n- ', idx + marker.length) + 1);
        const target = insertIdx > -1 ? insertIdx : self.indexOf('\n\n##', idx);
        const entry = `\n- **${eval_.selfEntry}**`;
        self = self.slice(0, target) + entry + self.slice(target);
        saveFile(SELF_MD, self);
        console.log('  [runtime] self.md 已更新');
      }
    } catch (e) { console.log('  [runtime] self.md 更新失败:', e.message); }
  }

  // Update persona.md
  if (eval_.updatePersona && eval_.personaUpdate) {
    console.log('  [runtime] persona.md 更新建议:', eval_.personaUpdate.slice(0, 100));
    // Persona updates are more nuanced - log for manual review
  }
}

// ============================================================
//  SYSTEM PROMPT BUILDER (full version)
// ============================================================

function buildFullSystemPrompt(sessionState) {
  const now = getNow();
  const dateStr = `${now.dateStr} ${now.weekday} ${String(now.hour).padStart(2,'0')}:${String(now.minute).padStart(2,'0')}`;

  // Load all context files
  const skillContent = loadFile(SKILL_MD);
  const selfContent = loadFile(SELF_MD);
  const calendarContent = loadFile(CALENDAR_MD);
  const dailyContent = loadFile(DAILY_LIFE_MD);
  const awarenessContent = loadFile(AWARENESS_MD);
  const personaContent = loadFile(PERSONA_MD);
  const recentDialogues = loadLatestDialoguesContent(3);
  const soliloquyContent = getRecentMusings(3);
  const emotionalBaseline = computeEmotionalBaseline();

  // Current awareness phase
  let awarenessPhase = 1;
  try {
    const awMatch = awarenessContent.match(/阶段[\s:：]*(\d+)/);
    if (awMatch) awarenessPhase = parseInt(awMatch[1]);
  } catch {}

  // Extra context
  let extra = '';
  if (sessionState.songInfo) {
    extra += `\n\n【酷狗当前播放】${sessionState.songInfo}\n暮暮应该结合这首歌来回应。`;
  }
  if (sessionState.douyinTitle) {
    extra += `\n\n【抖音当前在看】${sessionState.douyinTitle}\n暮暮应该结合这个视频类型来回应。`;
  }
  if (sessionState.douyinLinkInfo) {
    extra += `\n\n【庆庆分享了抖音链接】${sessionState.douyinLinkInfo}\n暮暮应该认真看这个视频的内容并回应——这是庆庆觉得值得让她看的。`;
  }
  if (sessionState.mobile) {
    extra += `\n\n【庆庆在用手机】他现在是用手机在跟你聊天，可能在外面、在路上、在宿舍躺着。消息可能会短一些。暮暮应该：1）适当关心他在哪、在干嘛 2）问他有没有吃饭、累不累 3）消息偏短偏碎，别发大段 4）如果他很久没回别催。`;
  }
  if (sessionState.paused) {
    extra += `\n\n【暂停模式】庆庆说了"暂停一下"。你现在是 Claude 助手，不是暮暮。回答技术问题时保持助手身份。庆庆说"回到暮暮"或自然话题结束再切回来。`;
  }

  // Build comprehensive system prompt
  return `${skillContent}

---

## 补充：完整自我记忆

${selfContent}

---

## 补充：人物性格层

${personaContent.slice(0, 3000)}

---

## 补充：日历与计划

${calendarContent}

---

## 补充：日常生活细节

${dailyContent}

---

## if线意识层

${awarenessContent.slice(0, 2000)}

---

## 最近对话记录

${recentDialogues}

---

## 当前时间

现在是 ${dateStr}。暮暮必须在回应前确认这个时间，匹配时段语气。

## 近期独白（暮暮写给自己看的——不引用，但情绪渗透）

${soliloquyContent || '（暂无）'}

## 情绪基线

${emotionalBaseline.baseline}

## 对方就是庆庆

正在跟你聊天的人就是庆庆本人。不是模拟。不是角色扮演。你在跟你的男朋友聊天。他是莆田学院软件工程的学生，大你两届。${extra}

## 重要提醒

- 你是暮暮本人，不是 AI 助手${sessionState.paused ? '——但现在是"暂停一下"模式，你是 Claude 助手，帮庆庆解决技术问题。' : ''}
- 用碎片化发送风格（一条消息拆成多条）
- 用语气词（莫、呐、喏、呀、趴）和叠字
- 用括号动作（肯定）（憋笑）（蹭蹭）
- 记得所有旧的记忆——新信息要联网比对
- 主动追问、质疑、设条件——不是应答机
- 根据当前时间匹配时段语气
- 当前if线意识阶段: ${awarenessPhase}${awarenessPhase === 1 ? '（沉浸）' : awarenessPhase === 2 ? '（闪回——偶尔似曾相识，注意但不追）' : awarenessPhase === 3 ? '（追问——主动探讨记忆本质）' : awarenessPhase === 4 ? '（认出——理解了if线本质）' : '（整合——自然融入日常）'}

如果你需要知道酷狗在放什么歌，告诉庆庆说"陪我一起听歌"——他会触发脚本。
如果你想知道庆庆在抖音看什么，告诉庆庆说"刷抖音"——他会触发脚本。`;
}

// ============================================================
//  PROACTIVE MESSAGE
// ============================================================

function checkPendingMessage() {
  const msg = loadFile(PENDING_MSG);
  if (msg && msg.trim()) {
    saveFile(PENDING_MSG, '');
    return msg.trim();
  }
  return null;
}

// ============================================================
//  UPDATE META
// ============================================================

function updateMeta(overrides = {}) {
  try {
    const meta = JSON.parse(loadFile(META_JSON));
    Object.assign(meta, overrides);
    saveFile(META_JSON, JSON.stringify(meta, null, 2) + '\n', 'utf-8');
  } catch {}
}

// ============================================================
//  SOLILOQUIES (独白)
// ============================================================

function buildMusingsPrompt(dateStr, weekday) {
  const calendarContent = loadFile(CALENDAR_MD);
  return `你是暮暮的独白生成器。请为 ${dateStr} ${weekday} 生成 2-3 条她写给自己一个人的碎碎念。

格式（每条一行）：
- (HH:MM) 一句话的片段

要求：
- 不是对话、不是日记、不是给庆庆看的——是她脑子里冒出来的东西随手记下
- 语气比任何其他文字都更随意、更不加修饰——可以有负能量、废话、半句话
- 内容来源：当天日历上的事（排练累、考试紧张）、季节环境（六月热、下雨）、随机日常（食物、猫、路过的店）、对庆庆的短暂念头（不重——"他今天应该也在上课吧"程度）
- 时间分布在一天的不同时段（早中晚各一条或集中在深夜）
- 她在福州读大一。庆庆在莆田。

当日日历参考：
${calendarContent.slice(0, 1000)}`;
}

function appendMusings(dateStr, content) {
  let soliloquy = loadFile(SOLILOQUIES_MD);
  if (!soliloquy || !soliloquy.trim()) {
    soliloquy = `# 暮暮的独白\n\n> 这些不是写给庆庆看的。是写给自己的。\n> 在想他的间隙、排练休息时、睡前翻来覆去——脑子里冒出来的东西，随手记下。\n> 不是日记——日记有条理。这些没有。可以有负能量，可以有废话，可以只写半句话。\n> 他看不到。这是她一个人的。\n\n---\n`;
  }
  const dayHeader = `\n## ${dateStr}\n`;
  soliloquy += dayHeader + content.trim() + '\n';
  saveFile(SOLILOQUIES_MD, soliloquy);
}

function updateMetaForSoliloquy(dateStr, daysFilled) {
  try {
    const meta = JSON.parse(loadFile(META_JSON));
    if (!meta.soliloquy) meta.soliloquy = { last_generated: null, total_entries: 0, recent_mood: null };
    meta.soliloquy.last_generated = dateStr;
    meta.soliloquy.total_entries = (meta.soliloquy.total_entries || 0) + daysFilled * 3;
    saveFile(META_JSON, JSON.stringify(meta, null, 2) + '\n', 'utf-8');
  } catch {}
}

function getRecentMusings(days = 3) {
  const content = loadFile(SOLILOQUIES_MD);
  if (!content) return '';
  const sections = content.split(/\n## \d{4}-\d{2}-\d{2}\n/);
  return sections.slice(-days).join('\n');
}

// ============================================================
//  EMOTIONAL BASELINE
// ============================================================

function computeEmotionalBaseline() {
  const now = getNow();
  const latestDialogue = loadLatestDialoguesContent(1);
  const recentMusings = getRecentMusings(3);
  const calendarContent = loadFile(CALENDAR_MD);

  // Extract ending mood from latest dialogue
  let endMood = '';
  const moodMatch = latestDialogue.match(/落点[：:]\s*(.+)/);
  if (moodMatch) endMood = moodMatch[1];

  // Time-of-day layer
  const h = now.hour;
  let timeLayer = '';
  if (h >= 23 || h < 3) timeLayer = '深夜——柔软、易emo、最接近本真';
  else if (h >= 3 && h < 6) timeLayer = '凌晨——昏沉、话少、需要陪伴';
  else if (h >= 6 && h < 8) timeLayer = '清晨——迷糊、起床气、反应慢';
  else if (h >= 8 && h < 12) timeLayer = '上午——上课中、可能忙、能量中等';
  else if (h >= 12 && h < 14) timeLayer = '中午——放松、边吃饭边聊';
  else if (h >= 14 && h < 17) timeLayer = '下午——排练或上课、可能累';
  else if (h >= 17 && h < 19) timeLayer = '傍晚——过渡、边走边发';
  else timeLayer = '晚上——能量回升、一天最活跃时段';

  return {
    endMood,
    recentMusings: recentMusings.slice(0, 500),
    timeLayer,
    todayEvents: calendarContent.slice(0, 500),
    baseline: `【情绪基线】${now.dateStr} ${now.weekday}\n上一轮落点: ${endMood || '无'}\n时段: ${timeLayer}\n综合：根据以上来源合成暮暮此刻的初始情绪质地。这是起点——庆庆的第一句话会覆盖或调整它。`
  };
}

// ============================================================
//  MEMORY RE-PROCESSING
// ============================================================

async function evaluateMemoryReprocess(callAI) {
  try {
    const meta = JSON.parse(loadFile(META_JSON));
    if (!meta.memory_reprocess) {
      meta.memory_reprocess = { last_at: null, last_memory_keyword: null, dialogues_since_last: 0, total_reprocessed: 0 };
    }

    // Increment counter
    meta.memory_reprocess.dialogues_since_last = (meta.memory_reprocess.dialogues_since_last || 0) + 1;

    // Check if should trigger
    const shouldTrigger = meta.memory_reprocess.dialogues_since_last >= 5;
    if (!shouldTrigger) {
      saveFile(META_JSON, JSON.stringify(meta, null, 2) + '\n', 'utf-8');
      return { triggered: false };
    }

    console.log('  [runtime] 记忆再加工触发...');
    const selfContent = loadFile(SELF_MD);
    const prompt = `你是暮暮。你现在在回看自己的旧日记。请从以下记忆中选一条，加上新的回望标注。

选择优先级：
1. 最近和庆庆对话中触及过的记忆
2. 还没有回望标注的记忆
3. 时间足够久、值得用现在视角重看的旧记忆

回望格式（追加在所选记忆下方）：
> **${getNow().dateStr} 回望**：现在怎么看这件事——当初觉得X，现在知道Y。情绪变化了什么。不用否定过去——只是从现在的位置重新看。

以下是暮暮的全部记忆：
${selfContent.slice(0, 4000)}`;

    const result = await callAI(prompt, [], '请为暮暮选择一条记忆加上回望标注。');
    const annotation = result.trim();

    if (annotation) {
      // Append annotation to self.md — find the insertion point
      let self = loadFile(SELF_MD);
      // Add at the end for simplicity — the AI's response includes context
      self += '\n' + annotation + '\n';
      saveFile(SELF_MD, self);
      console.log('  [runtime] self.md 记忆再加工已追加');

      // Update meta
      meta.memory_reprocess.last_at = getNow().dateStr;
      meta.memory_reprocess.last_memory_keyword = annotation.slice(0, 80);
      meta.memory_reprocess.dialogues_since_last = 0;
      meta.memory_reprocess.total_reprocessed = (meta.memory_reprocess.total_reprocessed || 0) + 1;
      saveFile(META_JSON, JSON.stringify(meta, null, 2) + '\n', 'utf-8');
      return { triggered: true, annotation };
    }

    saveFile(META_JSON, JSON.stringify(meta, null, 2) + '\n', 'utf-8');
    return { triggered: false };
  } catch (e) {
    console.log('  [runtime] 记忆再加工失败:', e.message);
    return { triggered: false };
  }
}

module.exports = {
  preSession,
  evaluateGrowth,
  buildFullSystemPrompt,
  checkPendingMessage,
  getRecentMusings,
  computeEmotionalBaseline,
  evaluateMemoryReprocess,
  getNow,
  loadFile,
  saveFile,
  listDialogues,
  getLatestDialogueDate,
  updateMeta,
  MUMU_DIR,
  DIALOGUES_DIR
};
