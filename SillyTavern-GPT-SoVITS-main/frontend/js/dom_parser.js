
const BARS_HTML = `<span class='sovits-voice-waves'><span class='sovits-voice-bar'></span><span class='sovits-voice-bar'></span><span class='sovits-voice-bar'></span></span>`;

// 本地兜底正则表达式
const FALLBACK_REGEX = /\[TTSVoice\s*:\s*([^:]+)\s*:\s*([^\]]+)\]\s*([^[\n<]+)/gi;

// HTML 属性转义函数，防止特殊字符破坏 HTML 结构
function escapeHtmlAttr(str) {
    if (!str) return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

export const TTS_Parser = {
    htmlCache: {},
    init() {
        console.log("✅[Parser] DOM 解析器已加载 (Observer 模式)");
        this.startObserver();
    },

    startObserver() {
        if (this.observer) return;
        this.observer = new MutationObserver((mutations) => {
            let shouldScan = false;
            for (let mutation of mutations) {
                if (mutation.type === 'childList' || mutation.type === 'characterData') {
                    shouldScan = true;
                    break;
                }
            }
            if (shouldScan) {
                this._executeScan();
            }
        });
        this.observer.observe(document.body, {
            childList: true,
            subtree: true,
            characterData: true
        });
    },

    scan() {
        this._executeScan();
    },

    // 供 Scheduler 调用的状态更新函数
    updateState() {
        const CACHE = window.TTS_State.CACHE;

        const _doUpdate = ($container) => {
            $container.find('.voice-bubble.loading').each(function () {
                const $btn = $(this);
                const key = $btn.attr('data-key');

                if (key && CACHE.audioMemory[key]) {
                    $btn.removeClass('loading');
                    $btn.attr('data-status', 'ready');
                    $btn.attr('data-audio-url', CACHE.audioMemory[key]);

                    if (window.TTS_Parser.htmlCache && window.TTS_Parser.htmlCache[key]) {
                        delete window.TTS_Parser.htmlCache[key];
                    }
                }
            });
        };

        // 更新主界面
        _doUpdate($('body'));

        // 更新 Iframe 内部
        $('iframe').each(function () {
            try {
                const $iframeBody = $(this).contents().find('body');
                if ($iframeBody.length > 0) _doUpdate($iframeBody);
            } catch (e) { }
        });
    },

    _executeScan() {
        const CACHE = window.TTS_State.CACHE;
        const TTS_Utils = window.TTS_Utils;
        const Scheduler = window.TTS_Scheduler;
        const REGEX = TTS_Utils && TTS_Utils.VOICE_TAG_REGEX ? TTS_Utils.VOICE_TAG_REGEX : FALLBACK_REGEX;

        if (CACHE.settings.enabled === false) return;

        const isIframeMode = CACHE.settings.iframe_mode === true;
        const currentCSS = TTS_Utils.getStyleContent();
        const activeStyle = CACHE.settings.bubble_style || localStorage.getItem('tts_bubble_style') || 'default';

        // IFRAME 模式
        if (isIframeMode) {
            $('iframe').each(function () {
                try {
                    const $iframe = $(this);
                    const doc = $iframe.contents();
                    const head = doc.find('head');
                    const body = doc.find('body');

                    if (currentCSS && head.length > 0 && head.find('#sovits-iframe-style').length === 0) {
                        head.append(`<style id='sovits-iframe-style'>${currentCSS}</style>`);
                    }
                    if (body.attr('data-bubble-style') !== activeStyle) {
                        body.attr('data-bubble-style', activeStyle);
                    }

                    if (!body.data('tts-event-bound')) {
                        body.on('click', '.voice-bubble', function (e) {
                            e.stopPropagation();
                            const $this = $(this);
                            window.top.postMessage({
                                type: 'play_tts',
                                key: $this.attr('data-key'),
                                text: $this.attr('data-text'),
                                charName: $this.attr('data-voice-name'),
                                emotion: $this.attr('data-voice-emotion')
                            }, '*');
                        });
                        body.data('tts-event-bound', true);
                    }

                    // Iframe 右键菜单支持
                    if (!body.data('tts-context-bound')) {
                        body.on('contextmenu', '.voice-bubble', function (e) {
                            e.stopPropagation();

                            // 计算 iframe 在主窗口的绝对位置
                            const iframeRect = $iframe[0].getBoundingClientRect();

                            // 构造伪事件对象,修正 clientX/Y
                            const fakeEvent = {
                                preventDefault: () => e.preventDefault(),
                                clientX: iframeRect.left + e.clientX,
                                clientY: iframeRect.top + e.clientY,
                                originalEvent: e.originalEvent
                            };

                            // 修正触摸事件坐标
                            if (e.originalEvent && e.originalEvent.touches && e.originalEvent.touches.length > 0) {
                                fakeEvent.originalEvent = {
                                    touches: [{
                                        clientX: iframeRect.left + e.originalEvent.touches[0].clientX,
                                        clientY: iframeRect.top + e.originalEvent.touches[0].clientY
                                    }]
                                };
                            }

                            // 调用 Events 模块的方法
                            if (window.TTS_Events && window.TTS_Events.handleContextMenu) {
                                window.TTS_Events.handleContextMenu(fakeEvent, $(this));
                            }
                        });
                        body.data('tts-context-bound', true);
                    }

                    const targets = body.find('*').filter(function () {
                        if (['SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT', 'BUTTON'].includes(this.tagName)) return false;
                        let hasTargetText = false;
                        $(this).contents().each(function () {
                            if (this.nodeType === 3 && this.nodeValue && this.nodeValue.indexOf("[TTSVoice") !== -1) {
                                hasTargetText = true;
                                return false;
                            }
                        });
                        return hasTargetText;
                    });

                    targets.each(function () {
                        const $this = $(this);
                        const html = $this.html();
                        if (REGEX.test(html)) {
                            REGEX.lastIndex = 0;
                            const newHtml = html.replace(REGEX, (match, spaceChars, name, emotion, text) => {
                                if (!text) return match;
                                const cleanName = name.trim();
                                const cleanText = text.replace(/<[^>]+>|&lt;[^&]+&gt;/g, '').trim();
                                if (!cleanText) return match;

                                const key = Scheduler.getTaskKey(cleanName, cleanText);
                                let status = 'waiting';
                                let dataUrlAttr = '';
                                let loadingClass = '';
                                if (CACHE.audioMemory[key]) {
                                    status = 'ready';
                                    dataUrlAttr = `data-audio-url='${CACHE.audioMemory[key]}'`;
                                } else if (CACHE.pendingTasks.has(key)) {
                                    status = 'queued';
                                    loadingClass = 'loading';
                                }
                                const d = Math.max(1, Math.ceil(cleanText.length * 0.25));
                                const bubbleWidth = Math.min(220, 60 + d * 10);
                                const prefix = spaceChars || '';

                                // 对 HTML 属性值进行转义，防止特殊字符破坏结构
                                const safeKey = escapeHtmlAttr(key);
                                const safeText = escapeHtmlAttr(cleanText);
                                const safeName = escapeHtmlAttr(cleanName);
                                const safeEmotion = escapeHtmlAttr(emotion.trim());

                                return `${prefix}<span class="voice-bubble ${loadingClass}"
                                    style="width: ${bubbleWidth}px"
                                    data-status="${status}" data-key="${safeKey}" ${dataUrlAttr} data-text="${safeText}"
                                    data-voice-name="${safeName}" data-voice-emotion="${safeEmotion}">
                                    ${BARS_HTML}
                                    <span class="sovits-voice-duration">${d}"</span>
                                </span>`;
                            });

                            if (newHtml !== html) {
                                $this.html(newHtml);
                                if (CACHE.settings.auto_generate) setTimeout(() => Scheduler.scanAndSchedule(), 100);
                            }
                        }
                    });
                } catch (e) { console.error(e); }
            });

        } else {
            // 普通模式
            if (currentCSS && $('#sovits-iframe-style-main').length === 0) {
                $('head').append(`<style id='sovits-iframe-style-main'>${currentCSS}</style>`);
            }
            if (document.body.getAttribute('data-bubble-style') !== activeStyle) {
                document.body.setAttribute('data-bubble-style', activeStyle);
            }

            $('.mes_text, .message-body, .markdown-content').each(function () {
                const $this = $(this);
                const html = $this.html();
                if (REGEX.test(html)) {
                    REGEX.lastIndex = 0;
                    const newHtml = html.replace(REGEX, (match, spaceChars, name, emotion, text) => {
                        if (!text) return match;
                        const cleanName = name.trim();
                        const cleanText = text.replace(/<[^>]+>|&lt;[^&]+&gt;/g, '').trim();
                        if (!cleanText) return match;

                        const key = Scheduler.getTaskKey(cleanName, cleanText);
                        let status = 'waiting';
                        let dataUrlAttr = '';
                        let loadingClass = '';
                        if (CACHE.audioMemory[key]) {
                            status = 'ready';
                            dataUrlAttr = `data-audio-url='${CACHE.audioMemory[key]}'`;
                        } else if (CACHE.pendingTasks.has(key)) {
                            status = 'queued';
                            loadingClass = 'loading';
                        }
                        const d = Math.max(1, Math.ceil(cleanText.length * 0.25));
                        const bubbleWidth = Math.min(220, 60 + d * 10);
                        const prefix = spaceChars || '';

                        // 对 HTML 属性值进行转义，防止特殊字符破坏结构
                        const safeKey = escapeHtmlAttr(key);
                        const safeText = escapeHtmlAttr(cleanText);
                        const safeName = escapeHtmlAttr(cleanName);
                        const safeEmotion = escapeHtmlAttr(emotion.trim());

                        return `${prefix}<span class="voice-bubble ${loadingClass}"
                                    style="width: ${bubbleWidth}px"
                                    data-status="${status}" data-key="${safeKey}" ${dataUrlAttr} data-text="${safeText}"
                                    data-voice-name="${safeName}" data-voice-emotion="${safeEmotion}">
                                    ${BARS_HTML}
                                    <span class="sovits-voice-duration">${d}"</span>
                                </span>`;
                    });

                    if (newHtml !== html) {
                        $this.html(newHtml);
                        if (CACHE.settings.auto_generate) setTimeout(() => Scheduler.scanAndSchedule(), 100);
                    }
                }
            });
        }

    }
};

