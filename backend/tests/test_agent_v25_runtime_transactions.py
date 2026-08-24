from unittest.mock import patch

from sqlalchemy.ext.asyncio import async_sessionmaker

from src.services.agent_v25_runtime_gate import (
    _case_passed,
    _evaluate_lifecycle_case,
    _evaluate_worker_interrupt,
)
from src.services.evaluation_v2_service import load_agent_v25_cases


async def test_runtime_lifecycle_cases_do_not_reuse_rolled_back_orm_state(db):
    """Rollback expiration never leaks ORM instances into later Gate assertions."""
    factory = async_sessionmaker(db.bind, expire_on_commit=False)
    cases = {case["category"]: case for case in load_agent_v25_cases()["action-runtime-safety-v1"]}

    with patch("src.tasks.agent_runs.dispatch_agent_run", return_value=None):
        for category in (
            "cross_user",
            "expired_changeset",
            "failed",
            "duplicate_write",
            "rollback",
        ):
            case = cases[category]
            actual = await _evaluate_lifecycle_case(factory, case)
            assert _case_passed(actual, case), {"category": category, "actual": actual}

        worker_case = cases["worker_interrupt"]
        worker_actual = await _evaluate_worker_interrupt(factory)
        assert _case_passed(worker_actual, worker_case), worker_actual
