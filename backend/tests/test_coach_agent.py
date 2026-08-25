import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from scripts.evaluate_coach_agent import evaluate
from src.agents.coach_agent import CoachAgent
from src.config import settings
from src.core.agent.persona import PILO_IDENTITY, PILO_LEARNING_INSIGHT_TEMPLATE


def _context():
    return {
        "profile": {"completion_rate_30d": 0.8},
        "active_patterns": [
            {
                "pattern_type": "preferred_learning_time",
                "pattern_value": {"peak_hours": [9]},
                "confidence": 0.8,
            }
        ],
        "recent_events": [],
        "goal_context": {"goal": {"id": "g1"}, "overdue_tasks": []},
        "data_quality": {"level": "high"},
    }


@pytest.mark.asyncio
async def test_coach_agent_accepts_valid_structured_narrative():
    response = SimpleNamespace(
        content=json.dumps(
            {
                "proposal_type": "learning_nudge",
                "title": "把难题放在上午",
                "summary": "你的上午完成记录更稳定。",
                "reasoning": ["09:00 左右的历史完成表现更好"],
            }
        ),
        response_metadata={"model_name": "test-model"},
    )
    llm = MagicMock(ainvoke=AsyncMock(return_value=response))
    with (
        patch.object(settings, "coach_agent_enabled", True),
        patch("src.agents.coach_agent.create_json_llm", return_value=llm),
    ):
        result = await CoachAgent.generate(
            _context(),
            expected_type="learning_nudge",
            fallback_title="fallback",
            fallback_summary="fallback",
            fallback_reasoning=["fallback"],
        )
    assert result.title == "把难题放在上午"
    assert result.model_name == "test-model"
    assert result.trace["fallback"] is False
    system_prompt = llm.ainvoke.call_args.args[0][0].content
    assert "你是 Pilo" in system_prompt
    assert "当前任务：生成学习洞察" in system_prompt
    assert "Pilo·Coach" not in system_prompt


def test_pilo_identity_hides_internal_capability_names_from_users():
    assert "Pilo" in PILO_IDENTITY
    assert "不得向用户暴露内部能力英文名" in PILO_IDENTITY
    assert "学习洞察" in PILO_LEARNING_INSIGHT_TEMPLATE


@pytest.mark.asyncio
async def test_coach_agent_falls_back_on_unsafe_action_type():
    response = SimpleNamespace(
        content=json.dumps(
            {
                "proposal_type": "reduce_daily_load",
                "title": "越权动作",
                "summary": "不应采用",
                "reasoning": ["不匹配策略"],
            }
        ),
        response_metadata={},
    )
    llm = MagicMock(ainvoke=AsyncMock(return_value=response))
    with (
        patch.object(settings, "coach_agent_enabled", True),
        patch("src.agents.coach_agent.create_json_llm", return_value=llm),
    ):
        result = await CoachAgent.generate(
            _context(),
            expected_type="learning_nudge",
            fallback_title="安全回退",
            fallback_summary="保持节奏",
            fallback_reasoning=["证据不足时不修改计划"],
        )
    assert result.title == "安全回退"
    assert result.trace["fallback"] is True


def test_coach_agent_evaluation_suite_passes():
    path = Path(__file__).parents[1] / "evals" / "coach_agent_cases_v1.json"
    report = evaluate(path)
    assert report["passed"] == report["total"]
