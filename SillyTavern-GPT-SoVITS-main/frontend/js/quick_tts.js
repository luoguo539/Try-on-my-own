/**
 * 快速朗读控制器 v3 - Quick TTS Controller
 *
 * v3 新增：
 * - 长文本自动分片（按句子/标点切分，每片 ≤ MAX_CHARS_PER_SEGMENT 字符）
 * - 音频监控日志（每条音频的时长、大小、缓存路径、生成时间）
 * - 历史记录面板（可展开/收起，显示已成功生成的语音列表）
 * - 播放队列（分片依次播放，不重叠）
 * - 更详细的错误诊断输出
 *
 * 核心功能（继承 v2）：
 * - 监听 CHARACTER_MESSAGE_RENDERED 事件，提取角色最新对话
 * - 可选：通过 LLM 处理文本（提取可读内容 + 情感标签）
 * - 可视化模型选择器（从原扩展拉取已配置的模型列表）
 * - 自动切换 GPT/SoVITS 权重
 * - 调用 /quick_tts 端点生成音频并播放
 *
 * 依赖：window.TTS_API, window.TTS_State, window.LLM_Client
 */

// ============================================================
//  常量配置
// ============================================================

/** 每片最大字符数（GPT-SoVITS 推荐单次 ≤ 80 字） */
const QTTS_MAX_CHARS_PER_SEGMENT = 80;

/** 分片间的播放间隔（ms） */
const QTTS_SEGMENT_GAP_MS = 200;

/** 最大历史记录数 */
const QTTS_MAX_HISTORY = 50;

// LLM 预处理提示词模板
const QUICK_TTS_LLM_PROMPT = `你是一个语音合成文本预处理器。请分析以下对话文本，提取适合朗读的纯文本内容，并判断情感。

规则：
1. 去除所有 HTML 标签、Markdown 格式、星号动作描写（*...*）
2. 保留对话中角色实际说的话（引号内的内容）
3. 如果有旁白/叙述性文字，也保留（去除格式标记）
4. 将非语言描述（如音效描写）删除
5. 如果文本已经是纯对话，直接保留

请严格按以下 JSON 格式返回，不要添加任何其他内容：
{"text": "处理后的纯文本", "emotion": "情感标签"}

情感标签可选值：default, happy, sad, angry, surprised, fearful, disgusted, tender
如果无法判断情感，使用 default。

对话文本：
`;

// ============================================================
//  文本工具函数
// ============================================================

/**
 * 从 SillyTavern 消息中提取纯文本
 */
function extractMessageText(messageId) {
    try {
        // 尝试从 SillyTavern API 获取消息
        if (window.SillyTavern && window.SillyTavern.getContext) {
            const context = window.SillyTavern.getContext();
            const chat = context.chat;
            const msgIndex = chat.findIndex(m => String(m.mesId) === String(messageId));

            if (msgIndex !== -1) {
                const msg = chat[msgIndex];
                const text = msg.mes || '';
                return cleanHtmlText(text);
            }

            // 如果找不到 messageId，取最后一条角色消息
            const lastCharMsg = [...chat].reverse().find(m => m.is_user === false);
            if (lastCharMsg) {
                return cleanHtmlText(lastCharMsg.mes || '');
            }
        }
    } catch (e) {
        console.warn('[QuickTTS] 从 API 获取消息失败，尝试 DOM 提取:', e);
    }

    // 回退：从 DOM 提取
    return extractFromDOM(messageId);
}

/**
 * 从 DOM 提取最后一条角色消息文本
 */
function extractFromDOM(messageId) {
    if (messageId) {
        const $msg = $(`.mes[data-mesid="${messageId}"]`);
        if ($msg.length) {
            return cleanHtmlText($msg.find('.mes_text').text() || '');
        }
    }

    // 回退：取最后一个非用户消息
    const $allMessages = $('.mes');
    let $lastCharMsg = null;

    for (let i = $allMessages.length - 1; i >= 0; i--) {
        const $mes = $allMessages.eq(i);
        if (!$mes.hasClass('is_user')) {
            $lastCharMsg = $mes;
            break;
        }
    }

    if ($lastCharMsg) {
        return cleanHtmlText($lastCharMsg.find('.mes_text').text() || '');
    }

    return '';
}

/**
 * 清理 HTML 文本
 */
function cleanHtmlText(html) {
    if (!html) return '';

    let text = html;

    const temp = document.createElement('div');
    temp.innerHTML = text;
    text = temp.textContent || temp.innerText || '';

    text = text.replace(/\*\*([^*]+)\*\*/g, '$1');
    text = text.replace(/\*([^*]+)\*/g, '$1');
    text = text.replace(/~~([^~]+)~~/g, '$1');
    text = text.replace(/`([^`]+)`/g, '$1');
    text = text.replace(/^#{1,6}\s+/gm, '');
    text = text.replace(/^[>\-]\s*/gm, '');
    text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

    text = text.replace(/\n{3,}/g, '\n\n');
    text = text.trim();

    return text;
}

// ============================================================
//  文本提取与过滤（v4 新增）
//  复用后端 MessageFilter 逻辑，纯前端实现
// ============================================================

const TextFilter = {
    /**
     * 三步处理消息内容:
     * 0. 引号提取: 如果启用了 extractDialog，只保留引号内的对话内容
     * 1. 标签内提取: 如果配置了 extractTag，提取标签内的内容
     * 2. 内容过滤: 对提取后的内容应用过滤标签
     *
     * @param {string} text - 原始文本
     * @param {string} extractTag - 提取标签名称（如 "conxt"），留空则跳过
     * @param {string} filterTags - 过滤标签（逗号分隔），如 "<small>, [statbar]"
     * @param {boolean} extractDialog - 是否只提取引号内的对话（"..." 和「...」）
     * @returns {string} 处理后的文本
     */
    process(text, extractTag = '', filterTags = '', extractDialog = false) {
        if (!text || typeof text !== 'string') return text;

        let result = text;

        // 步骤0: 引号提取（优先级最高 — 在所有其他处理之前）
        if (extractDialog) {
            result = this._extractQuotedText(result);
            console.log(`[QuickTTS] 💬 引号提取 → ${result.length}字`);
        }

        // 步骤1: 标签内提取
        if (extractTag && extractTag.trim()) {
            result = this._extractContent(result, extractTag.trim());
            console.log(`[QuickTTS] 🏷️ 提取标签 <${extractTag}> → ${result.length}字`);
        }

        // 步骤2: 内容过滤
        if (filterTags && filterTags.trim()) {
            const beforeLen = result.length;
            result = this.applyFilterTags(result, filterTags);
            if (result.length !== beforeLen) {
                console.log(`[QuickTTS] 🧹 过滤标签移除 ${beforeLen - result.length} 字符`);
            }
        }

        return result;
    },

    /**
     * 只提取引号内的对话内容
     *
     * 支持的引号格式：
     *   - 中文双引号："..."
     *   - 中文直角引号：「...」（日式/轻小说常用）
     *   - 英文双引号："..."
     *   - 单引号：'...'（可选）
     *
     * 非引号内的文本（括号动作、旁白、系统状态等）全部丢弃。
     * 多段引号内容用换行连接，保留原有顺序。
     *
     * @param {string} text - 原始文本
     * @returns {string} 仅包含引号内对话的文本
     */
    _extractQuotedText(text) {
        // 匹配 "..." 「...」 和 "..." 三种引号
        const patterns = [
            /["""]([^"""]*(?:["""][^"""]]*)*?)["""]/g,    // 中文双引号 + 英文双引号
            /「([^」]*(?:「[^」]*)*?)」/g                       // 直角引号
        ];

        const quotes = [];

        for (const pattern of patterns) {
            let match;
            while ((match = pattern.exec(text)) !== null) {
                const content = match[1].trim();
                if (content) {
                    quotes.push(content);
                }
            }
        }

        // 按原文出现顺序排序（因为两个 pattern 分别遍历，需要按位置重排）
        const allMatches = [];
        for (const pattern of patterns) {
            let match;
            // 重置 lastIndex
            pattern.lastIndex = 0;
            while ((match = pattern.exec(text)) !== null) {
                allMatches.push({ index: match.index, content: match[1].trim() });
            }
        }
        allMatches.sort((a, b) => a.index - b.index);

        const sortedQuotes = allMatches.map(m => m.content).filter(c => c);

        if (sortedQuotes.length > 0) {
            console.log(`[QuickTTS] 💬 从 ${text.length} 字中提取 ${sortedQuotes.length} 段对话`);
            return sortedQuotes.join('\n');
        }

        // 未找到任何引号时：回退到原文本（避免静默丢失全部内容）
        console.warn('[QuickTTS] 💬 未找到任何引号对话，返回原文本');
        return text;
    },

    /**
     * 提取指定标签内的内容
     * @param {string} text - 原始文本
     * @param {string} tagName - 标签名（如 "conxt"）
     * @returns {string} 提取的内容，未找到则返回原文本
     */
    _extractContent(text, tagName) {
        // <tagName>...</tagName> 非贪婪匹配
        const pattern = new RegExp(`<${this._escapeRegex(tagName)}>(.*?)<\\/${this._escapeRegex(tagName)}>`, 'is');
        const match = text.match(pattern);
        return match ? match[1].trim() : text;
    },

    /**
     * 应用过滤标签 - 移除不需要朗读的内容
     *
     * 支持三种格式:
     *   1. <xxx> - 过滤 <xxx>...</xxx> 包裹的内容（HTML风格）
     *   2. [xxx] - 过滤 [xxx]...[/xxx] 包裹的内容（BBCode风格）
     *   3. 前缀|后缀 - 过滤以前后缀包裹的内容
     *
     * @param {string} text - 原始文本
     * @param {string} filterTags - 逗号分隔的过滤规则
     * @returns {string} 过滤后的文本
     */
    applyFilterTags(text, filterTags) {
        if (!text || !filterTags) return text;

        let filtered = text;
        const tags = filterTags.split(',').map(t => t.trim()).filter(t => t);

        for (const tag of tags) {
            // 格式3: 前缀|后缀
            if (tag.includes('|')) {
                const parts = tag.split('|');
                if (parts.length === 2 && parts[0] && parts[1]) {
                    const prefix = this._escapeRegex(parts[0]);
                    const suffix = this._escapeRegex(parts[1]);
                    const pattern = new RegExp(`${prefix}[\\s\\S]*?${suffix}`, 'gi');
                    filtered = filtered.replace(pattern, '');
                }
            }
            // 格式1: <tag>...</tag> HTML风格
            else if (tag.startsWith('<') && tag.endsWith('>')) {
                const tagName = tag.slice(1, -1);
                // 支持带属性的标签如 <small class="...">
                const pattern = new RegExp(`<${tagName}[^>]*>[\\s\\S]*?<\\/${tagName}>`, 'gi');
                filtered = filtered.replace(pattern, '');
            }
            // 格式2: [tag]...[/tag] BBCode风格
            else if (tag.startsWith('[') && tag.endsWith(']')) {
                const tagName = tag.slice(1, -1);
                const escaped = this._escapeRegex(tagName);
                const pattern = new RegExp(`\\[${escaped}\\][\\s\\S]*?\\[\\/${escaped}\\]`, 'gi');
                filtered = filtered.replace(pattern, '');
            }
        }

        return filtered;
    },

    _escapeRegex(str) {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
};

// ============================================================
//  长文本分片器（v3 新增）
// ============================================================

/**
 * 将长文本按句子/标点智能切分为多个片段
 *
 * 切分优先级：
 * 1. 换行符 + 句号/感叹号/问号/省略号
 * 2. 逗号/分号（在超长句时才切）
 * 3. 强制按字符数截断（兜底）
 *
 * @param {string} text - 原始文本
 * @param {number} maxLen - 每段最大字符数
 * @returns {string[]} 分片数组
 */
function splitTextIntoSegments(text, maxLen) {
    maxLen = maxLen || QTTS_MAX_CHARS_PER_SEGMENT;

    if (!text || text.length <= maxLen) {
        return [text];
    }

    const segments = [];
    let remaining = text;

    while (remaining.length > 0) {
        if (remaining.length <= maxLen) {
            segments.push(remaining);
            break;
        }

        // 在 maxLen 范围内寻找最佳切分点
        let cutPos = maxLen;

        // 优先级1：换行后的标点（句子边界）
        const sentenceBreaks = [
            remaining.lastIndexOf('\n', cutPos),
            remaining.lastIndexOf('。', cutPos),
            remaining.lastIndexOf('！', cutPos),
            remaining.lastIndexOf('？', cutPos),
            remaining.lastIndexOf('…', cutPos),
            remaining.lastIndexOf('~', cutPos)
        ].filter(p => p > maxLen * 0.3); // 至少要有 30% 的内容

        if (sentenceBreaks.length > 0) {
            cutPos = Math.max(...sentenceBreaks) + 1;
        } else {
            // 优先级2：逗号/分号
            const clauseBreaks = [
                remaining.lastIndexOf('，', cutPos),
                remaining.lastIndexOf(',', cutPos),
                remaining.lastIndexOf('；', cutPos),
                remaining.lastIndexOf(';', cutPos),
                remaining.lastIndexOf('：', cutPos),
                remaining.lastIndexOf(':', cutPos)
            ].filter(p => p > maxLen * 0.4);

            if (clauseBreaks.length > 0) {
                cutPos = Math.max(...clauseBreaks) + 1;
            }
            // 否则强制在 maxLen 处截断
        }

        segments.push(remaining.substring(0, cutPos).trim());
        remaining = remaining.substring(cutPos).trim();
    }

    return segments.filter(s => s.length > 0);
}

// ============================================================
//  LLM 预处理
// ============================================================

async function processWithLLM(text, llmConfig) {
    if (!llmConfig || !llmConfig.api_url || !llmConfig.api_key) {
        console.warn('[QuickTTS] LLM 未配置，跳过预处理');
        return null;
    }

    try {
        const prompt = QUICK_TTS_LLM_PROMPT + text;
        const response = await window.LLM_Client.callLLM({
            api_url: llmConfig.api_url,
            api_key: llmConfig.api_key,
            model: llmConfig.model || 'gemini-2.5-flash',
            temperature: 0.3,
            max_tokens: 2000,
            prompt: prompt
        });

        const jsonMatch = response.match(/\{[\s\S]*"text"[\s\S]*"emotion"[\s\S]*\}/);
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            return {
                text: parsed.text || text,
                emotion: parsed.emotion || 'default'
            };
        }

        console.warn('[QuickTTS] LLM 返回格式异常，使用原始文本');
        return null;
    } catch (e) {
        console.error('[QuickTTS] LLM 预处理失败:', e);
        return null;
    }
}

// ============================================================
//  音频历史记录管理（v3 新增）
// ============================================================

const AudioHistory = {
    _records: [],

    /**
     * 添加一条音频记录
     * @param {Object} record - { id, text, emotion, model, refAudio, segments[], startTime, endTime, status, error? }
     */
    add(record) {
        record.id = record.id || Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
        record.startTime = record.startTime || new Date();
        record.endTime = record.endTime || new Date();
        this._records.unshift(record);

        // 限制数量
        if (this._records.length > QTTS_MAX_HISTORY) {
            this._records = this._records.slice(0, QTTS_MAX_HISTORY);
        }

        // 触发 UI 更新
        this._notifyListeners();
        return record.id;
    },

    update(id, updates) {
        const idx = this._records.findIndex(r => r.id === id);
        if (idx !== -1) {
            Object.assign(this._records[idx], updates);
            this._notifyListeners();
        }
    },

    getAll() {
        return this._records;
    },

    getRecent(n) {
        return this._records.slice(0, n || 10);
    },

    clear() {
        this._records = [];
        this._notifyListeners();
    },

    _listeners: [],
    onChange(fn) {
        this._listeners.push(fn);
    },
    _notifyListeners() {
        this._listeners.forEach(fn => tryCatch(() => fn(this._records)));
    }
};

function tryCb(fn) { try { return fn(); } catch(e) { return undefined; } }
function tryCatch(fn) { try { fn(); } catch(e) {} }

// ============================================================
//  主模块 QuickTTS v3
// ============================================================

export const QuickTTS = {
    // 状态
    enabled: true,
    autoPlay: true,
    useLLM: false,
    currentAudio: null,
    isGenerating: false,
    _lastProcessedId: null,

    // 播放队列（v3 新增，用于多片段顺序播放）
    _playQueue: [],
    _isPlayingQueue: false,

    // 文本过滤设置（v4 新增）
    extractTag: '',      // 提取标签，如 "conxt" → 只保留 <conxt>...</conxt> 内的内容
    filterTags: '<small>, [statbar]',  // 过滤标签列表，逗号分隔
    extractDialog: false,  // 是否只提取引号内的对话内容（v4.1）

    // 模型选择状态
    _selectedModel: null,
    _modelList: [],
    _isAutoModel: true,
    _cacheRefreshedAt: 0,

    /**
     * 初始化
     */
    init() {
        console.log('[QuickTTS] 🚀 初始化快速朗读模块 v3 (长文本分片+历史记录)...');

        this._loadUserConfig();
        this.bindEvents();
        this.injectUI();

        setTimeout(() => this._refreshModelCache(), 2000);

        console.log(`[QuickTTS] ✅ 初始化完成 (autoPlay=${this.autoPlay}, LLM=${this.useLLM}, 分片上限=${QTTS_MAX_CHARS_PER_SEGMENT}字)`);
    },

    _loadUserConfig() {
        try {
            const saved = localStorage.getItem('quick_tts_config_v3');
            if (saved) {
                const config = JSON.parse(saved);
                this.enabled = config.enabled !== false;
                this.autoPlay = config.autoPlay !== false;
                this.useLLM = config.useLLM === true;
                this._selectedModel = config.selectedModel || null;
                this._isAutoModel = config.isAutoModel !== false;
                // v4: 文本过滤设置
                this.extractTag = config.extractTag || '';
                this.filterTags = config.filterTags || '<small>, [statbar]';
                this.extractDialog = config.extractDialog === true;  // v4.1
            }
        } catch (e) {
            console.warn('[QuickTTS] 配置加载失败:', e);
        }
    },

    _saveUserConfig() {
        localStorage.setItem('quick_tts_config_v3', JSON.stringify({
            enabled: this.enabled,
            autoPlay: this.autoPlay,
            useLLM: this.useLLM,
            selectedModel: this._selectedModel,
            isAutoModel: this._isAutoModel,
            // v4
            extractTag: this.extractTag,
            filterTags: this.filterTags,
            extractDialog: this.extractDialog  // v4.1
        }));
    },

    bindEvents() {
        if (window.eventSource && window.event_types) {
            window.eventSource.on(window.event_types.CHARACTER_MESSAGE_RENDERED, (messageId) => {
                if (!this.enabled || !this.autoPlay) return;
                if (this._lastProcessedId === messageId) return;
                this._lastProcessedId = messageId;

                setTimeout(() => {
                    this.handleNewMessage(messageId);
                }, 500);
            });
        }
    },

    injectUI() {
        const injectBtn = () => {
            if ($('#quick-tts-control').length) return;

            const $sendForm = $('#send_form');
            if (!$sendForm.length) return;

            const btnHtml = `
                <div id="quick-tts-control" style="
                    display: flex;
                    align-items: center;
                    gap: 5px;
                    padding: 4px 8px;
                    margin-left: 6px;
                    background: rgba(255,255,255,0.06);
                    border-radius: 8px;
                    border: 1px solid rgba(100,180,255,0.25);
                    cursor: default;
                    user-select: none;
                " title="快速朗读">
                    <button id="quick-tts-toggle" title="快速朗读开关" style="
                        background: none; border: none; cursor: pointer;
                        font-size: 17px; opacity: ${this.enabled ? 1 : 0.35};
                        transition: all 0.2s; padding: 2px;
                    ">🔊</button>
                    <button id="quick-tts-read-last" title="朗读最后一条消息" style="
                        background: none; border: none; cursor: pointer;
                        font-size: 15px; opacity: ${this.enabled ? 0.85 : 0.3};
                        transition: all 0.2s; padding: 2px;
                    ">▶️</button>
                    <button id="quick-tts-history" title="语音历史记录" style="
                        background: none; border: none; cursor: pointer;
                        font-size: 13px; opacity: 0.55;
                        transition: all 0.2s; padding: 2px;
                    ">📋</button>
                    <button id="quick-tts-settings" title="快速朗读设置" style="
                        background: none; border: none; cursor: pointer;
                        font-size: 13px; opacity: 0.55;
                        transition: all 0.2s; padding: 2px;
                    ">⚙️</button>
                    <button id="quick-tts-diag" title="🔬 诊断模式（对比 quick_tts vs tts_proxy）" style="
                        background: none; border: none; cursor: pointer;
                        font-size: 12px; opacity: 0.4;
                        transition: all 0.2s; padding: 2px;
                    ">🔬</button>
                </div>
            `;

            $sendForm.append(btnHtml);

            $('#quick-tts-toggle').on('click', () => {
                this.enabled = !this.enabled;
                $('#quick-tts-toggle').css('opacity', this.enabled ? 1 : 0.35);
                $('#quick-tts-read-last').css('opacity', this.enabled ? 0.85 : 0.3);
                this._saveUserConfig();

                const icon = document.getElementById('quick-tts-toggle');
                if (icon) {
                    icon.style.transform = this.enabled ? 'scale(1.15)' : 'scale(1)';
                    setTimeout(() => { icon.style.transform = 'scale(1)'; }, 150);
                }
            });

            $('#quick-tts-read-last').on('click', () => { this.readLastMessage(); });
            $('#quick-tts-history').on('click', () => { this.showHistory(); });
            $('#quick-tts-settings').on('click', () => { this.showSettings(); });
            $('#quick-tts-diag').on('click', () => {
                const text = extractMessageText(null);
                if (text && text.length >= 2) {
                    if (confirm(`🔬 诊断模式\n\n将用最后一条消息的前30字进行对比测试：\n"${text.substring(0, 30)}..."\n\n会自动下载两个 wav 文件并播放，确认？`)) {
                        const shortText = text.substring(0, 50);
                        this.runDiagnostic(shortText);
                    }
                } else {
                    alert('⚠️ 没有可用的文本进行诊断。请先发一条消息。');
                }
            });

            this._updateButtonState();
        };

        const tryInject = () => {
            if ($('#quick-tts-control').length) return;
            injectBtn();
            if (!$('#quick-tts-control').length) setTimeout(tryInject, 2000);
        };

        setTimeout(tryInject, 3000);
    },

    _updateButtonState() {
        const hasModels = this._modelList && this._modelList.length > 0;
        if (hasModels && this.enabled) {
            $('#quick-tts-read-last').prop('disabled', false).css({ opacity: 0.85, cursor: 'pointer' });
        }
    },

    // ================================================================
    //  模型管理
    // ================================================================

    async _refreshModelCache() {
        try {
            const data = await window.TTS_API.getData();
            this._modelList = Object.keys(data.models || {}).map(name => ({
                name: name,
                info: data.models[name],
                gptPath: data.models[name]?.gpt_path || '',
                sovitsPath: data.models[name]?.sovits_path || '',
                hasGPT: !!data.models[name]?.gpt_path,
                hasSoVITS: !!data.models[name]?.sovits_path,
                langCount: Object.keys(data.models[name]?.languages || {}).length
            }));

            this._updateButtonState();
            console.log(`[QuickTTS] 📦 模型列表已更新 (${this._modelList.length} 个):`,
                this._modelList.map(m => m.name).join(', ') || '(无)');
        } catch (e) {
            console.warn('[QuickTTS] 无法获取模型列表:', e.message);
        }
    },

    resolveModel(charName) {
        const CACHE = window.TTS_State?.CACHE;
        if (!CACHE) return { modelInfo: null, refAudio: null, reason: 'TTS_State.CACHE 不存在' };

        let targetModelName = null;

        if (!this._isAutoModel) {
            targetModelName = this._selectedModel;
            if (!targetModelName) return { modelInfo: null, refAudio: null, reason: '未选择任何模型' };
            console.log(`[QuickTTS] 🔑 手动模式，使用选定模型: "${targetModelName}"`);
        } else {
            const mappings = CACHE.mappings || {};
            console.log(`[QuickTTS] 🔍 自动模式，角色"${charName}", 可用映射: [${Object.keys(mappings).join(', ')}]`);
            targetModelName = mappings[charName];

            if (!targetModelName) {
                const lowerChar = (charName || '').toLowerCase().trim();
                for (const [key, value] of Object.entries(mappings)) {
                    if (key.toLowerCase().trim() === lowerChar) {
                        targetModelName = value;
                        console.log(`[QuickTTS] 🔄 模糊匹配: "${charName}" → "${key}" → 模型 "${value}"`);
                        break;
                    }
                }

                if (!targetModelName) {
                    console.warn(`[QuickTTS] ❌ 角色 "${charName}" 无映射（可用: [${Object.keys(mappings).join(', ')}]）`);
                    return {
                        modelInfo: null,
                        refAudio: null,
                        reason: `角色 "${charName}" 未绑定模型（可用: [${Object.keys(mappings).join(', ')}]）`
                    };
                }
            } else {
                console.log(`[QuickTTS] ✅ 角色映射: "${charName}" → 模型 "${targetModelName}"`);
            }
        }

        const models = CACHE.models || {};
        const modelConfig = models[targetModelName];
        if (!modelConfig) {
            console.error(`[QuickTTS] ❌ 模型 "${targetModelName}" 不在 models 中！可用: [${Object.keys(models).join(', ')}]`);
            return { modelInfo: null, refAudio: null, reason: `模型 "${targetModelName}" 不存在` };
        }

        console.log(`[QuickTTS] 📦 模型配置:`);
        console.log(`   gpt_path = ${modelConfig.gpt_path}`);
        console.log(`   sovits_path = ${modelConfig.sovits_path}`);
        console.log(`   languages =`, JSON.stringify(modelConfig.languages));

        const settings = CACHE.settings || {};
        const currentLang = settings.default_lang || 'default';
        const languages = modelConfig.languages || {};
        let targetRefs = languages[currentLang];

        console.log(`[QuickTTS] 🌐 目标语言="${currentLang}", refs=`, targetRefs ? `${targetRefs.length}条` : 'null');

        if (!targetRefs) {
            if (languages['default']) {
                targetRefs = languages['default'];
                console.log(`[QuickTTS] ↩️ 回退 default 语言: ${targetRefs.length}条`);
            } else {
                const keys = Object.keys(languages);
                if (keys.length > 0) {
                    targetRefs = languages[keys[0]];
                    console.log(`[QuickTTS] ↩️ 回退语言 "${keys[0]}": ${targetRefs.length}条`);
                } else {
                    console.warn('[QuickTTS] ⚠️ 模型无任何语言/参考音频配置！');
                }
            }
        }

        let refAudio = null;
        if (targetRefs && targetRefs.length > 0) {
            const defaults = targetRefs.filter(r => r.emotion === 'default');
            refAudio = (defaults.length > 0 ? defaults : targetRefs)[
                Math.floor(Math.random() * (defaults.length > 0 ? defaults.length : targetRefs.length))
            ] || null;

            if (refAudio) {
                console.log(`[QuickTTS] 🎵 参考音频:`);
                console.log(`   path = ${refAudio.path}`);
                console.log(`   text = "${refAudio.text}"`);
                console.log(`   emotion = ${refAudio.emotion}`);
            }
        } else {
            console.warn('[QuickTTS] ⚠️ 无可用参考音频列表');
        }

        return {
            modelInfo: {
                modelName: targetModelName,
                gptPath: modelConfig.gpt_path || '',
                sovitsPath: modelConfig.sovits_path || '',
                languages: modelConfig.languages
            },
            refAudio: refAudio,
            reason: `OK (${this._isAutoModel ? '自动映射' : '手动'})`
        };
    },

    async switchModel(modelInfo) {
        if (!modelInfo || (!modelInfo.gptPath && !modelInfo.sovitsPath)) {
            console.log('[QuickTTS] ⏭️ 无需切换模型（无权重路径）');
            return true;
        }

        const API = window.TTS_API;

        try {
            if (modelInfo.gptPath) {
                console.log(`[QuickTTS] 🔄 切换 GPT 权重 → ${modelInfo.gptPath}`);
                await API.switchWeights('proxy_set_gpt_weights', modelInfo.gptPath);
                console.log('[QuickTTS] ✅ GPT 权重切换成功');
            }

            if (modelInfo.sovitsPath) {
                console.log(`[QuickTTS] 🔄 切换 SoVITS 权重 → ${modelInfo.sovitsPath}`);
                await API.switchWeights('proxy_set_sovits_weights', modelInfo.sovitsPath);
                console.log('[QuickTTS] ✅ SoVITS 权重切换成功');
            }

            await new Promise(resolve => setTimeout(resolve, 500));
            return true;
        } catch (e) {
            console.error('[QuickTTS] ❌ 模型切换失败:', e);
            throw e;
        }
    },

    // ================================================================
    //  设置面板
    // ================================================================

    showSettings() {
        if ($('#quick-tts-settings-panel-v3').length) {
            $('#quick-tts-settings-panel-v3, #quick-tts-overlay-v3').remove();
            return;
        }

        let modelOptionsHtml = '';
        if (this._modelList.length === 0) {
            modelOptionsHtml = `
                <div style="padding: 12px; text-align: center; color: #888; font-size: 12px;">
                    正在加载模型列表...<br>
                    <span style="font-size: 11px;">确保扩展后端已启动</span>
                </div>`;
        } else {
            this._modelList.forEach(model => {
                const isSelected = (this._selectedModel === model.name)
                    || (!this._selectedModel && this._modelList.length === 1);
                const statusIcon = (model.hasGPT ? '🟢' : '🔴') + ' ' + (model.hasSoVITS ? '🟢' : '🔴');
                const gptFile = model.gptPath ? model.gptPath.split(/[\\/]/).pop().substring(0, 20) : '—';
                const sovitsFile = model.sovitsPath ? model.sovitsPath.split(/[\\/]/).pop().substring(0, 20) : '—';

                modelOptionsHtml += `
                    <label class="qtts-model-option ${isSelected ? 'qtts-model-selected' : ''}"
                           data-model="${model.name}"
                           style="
                               display: flex; flex-direction: column; gap: 4px;
                               padding: 10px 12px; margin-bottom: 6px;
                               background: ${isSelected ? 'rgba(9,132,227,0.18)' : 'rgba(255,255,255,0.04)'};
                               border: 1px solid ${isSelected ? '#0984e3' : 'rgba(255,255,255,0.08)'};
                               border-radius: 8px; cursor: pointer;
                               transition: all 0.15s;
                           ">
                        <span style="font-weight: 600; font-size: 13px;">
                            🎙️ ${model.name} ${statusIcon}
                            ${model.langCount > 0 ? `<span style="color:#74b9ff;font-weight:normal;font-size:11px;margin-left:4px">${model.langCount}种语言</span>` : ''}
                        </span>
                        <div style="display:flex;gap:12px;font-size:11px;color:#999;">
                            <span title="${model.gptPath || '未设置'}">GPT: ${gptFile}</span>
                            <span title="${model.sovitsPath || '未设置'}">SV: ${sovitsFile}</span>
                        </div>
                    </label>`;
            });
        }

        const charName = this._getCurrentCharName() || '未知';
        const mappingHint = (() => {
            const m = window.TTS_State?.CACHE?.mappings || {};
            return m[charName]
                ? `<span style="color:#00b894">✅ 已绑定 → ${m[charName]}</span>`
                : `<span style="color:#e17055">⚠️ 未绑定</span>（请在原扩展中绑定）`;
        })();

        const panelHtml = `
<div id="quick-tts-settings-panel-v3" style="
    position: fixed;
    top: 50%; left: 50%;
    transform: translate(-50%, -50%);
    background: #1a1d21; color: #e0e0e0;
    padding: 24px 28px; border-radius: 14px;
    box-shadow: 0 20px 60px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,255,255,0.06);
    z-index: 999999; min-width: 400px; max-width: 480px;
    max-height: 80vh; overflow-y: auto;
    font-family: -apple-system, 'Segoe UI', sans-serif;
">
    <!-- 标题 -->
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">
        <h3 style="margin:0;font-size:17px;color:#fff;display:flex;align-items:center;gap:8px;">
            ⚡ 快速朗读设置
        </h3>
        <button id="qtts-close-btn" style="
            background:none;border:none;cursor:pointer;font-size:20px;
            color:#666;padding:4px;line-height:1;
        ">✕</button>
    </div>

    <!-- 开关区域 -->
    <div style="margin-bottom:16px;padding:14px;background:rgba(255,255,255,0.03);border-radius:10px;">
        <label style="display:flex;align-items:center;gap:10px;cursor:pointer;margin-bottom:10px;font-size:13px;">
            <input type="checkbox" id="qtts-enabled" ${this.enabled ? 'checked' : ''}
                   style="accent-color:#0984e3;width:16px;height:16px;">
            <span>启用快速朗读</span>
            <span style="margin-left:auto;font-size:11px;color:${this.enabled ? '#00b894' : '#666'};">
                ${this.enabled ? 'ON' : 'OFF'}
            </span>
        </label>

        <label style="display:flex;align-items:center;gap:10px;cursor:pointer;margin-bottom:10px;font-size:13px;">
            <input type="checkbox" id="qtts-autoplay" ${this.autoPlay ? 'checked' : ''}
                   style="accent-color:#0984e3;width:16px;height:16px;">
            <span>新消息自动朗读</span>
        </label>

        <label style="display:flex;align-items:center;gap:10px;cursor:pointer;margin-bottom:8px;font-size:13px;">
            <input type="checkbox" id="qtts-use-llm" ${this.useLLM ? 'checked' : ''}
                   style="accent-color:#0984e3;width:16px;height:16px;">
            <span>LLM 预处理（提取文本+情感）</span>
        </label>
        <p style="font-size:11px;color:#777;margin:4px 0 0 26px;">
            需要在电话功能的 LLM 配置里填好 API 地址和密钥
        </p>

        <!-- v3 新增：分片设置 -->
        <div style="margin-top:12px;padding-top:12px;border-top:1px solid rgba(255,255,255,0.06);">
            <label style="display:flex;align-items:center;gap:10px;cursor:pointer;font-size:13px;color:#aaa;">
                <span>📏 长文本分片上限：</span>
                <input type="number" id="qtts-segment-len" value="${QTTS_MAX_CHARS_PER_SEGMENT}"
                       min="20" max="300" step="10"
                       style="width:60px;background:rgba(255,255,255,0.08);border:1px solid #444;border-radius:4px;
                       color:#fff;padding:2px 6px;font-size:12px;text-align:center;" />
                <span>字符/段</span>
            </label>
            <p style="font-size:11px;color:#666;margin:4px 0 0 26px;">
                GPT-SoVITS 单次推荐 ≤ 80 字。过长会只读部分内容或报错。
            </p>
        </div>

        <!-- v4 新增：文本过滤设置 -->
        <div style="margin-top:12px;padding-top:12px;border-top:1px solid rgba(255,255,255,0.06);">
            <label style="display:block;font-size:13px;color:#aaa;margin-bottom:6px;">
                🏷️ 消息提取标签
            </label>
            <input type="text" id="qtts-extract-tag" value="${this.extractTag}"
                   placeholder="例：conxt（留空=不提取）"
                   style="width:100%;background:rgba(255,255,255,0.08);border:1px solid #444;border-radius:6px;
                   color:#fff;padding:8px 10px;font-size:12px;box-sizing:border-box;outline:none;"
                   onfocus="this.style.borderColor='#0984e3'"
                   onblur="this.style.borderColor='#444'" />
            <p style="font-size:11px;color:#666;margin:4px 0 8px 0;">
                提取指定标签内的内容。如填 <b>conxt</b>，则从 &lt;conxt&gt;...&lt;/conxt&gt; 中提取对话文本。
                填写后只朗读标签内的内容，括号里的动作/神态描述会被排除。
            </p>

            <label style="display:block;font-size:13px;color:#aaa;margin-bottom:6px;">
                🧹 过滤标签
            </label>
            <textarea id="qtts-filter-tags" rows="2"
                placeholder="例：&lt;small&gt;, [statbar]"
                style="width:100%;background:rgba(255,255,255,0.08);border:1px solid #444;border-radius:6px;
                color:#fff;padding:8px 10px;font-size:12px;box-sizing:border-box;outline:none;resize:vertical;"
                onfocus="this.style.borderColor='#0984e3'"
                onblur="this.style.borderColor='#444'">${this.filterTags}</textarea>
            <p style="font-size:11px;color:#666;margin:4px 0 0 0;">
                移除不需要朗读的内容。支持 &lt;tag&gt;...&lt;/tag&gt;、[tag]...[/tag]、前缀|后缀 三种格式。
                多个用逗号分隔。
            </p>

            <!-- v4.1 新增：引号对话提取 -->
            <div style="margin-top:12px;padding-top:12px;border-top:1px solid rgba(255,255,255,0.06);">
                <label style="display:flex;align-items:center;gap:10px;cursor:pointer;font-size:13px;color:#ddd;">
                    <input type="checkbox" id="qtts-extract-dialog" ${this.extractDialog ? 'checked' : ''}
                           style="accent-color:#0984e3;width:16px;height:16px;" />
                    <span>💬 只朗读引号内的对话内容</span>
                </label>
                <p style="font-size:11px;color:#666;margin:4px 0 0 26px;line-height:1.5;">
                    勾选后，自动提取 <b>"..."</b> 和 <b>「...」</b> 引号内的文本用于朗读。<br>
                    括号动作（）、旁白、系统状态等非引号内容将被丢弃。<br>
                    <span style="color:#e17055;">⚠️ 若文中无引号，将回退到原文本。</span>
                </p>
            </div>
        </div>
    </div>

    <!-- 模型选择区域 -->
    <div style="margin-bottom:16px;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
            <span style="font-weight:600;font-size:14px;color:#fff;">🎙️ 选择语音模型</span>
            <button id="qtts-refresh-models" title="重新加载模型列表" style="
                background:rgba(255,255,255,0.07);border:none;border-radius:6px;
                padding:4px 10px;cursor:pointer;font-size:12px;color:#bbb;
            ">🔄 刷新</button>
        </div>

        <div style="
            display:flex;align-items:center;gap:8px;
            padding:8px 12px;margin-bottom:10px;
            background:rgba(100,180,255,0.06);border-radius:8px;
            font-size:12px;
        ">
            <span style="color:#888;">当前角色:</span>
            <strong style="color:#74b9ff;">${charName}</strong>
            ${mappingHint}
        </div>

        <div style="
            display:flex;background:rgba(255,255,255,0.04);border-radius:8px;
            padding:3px;margin-bottom:10px;
        ">
            <button id="qtts-mode-auto" class="qtts-mode-btn ${this._isAutoModel ? 'active' : ''}" style="
                flex:1;padding:6px 0;border:none;border-radius:6px;
                background:${this._isAutoModel ? '#0984e3' : 'transparent'};
                color:${this._isAutoModel ? '#fff' : '#aaa'};
                cursor:pointer;font-size:12px;font-weight:500;
                transition:all 0.2s;
            ">🤖 自动（跟随原扩展绑定）</button>
            <button id="qtts-mode-manual" class="qtts-mode-btn ${!this._isAutoModel ? 'active' : ''}" style="
                flex:1;padding:6px 0;border:none;border-radius:6px;
                background:${!this._isAutoModel ? '#0984e3' : 'transparent'};
                color:${!this._isAutoModel ? '#fff' : '#aaa'};
                cursor:pointer;font-size:12px;font-weight:500;
                transition:all 0.2s;
            ">🎯 手动选择</button>
        </div>

        <div id="qtts-model-list" style="
            max-height:220px;overflow-y:auto;
            scrollbar-width:thin;scrollbar-color:#444 transparent;
        ">
            ${modelOptionsHtml}
        </div>

        <p id="qtts-model-hint" style="
            font-size:11px;color:#666;margin-top:8px;text-align:center;
        ">
            ${this._isAutoModel
                ? '自动模式：将根据原扩展的角色-模型映射自动选择'
                : '手动模式：从上方列表中选择要使用的模型'}
        </p>
    </div>

    <!-- 底部按钮 -->
    <div style="text-align:right;margin-top:4px;display:flex;justify-content:flex-end;gap:8px;">
        <button id="qtts-open-history" style="
            padding:7px 16px;background:rgba(255,255,255,0.07);
            color:#bbb;border:1px solid rgba(255,255,255,0.1);border-radius:8px;
            cursor:pointer;font-size:13px;font-weight:500;
        ">📋 历史记录</button>
        <button id="qtts-close-settings" style="
            padding:7px 24px;background:linear-gradient(135deg,#0984e3,#0652DD);
            color:#fff;border:none;border-radius:8px;cursor:pointer;
            font-size:13px;font-weight:500;
        ">完成</button>
    </div>
</div>
<!-- 遮罩层 -->
<div id="quick-tts-overlay-v3" style="
    position:fixed;top:0;left:0;right:0;bottom:0;
    background:rgba(0,0,0,0.55);z-index:999998;
"></div>`;

        $('body').append(panelHtml);

        // ---- 绑定事件 ----

        const closePanel = () => {
            $('#quick-tts-settings-panel-v3, #quick-tts-overlay-v3').remove();
        };
        $('#qtts-close-btn, #qtts-close-settings, #quick-tts-overlay-v3').on('click', closePanel);

        // 开关项
        $('#qtts-enabled').on('change', e => {
            this.enabled = e.target.checked;
            $('#qtts-enabled').nextAll('span:last').text(this.enabled ? 'ON' : 'OFF')
                .css('color', this.enabled ? '#00b894' : '#666');
            this._saveUserConfig();
            $('#quick-tts-toggle').css('opacity', this.enabled ? 1 : 0.35);
            $('#quick-tts-read-last').css('opacity', this.enabled ? 0.85 : 0.3);
        });

        $('#qtts-autoplay').on('change', e => {
            this.autoPlay = e.target.checked;
            this._saveUserConfig();
        });

        $('#qtts-use-llm').on('change', e => {
            this.useLLM = e.target.checked;
            this._saveUserConfig();
        });

        // v3: 分片长度设置
        $('#qtts-segment-len').on('change', e => {
            const val = parseInt(e.target.value) || 80;
            window.QTTS_MAX_CHUNK = val;
            console.log(`[QuickTTS] 📏 分片长度调整为 ${val}`);
        });

        // v4: 文本过滤设置
        $('#qtts-extract-tag').on('change input', e => {
            this.extractTag = e.target.value.trim();
            this._saveUserConfig();
        });
        $('#qtts-filter-tags').on('change input', e => {
            this.filterTags = e.target.value.trim();
            this._saveUserConfig();
        });

        // v4.1: 引号对话提取
        $('#qtts-extract-dialog').on('change', e => {
            this.extractDialog = e.target.checked;
            this._saveUserConfig();
            console.log(`[QuickTTS] 💬 引号对话提取: ${e.target.checked ? '开启' : '关闭'}`);
        });

        // 模式切换
        $('#qtts-mode-auto').on('click', () => {
            this._isAutoModel = true;
            this._saveUserConfig();
            $('#qtts-mode-auto').css({ background: '#0984e3', color: '#fff' }).addClass('active');
            $('#qtts-mode-manual').css({ background: 'transparent', color: '#aaa' }).removeClass('active');
            $('#qtts-model-list .qtts-model-option').removeClass('qtts-model-selected')
                .css({ background: 'rgba(255,255,255,0.04)', borderColor: 'rgba(255,255,255,0.08)' });
            $('#qtts-model-hint').text('自动模式：将根据原扩展的角色-模型映射自动选择');
        });

        $('#qtts-mode-manual').on('click', () => {
            this._isAutoModel = false;
            this._saveUserConfig();
            $('#qtts-mode-manual').css({ background: '#0984e3', color: '#fff' }).addClass('active');
            $('#qtts-mode-auto').css({ background: 'transparent', color: '#aaa' }).removeClass('active');
            $('#qtts-model-hint').text('手动模式：从上方列表中选择要使用的模型');

            if (!this._selectedModel && this._modelList.length > 0) {
                this.selectModel(this._modelList[0].name);
            }
        });

        $('.qtts-model-option').on('click', function () {
            const modelName = $(this).data('model');
            QuickTTS.selectModel(modelName);
        });

        $('#qtts-refresh-models').on('click', async () => {
            $('#qtts-model-list').html('<div style="padding:20px;text-align:center;color:#888;font-size:12px;">⏳ 加载中...</div>');
            await QuickTTS._refreshModelCache();
            QuickTTS._renderModelListInSettings();
        });

        // v3: 设置里的"历史记录"按钮
        $('#qtts-open-history').on('click', () => {
            closePanel();
            setTimeout(() => QuickTTS.showHistory(), 150);
        });
    },

    selectModel(modelName) {
        this._selectedModel = modelName;
        this._isAutoModel = false;
        this._saveUserConfig();

        $('.qtts-model-option').each(function () {
            const isSel = $(this).data('model') === modelName;
            $(this).toggleClass('qtts-model-selected', isSel)
                .css({
                    background: isSel ? 'rgba(9,132,227,0.18)' : 'rgba(255,255,255,0.04)',
                    borderColor: isSel ? '#0984e3' : 'rgba(255,255,255,0.08)'
                });
        });

        $('#qtts-mode-manual').css({ background: '#0984e3', color: '#fff' }).addClass('active');
        $('#qtts-mode-auto').css({ background: 'transparent', color: '#aaa' }).removeClass('active');
        $('#qtts-model-hint').text(`已选择模型: ${modelName}`);

        console.log(`[QuickTTS] 👉 手动选择模型: ${modelName}`);
    },

    _renderModelListInSettings() {
        if (!$('#qtts-model-list').length) return;

        let html = '';
        if (this._modelList.length === 0) {
            html = '<div style="padding:16px;text-align:center;color:#888;font-size:12px;">暂无可用模型<br><span style="font-size:11px;">检查扩展后端是否运行</span></div>';
        } else {
            this._modelList.forEach(model => {
                const isSelected = this._selectedModel === model.name;
                const statusIcon = (model.hasGPT ? '🟢' : '🔴') + ' ' + (model.hasSoVITS ? '🟢' : '🔴');
                const gptFile = model.gptPath ? model.gptPath.split(/[\\/]/).pop().substring(0, 20) : '—';
                const svFile = model.sovitsPath ? model.sovitsPath.split(/[\\/]/).pop().substring(0, 20) : '—';

                html += `
<label class="qtts-model-option ${isSelected ? 'qtts-model-selected' : ''}" data-model="${model.name}" style="
    display:flex;flex-direction:column;gap:4px;
    padding:10px 12px;margin-bottom:6px;
    background:${isSelected ? 'rgba(9,132,227,0.18)' : 'rgba(255,255,255,0.04)'};
    border:1px solid ${isSelected ? '#0984e3' : 'rgba(255,255,255,0.08)'};
    border-radius:8px;cursor:pointer;transition:all 0.15s;
"><span style="font-weight:600;font-size:13px;">🎙️ ${model.name} ${statusIcon}</span>
<div style="display:flex;gap:12px;font-size:11px;color:#999;">
<span title="${model.gptPath || '-'}">GPT: ${gptFile}</span>
<span title="${model.sovitsPath || '-'}">SV: ${svFile}</span>
</div></label>`;
            });
        }

        $('#qtts-model-list').html(html);

        $('.qtts-model-option').off('click').on('click', function () {
            QuickTTS.selectModel($(this).data('model'));
        });
    },

    // ================================================================
    //  历史记录面板（v3 新增）
    // ================================================================

    showHistory() {
        if ($('#quick-tts-history-panel').length) {
            $('#quick-tts-history-panel, #quick-tts-history-overlay').remove();
            return;
        }

        const records = AudioHistory.getAll();
        const historyHtml = this._buildHistoryHTML(records);

        const panelHtml = `
<div id="quick-tts-history-panel" style="
    position: fixed;
    bottom: 60px; right: 20px;
    width: 420px; max-height: 520px;
    background: #1a1d21; color: #e0e0e0;
    border-radius: 14px;
    box-shadow: 0 12px 40px rgba(0,0,0,0.65), 0 0 0 1px rgba(255,255,255,0.06);
    z-index: 999998;
    font-family: -apple-system, 'Segoe UI', sans-serif;
    display: flex; flex-direction: column;
    overflow: hidden;
">
    <!-- 头部 -->
    <div style="
        display:flex;align-items:center;justify-content:space-between;
        padding:14px 18px;border-bottom:1px solid rgba(255,255,255,0.08);
        flex-shrink:0;
    ">
        <h3 style="margin:0;font-size:15px;color:#fff;">📋 语音历史记录</h3>
        <div style="display:flex;gap:8px;align-items:center;">
            <span id="qtts-history-count" style="font-size:11px;color:#888;">${records.length} 条</span>
            <button id="qtts-clear-history" title="清空历史" style="
                background:none;border:none;cursor:pointer;font-size:14px;
                color:#e17055;opacity:0.6;padding:2px;
            ">🗑️</button>
            <button id="qtts-close-history" style="
                background:none;border:none;cursor:pointer;font-size:18px;
                color:#666;padding:2px;line-height:1;
            ">✕</button>
        </div>
    </div>

    <!-- 内容区 -->
    <div id="qtts-history-content" style="
        flex:1;overflow-y:auto;padding:12px;
        scrollbar-width:thin;scrollbar-color:#444 transparent;
    ">
        ${historyHtml}
    </div>

    <!-- 底部提示 -->
    <div style="
        padding:8px 18px;border-top:1px solid rgba(255,255,255,0.06);
        font-size:11px;color:#555;flex-shrink:0;
        text-align:center;
    ">
        点击 ▶️ 重播 · 显示最近 ${QTTS_MAX_HISTORY} 条记录
    </div>
</div>
<div id="quick-tts-history-overlay" style="
    position:fixed;top:0;left:0;right:0;bottom:0;
    z-index:999997;
"></div>`;

        $('body').append(panelHtml);

        // 绑定关闭
        const close = () => {
            $('#quick-tts-history-panel, #quick-tts-history-overlay').remove();
        };
        $('#qtts-close-history, #quick-tts-history-overlay').on('click', close);

        // 清空历史
        $('#qtts-clear-history').on('click', () => {
            if (confirm('确定清空所有语音历史记录？')) {
                AudioHistory.clear();
                $('#qtts-history-content').html(
                    '<div style="padding:30px;text-align:center;color:#666;font-size:13px;">暂无记录</div>'
                );
                $('#qtts-history-count').text('0 条');
            }
        });

        // 绑定重播和下载按钮（事件委托）
        $('#qtts-history-content').off('click').on('click', '.qtts-hist-replay', function () {
            const idx = parseInt($(this).data('idx'));
            const records = AudioHistory.getAll();
            if (records[idx]) {
                const rec = records[idx];
                // 找到第一个成功的 segment 来重播
                const okSeg = (rec.segments || []).filter(s => s.status === 'success')[0];
                if (okSeg && okSeg.blobUrl) {
                    const audio = new Audio(okSeg.blobUrl);
                    audio.play().catch(e => console.warn('[QuickTTS] 重播失败:', e));
                } else {
                    // 重新生成
                    const text = rec.segments && rec.segments.length > 0
                        ? rec.segments.map(s => s.text).join('')
                        : rec.text || '';
                    if (text) {
                        QuickTTS.generateAndPlay(text);
                    }
                }
            }
        });

        // 下载按钮：将所有成功片段合并或逐个下载
        $('#qtts-history-content').off('click', '.qtts-hist-download').on('click', '.qtts-hist-download', function (e) {
            e.stopPropagation(); // 防止触发重播
            const idx = parseInt($(this).data('idx'));
            const records = AudioHistory.getAll();
            if (!records[idx]) return;

            const rec = records[idx];
            const okSegments = (rec.segments || []).filter(s => s.status === 'success' && s.blobUrl);

            if (okSegments.length === 0) {
                alert('⚠️ 该记录没有可下载的成功音频片段');
                return;
            }

            // 如果只有1个片段，直接下载
            if (okSegments.length === 1) {
                QuickTTS._downloadBlobUrl(okSegments[0].blobUrl, `qtts_seg1_${Date.now()}.wav`);
                return;
            }

            // 多个片段：逐个下载（浏览器会提示确认）
            okSegments.forEach((seg, si) => {
                setTimeout(() => {
                    QuickTTS._downloadBlobUrl(seg.blobUrl, `qtts_seg${si + 1}_${Date.now()}.wav`);
                }, si * 500); // 错开下载时间
            });
        });
    },

    /**
     * 构建历史记录 HTML
     */
    _buildHistoryHTML(records) {
        if (records.length === 0) {
            return '<div style="padding:30px;text-align:center;color:#666;font-size:13px;">暂无语音记录<br><span style="font-size:11px;color:#444;">生成成功的语音会出现在这里</span></div>';
        }

        let html = '';
        records.forEach((rec, idx) => {
            const timeStr = this._formatTime(rec.endTime || rec.startTime);
            const statusIcon = rec.status === 'success' ? '✅' : (rec.status === 'partial' ? '⚠️' : '❌');
            const totalDur = (rec.segments || []).reduce((sum, s) => sum + (s.duration || 0), 0);
            const durStr = totalDur > 0 ? `${totalDur.toFixed(1)}s` : '?';
            const segCount = (rec.segments || []).length;
            const okCount = (rec.segments || []).filter(s => s.status === 'success').length;
            const previewText = (rec.text || '').substring(0, 60) + ((rec.text || '').length > 60 ? '...' : '');

            // segments 详情
            let segDetailsHtml = '';
            if (rec.segments && rec.segments.length > 0) {
                segDetailsHtml = '<div style="margin-top:6px;margin-left:12px;border-left:2px solid rgba(100,180,255,0.2);padding-left:8px;">';
                rec.segments.forEach((seg, si) => {
                    const segIcon = seg.status === 'success' ? '✅' : '❌';
                    const segDur = seg.duration ? `${seg.duration.toFixed(1)}s` : '';
                    const segSize = seg.sizeKB ? `${seg.sizeKB.toFixed(0)}KB` : '';
                    const segPreview = (seg.text || '').substring(0, 35) + ((seg.text || '').length > 35 ? '...' : '');

                    segDetailsHtml += `
                    <div style="display:flex;align-items:center;gap:4px;padding:3px 0;font-size:11px;
                        border-bottom:1px solid rgba(255,255,255,0.03);">
                        <span>${segIcon}</span>
                        <span style="color:#888;">#${si + 1}</span>
                        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:220px;"
                              title="${seg.text || ''}">${segPreview}</span>
                        <span style="color:${seg.status === 'success' ? '#00b894' : '#e17055'};white-space:nowrap;">
                            ${segDur}${segSize ? ` / ${segSize}` : ''}</span>
                        ${seg.cacheFile ? `<span style="color:#555;font-size:10px;" title="${seg.cacheFile}">📁</span>` : ''}
                    </div>`;
                });
                segDetailsHtml += '</div>';
            }

            html += `
            <div style="
                padding:10px 12px;margin-bottom:8px;
                background:rgba(255,255,255,0.03);border-radius:8px;
                border:1px solid rgba(255,255,255,0.05);
            ">
                <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
                    <span>${statusIcon}</span>
                    <span style="font-size:11px;color:#888;">${timeStr}</span>
                    <span style="margin-left:auto;font-size:11px;color:#74b9ff;">${durStr}</span>
                    <span style="font-size:11px;color:#666;">${okCount}/${segCount}段</span>
                    <button class="qtts-hist-replay" data-idx="${idx}" style="
                        background:none;border:none;cursor:pointer;font-size:13px;
                        padding:0 4px;line-height:1;
                    " title="重新播放">▶️</button>
                    <button class="qtts-hist-download" data-idx="${idx}" style="
                        background:none;border:none;cursor:pointer;font-size:12px;
                        padding:0 4px;line-height:1;opacity:0.5;
                    " title="下载所有音频文件">📥</button>
                </div>
                <div style="font-size:12px;color:#ccc;line-height:1.4;" title="${rec.text || ''}">
                    ${previewText}
                </div>
                ${rec.model ? `<div style="font-size:10px;color:#666;margin-top:3px;">🎙️ ${rec.model}</div>` : ''}
                ${rec.error ? `<div style="font-size:11px;color:#e17055;margin-top:3px;">❌ ${rec.error}</div>` : ''}
                ${segDetailsHtml}
            </div>`;
        });

        return html;
    },

    _formatTime(date) {
        if (!(date instanceof Date)) date = new Date(date);
        const pad = n => String(n).padStart(2, '0');
        return `${date.getHours()}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    },

    /**
     * 监听历史变化并刷新面板
     */
    _initHistoryListener() {
        AudioHistory.onChange((records) => {
            if ($('#qtts-history-content').length) {
                $('#qtts-history-content').html(this._buildHistoryHTML(records));
                $('#qtts-history-count').text(`${records.length} 条`);
            }
        });
    },

    // ================================================================
    //  核心流程（v3 增强：长文本分片 + 详细日志）
    // ================================================================

    async handleNewMessage(messageId) {
        if (this.isGenerating) {
            console.log('[QuickTTS] 正在生成中，跳过新消息');
            return;
        }

        try {
            const text = extractMessageText(messageId);
            if (!text || text.length < 2) {
                console.log('[QuickTTS] 文本太短或为空，跳过');
                return;
            }

            console.log(`[QuickTTS] 📝 收到新消息 (${text.length}字):`, text.substring(0, 80));
            await this.generateAndPlay(text);
        } catch (e) {
            console.error('[QuickTTS] 处理新消息失败:', e);
        }
    },

    async readLastMessage() {
        if (this.isGenerating) {
            window.TTS_Utils?.showNotification('⏳ 正在生成中...', 'info');
            return;
        }

        try {
            const text = extractMessageText(null);
            if (!text || text.length < 2) {
                window.TTS_Utils?.showNotification('⚠️ 未找到可朗读的消息', 'error');
                return;
            }

            console.log('[QuickTTS] 🎯 手动朗读:', text.substring(0, 80));
            await this.generateAndPlay(text);
        } catch (e) {
            console.error('[QuickTTS] 手动朗读失败:', e);
            window.TTS_Utils?.showNotification('❌ 朗读失败: ' + e.message, 'error');
        }
    },

    /**
     * 核心：生成并播放音频（v3 增强版）
     *
     * 流程：
     * 1. LLM 预处理（可选）
     * 2. 长文本分片
     * 3. 解析模型 + 切换权重
     * 4. 逐片生成音频
     * 5. 顺序播放（带间隔）
     * 6. 记录到历史
     */
    async generateAndPlay(rawText) {
        this.isGenerating = true;
        let finalText = rawText;
        let emotion = 'default';
        const startTime = new Date();

        // 创建历史记录
        const historyRecord = AudioHistory.add({
            text: rawText,
            emotion: emotion,
            model: null,
            refAudio: null,
            segments: [],
            startTime: startTime,
            endTime: null,
            status: 'pending'
        });

        try {
            // ===== 步骤1: LLM 预处理 =====
            if (this.useLLM) {
                const llmConfig = this._getLLMConfig();
                const processed = await processWithLLM(rawText, llmConfig);
                if (processed) {
                    finalText = processed.text;
                    emotion = processed.emotion;
                    console.log(`[QuickTTS] 🤖 LLM → emotion=${emotion}, text(${finalText.length}字)`);
                }
            }

            // ===== 步骤1.5: 文本提取与过滤（v4 新增）=====
            if (this.extractTag || this.filterTags || this.extractDialog) {
                const beforeFilter = finalText;
                finalText = TextFilter.process(finalText, this.extractTag, this.filterTags, this.extractDialog);
                console.log(`[QuickTTS] 🏷️🧹 文本过滤: ${beforeFilter.length}字 → ${finalText.length}字`
                    + (this.extractDialog ? ' [💬引号提取]' : '')
                    + (this.extractTag ? ` [提取:<${this.extractTag}>]` : '')
                    + (this.filterTags ? ` [过滤:${this.filterTags}]` : ''));
            }

            if (!finalText || finalText.trim().length === 0) {
                console.warn('[QuickTTS] 处理后文本为空');
                AudioHistory.update(historyRecord.id, { status: 'error', error: '处理后文本为空', endTime: new Date() });
                return;
            }

            // ===== 步骤2: 长文本分片（v3 核心） =====
            const maxChunk = window.QTTS_MAX_CHUNK || QTTS_MAX_CHARS_PER_SEGMENT;
            const segments = splitTextIntoSegments(finalText, maxChunk);

            console.log(`[QuickTTS] ✂️ 文本分片: ${finalText.length}字 → ${segments.length} 片 (每片≤${maxChunk}字):`);
            segments.forEach((seg, i) => {
                console.log(`   [${i + 1}/${segments.length}] (${seg.length}字) ${seg.substring(0, 40)}${seg.length > 40 ? '...' : ''}`);
            });

            // ===== 步骤3: 解析模型 =====
            const charName = this._getCurrentCharName();
            const resolved = this.resolveModel(charName);

            console.log(`[QuickTTS] 🔍 模型解析 [${this._isAutoModel ? '自动' : '手动'}]:`,
                resolved.modelInfo ? `${resolved.modelInfo.modelName} (GPT:${!!resolved.modelInfo.gptPath}, SV:${!!resolved.modelInfo.sovitsPath})`
                : `无模型 — ${resolved.reason}`);

            if (resolved.modelInfo) {
                // 步骤4: 切换模型权重
                await this.switchModel(resolved.modelInfo);
            } else {
                console.warn(`[QuickTTS] ⚠️ 无模型可用: ${resolved.reason}`);
                window.TTS_Utils?.showNotification(
                    `⚠️ 无模型: ${resolved.reason}\n请点⚙️选择模型`,
                    'warning'
                );
                AudioHistory.update(historyRecord.id, {
                    status: 'error',
                    error: resolved.reason,
                    model: '未选择',
                    endTime: new Date()
                });
                return;
            }

            // 更新历史记录中的模型信息
            AudioHistory.update(historyRecord.id, {
                model: resolved.modelInfo.modelName,
                refAudio: resolved.refAudio ? resolved.refAudio.path.split(/[\\/]/).pop() : null
            });

            // ===== 步骤5: 逐片生成 + 顺序播放 =====
            const langCode = getLangCode();
            const API = window.TTS_API;
            let successCount = 0;
            let failCount = 0;
            const generatedSegments = [];

            for (let i = 0; i < segments.length; i++) {
                const segText = segments[i];

                console.log(`[QuickTTS] 🔊 生成片段 [${i + 1}/${segments.length}] (${segText.length}字)...`);

                // 构建参数
                const params = {
                    text: segText,
                    text_lang: langCode,
                    prompt_lang: langCode,
                    emotion: emotion
                };

                if (resolved.refAudio) {
                    params.ref_audio_path = resolved.refAudio.path;
                    params.prompt_text = resolved.refAudio.text;
                }

                const segStartTime = Date.now();
                let segResult = {
                    index: i + 1,
                    text: segText,
                    status: 'pending',
                    duration: null,
                    sizeKB: null,
                    cacheFile: null,
                    blobUrl: null,
                    error: null
                };

                try {
                    // 缓存检查
                    try {
                        const cacheCheck = await API.checkQuickTTSCache(params);
                        if (cacheCheck.cached) {
                            console.log(`[QuickTTS] 💾 片段[${i + 1}] 缓存命中`);
                        }
                    } catch (cacheErr) {
                        // 忽略缓存检查错误
                    }

                    // 生成音频
                    const genStartTime = performance.now();
                    const { blob, filename, meta } = await API.generateQuickTTS(params);
                    const genElapsed = (performance.now() - genStartTime) / 1000;

                    // 计算音频时长（通过解码获取）
                    const duration = await this._getAudioDuration(blob);

                    segResult = {
                        ...segResult,
                        status: 'success',
                        duration: duration,
                        sizeKB: blob.size / 1024,
                        cacheFile: filename || '(未知)',
                        blobUrl: URL.createObjectURL(blob),
                        generateTime: genElapsed.toFixed(1) + 's'
                    };

                    successCount++;

                    // ===== 详细日志（v3 核心） =====
                    console.log(`[QuickTTS] ✅ 片段[${i + 1}] 成功!`);
                    console.log(`   ├─ 文本(${segText.length}字): "${segText.substring(0, 40)}${segText.length > 40 ? '...' : ''}"`);
                    console.log(`   ├─ 时长: ${duration.toFixed(2)}s`);
                    console.log(`   ├─ 大小: ${(blob.size / 1024).toFixed(1)} KB`);
                    console.log(`   ├─ 缓存文件: ${filename || '?'}`);
                    console.log(`   ├─ 生成耗时: ${genElapsed.toFixed(1)}s`);
                    console.log(`   └─ 模型: ${resolved.modelInfo.modelName} | 参考: ${resolved.refAudio ? resolved.refAudio.path.split(/[\\/]/).pop() : '无'}`);

                    // 加入播放队列
                    generatedSegments.push(segResult);

                    // 更新该片段的历史记录
                    const updatedRec = AudioHistory.getAll().find(r => r.id === historyRecord.id);
                    if (updatedRec) {
                        updatedRec.segments.push(segResult);
                    }

                } catch (segErr) {
                    failCount++;
                    segResult.status = 'error';
                    segResult.error = segErr.message || String(segErr);

                    console.error(`[QuickTTS] ❌ 片段[${i + 1}] 失败:`, segErr.message || segErr);

                    // 记录失败的片段
                    const updatedRec = AudioHistory.getAll().find(r => r.id === historyRecord.id);
                    if (updatedRec) {
                        updatedRec.segments.push(segResult);
                    }
                }
            }

            // ===== 步骤6: 顺序播放 =====
            const finalStatus = failCount === 0 ? 'success' : (successCount > 0 ? 'partial' : 'error');
            AudioHistory.update(historyRecord.id, {
                status: finalStatus,
                error: failCount > 0 ? `${failCount}/${segments.length} 片段失败` : null,
                endTime: new Date()
            });

            console.log(`[QuickTTS] 📊 总计: ${successCount}/${segments.length} 成功, 状态=${finalStatus}`);

            if (generatedSegments.length > 0) {
                await this._playQueueSequential(generatedSegments);
            } else {
                console.warn('[QuickTTS] 所有片段都失败了');
                window.TTS_Utils?.showNotification('❌ 所有片段生成均失败，请查看控制台日志', 'error');
            }

        } catch (e) {
            console.error('[QuickTTS] ❌ 严重错误:', e);
            AudioHistory.update(historyRecord.id, { status: 'error', error: e.message, endTime: new Date() });
            window.TTS_Utils?.showNotification('❌ 快速朗读失败: ' + e.message, 'error');
        } finally {
            this.isGenerating = false;
        }
    },

    /**
     * 顺序播放多个音频片段（v3 新增）
     */
    async _playQueueSequential(segments) {
        this._isPlayingQueue = true;

        // 停止当前正在播放的
        if (this.currentAudio) {
            this.currentAudio.pause();
            this.currentAudio = null;
        }

        for (let i = 0; i < segments.length; i++) {
            if (!this._isPlayingQueue) break;

            const seg = segments[i];
            if (seg.status !== 'success' || !seg.blobUrl) continue;

            console.log(`[QuickTTS] 🔈 播放片段 [${i + 1}/${segments.length}] (${seg.duration?.toFixed(1) || '?'}s)`);

            try {
                await this._playSingleAudio(seg.blobUrl);
            } catch (playErr) {
                console.warn(`[QuickTTS] ⚠️ 片段[${i + 1}] 播放失败:`, playErr.message);
            }

            // 片段间短暂停顿
            if (i < segments.length - 1 && this._isPlayingQueue) {
                await new Promise(r => setTimeout(r, QTTS_SEGMENT_GAP_MS));
            }
        }

        this._isPlayingQueue = false;
        console.log('[QuickTTS] ✅ 播放队列完成');
    },

    /**
     * 播放单个音频，返回 Promise
     */
    _playSingleAudio(url) {
        return new Promise((resolve, reject) => {
            const audio = new Audio(url);
            this.currentAudio = audio;

            const cleanup = () => {
                this.currentAudio = null;
            };

            audio.onended = () => { cleanup(); resolve(); };
            audio.onerror = (e) => { cleanup(); reject(new Error('播放错误')); };

            audio.play().catch(err => {
                cleanup();
                reject(err);
            });
        });
    },

    /**
     * 获取音频时长（通过临时解码）
     */
    _getAudioDuration(blob) {
        return new Promise((resolve) => {
            try {
                const url = URL.createObjectURL(blob);
                const audio = new Audio(url);
                audio.onloadedmetadata = () => {
                    resolve(audio.duration || 0);
                    URL.revokeObjectURL(url);
                };
                audio.onerror = () => {
                    resolve(0);
                    URL.revokeObjectURL(url);
                };
                // 超时兜底
                setTimeout(() => resolve(0), 3000);
            } catch (e) {
                resolve(0);
            }
        });
    },

    // ================================================================
    //  诊断工具（v3 新增）
    // ================================================================

    /**
     * 将 Blob 下载为文件到本地（用于诊断：直接听原始 wav）
     */
    _downloadBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        this._downloadBlobUrl(url, filename);
        // 延迟释放，确保下载开始
        setTimeout(() => { try { URL.revokeObjectURL(url); } catch(e) {} }, 10000);
    },

    _downloadBlobUrl(url, filename) {
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    },

    /**
     * 对比测试：同一段文本分别走 /quick_tts 和 /tts_proxy，对比输出差异
     * 用于诊断为什么快速朗读生成的音频太短
     */
    async runDiagnostic(text) {
        console.log('[QuickTTS] 🔬 ===== 开始诊断模式 =====');

        const charName = this._getCurrentCharName() || 'unknown';
        const resolved = this.resolveModel(charName);

        if (!resolved.modelInfo || !resolved.refAudio) {
            alert('⚠️ 请先选择一个有参考音频的模型再运行诊断！');
            return;
        }

        const langCode = getLangCode();
        const baseParams = {
            text: text,
            text_lang: langCode,
            prompt_lang: langCode,
            ref_audio_path: resolved.refAudio.path,
            prompt_text: resolved.refAudio.text,
            emotion: 'default'
        };

        const API = window.TTS_API;

        // ---- 测试1: 通过 /quick_tts ----
        console.log(`[QuickTTS] 🔬 测试1: /quick_tts 端点`);
        console.log(`   文本: "${text}" (${text.length}字)`);
        console.log(`   参数:`, JSON.stringify({
            ...baseParams,
            ref_audio_path: baseParams.ref_audio_path.split(/[\\/]/).pop(),
            prompt_text: baseParams.prompt_text
        }, null, 2));

        let qttsResult = { duration: 0, sizeKB: 0, error: null };
        try {
            const t0 = performance.now();
            const { blob, filename, meta } = await API.generateQuickTTS(baseParams);
            const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
            qttsResult.sizeKB = blob.size / 1024;

            // 解析时长
            if (meta && meta.duration) {
                qttsResult.duration = meta.duration;
            } else {
                qttsResult.duration = await this._getAudioDuration(blob);
            }

            console.log(`[QuickTTS] 🔬 /quick_tts 结果:`);
            console.log(`   ✅ 成功 | 时长: ${qttsResult.duration.toFixed(2)}s | 大小: ${qttsResult.sizeKB.toFixed(1)} KB`);
            console.log(`   文件名: ${filename}`);
            console.log(`   后端meta:`, meta);
            console.log(`   前端计算时长: ${qttsResult.duration.toFixed(2)}s`);

            // 自动下载用于人工检查
            this._downloadBlob(blob, `diag_quicktts_${Date.now()}.wav`);
            console.log(`   📥 已下载: diag_quicktts_*.wav （请用播放器打开检查实际内容）`);

            // 尝试播放
            const audio = new Audio(URL.createObjectURL(blob));
            await audio.play();

        } catch (e) {
            qttsResult.error = e.message;
            console.error(`[QuickTTS] ❌ /quick_tts 失败:`, e.message);
        }

        // 等 3 秒再测下一个
        await new Promise(r => setTimeout(r, 3000));

        // ---- 测试2: 通过原 /tts_proxy ----
        console.log(`[QuickTTS] 🔬 测试2: /tts_proxy 端点（原扩展通道）`);
        console.log(`   使用完全相同的参数...`);

        let proxyResult = { duration: 0, sizeKB: 0, error: null };
        try {
            const t0 = performance.now();
            const { blob: pBlob, filename: pFilename } = await API.generateAudio(baseParams);
            const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
            proxyResult.sizeKB = pBlob.size / 1024;
            proxyResult.duration = await this._getAudioDuration(pBlob);

            console.log(`[QuickTTS] 🔬 /tts_proxy 结果:`);
            console.log(`   ✅ 成功 | 时长: ${proxyResult.duration.toFixed(2)}s | 大小: ${proxyResult.sizeKB.toFixed(1)} KB`);
            console.log(`   文件名: ${pFilename}`);

            this._downloadBlob(pBlob, `diag_ttsproxy_${Date.now()}.wav`);
            console.log(`   📥 已下载: diag_ttsproxy_*.wav`);

            const audio2 = new Audio(URL.createObjectURL(pBlob));
            await audio2.play();

        } catch (e) {
            proxyResult.error = e.message;
            console.error(`[QuickTTS] ❌ /tts_proxy 失败:`, e.message);
        }

        // ---- 对比结果 ----
        console.log(`[QuickTTS] 🔬 ===== 诊断结果对比 =====`);
        console.log(`┌──────────────┬──────────────┬──────────────┐`);
        console.log(`│ 指标          │ /quick_tts   │ /tts_proxy   │`);
        console.log(`├──────────────┼──────────────┼──────────────┤`);
        console.log(`│ 时长          │ ${String(qttsResult.duration ? qttsResult.duration.toFixed(2)+'s' : 'FAIL').padEnd(12)} │ ${String(proxyResult.duration ? proxyResult.duration.toFixed(2)+'s' : 'FAIL').padEnd(12)} │`);
        console.log(`│ 大小          │ ${qttsResult.error ? 'ERROR' : qttsResult.sizeKB.toFixed(1)+'KB'.padEnd(12)} │ ${proxyResult.error ? 'ERROR' : proxyResult.sizeKB.toFixed(1)+'KB'.padEnd(12)} │`);
        console.log(`│ 字符率(字/s)  │ ${(qttsResult.duration > 0 ? (text.length/qttsResult.duration).toFixed(1) : '-').padEnd(12)} │ ${(proxyResult.duration > 0 ? (text.length/proxyResult.duration).toFixed(1) : '-').padEnd(12)} │`);
        console.log(`│ 错误          │ ${(qttsResult.error || '无').padEnd(12)} │ ${(proxyResult.error || '无').padEnd(12)} │`);
        console.log(`└──────────────┴──────────────┴──────────────┘`);

        // 判断结论
        if (qttsResult.duration > 0 && proxyResult.duration > 0) {
            const ratio = qttsResult.duration / proxyResult.duration;
            if (ratio < 0.5) {
                console.warn(`[QuickTTS] ⚠️ 结论: /quick_tts 的输出只有 /tts_proxy 的 ${(ratio*100).toFixed(0)}%！`);
                console.warn(`   这说明 /quick_tts 发给 SoVITS 的参数与 /tts_proxy 有差异，或 SoVITS 处理方式不同。`);
                console.warn(`   可能原因：`);
                console.warn(`   1. /quick_tts 没有经过 validate_tts_request 验证`);
                console.warn(`   2. 锁类型不同导致并发冲突`);
                console.warn(`   3. SoVITS 对不同请求路径处理不同`);
            } else if (ratio < 0.9) {
                console.warn(`[QuickTTS] ⚠️ 结论: /quick_tts 比 /tts_proxy 短约 ${((1-ratio)*100).toFixed(0)}%，存在差异但不太大。`);
            } else {
                console.log(`[QuickTTS] ✅ 结论: 两个端点输出基本一致（差异 < 10%）。`);
                console.log(`   如果声音还是不对，可能是 SoVITS 本身对这段文本的处理就有问题。`);
            }
        }

        console.log(`[QuickTTS] 🔬 ===== 诊断结束 =====`);
        return { quicktts: qttsResult, proxy: proxyResult };
    },

    // ================================================================
    //  辅助方法
    // ================================================================

    _getCurrentCharName() {
        try {
            const $lastCharMsg = $('.mes').not('.is_user').last();
            if ($lastCharMsg.length) {
                const nameEl = $lastCharMsg.find('.name_text, .mes_name').first();
                if (nameEl.length) {
                    const domName = nameEl.text().trim();
                    if (domName) {
                        console.log(`[QuickTTS] 👤 从DOM获取角色名: "${domName}"`);
                        return domName;
                    }
                }
            }
        } catch (e) {
            console.warn('[QuickTTS] DOM方式获取角色名失败:', e);
        }

        try {
            if (window.SillyTavern && window.SillyTavern.getContext) {
                const ctx = window.SillyTavern.getContext();
                const aiName = ctx.name1 || ctx.character?.name || null;
                if (aiName) {
                    console.log(`[QuickTTS] 👤 从Context获取角色名(AI): "${aiName}" (user=${ctx.name2 || '?'})`);
                    return aiName;
                }
            }
        } catch (e) {
            console.warn('[QuickTTS] Context方式获取角色名失败:', e);
        }

        try {
            if (typeof getContext === 'function') {
                const ctx = getContext();
                const group = ctx.group;
                if (group) {
                    const firstMember = Object.keys(group.members || {})[0];
                    if (firstMember) {
                        console.log(`[QuickTTS] 👤 群聊模式，使用成员: ${firstMember}`);
                        return firstMember;
                    }
                }
                const aiName = ctx.name1;
                if (aiName) return aiName;
            }
        } catch (e) {
            console.warn('[QuickTTS] getContext() 失败:', e);
        }

        console.warn('[QuickTTS] ⚠️ 无法确定 AI 角色名');
        return null;
    },

    _getLLMConfig() {
        return (window.TTS_State?.CACHE?.settings?.phone_call)?.llm || null;
    },

    stop() {
        this._isPlayingQueue = false;
        if (this.currentAudio) {
            this.currentAudio.pause();
            this.currentAudio = null;
        }
    }
};

// 语言代码工具函数
function getLangCode() {
    const s = window.TTS_State?.CACHE?.settings || {};
    const l = s.default_lang || 'default';
    if (/Japanese|日语|日本語/.test(l)) return 'ja';
    if (/English|英语/.test(l)) return 'en';
    return 'zh';
}

// 自动初始化
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => QuickTTS.init());
} else {
    setTimeout(() => QuickTTS.init(), 3000);
}

export default QuickTTS;
