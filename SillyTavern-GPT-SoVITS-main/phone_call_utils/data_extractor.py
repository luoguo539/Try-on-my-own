import re
from typing import List, Dict
from phone_call_utils.context_converter import ContextConverter


class DataExtractor:
    """数据提取工具"""
    
    @staticmethod
    def extract(context: List[Dict], extractors: List[Dict]) -> Dict[str, List[str]]:
        """
        使用配置的提取器从上下文中提取数据
        
        Args:
            context: 对话上下文列表,标准格式 [{"role": "user"|"assistant"|"system", "content": "..."}, ...]
            extractors: 提取器配置列表
                每个提取器包含:
                - name: 提取器名称
                - pattern: 正则表达式模式
                - scope: 过滤范围 ("character_only" | "user_only" | "all")
                - limit: 可选,限制提取数量
                - recent_only: 可选,仅从最近N条消息提取
                - deduplicate: 可选,是否去重(默认True)
            
        Returns:
            提取结果字典 {extractor_name: [matched_values]}
        """
        # 转换上下文为标准格式 {role, content}
        context = ContextConverter.convert_to_standard_format(context)
        
        results = {}
        
        for extractor in extractors:
            name = extractor["name"]
            pattern = extractor["pattern"]
            scope = extractor["scope"]
            limit = extractor.get("limit", None)
            recent_only = extractor.get("recent_only", None)
            deduplicate = extractor.get("deduplicate", True)
            
            results[name] = []
            
            # 过滤消息
            filtered_messages = DataExtractor._filter_by_scope(context, scope)
            
            # 限制最近消息
            if recent_only and recent_only > 0:
                filtered_messages = filtered_messages[-recent_only:]
            
            # 提取数据
            for msg in filtered_messages:
                content = msg.get('content', '')  # 使用标准的 'content' 字段
                matches = re.findall(pattern, content)
                results[name].extend(matches)
            
            # 去重
            if deduplicate:
                results[name] = list(dict.fromkeys(results[name]))
            
            # 限制数量
            if limit and limit > 0:
                results[name] = results[name][:limit]
            
            print(f"[DataExtractor] {name}: 提取到 {len(results[name])} 项数据")
        
        return results
    
    @staticmethod
    def _filter_by_scope(context: List[Dict], scope: str) -> List[Dict]:
        """
        按scope过滤消息
        
        Args:
            context: 对话上下文,标准格式 [{"role": "user"|"assistant"|"system", "content": "..."}]
            scope: 过滤范围 ("character_only" | "user_only" | "all")
            
        Returns:
            过滤后的消息列表
        """
        if scope == "character_only":
            return [msg for msg in context if msg.get('role') == 'assistant']
        elif scope == "user_only":
            return [msg for msg in context if msg.get('role') == 'user']
        else:
            return context
