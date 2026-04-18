/**
 * 自动电话生成 - 前端集成示例
 * 
 * 此文件展示如何在 SillyTavern 前端集成自动电话生成功能
 */

class AutoPhoneCallManager {
    constructor(apiBaseUrl = 'http://localhost:8000/api') {
        this.apiBaseUrl = apiBaseUrl;
        this.wsBaseUrl = apiBaseUrl.replace('http', 'ws').replace('/api', '');
        this.currentCharName = null;
        this.ws = null;
        this.reconnectInterval = null;
        this.heartbeatInterval = null;
    }

    /**
     * 初始化 - 当用户进入角色对话页面时调用
     */
    init(charName) {
        this.currentCharName = charName;
        this.connectWebSocket();
        console.log(`[AutoPhoneCall] 已初始化: ${charName}`);
    }

    /**
     * 建立 WebSocket 连接
     */
    connectWebSocket() {
        if (!this.currentCharName) {
            console.error('[AutoPhoneCall] 未设置角色名称');
            return;
        }

        const wsUrl = `${this.wsBaseUrl}/ws/phone_call/${encodeURIComponent(this.currentCharName)}`;
        console.log(`[AutoPhoneCall] 连接 WebSocket: ${wsUrl}`);

        this.ws = new WebSocket(wsUrl);

        this.ws.onopen = () => {
            console.log('[AutoPhoneCall] ✅ WebSocket 已连接');
            this.startHeartbeat();
            this.clearReconnect();
        };

        this.ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                this.handleMessage(data);
            } catch (e) {
                console.error('[AutoPhoneCall] 解析消息失败:', e);
            }
        };

        this.ws.onerror = (error) => {
            console.error('[AutoPhoneCall] ❌ WebSocket 错误:', error);
        };

        this.ws.onclose = () => {
            console.log('[AutoPhoneCall] WebSocket 已断开');
            this.stopHeartbeat();
            this.scheduleReconnect();
        };
    }

    /**
     * 处理接收到的消息
     */
    handleMessage(data) {
        console.log('[AutoPhoneCall] 收到消息:', data);

        switch (data.type) {
            case 'connected':
                console.log(`[AutoPhoneCall] 连接确认: ${data.message}`);
                break;

            case 'phone_call_ready':
                this.onPhoneCallReady(data);
                break;

            default:
                console.log('[AutoPhoneCall] 未知消息类型:', data.type);
        }
    }

    /**
     * 电话生成完成回调
     */
    onPhoneCallReady(data) {
        console.log('[AutoPhoneCall] 🎉 电话生成完成!', data);

        // 显示通知
        this.showNotification(
            `${data.char_name} 给你打来电话!`,
            `点击查看详情`,
            () => this.showPhoneCallDialog(data)
        );

        // 可选: 播放提示音
        this.playNotificationSound();

        // 触发自定义事件,供其他模块监听
        this.dispatchEvent('phone_call_ready', data);
    }

    /**
     * 显示通知
     */
    showNotification(title, message, onClick) {
        // 方式 1: 浏览器原生通知
        if ('Notification' in window && Notification.permission === 'granted') {
            const notification = new Notification(title, {
                body: message,
                icon: '/path/to/icon.png'
            });

            notification.onclick = () => {
                window.focus();
                if (onClick) onClick();
                notification.close();
            };
        }
        // 方式 2: 页面内通知 (Toastr 或自定义)
        else {
            // 假设使用 toastr
            if (typeof toastr !== 'undefined') {
                toastr.info(message, title, {
                    onclick: onClick,
                    timeOut: 10000
                });
            } else {
                alert(`${title}\n${message}`);
            }
        }
    }

    /**
     * 显示电话详情对话框
     */
    showPhoneCallDialog(data) {
        // 创建对话框 HTML
        const dialogHtml = `
            <div class="auto-phone-call-dialog">
                <h3>${data.char_name} 的来电</h3>
                <div class="segments">
                    ${data.segments.map((seg, i) => `
                        <div class="segment">
                            <span class="emotion">[${seg.emotion}]</span>
                            <span class="text">${seg.text}</span>
                        </div>
                    `).join('')}
                </div>
                ${data.audio_path ? `
                    <audio controls autoplay>
                        <source src="${data.audio_path}" type="audio/wav">
                    </audio>
                ` : ''}
                <button onclick="autoPhoneCallManager.closeDialog()">关闭</button>
            </div>
        `;

        // 显示对话框 (根据实际 UI 框架调整)
        // 例如使用 jQuery UI Dialog
        if (typeof $ !== 'undefined' && $.fn.dialog) {
            $(dialogHtml).dialog({
                modal: true,
                width: 500,
                title: '来电通知'
            });
        } else {
            // 简单实现
            const dialog = document.createElement('div');
            dialog.innerHTML = dialogHtml;
            dialog.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:white;padding:20px;border-radius:8px;box-shadow:0 4px 6px rgba(0,0,0,0.1);z-index:9999;';
            document.body.appendChild(dialog);
        }
    }

    /**
     * 播放提示音
     */
    playNotificationSound() {
        const audio = new Audio('/path/to/notification.mp3');
        audio.volume = 0.5;
        audio.play().catch(e => console.log('播放提示音失败:', e));
    }

    /**
     * 发送消息 Webhook
     */
    async sendMessageWebhook(currentFloor, context) {
        if (!this.currentCharName) {
            console.error('[AutoPhoneCall] 未设置角色名称');
            return;
        }

        try {
            const response = await fetch(`${this.apiBaseUrl}/phone_call/webhook/message`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    char_name: this.currentCharName,
                    current_floor: currentFloor,
                    context: context
                })
            });

            const result = await response.json();
            console.log('[AutoPhoneCall] Webhook 响应:', result);

            if (result.status === 'scheduled') {
                console.log(`[AutoPhoneCall] ✅ 已调度生成任务: ID=${result.call_id}`);
            }

            return result;
        } catch (e) {
            console.error('[AutoPhoneCall] Webhook 调用失败:', e);
        }
    }

    /**
     * 获取历史记录
     */
    async getHistory(limit = 10) {
        if (!this.currentCharName) return [];

        try {
            const response = await fetch(
                `${this.apiBaseUrl}/phone_call/auto/history/${encodeURIComponent(this.currentCharName)}?limit=${limit}`
            );
            const result = await response.json();
            return result.history || [];
        } catch (e) {
            console.error('[AutoPhoneCall] 获取历史记录失败:', e);
            return [];
        }
    }

    /**
     * 获取最新记录
     */
    async getLatest() {
        if (!this.currentCharName) return null;

        try {
            const response = await fetch(
                `${this.apiBaseUrl}/phone_call/auto/latest/${encodeURIComponent(this.currentCharName)}`
            );
            const result = await response.json();
            return result.latest;
        } catch (e) {
            console.error('[AutoPhoneCall] 获取最新记录失败:', e);
            return null;
        }
    }

    /**
     * 心跳
     */
    startHeartbeat() {
        this.heartbeatInterval = setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.send('ping');
            }
        }, 30000); // 30秒
    }

    stopHeartbeat() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
    }

    /**
     * 重连
     */
    scheduleReconnect() {
        if (this.reconnectInterval) return;

        console.log('[AutoPhoneCall] 5秒后重连...');
        this.reconnectInterval = setTimeout(() => {
            this.reconnectInterval = null;
            this.connectWebSocket();
        }, 5000);
    }

    clearReconnect() {
        if (this.reconnectInterval) {
            clearTimeout(this.reconnectInterval);
            this.reconnectInterval = null;
        }
    }

    /**
     * 触发自定义事件
     */
    dispatchEvent(eventName, data) {
        const event = new CustomEvent(`auto_phone_call_${eventName}`, {
            detail: data
        });
        window.dispatchEvent(event);
    }

    /**
     * 清理 - 当用户离开对话页面时调用
     */
    cleanup() {
        console.log('[AutoPhoneCall] 清理资源...');
        this.stopHeartbeat();
        this.clearReconnect();

        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }

        this.currentCharName = null;
    }
}

// ==================== 使用示例 ====================

// 全局实例
const autoPhoneCallManager = new AutoPhoneCallManager();

// 1. 在进入角色对话页面时初始化
function onEnterChat(charName) {
    autoPhoneCallManager.init(charName);

    // 请求通知权限
    if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
    }
}

// 2. 在发送消息后调用 webhook
async function onMessageSent(message) {
    // 获取当前对话楼层
    const currentFloor = getCurrentFloor(); // 需要实现此函数

    // 获取对话上下文
    const context = getConversationContext(); // 需要实现此函数

    // 调用 webhook
    await autoPhoneCallManager.sendMessageWebhook(currentFloor, context);
}

// 3. 监听电话生成完成事件
window.addEventListener('auto_phone_call_phone_call_ready', (event) => {
    console.log('监听到电话生成完成:', event.detail);
    // 自定义处理逻辑
});

// 4. 在离开对话页面时清理
function onLeaveChat() {
    autoPhoneCallManager.cleanup();
}

// 5. 查看历史记录
async function showAutoCallHistory() {
    const history = await autoPhoneCallManager.getHistory(20);
    console.log('历史记录:', history);
    // 渲染历史记录列表
}

// ==================== 辅助函数示例 ====================

/**
 * 获取当前对话楼层
 * 需要根据实际的 SillyTavern 数据结构实现
 */
function getCurrentFloor() {
    // 示例: 假设消息存储在全局变量 chat 中
    // return chat.length;

    // 或者从 DOM 中计算
    return document.querySelectorAll('.mes').length;
}

/**
 * 获取对话上下文
 * 需要根据实际的 SillyTavern 数据结构实现
 */
function getConversationContext() {
    // 示例: 返回最近10条消息
    // return chat.slice(-10).map(msg => ({
    //     role: msg.is_user ? 'user' : 'assistant',
    //     content: msg.mes
    // }));

    return [];
}
