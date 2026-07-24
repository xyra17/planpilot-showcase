import asyncio
import logging

from duckduckgo_search import DDGS
from langchain_core.tools import tool

logger = logging.getLogger(__name__)


def _ddg_search(query: str) -> list:
    with DDGS() as ddgs:
        return list(ddgs.text(query, max_results=5, region="cn-zh"))


@tool
async def web_search(query: str) -> str:
    """搜索互联网获取学习资料、课程推荐或最新技术信息。当用户询问具体学习资源、书籍、课程时使用。"""
    try:
        results = await asyncio.to_thread(_ddg_search, query)
        if not results:
            return "未找到相关结果。"
        snippets = [
            f"**{r['title']}**\n{r.get('body', '')[:400]}\n来源：{r['href']}"
            for r in results
        ]
        return "\n\n---\n\n".join(snippets)
    except Exception as e:
        logger.warning("DuckDuckGo search failed: %s", e)
        return "搜索暂时不可用，请稍后再试。"


chat_tools = [web_search]
