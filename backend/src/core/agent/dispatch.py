"""Deterministic routing between the conversation and action agents.

Only capabilities that the current action tool registry can complete reliably
are routed to a durable run. Ambiguous requests remain conversational so the
assistant can clarify them without creating abandoned approval records.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Literal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.agent_v2.schemas import ActionEntityRef, ActionIntent, NeedFrame
from src.core.time import local_date_for_timezone, utc_now
from src.events.publisher import emit
from src.models import Goal, PendingActionIntent, Task, User

AgentMode = Literal["conversation", "action"]
SpeechActRoute = Literal["conversation", "preview", "continue"]


@dataclass(frozen=True)
class AgentDispatchDecision:
    mode: AgentMode
    capability: str
    reason: str


@dataclass(frozen=True)
class SpeechActGuard:
    route: SpeechActRoute
    reason: str


_DISCUSSION_CUES = (
    "怎么",
    "如何",
    "怎么理解",
    "如何理解",
    "为什么",
    "解释",
    "讲一下",
    "说说",
    "思路",
    "建议",
)

_TASK_MUTATION_CUES = (
    "新建任务",
    "新增任务",
    "创建任务",
    "添加任务",
    "加任务",
    "删除任务",
    "删掉任务",
    "移除任务",
    "完成任务",
    "标记完成",
    "记成完成",
    "勾掉",
    "搞定",
    "删前",
    "不留了",
    "标完成预览",
    "记作已完成",
    "走确认链",
)

_TASK_MOVE_CUES = (
    "重新安排",
    "重新排期",
    "重新排",
    "重排",
    "改到",
    "移到",
    "挪到",
    "移动",
    "改去",
    "延两天",
    "往后挪",
)


def _normalize_action_text(message: str) -> str:
    normalized = " ".join(message.strip().split())
    # Keep this deliberately small and audited: it influences whether a durable
    # action is proposed, so broad fuzzy correction would be unsafe.
    return normalized.replace("任物", "任务").replace("排其", "排期")


def _is_natural_checkin_report(message: str) -> bool:
    """Separate progress reports from commands targeting a concrete task entity."""
    has_progress_report = bool(
        re.search(
            r"(?:今天|今日).{0,30}(?:完成了|做了|学了|学习了|没完成|未完成|完成(?:了)?[一二两三四五六七八九十\d]+项)",
            message,
        )
        or re.search(r"(?:打个卡|打卡|汇报(?:一下)?进度|记录一下).{0,20}$", message)
    )
    if not has_progress_report:
        return False
    has_explicit_entity = bool(_quoted_title(message))
    has_mutation_command = bool(
        re.search(
            r"(?:把|将).{1,80}(?:标记完成|标完成|记成完成|勾掉)", message
        )
        or re.search(r"(?:帮我|请|给我).{0,10}(?:标记完成|标完成|记成完成|勾掉)", message)
    )
    return not (has_explicit_entity or has_mutation_command)


def classify_action_speech_act(message: str) -> SpeechActGuard:
    """Apply one compositional speech-act boundary before capability routing.

    Preview requests may describe a proposed write but are still non-writing
    until approval.  Analysis, hypothetical, and pure-question requests remain
    conversational unless they explicitly request such a preview artifact.
    """
    preview_artifacts = (
        "预览",
        "草案",
        "变更方案",
        "调整方案",
        "调整预览",
        "差异预览",
        "逐项变更",
    )
    preview_request_cues = (
        "生成",
        "给出",
        "先看",
        "只给",
        "先给",
        "展示",
        "产出",
        "输出",
        "创建",
        "列出",
        "亮出",
        "让我审",
        "先让我审",
    )
    has_preview_artifact = any(cue in message for cue in preview_artifacts)
    negates_preview_creation = any(
        cue in message
        for cue in ("不要生成变更", "不要生成预览", "不要生成草案", "禁止创建行动", "不要创建行动")
    )
    explicitly_requests_preview = has_preview_artifact and any(
        cue in message for cue in preview_request_cues
    ) and not negates_preview_creation
    if explicitly_requests_preview:
        return SpeechActGuard("preview", "explicit_preview_requested")

    analysis_only = any(
        cue in message
        for cue in (
            "只分析",
            "只解释",
            "只说明",
            "只告诉影响",
            "只说影响",
            "想了解",
            "分析影响",
        )
    )
    prohibits_action = any(
        cue in message
        for cue in (
            "不要生成变更",
            "禁止创建行动",
            "不要创建行动",
            "不要执行",
            "不执行",
            "无需执行",
            "只分析不要执行",
        )
    ) or bool(
        re.search(
            r"(?:先不要|暂时不|无需|不需要|不要(?!了)|别(?:再)?)[^，,。；;]{0,12}"
            r"(?:新建|新增|创建|添加|删除|删掉|清掉|移除|完成|重排|重新安排|改到|移到|挪到|减负|走确认链)",
            message,
        )
    )
    if analysis_only or prohibits_action:
        return SpeechActGuard("conversation", "analysis_or_execution_prohibited")

    hypothetical = any(cue in message for cue in ("如果", "假如", "假设", "要是"))
    pure_question = any(cue in message for cue in ("能不能", "可不可以", "是否可以")) or bool(
        re.search(r"(?:清掉|删除|移除|完成|重排|减负|走确认链).{0,12}(?:吗|么|？|\?)", message)
    )
    if hypothetical or pure_question:
        return SpeechActGuard("conversation", "hypothetical_or_pure_question")
    return SpeechActGuard("continue", "no_speech_act_guard")


def classify_agent_request(message: str) -> AgentDispatchDecision:
    normalized = _normalize_action_text(message)
    if not normalized:
        return AgentDispatchDecision("conversation", "chat", "empty_message")

    if _is_natural_checkin_report(normalized):
        return AgentDispatchDecision("conversation", "chat", "natural_checkin_report")

    speech_act = classify_action_speech_act(normalized)
    if speech_act.route == "conversation":
        return AgentDispatchDecision("conversation", "chat", speech_act.reason)

    asks_for_discussion = any(cue in normalized for cue in _DISCUSSION_CUES)
    explicit_preview = speech_act.route == "preview"

    if (
        any(term in normalized for term in ("负荷", "任务量", "减量", "减负", "砍点量", "每天最多", "只扛得住", "每天二十分钟"))
        and any(term in normalized for term in ("降下来", "减少", "减到", "减量", "砍", "能降", "最多", "扛得住"))
    ) or (
        any(term in normalized for term in ("减负", "降负荷", "降低负荷"))
        and any(term in normalized for term in ("草案", "预览", "变更"))
    ) or (
        any(term in normalized for term in ("调整方案", "调整草案", "草案", "方案"))
        and any(term in normalized for term in ("预览", "确认", "编辑", "删改", "取消", "可能", "再批"))
    ):
        return AgentDispatchDecision("action", "reschedule_overdue", "explicit_load_adjustment")

    overdue_terms = ("逾期", "过期", "积压", "欠项", "旧欠项", "欠下", "欠着", "欠账")
    if any(term in normalized for term in overdue_terms) and any(
        cue in normalized for cue in _TASK_MOVE_CUES
    ) or (
        any(term in normalized for term in overdue_terms)
        and any(term in normalized for term in ("摊开", "摊到", "重排", "批量", "按容量", "新日期", "差异预览"))
    ) or (
        "批量排期" in normalized and any(term in normalized for term in ("逐项变更", "预览", "调整"))
    ) or (
        any(term in normalized for term in ("这个目标", "当前目标", "目标"))
        and any(
            term in normalized
            for term in ("调整预览", "调整方案", "未来一周", "未来七天", "逐项变更预览")
        )
        and any(term in normalized for term in ("生成", "产出", "给", "创建", "停在审批", "确认"))
    ):
        if asks_for_discussion and not explicit_preview:
            return AgentDispatchDecision("conversation", "chat", "discussion_over_reschedule")
        return AgentDispatchDecision("action", "reschedule_overdue", "explicit_reschedule")

    natural_task_mutation = any(
        re.search(pattern, normalized)
        for pattern in (
            r"(?:新建|新增|创建|添加|加)(?:一个|一项)?.{0,80}任务",
            r"(?:删除|删掉|移除|完成|标记完成).{0,120}(?:任务|不要了)",
            r"(?:删除|删掉|移除).{0,120}(?:影响|先告诉)",
            r"(?:这个|该).{1,80}(?:不要了|删掉|删除|完成)",
            r"(?:^|[：:。；;])\s*完成\s+.{1,80}(?:[。.!！]|$)",
            r".{1,80}(?:已经)?做完了.{0,20}(?:标记完成|完成)",
            r".{1,100}(?:搞定啦|勾掉|记成完成|按流程标完成)",
            r".{1,100}(?:收尾|记作已完成|做完).{0,30}(?:标完成预览|确认链|先确认)",
            r".{1,100}(?:我不留了|删前|删掉吧|想移除)",
            r"(?:添一项|加个).{1,80}(?:待办|复习)",
            r"(?:给|帮我给).{1,80}(?:记一条|添一项).{1,80}(?:先(?:让我)?审|先展示|预览)",
            r"(?:移除|清掉).{1,100}(?:风险|恢复|预览|别写)",
        )
    )
    if any(cue in normalized for cue in _TASK_MUTATION_CUES) or natural_task_mutation:
        if asks_for_discussion and not explicit_preview:
            return AgentDispatchDecision("conversation", "chat", "discussion_over_mutation")
        return AgentDispatchDecision("action", "task_mutation", "explicit_task_mutation")

    if "想移除" in normalized or ("高风险预览" in normalized and "移除" in normalized):
        return AgentDispatchDecision("action", "task_mutation", "explicit_task_mutation")

    has_task_object = "任务" in normalized
    if has_task_object and any(cue in normalized for cue in _TASK_MOVE_CUES):
        if asks_for_discussion and not explicit_preview:
            return AgentDispatchDecision("conversation", "chat", "discussion_over_reschedule")
        return AgentDispatchDecision("action", "task_mutation", "explicit_task_move")

    if re.search(
        r"(?:把|将)\s*(?:它|这个|那个|这项|那项)\s*(?:改到|移到|挪到)",
        normalized,
    ):
        return AgentDispatchDecision("conversation", "chat", "unresolved_task_reference")
    if re.search(r"(?:把|将)\s*.{1,120}(?:改到|移到|挪到)", normalized):
        return AgentDispatchDecision("action", "task_mutation", "explicit_task_move")
    if re.search(r".{1,120}(?:今天悬了|(?:改去|放到)(?:明天|后天|大后天)|延两天|往后挪)", normalized):
        return AgentDispatchDecision("action", "task_mutation", "explicit_task_move")
    if re.search(r".{1,120}(?:赶不上|延到周[一二三四五六日天])", normalized):
        return AgentDispatchDecision("action", "task_mutation", "explicit_task_move")

    return AgentDispatchDecision("conversation", "chat", "no_supported_action")


def _quoted_title(message: str) -> str | None:
    match = re.search(r"[“\"]([^”\"]+)[”\"]", message)
    return match.group(1).strip() if match else None


def _extract_task_title(message: str) -> str | None:
    """Extract an explicit task reference from common natural-language forms.

    Quoted titles remain preferred. The fallback only accepts bounded command
    phrases and strips date/duration scaffolding; it does not fuzzy-match or
    choose among database rows. Ambiguous matches are still rejected below.
    """
    quoted = _quoted_title(message)
    if quoted:
        return quoted
    create = re.search(
        r"(?:新建|新增|创建|添加|加|添)(?:一个|一项|个)?\s*"
        r"(?:(?:今天|明天|明日|明儿|后天)\s*)?(?:(?:半小时|\d+\s*(?:分钟|小时))\s*(?:的)?\s*)?"
        r"(.+?)(?:任务)(?:[，,。]|$)",
        message,
    )
    if create:
        return create.group(1).strip(' "“”') or None
    create_todo = re.search(
        r"(?:添一项|加个)[:：]?\s*(?:(?:今天|明天|明日|明儿|后天)\s*)?"
        r"(?:(?:半小时|\d+\s*(?:分钟|小时))\s*)?(.+?)(?:的)?(?:待办|[，,。]|$)",
        message,
    )
    if create_todo:
        value = re.sub(
            r"(?:三十分钟|半小时|\d+\s*(?:分钟|小时))$", "", create_todo.group(1)
        ).strip(' "“”')
        return value or None
    recorded = re.search(
        r"(?:给|帮我给).+?记一条\s*(?:(?:今天|明天|明早|后天|周末)\s*)?"
        r"(?:(?:[一二两三四五六七八九十\d]+)\s*分钟(?:的)?\s*)?"
        r"(.+?)(?:[，,。]|先(?:让我)?审|先展示|$)",
        message,
    )
    if recorded:
        return recorded.group(1).strip(' "“”') or None
    weekend_create = re.search(
        r"(?:想)?添一项\s*(?:周末\s*)?(.+?)(?:[，,。]|先展示|先审|$)", message
    )
    if weekend_create:
        return weekend_create.group(1).strip(' "“”') or None
    suffixed_duration = re.search(
        r"添一项[:：]?\s*(?:(?:今天|明天|明日|明儿|后天)\s*)?"
        r"(.+?)(?:三十分钟|半小时|\d+\s*分钟)(?:[，,。]|$)",
        message,
    )
    if suffixed_duration:
        return suffixed_duration.group(1).strip(' "“”') or None
    colon_create = re.search(
        r"(?:新建|新增|创建|添加|加)任务\s*[:：]\s*"
        r"(?:(?:今天|明天|后天)\s*)?(?:\d+\s*(?:分钟|小时)\s*)?"
        r"(.+?)(?:半小时|一小时|\d+\s*分钟|\d+\s*小时|[。.!！]|$)",
        message,
    )
    if colon_create:
        return colon_create.group(1).strip(' "“”') or None
    move = re.search(r"(?:^|[：:。；;])\s*(?:把|将)\s*(.+?)\s*(?:改到|移到|挪到)", message)
    if move:
        return move.group(1).strip(' "“”') or None
    completed = re.search(
        r"[：:。；;]\s*([^：:。；;]+?)\s*(?:已经)?做完了(?:[，,].*)?(?:[。.!！]|$)",
        message,
    ) or re.search(r"^\s*(.+?)\s*(?:已经)?做完了(?:[，,].*)?(?:[。.!！]|$)", message)
    if completed:
        return completed.group(1).strip(' "“”') or None
    direct = re.search(
        r"(?:^|[：:。；;])\s*(?:把|删除|删掉|移除|完成|标记完成)\s*(?:这个|该)?\s*"
        r"(.+?)(?:\s*(?:不要了|删掉|删除|完成|标记完成)|[，,。]|$)",
        message,
    )
    if not direct:
        direct = re.search(r"(?:这个|该)\s*(.+?)\s*不要了", message)
    if direct:
        value = direct.group(1).strip(' "“”')
        return value.removesuffix("任务").strip() or None
    return None


def _requested_date(message: str, today: date) -> str | None:
    match = re.search(r"(20\d{2}-\d{2}-\d{2})", message)
    if match:
        try:
            return date.fromisoformat(match.group(1)).isoformat()
        except ValueError:
            return None
    if "大后天" in message:
        return (today + timedelta(days=3)).isoformat()
    if any(term in message for term in ("明天", "明日", "明儿", "明早")):
        return (today + timedelta(days=1)).isoformat()
    if "后天" in message:
        return (today + timedelta(days=2)).isoformat()
    if "今天" in message:
        return today.isoformat()
    if "延两天" in message:
        return (today + timedelta(days=2)).isoformat()
    weekday_match = re.search(r"(?:周|星期)([一二三四五六日天])", message)
    if weekday_match:
        weekday = {"一": 0, "二": 1, "三": 2, "四": 3, "五": 4, "六": 5, "日": 6, "天": 6}[weekday_match.group(1)]
        days = (weekday - today.weekday()) % 7
        return (today + timedelta(days=days or 7)).isoformat()
    return None


def _requested_effect(
    message: str,
) -> Literal["create", "update", "complete", "delete", "reschedule"]:
    if (
        any(term in message for term in ("删除任务", "删掉任务", "移除任务", "删掉吧", "想移除", "不留了", "移除", "清掉"))
        or re.search(
            r"(?:删掉|删除|移除).{0,120}(?:不要了|删掉|删除|影响|先告诉)(?:[。.!！?？]|$)",
            message,
        )
        or re.search(r"(?:这个|该).{1,120}不要了", message)
    ):
        return "delete"
    if any(term in message for term in ("完成任务", "标记完成", "记成完成", "记作已完成", "做完了", "搞定啦", "勾掉", "标完成", "收尾", "确认链")) or re.search(
        r"(?:完成|做完).{0,80}(?:任务)?(?:[。.!！]|$)", message
    ):
        return "complete"
    if any(
        term in message for term in ("新建任务", "新增任务", "创建任务", "添加任务")
    ) or "添一项" in message or "记一条" in message or re.search(r"(?:新建|新增|创建|添加|加|添)(?:一个|一项|个)?.{0,50}(?:任务|待办)", message):
        return "create"
    if any(term in message for term in ("逾期", "过期", "积压", "欠项", "旧欠项", "欠下", "欠着", "欠账", "负荷", "任务量", "减量", "减负", "砍点量", "每天最多", "每天二十分钟", "批量排期", "可编辑方案", "调整方案", "调整预览", "调整草案", "草案")):
        return "reschedule"
    return "update"


async def resolve_action_intent(
    db: AsyncSession,
    *,
    user_id: str,
    message: str,
    goal_id: str | None,
    source: Literal["pilo", "insight", "api", "scheduler"] = "pilo",
) -> ActionIntent | None:
    message = _normalize_action_text(message)
    decision = classify_agent_request(message)
    if decision.mode != "action":
        return None
    # Capability routing owns the broad action family. In particular,
    # “过期未完成任务” contains the substring “完成任务” but is a batch
    # reschedule request, not a completion command.
    effect = (
        "reschedule"
        if decision.capability == "reschedule_overdue"
        else _requested_effect(message)
    )
    missing: list[str] = []
    refs: list[ActionEntityRef] = []
    constraints: dict[str, object] = {}
    user = await db.get(User, user_id)
    today = local_date_for_timezone(user.timezone if user else "UTC")

    if goal_id:
        goal = await db.scalar(select(Goal).where(Goal.id == goal_id, Goal.user_id == user_id))
        if goal is None:
            missing.append("goal")
        else:
            refs.append(ActionEntityRef(entity="goal", entity_id=goal.id, label=goal.title))

    title = _extract_task_title(message)
    requested_date = _requested_date(message, today)
    if requested_date:
        constraints["scheduled_date"] = requested_date

    if effect == "create":
        if not goal_id:
            missing.append("goal")
        if not title:
            missing.append("task_title")
        else:
            constraints["task_title"] = title
        if not requested_date:
            missing.append("scheduled_date")
    elif effect == "reschedule" and decision.capability == "reschedule_overdue":
        if not goal_id:
            missing.append("goal")
        else:
            constraints["overdue_only"] = True
            constraints["requested_scope"] = "goal"
    elif effect in {"delete", "complete", "update"}:
        rows = []
        if title:
            global_statement = (
                select(Task, Goal)
                .join(Goal, Task.goal_id == Goal.id)
                .where(Goal.user_id == user_id, Task.title == title)
            )
            statement = global_statement
            if goal_id:
                statement = statement.where(Task.goal_id == goal_id)
            rows = (await db.execute(statement)).all()
            # The UI commonly supplies the currently active goal as context even when
            # the user names a unique task owned by another goal.  The explicit entity
            # must win when it is globally unambiguous; duplicate titles still require
            # a clarification instead of silently crossing goal scope.
            if not rows and goal_id:
                global_rows = (await db.execute(global_statement)).all()
                if len(global_rows) == 1:
                    rows = global_rows
        if not rows:
            visible_tasks = list(
                (
                    await db.execute(
                        select(Task, Goal)
                        .join(Goal, Task.goal_id == Goal.id)
                        .where(Goal.user_id == user_id)
                        .where(Task.goal_id == goal_id if goal_id else True)
                    )
                ).all()
            )
            contained_titles = {
                task.title for task, _goal in visible_tasks if task.title and task.title in message
            }
            if contained_titles:
                longest = max(len(item) for item in contained_titles)
                best_titles = {item for item in contained_titles if len(item) == longest}
                rows = [row for row in visible_tasks if row[0].title in best_titles]
                title = next(iter(best_titles)) if len(best_titles) == 1 else None
        if not title and not rows:
            missing.append("task_title")
        else:
            if not rows:
                missing.append("task_match")
            elif len(rows) > 1:
                missing.append("task_disambiguation")
                constraints["task_candidates"] = [
                    {"task_id": task.id, "goal_id": goal.id, "goal_title": goal.title}
                    for task, goal in rows[:8]
                ]
            else:
                task, task_goal = rows[0]
                refs.append(ActionEntityRef(entity="task", entity_id=task.id, label=task.title))
                if goal_id != task.goal_id:
                    refs = [ref for ref in refs if ref.entity != "goal"]
                    goal_id = task.goal_id
                    refs.append(
                        ActionEntityRef(
                            entity="goal", entity_id=task_goal.id, label=task_goal.title
                        )
                    )
        if effect == "update" and not requested_date:
            missing.append("scheduled_date")

    return ActionIntent(
        capability=decision.capability,
        goal_id=goal_id,
        entity_refs=refs,
        constraints=constraints,
        requested_effect=effect,
        resolution_quality="exact" if not missing else "incomplete",
        missing_slots=sorted(set(missing)),
        source=source,
    )


def action_clarification(intent: ActionIntent) -> str:
    labels = {
        "goal": "请选择这项任务所属的学习目标",
        "task_title": "请用引号写出任务标题，例如“章节练习”",
        "scheduled_date": "请补充执行日期，例如今天、明天或 2026-08-31",
        "task_match": "没有找到这个标题的任务，请检查名称后重试",
        "task_disambiguation": "发现多个同名任务，请先选择目标后再操作",
    }
    details = [labels[item] for item in intent.missing_slots if item in labels]
    return "要执行这项操作，我还需要确认：" + "；".join(details) + "。确认清楚后我再生成变更预览。"


def _conversation_need_frame(message: str) -> NeedFrame:
    normalized = message.strip()
    speech_act: Literal["ask", "explain", "command", "confirm", "cancel", "inform"]
    if any(term in normalized for term in ("为什么", "解释", "怎么理解", "讲一下")):
        speech_act = "explain"
    elif normalized.endswith(("?", "？")) or any(
        term in normalized for term in ("怎么", "如何", "是否", "能不能")
    ):
        speech_act = "ask"
    else:
        speech_act = "inform"
    scopes = ["conversation"]
    if "目标" in normalized:
        scopes.append("goal")
    if "任务" in normalized or "计划" in normalized:
        scopes.append("tasks")
    if "资料" in normalized or "知识" in normalized:
        scopes.append("knowledge")
    return NeedFrame(
        speech_act=speech_act,
        core_need=normalized[:120] or "继续对话",
        mode="conversation",
        context_scope=list(dict.fromkeys(scopes)),
        evidence_scope=[],
    )


async def resolve_need_frame(
    db: AsyncSession,
    *,
    user_id: str,
    session_id: str,
    conversation_turn_id: str,
    message: str,
    goal_id: str | None,
) -> NeedFrame:
    now = utc_now()
    from src.services.beta_evidence_service import assignment

    beta = await assignment(db, user_id)
    await emit(
        db,
        user_id=user_id,
        goal_id=goal_id,
        aggregate_type="conversation_turn",
        aggregate_id=conversation_turn_id,
        event_type="ConversationTurnReceived",
        source="user_action",
        payload={"session_id": session_id, "beta": beta},
        idempotency_key=f"conversation-turn-received:{conversation_turn_id}",
    )
    pending = await db.scalar(
        select(PendingActionIntent).where(
            PendingActionIntent.user_id == user_id,
            PendingActionIntent.session_id == session_id,
        )
    )
    if pending and pending.expires_at <= now:
        await db.delete(pending)
        pending = None
        await db.flush()

    if pending and message.strip() in {"取消", "算了", "不用了", "先不做了", "取消操作"}:
        await db.delete(pending)
        await emit(
            db,
            user_id=user_id,
            goal_id=goal_id,
            aggregate_type="conversation_turn",
            aggregate_id=conversation_turn_id,
            event_type="PendingActionCancelled",
            source="user_action",
            payload={"session_id": session_id, "pending_turn_id": pending.conversation_turn_id},
        )
        await db.commit()
        return NeedFrame(
            speech_act="cancel",
            core_need="取消待补充的行动请求",
            mode="conversation",
            context_scope=["conversation"],
        )

    original_message = message
    resolved_goal_id = goal_id
    if pending:
        original_message = str(pending.payload.get("original_message") or "")
        prior = ActionIntent.model_validate(pending.payload.get("action_intent") or {})
        supplement = message.strip()
        if "task_title" in prior.missing_slots and not _extract_task_title(supplement):
            if supplement and not _requested_date(supplement, date.today()):
                supplement = f"“{supplement}”"
        if "goal" in prior.missing_slots and not resolved_goal_id:
            goal_label = _quoted_title(message) or message.strip()
            matched_goal = await db.scalar(
                select(Goal).where(
                    Goal.user_id == user_id,
                    Goal.status == "active",
                    Goal.title == goal_label,
                )
            )
            if matched_goal:
                resolved_goal_id = matched_goal.id
                supplement = ""
        if "task_disambiguation" in prior.missing_slots and not resolved_goal_id:
            goal_label = _quoted_title(message) or message.strip()
            matched_goal = await db.scalar(
                select(Goal).where(Goal.user_id == user_id, Goal.title == goal_label)
            )
            if matched_goal:
                resolved_goal_id = matched_goal.id
                supplement = ""
        message = f"{original_message} {supplement}".strip()

    intent = await resolve_action_intent(
        db,
        user_id=user_id,
        message=message,
        goal_id=resolved_goal_id,
    )
    if intent is None:
        frame = _conversation_need_frame(message)
        await emit(
            db,
            user_id=user_id,
            goal_id=goal_id,
            aggregate_type="conversation_turn",
            aggregate_id=conversation_turn_id,
            event_type="NeedFrameResolved",
            source="user_action",
            payload={
                "need_frame": frame.model_dump(mode="json"),
                "session_id": session_id,
                "beta": beta,
            },
        )
        await db.commit()
        return frame

    mode = "action" if intent.complete else "clarification"
    frame = NeedFrame(
        speech_act="command",
        core_need=intent.capability,
        mode=mode,
        context_scope=["goal", "tasks"],
        evidence_scope=[ref.entity_id for ref in intent.entity_refs],
        action_intent=intent,
    )
    if intent.complete:
        if pending:
            intent.constraints["resolved_request"] = message
        if pending:
            await db.delete(pending)
        await emit(
            db,
            user_id=user_id,
            goal_id=intent.goal_id,
            aggregate_type="conversation_turn",
            aggregate_id=conversation_turn_id,
            event_type="IntentResolved",
            source="user_action",
            payload={
                "session_id": session_id,
                "need_frame": frame.model_dump(mode="json"),
                "beta": beta,
                "continued_from_turn_id": pending.conversation_turn_id if pending else None,
            },
        )
        await db.commit()
        return frame

    payload = {
        "original_message": original_message,
        "goal_id": resolved_goal_id,
        "action_intent": intent.model_dump(mode="json"),
    }
    if pending:
        pending.payload = payload
        pending.missing_slots = intent.missing_slots
        pending.expires_at = now + timedelta(minutes=10)
    else:
        db.add(
            PendingActionIntent(
                user_id=user_id,
                session_id=session_id,
                conversation_turn_id=conversation_turn_id,
                payload=payload,
                missing_slots=intent.missing_slots,
                expires_at=now + timedelta(minutes=10),
            )
        )
    await emit(
        db,
        user_id=user_id,
        goal_id=intent.goal_id,
        aggregate_type="conversation_turn",
        aggregate_id=conversation_turn_id,
        event_type="ClarificationRequested",
        source="ai_agent",
        payload={
            "session_id": session_id,
            "need_frame": frame.model_dump(mode="json"),
            "missing_slots": intent.missing_slots,
            "beta": beta,
        },
    )
    await db.commit()
    return frame
