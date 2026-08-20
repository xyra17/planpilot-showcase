from __future__ import annotations

import asyncio

from fastapi import HTTPException
from sqlalchemy.exc import DBAPIError, OperationalError

from src.core.agent_v2.resolver import PlanValidationError
from src.core.agent_v2.schemas import AgentError, ErrorCategory


class BudgetExceeded(RuntimeError):
    pass


class LeaseLost(RuntimeError):
    pass


def classify_error(exc: Exception) -> AgentError:
    if isinstance(exc, BudgetExceeded):
        return AgentError(
            code="budget_exceeded", category=ErrorCategory.BUDGET_EXCEEDED, safe_message=str(exc)
        )
    if isinstance(exc, LeaseLost):
        return AgentError(
            code="lease_lost", category=ErrorCategory.CANCELLED, safe_message="执行租约已失效"
        )
    if isinstance(exc, (asyncio.TimeoutError, TimeoutError, OperationalError, DBAPIError)):
        return AgentError(
            code="transient_failure",
            category=ErrorCategory.RETRYABLE,
            safe_message="临时执行失败，可重试",
        )
    if isinstance(exc, HTTPException):
        if exc.status_code == 409:
            return AgentError(
                code="stale_precondition",
                category=ErrorCategory.RECOVERABLE,
                safe_message=str(exc.detail),
            )
        if exc.status_code in {401, 403}:
            return AgentError(
                code="permission_denied",
                category=ErrorCategory.FATAL,
                safe_message="没有执行此操作的权限",
            )
        if exc.status_code >= 500:
            return AgentError(
                code="service_failure",
                category=ErrorCategory.RETRYABLE,
                safe_message="依赖服务暂时不可用",
            )
        return AgentError(
            code="invalid_request", category=ErrorCategory.FATAL, safe_message=str(exc.detail)
        )
    if isinstance(exc, (PlanValidationError, KeyError, ValueError, TypeError)):
        return AgentError(
            code="invalid_contract", category=ErrorCategory.FATAL, safe_message=str(exc)
        )
    return AgentError(
        code="execution_failure",
        category=ErrorCategory.FATAL,
        safe_message="执行失败，请查看审计记录",
    )
