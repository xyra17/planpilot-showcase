from unittest.mock import MagicMock, patch

from src.core.llm_router import (
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
    routed = MagicMock()
    local.with_fallbacks.return_value = routed
    flash = MagicMock()

    with patch("src.core.llm_router.ChatOpenAI", side_effect=[local, flash]) as factory:
        result = create_routine_llm(max_tokens=123)

    assert result is routed
    assert factory.call_args_list[0].kwargs["model"].endswith("Qwen3.5-9B-MLX-4bit")
    assert factory.call_args_list[0].kwargs["max_retries"] == 0
    assert factory.call_args_list[0].kwargs["extra_body"] == {
        "chat_template_kwargs": {"enable_thinking": False}
    }
    assert factory.call_args_list[1].kwargs["model"] == "deepseek-v4-flash"
    local.with_fallbacks.assert_called_once_with([flash])


def test_routine_route_binds_tools_before_adding_fallback():
    local = MagicMock()
    local_bound = MagicMock()
    local.bind_tools.return_value = local_bound
    flash = MagicMock()
    flash_bound = MagicMock()
    flash.bind_tools.return_value = flash_bound
    tools = [MagicMock()]

    with patch("src.core.llm_router.ChatOpenAI", side_effect=[local, flash]):
        create_routine_llm(tools=tools)

    local.bind_tools.assert_called_once_with(tools)
    flash.bind_tools.assert_called_once_with(tools)
    local_bound.with_fallbacks.assert_called_once_with([flash_bound])


def test_pro_route_never_uses_local_model():
    pro = MagicMock()
    with patch("src.core.llm_router.ChatOpenAI", return_value=pro) as factory:
        result = create_pro_llm(max_tokens=700)

    assert result is pro
    assert factory.call_args.kwargs["model"] == "deepseek-v4-pro"


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
        "average_latency_ms": 125.0,
    }
    assert "prompt" not in str(snapshot).lower()
    assert "response" not in str(snapshot).lower()


def test_structured_route_enforces_json_object():
    routed = MagicMock()
    with patch("src.core.llm_router.create_routine_llm", return_value=routed) as factory:
        result = create_structured_routine_llm(max_tokens=200)

    assert result is routed
    assert factory.call_args.kwargs["model_kwargs"]["response_format"] == {
        "type": "json_object"
    }
