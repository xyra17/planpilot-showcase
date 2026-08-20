"""Extraction Rules — Phase 2C-3

每条 Rule 对应 Phase_2C-3_Pattern_Analyzer_Design.md §6.1 规则表中的一行。
Rule 在此包的子模块中声明，模块加载时自动注册到 RuleRegistry。

导入顺序：
  base.py         → ExtractionRule / RuleRegistry / register_extractor
  habit_rules.py  → H-1 ~ H-4（Learning Habit 类）
  perf_rules.py   → P-1 ~ P-2（Performance 类）
  plan_rules.py   → Pl-1 ~ Pl-2（Planning 类）
"""

# 触发各 Rule 模块的自动注册
import src.intelligence.extraction_rules.habit_rules  # noqa: F401
import src.intelligence.extraction_rules.perf_rules  # noqa: F401
import src.intelligence.extraction_rules.plan_rules  # noqa: F401
from src.intelligence.extraction_rules.base import (
    ExtractionRule,
    RuleRegistry,
    register_extractor,
    run_extractor,
)

__all__ = [
    "ExtractionRule",
    "RuleRegistry",
    "register_extractor",
    "run_extractor",
]
