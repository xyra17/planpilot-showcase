from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.core.llm_router import (
    ainvoke_routine_checked,
    create_pro_llm,
    create_routine_llm,
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

    with (
        patch("src.core.llm_router.ChatOpenAI", side_effect=[local, flash]) as factory,
        patch("src.core.llm_router._limit_local_concurrency", return_value=limited),
    ):
        result = create_routine_llm(max_tokens=123)

    assert result is routed
    assert factory.call_args_list[0].kwargs["model"].endswith("Qwen3.5-9B-MLX-4bit")
    assert factory.call_args_list[0].kwargs["max_retries"] == 0
    assert factory.call_args_list[0].kwargs["extra_body"] == {
        "chat_template_kwargs": {"enable_thinking": False}
    }
    assert factory.call_args_list[1].kwargs["model"] == "deepseek-v4-flash"
    assert factory.call_args_list[1].kwargs["max_retries"] == 0
    limited.with_fallbacks.assert_called_once_with([flash])


def test_routine_route_binds_tools_before_adding_fallback():
    local = MagicMock()
    local_bound = MagicMock()
    local.bind_tools.return_value = local_bound
    flash = MagicMock()
    flash_bound = MagicMock()
    flash.bind_tools.return_value = flash_bound
    limited = MagicMock()
    tools = [MagicMock()]

    with (
        patch("src.core.llm_router.ChatOpenAI", side_effect=[local, flash]),
        patch("src.core.llm_router._limit_local_concurrency", return_value=limited),
    ):
        create_routine_llm(tools=tools)

    local.bind_tools.assert_called_once_with(tools)
    flash.bind_tools.assert_called_once_with(tools)
    limited.with_fallbacks.assert_called_once_with([flash_bound])


def test_pro_route_never_uses_local_model():
    pro = MagicMock()
    with patch("src.core.llm_router.ChatOpenAI", return_value=pro) as factory:
        result = create_pro_llm(max_tokens=700)

    assert result is pro
    assert factory.call_args.kwargs["model"] == "deepseek-v4-pro"
    assert factory.call_args.kwargs["max_retries"] == 0


def test_open_circuit_skips_local_model():
    local_circuit.record_failure()
    local_circuit.record_failure()
    flash = MagicMock()

    with patch("src.core.llm_router.ChatOpenAI", return_value=flash) as factory:
        result = create_routine_llm(max_tokens=20)

    assert result is flash
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
    with patch("src.core.llm_router.create_routine_llm", return_value=routed) as factory:
        result = create_structured_routine_llm(max_tokens=200)

    assert result is routed
    assert factory.call_args.kwargs["model_kwargs"]["response_format"] == {"type": "json_object"}


def test_structured_route_can_pin_an_approved_smart_model_config():
    configured = MagicMock()
    with patch("src.core.llm_router.ChatOpenAI", return_value=configured) as factory:
        result = create_structured_routine_llm(
            provider="smart",
            model_name="pinned-model-v2",
            timeout_ms=45000,
            temperature=0.1,
            max_tokens=321,
        )

    assert result is configured
    assert factory.call_args.kwargs["model"] == "pinned-model-v2"
    assert factory.call_args.kwargs["timeout"] == 45
    assert factory.call_args.kwargs["model_kwargs"]["response_format"] == {"type": "json_object"}


@pytest.mark.asyncio
async def test_quality_failure_retries_with_cloud_model():
    local_response = MagicMock(
        content="not json",
        response_metadata={"model_name": "local-qwen"},
    )
    cloud_response = MagicMock(
        content='{"ok": true}',
        response_metadata={"model_name": "deepseek-v4-flash"},
    )
    routed = MagicMock()
    routed.ainvoke = AsyncMock(return_value=local_response)
    cloud = MagicMock()
    cloud.ainvoke = AsyncMock(return_value=cloud_response)

    with (
        patch("src.core.llm_router.create_routine_llm", return_value=routed),
        patch("src.core.llm_router._flash_llm", return_value=cloud),
    ):
        result = await ainvoke_routine_checked(
            ["message"],
            validator=lambda content: __import__("json").loads(content),
        )

    assert result is cloud_response
    cloud.ainvoke.assert_awaited_once()
