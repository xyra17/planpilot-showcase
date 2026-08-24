from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.core.llm_router import (
    MODEL_ROLE_CONTRACTS,
    ainvoke_structured_checked,
    create_critical_llm,
    create_interactive_llm,
    create_json_llm,
    create_structured_routine_llm,
    local_circuit,
    model_metrics,
)


def setup_function():
    local_circuit.reset()
    model_metrics.reset()


def test_routine_route_prefers_local_and_falls_back_to_flash():
    local = MagicMock()
    limited = MagicMock()
    routed = MagicMock()
    limited.with_fallbacks.return_value = routed
    flash = MagicMock()
    flash_limited = MagicMock()

    with (
        patch("src.core.llm_router.ChatOpenAI", side_effect=[local, flash]) as factory,
        patch("src.core.llm_router._limit_local_concurrency", return_value=limited),
        patch("src.core.llm_router._limit_flash_concurrency", return_value=flash_limited),
    ):
        result = create_interactive_llm(max_tokens=123)

    assert result is routed
    assert factory.call_args_list[0].kwargs["model"].endswith("Qwen3.5-9B-MLX-4bit")
    assert factory.call_args_list[0].kwargs["max_retries"] == 0
    assert factory.call_args_list[0].kwargs["extra_body"] == {
        "chat_template_kwargs": {"enable_thinking": False}
    }
    assert factory.call_args_list[1].kwargs["model"] == "deepseek-v4-flash"
    assert factory.call_args_list[1].kwargs["max_retries"] == 0
    limited.with_fallbacks.assert_called_once_with([flash_limited])


def test_routine_route_binds_tools_before_adding_fallback():
    local = MagicMock()
    local_bound = MagicMock()
    local.bind_tools.return_value = local_bound
    flash = MagicMock()
    flash_bound = MagicMock()
    flash.bind_tools.return_value = flash_bound
    limited = MagicMock()
    flash_limited = MagicMock()
    tools = [MagicMock()]

    with (
        patch("src.core.llm_router.ChatOpenAI", side_effect=[local, flash]),
        patch("src.core.llm_router._limit_local_concurrency", return_value=limited),
        patch("src.core.llm_router._limit_flash_concurrency", return_value=flash_limited),
    ):
        create_interactive_llm(tools=tools)

    local.bind_tools.assert_called_once_with(tools)
    flash.bind_tools.assert_called_once_with(tools)
    flash_limited.assert_not_called()
    limited.with_fallbacks.assert_called_once_with([flash_limited])


def test_pro_route_never_uses_local_model():
    pro = MagicMock()
    limited = MagicMock()
    with (
        patch("src.core.llm_router.ChatOpenAI", return_value=pro) as factory,
        patch("src.core.llm_router._limit_pro_concurrency", return_value=limited),
    ):
        result = create_critical_llm(max_tokens=700)

    assert result is limited
    assert factory.call_args.kwargs["model"] == "deepseek-v4-pro"
    assert factory.call_args.kwargs["max_retries"] == 0


def test_open_circuit_skips_local_model():
    local_circuit.record_failure()
    local_circuit.record_failure()
    flash = MagicMock()
    flash_limited = MagicMock()

    with (
        patch("src.core.llm_router.ChatOpenAI", return_value=flash) as factory,
        patch("src.core.llm_router._limit_flash_concurrency", return_value=flash_limited),
    ):
        result = create_interactive_llm(max_tokens=20)

    assert result is flash_limited
    assert factory.call_count == 1
    assert factory.call_args.kwargs["model"] == "deepseek-v4-flash"
    assert local_circuit.snapshot()["state"] == "open"


def test_metrics_do_not_contain_prompt_or_response_content():
    model_metrics.record("local", "success", 125.0)
    snapshot = model_metrics.snapshot()

    assert snapshot["local"] == {
        "requests": 1,
        "successes": 1,
        "failures": 0,
        "quality_failures": 0,
        "average_latency_ms": 125.0,
    }
    assert "prompt" not in str(snapshot).lower()
    assert "response" not in str(snapshot).lower()


def test_structured_route_enforces_json_object():
    routed = MagicMock()
    with patch("src.core.llm_router.create_structured_llm", return_value=routed) as factory:
        result = create_json_llm(max_tokens=200)

    assert result is routed
    assert factory.call_args.kwargs["model_kwargs"]["response_format"] == {"type": "json_object"}


def test_structured_route_can_pin_an_approved_smart_model_config():
    configured = MagicMock()
    limited = MagicMock()
    with (
        patch("src.core.llm_router.ChatOpenAI", return_value=configured) as factory,
        patch("src.core.llm_router._limit_flash_concurrency", return_value=limited),
    ):
        result = create_structured_routine_llm(
            provider="smart",
            model_name="pinned-model-v2",
            timeout_ms=45000,
            temperature=0.1,
            max_tokens=321,
        )

    assert result is limited
    assert factory.call_args.kwargs["model"] == "pinned-model-v2"
    assert factory.call_args.kwargs["timeout"] == 45
    assert factory.call_args.kwargs["model_kwargs"]["response_format"] == {"type": "json_object"}


@pytest.mark.asyncio
async def test_quality_failure_retries_with_local_model():
    cloud_response = MagicMock(
        content="not json",
        response_metadata={"model_name": "deepseek-v4-flash"},
    )
    local_response = MagicMock(
        content='{"ok": true}',
        response_metadata={"model_name": "local-qwen"},
    )
    routed = MagicMock()
    routed.ainvoke = AsyncMock(return_value=cloud_response)
    local = MagicMock()
    local.ainvoke = AsyncMock(return_value=local_response)

    with (
        patch("src.core.llm_router.create_structured_llm", return_value=routed),
        patch("src.core.llm_router._local_llm", return_value=local),
        patch("src.core.llm_router._limit_local_concurrency", return_value=local),
    ):
        result = await ainvoke_structured_checked(
            ["message"],
            validator=lambda content: __import__("json").loads(content),
        )

    assert result is local_response
    local.ainvoke.assert_awaited_once()


def test_model_roles_are_explicit_and_non_overlapping():
    assert MODEL_ROLE_CONTRACTS["interactive"]["primary"] == "local"
    assert MODEL_ROLE_CONTRACTS["structured"]["primary"] == "flash"
    assert MODEL_ROLE_CONTRACTS["critical"]["primary"] == "pro"
    assert MODEL_ROLE_CONTRACTS["embedding"]["primary"] == "embedding-local"
