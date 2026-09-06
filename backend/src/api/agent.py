import hashlib
import json
import logging
import math
import time
import uuid
from datetime import date, timedelta
from typing import Literal

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from langchain_core.messages import HumanMessage
from pydantic import BaseModel
from sqlalchemy import func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sse_starlette.sse import EventSourceResponse

from src.core.agent.dispatch import action_clarification, resolve_need_frame
from src.core.llm_quality import compact_text
from src.core.llm_router import (
    ainvoke_structured_checked,
    create_critical_llm,
    create_interactive_llm,
    require_json_array,
    require_json_object,
)
from src.core.time import local_date_for_timezone, utc_now
from src.database import get_db
from src.deps import get_current_user
from src.events.publisher import emit
from src.intelligence.decision_context import DecisionContextBuilder
from src.intelligence.knowledge_graph import KnowledgeGraphService
from src.models import (
    CheckinRecord,
    DailyBriefCache,
    Goal,
    KnowledgeChunk,
    KnowledgeItem,
    KnowledgeItemGoalLink,
    LearningEvent,
    Plan,
    Task,
    TaskMasteryRecord,
    User,
)

logger = logging.getLogger(__name__)

# 内存缓存：key = "{user_id}:{task_id}"，value = 生成的验证问题
_verify_cache: dict[str, str] = {}

router = APIRouter(prefix="/api/v1/agent", tags=["agent"])


# ── Stream ────────────────────────────────────────────────────


class PiloPreferencesRequest(BaseModel):
    tone: Literal["warm", "direct", "socratic"] = "warm"
    initiative: Literal["quiet", "balanced", "proactive"] = "balanced"
    detail: Literal["brief", "balanced", "deep"] = "balanced"
    celebrateProgress: bool = True
    motion: Literal["calm", "lively"] = "calm"


class StreamRequest(BaseModel):
    message: str
    goal_id: str | None = None
    session_id: str
    pilo_preferences: PiloPreferencesRequest | None = None
    source_type: str | None = None
    source_id: str | None = None
    source_version: int | None = None


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


def _cosine_sim(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(x * x for x in b))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


async def _get_embedding(text: str) -> list[float] | None:
    try:
        from src.core.embedding import embed_text

        return await embed_text(text)
    except Exception as exc:
        logger.warning("任务知识匹配的语义向量生成失败，降级为关键词检索: %s", type(exc).__name__)
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
            scored = [(it.id, _cosine_sim(query_emb, it.embedding)) for it in items_with_emb]
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
            pair = title_lower[i : i + 2]
            if all("\u4e00" <= c <= "\u9fff" for c in pair):
                candidates.add(pair)
        if candidates:
            for item in items_no_emb:
                if len(matched_ids) >= 3:
                    break
                combined = (item.title + " " + item.content[:1000]).lower()
                if any(c in combined for c in candidates):
                    matched_ids.add(item.id)

    return list(matched_ids)[:3]


async def _create_goal_plan_action(
    db: AsyncSession,
    user: User,
    message: str,
    structured: dict,
    conversation_turn_id: str,
    need_frame: dict,
) -> dict:
    from src.services.proposal_service import (
        ProposalCreate,
        convert_insight_to_action_run,
        create_proposal,
    )

    today = local_date_for_timezone(user.timezone)
    total_weeks = max(1, min(int(structured.get("total_weeks") or 4), 260))
    weekly_hours = max(0.5, min(float(structured.get("weekly_hours") or 7), 84))
    plan_summary = str(structured.get("plan_summary") or message[:80]).strip()
    goal_id = str(uuid.uuid4())
    goal_snapshot = {
        "id": goal_id,
        "type": "skill",
        "title": plan_summary[:20] or "学习目标",
        "deadline": (today + timedelta(weeks=total_weeks)).isoformat(),
        "daily_hours": max(0.5, min(round(weekly_hours / 7, 1), 12)),
        "current_level": "beginner",
        "status": "active",
        "meta": {"plan_summary": plan_summary, "phases": structured.get("phases", [])},
        "version": 1,
    }
    sample_tasks = list(structured.get("sample_tasks") or [])[:30]
    if not sample_tasks:
        sample_tasks = [
            {"title": f"{phase['name']}：{str(phase.get('focus', ''))[:20]}", "estimated_mins": 60}
            for phase in list(structured.get("phases") or [])[:12]
        ]
    tasks = [
        {
            "id": str(uuid.uuid4()),
            "goal_id": goal_id,
            "title": str(item.get("title") or f"任务 {index + 1}")[:200],
            "description": None,
            "estimated_mins": max(5, min(int(item.get("estimated_mins") or 30), 480)),
            "status": "pending",
            "priority": "medium",
            "scheduled_date": (today + timedelta(days=index)).isoformat(),
            "mastery_level": "unknown",
            "type": str(item.get("type") or "study"),
            "kb_refs": [],
            "version": 1,
        }
        for index, item in enumerate(sample_tasks)
    ]
    proposal = await create_proposal(
        user.id,
        ProposalCreate(
            proposal_type="GOAL_PLAN_CREATE",
            title=f"创建目标“{goal_snapshot['title']}”",
            summary=plan_summary,
            reasoning=["这是根据本轮目标描述生成的计划草案，执行前需要确认具体目标与任务。"],
            proposed_changes={"goal": goal_snapshot, "tasks": tasks},
            confidence=0.9,
        ),
        db,
        source="ai_agent",
    )
    return await convert_insight_to_action_run(
        user.id,
        str(proposal["id"]),
        db,
        conversation_turn_id=conversation_turn_id,
        need_frame=need_frame,
    )


async def _create_checkin_action(
    db: AsyncSession,
    user: User,
    goal_id: str,
    text: str,
    rate: float,
    conversation_turn_id: str,
    need_frame: dict,
) -> dict:
    from src.services.proposal_service import (
        ProposalCreate,
        convert_insight_to_action_run,
        create_proposal,
    )

    checkin_date = local_date_for_timezone(user.timezone).isoformat()
    proposal = await create_proposal(
        user.id,
        ProposalCreate(
            goal_id=goal_id,
            proposal_type="CHECKIN_RECORD",
            title="确认本次学习打卡",
            summary=f"Pilo 从你的描述中推断本次完成度约为 {round(rate * 100)}%。",
            reasoning=["自然语言完成度可能存在理解偏差，因此记录前需要你确认。"],
            proposed_changes={
                "goal_id": goal_id,
                "date": checkin_date,
                "natural_text": text,
                "completion_rate": rate,
            },
            confidence=0.75,
        ),
        db,
        source="ai_agent",
    )
    return await convert_insight_to_action_run(
        user.id,
        str(proposal["id"]),
        db,
        conversation_turn_id=conversation_turn_id,
        need_frame=need_frame,
    )


@router.post("/stream")
async def stream(
    body: StreamRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> EventSourceResponse:
    from langchain_core.messages import HumanMessage

    from src.core.agent.graph import get_agent

    async def generate():
        stream_started = time.monotonic()
        first_token_logged = False
        try:
            conversation_turn_id = str(uuid.uuid4())
            need_frame = await resolve_need_frame(
                db,
                user_id=current_user.id,
                session_id=body.session_id,
                conversation_turn_id=conversation_turn_id,
                message=body.message,
                goal_id=body.goal_id,
            )
            action_intent = need_frame.action_intent
            if need_frame.speech_act == "cancel" and action_intent is None:
                yield {
                    "event": "token",
                    "data": json.dumps(
                        {"text": "好的，刚才那项待补充的操作已经取消，不会生成变更。"},
                        ensure_ascii=False,
                    ),
                }
                yield {"event": "done", "data": "{}"}
                return
            if action_intent is not None and not action_intent.complete:
                clarification = action_clarification(action_intent)
                yield {
                    "event": "token",
                    "data": json.dumps({"text": clarification}, ensure_ascii=False),
                }
                yield {"event": "done", "data": "{}"}
                return
            if action_intent is not None:
                from src.core.agent_v2.orchestrator import create_run, run_detail
                from src.tasks.agent_runs import dispatch_agent_run

                yield {
                    "event": "action_start",
                    "data": json.dumps(
                        {"capability": action_intent.capability}, ensure_ascii=False
                    ),
                }
                run = await create_run(
                    db,
                    user_id=current_user.id,
                    request=str(action_intent.constraints.get("resolved_request") or body.message),
                    goal_id=action_intent.goal_id,
                    step_budget=10,
                    token_budget=20000,
                    auto_advance=False,
                    run_kind="user",
                    action_intent=action_intent,
                    deterministic_plan_only=True,
                    conversation_turn_id=conversation_turn_id,
                    trace_context={
                        "conversation_turn_id": conversation_turn_id,
                        "need_frame": need_frame.model_dump(mode="json"),
                        "action_intent": action_intent.model_dump(mode="json"),
                        "source": "pilo",
                    },
                )
                try:
                    dispatch_agent_run(run.id, current_user.id)
                except Exception:
                    logger.exception(
                        "action_agent_dispatch_failed run_id=%s; recovery will retry",
                        run.id,
                    )
                detail = await run_detail(db, current_user.id, run.id)
                yield {
                    "event": "action_run",
                    "data": json.dumps(detail, ensure_ascii=False),
                }
                logger.info(
                    "agent_request_dispatched mode=action capability=%s run_id=%s latency_ms=%.1f",
                    action_intent.capability,
                    run.id,
                    (time.monotonic() - stream_started) * 1000,
                )
                yield {"event": "done", "data": "{}"}
                return

            agent = await get_agent()
            config = {"configurable": {"thread_id": f"user_{current_user.id}_{body.session_id}"}}
            state_input = {
                "messages": [HumanMessage(content=body.message)],
                "user_id": current_user.id,
                "goal_id": body.goal_id,
                "pilo_preferences": (
                    body.pilo_preferences.model_dump() if body.pilo_preferences else None
                ),
                "conversation_turn_id": conversation_turn_id,
                "need_frame": need_frame.model_dump(mode="json"),
            }

            from src.core.agent.nodes.intent import _keyword_intent
            from src.services.chat_context import build_chat_context

            fast_intent = _keyword_intent(body.message)
            if fast_intent in {"goal_setup", "checkin", "verification"}:
                chat_context: dict = {}
                context_meta = {
                    "latency_ms": 0.0,
                    "quality": "not_required",
                    "memory_count": 0,
                    "knowledge_count": 0,
                }
            else:
                yield {"event": "context_start", "data": "{}"}
                chat_context, context_meta = await build_chat_context(
                    user_id=current_user.id,
                    goal_id=body.goal_id,
                    message=body.message,
                    source_id=body.source_id if body.source_type == "note" else None,
                    source_version=body.source_version,
                )
            state_input["chat_context"] = chat_context
            yield {
                "event": "context_ready",
                "data": json.dumps(context_meta, ensure_ascii=False),
            }
            source_refs = []
            goal_source = chat_context.get("goal")
            if body.goal_id and isinstance(goal_source, dict) and goal_source.get("title"):
                source_refs.append(
                    {
                        "id": body.goal_id,
                        "title": goal_source["title"],
                        "citation": f"目标：《{goal_source['title']}》",
                        "source_type": "goal",
                        "source_role": "user_intent_contract",
                        "intent_version": goal_source.get("intent_version"),
                    }
                )
            source_refs.extend(
                [
                    {
                        key: source.get(key)
                        for key in (
                            "id",
                            "title",
                            "citation",
                            "source_type",
                            "source_role",
                            "chunk_index",
                            "content_version",
                        )
                        if source.get(key) is not None
                    }
                    for source in (chat_context.get("knowledge_sources") or [])
                ]
            )
            if source_refs:
                yield {
                    "event": "sources",
                    "data": json.dumps({"sources": source_refs}, ensure_ascii=False),
                }

            from src.core.agent.nodes.chat import sanitize_user_visible_text

            async for event in agent.astream_events(state_input, config=config, version="v2"):
                kind = event["event"]

                if kind == "on_chat_model_stream":
                    node = event.get("metadata", {}).get("langgraph_node", "")
                    if node not in ("setup_goal", "chat", "checkin", "verify"):
                        continue
                    chunk = event["data"].get("chunk")
                    text = chunk.content if chunk and hasattr(chunk, "content") else ""
                    if text:
                        if not first_token_logged:
                            first_token_logged = True
                            logger.info(
                                "agent_stream_first_token latency_ms=%.1f context_latency_ms=%.1f",
                                (time.monotonic() - stream_started) * 1000,
                                context_meta["latency_ms"],
                            )
                        # The final graph message is emitted after deterministic
                        # privacy and non-writing output contracts have run.
                        # Action status continues to use its independent SSE path.

                elif kind == "on_tool_start":
                    yield {
                        "event": "tool_start",
                        "data": json.dumps({"tool": event.get("name", "")}),
                    }

                elif kind == "on_tool_end":
                    yield {"event": "tool_end", "data": "{}"}

                elif kind == "on_chain_end" and event.get("name") in ("setup_goal",):
                    out = event["data"].get("output") or {}
                    if isinstance(out, dict) and out.get("structured_output"):
                        yield {"event": "structured", "data": json.dumps(out["structured_output"])}

            final_state = await agent.aget_state(config)
            final_messages = list(final_state.values.get("messages") or [])
            final_text = next(
                (
                    str(getattr(message, "content", ""))
                    for message in reversed(final_messages)
                    if getattr(message, "type", "") == "ai" and getattr(message, "content", "")
                ),
                "",
            )
            final_text = sanitize_user_visible_text(final_text)
            if final_text:
                yield {"event": "token", "data": json.dumps({"text": final_text})}
            actual_context_trace = final_state.values.get("actual_context_trace")
            if isinstance(actual_context_trace, dict):
                yield {
                    "event": "context_trace",
                    "data": json.dumps(actual_context_trace, ensure_ascii=False),
                }

            # 目标计划只生成草案；实际创建统一进入 Action Run 审批链。
            if not body.goal_id:
                structured = final_state.values.get("structured_output")
                if structured:
                    run_detail_payload = await _create_goal_plan_action(
                        db,
                        current_user,
                        body.message,
                        structured,
                        conversation_turn_id,
                        need_frame.model_dump(mode="json"),
                    )
                    yield {
                        "event": "action_run",
                        "data": json.dumps(run_detail_payload, ensure_ascii=False),
                    }

            # 自然语言打卡先生成预览；确认后由统一 Executor 保存。
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
                    checkin_run = await _create_checkin_action(
                        db,
                        current_user,
                        target_goal_id,
                        checkin_text,
                        checkin_rate,
                        conversation_turn_id,
                        need_frame.model_dump(mode="json"),
                    )
                    yield {
                        "event": "action_run",
                        "data": json.dumps(checkin_run, ensure_ascii=False),
                    }

            logger.info(
                "agent_stream_completed latency_ms=%.1f context_latency_ms=%.1f first_token=%s",
                (time.monotonic() - stream_started) * 1000,
                context_meta["latency_ms"],
                first_token_logged,
            )
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
    """按每日预算分配任务，并在给定时间窗内尽量均匀展开。"""
    if not available_dates:
        return [date.today()] * len(tasks)
    daily_budget_mins = max(30, daily_hours * 60)
    result: list[date] = []
    day_idx = 0
    day_used = [0.0] * len(available_dates)
    task_count = len(tasks)
    for task_idx, task in enumerate(tasks):
        if task_count > 1 and len(available_dates) > 1:
            target_idx = round(task_idx * (len(available_dates) - 1) / (task_count - 1))
            day_idx = max(day_idx, target_idx)
        task_mins = float(task.get("estimated_mins") or 30)
        while (
            day_idx < len(available_dates) - 1
            and day_used[day_idx] > 0
            and day_used[day_idx] + task_mins > daily_budget_mins
        ):
            day_idx += 1
        result.append(available_dates[day_idx])
        day_used[day_idx] += task_mins
    return result


def _schedule_plan_phases(
    phases: list[dict], available_dates: list[date], daily_hours: float
) -> list[date]:
    """按连续且不重叠的阶段时间窗排程，保持阶段和任务的先后顺序。"""
    if not available_dates:
        return [date.today()] * sum(len(phase.get("tasks") or []) for phase in phases)

    scheduled: list[date] = []
    cursor = 0
    for phase in phases:
        phase_days = max(0, int(phase.get("days") or 0))
        window = available_dates[cursor : cursor + phase_days]
        cursor += phase_days
        if not window:
            fallback_idx = min(max(cursor, 1), len(available_dates)) - 1
            window = [available_dates[fallback_idx]]
        scheduled.extend(_distribute_tasks_by_day(phase.get("tasks") or [], window, daily_hours))
    return scheduled


def _allocate_phase_days(weights: list[int], available_days: int) -> list[int]:
    """用最大余数法分配阶段天数，保证结果之和严格等于可用天数。"""
    if not weights:
        return []
    total_days = max(1, available_days)
    minimums = [1 if index < total_days else 0 for index in range(len(weights))]
    remaining = total_days - sum(minimums)
    if remaining <= 0:
        return minimums

    safe_weights = [max(1, int(weight or 1)) for weight in weights]
    total_weight = sum(safe_weights)
    raw_shares = [remaining * weight / total_weight for weight in safe_weights]
    allocations = [minimum + int(share) for minimum, share in zip(minimums, raw_shares)]
    leftovers = total_days - sum(allocations)
    remainder_order = sorted(
        range(len(weights)), key=lambda index: raw_shares[index] % 1, reverse=True
    )
    for index in remainder_order[:leftovers]:
        allocations[index] += 1
    return allocations


def _format_plan_personalization(context: dict) -> str:
    """把经隐私许可的长期证据压缩成规划软约束。"""
    quality = context.get("data_quality") or {}
    if quality.get("personalization_enabled") is False:
        return "【个性化依据】用户未启用个性化；只采用本次目标的显式设置。\n"

    profile = context.get("profile") or {}
    evidence_count = int(profile.get("event_count") or quality.get("profile_event_count") or 0)
    evidence: list[str] = []
    if evidence_count >= 5:
        if profile.get("avg_session_duration_mins") is not None:
            evidence.append(f"历史单次学习平均 {profile['avg_session_duration_mins']:.0f} 分钟")
        if profile.get("avg_daily_investment_mins") is not None:
            evidence.append(f"历史日均投入 {profile['avg_daily_investment_mins']:.0f} 分钟")
        if profile.get("preferred_weekdays"):
            labels = "一二三四五六日"
            weekdays = "、".join(
                f"周{labels[int(day)]}"
                for day in profile["preferred_weekdays"]
                if 0 <= int(day) < 7
            )
            if weekdays:
                evidence.append(f"较常学习日为 {weekdays}")
        if profile.get("reschedule_rate") is not None:
            evidence.append(f"近期待改期率 {profile['reschedule_rate']:.0%}")
        if profile.get("estimation_accuracy") is not None:
            evidence.append(f"历史时长估算准确度 {profile['estimation_accuracy']:.0%}")

    for pattern in (context.get("active_patterns") or [])[:3]:
        explanation = str(pattern.get("explanation") or "").strip()
        if explanation:
            evidence.append(f"行为模式：{explanation}")

    memory_rows = (context.get("memories") or {}).get("semantic", []) + (
        context.get("memories") or {}
    ).get("episodic", [])
    for memory in memory_rows[:3]:
        summary = str(memory.get("summary") or "").strip()
        if summary:
            evidence.append(f"相关记忆：{summary}")

    if not evidence:
        return "【个性化依据】长期行为证据不足；只采用本次目标的显式设置。\n"
    return (
        "【个性化软约束】以下是经用户许可、且已有证据的数据："
        + "；".join(evidence)
        + "。它们只用于调整任务粒度和节奏；用户本次明确设置始终优先，不得据此虚构偏好。\n"
    )


@router.get("/plan-context/{goal_id}")
async def get_plan_context(
    goal_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    goal = (
        await db.execute(select(Goal).where(Goal.id == goal_id, Goal.user_id == current_user.id))
    ).scalar_one_or_none()
    if not goal:
        raise HTTPException(status_code=404, detail="目标不存在")

    kb_id: str | None = goal.knowledge_base_id or (goal.meta or {}).get("kb_id")
    kb_overview: list[dict] = []
    reference_filters = [
        KnowledgeItem.goal_links.any(KnowledgeItemGoalLink.goal_id == goal_id),
    ]
    if kb_id:
        reference_filters.append(KnowledgeItem.kb_id == kb_id)
    kb_items = (
        (
            await db.execute(
                select(KnowledgeItem).where(
                    KnowledgeItem.user_id == current_user.id,
                    or_(*reference_filters),
                )
            )
        )
        .scalars()
        .all()
    )
    _source_registry, source_context = await _build_plan_sources(
        db,
        [item for item in kb_items if item.processing_status == "ready"],
        max_chars=6000,
    )
    for it in kb_items:
        char_count = len(it.content) if it.content else 0
        kb_overview.append(
            {
                "title": it.title,
                "char_count": char_count,
                "estimated_pages": max(1, math.ceil(char_count / 600)),
            }
        )

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
        kb_summary_line = f"参考资料包括：{'、'.join(parts)}。"

    understanding_prompt = (
        f"用户的{type_label}目标是「{goal.title}」，截止日期 {goal.deadline}，"
        f"每日学习 {goal.daily_hours} 小时，当前水平：{goal.current_level}。"
        + (kb_summary_line if kb_summary_line else "未关联参考资料。")
        + (f"\n资料正文片段：\n{source_context}\n" if source_context else "")
        + "\n请用 2-3 句话描述：你对这个学习目标的理解是什么？关键学习重点是什么？有什么需要特别注意的？"
        "如果有多份资料，请根据正文内容给出建议阅读顺序，并说明依赖关系；不要只按文件名猜测。"
        "直接输出理解内容，不要加任何前缀。"
    )

    initial_understanding = ""
    try:
        llm = create_interactive_llm(
            max_tokens=200,
            temperature=0.3,
        )
        result = await llm.ainvoke([HumanMessage(content=understanding_prompt)])
        initial_understanding = compact_text(result.content, 180)
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
    goal = (
        await db.execute(select(Goal).where(Goal.id == goal_id, Goal.user_id == current_user.id))
    ).scalar_one_or_none()
    if not goal:
        raise HTTPException(status_code=404, detail="目标不存在")

    type_label = {
        "exam": "备考",
        "certification": "认证备考",
        "skill": "技能学习",
        "reading": "阅读",
        "language": "语言学习",
        "habit": "习惯养成",
    }.get(goal.type or "skill", "学习")

    prompt = (
        f"用户正在制定「{goal.title}」的{type_label}计划。"
        "请为「补充说明」输入框生成一句 placeholder 示例文字，引导用户描述自己的基础水平、希望重点学习的内容、可以跳过的部分。"
        "要求：以「例如：」开头，内容必须针对该具体目标，30-50字，只输出 placeholder 文字，不要任何解释。"
    )

    placeholder = ""
    try:
        llm = create_interactive_llm(
            max_tokens=100,
            temperature=0.7,
        )
        result = await llm.ainvoke([HumanMessage(content=prompt)])
        placeholder = compact_text(result.content, 50)
    except Exception:
        pass

    return {"placeholder": placeholder}


def _compact_plan_source_text(value: str, limit: int = 1200) -> str:
    return " ".join((value or "").split())[:limit]


def _source_can_influence_plan(item: KnowledgeItem) -> bool:
    metadata = item.source_metadata or {}
    if not metadata:
        return True
    uses = set(metadata.get("learning_use") or [])
    if item.source_role == "scope":
        return bool(uses & {"define_scope", "plan_sequence"})
    return bool(uses & {"plan_sequence", "execute_task"})


async def _build_plan_sources(
    db: AsyncSession,
    items: list[KnowledgeItem],
    *,
    max_chars: int = 18000,
) -> tuple[list[dict], str]:
    """Build a bounded, auditable source pack from actual knowledge content."""
    if not items:
        return [], ""
    item_ids = [item.id for item in items]
    chunks = (
        (
            await db.execute(
                select(KnowledgeChunk)
                .where(KnowledgeChunk.item_id.in_(item_ids))
                .order_by(KnowledgeChunk.item_id, KnowledgeChunk.chunk_index)
            )
        )
        .scalars()
        .all()
    )
    chunks_by_item: dict[str, list[KnowledgeChunk]] = {}
    for chunk in chunks:
        chunks_by_item.setdefault(chunk.item_id, []).append(chunk)

    registry: list[dict] = []
    prompt_blocks: list[str] = []
    used_chars = 0
    rows_by_item: list[tuple[int, KnowledgeItem, list[dict]]] = []
    for item_index, item in enumerate(items, start=1):
        candidates = chunks_by_item.get(item.id) or []
        if candidates:
            source_rows = [
                {
                    "chunk_id": chunk.id,
                    "chunk_index": chunk.chunk_index,
                    "start_char": chunk.start_char,
                    "end_char": chunk.end_char,
                    "text": chunk.content,
                }
                for chunk in candidates
            ]
        elif item.content:
            # Older items may predate chunking. They are still real source text,
            # and the character range makes the fallback citation reviewable.
            source_rows = []
            for chunk_index, start_char in enumerate(range(0, len(item.content), 1200)):
                source_rows.append(
                    {
                        "chunk_id": None,
                        "chunk_index": chunk_index,
                        "start_char": start_char,
                        "end_char": min(len(item.content), start_char + 1200),
                        "text": item.content[start_char : start_char + 1200],
                    }
                )
        else:
            continue
        rows_by_item.append((item_index, item, source_rows))

    # Round-robin excerpts so every selected document contributes its opening
    # structure before any single long document consumes the context budget.
    max_depth = max((len(rows) for _, _, rows in rows_by_item), default=0)
    for depth in range(max_depth):
        for item_index, item, source_rows in rows_by_item:
            if depth >= len(source_rows):
                continue
            row = source_rows[depth]
            text = _compact_plan_source_text(row["text"])
            if not text:
                continue
            source_key = f"S{item_index}-C{row['chunk_index'] + 1}"
            role_label = "学习范围" if item.source_role == "scope" else "执行参考"
            metadata_label = json.dumps(item.source_metadata or {}, ensure_ascii=False)
            block = (
                f"[{source_key}] [{role_label}] 《{item.title}》"
                f"元数据：{metadata_label}\n第 {row['chunk_index'] + 1} 段：{text}"
            )
            if used_chars + len(block) > max_chars and registry:
                continue
            used_chars += len(block)
            citation = f"{item.title} · 第 {row['chunk_index'] + 1} 段"
            registry.append(
                {
                    "source_key": source_key,
                    "item_id": item.id,
                    "item_title": item.title,
                    "source_role": item.source_role or "reference",
                    "source_metadata": item.source_metadata or {},
                    "content_version": int(getattr(item, "content_version", 1) or 1),
                    "chunk_id": row["chunk_id"],
                    "chunk_index": row["chunk_index"],
                    "start_char": row["start_char"],
                    "end_char": row["end_char"],
                    "locator": citation,
                    "snippet": text[:240],
                }
            )
            prompt_blocks.append(block)
        if used_chars >= max_chars:
            break
    return registry, "\n".join(prompt_blocks)


def _normalize_plan_task(
    task: dict, source_map: dict[str, dict], concept_map: dict[str, dict], kb_mode: str
) -> dict:
    title = compact_text(str(task.get("title") or "学习任务"), 40)
    objective = compact_text(
        str(task.get("objective") or task.get("deliverable") or "完成并记录学习结果"), 100
    )
    steps = [
        compact_text(str(step), 120) for step in (task.get("steps") or []) if str(step).strip()
    ]
    if not steps:
        steps = [f"围绕「{title}」学习对应内容", "独立完成练习或复述", "记录结果与仍不确定的部分"]
    done_criteria = [
        compact_text(str(value), 120)
        for value in (task.get("done_criteria") or [objective])
        if str(value).strip()
    ]
    requested_keys = [str(value) for value in (task.get("source_keys") or [])]
    source_refs = [dict(source_map[key]) for key in requested_keys if key in source_map]
    requested_concepts = [str(value) for value in (task.get("concept_ids") or [])]
    concept_refs = [
        {
            "id": concept_map[concept_id]["id"],
            "name": concept_map[concept_id]["name"],
            "review_status": concept_map[concept_id]["review_status"],
        }
        for concept_id in requested_concepts
        if concept_id in concept_map and concept_map[concept_id]["review_status"] == "confirmed"
    ]
    if kb_mode == "kb_only" and source_map and not source_refs:
        # Do not let a model formatting omission silently produce an ungrounded
        # task in strict mode. The first real excerpt remains fully auditable.
        source_refs = [dict(next(iter(source_map.values())))]
    execution_guide = {
        "why_now": compact_text(str(task.get("why_now") or "这是当前阶段的前置行动。"), 160),
        "steps": steps[:6],
        "deliverable": compact_text(str(task.get("deliverable") or objective), 160),
        "done_criteria": done_criteria[:5],
        "prerequisites": [
            compact_text(str(value), 100)
            for value in (task.get("prerequisites") or [])
            if str(value).strip()
        ][:4],
        "source_refs": source_refs[:5],
        "concept_refs": concept_refs[:6],
    }
    return {
        "title": title,
        "objective": objective,
        "estimated_mins": max(10, min(180, int(task.get("estimated_mins") or 30))),
        "type": task.get("type")
        if task.get("type") in {"study", "review", "practice"}
        else "study",
        "execution_guide": execution_guide,
    }


def _validate_macro_plan_output(content: str, *, kb_mode: str, source_keys: set[str]) -> None:
    require_json_object(content)
    start, end = content.find("{"), content.rfind("}") + 1
    payload = json.loads(content[start:end])
    phases = payload.get("phases")
    if not isinstance(phases, list) or not phases:
        raise ValueError("计划必须包含阶段")
    task_count = 0
    for phase in phases:
        tasks = phase.get("tasks") if isinstance(phase, dict) else None
        if not isinstance(tasks, list) or not tasks:
            raise ValueError("每个阶段必须包含任务")
        for task in tasks:
            task_count += 1
            if not isinstance(task, dict) or not str(task.get("title") or "").strip():
                raise ValueError("任务必须有具体标题")
            if not str(task.get("why_now") or "").strip():
                raise ValueError("任务缺少 why_now")
            if len([step for step in (task.get("steps") or []) if str(step).strip()]) < 2:
                raise ValueError("任务至少需要两个执行步骤")
            if not str(task.get("deliverable") or "").strip():
                raise ValueError("任务缺少可检查产出")
            if not [value for value in (task.get("done_criteria") or []) if str(value).strip()]:
                raise ValueError("任务缺少完成标准")
            if kb_mode == "kb_only":
                refs = {str(value) for value in (task.get("source_keys") or [])}
                if not refs.intersection(source_keys):
                    raise ValueError("严格资料模式下每个任务必须引用真实原文片段")
    if task_count == 0:
        raise ValueError("计划没有任务")


def _plan_lifecycle(plan: Plan) -> dict:
    return dict((plan.content or {}).get("lifecycle") or {})


def _draft_response(plan: Plan) -> dict:
    baseline = dict(plan.baseline or {})
    lifecycle = _plan_lifecycle(plan)
    return {
        "plan_id": plan.id,
        "status": lifecycle.get("status", "draft"),
        "goal_intent_version": plan.goal_intent_version,
        "phases": baseline.get("phases") or [],
        "total_tasks": sum(len(phase.get("tasks") or []) for phase in baseline.get("phases") or []),
        "start_date": lifecycle.get("start_date", ""),
        "estimated_completion_date": lifecycle.get("estimated_completion_date", ""),
        "source_summary": lifecycle.get("source_summary") or {},
        "replacement_summary": lifecycle.get("replacement_summary") or {},
    }


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
    if kb_mode not in {"kb_only", "kb_reference", "no_kb"}:
        raise HTTPException(status_code=422, detail="无效的参考资料使用方式")
    if pacing_mode not in {"auto", "fixed"}:
        raise HTTPException(status_code=422, detail="无效的学习节奏设置")

    goal = (
        await db.execute(select(Goal).where(Goal.id == goal_id, Goal.user_id == current_user.id))
    ).scalar_one_or_none()
    if not goal:
        raise HTTPException(status_code=404, detail="目标不存在")

    # 计算可学天数
    today = local_date_for_timezone(current_user.timezone)
    deadline_date = date.fromisoformat(goal.deadline)
    work_schedule: str = goal.work_schedule or (goal.meta or {}).get("work_schedule", "all")
    kb_id: str | None = goal.knowledge_base_id or (goal.meta or {}).get("kb_id")
    goal_type: str = goal.type or "skill"

    # 读取与目标关联的参考资料（兼容旧 knowledge_base_id）。
    kb_items_for_prompt: list[dict] = []
    kb_items_raw: list[KnowledgeItem] = []
    total_kb_chars = 0
    if kb_mode in ("kb_only", "kb_reference"):
        reference_filters = [
            KnowledgeItem.goal_id == goal_id,
            KnowledgeItem.goal_links.any(KnowledgeItemGoalLink.goal_id == goal_id),
        ]
        if kb_id:
            reference_filters.append(KnowledgeItem.kb_id == kb_id)
        kb_items_raw = (
            (
                await db.execute(
                    select(KnowledgeItem).where(
                        KnowledgeItem.user_id == current_user.id,
                        KnowledgeItem.processing_status == "ready",
                        KnowledgeItem.source_role.in_(["scope", "reference"]),
                        or_(*reference_filters),
                    )
                )
            )
            .scalars()
            .all()
        )
        kb_items_raw = [item for item in kb_items_raw if _source_can_influence_plan(item)]
        for it in kb_items_raw:
            char_count = len(it.content) if it.content else 0
            total_kb_chars += char_count
            kb_items_for_prompt.append(
                {
                    "title": it.title,
                    "char_count": char_count,
                    "estimated_pages": max(1, char_count // 600),
                    "source_role": it.source_role or "reference",
                }
            )

    source_registry, source_context = await _build_plan_sources(db, kb_items_raw)
    source_map = {source["source_key"]: source for source in source_registry}
    has_kb_content = bool(source_registry)

    knowledge_map_context = ""
    concept_map: dict[str, dict] = {}
    if kb_mode != "no_kb" and has_kb_content:
        try:
            graph = await KnowledgeGraphService.get_graph(
                db, current_user.id, goal_id=goal_id
            )
            concepts = graph.get("concepts") or []
            edges = graph.get("edges") or []
            if concepts:
                concept_map = {
                    str(item["id"]): item
                    for item in concepts[:48]
                    if item.get("review_status") == "confirmed"
                }
                concept_lines = "\n".join(
                    f"- {item['id']} | {item['name']} | {item.get('review_status', 'draft')}"
                    for item in concept_map.values()
                )
                prerequisite_count = sum(
                    item.get("relation_type") == "prerequisite"
                    and item.get("review_status") != "rejected"
                    for item in edges
                )
                knowledge_map_context = (
                    "【用户已确认的资料知识地图】\n"
                    f"知识点（ID | 名称 | 审核状态）：\n{concept_lines}\n"
                    f"已确认前置关系：{prerequisite_count} 条。"
                    "必须结合下方原文片段；地图是可更新的派生认知资产，不替代原文。"
                    "任务仅可在 concept_ids 中绑定 confirmed 知识点。\n"
                )
        except Exception as exc:
            logger.warning("load confirmed resource knowledge map failed: %s", type(exc).__name__)

    kb_doc_list = "\n".join(
        f"  - [{'学习范围' if item['source_role'] == 'scope' else '执行参考'}] "
        f"《{item['title']}》约 {item['estimated_pages']} 页（{item['char_count']} 字）"
        for item in kb_items_for_prompt
    )

    # 按目标类型 × 资料使用方式决定生成边界。
    is_exam_type = goal_type in ("exam", "certification")

    if kb_mode == "kb_only" and not has_kb_content:
        raise HTTPException(
            status_code=422,
            detail="仅从参考资料生成需要至少一份已处理完成且包含正文的关联资料",
        )

    if kb_mode == "kb_only" and has_kb_content:
        kb_instruction = (
            f"【严格资料边界】只能使用下方带 source_key 的原文片段生成任务，不得引入片段之外的知识点。\n{kb_doc_list}\n"
            "每个任务必须返回至少一个真实 source_key。资料证据不足时减少范围，不要补写常识。\n"
        )
    elif kb_mode == "kb_reference" and has_kb_content:
        if is_exam_type:
            kb_instruction = (
                f"【参考资料】（优先依据下方原文片段划分阶段）：\n{kb_doc_list}\n"
                "备考要求：按文档/模块分阶段，覆盖全部考试重点，后期安排复习和冲刺。\n"
            )
        elif goal_type == "skill":
            kb_instruction = (
                f"【参考资料】（以原文片段为主要教材，结合实战练习）：\n{kb_doc_list}\n"
                "技能要求：学习理论后立即配套实战练习，以项目驱动为主。\n"
            )
        elif goal_type == "reading":
            kb_instruction = (
                f"【参考资料】（作为阅读材料）：\n{kb_doc_list}\n"
                "阅读要求：按章节逐步精读，每章做笔记/摘要，跟进阅读进度，关注理解深度而非速度。\n"
            )
        elif goal_type == "language":
            kb_instruction = (
                f"【参考资料】（作为语言学习材料）：\n{kb_doc_list}\n"
                "语言学习要求：大量输入（听力+阅读）为主，词汇积累+语法系统打底，注重实际应用练习。\n"
            )
        elif goal_type == "habit":
            kb_instruction = (
                f"【参考资料】（作为习惯养成指导）：\n{kb_doc_list}\n"
                "习惯养成要求：从最小行为开始逐步递增，固定时间地点形成条件反射，先建立节奏再提升质量。\n"
            )
        else:
            kb_instruction = f"【参考资料】（作为学习材料）：\n{kb_doc_list}\n"
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
            kb_instruction = (
                "阅读建议：建议关联具体书籍或文章作为参考资料，以便生成更精准的阅读计划。\n"
            )
        elif goal_type == "language":
            kb_instruction = (
                "语言学习建议：大量输入（听力+阅读）为主，词汇积累+语法打底，注重实际应用。\n"
            )
        elif goal_type == "habit":
            kb_instruction = (
                "习惯养成建议：从最小可执行行为开始，固定时间地点，先建立节奏再提升强度。\n"
            )
        else:
            kb_instruction = ""
    else:
        kb_instruction = ""

    # pacing_mode=auto 时注入参考资料阅读节奏估算
    pacing_note = ""
    if pacing_mode == "auto" and total_kb_chars > 0:
        kb_read_hours = round(total_kb_chars / 20000, 1)
        pacing_note = (
            f"【阅读节奏参考】参考资料总计约 {total_kb_chars} 字，"
            f"按正常阅读速度约需 {kb_read_hours} 小时完整阅读，请据此合理分配各阶段阅读任务量。\n"
        )

    # 用户补充意图（高优先级约束）
    intent_note = ""
    if user_intent_supplement:
        intent_note = (
            f"【用户特别说明】（请将以下要求作为高优先级约束融入计划）：{user_intent_supplement}\n"
        )
    contract_note = ""
    if goal.contract:
        contract_note = (
            "【目标契约】以下内容是用户明确设定的结果、基线、成功标准和范围约束，"
            "优先级高于系统建议，不得自行改写：\n"
            + json.dumps(goal.contract, ensure_ascii=False, separators=(",", ":"))
            + "\n"
        )

    try:
        decision_context = await DecisionContextBuilder.build(
            db, current_user.id, goal_id=goal_id, recent_event_limit=8
        )
    except Exception as exc:
        logger.warning("build macro plan personalization context failed: %s", exc)
        decision_context = {}
    personalization_note = _format_plan_personalization(decision_context)

    # 获取所有可用日期列表（含截止日当天）
    available_dates = _get_available_dates(today, deadline_date, work_schedule)
    available_days = max(1, len(available_dates))
    total_study_hours = round(available_days * goal.daily_hours, 1)
    total_study_mins = int(total_study_hours * 60)
    # 每日时长是容量上限，不应强迫模型用碎任务填满所有分钟。
    suggested_tasks_min = max(1, min(12, math.ceil(available_days / 2)))
    suggested_tasks_max = max(suggested_tasks_min, min(24, available_days))

    rest_note = {"weekday": "（已排除周末）", "weekend": "（已排除工作日）", "all": ""}.get(
        work_schedule, ""
    )

    prompt = (
        f"你是 Pilo 背后的计划生成工具。不要输出陪伴话术，也不要暴露内部能力名称。\n"
        f"目标：{goal.title}\n"
        f"目标类型：{goal_type}\n"
        f"开始日期：{today.isoformat()}\n"
        f"截止日期：{goal.deadline}\n"
        f"可学习天数：{available_days} 天{rest_note}，每日学习 {goal.daily_hours} 小时\n"
        f"总可用学习时长：{total_study_hours} 小时（约 {total_study_mins} 分钟）\n"
        f"当前水平：{goal.current_level}\n"
        + intent_note
        + contract_note
        + personalization_note
        + knowledge_map_context
        + kb_instruction
        + pacing_note
        + (f"\n【可引用资料原文】\n{source_context}\n" if source_context else "")
        + f"\n请生成一份完整的学习计划，时间范围覆盖全部 {available_days} 个可学习日，划分成 2-4 个连续阶段。\n"
        f"【容量边界】每日 {goal.daily_hours} 小时和总计 {total_study_mins} 分钟均为上限，不是必须填满的配额；"
        "按完成目标真正需要的工作量估算，不要为了填满时间制造重复任务。\n"
        f"【任务数量】建议生成 {suggested_tasks_min}~{suggested_tasks_max} 个有明确产出的任务，每项通常 15~60 分钟。\n"
        f"【阶段划分】days 表示连续阶段所占的可学习日，所有阶段 days 之和必须等于 {available_days}；"
        "阶段不得重叠，任务必须按前置依赖和实际执行顺序排列。不要输出日期，系统会在阶段时间窗内确定性排期。\n"
        "【行动任务要求】任务不是目录标题。每个任务必须说明 why_now、2-5个可直接执行的steps、"
        "可保存或检查的deliverable，以及1-3条done_criteria。objective必须包含可观测行为动词"
        "（如：能独立写出/能解释/能完成）+具体数量或时长指标。\n"
        "  ❌ 模糊示例：「熟练掌握循环语法」\n"
        "  ✅ 量化示例：「能独立写出3种循环结构各2个正确示例，不查文档」\n"
        "严格按以下JSON格式输出，不加任何解释：\n"
        "{\n"
        '  "phases": [\n'
        '    {"name": "阶段名", "days": 整数, "focus": "核心重点（30字内）",\n'
        '     "tasks": [{"title": "具体行动名称", "objective": "可观测学习目标", '
        '"why_now": "为什么当前阶段先做它", "steps": ["步骤1", "步骤2"], '
        '"deliverable": "本次产出物", "done_criteria": ["验收标准1"], '
        '"prerequisites": ["可选前置条件"], "source_keys": ["S1-C1"], '
        '"concept_ids": ["仅填写上方 confirmed 知识点ID"], '
        '"estimated_mins": 整数, "type": "study|review|practice"}]}\n'
        "  ],\n"
        '  "total_tasks": 整数\n'
        "}"
    )

    result = await ainvoke_structured_checked(
        [HumanMessage(content=prompt)],
        validator=lambda content: _validate_macro_plan_output(
            content,
            kb_mode=kb_mode,
            source_keys=set(source_map),
        ),
        max_tokens=8192,
        temperature=0.3,
        model_kwargs={"response_format": {"type": "json_object"}},
    )
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
    for phase, phase_days in zip(phases, _allocate_phase_days(weights, available_days)):
        phase["days"] = phase_days

    # Normalize the model output into the user-visible execution contract and
    # assign deterministic dates before anything can become an active task.
    normalized_phases: list[dict] = []
    for phase in phases:
        normalized_phases.append(
            {
                "name": compact_text(str(phase.get("name") or "学习阶段"), 40),
                "focus": compact_text(str(phase.get("focus") or ""), 120),
                "days": int(phase.get("days") or 1),
                "tasks": [
                    _normalize_plan_task(task, source_map, concept_map, kb_mode)
                    for task in (phase.get("tasks") or [])
                    if isinstance(task, dict)
                ],
            }
        )
    if not any(phase["tasks"] for phase in normalized_phases):
        raise HTTPException(status_code=502, detail="AI 未生成可执行任务，请重试")

    scheduled = _schedule_plan_phases(normalized_phases, available_dates, goal.daily_hours)
    task_ret_idx = 0
    phases_out = []
    for p in normalized_phases:
        phase_task_list = p.get("tasks") or []
        phase_dates: list[date] = []
        tasks_out = []
        for t in phase_task_list:
            sched = scheduled[task_ret_idx] if task_ret_idx < len(scheduled) else None
            if sched:
                phase_dates.append(sched)
            tasks_out.append({**t, "scheduled_date": sched.isoformat() if sched else ""})
            task_ret_idx += 1
        phases_out.append(
            {
                "name": p["name"],
                "focus": p.get("focus", ""),
                "days": p.get("days", 0),
                "start_date": min(phase_dates).isoformat() if phase_dates else "",
                "end_date": max(phase_dates).isoformat() if phase_dates else "",
                "tasks": tasks_out,
            }
        )

    current_plan = (
        await db.execute(
            select(Plan)
            .where(Plan.goal_id == goal_id, Plan.is_current.is_(True))
            .order_by(Plan.created_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    replacement_count = 0
    if current_plan:
        replacement_count = int(
            await db.scalar(
                select(func.count(Task.id)).where(
                    Task.plan_id == current_plan.id,
                    Task.status.in_(["pending", "in_progress"]),
                )
            )
            or 0
        )
    next_version = (
        int(await db.scalar(select(func.max(Plan.version)).where(Plan.goal_id == goal_id)) or 0) + 1
    )
    estimated_completion_date = scheduled[-1].isoformat() if scheduled else goal.deadline
    source_item_ids = {source["item_id"] for source in source_registry}
    cited_keys = {
        ref["source_key"]
        for phase in phases_out
        for task in phase["tasks"]
        for ref in task["execution_guide"].get("source_refs", [])
    }
    draft_data = {"phases": phases_out, "total_tasks": sum(len(p["tasks"]) for p in phases_out)}
    plan = Plan(
        id=str(uuid.uuid4()),
        goal_id=goal_id,
        version=next_version,
        is_current=False,
        baseline=draft_data,
        content={
            "lifecycle": {
                "status": "draft",
                "kb_mode": kb_mode,
                "pacing_mode": pacing_mode,
                "start_date": available_dates[0].isoformat()
                if available_dates
                else today.isoformat(),
                "estimated_completion_date": estimated_completion_date,
                "source_summary": {
                    "mode": kb_mode,
                    "items_read": len(source_item_ids),
                    "excerpts_read": len(source_registry),
                    "excerpts_cited": len(cited_keys),
                },
                "replacement_summary": {
                    "current_plan_id": current_plan.id if current_plan else None,
                    "pending_tasks_to_replace": replacement_count,
                    "completed_tasks_preserved": True,
                },
            }
        },
        goal_intent_version=goal.intent_version or 1,
        goal_contract_snapshot=dict(goal.contract or {}),
    )
    db.add(plan)
    await emit(
        db,
        user_id=current_user.id,
        goal_id=goal_id,
        aggregate_type="plan",
        aggregate_id=plan.id,
        event_type="MacroPlanDraftGenerated",
        payload={
            "plan_version": plan.version,
            "goal_intent_version": plan.goal_intent_version,
            "task_count": draft_data["total_tasks"],
            "kb_mode": kb_mode,
            "source_items": len(source_item_ids),
            "source_excerpts": len(source_registry),
        },
    )
    await db.commit()
    return _draft_response(plan)


@router.post("/macro-plan/{goal_id}/{plan_id}/confirm")
async def confirm_macro_plan(
    goal_id: str,
    plan_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    goal = (
        await db.execute(select(Goal).where(Goal.id == goal_id, Goal.user_id == current_user.id))
    ).scalar_one_or_none()
    if not goal:
        raise HTTPException(status_code=404, detail="目标不存在")
    plan = (
        await db.execute(select(Plan).where(Plan.id == plan_id, Plan.goal_id == goal_id))
    ).scalar_one_or_none()
    if not plan:
        raise HTTPException(status_code=404, detail="计划草案不存在")
    lifecycle = _plan_lifecycle(plan)
    if lifecycle.get("status") != "draft":
        raise HTTPException(status_code=409, detail="该草案已处理，无法重复采用")
    if (plan.goal_intent_version or 1) != (goal.intent_version or 1):
        raise HTTPException(status_code=409, detail="目标定义已更新，请重新生成计划草案")

    old_plans = (
        (
            await db.execute(
                select(Plan)
                .where(Plan.goal_id == goal_id, Plan.is_current.is_(True))
                .order_by(Plan.created_at.desc())
            )
        )
        .scalars()
        .all()
    )
    expected_current_plan_id = (lifecycle.get("replacement_summary") or {}).get("current_plan_id")
    actual_current_plan_id = old_plans[0].id if old_plans else None
    if expected_current_plan_id != actual_current_plan_id:
        raise HTTPException(status_code=409, detail="当前计划已变化，请重新生成草案后再采用")
    previous_task_states: list[dict] = []
    for old_plan in old_plans:
        old_plan.is_current = False
        old_tasks = (
            (
                await db.execute(
                    select(Task).where(
                        Task.plan_id == old_plan.id,
                        Task.status.in_(["pending", "in_progress"]),
                    )
                )
            )
            .scalars()
            .all()
        )
        for old_task in old_tasks:
            previous_task_states.append({"task_id": old_task.id, "status": old_task.status})
            old_task.status = "abandoned"

    task_count = 0
    created_task_ids: list[str] = []
    for phase in (plan.baseline or {}).get("phases") or []:
        for task_data in phase.get("tasks") or []:
            guide = dict(task_data.get("execution_guide") or {})
            refs = guide.get("source_refs") or []
            task = Task(
                id=str(uuid.uuid4()),
                goal_id=goal_id,
                plan_id=plan.id,
                title=task_data.get("title") or f"任务 {task_count + 1}",
                description=task_data.get("objective") or None,
                estimated_mins=int(task_data.get("estimated_mins") or 30),
                type=task_data.get("type") or "study",
                scheduled_date=task_data.get("scheduled_date") or goal.deadline,
                stage_label=phase.get("name") or None,
                sequence_in_plan=task_count,
                status="pending",
                kb_refs=list(
                    dict.fromkeys(ref.get("item_id") for ref in refs if ref.get("item_id"))
                ),
                execution_guide=guide,
            )
            db.add(task)
            created_task_ids.append(task.id)
            task_count += 1

    plan.is_current = True
    plan.content = {
        **(plan.content or {}),
        "lifecycle": {
            **lifecycle,
            "status": "active",
            "previous_plan_ids": [old_plan.id for old_plan in old_plans],
            "previous_task_states": previous_task_states,
            "activated_at": utc_now().isoformat(),
        },
    }
    await emit(
        db,
        user_id=current_user.id,
        goal_id=goal_id,
        aggregate_type="plan",
        aggregate_id=plan.id,
        event_type="MacroPlanActivated",
        payload={
            "plan_version": plan.version,
            "created_task_ids": created_task_ids,
            "replaced_task_ids": [row["task_id"] for row in previous_task_states],
            "goal_intent_version": plan.goal_intent_version,
        },
    )
    await db.commit()
    # Return the persisted state, not the proposed payload.
    persisted = (
        (
            await db.execute(
                select(Task).where(Task.plan_id == plan.id).order_by(Task.sequence_in_plan)
            )
        )
        .scalars()
        .all()
    )
    return {
        "plan_id": plan.id,
        "status": "active",
        "created_task_ids": [task.id for task in persisted],
        "created_tasks": len(persisted),
        "replaced_tasks": len(previous_task_states),
        "can_undo": True,
    }


@router.post("/macro-plan/{goal_id}/{plan_id}/cancel")
async def cancel_macro_plan_draft(
    goal_id: str,
    plan_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    plan = (
        await db.execute(
            select(Plan)
            .join(Goal, Goal.id == Plan.goal_id)
            .where(
                Plan.id == plan_id,
                Plan.goal_id == goal_id,
                Goal.user_id == current_user.id,
            )
        )
    ).scalar_one_or_none()
    if not plan:
        raise HTTPException(status_code=404, detail="计划草案不存在")
    lifecycle = _plan_lifecycle(plan)
    if lifecycle.get("status") != "draft":
        raise HTTPException(status_code=409, detail="只有未采用的草案可以放弃")
    plan.content = {**(plan.content or {}), "lifecycle": {**lifecycle, "status": "cancelled"}}
    await emit(
        db,
        user_id=current_user.id,
        goal_id=goal_id,
        aggregate_type="plan",
        aggregate_id=plan.id,
        event_type="MacroPlanDraftCancelled",
        payload={"plan_version": plan.version},
    )
    await db.commit()
    return {"plan_id": plan.id, "status": "cancelled"}


@router.post("/macro-plan/{goal_id}/{plan_id}/undo")
async def undo_macro_plan_activation(
    goal_id: str,
    plan_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    plan = (
        await db.execute(
            select(Plan)
            .join(Goal, Goal.id == Plan.goal_id)
            .where(
                Plan.id == plan_id,
                Plan.goal_id == goal_id,
                Goal.user_id == current_user.id,
                Plan.is_current.is_(True),
            )
        )
    ).scalar_one_or_none()
    if not plan:
        raise HTTPException(status_code=404, detail="当前计划不存在")
    lifecycle = _plan_lifecycle(plan)
    if lifecycle.get("status") != "active":
        raise HTTPException(status_code=409, detail="该计划无法撤销")

    new_tasks = (await db.execute(select(Task).where(Task.plan_id == plan.id))).scalars().all()
    for task in new_tasks:
        if task.status != "completed":
            task.status = "abandoned"
    previous_ids = lifecycle.get("previous_plan_ids") or []
    if previous_ids:
        previous_plan = (
            await db.execute(
                select(Plan)
                .where(Plan.id.in_(previous_ids))
                .order_by(Plan.created_at.desc())
                .limit(1)
            )
        ).scalar_one_or_none()
        if previous_plan:
            previous_plan.is_current = True
    previous_states = {
        row["task_id"]: row["status"] for row in lifecycle.get("previous_task_states") or []
    }
    if previous_states:
        previous_tasks = (
            (await db.execute(select(Task).where(Task.id.in_(previous_states)))).scalars().all()
        )
        for task in previous_tasks:
            task.status = previous_states[task.id]
    plan.is_current = False
    plan.content = {
        **(plan.content or {}),
        "lifecycle": {**lifecycle, "status": "undone", "undone_at": utc_now().isoformat()},
    }
    await emit(
        db,
        user_id=current_user.id,
        goal_id=goal_id,
        aggregate_type="plan",
        aggregate_id=plan.id,
        event_type="MacroPlanActivationUndone",
        payload={
            "restored_plan_ids": previous_ids,
            "restored_task_ids": list(previous_states),
        },
    )
    await db.commit()
    return {
        "plan_id": plan.id,
        "status": "undone",
        "restored_plan_id": previous_ids[-1] if previous_ids else None,
        "restored_tasks": len(previous_states),
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
    llm = create_interactive_llm(temperature=0.3)
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


async def _upsert_brief_cache(
    user_id: str, db: AsyncSession, brief_dict: dict, generated_by: str
) -> None:
    today = date.today().isoformat()
    bind = db.get_bind()

    if bind.dialect.name == "postgresql":
        from sqlalchemy.dialects.postgresql import insert as pg_insert

        stmt = (
            pg_insert(DailyBriefCache)
            .values(
                id=str(uuid.uuid4()),
                user_id=user_id,
                date=today,
                content=brief_dict,
                is_read=False,
                generated_by=generated_by,
            )
            .on_conflict_do_update(
                constraint="uq_daily_brief_cache_user_date",
                set_={
                    "content": brief_dict,
                    "generated_by": generated_by,
                    "generated_at": utc_now(),
                },
            )
        )
        await db.execute(stmt)
    else:
        cached = (
            await db.execute(
                select(DailyBriefCache).where(
                    DailyBriefCache.user_id == user_id,
                    DailyBriefCache.date == today,
                )
            )
        ).scalar_one_or_none()
        if cached:
            cached.content = brief_dict
            cached.generated_by = generated_by
            cached.generated_at = utc_now()
        else:
            db.add(
                DailyBriefCache(
                    id=str(uuid.uuid4()),
                    user_id=user_id,
                    date=today,
                    content=brief_dict,
                    is_read=False,
                    generated_by=generated_by,
                )
            )
    await db.commit()


async def _build_daily_brief_for_user(
    user_id: str, db: AsyncSession, count: int = 3
) -> dict | None:
    today = date.today().isoformat()
    yesterday = (date.today() - timedelta(days=1)).isoformat()
    seven_days_ago = (date.today() - timedelta(days=7)).isoformat()

    recent_checkins = (
        (
            await db.execute(
                select(CheckinRecord)
                .where(
                    CheckinRecord.user_id == user_id,
                    CheckinRecord.date >= seven_days_ago,
                    CheckinRecord.mode != "natural",
                )
                .order_by(CheckinRecord.date.desc())
            )
        )
        .scalars()
        .all()
    )

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
    yesterday_tasks = (
        (
            await db.execute(
                select(Task)
                .join(Goal, Task.goal_id == Goal.id)
                .where(
                    Goal.user_id == user_id,
                    Task.scheduled_date == yesterday,
                    Task.status == "completed",
                )
                .limit(15)
            )
        )
        .scalars()
        .all()
    )

    # 所有活跃目标（复习题覆盖全部目标，不限于昨天）
    active_goals = (
        (await db.execute(select(Goal).where(Goal.user_id == user_id, Goal.status == "active")))
        .scalars()
        .all()
    )

    # 今日任务统计
    today_tasks = (
        (
            await db.execute(
                select(Task)
                .join(Goal, Task.goal_id == Goal.id)
                .where(Goal.user_id == user_id, Task.scheduled_date == today)
            )
        )
        .scalars()
        .all()
    )
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
        summary += (
            "，表现优秀！"
            if avg_rate >= 0.8
            else "，继续加油！"
            if avg_rate >= 0.5
            else "，注意调整节奏。"
        )

    # 构建 goalReviews
    goal_reviews: list[GoalReview] = []
    for goal in active_goals:
        recent_tasks = (
            (
                await db.execute(
                    select(Task)
                    .where(
                        Task.goal_id == goal.id,
                        Task.status == "completed",
                        Task.scheduled_date >= seven_days_ago,
                    )
                    .order_by(Task.scheduled_date.desc())
                    .limit(5)
                )
            )
            .scalars()
            .all()
        )
        if not recent_tasks:
            continue
        kb_items = (
            (
                await db.execute(
                    select(KnowledgeItem)
                    .where(
                        or_(
                            KnowledgeItem.goal_id == goal.id,
                            KnowledgeItem.goal_links.any(KnowledgeItemGoalLink.goal_id == goal.id),
                        ),
                        KnowledgeItem.source_type != "chat_note",
                    )
                    .limit(2)
                )
            )
            .scalars()
            .all()
        )
        effective_count = min(count, max(1, len(recent_tasks)))
        try:
            questions = await _generate_review_questions(
                goal.title, recent_tasks, kb_items, effective_count
            )
        except Exception:
            questions = _fallback_questions(recent_tasks)
        goal_reviews.append(
            GoalReview(
                goalId=goal.id,
                goalTitle=goal.title,
                questions=questions,
            )
        )

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
        cached = (
            await db.execute(
                select(DailyBriefCache).where(
                    DailyBriefCache.user_id == current_user.id,
                    DailyBriefCache.date == today,
                )
            )
        ).scalar_one_or_none()
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

    goal_tasks = (
        (
            await db.execute(
                select(Task)
                .where(
                    Task.goal_id == goal_id,
                    Task.status == "completed",
                    Task.scheduled_date >= seven_days_ago,
                )
                .order_by(Task.scheduled_date.desc())
                .limit(5)
            )
        )
        .scalars()
        .all()
    )

    if not goal_tasks:
        return None

    kb_items = (
        (
            await db.execute(
                select(KnowledgeItem)
                .where(
                    or_(
                        KnowledgeItem.goal_id == goal_id,
                        KnowledgeItem.goal_links.any(KnowledgeItemGoalLink.goal_id == goal_id),
                    ),
                    KnowledgeItem.source_type != "chat_note",
                )
                .limit(2)
            )
        )
        .scalars()
        .all()
    )

    try:
        questions = await _generate_review_questions(
            goal.title, list(goal_tasks), list(kb_items), count
        )
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
    task = (
        await db.execute(
            select(Task)
            .join(Goal, Task.goal_id == Goal.id)
            .where(
                Task.id == body.task_id,
                Goal.user_id == current_user.id,
            )
        )
    ).scalar_one_or_none()
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在")

    guide = dict(task.execution_guide or {})
    source_context = "\n".join(
        f"- {ref.get('locator', ref.get('item_title', '参考资料'))}：{ref.get('snippet', '')}"
        for ref in (guide.get("source_refs") or [])[:4]
    )
    task_notes = (
        (
            await db.execute(
                select(KnowledgeItem)
                .where(
                    KnowledgeItem.user_id == current_user.id,
                    KnowledgeItem.task_id == task.id,
                )
                .order_by(KnowledgeItem.updated_at.desc())
                .limit(3)
            )
        )
        .scalars()
        .all()
    )
    note_context = "\n".join(
        f"- {note.title}：{_compact_plan_source_text(note.normalized_content or note.content, 500)}"
        for note in task_notes
    )

    prompt = (
        f"学习者刚完成了任务「{task.title}」。\n\n"
        f"任务目标：{task.description or guide.get('deliverable', '')}\n"
        f"任务产出：{guide.get('deliverable', '')}\n"
        f"验收标准：{json.dumps(guide.get('done_criteria') or [], ensure_ascii=False)}\n"
        + (f"引用资料：\n{source_context}\n" if source_context else "")
        + (f"学习者笔记：\n{note_context}\n" if note_context else "")
        + "\n"
        "请生成一道深度检验理解的题目，以及该题目的参考答案要点。\n"
        "要求：\n"
        "- 问题聚焦原理理解、应用场景或知识间的联系，而非可以直接搜索到的事实\n"
        "- 参考答案列出3-5个核心要点，每个要点一行，供学习者自我对照\n\n"
        "严格按以下JSON格式输出，不加任何额外内容：\n"
        '{"question": "问题内容", "answer_hint": "要点1\\n要点2\\n要点3"}'
    )
    result = await ainvoke_structured_checked(
        [HumanMessage(content=prompt)],
        validator=require_json_object,
        max_tokens=500,
        model_kwargs={"response_format": {"type": "json_object"}},
    )
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
    task = (
        await db.execute(
            select(Task)
            .join(Goal, Task.goal_id == Goal.id)
            .where(
                Task.id == body.task_id,
                Goal.user_id == current_user.id,
            )
        )
    ).scalar_one_or_none()
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在")

    question = _verify_cache.get(
        f"{current_user.id}:{body.task_id}",
        f"谈谈你对「{task.title}」的理解",
    )

    guide = dict(task.execution_guide or {})
    source_context = "\n".join(
        f"- {ref.get('locator', ref.get('item_title', '参考资料'))}：{ref.get('snippet', '')}"
        for ref in (guide.get("source_refs") or [])[:4]
    )
    task_notes = (
        (
            await db.execute(
                select(KnowledgeItem)
                .where(
                    KnowledgeItem.user_id == current_user.id,
                    KnowledgeItem.task_id == task.id,
                )
                .order_by(KnowledgeItem.updated_at.desc())
                .limit(3)
            )
        )
        .scalars()
        .all()
    )
    note_context = "\n".join(
        f"- {note.title}：{_compact_plan_source_text(note.normalized_content or note.content, 500)}"
        for note in task_notes
    )

    llm = create_critical_llm(max_tokens=700)
    eval_prompt = (
        f"任务：「{task.title}」\n"
        f"任务目标：{task.description or ''}\n"
        f"任务产出：{guide.get('deliverable', '')}\n"
        f"验收标准：{json.dumps(guide.get('done_criteria') or [], ensure_ascii=False)}\n"
        + (f"引用资料：\n{source_context}\n" if source_context else "")
        + (f"学习者笔记：\n{note_context}\n" if note_context else "")
        + f"考查问题：{question}\n"
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

    assessment_key = hashlib.sha256(
        f"{current_user.id}:{task.id}:{question}:{body.answer}".encode("utf-8")
    ).hexdigest()
    await emit(
        db,
        user_id=current_user.id,
        goal_id=task.goal_id,
        aggregate_type="mastery_assessment",
        aggregate_id=task.id,
        event_type="MasteryAssessmentSubmitted",
        payload={
            "task_id": task.id,
            "evidence_type": "explanation",
            "score": score,
            "passed": passed,
            "contains_user_content": False,
        },
        idempotency_key=f"verification-assessment:{assessment_key}",
    )

    if passed:
        mastery_level = "L3" if score < 90 else "L4"
        evidence_key = assessment_key
        evidence_idempotency_key = f"verification-evidence:{evidence_key}"
        existing_evidence = await db.scalar(
            select(LearningEvent).where(LearningEvent.idempotency_key == evidence_idempotency_key)
        )
        previous_level = task.mastery_level
        task.mastery_level = mastery_level
        if existing_evidence is None:
            await emit(
                db,
                user_id=current_user.id,
                goal_id=task.goal_id,
                aggregate_type="task",
                aggregate_id=task.id,
                event_type="MasteryRecorded",
                payload={
                    "task_title": task.title,
                    "from_level": previous_level,
                    "to_level": mastery_level,
                    "submission_mode": "verification",
                    "score": score,
                    "aggregate_version": task.version + 1,
                },
                idempotency_key=f"verification-mastery:{evidence_key}",
            )
            await emit(
                db,
                user_id=current_user.id,
                goal_id=task.goal_id,
                aggregate_type="mastery_evidence",
                aggregate_id=task.id,
                event_type="MasteryEvidenceAdded",
                payload={
                    "task_id": task.id,
                    "evidence_type": "explanation",
                    "quality": "model_scored",
                    "score": score,
                    "passed": True,
                    "mastery_level": mastery_level,
                    "contains_user_content": False,
                },
                idempotency_key=evidence_idempotency_key,
            )
            db.add(
                TaskMasteryRecord(
                    task_id=task.id,
                    goal_id=task.goal_id,
                    user_id=current_user.id,
                    mastery_level=mastery_level,
                    source="ai_assessment",
                    notes=f"verification_score={score}",
                )
            )
            await KnowledgeGraphService.record_task_evidence(
                db,
                current_user.id,
                goal_id=task.goal_id,
                task_id=task.id,
                execution_guide=guide,
                score=score / 100,
                evidence_source="verification",
                evidence_type="explanation_assessment",
                summary=f"回答掌握检验题，评分 {score}/100",
            )
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
    goals = (
        (
            await db.execute(
                select(Goal).where(Goal.user_id == current_user.id, Goal.status == "active")
            )
        )
        .scalars()
        .all()
    )
    if not goals:
        return []

    today = date.today().isoformat()
    week_ago = (date.today() - timedelta(days=7)).isoformat()

    # 路由器内部负责本地优先与 Flash 自动回退。
    result: list[GoalDailyPlan] = []

    for goal in goals:
        daily_hours = float(goal.daily_hours or 1.0)

        # 最近7天 checkin
        checkins = (
            (
                await db.execute(
                    select(CheckinRecord)
                    .where(CheckinRecord.goal_id == goal.id, CheckinRecord.date >= week_ago)
                    .order_by(CheckinRecord.date.desc())
                )
            )
            .scalars()
            .all()
        )

        # pending 任务（含过期）
        pending_tasks = (
            (
                await db.execute(
                    select(Task)
                    .where(Task.goal_id == goal.id, Task.status.in_(["pending", "partial"]))
                    .order_by(Task.scheduled_date, Task.created_at)
                    .limit(20)
                )
            )
            .scalars()
            .all()
        )

        # mastery=basic 的任务（需复习）
        weak_tasks = (
            (
                await db.execute(
                    select(Task)
                    .where(Task.goal_id == goal.id, Task.mastery_level == "L2")
                    .order_by(Task.created_at.desc())
                    .limit(10)
                )
            )
            .scalars()
            .all()
        )

        checkin_summary = (
            "\n".join(f"- {c.date}: 完成度{round(c.completion_rate * 100)}%" for c in checkins)
            or "本周暂无打卡记录"
        )

        pending_summary = (
            "\n".join(
                f"- [{t.id}] {t.title} (scheduled:{t.scheduled_date}, priority:{t.priority}, mastery:{t.mastery_level or 'unknown'})"
                for t in pending_tasks
            )
            or "无待完成任务"
        )

        weak_summary = "\n".join(f"- [{t.id}] {t.title}" for t in weak_tasks) or "无"

        budget_mins = int(daily_hours * 60)

        try:
            days_remaining = (date.fromisoformat(goal.deadline) - date.today()).days
        except (ValueError, TypeError):
            days_remaining = 999
        urgency_label = (
            "极高（≤7天）"
            if days_remaining <= 7
            else "高（≤30天）"
            if days_remaining <= 30
            else "中（≤90天）"
            if days_remaining <= 90
            else "低"
        )

        overdue_count = sum(
            1 for t in pending_tasks if t.scheduled_date and t.scheduled_date < today
        )
        eff_hours = max(daily_hours, 0.5)  # 防止 daily_hours=0 导致除零
        pressure_score = round((overdue_count * 2 + len(pending_tasks)) / eff_hours, 1)
        pressure_label = (
            "极高风险"
            if pressure_score >= 4
            else "高风险"
            if pressure_score >= 2
            else "中等"
            if pressure_score >= 1
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
        try:
            res = await ainvoke_structured_checked(
                [HumanMessage(content=prompt)],
                validator=require_json_array,
                temperature=0.3,
            )
            raw = res.content.strip()
            start, end = raw.find("["), raw.rfind("]") + 1
            suggestions = [DailyTaskSuggestion(**s) for s in json.loads(raw[start:end])]
        except Exception:
            logger.exception("每日任务模型调用失败 goal_id=%s", goal.id)

        result.append(
            GoalDailyPlan(
                goal_id=goal.id,
                goal_title=goal.title,
                daily_hours=daily_hours,
                tasks=suggestions,
            )
        )

    return result


# ── Note Assist ──────────────────────────────────────────────


class NoteAssistRequest(BaseModel):
    command: str  # summarize | expand | quiz | checklist
    context: str = ""  # 用户选中的文字或空
    goal_id: str | None = None


@router.post("/note-assist")
async def note_assist(
    body: NoteAssistRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    goal_ctx = ""
    if body.goal_id:
        goal = (
            await db.execute(
                select(Goal).where(Goal.id == body.goal_id, Goal.user_id == current_user.id)
            )
        ).scalar_one_or_none()
        if goal:
            recent_tasks = (
                (
                    await db.execute(
                        select(Task)
                        .where(Task.goal_id == goal.id)
                        .order_by(Task.scheduled_date.desc())
                        .limit(5)
                    )
                )
                .scalars()
                .all()
            )
            task_titles = "、".join(t.title for t in recent_tasks)
            goal_ctx = f"学习目标：{goal.title}。近期任务：{task_titles}。"

    prompts = {
        "summarize": f"{goal_ctx}请用 3-5 句话总结上述学习内容的核心要点，输出简洁的 Markdown 列表。",
        "expand": f"{goal_ctx}请对以下内容进行展开说明，补充关键细节和示例：\n{body.context}",
        "quiz": f"{goal_ctx}请根据上述学习内容，生成 3 道有深度的思考题（含参考答案要点），用 Markdown 格式输出。",
        "checklist": f"{goal_ctx}请将以下内容整理成可操作的任务清单（Markdown 任务列表格式）：\n{body.context}",
    }
    prompt_text = prompts.get(body.command, prompts["summarize"])

    llm = create_interactive_llm(
        max_tokens=600,
        temperature=0.7,
    )
    resp = await llm.ainvoke([HumanMessage(content=prompt_text)])
    return {"content": resp.content}
