import importlib.util
from pathlib import Path


def load_script():
    path = Path(__file__).parents[1] / "scripts" / "configure_models.py"
    spec = importlib.util.spec_from_file_location("configure_models", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_update_env_preserves_unmanaged_values_and_comments():
    script = load_script()
    lines = [
        "# keep",
        "DATABASE_URL=postgresql://example",
        "SMART_MODEL_NAME=old-model",
    ]
    updated = script.update_env(
        lines,
        {
            "SMART_MODEL_NAME": "new-model",
            "SMART_PRO_MODEL_NAME": "quality-model",
        },
    )

    assert "# keep" in updated
    assert "DATABASE_URL=postgresql://example" in updated
    assert "SMART_MODEL_NAME=new-model" in updated
    assert "SMART_PRO_MODEL_NAME=quality-model" in updated


def test_redaction_never_returns_full_secret():
    script = load_script()
    secret = "sk-super-secret-value"
    redacted = script.redact(secret)

    assert redacted != secret
    assert "super-secret" not in redacted


def test_base_url_validation():
    script = load_script()
    assert script.valid_base_url("http://localhost:8080/v1")
    assert script.valid_base_url("https://example.com/v1")
    assert not script.valid_base_url("example.com/v1")
