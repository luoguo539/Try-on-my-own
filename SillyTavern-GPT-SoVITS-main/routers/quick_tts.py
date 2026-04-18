"""
快速朗读模块 - Quick TTS

核心功能：
- 接收前端发送的文本，直接复用 tts_proxy 链路生成音频
- 不依赖 [TTSVoice] 标签解析，直接接收已处理文本
- 支持通过前端 LLM 预处理（提取可读文本 + 情感标签）
"""

import os
import hashlib
import struct
import requests
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse
from typing import Optional

from config import get_current_dirs, get_sovits_host

router = APIRouter()

# 锁管理器（单例，避免重复导入）
_lock_manager = None


def _get_wav_duration(wav_path):
    """
    从 WAV 文件头解析音频时长（秒），不依赖外部库。
    
    WAV 文件格式：
      - RIFF header (12 bytes)
      - fmt chunk: 包含 sample_rate, channels, bits_per_sample
      - data chunk: 包含音频数据大小
    
    时长 = data_size / (sample_rate * channels * bits_per_sample / 8)
    """
    try:
        with open(wav_path, 'rb') as f:
            # 跳过 RIFF header (12 bytes)
            riff = f.read(4)
            if riff != b'RIFF':
                return 0.0
            f.read(4)  # file size
            wave = f.read(4)
            if wave != b'WAVE':
                return 0.0

            # 查找 fmt chunk
            sample_rate = 0
            channels = 0
            bits_per_sample = 16
            data_size = 0

            while True:
                chunk_id = f.read(4)
                if len(chunk_id) < 4:
                    break
                chunk_size = struct.unpack('<I', f.read(4))[0]

                if chunk_id == b'fmt ':
                    audio_format = struct.unpack('<H', f.read(2))[0]
                    channels = struct.unpack('<H', f.read(2))[0]
                    sample_rate = struct.unpack('<I', f.read(4))[0]
                    # byte_rate = struct.unpack('<I', f.read(4))[0]  # skip
                    # block_align = struct.unpack('<H', f.read(2))[0]  # skip
                    bits_per_sample = struct.unpack('<H', f.read(2))[0]
                    # 如果 fmt chunk 有额外字节，跳过
                    extra = chunk_size - 16
                    if extra > 0:
                        f.read(extra)

                elif chunk_id == b'data':
                    data_size = chunk_size
                    break  # 找到 data chunk，不需要再读了

                else:
                    # 跳过未知 chunk（对齐到偶数字节边界）
                    f.read(chunk_size + (chunk_size % 2))

            # 计算时长
            if sample_rate > 0 and channels > 0 and bits_per_sample > 0 and data_size > 0:
                bytes_per_sample = bits_per_sample // 8
                duration = data_size / (sample_rate * channels * bytes_per_sample)
                return duration
            return 0.0

    except Exception as e:
        print(f"[QuickTTS] ⚠️ 无法解析 WAV 时长: {e}")
        return 0.0


def _get_lock_manager():
    """懒加载锁管理器，导入失败时回退到空上下文"""
    global _lock_manager
    if _lock_manager is not None:
        return _lock_manager

    try:
        from services.model_weight_service import model_weight_service
        _lock_manager = model_weight_service
        print("[QuickTTS] ✅ model_weight_service 加载成功")
    except ImportError:
        import contextlib
        _lock_manager = contextlib.nullcontext
        print("[QuickTTS] ⚠️ model_weight_service 不可用，跳过模型锁")
    except Exception as e:
        import contextlib
        _lock_manager = contextlib.nullcontext
        print(f"[QuickTTS] ⚠️ model_weight_service 加载异常: {e}")
    return _lock_manager


def _maintain_cache_size(cache_dir):
    """缓存清理（内联实现，避免跨模块导入问题）"""
    try:
        from config import MAX_CACHE_SIZE_MB
    except ImportError:
        MAX_CACHE_SIZE_MB = 500

    try:
        if not os.path.exists(cache_dir):
            return
        files = []
        total_size = 0
        with os.scandir(cache_dir) as it:
            for entry in it:
                if entry.is_file() and entry.name.endswith('.wav'):
                    stat = entry.stat()
                    files.append({"path": entry.path, "size": stat.st_size, "mtime": stat.st_mtime})
                    total_size += stat.st_size

        if (total_size / (1024 * 1024)) < MAX_CACHE_SIZE_MB:
            return

        files.sort(key=lambda x: x["mtime"])
        for f in files:
            try:
                os.remove(f["path"])
                total_size -= f["size"]
                if (total_size / (1024 * 1024)) < (MAX_CACHE_SIZE_MB * 0.9):
                    break
            except Exception:
                pass
    except Exception:
        pass


@router.get("/quick_tts")
async def quick_tts(
    text: str,
    text_lang: str = "zh",
    ref_audio_path: str = "",
    prompt_text: str = "",
    prompt_lang: str = "zh",
    emotion: str = "default",
    check_only: Optional[str] = None
):
    """
    快速朗读端点 - 直接将文本发送到 SoVITS 生成音频

    与 tts_proxy 的区别：
    - ref_audio_path/prompt_text 为可选（不传则走无参考音频模式）
    - 专为前端 quick_tts.js 设计
    - 缓存 key 包含 "quick_" 前缀避免与普通 TTS 缓存冲突

    Args:
        text: 要朗读的文本（前端已处理过，去除 HTML/标签）
        text_lang: 文本语言 (zh/ja/en)
        ref_audio_path: 参考音频路径（可选，由前端根据角色模型传入）
        prompt_text: 参考音频文本（可选）
        prompt_lang: 参考音频语言（可选）
        emotion: 情感标签 (default/happy/sad/angry/surprised 等)
        check_only: 仅检查缓存

    Returns:
        audio/wav 文件或缓存状态 JSON
    """
    if not text or not text.strip():
        raise HTTPException(status_code=400, detail="文本内容不能为空")

    _, cache_dir = get_current_dirs()

    try:
        # 缓存 Key: 使用 quick_ 前缀区分
        cache_key = f"quick_{text}_{emotion}_{text_lang}_{ref_audio_path}"
        cache_hash = hashlib.md5(cache_key.encode('utf-8')).hexdigest()
        cache_filename = f"quick_{cache_hash}.wav"
        cache_path = os.path.join(cache_dir, cache_filename)

        custom_headers = {
            "X-Audio-Filename": cache_filename,
            "Access-Control-Expose-Headers": "X-Audio-Filename"
        }

        # 缓存检查
        if check_only == "true":
            return {
                "cached": os.path.exists(cache_path),
                "filename": cache_filename
            }

        # 命中缓存直接返回
        if os.path.exists(cache_path):
            return FileResponse(cache_path, media_type="audio/wav", headers=custom_headers)

        # 需要生成，获取锁
        lock_mgr = _get_lock_manager()
        if lock_mgr:
            lock_ctx = lock_mgr.acquire_lock(f"quick_tts_{emotion}")
        else:
            import contextlib
            lock_ctx = contextlib.nullcontext()

        async with lock_ctx:
            # 再次检查缓存（可能在等锁时已有其他请求生成）
            if os.path.exists(cache_path):
                return FileResponse(cache_path, media_type="audio/wav", headers=custom_headers)

            # 如果有参考音频，验证路径存在
            if ref_audio_path:
                if not os.path.exists(ref_audio_path):
                    raise HTTPException(
                        status_code=400,
                        detail=f"参考音频文件不存在: {ref_audio_path}"
                    )
                if not prompt_text:
                    raise HTTPException(
                        status_code=400,
                        detail="提供了 ref_audio_path 但缺少 prompt_text"
                    )

            _maintain_cache_size(cache_dir)

            # 转发到 SoVITS
            sovits_host = get_sovits_host()
            url = f"{sovits_host}/tts"
            params = {
                "text": text,
                "text_lang": text_lang,
                "streaming_mode": "false",
                "text_split_method": "cut0"  # 显式指定文本切分方式
            }

            # 如果有参考音频则传入
            if ref_audio_path and prompt_text:
                params["ref_audio_path"] = ref_audio_path
                params["prompt_text"] = prompt_text
                params["prompt_lang"] = prompt_lang

            print(f"[QuickTTS] 🎤 生成中: text_len={len(text)}, emotion={emotion}, "
                  f"has_ref={bool(ref_audio_path)}, sovits={sovits_host}")
            
            # 🔍 详细诊断日志：打印完整参数（脱敏）
            safe_params = dict(params)
            if "ref_audio_path" in safe_params:
                import os as _os
                safe_params["ref_audio_path"] = _os.path.basename(safe_params["ref_audio_path"])
            print(f"[QuickTTS] 📋 发送参数: {safe_params}")

            try:
                r = requests.get(
                    url,
                    params=params,
                    timeout=120,
                    proxies={'http': None, 'https': None}
                )
            except requests.exceptions.Timeout:
                raise HTTPException(status_code=503, detail="SoVITS 请求超时 (120秒)")
            except requests.exceptions.ConnectionError:
                raise HTTPException(
                    status_code=503,
                    detail=f"无法连接到 SoVITS 服务 ({sovits_host})，请检查服务是否启动"
                )
            except requests.exceptions.RequestException as e:
                raise HTTPException(status_code=503, detail=f"SoVITS 连接失败: {str(e)}")

            if r.status_code != 200:
                detail_msg = f"SoVITS 返回错误 (HTTP {r.status_code})"
                try:
                    err_body = r.json()
                    if isinstance(err_body, dict) and "message" in err_body:
                        detail_msg = f"SoVITS: {err_body['message']}"
                    elif isinstance(err_body, dict) and "detail" in err_body:
                        detail_msg = f"SoVITS: {err_body['detail']}"
                    else:
                        detail_msg = f"SoVITS: {str(err_body)[:200]}"
                except Exception:
                    if r.text:
                        detail_msg = f"SoVITS: {r.text[:200]}"
                print(f"[QuickTTS] ❌ {detail_msg}")
                raise HTTPException(status_code=502, detail=detail_msg)

            # 检查返回内容是否为有效音频
            content_type = r.headers.get('Content-Type', '')
            if len(r.content) < 1000 and 'audio' not in content_type and 'octet-stream' not in content_type:
                detail_msg = f"SoVITS 返回了非音频数据 ({len(r.content)} bytes)"
                try:
                    detail_msg = f"SoVITS 返回异常: {r.text[:200]}"
                except Exception:
                    pass
                print(f"[QuickTTS] ❌ {detail_msg}")
                raise HTTPException(status_code=502, detail=detail_msg)

            # 保存缓存
            temp_path = cache_path + ".tmp"
            try:
                with open(temp_path, "wb") as f:
                    f.write(r.content)
                if os.path.exists(cache_path):
                    os.remove(cache_path)
                os.rename(temp_path, cache_path)

                # 获取音频文件大小和时长
                file_size = len(r.content)
                audio_duration = _get_wav_duration(cache_path)

                print(f"[QuickTTS] ✅ 生成成功: {cache_filename} ({file_size} bytes, {audio_duration:.2f}s)")

                # 将元数据写入响应头
                custom_headers["X-Audio-Size"] = str(file_size)
                custom_headers["X-Audio-Duration"] = f"{audio_duration:.3f}"
                custom_headers["Access-Control-Expose-Headers"] = "X-Audio-Filename, X-Audio-Size, X-Audio-Duration"

            except Exception as e:
                print(f"[QuickTTS] ❌ 文件保存错误: {e}")
                if os.path.exists(temp_path):
                    os.remove(temp_path)
                raise HTTPException(status_code=500, detail="音频文件保存失败")

        return FileResponse(cache_path, media_type="audio/wav", headers=custom_headers)

    except HTTPException as he:
        raise he
    except Exception as e:
        import traceback
        print(f"[QuickTTS] ❌ 未预期错误: {e}")
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Quick TTS 内部错误: {str(e)}")
