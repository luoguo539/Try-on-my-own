/**
 * WebSocket 管理器
 * 
 * 职责:
 * - 建立与后端的 WebSocket 连接
 * - 接收后端推送的消息 (llm_request, phone_call_ready 等)
 * - 将消息转发到 TTS_Events 事件系统
 * - 自动重连机制
 */

export const WebSocketManager = {
    // WebSocket 连接
    ws: null,

    // 当前角色名称
    currentCharName: null,

    // 重连配置
    reconnectAttempts: 0,
    maxReconnectAttempts: 5,
    reconnectDelay: 3000,
    reconnectTimer: null,

    // 心跳配置
    heartbeatInterval: null,
    heartbeatDelay: 30000, // 30秒

    /**
     * 初始化 WebSocket 连接
     * @param {string} charName - 角色名称
     */
    connect(charName) {
        if (!charName) {
            console.warn('[WebSocketManager] ⚠️ 角色名称为空,跳过连接');
            return;
        }

        // 如果已连接或正在连接到相同角色,跳过
        if (this.ws && this.currentCharName === charName) {
            const state = this.ws.readyState;
            if (state === WebSocket.CONNECTING) {
                console.log('[WebSocketManager] ℹ️ 正在连接到相同角色,跳过');
                return;
            }
            if (state === WebSocket.OPEN) {
                console.log('[WebSocketManager] ℹ️ 已连接到相同角色,跳过');
                return;
            }
        }

        // 关闭旧连接
        this.disconnect();

        this.currentCharName = charName;

        // 获取 API Host
        const apiHost = this.getApiHost();
        const wsUrl = `ws://${apiHost.replace(/^https?:\/\//, '')}/api/ws/phone_call/${encodeURIComponent(charName)}`;

        console.log(`[WebSocketManager] 🔌 正在连接: ${wsUrl}`);

        try {
            this.ws = new WebSocket(wsUrl);

            this.ws.onopen = () => {
                console.log(`[WebSocketManager] ✅ WebSocket 已连接: ${charName}`);
                this.reconnectAttempts = 0;
                this.startHeartbeat();
            };

            this.ws.onmessage = (event) => {
                this.handleMessage(event.data);
            };

            this.ws.onerror = (error) => {
                console.error('[WebSocketManager] ❌ WebSocket 错误:');
                console.error('  - URL:', wsUrl);
                console.error('  - ReadyState:', this.ws?.readyState);
                console.error('  - Error:', error);
            };

            this.ws.onclose = (event) => {
                console.log('[WebSocketManager] 🔌 WebSocket 已断开');
                console.log('  - Code:', event.code);
                console.log('  - Reason:', event.reason || '(无原因)');
                console.log('  - Clean:', event.wasClean);
                this.stopHeartbeat();
                this.scheduleReconnect();
            };

        } catch (error) {
            console.error('[WebSocketManager] ❌ 创建 WebSocket 失败:', error);
            this.scheduleReconnect();
        }
    },

    /**
     * 断开连接
     */
    disconnect() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        this.stopHeartbeat();

        if (this.ws) {
            try {
                this.ws.close();
            } catch (e) {
                console.warn('[WebSocketManager] 关闭连接时出错:', e);
            }
            this.ws = null;
        }
    },

    /**
     * 处理接收到的消息
     * @param {string} data - 消息数据
     */
    handleMessage(data) {
        // 跳过心跳响应
        if (data === 'pong') {
            return;
        }

        try {
            const message = JSON.parse(data);
            console.log('[WebSocketManager] 📥 收到消息:', message);

            // 转发到 TTS_Events
            if (window.TTS_Events && window.TTS_Events.emit) {
                window.TTS_Events.emit('websocket_message', message);
            } else {
                console.warn('[WebSocketManager] ⚠️ TTS_Events 未就绪,消息未转发');
            }

        } catch (error) {
            console.error('[WebSocketManager] ❌ 解析消息失败:', error, data);
        }
    },

    /**
     * 调度重连
     */
    scheduleReconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.warn('[WebSocketManager] ⚠️ 达到最大重连次数,停止重连');
            return;
        }

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
        }

        this.reconnectAttempts++;
        const delay = this.reconnectDelay * this.reconnectAttempts;

        console.log(`[WebSocketManager] 🔄 ${delay}ms 后重连 (尝试 ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

        this.reconnectTimer = setTimeout(() => {
            if (this.currentCharName) {
                this.connect(this.currentCharName);
            }
        }, delay);
    },

    /**
     * 启动心跳
     */
    startHeartbeat() {
        this.stopHeartbeat();

        this.heartbeatInterval = setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                try {
                    this.ws.send('ping');
                } catch (e) {
                    console.warn('[WebSocketManager] ⚠️ 心跳发送失败:', e);
                }
            }
        }, this.heartbeatDelay);
    },

    /**
     * 停止心跳
     */
    stopHeartbeat() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
    },

    /**
     * 获取 API Host
     */
    getApiHost() {
        // 从 TTS_State 获取配置的 API Host
        if (window.TTS_State && window.TTS_State.CACHE && window.TTS_State.CACHE.API_URL) {
            return window.TTS_State.CACHE.API_URL;
        }

        // 回退到默认值
        const apiHost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
            ? '127.0.0.1'
            : window.location.hostname;

        return `http://${apiHost}:3000`;
    }
};

// 挂载到全局
window.TTS_WebSocketManager = WebSocketManager;

console.log('[WebSocketManager] 📦 模块已加载');

export default WebSocketManager;
