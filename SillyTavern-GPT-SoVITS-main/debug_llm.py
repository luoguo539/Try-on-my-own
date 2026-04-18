"""
调试LLM API调用
直接测试本地反代服务是否可用
"""
import httpx
import json

# 配置 - 从system_settings.json读取
API_URL = "http://127.0.0.1:7861/v1"
API_KEY = "pwd"  # 用户配置的密钥

async def test_llm_direct():
    """直接测试LLM API"""
    print("="*60)
    print("直接测试本地反代LLM API")
    print("="*60)
    
    # 自动添加 /chat/completions 后缀(如果不存在)
    llm_url = API_URL.strip()
    if '/chat/completions' not in llm_url:
        llm_url = llm_url.rstrip('/') + '/chat/completions'
    
    print(f"基础API地址: {API_URL}")
    print(f"完整API地址: {llm_url}")
    print(f"API密钥: {API_KEY}")
    
    # 构建测试请求
    payload = {
        "model": "gemini-3-flash",  # 使用用户配置的模型
        "messages": [
            {"role": "user", "content": "你好,请简单回复一句话"}
        ],
        "temperature": 0.8,
        "max_tokens": 100
    }
    
    print(f"\n请求体:")
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    
    async with httpx.AsyncClient(timeout=30.0) as client:
        try:
            print(f"\n发送请求...")
            response = await client.post(
                llm_url,
                headers={
                    "Authorization": f"Bearer {API_KEY}",
                    "Content-Type": "application/json"
                },
                json=payload
            )
            
            print(f"\n响应状态码: {response.status_code}")
            print(f"响应头:")
            for key, value in response.headers.items():
                print(f"  {key}: {value}")
            
            if response.status_code == 200:
                data = response.json()
                print(f"\n✅ 成功!")
                print(f"响应内容:")
                print(json.dumps(data, ensure_ascii=False, indent=2))
                
                # 提取回复
                if "choices" in data and len(data["choices"]) > 0:
                    reply = data["choices"][0]["message"]["content"]
                    print(f"\nLLM回复: {reply}")
            else:
                print(f"\n❌ 请求失败")
                print(f"响应内容: {response.text}")
                
        except httpx.ConnectError as e:
            print(f"\n❌ 连接错误: {e}")
            print(f"提示: 请检查反代服务是否在 127.0.0.1:11806 运行")
        except httpx.TimeoutException as e:
            print(f"\n❌ 请求超时: {e}")
        except Exception as e:
            print(f"\n❌ 其他错误: {e}")
            import traceback
            traceback.print_exc()

if __name__ == "__main__":
    import asyncio
    asyncio.run(test_llm_direct())
