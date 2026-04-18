import os
import wave
from config import load_json, save_json, MAX_CACHE_SIZE_MB

def get_audio_duration(file_path):
    """获取音频文件时长(秒)"""
    try:
        with wave.open(file_path, 'r') as audio:
            frames = audio.getnframes()
            rate = audio.getframerate()
            duration = frames / float(rate)
            return duration
    except Exception as e:
        print(f"⚠️ 无法读取音频时长: {file_path}, 错误: {e}")
        return None

def pad_audio_to_duration(input_path, target_duration=3.0):
    """将音频填充到指定时长(在末尾添加静音)"""
    try:
        # 创建临时备份
        backup_path = input_path + ".tmp_backup"
        import shutil
        shutil.copy2(input_path, backup_path)
        
        # 读取原始音频
        with wave.open(backup_path, 'r') as audio:
            params = audio.getparams()
            frames = audio.readframes(audio.getnframes())
            current_duration = audio.getnframes() / audio.getframerate()
            
            if current_duration >= target_duration:
                os.remove(backup_path)
                return False
            
            # 计算需要添加的静音帧数
            silence_duration = target_duration - current_duration
            silence_frames = int(silence_duration * audio.getframerate())
            silence = b'\x00' * (silence_frames * params.sampwidth * params.nchannels)
        
        # 写入新文件
        with wave.open(input_path, 'w') as output:
            output.setparams(params)
            output.writeframes(frames + silence)
        
        # 删除备份
        os.remove(backup_path)
        print(f"✅ 音频已自动填充: {os.path.basename(input_path)} ({current_duration:.2f}s → {target_duration:.2f}s)")
        return True
        
    except Exception as e:
        print(f"❌ 音频填充失败: {input_path}, 错误: {e}")
        # 恢复备份
        if os.path.exists(backup_path):
            import shutil
            shutil.move(backup_path, input_path)
        return False

def _parse_ref_audio_metadata(filename):
    """
    从参考音频文件名解析 emotion 和 prompt_text。
    
    支持的命名格式：
    1. 标准格式:  {emotion}_{prompt_text}.wav   → emotion="happy", text="你好世界"
    2. 无下划线:  {text}.wav                      → emotion="default", text="{text}"
    3. 特殊前缀:  {特殊字符开头}_{内容}.wav        → emotion="default", text="完整文件名(去扩展名)"
       （如 ____________________tts-id-xxx_original.wav、04她...岸边归来.wav）
    
    Returns:
        (emotion, text) 元组
    """
    import re
    name = os.path.splitext(filename)[0]
    
    # 空名称保护
    if not name.strip():
        return ("default", "")
    
    # 检查是否是标准格式: 以英文/中文情绪词开头 + 下划线
    # 标准情绪关键词列表
    standard_emotions = {
        'default', 'happy', 'sad', 'angry', 'surprised', 'fearful',
        'disgusted', 'neutral', 'calm', 'excited', 'gentle', 'cold',
        '快乐', '悲伤', '愤怒', '惊讶', '恐惧', '厌恶', '平静', '兴奋',
        '温柔', '冷漠', '默认'
    }
    
    if '_' in name:
        parts = name.split('_', 1)
        candidate_emotion = parts[0].strip()
        
        # 只有当第一部分看起来像合理的情绪标签时才拆分
        if (candidate_emotion.lower() in standard_emotions or 
            candidate_emotion in standard_emotions):
            # 合理的情绪标签 → 标准拆分
            return (candidate_emotion, parts[1] if len(parts) > 1 else "")
        
        # 第一部分不是有效情绪词 → 可能是非标准命名（如"04她...岸边归来"）
        # 将完整文件名作为 text，emotion 用 default
        print(f"[scan_audio] ℹ️ 非标准文件名 '{filename}' → 使用完整名称作为文本引用")
        return ("default", name)
    
    # 没有下划线 → 整体作为 text
    return ("default", name)


def scan_audio_files(directory):
    """扫描目录下的音频文件,跳过不符合时长要求的文件"""
    refs = []
    warnings = []
    
    if not os.path.exists(directory): 
        return refs
    
    for f in os.listdir(directory):
        if f.lower().endswith(('.wav', '.mp3')):
            full_path = os.path.join(directory, f)
            
            # 检查音频时长
            duration = get_audio_duration(full_path)
            
            if duration is None:
                warnings.append(f"⚠️ 无法读取: {f}")
                continue
            
            # 检查时长范围 (3-10秒)
            if duration < 2.99:  # 使用 2.99 避免浮点数精度问题
                warnings.append(f"⚠️ 音频过短 ({duration:.2f}s < 3s): {f}")
                print(f"⚠️ 跳过过短音频: {f} ({duration:.2f}秒)")
                continue
            elif duration > 10.01:  # 使用 10.01 避免浮点数精度问题
                warnings.append(f"⚠️ 音频过长 ({duration:.2f}s > 10s): {f}")
                print(f"⚠️ 跳过过长音频: {f} ({duration:.2f}秒)")
                continue
            
            # 正常音频，使用改进的解析逻辑
            emotion, text = _parse_ref_audio_metadata(f)
            
            # 如果解析出的 text 看起来不合理（太短或包含可疑字符），给出警告
            if text and len(text) > 0 and len(text) < 4:
                print(f"[scan_audio] ⚠️ 文件 '{f}' 的 prompt_text 较短 ('{text}')，可能影响 TTS 质量")
            
            refs.append({
                "emotion": emotion, 
                "text": text, 
                "path": full_path,
                "duration": duration,
                "filename": f  # 保留原始文件名便于调试
            })
    
    # 如果有警告,打印汇总
    if warnings:
        print(f"\n⚠️ 发现 {len(warnings)} 个不合格的参考音频:")
        for warning in warnings[:5]:  # 只显示前5个
            print(f"  {warning}")
        if len(warnings) > 5:
            print(f"  ... 还有 {len(warnings) - 5} 个")
        print("💡 提示: 请在管理页面重新上传这些音频,系统会自动处理时长问题\n")
    
    return refs

def maintain_cache_size(cache_dir):
    """清理缓存以限制大小"""
    try:
        if not os.path.exists(cache_dir): return
        files = []
        total_size = 0
        with os.scandir(cache_dir) as it:
            for entry in it:
                if entry.is_file() and entry.name.endswith('.wav'):
                    stat = entry.stat()
                    files.append({"path": entry.path, "size": stat.st_size, "mtime": stat.st_mtime})
                    total_size += stat.st_size

        if (total_size / (1024 * 1024)) < MAX_CACHE_SIZE_MB: return

        # 按修改时间排序，删除旧的
        files.sort(key=lambda x: x["mtime"])
        for f in files:
            try:
                os.remove(f["path"])
                total_size -= f["size"]
                if (total_size / (1024 * 1024)) < (MAX_CACHE_SIZE_MB * 0.9): break
            except: pass
    except: pass
