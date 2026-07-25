import json
import logging
import math
import uuid
from datetime import UTC, date, datetime, timedelta

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from langchain_core.messages import HumanMessage
from langchain_openai import ChatOpenAI
from pydantic import BaseModel
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sse_starlette.sse import EventSourceResponse

from src.config import settings
from src.database import get_db
from src.deps import get_current_user
from src.models import (
    CheckinRecord,
    DailyBriefCache,
    Goal,
    KnowledgeItem,
    Plan,
    Task,
    User,
)

logger = logging.getLogger(__name__)

# 内存缓存：key = "{user_id}:{task_id}"，value = 生成的验证问题
_verify_cache: dict[str, str] = {}

router = APIRouter(prefix="/api/v1/agent", tags=["agent"])


# ── Stream ────────────────────────────────────────────────────

class StreamRequest(BaseModel):
    message: str
    goal_id: str | None = None
    session_id: str


class ConfirmRequest(BaseModel):
    session_id: str
    confirmed: bool


async def _find_active_goal(db: AsyncSession, user_id: str):
    result = await db.execute(
        select(Goal)
        .where(Goal.user_id == user_id, Goal.status == "active")
        .order_by(Goal.created_at.desc())
        .limit(1)
    )
    return result.scalar_one_or_none()


async def _save_checkin(
    db: AsyncSession, user_id: str, goal_id: str, text: str, rate: float
) -> None:
    today = date.today().isoformat()
    existing = (await db.execute(
        select(CheckinRecord).where(
            CheckinRecord.user_id == user_id,
            CheckinRecord.goal_id == goal_id,
            CheckinRecord.date == today,
        )
    )).scalar_one_or_none()

    if existing:
        existing.completion_rate = rate
        existing.natural_text = text
    else:
        db.add(CheckinRecord(
            user_id=user_id,
            goal_id=goal_id,
            date=today,
            mode="natural",
            natural_text=text,
            completion_rate=rate,
            stats={},
            feedback="",
        ))
    await db.commit()


async def _generate_replan_options(
    goal, pending_tasks: list, recent_checkins: list
) -> dict | None:
    """生成两个重规划方案（A=降低难度, B=延长截止），不写入 DB。"""
    checkin_summary = "、".join(
        f"{c.date}完成率{round(c.completion_rate * 100)}%"
        for c in reversed(recent_checkins)
    )
    pending_titles = [t.title for t in pending_tasks[:10]]

    llm = ChatOpenAI(
        model=settings.smart_pro_model_name,
        api_key=settings.smart_api_key,
        base_url=settings.smart_base_url or None,
        max_tokens=1500,
    )
    prompt = (
        f"学习目标：{goal.title}，截止日期：{goal.deadline}，每日学习{goal.daily_hours}小时。\n"
        f"近期打卡记录：{checkin_summary or '无'}\n"
        f"剩余未完成任务：{pending_titles}\n\n"
        "用户连续多天完成率偏低，请生成两个重规划方案：\n"
        "方案A（降低难度）：拆解任务、降低每日量，保持截止日期。\n"
        "方案B（延长计划）：推迟截止日期7-14天，保持原有任务难度。\n\n"
        "严格按以下JSON格式输出，不加任何解释：\n"
        '{"option_a":{"label":"降低难度","description":"20字内方案描述","trade_off":"20字内权衡说明",'
        '"new_daily_hours":数字,"tasks":[{"title":"任务名","estimated_mins":数字,"type":"study|review|practice"}]},'
        '"option_b":{"label":"延长计划","description":"20字内方案描述","trade_off":"20字内权衡说明",'
        f'"new_deadline":"在{goal.deadline}基础上推迟7-14天（ISO格式）",'
        '"tasks":[{"title":"任务名","estimated_mins":数字,"type":"study|review|practice"}]}}'
    )
    result = await llm.ainvoke([HumanMessage(content=prompt)])
    raw = result.content.strip()
    try:
        start, end = raw.find("{"), raw.rfind("}") + 1
        if start != -1 and end > start:
            return json.loads(raw[start:end])
    except Exception:
        pass
    return None


async def _execute_replan_option(
    db: AsyncSession, user_id: str, goal_id: str, option: dict
) -> list[dict]:
    """应用用户选择的重规划方案：标记旧 pending 任务为 skipped，创建新任务，按需更新目标字段。"""
    goal = (await db.execute(select(Goal).where(Goal.id == goal_id))).scalar_one_or_none()
    if not goal:
        return []

    pending_tasks = (await db.execute(
        select(Task)
        .where(Task.goal_id == goal_id, Task.status == "pending")
        .order_by(Task.scheduled_date)
    )).scalars().all()

    if "new_daily_hours" in option:
        goal.daily_hours = float(option["new_daily_hours"])
    if "new_deadline" in option:
        goal.deadline = str(option["new_deadline"])

    for t in pending_tasks:
        t.status = "skipped"

    kb_items = (await db.execute(
        select(KnowledgeItem).where(KnowledgeItem.user_id == user_id)
    )).scalars().all()

    today = date.today()
    created: list[dict] = []
    for i, td in enumerate(option.get("tasks") or []):
        task_title = td.get("title", f"任务 {i+1}")
        task = Task(
            id=str(uuid.uuid4()),
            goal_id=goal_id,
            title=task_title,
            estimated_mins=int(td.get("estimated_mins") or 30),
            type=td.get("type", "study"),
            scheduled_date=(today + timedelta(days=i)).isoformat(),
            status="pending",
            kb_refs=await _match_kb_refs(kb_items, task_title),
        )
        db.add(task)
        created.append({"id": task.id, "title": task.title, "estimated_mins": task.estimated_mins})

    await db.commit()
    return created


async def _do_replan(db: AsyncSession, user_id: str, goal_id: str) -> list[dict]:
    """直接重规划（兜底/HiL确认路径）：生成单一调整方案并立即写入 DB。"""
    goal = (await db.execute(select(Goal).where(Goal.id == goal_id))).scalar_one_or_none()
    if not goal:
        return []

    recent_checkins = (await db.execute(
        select(CheckinRecord)
        .where(CheckinRecord.goal_id == goal_id)
        .order_by(CheckinRecord.date.desc())
        .limit(5)
    )).scalars().all()

    pending_tasks = (await db.execute(
        select(Task)
        .where(Task.goal_id == goal_id, Task.status == "pending")
        .order_by(Task.scheduled_date)
    )).scalars().all()

    checkin_summary = "、".join(
        f"{c.date}完成率{round(c.completion_rate * 100)}%"
        for c in reversed(recent_checkins)
    )
    pending_titles = [t.title for t in pending_tasks[:10]]

    llm = ChatOpenAI(
        model=settings.smart_pro_model_name,
        api_key=settings.smart_api_key,
        base_url=settings.smart_base_url or None,
        max_tokens=1024,
    )
    prompt = (
        f"学习目标：{goal.title}，截止日期：{goal.deadline}，每日学习{goal.daily_hours}小时。\n"
        f"近期打卡记录：{checkin_summary or '无'}\n"
        f"剩余未完成任务：{pending_titles}\n\n"
        "用户连续多天完成率偏低，需要重新规划。请生成更易实现的调整后任务清单。\n"
        "严格按以下JSON格式输出，不加任何解释：\n"
        '[{"title": "任务名", "estimated_mins": 数字, "type": "study|review|practice"}, ...]'
    )
    result = await llm.ainvoke([HumanMessage(content=prompt)])
    raw = result.content.strip()

    new_tasks_data: list[dict] = []
    try:
        start, end = raw.find("["), raw.rfind("]") + 1
        if start != -1 and end > start:
            new_tasks_data = json.loads(raw[start:end])
    except Exception:
        pass

    if not new_tasks_data:
        return []

    for t in pending_tasks:
        t.status = "skipped"

    kb_items = (await db.execute(
        select(KnowledgeItem).where(KnowledgeItem.user_id == user_id)
    )).scalars().all()

    today = date.today()
    created: list[dict] = []
    for i, td in enumerate(new_tasks_data):
        task_title = td.get("title", f"任务 {i+1}")
        task = Task(
            id=str(uuid.uuid4()),
            goal_id=goal_id,
            title=task_title,
            estimated_mins=int(td.get("estimated_mins") or 30),
            type=td.get("type", "study"),
            scheduled_date=(today + timedelta(days=i)).isoformat(),
            status="pending",
            kb_refs=await _match_kb_refs(kb_items, task_title),
        )
        db.add(task)
        created.append({"id": task.id, "title": task.title, "estimated_mins": task.estimated_mins})

    await db.commit()
    return created


def _cosine_sim(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(x * x for x in b))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


async def _get_embedding(text: str) -> list[float] | None:
    try:
        from openai import AsyncOpenAI
        client = AsyncOpenAI(
            api_key=settings.smart_api_key,
            base_url=settings.smart_base_url or None,
        )
        resp = await client.embeddings.create(model="text-embedding-3-small", input=text)
        return resp.data[0].embedding
    except Exception:
        return None


async def _match_kb_refs(kb_items: list, task_title: str) -> list[str]:
    """语义向量检索（有 embedding 时）+ 关键词匹配兜底。"""
    if not kb_items:
        return []

    matched_ids: set[str] = set()

    items_with_emb = [it for it in kb_items if it.embedding]
    items_no_emb = [it for it in kb_items if not it.embedding]

    if items_with_emb:
        query_emb = await _get_embedding(task_title)
        if query_emb:
            scored = [
                (it.id, _cosine_sim(query_emb, it.embedding))
                for it in items_with_emb
            ]
            scored.sort(key=lambda x: x[1], reverse=True)
            for item_id, score in scored[:3]:
                if score >= 0.6:
                    matched_ids.add(item_id)

    if len(matched_ids) < 3 and items_no_emb:
        title_lower = task_title.lower()
        candidates: set[str] = set()
        for w in title_lower.split():
            if len(w) >= 3:
                candidates.add(w)
        for i in range(len(title_lower) - 1):
            pair = title_lower[i:i + 2]
            if all('\u4e00' <= c <= '\u9fff' for c in pair):
                candidates.add(pair)
        if candidates:
            for item in items_no_emb:
                if len(matched_ids) >= 3:
                    break
                combined = (item.title + " " + item.content[:1000]).lower()
                if any(c in combined for c in candidates):
                    matched_ids.add(item.id)

    return list(matched_ids)[:3]


async def _save_plan(db: AsyncSession, user_id: str, message: str, structured: dict) -> str:
    total_weeks = int(structured.get("total_weeks") or 4)
    weekly_hours = float(structured.get("weekly_hours") or 7)
    plan_summary = structured.get("plan_summary") or message[:80]

    # 从 plan_summary 截取标题（最多20字）
    title = plan_summary[:20] if len(plan_summary) > 20 else plan_summary
    deadline = (date.today() + timedelta(weeks=total_weeks)).isoformat()
    daily_hours = round(weekly_hours / 7, 1)

    goal = Goal(
        id=str(uuid.uuid4()),
        user_id=user_id,
        type="skill",
        title=title,
        deadline=deadline,
        daily_hours=max(0.5, min(daily_hours, 12)),
        current_level="beginner",
        meta={"plan_summary": plan_summary, "phases": structured.get("phases", [])},
    )
    db.add(goal)
    await db.flush()  # 获取 goal.id 但不提交

    # 获取用户知识库文件，用于关联 kb_refs
    kb_items = (await db.execute(
        select(KnowledgeItem).where(KnowledgeItem.user_id == user_id)
    )).scalars().all()

    sample_tasks = structured.get("sample_tasks") or []
    if not sample_tasks:
        sample_tasks = [
            {"title": f"{p['name']}：{p.get('focus','')[:20]}", "estimated_mins": 60}
            for p in structured.get("phases") or []
        ]

    for i, t in enumerate(sample_tasks):
        task_title = t.get("title", f"任务 {i+1}")
        kb_refs = await _match_kb_refs(kb_items, task_title)
        task = Task(
            id=str(uuid.uuid4()),
            goal_id=goal.id,
            title=task_title,
            estimated_mins=int(t.get("estimated_mins") or 30),
            scheduled_date=(date.today() + timedelta(days=i)).isoformat(),
            status="pending",
            kb_refs=kb_refs,
        )
        db.add(task)

    await db.commit()
    return goal.id


@router.post("/stream")
async def stream(
    body: StreamRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> EventSourceResponse:
    from langchain_core.messages import HumanMessage

    from src.core.agent.graph import get_agent

    async def generate():
        try:
            agent = await get_agent()
            config = {"configurable": {"thread_id": f"user_{current_user.id}_{body.session_id}"}}
            state_input = {
                "messages": [HumanMessage(content=body.message)],
                "user_id": current_user.id,
                "goal_id": body.goal_id,
            }

            async for event in agent.astream_events(state_input, config=config, version="v2"):
                kind = event["event"]

                if kind == "on_chat_model_stream":
                    node = event.get("metadata", {}).get("langgraph_node", "")
                    if node not in ("setup_goal", "chat", "checkin", "replan_chat", "confirm_replan", "verify"):
                        continue
                    chunk = event["data"].get("chunk")
                    text = chunk.content if chunk and hasattr(chunk, "content") else ""
                    if text:
                        yield {"event": "token", "data": json.dumps({"text": text})}

                elif kind == "on_tool_start":
                    yield {"event": "tool_start", "data": json.dumps({"tool": event.get("name", "")})}

                elif kind == "on_tool_end":
                    yield {"event": "tool_end", "data": "{}"}

                elif kind == "on_chain_end" and event.get("name") in ("setup_goal",):
                    out = event["data"].get("output") or {}
                    if isinstance(out, dict) and out.get("structured_output"):
                        yield {"event": "structured", "data": json.dumps(out["structured_output"])}

            final_state = await agent.aget_state(config)

            # HiL: 若图在 confirm_replan 前被中断，通知前端弹确认框
            if "confirm_replan" in (final_state.next or []):
                yield {"event": "confirmation_needed", "data": json.dumps({
                    "type": "replan",
                    "goal_id": body.goal_id or final_state.values.get("goal_id"),
                    "session_id": body.session_id,
                })}
                return

            # 计划生成完毕后，若无 goal_id 则自动保存
            if not body.goal_id:
                structured = final_state.values.get("structured_output")
                if structured:
                    goal_id = await _save_plan(db, current_user.id, body.message, structured)
                    yield {"event": "plan_saved", "data": json.dumps({"goal_id": goal_id})}

            # checkin intent：保存打卡记录
            checkin_rate = final_state.values.get("checkin_rate")
            checkin_text = final_state.values.get("checkin_text")
            if checkin_rate is not None and checkin_text:
                goal_id_for_checkin = body.goal_id or None
                active_goal = (
                    await _find_active_goal(db, current_user.id)
                    if not goal_id_for_checkin
                    else None
                )
                target_goal_id = goal_id_for_checkin or (active_goal.id if active_goal else None)
                if target_goal_id:
                    await _save_checkin(db, current_user.id, target_goal_id, checkin_text, checkin_rate)
                    yield {"event": "checkin_saved", "data": json.dumps({
                        "goal_id": target_goal_id, "completion_rate": checkin_rate
                    })}

                    # 连续 4 天完成率 < 60% 触发重规划
                    recent = (await db.execute(
                        select(CheckinRecord)
                        .where(CheckinRecord.goal_id == target_goal_id)
                        .order_by(CheckinRecord.date.desc())
                        .limit(3)
                    )).scalars().all()
                    should_replan = (
                        checkin_rate < 0.6
                        and len(recent) >= 3
                        and all(r.completion_rate < 0.6 for r in recent)
                    )
                    if should_replan:
                        goal_obj = (await db.execute(
                            select(Goal).where(Goal.id == target_goal_id)
                        )).scalar_one_or_none()
                        pending_obj = (await db.execute(
                            select(Task)
                            .where(Task.goal_id == target_goal_id, Task.status == "pending")
                            .order_by(Task.scheduled_date)
                        )).scalars().all()
                        options = (
                            await _generate_replan_options(goal_obj, list(pending_obj), list(recent))
                            if goal_obj else None
                        )
                        if options:
                            yield {"event": "replan_options", "data": json.dumps({
                                "goal_id": target_goal_id,
                                "option_a": options["option_a"],
                                "option_b": options["option_b"],
                            })}
                        else:
                            new_tasks = await _do_replan(db, current_user.id, target_goal_id)
                            yield {"event": "replan_done", "data": json.dumps({"tasks": new_tasks})}

            yield {"event": "done", "data": "{}"}

        except Exception as e:
            yield {"event": "error", "data": json.dumps({"message": str(e)})}

    return EventSourceResponse(generate())


@router.post("/confirm")
async def confirm(
    body: ConfirmRequest,
    current_user: User = Depends(get_current_user),
) -> dict:
    from src.core.agent.graph import get_agent
    agent = await get_agent()
    config = {"configurable": {"thread_id": f"user_{current_user.id}_{body.session_id}"}}
    try:
        await agent.aupdate_state(
            config,
            {"user_confirmed": body.confirmed, "pending_confirmation": None},
        )
    except Exception as e:
        logger.warning("confirm aupdate_state failed: %s", e)
    return {"status": "ok"}


@router.post("/resume/{session_id}")
async def resume_stream(
    session_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> EventSourceResponse:
    from src.core.agent.graph import get_agent

    async def generate():
        try:
            agent = await get_agent()
            config = {"configurable": {"thread_id": f"user_{current_user.id}_{session_id}"}}

            async for event in agent.astream_events(None, config=config, version="v2"):
                kind = event["event"]
                if kind == "on_chat_model_stream":
                    node = event.get("metadata", {}).get("langgraph_node", "")
                    if node not in ("confirm_replan",):
                        continue
                    chunk = event["data"].get("chunk")
                    text = chunk.content if chunk and hasattr(chunk, "content") else ""
                    if text:
                        yield {"event": "token", "data": json.dumps({"text": text})}

            final_state = await agent.aget_state(config)

            # 若用户确认重规划，执行 replan 并返回结果
            if final_state.values.get("pending_replan"):
                goal_id = final_state.values.get("goal_id")
                if goal_id:
                    new_tasks = await _do_replan(db, current_user.id, goal_id)
                    yield {"event": "replan_done", "data": json.dumps({"tasks": new_tasks})}

            yield {"event": "done", "data": "{}"}

        except Exception as e:
            yield {"event": "error", "data": json.dumps({"message": str(e)})}

    return EventSourceResponse(generate())


@router.post("/replan/{goal_id}")
async def trigger_replan(
    goal_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    goal = (await db.execute(
        select(Goal).where(Goal.id == goal_id, Goal.user_id == current_user.id)
    )).scalar_one_or_none()
    if not goal:
        raise HTTPException(status_code=404, detail="目标不存在")

    new_tasks = await _do_replan(db, current_user.id, goal_id)
    return {"tasks": new_tasks}


class ReplanExecuteBody(BaseModel):
    option: dict


@router.post("/replan/{goal_id}/execute")
async def execute_replan(
    goal_id: str,
    body: ReplanExecuteBody,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    goal = (await db.execute(
        select(Goal).where(Goal.id == goal_id, Goal.user_id == current_user.id)
    )).scalar_one_or_none()
    if not goal:
        raise HTTPException(status_code=404, detail="目标不存在")
    new_tasks = await _execute_replan_option(db, current_user.id, goal_id, body.option)
    return {"tasks": new_tasks}


def _get_available_dates(start: date, deadline: date, work_schedule: str) -> list[date]:
    """返回 [start, deadline] 之间所有可学习日期列表。"""
    available: list[date] = []
    cur = start
    while cur <= deadline:
        wd = cur.weekday()
        if work_schedule == "weekday" and wd >= 5:
            cur += timedelta(days=1)
            continue
        if work_schedule == "weekend" and wd < 5:
            cur += timedelta(days=1)
            continue
        available.append(cur)
        cur += timedelta(days=1)
    return available


def _schedule_dates(start: date, count: int, work_schedule: str) -> list[date]:
    """按照 work_schedule 生成 count 个可学习日期，跳过不可用天。"""
    dates: list[date] = []
    current = start
    while len(dates) < count:
        weekday = current.weekday()
        if work_schedule == "weekday" and weekday >= 5:
            current += timedelta(days=1)
            continue
        if work_schedule == "weekend" and weekday < 5:
            current += timedelta(days=1)
            continue
        dates.append(current)
        current += timedelta(days=1)
    return dates


def _distribute_tasks_by_day(
    tasks: list[dict],
    available_dates: list[date],
    daily_hours: float,
) -> list[date]:
    """按每日学习预算将任务分配到具体日期，多个任务可落在同一天。"""
    if not available_dates:
        return [date.today()] * len(tasks)
    daily_budget_mins = max(30, daily_hours * 60)
    result: list[date] = []
    day_idx = 0
    day_used = 0.0
    for task in tasks:
        task_mins = float(task.get("estimated_mins") or 30)
        if day_used + task_mins > daily_budget_mins and day_used > 0:
            day_idx += 1
            day_used = 0.0
        if day_idx >= len(available_dates):
            day_idx = len(available_dates) - 1
        result.append(available_dates[day_idx])
        day_used += task_mins
    return result


@router.get("/plan-context/{goal_id}")
async def get_plan_context(
    goal_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    goal = (await db.execute(
        select(Goal).where(Goal.id == goal_id, Goal.user_id == current_user.id)
    )).scalar_one_or_none()
    if not goal:
        raise HTTPException(status_code=404, detail="目标不存在")

    kb_id: str | None = (goal.meta or {}).get("kb_id")
    kb_overview: list[dict] = []
    if kb_id:
        kb_items = (await db.execute(
            select(KnowledgeItem).where(KnowledgeItem.kb_id == kb_id)
        )).scalars().all()
        for it in kb_items:
            char_count = len(it.content) if it.content else 0
            kb_overview.append({
                "title": it.title,
                "char_count": char_count,
                "estimated_pages": max(1, char_count // 600),
            })

    type_label = {
        "exam": "备考",
        "certification": "认证备考",
        "skill": "技能学习",
        "reading": "阅读计划",
        "language": "语言学习",
        "habit": "习惯养成",
    }.get(goal.type or "skill", "学习")
    kb_summary_line = ""
    if kb_overview:
        parts = [f"《{item['title']}》约 {item['estimated_pages']} 页" for item in kb_overview[:8]]
        kb_summary_line = f"知识库包含：{'、'.join(parts)}。"

    understanding_prompt = (
        f"用户的{type_label}目标是「{goal.title}」，截止日期 {goal.deadline}，"
        f"每日学习 {goal.daily_hours} 小时，当前水平：{goal.current_level}。"
        + (kb_summary_line if kb_summary_line else "未关联知识库。")
        + "\n请用 2-3 句话描述：你对这个学习目标的理解是什么？关键学习重点是什么？有什么需要特别注意的？"
        "直接输出理解内容，不要加任何前缀。"
    )

    initial_understanding = ""
    try:
        llm = ChatOpenAI(
            model=settings.smart_model_name,
            api_key=settings.smart_api_key,
            base_url=settings.smart_base_url or None,
            max_tokens=200,
            temperature=0.3,
        )
        result = await llm.ainvoke([HumanMessage(content=understanding_prompt)])
        initial_understanding = result.content.strip()
    except Exception:
        pass

    return {
        "kb_overview": kb_overview,
        "initial_understanding": initial_understanding,
    }


@router.get("/intent-placeholder/{goal_id}")
async def get_intent_placeholder(
    goal_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    goal = (await db.execute(
        select(Goal).where(Goal.id == goal_id, Goal.user_id == current_user.id)
    )).scalar_one_or_none()
    if not goal:
        raise HTTPException(status_code=404, detail="目标不存在")

    type_label = {
        "exam": "备考", "certification": "认证备考", "skill": "技能学习",
        "reading": "阅读", "language": "语言学习", "habit": "习惯养成",
    }.get(goal.type or "skill", "学习")

    prompt = (
        f"用户正在制定「{goal.title}」的{type_label}计划。"
        "请为「补充说明」输入框生成一句 placeholder 示例文字，引导用户描述自己的基础水平、希望重点学习的内容、可以跳过的部分。"
        "要求：以「例如：」开头，内容必须针对该具体目标，30-50字，只输出 placeholder 文字，不要任何解释。"
    )

    placeholder = ""
    try:
        llm = ChatOpenAI(
            model=settings.smart_model_name,
            api_key=settings.smart_api_key,
            base_url=settings.smart_base_url or None,
            max_tokens=100,
            temperature=0.7,
        )
        result = await llm.ainvoke([HumanMessage(content=prompt)])
        placeholder = result.content.strip()
    except Exception:
        pass

    return {"placeholder": placeholder}


@router.post("/macro-plan/{goal_id}")
async def generate_macro_plan(
    goal_id: str,
    body: dict = Body(default_factory=dict),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    kb_mode: str = body.get("kb_mode", "kb_reference")  # kb_only | kb_reference | no_kb
    user_intent_supplement: str = (body.get("user_intent_supplement") or "").strip()
    pacing_mode: str = body.get("pacing_mode", "fixed")  # auto | fixed

    goal = (await db.execute(
        select(Goal).where(Goal.id == goal_id, Goal.user_id == current_user.id)
    )).scalar_one_or_none()
    if not goal:
        raise HTTPException(status_code=404, detail="目标不存在")

    # 取消旧的 is_current 计划
    old_plans = (await db.execute(
        select(Plan).where(Plan.goal_id == goal_id, Plan.is_current.is_(True))
    )).scalars().all()
    for p in old_plans:
        p.is_current = False

    # 计算可学天数
    today = date.today()
    deadline_date = date.fromisoformat(goal.deadline)
    work_schedule: str = (goal.meta or {}).get("work_schedule", "all")
    kb_id: str | None = (goal.meta or {}).get("kb_id")
    goal_type: str = goal.type or "skill"

    # 读取 KB 文档列表（全量，取 title + 字数；不截断内容注入 prompt）
    kb_items_for_prompt: list[dict] = []
    total_kb_chars = 0
    if kb_mode in ("kb_only", "kb_reference") and kb_id:
        kb_items_raw = (await db.execute(
            select(KnowledgeItem).where(KnowledgeItem.kb_id == kb_id)
        )).scalars().all()
        for it in kb_items_raw:
            char_count = len(it.content) if it.content else 0
            total_kb_chars += char_count
            kb_items_for_prompt.append({
                "title": it.title,
                "char_count": char_count,
                "estimated_pages": max(1, char_count // 600),
            })

    kb_doc_list = "\n".join(
        f"  - 《{item['title']}》约 {item['estimated_pages']} 页（{item['char_count']} 字）"
        for item in kb_items_for_prompt
    )

    # 按目标类型 × KB 状态决定 KB 指令策略
    has_kb_content = bool(kb_items_for_prompt)
    is_exam_type = goal_type in ("exam", "certification")

    if kb_mode == "kb_only" and has_kb_content:
        kb_instruction = (
            f"【重要约束】请严格基于以下知识库文档制定计划，不要引入库外知识点：\n{kb_doc_list}\n"
            "每个阶段的任务必须能在以上文档中找到对应内容，覆盖率是首要指标。\n"
        )
    elif kb_mode == "kb_reference" and has_kb_content:
        if is_exam_type:
            kb_instruction = (
                f"【知识库文档】（请以此为核心结构划分阶段，确保每份文档都有对应任务）：\n{kb_doc_list}\n"
                "备考要求：按文档/模块分阶段，覆盖全部考试重点，后期安排复习和冲刺。\n"
            )
        elif goal_type == "skill":
            kb_instruction = (
                f"【知识库文档】（作为主要学习教材，结合实战练习）：\n{kb_doc_list}\n"
                "技能要求：学习理论后立即配套实战练习，以项目驱动为主。\n"
            )
        elif goal_type == "reading":
            kb_instruction = (
                f"【知识库文档】（作为阅读材料）：\n{kb_doc_list}\n"
                "阅读要求：按章节逐步精读，每章做笔记/摘要，跟进阅读进度，关注理解深度而非速度。\n"
            )
        elif goal_type == "language":
            kb_instruction = (
                f"【知识库文档】（作为语言学习材料）：\n{kb_doc_list}\n"
                "语言学习要求：大量输入（听力+阅读）为主，词汇积累+语法系统打底，注重实际应用练习。\n"
            )
        elif goal_type == "habit":
            kb_instruction = (
                f"【知识库文档】（作为习惯养成指导）：\n{kb_doc_list}\n"
                "习惯养成要求：从最小行为开始逐步递增，固定时间地点形成条件反射，先建立节奏再提升质量。\n"
            )
        else:
            kb_instruction = (
                f"【知识库文档】（作为参考学习材料）：\n{kb_doc_list}\n"
            )
    elif not has_kb_content and is_exam_type:
        kb_instruction = (
            "⚠️ 当前未关联考纲/教材资料，将按通用考试模块结构生成计划（完型/阅读/写作等）。"
            "建议补充相关资料后重新生成以获得更精准的计划。\n"
        )
    elif not has_kb_content:
        # 无 KB 时按目标类型提供基础指导
        if goal_type == "skill":
            kb_instruction = "技能学习建议：理论学习后立即配套实战练习，以项目驱动，边学边做。\n"
        elif goal_type == "reading":
            kb_instruction = "阅读建议：建议关联具体书籍或文章到知识库，以便生成更精准的阅读计划。\n"
        elif goal_type == "language":
            kb_instruction = "语言学习建议：大量输入（听力+阅读）为主，词汇积累+语法打底，注重实际应用。\n"
        elif goal_type == "habit":
            kb_instruction = "习惯养成建议：从最小可执行行为开始，固定时间地点，先建立节奏再提升强度。\n"
        else:
            kb_instruction = ""
    else:
        kb_instruction = ""

    # pacing_mode=auto 时注入 KB 阅读节奏估算
    pacing_note = ""
    if pacing_mode == "auto" and total_kb_chars > 0:
        kb_read_hours = round(total_kb_chars / 20000, 1)
        pacing_note = (
            f"【阅读节奏参考】知识库总计约 {total_kb_chars} 字，"
            f"按正常阅读速度约需 {kb_read_hours} 小时完整阅读，请据此合理分配各阶段阅读任务量。\n"
        )

    # 用户补充意图（高优先级约束）
    intent_note = ""
    if user_intent_supplement:
        intent_note = f"【用户特别说明】（请将以下要求作为高优先级约束融入计划）：{user_intent_supplement}\n"

    # 获取所有可用日期列表（含截止日当天）
    available_dates = _get_available_dates(today, deadline_date, work_schedule)
    available_days = max(1, len(available_dates))
    total_study_hours = round(available_days * goal.daily_hours, 1)
    total_study_mins = int(total_study_hours * 60)
    # 建议每个任务平均30分钟，估算任务数量区间
    suggested_tasks_min = max(available_days, total_study_mins // 45)
    suggested_tasks_max = total_study_mins // 20

    rest_note = {"weekday": "（已排除周末）", "weekend": "（已排除工作日）", "all": ""}.get(work_schedule, "")

    prompt = (
        f"你是学习规划专家。\n"
        f"目标：{goal.title}\n"
        f"目标类型：{goal_type}\n"
        f"开始日期：{today.isoformat()}\n"
        f"截止日期：{goal.deadline}\n"
        f"可学习天数：{available_days} 天{rest_note}，每日学习 {goal.daily_hours} 小时\n"
        f"总可用学习时长：{total_study_hours} 小时（约 {total_study_mins} 分钟）\n"
        f"当前水平：{goal.current_level}\n"
        + intent_note
        + kb_instruction
        + pacing_note
        + f"\n请生成一份完整的学习计划，覆盖全部 {available_days} 天，划分成 2-4 个阶段。\n"
        f"【任务数量】所有阶段的任务 estimated_mins 之和应接近 {total_study_mins} 分钟，"
        f"建议生成 {suggested_tasks_min}~{suggested_tasks_max} 个任务。\n"
        f"【阶段划分】用 days 字段表示每阶段占用天数，各阶段 days 之和等于 {available_days}。\n"
        "每个阶段包含若干具体任务，任务按阶段顺序排列。\n"
        "【成功标准要求】每个任务的 objective 字段必须包含可观测的行为动词（如：能独立写出/能解释/能完成）"
        "+ 具体数量或时长指标。\n"
        "  ❌ 模糊示例：「熟练掌握循环语法」\n"
        "  ✅ 量化示例：「能独立写出3种循环结构各2个正确示例，不查文档」\n"
        "严格按以下JSON格式输出，不加任何解释：\n"
        "{\n"
        '  "phases": [\n'
        '    {"name": "阶段名", "days": 整数, "focus": "核心重点（30字内）",\n'
        '     "tasks": [{"title": "任务名称（15字内，具体到章节或知识点）", "objective": "成功标准：含行为动词+数量指标（35字内）", "estimated_mins": 整数, "type": "study|review|practice"}]}\n'
        "  ],\n"
        '  "total_tasks": 整数\n'
        "}"
    )

    llm = ChatOpenAI(
        model=settings.smart_model_name,
        api_key=settings.smart_api_key,
        base_url=settings.smart_base_url or None,
        max_tokens=2048,
        temperature=0.3,
    )

    result = await llm.ainvoke([HumanMessage(content=prompt)])
    raw = result.content.strip()

    plan_data: dict = {}
    try:
        start = raw.find("{")
        end = raw.rfind("}") + 1
        if start != -1 and end > start:
            plan_data = json.loads(raw[start:end])
    except Exception:
        pass

    phases = plan_data.get("phases") or []
    if not phases:
        raise HTTPException(status_code=502, detail="AI 生成计划失败，请重试")

    # 后处理：将 AI 返回的 days 按比例重新分配，确保总和等于实际可用天数
    weights = [max(1, p.get("days", 1)) for p in phases]
    total_weight = sum(weights)
    remaining = available_days
    for i, (p, w) in enumerate(zip(phases, weights)):
        if i == len(phases) - 1:
            p["days"] = max(1, remaining)
        else:
            alloc = max(1, round(w / total_weight * available_days))
            p["days"] = alloc
            remaining -= alloc

    # 创建 Plan 记录
    plan = Plan(
        id=str(uuid.uuid4()),
        goal_id=goal_id,
        version=len(old_plans) + 1,
        is_current=True,
        baseline=plan_data,
        content=plan_data,
    )
    db.add(plan)
    await db.flush()

    # 按 work_schedule 分配日期，批量创建 Task
    kb_items_all = (await db.execute(
        select(KnowledgeItem).where(KnowledgeItem.user_id == current_user.id)
    )).scalars().all()

    all_tasks_flat = [t for phase in phases for t in (phase.get("tasks") or [])]
    scheduled = _distribute_tasks_by_day(
        all_tasks_flat, available_dates, goal.daily_hours
    )

    for i, (td, sched_date) in enumerate(zip(all_tasks_flat, scheduled)):
        task_title = td.get("title", f"任务 {i+1}")
        task_obj = td.get("objective") or None
        task = Task(
            id=str(uuid.uuid4()),
            goal_id=goal_id,
            plan_id=plan.id,
            title=task_title,
            description=task_obj,
            estimated_mins=int(td.get("estimated_mins") or 30),
            type=td.get("type", "study"),
            scheduled_date=sched_date.isoformat(),
            status="pending",
            kb_refs=await _match_kb_refs(kb_items_all, task_title),
        )
        db.add(task)

    await db.commit()

    # 计算预计完成日期
    estimated_completion_date = scheduled[-1].isoformat() if scheduled else goal.deadline

    # 构建含 scheduled_date 的阶段返回（与 scheduled 列表对齐）
    task_ret_idx = 0
    phases_out = []
    for p in phases:
        phase_task_list = p.get("tasks") or []
        phase_dates: list[date] = []
        tasks_out = []
        for t in phase_task_list:
            sched = scheduled[task_ret_idx] if task_ret_idx < len(scheduled) else None
            if sched:
                phase_dates.append(sched)
            tasks_out.append({
                "title": t.get("title", ""),
                "objective": t.get("objective", ""),
                "estimated_mins": int(t.get("estimated_mins") or 30),
                "type": t.get("type", "study"),
                "scheduled_date": sched.isoformat() if sched else "",
            })
            task_ret_idx += 1
        phases_out.append({
            "name": p["name"],
            "focus": p.get("focus", ""),
            "days": p.get("days", 0),
            "start_date": min(phase_dates).isoformat() if phase_dates else "",
            "end_date": max(phase_dates).isoformat() if phase_dates else "",
            "tasks": tasks_out,
        })

    return {
        "plan_id": plan.id,
        "phases": phases_out,
        "total_tasks": len(all_tasks_flat),
        "start_date": available_dates[0].isoformat() if available_dates else today.isoformat(),
        "estimated_completion_date": estimated_completion_date,
    }


class ReviewQuestion(BaseModel):
    id: str
    question: str
    hint: str


class GoalReview(BaseModel):
    goalId: str
    goalTitle: str
    questions: list[ReviewQuestion]


class DailyBriefOut(BaseModel):
    date: str
    summary: str
    goalReviews: list[GoalReview]
    insight: str
    recommendedAction: str = ""


async def _generate_review_questions(
    goal_title: str,
    tasks: list,
    kb_items: list,
    count: int = 3,
) -> list[ReviewQuestion]:
    task_lines = "\n".join(f"- {t.title}（约 {t.estimated_mins} 分钟）" for t in tasks)
    kb_context = "\n".join(item.content[:300] for item in kb_items[:2])
    n = count
    prompt = (
        f"目标：{goal_title}\n"
        f"昨日完成的学习任务：\n{task_lines}\n"
        + (f"\n相关知识内容（节选）：\n{kb_context}\n" if kb_context else "")
        + f"\n请针对以上内容生成 {n} 道 10 分钟快速复习题。\n"
        "要求：\n"
        "- question：测试昨日内容理解的简洁问题（30字以内）\n"
        "- hint：答题关键点或提示（60字以内）\n"
        "只输出 JSON 数组，不含其他文字：\n"
        '[{"question":"...","hint":"..."}]'
    )
    llm = ChatOpenAI(
        api_key=settings.smart_api_key,
        base_url=settings.smart_base_url,
        model=settings.smart_model_name,
        temperature=0.3,
    )
    resp = await llm.ainvoke([HumanMessage(content=prompt)])
    raw = resp.content.strip()
    if "```" in raw:
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]
        raw = raw.split("```")[0]
    try:
        parsed = json.loads(raw.strip())
    except (json.JSONDecodeError, ValueError) as e:
        logger.warning("LLM returned invalid JSON for review questions: %s", e)
        raise
    return [
        ReviewQuestion(id=str(uuid.uuid4()), question=item["question"], hint=item["hint"])
        for item in parsed[:n]
    ]


def _fallback_questions(tasks: list) -> list[ReviewQuestion]:
    return [
        ReviewQuestion(
            id=t.id,
            question=f"回顾「{t.title}」，核心要点是什么？",
            hint=f"昨日学习，预计 {t.estimated_mins} 分钟",
        )
        for t in tasks[:3]
    ]


async def _upsert_brief_cache(user_id: str, db: AsyncSession, brief_dict: dict, generated_by: str) -> None:
    today = date.today().isoformat()
    bind = db.get_bind()

    if bind.dialect.name == "postgresql":
        from sqlalchemy.dialects.postgresql import insert as pg_insert

        stmt = pg_insert(DailyBriefCache).values(
            id=str(uuid.uuid4()),
            user_id=user_id,
            date=today,
            content=brief_dict,
            is_read=False,
            generated_by=generated_by,
        ).on_conflict_do_update(
            constraint="uq_daily_brief_cache_user_date",
            set_={
                "content": brief_dict,
                "generated_by": generated_by,
                "generated_at": datetime.now(UTC).replace(tzinfo=None),
            },
        )
        await db.execute(stmt)
    else:
        cached = (await db.execute(
            select(DailyBriefCache).where(
                DailyBriefCache.user_id == user_id,
                DailyBriefCache.date == today,
            )
        )).scalar_one_or_none()
        if cached:
            cached.content = brief_dict
            cached.generated_by = generated_by
            cached.generated_at = datetime.now(UTC).replace(tzinfo=None)
        else:
            db.add(DailyBriefCache(
                id=str(uuid.uuid4()),
                user_id=user_id,
                date=today,
                content=brief_dict,
                is_read=False,
                generated_by=generated_by,
            ))
    await db.commit()


async def _build_daily_brief_for_user(user_id: str, db: AsyncSession, count: int = 3) -> dict | None:
    today = date.today().isoformat()
    yesterday = (date.today() - timedelta(days=1)).isoformat()
    seven_days_ago = (date.today() - timedelta(days=7)).isoformat()

    recent_checkins = (await db.execute(
        select(CheckinRecord)
        .where(
            CheckinRecord.user_id == user_id,
            CheckinRecord.date >= seven_days_ago,
            CheckinRecord.mode != "natural",
        )
        .order_by(CheckinRecord.date.desc())
    )).scalars().all()

    if not recent_checkins:
        return None

    # 连续打卡天数
    streak = 0
    checkin_dates = {c.date for c in recent_checkins}
    check_date = date.today() if today in checkin_dates else date.today() - timedelta(days=1)
    while check_date.isoformat() in checkin_dates:
        streak += 1
        check_date -= timedelta(days=1)

    # 昨日完成任务（用于 summary 统计）
    yesterday_tasks = (await db.execute(
        select(Task)
        .join(Goal, Task.goal_id == Goal.id)
        .where(Goal.user_id == user_id, Task.scheduled_date == yesterday, Task.status == "completed")
        .limit(15)
    )).scalars().all()

    # 所有活跃目标（复习题覆盖全部目标，不限于昨天）
    active_goals = (await db.execute(
        select(Goal)
        .where(Goal.user_id == user_id, Goal.status == "active")
    )).scalars().all()

    # 今日任务统计
    today_tasks = (await db.execute(
        select(Task)
        .join(Goal, Task.goal_id == Goal.id)
        .where(Goal.user_id == user_id, Task.scheduled_date == today)
    )).scalars().all()
    today_done = sum(1 for t in today_tasks if t.status == "completed")
    today_total = len(today_tasks)

    # 构建 summary
    last = recent_checkins[0]
    avg_rate = sum(c.completion_rate for c in recent_checkins) / len(recent_checkins)
    if last.date == today:
        summary = f"今日已打卡，完成率 {round(last.completion_rate * 100)}%。近7天平均完成率 {round(avg_rate * 100)}%。"
    else:
        mins = sum(t.estimated_mins for t in yesterday_tasks)
        summary = f"昨日完成 {len(yesterday_tasks)} 项任务"
        if mins:
            summary += f"，累计约 {round(mins / 60, 1)} 小时"
        summary += f"。近7天平均完成率 {round(avg_rate * 100)}%"
        summary += "，表现优秀！" if avg_rate >= 0.8 else "，继续加油！" if avg_rate >= 0.5 else "，注意调整节奏。"

    # 构建 goalReviews
    goal_reviews: list[GoalReview] = []
    for goal in active_goals:
        recent_tasks = (await db.execute(
            select(Task)
            .where(
                Task.goal_id == goal.id,
                Task.status == "completed",
                Task.scheduled_date >= seven_days_ago,
            )
            .order_by(Task.scheduled_date.desc())
            .limit(5)
        )).scalars().all()
        if not recent_tasks:
            continue
        kb_items = (await db.execute(
            select(KnowledgeItem)
            .where(KnowledgeItem.goal_id == goal.id, KnowledgeItem.source_type != "chat_note")
            .limit(2)
        )).scalars().all()
        effective_count = min(count, max(1, len(recent_tasks)))
        try:
            questions = await _generate_review_questions(goal.title, recent_tasks, kb_items, effective_count)
        except Exception:
            questions = _fallback_questions(recent_tasks)
        goal_reviews.append(GoalReview(
            goalId=goal.id,
            goalTitle=goal.title,
            questions=questions,
        ))

    # 构建 insight
    if streak >= 7:
        insight = f"连续打卡 {streak} 天！按当前节奏正稳步推进目标。"
    elif streak >= 3:
        insight = f"已连续打卡 {streak} 天，保持这个节奏！"
    elif streak >= 1:
        insight = f"今天是连续打卡第 {streak} 天，坚持下去！"
    else:
        insight = "今天是重新出发的好时机，完成今日 Check-in 开始积累连续打卡！"

    if today_total > 0:
        insight += f" 今日任务 {today_done}/{today_total} 已完成。"

    # 推荐行动：今日最高优先级未完成任务
    priority_order = {"high": 0, "medium": 1, "low": 2}
    pending = [t for t in today_tasks if t.status != "completed"]
    pending.sort(key=lambda t: priority_order.get(t.priority or "low", 2))
    if pending:
        recommended_action = f"建议先完成：{pending[0].title}"
    elif today_total > 0:
        recommended_action = "今日任务已全部完成，干得漂亮！"
    else:
        recommended_action = "暂无今日任务，可前往目标页添加计划。"

    return DailyBriefOut(
        date=today,
        summary=summary,
        goalReviews=goal_reviews,
        insight=insight,
        recommendedAction=recommended_action,
    ).model_dump()


@router.get("/daily-brief", response_model=DailyBriefOut | None)
async def daily_brief(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    count: int = Query(default=3, ge=1, le=5),
    refresh: bool = Query(default=False),
) -> DailyBriefOut | None:
    today = date.today().isoformat()
    if not refresh:
        cached = (await db.execute(
            select(DailyBriefCache).where(
                DailyBriefCache.user_id == current_user.id,
                DailyBriefCache.date == today,
            )
        )).scalar_one_or_none()
        if cached:
            if count != 3:
                pass  # bypass cache, regenerate below
            else:
                if not cached.is_read:
                    await db.execute(
                        update(DailyBriefCache)
                        .where(DailyBriefCache.id == cached.id)
                        .values(is_read=True)
                    )
                    await db.commit()
                return DailyBriefOut(**cached.content)

    brief_dict = await _build_daily_brief_for_user(current_user.id, db, count)
    if not brief_dict:
        return None
    await _upsert_brief_cache(current_user.id, db, brief_dict, "on_demand")
    return DailyBriefOut(**brief_dict)


@router.get("/daily-brief/goal/{goal_id}", response_model=GoalReview | None)
async def refresh_goal_review(
    goal_id: str,
    count: int = Query(default=3, ge=1, le=10),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> GoalReview | None:
    """单目标重新生成复习题（用户手动调整题数时调用）"""
    seven_days_ago = (date.today() - timedelta(days=7)).isoformat()
    goal = (await db.execute(select(Goal).where(Goal.id == goal_id))).scalar_one_or_none()
    if not goal or goal.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="Goal not found")

    goal_tasks = (await db.execute(
        select(Task)
        .where(Task.goal_id == goal_id, Task.status == "completed", Task.scheduled_date >= seven_days_ago)
        .order_by(Task.scheduled_date.desc())
        .limit(5)
    )).scalars().all()

    if not goal_tasks:
        return None

    kb_items = (await db.execute(
        select(KnowledgeItem)
        .where(KnowledgeItem.goal_id == goal_id, KnowledgeItem.source_type != "chat_note")
        .limit(2)
    )).scalars().all()

    try:
        questions = await _generate_review_questions(goal.title, list(goal_tasks), list(kb_items), count)
    except Exception:
        questions = _fallback_questions(list(goal_tasks))

    return GoalReview(goalId=goal_id, goalTitle=goal.title, questions=questions)




class VerifyRequest(BaseModel):
    goal_id: str
    task_id: str


class VerifyAnswerRequest(BaseModel):
    goal_id: str
    task_id: str
    answer: str


@router.post("/verify")
async def verify_start(
    body: VerifyRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    task = (await db.execute(
        select(Task).join(Goal, Task.goal_id == Goal.id).where(
            Task.id == body.task_id,
            Goal.user_id == current_user.id,
        )
    )).scalar_one_or_none()
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在")

    llm = ChatOpenAI(
        model=settings.smart_model_name,
        api_key=settings.smart_api_key,
        base_url=settings.smart_base_url or None,
        max_tokens=500,
    )
    prompt = (
        f"学习者刚完成了任务「{task.title}」。\n\n"
        "请生成一道深度检验理解的题目，以及该题目的参考答案要点。\n"
        "要求：\n"
        "- 问题聚焦原理理解、应用场景或知识间的联系，而非可以直接搜索到的事实\n"
        "- 参考答案列出3-5个核心要点，每个要点一行，供学习者自我对照\n\n"
        "严格按以下JSON格式输出，不加任何额外内容：\n"
        '{"question": "问题内容", "answer_hint": "要点1\\n要点2\\n要点3"}'
    )
    result = await llm.ainvoke([HumanMessage(content=prompt)])
    raw = result.content.strip()
    try:
        start, end = raw.find("{"), raw.rfind("}") + 1
        parsed = json.loads(raw[start:end])
        question = parsed.get("question", "").strip()
        answer_hint = parsed.get("answer_hint", "").strip()
    except Exception:
        question = raw
        answer_hint = ""

    _verify_cache[f"{current_user.id}:{body.task_id}"] = question
    return {"question": question, "answer_hint": answer_hint}


@router.post("/verify/answer")
async def verify_answer(
    body: VerifyAnswerRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    task = (await db.execute(
        select(Task).join(Goal, Task.goal_id == Goal.id).where(
            Task.id == body.task_id,
            Goal.user_id == current_user.id,
        )
    )).scalar_one_or_none()
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在")

    question = _verify_cache.get(
        f"{current_user.id}:{body.task_id}",
        f"谈谈你对「{task.title}」的理解",
    )

    llm = ChatOpenAI(
        model=settings.smart_pro_model_name,
        api_key=settings.smart_api_key,
        base_url=settings.smart_base_url or None,
        max_tokens=700,
    )
    eval_prompt = (
        f"任务：「{task.title}」\n"
        f"考查问题：{question}\n"
        f"学习者回答：{body.answer}\n\n"
        "你是一位严格但友善的学习导师，请对学习者的回答进行全面评估。\n"
        "评分标准：\n"
        "- 90-100：概念清晰、有深度，能举例或联系实际\n"
        "- 70-89：基本掌握，有少量不准确或遗漏\n"
        "- 60-69：理解浅显，答到了部分要点但缺乏深度\n"
        "- 0-59：答非所问、概念混淆或严重遗漏核心内容\n\n"
        "评分规则：score >= 60 视为通过（passed=true）\n\n"
        "严格按以下JSON格式输出，不加任何额外内容：\n"
        '{"score": 数字, "passed": true或false, '
        '"feedback": "2-3句具体评语，指出亮点和不足", '
        '"suggestion": "当score<60时：3条具体复习建议（如：重新阅读XX概念/尝试XX练习），否则为null", '
        '"follow_up": "当60<=score<80时：一个追问帮助深化理解，否则为null"}'
    )
    result = await llm.ainvoke([HumanMessage(content=eval_prompt)])
    raw = result.content.strip()

    try:
        start, end = raw.find("{"), raw.rfind("}") + 1
        parsed = json.loads(raw[start:end])
        passed = bool(parsed.get("passed", False))
        score = int(parsed.get("score", 70 if passed else 45))
        feedback = parsed.get("feedback", "感谢你的回答！")
        suggestion = parsed.get("suggestion") if not passed else None
        follow_up = parsed.get("follow_up") if passed and score < 80 else None
    except Exception:
        passed = True
        score = 75
        feedback = "很好，继续保持！"
        suggestion = None
        follow_up = None

    if passed:
        task.mastery_level = "L3" if score < 90 else "L4"
        await db.commit()

    out: dict = {"passed": passed, "score": score, "feedback": feedback}
    if suggestion:
        out["suggestion"] = suggestion
    if follow_up:
        out["follow_up"] = follow_up
    return out


# ── Daily Task Generation ─────────────────────────────────────

class DailyTaskSuggestion(BaseModel):
    title: str
    estimated_mins: int
    type: str  # study | review | practice
    source_task_id: str | None = None
    reason: str


class GoalDailyPlan(BaseModel):
    goal_id: str
    goal_title: str
    daily_hours: float
    tasks: list[DailyTaskSuggestion]


@router.post("/daily-tasks", response_model=list[GoalDailyPlan])
async def generate_daily_tasks(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[GoalDailyPlan]:
    goals = (await db.execute(
        select(Goal).where(Goal.user_id == current_user.id, Goal.status == "active")
    )).scalars().all()
    if not goals:
        return []

    today = date.today().isoformat()
    week_ago = (date.today() - timedelta(days=7)).isoformat()

    # 本地模型优先，失败则回退 Smart API
    _llm_candidates = []
    if settings.openai_base_url:
        _llm_candidates.append(ChatOpenAI(
            model=settings.model_name or "deepseek-chat",
            openai_api_key=settings.openai_api_key or "local",
            openai_api_base=settings.openai_base_url,
            temperature=0.3,
        ))
    if settings.smart_api_key:
        _llm_candidates.append(ChatOpenAI(
            model=settings.smart_model_name or "deepseek-chat",
            openai_api_key=settings.smart_api_key,
            openai_api_base=settings.smart_base_url,
            temperature=0.3,
        ))

    result: list[GoalDailyPlan] = []

    for goal in goals:
        daily_hours = float(goal.daily_hours or 1.0)

        # 最近7天 checkin
        checkins = (await db.execute(
            select(CheckinRecord)
            .where(CheckinRecord.goal_id == goal.id, CheckinRecord.date >= week_ago)
            .order_by(CheckinRecord.date.desc())
        )).scalars().all()

        # pending 任务（含过期）
        pending_tasks = (await db.execute(
            select(Task)
            .where(Task.goal_id == goal.id, Task.status.in_(["pending", "partial"]))
            .order_by(Task.scheduled_date, Task.created_at)
            .limit(20)
        )).scalars().all()

        # mastery=basic 的任务（需复习）
        weak_tasks = (await db.execute(
            select(Task)
            .where(Task.goal_id == goal.id, Task.mastery_level == "L2")
            .order_by(Task.created_at.desc())
            .limit(10)
        )).scalars().all()

        checkin_summary = "\n".join(
            f"- {c.date}: 完成度{round(c.completion_rate * 100)}%"
            for c in checkins
        ) or "本周暂无打卡记录"

        pending_summary = "\n".join(
            f"- [{t.id}] {t.title} (scheduled:{t.scheduled_date}, priority:{t.priority}, mastery:{t.mastery_level or 'unknown'})"
            for t in pending_tasks
        ) or "无待完成任务"

        weak_summary = "\n".join(
            f"- [{t.id}] {t.title}"
            for t in weak_tasks
        ) or "无"

        budget_mins = int(daily_hours * 60)

        try:
            days_remaining = (date.fromisoformat(goal.deadline) - date.today()).days
        except (ValueError, TypeError):
            days_remaining = 999
        urgency_label = (
            "极高（≤7天）" if days_remaining <= 7
            else "高（≤30天）" if days_remaining <= 30
            else "中（≤90天）" if days_remaining <= 90
            else "低"
        )

        overdue_count = sum(
            1 for t in pending_tasks
            if t.scheduled_date and t.scheduled_date < today
        )
        eff_hours = max(daily_hours, 0.5)  # 防止 daily_hours=0 导致除零
        pressure_score = round((overdue_count * 2 + len(pending_tasks)) / eff_hours, 1)
        pressure_label = (
            "极高风险" if pressure_score >= 4
            else "高风险" if pressure_score >= 2
            else "中等" if pressure_score >= 1
            else "正常"
        )

        prompt = (
            f"你是一个学习规划助手。请为用户今日（{today}）规划目标「{goal.title}」的学习任务。\n\n"
            f"目标元信息：\n"
            f"- 目标：{goal.title}（截止日期：{goal.deadline} | 距今 {days_remaining} 天，紧迫度：{urgency_label} | 积压状态：{pressure_label} [压力分: {pressure_score}]）\n"
            f"- 当前水平：{goal.current_level}\n"
            f"- 每日学习预算：{budget_mins} 分钟\n\n"
            f"最近7天打卡记录：\n{checkin_summary}\n\n"
            f"待完成任务（含过期，按 priority 降序排列）：\n{pending_summary}\n\n"
            f"掌握薄弱任务（需复习）：\n{weak_summary}\n\n"
            "规划规则（必须全部遵守）：\n"
            "1. 按 priority 降序安排任务，同等优先级优先选择过期任务；当本目标与其他目标截止日期相同时，必须严格参考【积压状态】和【压力分】，压力分越高越优先安排任务\n"
            f"2. 紧迫度为极高/高时，今日任务总时长可上浮至预算的 120%（最多 {int(budget_mins * 1.2)} 分钟）\n"
            "3. mastery=L2 的任务安排 30 分钟复习；mastery=L1 的任务重新学习\n"
            "4. 若最近3天完成率均<50%，减少今日任务数量（最多2个）\n"
            f"5. 【时间总量约束】总时长必须控制在预算 ±10% 以内（{int(budget_mins * 0.9)}~{int(budget_mins * 1.1)} 分钟）；紧迫度极高/高时上限放宽至 120%\n"
            f"6. 【极端时间守卫】若预算 < 120 分钟，输出任务数量不超过 2 个，单任务时长不低于 30 分钟\n"
            "7. 单任务时长范围：30~60 分钟；禁止出现 <30 分钟或 >60 分钟的任务\n"
            "8. 若有合适的 source_task_id（来自待完成任务列表），填写该字段；否则为 null\n\n"
            "请以JSON数组返回，每项格式：\n"
            '{"title":"任务标题","estimated_mins":30,"type":"study|review|practice","source_task_id":"id或null","reason":"简短原因"}\n'
            "只返回JSON数组，不要其他文字。"
        )

        suggestions = []
        for _llm in _llm_candidates:
            try:
                res = await _llm.ainvoke([HumanMessage(content=prompt)])
                raw = res.content.strip()
                start, end = raw.find("["), raw.rfind("]") + 1
                suggestions = [DailyTaskSuggestion(**s) for s in json.loads(raw[start:end])]
                break
            except Exception:
                continue

        result.append(GoalDailyPlan(
            goal_id=goal.id,
            goal_title=goal.title,
            daily_hours=daily_hours,
            tasks=suggestions,
        ))

    return result


class RescheduleOut(BaseModel):
    estimated_completion_date: str
    days_saved: int
    rescheduled_count: int


@router.post("/reschedule/{goal_id}", response_model=RescheduleOut)
async def reschedule_goal(
    goal_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> RescheduleOut:
    goal = (await db.execute(
        select(Goal).where(Goal.id == goal_id, Goal.user_id == current_user.id)
    )).scalar_one_or_none()
    if not goal:
        raise HTTPException(status_code=404, detail="目标不存在")

    pending_tasks = (await db.execute(
        select(Task)
        .where(
            Task.goal_id == goal_id,
            Task.mastery_level != "good",
            Task.status.in_(["pending", "partial"]),
        )
        .order_by(Task.scheduled_date, Task.created_at)
    )).scalars().all()

    if not pending_tasks:
        return RescheduleOut(
            estimated_completion_date=goal.deadline,
            days_saved=0,
            rescheduled_count=0,
        )

    work_schedule = (goal.meta or {}).get("work_schedule", "all")
    today = date.today()
    deadline = date.fromisoformat(goal.deadline)
    available_dates = _get_available_dates(today, deadline, work_schedule)

    if not available_dates:
        raise HTTPException(status_code=422, detail="截止日期已过，无可用日期")

    original_last = max(t.scheduled_date for t in pending_tasks)
    task_dicts = [{"estimated_mins": t.estimated_mins} for t in pending_tasks]
    scheduled = _distribute_tasks_by_day(task_dicts, available_dates, float(goal.daily_hours or 1.0))

    for task, new_date in zip(pending_tasks, scheduled):
        task.scheduled_date = new_date.isoformat()

    await db.commit()

    new_last = scheduled[-1] if scheduled else today
    days_saved = max(0, (date.fromisoformat(original_last) - new_last).days)

    return RescheduleOut(
        estimated_completion_date=new_last.isoformat(),
        days_saved=days_saved,
        rescheduled_count=len(pending_tasks),
    )


# ── Note Assist ──────────────────────────────────────────────

class NoteAssistRequest(BaseModel):
    command: str          # summarize | expand | quiz | checklist
    context: str = ""     # 用户选中的文字或空
    goal_id: str | None = None


@router.post("/note-assist")
async def note_assist(
    body: NoteAssistRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    goal_ctx = ""
    if body.goal_id:
        goal = (await db.execute(
            select(Goal).where(Goal.id == body.goal_id, Goal.user_id == current_user.id)
        )).scalar_one_or_none()
        if goal:
            recent_tasks = (await db.execute(
                select(Task).where(Task.goal_id == goal.id).order_by(Task.scheduled_date.desc()).limit(5)
            )).scalars().all()
            task_titles = "、".join(t.title for t in recent_tasks)
            goal_ctx = f"学习目标：{goal.title}。近期任务：{task_titles}。"

    prompts = {
        "summarize": f"{goal_ctx}请用 3-5 句话总结上述学习内容的核心要点，输出简洁的 Markdown 列表。",
        "expand":    f"{goal_ctx}请对以下内容进行展开说明，补充关键细节和示例：\n{body.context}",
        "quiz":      f"{goal_ctx}请根据上述学习内容，生成 3 道有深度的思考题（含参考答案要点），用 Markdown 格式输出。",
        "checklist": f"{goal_ctx}请将以下内容整理成可操作的任务清单（Markdown 任务列表格式）：\n{body.context}",
    }
    prompt_text = prompts.get(body.command, prompts["summarize"])

    llm = ChatOpenAI(
        model=settings.smart_model_name,
        api_key=settings.smart_api_key,
        base_url=settings.smart_base_url or None,
        max_tokens=600,
        temperature=0.7,
    )
    resp = await llm.ainvoke([HumanMessage(content=prompt_text)])
    return {"content": resp.content}
