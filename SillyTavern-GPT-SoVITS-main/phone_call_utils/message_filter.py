import re
from typing import Optional


class MessageFilter:
    """
    消息内容过滤工具
    参考 docs/src.js 的 applyFilterTags 实现
    """
    
    @staticmethod
    def extract_and_filter(text: str, extract_tag: str = "", filter_tags: str = "") -> str:
        """
        两步处理消息内容:
        1. 文本提取: 如果配置了 extract_tag,提取标签内的内容
        2. 内容过滤: 对提取后的内容应用过滤标签
        
        Args:
            text: 原始文本
            extract_tag: 提取标签名称(如 "conxt"),留空则跳过提取步骤
            filter_tags: 过滤标签(逗号分隔),如 "<small>, [statbar]"
            
        Returns:
            处理后的文本
        """
        if not text or not isinstance(text, str):
            return text
        
        # 步骤1: 文本提取
        processed_text = text
        if extract_tag and extract_tag.strip():
            processed_text = MessageFilter._extract_content(text, extract_tag.strip())
        
        # 步骤2: 内容过滤
        if filter_tags and filter_tags.strip():
            processed_text = MessageFilter.apply_filter_tags(processed_text, filter_tags)
        
        return processed_text
    
    @staticmethod
    def _extract_content(text: str, tag_name: str) -> str:
        """
        提取指定标签内的内容
        
        Args:
            text: 原始文本
            tag_name: 标签名称(如 "conxt")
            
        Returns:
            提取的内容,如果未找到标签则返回原文本
        """
        # 构建正则表达式: <tag_name>...</tag_name>
        # 使用非贪婪匹配
        pattern = f"<{re.escape(tag_name)}>(.*?)</{re.escape(tag_name)}>"
        match = re.search(pattern, text, re.DOTALL | re.IGNORECASE)
        
        if match:
            return match.group(1)
        
        # 未找到标签,返回原文本
        return text
    
    @staticmethod
    def apply_filter_tags(text: str, filter_tags: str) -> str:
        """
        根据配置的标签过滤文本内容
        支持三种格式:
        1. <xxx> - 过滤 <xxx>...</xxx> 包裹的内容
        2. [xxx] - 过滤 [xxx]...[/xxx] 包裹的内容
        3. 前缀|后缀 - 过滤以前缀开头、后缀结尾的内容(如: <thought target=|</thought>)
        
        Args:
            text: 原始文本
            filter_tags: 过滤标签配置(逗号分隔)
            
        Returns:
            过滤后的文本
        """
        if not text or not isinstance(text, str):
            return text
        
        if not filter_tags or not filter_tags.strip():
            return text
        
        filtered = text
        # 分割标签并去除空白
        tags = [t.strip() for t in filter_tags.split(',') if t.strip()]
        
        for tag in tags:
            # 格式3: 前缀|后缀 格式(如: <thought target=|</thought>)
            if '|' in tag:
                parts = tag.split('|')
                if len(parts) == 2 and parts[0] and parts[1]:
                    prefix = parts[0]
                    suffix = parts[1]
                    # 转义正则特殊字符
                    escaped_prefix = re.escape(prefix)
                    escaped_suffix = re.escape(suffix)
                    # 使用非贪婪匹配
                    pattern = f"{escaped_prefix}[\\s\\S]*?{escaped_suffix}"
                    filtered = re.sub(pattern, '', filtered, flags=re.IGNORECASE)
            
            # 格式1: HTML风格标签,如 <small>
            elif tag.startswith('<') and tag.endswith('>'):
                tag_name = tag[1:-1]  # 去除 < 和 >
                # 匹配 <tag_name ...>...</tag_name>
                # 支持标签属性,如 <small class="...">
                pattern = f"<{tag_name}[^>]*>[\\s\\S]*?</{tag_name}>"
                filtered = re.sub(pattern, '', filtered, flags=re.IGNORECASE)
            
            # 格式2: 方括号风格标签,如 [statbar]
            elif tag.startswith('[') and tag.endswith(']'):
                tag_name = tag[1:-1]  # 去除 [ 和 ]
                # 转义标签名中的特殊字符
                escaped_tag = re.escape(tag_name)
                # 匹配 [tag_name]...[/tag_name]
                pattern = f"\\[{escaped_tag}\\][\\s\\S]*?\\[/{escaped_tag}\\]"
                filtered = re.sub(pattern, '', filtered, flags=re.IGNORECASE)
        
        return filtered
