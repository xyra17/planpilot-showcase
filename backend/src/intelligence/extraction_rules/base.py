"""Extraction Rule 基础设施：Schema / Registry / Extractor 注册

职责：
- ExtractionRule  : 声明式配置，描述"哪个事件 → 哪个 Pattern"
- RuleRegistry    : 中心注册表，Dispatcher 按 event_type 查询 Rule 列表
- register_extractor : 装饰器，将异步函数绑定到 rule_id

设计原则（来自 Phase_2C-3_Pattern_Analyzer_Design.md §3）：
- Rule 是纯数据（dataclass），特征提取逻辑在独立函数中
- 新增 Pattern 类型只需新增 Rule + Extractor，不修改 Dispatcher
- condition_check 失败静默跳过，不抛出异常
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Awaitable, Callable, Literal

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

    from src.models import LearningEvent

# ── 类型别名 ────────────────────────────────────────────────────────────────

ExtractorFn = Callable[
    ["LearningEvent", "AsyncSession"],
    Awaitable[dict[str, Any]],
]


# ── ExtractionRule Dataclass ────────────────────────────────────────────────


@dataclass
class ExtractionRule:
    """单条 Extraction Rule 的声明式配置。

    每条 Rule 对应 Phase_2C-3_Pattern_Analyzer_Design.md §6.1 规则表中的一行。
    """

    rule_id: str
    """唯一标识，格式："{event_type}_to_{pattern_type}[_{variant}]"
    示例：
      "task_completed_to_preferred_time"
      "checkin_submitted_to_session_length"
    """

    source_event_type: str
    """触发此 Rule 的 LearningEvent.event_type（大小写完全匹配）。"""

    target_pattern_type: str
    """目标 LearnerPattern.pattern_type。"""

    target_scope: Literal["user", "skill_category", "goal"]
    """Pattern 所在 scope 层级，决定 upsert 时的查询 key。"""

    base_contribution: float
    """单次 evidence 基础权重（0.0–1.0）。"""

    reliability: float
    """数据来源可靠性（0.0–1.0）。
    客观系统数据 = 0.9（actual_mins, occurred_at）
    系统推算值   = 0.8（days_overdue, debt_created）
    用户自填数据 = 0.6（time_investment_mins, completion_rate）
    """

    condition: str | None = None
    """Python 表达式（在 {"payload": dict, "event": LearningEvent} 上下文中求值）。
    None = 无条件，所有此类事件均触发。
    示例："payload.get('actual_mins', 0) > 0"
    """

    requires_db_join: bool = False
    """True = extract_features 需要查询其他表（如 tasks.estimated_mins）。"""

    description: str = ""
    """人类可读说明，用于文档和调试日志。"""

    # ── 运行时属性 ──────────────────────────────────────────────────────────

    @property
    def contribution(self) -> float:
        """单次 evidence 的实际贡献量 = base_contribution × reliability。"""
        return self.base_contribution * self.reliability

    def condition_check(self, event: "LearningEvent") -> bool:
        """检查事件是否满足此 Rule 的前置条件。

        condition 求值失败时静默返回 False（不抛出异常）。
        """
        if self.condition is None:
            return True
        try:
            payload: dict[str, Any] = event.payload or {}
            return bool(
                eval(self.condition, {"__builtins__": {}}, {"payload": payload, "event": event})
            )
        except Exception:
            return False  # 条件求值失败 → 跳过此 Rule


# ── RuleRegistry ────────────────────────────────────────────────────────────


class RuleRegistry:
    """ExtractionRule 的中心注册表。

    Dispatcher 只与 RuleRegistry 交互，不需要知道具体 Rule 实现。
    新增 Rule 只需调用 register()，无需修改 Dispatcher 代码。
    """

    _rules: dict[str, list[ExtractionRule]] = {}

    @classmethod
    def register(cls, rule: ExtractionRule) -> None:
        """注册一条 Rule。同一 event_type 可有多条 Rule（List 追加）。"""
        cls._rules.setdefault(rule.source_event_type, []).append(rule)

    @classmethod
    def get_rules(cls, event_type: str) -> list[ExtractionRule]:
        """返回绑定到指定 event_type 的所有 Rule（不存在则返回空列表）。"""
        return cls._rules.get(event_type, [])

    @classmethod
    def all_rules(cls) -> list[ExtractionRule]:
        """返回所有已注册的 Rule（顺序不保证）。"""
        return [r for rules in cls._rules.values() for r in rules]

    @classmethod
    def clear(cls) -> None:
        """清空注册表（仅供测试使用）。"""
        cls._rules.clear()


# ── Feature Extractor Registry ──────────────────────────────────────────────


_extractors: dict[str, ExtractorFn] = {}


def register_extractor(rule_id: str):
    """装饰器：将异步函数注册为指定 rule_id 的特征提取器。

    使用示例：
        @register_extractor("task_completed_to_preferred_time")
        async def extract_preferred_time(event, db):
            return {"extracted_hour": event.occurred_at.hour}
    """

    def decorator(fn: ExtractorFn) -> ExtractorFn:
        _extractors[rule_id] = fn
        return fn

    return decorator


async def run_extractor(
    rule_id: str,
    event: "LearningEvent",
    db: "AsyncSession",
) -> dict[str, Any]:
    """运行指定 rule_id 的特征提取器，返回 evidence.meta dict。

    Raises:
        NotImplementedError: 若 rule_id 未注册 extractor。
    """
    extractor = _extractors.get(rule_id)
    if extractor is None:
        raise NotImplementedError(
            f"No extractor registered for rule_id={rule_id!r}. "
            f"Use @register_extractor({rule_id!r}) to register one."
        )
    return await extractor(event, db)
