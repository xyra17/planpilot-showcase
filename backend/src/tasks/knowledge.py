import asyncio

from src.celery_app import celery_app
from src.database import AsyncSessionLocal


@celery_app.task(
    name="src.tasks.knowledge.vectorize_item",
    bind=True,
    max_retries=3,
    default_retry_delay=60,
)
def vectorize_item(self, item_id: str):
    try:
        asyncio.run(_vectorize(item_id))
    except Exception as exc:
        raise self.retry(exc=exc)


async def _vectorize(item_id: str) -> None:
    from openai import AsyncOpenAI
    from sqlalchemy import select
    from src.config import settings
    from src.models import KnowledgeItem

    async with AsyncSessionLocal() as db:
        item = (await db.execute(
            select(KnowledgeItem).where(KnowledgeItem.id == item_id)
        )).scalar_one_or_none()
        if not item or not item.content:
            return

        text = (item.title + "\n" + item.content)[:8000]

        # 本地模型优先，失败则回退 Smart API
        clients_to_try = []
        if settings.openai_base_url:
            clients_to_try.append(AsyncOpenAI(api_key=settings.openai_api_key or "local", base_url=settings.openai_base_url))
        if settings.smart_api_key:
            clients_to_try.append(AsyncOpenAI(api_key=settings.smart_api_key, base_url=settings.smart_base_url or None))

        for client in clients_to_try:
            try:
                resp = await client.embeddings.create(model="text-embedding-3-small", input=text)
                item.embedding = resp.data[0].embedding
                await db.commit()
                return
            except Exception:
                continue
