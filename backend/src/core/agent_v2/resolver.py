from __future__ import annotations

from typing import Any

from src.core.agent_v2.schemas import AgentPlan, OutputRef, PlanStep


class PlanValidationError(ValueError):
    pass


def validate_plan(plan: AgentPlan, *, available_tools: set[str], step_budget: int) -> None:
    if len(plan.steps) > step_budget:
        raise PlanValidationError("执行计划超过步骤预算")
    keys = [step.step_id for step in plan.steps]
    if len(keys) != len(set(keys)):
        raise PlanValidationError("执行计划包含重复 step_id")
    known = set(keys)
    position = {key: index for index, key in enumerate(keys)}
    for step in plan.steps:
        if step.tool_name not in available_tools:
            raise PlanValidationError(f"计划引用未注册工具: {step.tool_name}")
        for dependency in step.depends_on:
            if dependency not in known:
                raise PlanValidationError(f"步骤 {step.step_id} 引用不存在的依赖 {dependency}")
            if dependency == step.step_id:
                raise PlanValidationError("步骤不能依赖自身")
        for ref in step.input_refs.values():
            if ref.step_id not in known:
                raise PlanValidationError(f"输出引用不存在: {ref.step_id}")
            if position[ref.step_id] >= position[step.step_id]:
                raise PlanValidationError("输出引用必须指向上游步骤")
            if ref.step_id not in step.depends_on:
                raise PlanValidationError("输出引用必须同时声明为步骤依赖")

    visiting: set[str] = set()
    visited: set[str] = set()
    graph = {step.step_id: step.depends_on for step in plan.steps}

    def visit(key: str) -> None:
        if key in visiting:
            raise PlanValidationError("执行计划存在循环依赖")
        if key in visited:
            return
        visiting.add(key)
        for dependency in graph[key]:
            visit(dependency)
        visiting.remove(key)
        visited.add(key)

    for key in keys:
        visit(key)


def _read_path(value: Any, path: str | None) -> Any:
    if not path:
        return value
    current = value
    for segment in path.split("."):
        if isinstance(current, dict) and segment in current:
            current = current[segment]
        elif isinstance(current, list) and segment.isdigit() and int(segment) < len(current):
            current = current[int(segment)]
        else:
            raise PlanValidationError(f"输出路径不存在: {path}")
    return current


def resolve_inputs(
    step: PlanStep,
    *,
    outputs: dict[str, dict[str, Any] | None],
) -> dict[str, Any]:
    payload = dict(step.input)
    for field, raw_ref in step.input_refs.items():
        ref = raw_ref if isinstance(raw_ref, OutputRef) else OutputRef.model_validate(raw_ref)
        if ref.step_id not in outputs or outputs[ref.step_id] is None:
            raise PlanValidationError(f"依赖步骤尚无输出: {ref.step_id}")
        payload[field] = _read_path(outputs[ref.step_id], ref.path)
    return payload


def ready_steps(steps: list[Any]) -> tuple[list[Any], list[Any]]:
    by_key = {step.step_key: step for step in steps}
    ready: list[Any] = []
    blocked: list[Any] = []
    for step in steps:
        if step.status not in {"pending", "ready", "retrying"}:
            continue
        dependencies = [by_key.get(key) for key in (step.depends_on or [])]
        if any(
            item is None or item.status in {"failed", "blocked", "skipped"} for item in dependencies
        ):
            blocked.append(step)
        elif all(item.status == "completed" for item in dependencies):
            ready.append(step)
    return ready, blocked
