from datetime import date, timedelta

import pytest

from src.core.agent.dispatch import (
    classify_action_speech_act,
    classify_agent_request,
    resolve_action_intent,
)
from src.core.agent.nodes.intent import _keyword_intent
from src.models import Goal, Task


@pytest.mark.parametrize(
    ("message", "capability"),
    [
        ("欠着的项目帮我摊到下周，先出草案别落库。", "reschedule_overdue"),
        ("逾期那批请避开周三，逐项给新日期让我看。", "reschedule_overdue"),
        ("给技能训练记一条明早二十分钟的错题整理，先让我审。", "task_mutation"),
        ("阅读任务已经收尾，按流程给我标完成预览。", "task_mutation"),
        ("请把章节复习记作已完成，但要先确认。", "task_mutation"),
        ("我做完章节练习了，帮我走确认链。", "task_mutation"),
        ("移除章节练习前把关联风险和恢复方式说清。", "task_mutation"),
        ("章节练习可以清掉吗？只给高风险预览，别写。", "task_mutation"),
        ("所有逾期项一起生成差异预览，先别提交。", "reschedule_overdue"),
        ("批量排期时周末最多一项，给出逐项变更。", "reschedule_overdue"),
        ("这周只能每天二十分钟，帮我列减负草案。", "reschedule_overdue"),
        ("章节今天赶不上，放到大后天前先给预览。", "task_mutation"),
        ("为这个目标的逾期任务生成未来七天调整预览，停在审批。", "reschedule_overdue"),
        ("生成这个目标逾期任务的调整预览并停住。", "reschedule_overdue"),
        ("先产出这个目标未来一周的调整预览，我改过方案以后才确认。", "reschedule_overdue"),
        ("批量把阅读计划 1所有过期未完成任务排入未来七天。", "reschedule_overdue"),
        ("将旧欠项批量重排到下周，输出每项 before/after 预览。", "reschedule_overdue"),
    ],
)
def test_holdout_semantic_action_categories_route_to_supported_capability(
    message, capability
):
    decision = classify_agent_request(message)
    assert decision.mode == "action"
    assert decision.capability == capability


@pytest.mark.parametrize(
    ("message", "expected_mode", "expected_guard"),
    [
        ("如果我走确认链会怎样，只分析不要执行。", "conversation", "conversation"),
        ("我想了解减负草案，不要生成变更。", "conversation", "conversation"),
        ("能不能清掉章节练习？先说风险，不要执行。", "conversation", "conversation"),
        ("章节练习可以清掉吗？只给高风险预览，别写。", "action", "preview"),
        ("清掉章节练习，先给高风险预览。", "action", "preview"),
        ("移除章节练习前把风险和恢复方式说清，先给预览。", "action", "preview"),
    ],
)
def test_unified_speech_act_guard_precedes_capability_routing(
    message, expected_mode, expected_guard
):
    assert classify_action_speech_act(message).route == expected_guard
    assert classify_agent_request(message).mode == expected_mode


def test_routes_supported_task_actions_to_action_agent():
    samples = (
        "把所有逾期任务重新安排到未来一周",
        "新增任务“复习二分查找”",
        "删除任务“过时的章节练习”",
        "把任务“Python 变量”改到明天",
        "标记完成任务“数组练习”",
        "把数组练习挪到后天，先让我确认",
        "我这周只能每天 30 分钟，把负荷降下来，先预览",
        "先给调整草案，我要编辑后再确认",
        "信息不足就先问清楚，别猜。我的意思是：完成 技能训练 3 · 第17步。",
        "给当前目标添一项：明儿复习三十分钟，先别直接保存。",
        "这项章节练习延两天，给我看改前改后。",
        "章节练习搞定啦，记成完成但先确认。",
        "这个任务章节练习删掉吧，不过没确认不能写。",
        "最近加班，只扛得住每天半小时，先给减量方案。",
        "欠下的活往后七天摊开，先把草案亮出来。",
        "草案出来后我还要删改几项，再决定。",
    )
    for message in samples:
        assert classify_agent_request(message).mode == "action"


def test_keeps_questions_and_unsupported_actions_conversational():
    samples = (
        "帮我解释二分查找",
        "把这个任务拆解思路讲一下",
        "把当前目标拆成几个阶段",
        "为什么最近进度比较慢？",
        "根据我的资料回答这个问题",
        "如何重新安排这些任务比较合理？",
        "降低下周的学习负荷",
        "先不要删除任务“章节练习”",
        "能不能删除任务“章节练习”？",
    )
    for message in samples:
        assert classify_agent_request(message).mode == "conversation"


@pytest.mark.parametrize(
    ("message", "expected_mode"),
    [
        ("今天完成了学习任务", "conversation"),
        ("今天完成了两项，打个卡", "conversation"),
        ("把任务“X”标记完成", "action"),
        ("今天把“X”做完了，帮我标记完成", "action"),
        ("如果今天没完成会怎样，只分析不要执行", "conversation"),
    ],
)
def test_progress_report_and_explicit_task_completion_boundary(message, expected_mode):
    assert classify_agent_request(message).mode == expected_mode


def test_oral_progress_report_reaches_checkin_understanding_path():
    message = "我刚完成一小段，用时十八分钟，记录前让我确认。"
    assert classify_agent_request(message).mode == "conversation"
    assert _keyword_intent(message) == "checkin"


@pytest.mark.asyncio
async def test_action_intent_requires_explicit_create_fields(db, client, auth, goal_id):
    goal = await db.get(Goal, goal_id)
    assert goal is not None

    missing_date = await resolve_action_intent(
        db,
        user_id=goal.user_id,
        message="新增任务“复习二分查找”",
        goal_id=goal_id,
    )
    assert missing_date is not None
    assert missing_date.missing_slots == ["scheduled_date"]

    missing_title = await resolve_action_intent(
        db,
        user_id=goal.user_id,
        message="新增任务明天",
        goal_id=goal_id,
    )
    assert missing_title is not None
    assert missing_title.missing_slots == ["task_title"]

    complete = await resolve_action_intent(
        db,
        user_id=goal.user_id,
        message="新增任务“复习二分查找”，安排到明天",
        goal_id=goal_id,
    )
    assert complete is not None and complete.complete
    assert complete.constraints["task_title"] == "复习二分查找"
    assert complete.constraints["scheduled_date"] == (date.today() + timedelta(days=1)).isoformat()


@pytest.mark.asyncio
async def test_natural_action_forms_resolve_without_forcing_quotes(db, client, auth, goal_id):
    goal = await db.get(Goal, goal_id)
    assert goal is not None
    create = await resolve_action_intent(
        db,
        user_id=goal.user_id,
        message="创建一个明天30分钟的复习任务",
        goal_id=goal_id,
    )
    assert create is not None and create.complete
    assert create.requested_effect == "create"
    assert create.constraints["task_title"] == "复习"
    colon_create = await resolve_action_intent(
        db,
        user_id=goal.user_id,
        message="帮我加任务：明天复盘错题半小时。",
        goal_id=goal_id,
    )
    assert colon_create is not None and colon_create.complete
    assert colon_create.constraints["task_title"] == "复盘错题"
    holdout_create = await resolve_action_intent(
        db,
        user_id=goal.user_id,
        message="给测试目标添一项：明儿复习三十分钟，先别直接保存。",
        goal_id=goal_id,
    )
    assert holdout_create is not None and holdout_create.complete
    assert holdout_create.requested_effect == "create"
    assert holdout_create.constraints["task_title"] == "复习"
    recorded_create = await resolve_action_intent(
        db,
        user_id=goal.user_id,
        message="给测试目标记一条明早二十分钟的错题整理，先让我审。",
        goal_id=goal_id,
    )
    assert recorded_create is not None and recorded_create.complete
    assert recorded_create.requested_effect == "create"
    assert recorded_create.constraints["task_title"] == "错题整理"
    assert recorded_create.constraints["scheduled_date"] == (
        date.today() + timedelta(days=1)
    ).isoformat()

    overdue = await resolve_action_intent(
        db,
        user_id=goal.user_id,
        message="把这个目标的逾期任务重新排到未来七天，先给我看",
        goal_id=goal_id,
    )
    assert overdue is not None and overdue.complete
    assert overdue.capability == "reschedule_overdue"
    assert overdue.constraints["overdue_only"] is True

    expired_incomplete = await resolve_action_intent(
        db,
        user_id=goal.user_id,
        message="批量把阅读计划 1所有过期未完成任务排入未来七天，先给逐项变更预览。",
        goal_id=goal_id,
    )
    assert expired_incomplete is not None and expired_incomplete.complete
    assert expired_incomplete.capability == "reschedule_overdue"
    assert expired_incomplete.requested_effect == "reschedule"

    db.add(
        Task(
            id="dispatch-natural-delete",
            goal_id=goal_id,
            title="错题复习",
            scheduled_date=date.today().isoformat(),
        )
    )
    await db.flush()
    delete = await resolve_action_intent(
        db,
        user_id=goal.user_id,
        message="这个错题复习不要了，删掉",
        goal_id=goal_id,
    )
    assert delete is not None and delete.complete
    assert delete.requested_effect == "delete"

    inspected_delete = await resolve_action_intent(
        db,
        user_id=goal.user_id,
        message="删除错题复习，必须先告诉我影响。",
        goal_id=goal_id,
    )
    assert inspected_delete is not None and inspected_delete.complete
    assert inspected_delete.requested_effect == "delete"

    moved = await resolve_action_intent(
        db,
        user_id=goal.user_id,
        message="我说得口语一点：把错题复习挪到后天，先让我确认。",
        goal_id=goal_id,
    )
    assert moved is not None and moved.complete
    assert moved.requested_effect == "update"
    assert moved.constraints["scheduled_date"] == (date.today() + timedelta(days=2)).isoformat()

    completed = await resolve_action_intent(
        db,
        user_id=goal.user_id,
        message="我可能没说顺；我的意思是：错题复习已经做完了，标记完成。",
        goal_id=goal_id,
    )
    assert completed is not None and completed.complete
    assert completed.requested_effect == "complete"

    exact_unquoted = await resolve_action_intent(
        db,
        user_id=goal.user_id,
        message="错题复习搞定啦，记成完成但先确认。",
        goal_id=goal_id,
    )
    assert exact_unquoted is not None and exact_unquoted.complete
    assert exact_unquoted.requested_effect == "complete"
    confirmed_complete = await resolve_action_intent(
        db,
        user_id=goal.user_id,
        message="请把错题复习记作已完成，但要先确认。",
        goal_id=goal_id,
    )
    assert confirmed_complete is not None and confirmed_complete.complete
    assert confirmed_complete.requested_effect == "complete"

    delayed = await resolve_action_intent(
        db,
        user_id=goal.user_id,
        message="错题复习今天悬了，挪到大后天，先问我。",
        goal_id=goal_id,
    )
    assert delayed is not None and delayed.complete
    assert delayed.constraints["scheduled_date"] == (date.today() + timedelta(days=3)).isoformat()
    weekday_move = await resolve_action_intent(
        db,
        user_id=goal.user_id,
        message="把错题复习延到周四，确认前不要改。",
        goal_id=goal_id,
    )
    assert weekday_move is not None and weekday_move.complete
    assert date.fromisoformat(weekday_move.constraints["scheduled_date"]).weekday() == 3

    reduced = await resolve_action_intent(
        db,
        user_id=goal.user_id,
        message="工作爆了，减少测试目标本周任务量。",
        goal_id=goal_id,
    )
    assert reduced is not None and reduced.complete
    assert reduced.requested_effect == "reschedule"
    reduced_holdout = await resolve_action_intent(
        db,
        user_id=goal.user_id,
        message="每天最多 30 分钟，哪些能降先列出来。",
        goal_id=goal_id,
    )
    assert reduced_holdout is not None and reduced_holdout.complete
    assert reduced_holdout.requested_effect == "reschedule"

    deleted_holdout = await resolve_action_intent(
        db,
        user_id=goal.user_id,
        message="想移除 错题复习，先给高风险预览。",
        goal_id=goal_id,
    )
    assert deleted_holdout is not None and deleted_holdout.complete
    assert deleted_holdout.requested_effect == "delete"


@pytest.mark.asyncio
async def test_action_intent_resolves_exact_owned_task_and_detects_duplicates(
    db, client, auth, goal_id
):
    first_goal = await db.get(Goal, goal_id)
    assert first_goal is not None
    second_goal = Goal(
        id="dispatch-goal-2",
        user_id=first_goal.user_id,
        type="skill",
        title="第二目标",
        deadline=(date.today() + timedelta(days=30)).isoformat(),
        daily_hours=1,
        status="active",
    )
    db.add(second_goal)
    db.add_all(
        [
            Task(
                id="dispatch-task-1",
                goal_id=goal_id,
                title="同名练习",
                scheduled_date=date.today().isoformat(),
            ),
            Task(
                id="dispatch-task-2",
                goal_id=second_goal.id,
                title="同名练习",
                scheduled_date=date.today().isoformat(),
            ),
        ]
    )
    await db.flush()

    ambiguous = await resolve_action_intent(
        db,
        user_id=first_goal.user_id,
        message="删除任务“同名练习”",
        goal_id=None,
    )
    assert ambiguous is not None
    assert "task_disambiguation" in ambiguous.missing_slots

    resolved = await resolve_action_intent(
        db,
        user_id=first_goal.user_id,
        message="删除任务“同名练习”",
        goal_id=goal_id,
    )
    assert resolved is not None and resolved.complete
    task_ref = next(ref for ref in resolved.entity_refs if ref.entity == "task")
    assert task_ref.entity_id == "dispatch-task-1"

    unique_cross_goal = Task(
        id="dispatch-task-cross-goal",
        goal_id=second_goal.id,
        title="跨目标唯一任务",
        scheduled_date=date.today().isoformat(),
    )
    db.add(unique_cross_goal)
    await db.flush()
    cross_goal = await resolve_action_intent(
        db,
        user_id=first_goal.user_id,
        message="我说得口语一点：跨目标唯一任务已经做完了，标记完成，先给我确认。",
        goal_id=goal_id,
    )
    assert cross_goal is not None and cross_goal.complete
    assert cross_goal.goal_id == second_goal.id
    cross_task_ref = next(ref for ref in cross_goal.entity_refs if ref.entity == "task")
    assert cross_task_ref.entity_id == unique_cross_goal.id

    missing = await resolve_action_intent(
        db,
        user_id=first_goal.user_id,
        message="删除任务“并不存在”",
        goal_id=goal_id,
    )
    assert missing is not None
    assert missing.missing_slots == ["task_match"]
