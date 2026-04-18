# 快速朗读功能 (Quick TTS) 实现说明

## 概述

在 SillyTavern-GPT-SoVITS 扩展基础上新增"快速朗读"功能，无需依赖 `[TTSVoice]` 标签解析，直接将角色对话文本发送到 TTS 后端生成音频并播放。

## 架构设计

```
角色新消息 ──► 提取纯文本 ──► [可选] LLM 预处理 ──► /quick_tts 端点 ──► GPT-SoVITS (9880)
                                  │                        │
                                  │                    缓存机制
                                  │                        │
                            提取可读文本              直接播放
                            + 情感标签
```

## 修改的文件

### 后端 (Python)

| 文件 | 变更 | 说明 |
|------|------|------|
| `routers/quick_tts.py` | **新增** | 快速朗读路由，复用 tts_proxy 的缓存和 SoVITS 转发逻辑 |
| `manager.py` | 修改 | 注册 `quick_tts.router` 到 FastAPI 应用 |

### 前端 (JavaScript)

| 文件 | 变更 | 说明 |
|------|------|------|
| `frontend/js/quick_tts.js` | **新增** | 快速朗读控制器（消息提取、LLM 预处理、播放控制、UI） |
| `frontend/js/api.js` | 修改 | 新增 `checkQuickTTSCache()` 和 `generateQuickTTS()` API 方法 |
| `index.js` | 修改 | 导入并初始化 QuickTTS 模块 |

## 功能特性

### 1. 自动朗读新消息
- 监听 `CHARACTER_MESSAGE_RENDERED` 事件
- 自动提取角色最新对话文本
- 直接调用 `/quick_tts` 生成音频并播放
- 可通过 🔊 按钮一键开关

### 2. LLM 预处理（可选）
- 使用已有的 `LLM_Client`（前端调用，避免服务端 502 问题）
- 复用电话功能的 LLM 配置（`phone_call.llm`）
- 提取可朗读的纯文本 + 推断情感标签
- 提示词模板会去除 HTML、Markdown、动作描写等非朗读内容

### 3. 手动朗读
- ▶️ 按钮可手动触发朗读最后一条消息
- 适用于浏览历史对话时想朗读某条消息

### 4. 完全复用现有能力
- **缓存机制**: 使用 `quick_` 前缀的缓存 key，与普通 TTS 互不干扰
- **模型切换**: 复用 `proxy_set_gpt_weights` / `proxy_set_sovits_weights`
- **角色模型映射**: 自动根据当前角色名查找对应的参考音频
- **电话功能**: 完全不受影响，独立运行

## API 端点

### `GET /quick_tts`

请求参数：
| 参数 | 类型 | 必需 | 默认值 | 说明 |
|------|------|------|--------|------|
| text | string | ✅ | - | 要朗读的文本 |
| text_lang | string | ❌ | zh | 文本语言 (zh/ja/en) |
| ref_audio_path | string | ❌ | - | 参考音频路径 |
| prompt_text | string | ❌ | - | 参考音频文本 |
| prompt_lang | string | ❌ | zh | 参考音频语言 |
| emotion | string | ❌ | default | 情感标签 |
| check_only | string | ❌ | - | 设为 "true" 仅检查缓存 |

响应：
- `check_only=true`: 返回 `{cached: bool, filename: str}`
- 正常请求: 返回 `audio/wav` 文件，带 `X-Audio-Filename` 响应头

## UI 控件

在发送栏右侧新增三个按钮：
- 🔊 **开关按钮**: 切换快速朗读的开启/关闭
- ▶️ **手动朗读**: 点击朗读最后一条角色消息
- ⚙️ **设置**: 打开设置面板

设置面板选项：
- ✅ 新消息自动朗读
- ✅ 使用 LLM 预处理（需配置电话功能的 LLM API）
- ✅ 启用快速朗读

## 配置存储

用户偏好保存在 `localStorage.quick_tts_config`：
```json
{
    "enabled": true,
    "autoPlay": true,
    "useLLM": false
}
```

## 与现有功能的对比

| 特性 | 原有 TTS（[TTSVoice]） | 快速朗读 |
|------|------------------------|---------|
| 触发方式 | 解析 `[TTSVoice]` 标签 | 监听新消息事件 |
| 文本来源 | 标签内文本 | 消息全文（LLM 可提取） |
| 情感控制 | 标签内指定 | LLM 推断 / default |
| 参考音频 | 按角色绑定自动匹配 | 同上 |
| 缓存 | 共享缓存 | `quick_` 前缀独立缓存 |
| 互影响 | 无 | 无 |

## 部署步骤

1. 将修改后的文件复制到扩展目录
2. 重启扩展后端（`python manager.py`）
3. 刷新 SillyTavern 页面
4. 在发送栏右侧看到 🔊 按钮
5. 发送消息给角色，自动朗读最后一条回复

## 后续优化方向

- [ ] 添加对话历史上下文发送给 LLM（提升情感判断准确性）
- [ ] 支持选中特定文本进行朗读
- [ ] 添加朗读队列（多条消息排队朗读）
- [ ] 快捷键绑定（如 Ctrl+Shift+T）
- [ ] 音量/语速控制
- [ ] 支持流式音频播放（减少首字延迟）
