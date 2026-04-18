// static/js/state.js
export const TTS_State = {
    // 核心缓存数据
    CACHE: {
        models: {},
        mappings: {},
        settings: {
            auto_generate: true,
            enabled: true,
            iframe_mode: false // 显式初始化
        },
        audioMemory: {},
        pendingTasks: new Set(),
        API_URL: "" // 添加 API_URL 字段供其他模块使用
    },

    // 当前加载的模型记录
    CURRENT_LOADED: {
        gpt_path: null,
        sovits_path: null
    },

    // 提供一个简单的初始化/重置方法（预留未来使用）
    init() {
        console.log("✅ [State] 状态管理模块已就绪");
    }
};
