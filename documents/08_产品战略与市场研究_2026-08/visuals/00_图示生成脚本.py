#!/usr/bin/env python3
"""Build the small, purposeful PlanPilot visual set.

Diagram types are selected by question:
- mind maps: requirements and capability hierarchy;
- object map: product architecture;
- process: evidence-to-decision;
- sequence: supervised AI write path;
- journey: the 16-week career-transition scenario.
"""

from __future__ import annotations

import hashlib
import json
import zipfile
from html import escape
from pathlib import Path


OUT = Path(__file__).resolve().parent
FONT = '-apple-system,BlinkMacSystemFont,"PingFang SC","Noto Sans CJK SC","Microsoft YaHei",sans-serif'

# Reference-image visual language: black ink, white surfaces, lavender intent,
# blue product flow, cyan evidence/data, amber operations, and a restrained rose
# correction signal. Large surfaces stay white with very low-chroma tint.
C = {
    "bg": "#FBFBFF",
    "paper": "#FFFFFF",
    "ink": "#090A24",
    "muted": "#69708A",
    "border": "#DDE0EB",
    "line": "#A8AEC2",
    "purple": "#8272FF",
    "purple_2": "#A99FFF",
    "purple_soft": "#F3F1FF",
    "blue": "#5B74FF",
    "blue_soft": "#EEF1FF",
    "cyan": "#45C7C3",
    "cyan_soft": "#EFFBFA",
    "amber": "#F0A12D",
    "amber_soft": "#FFF8EB",
    "rose": "#D86E86",
    "rose_soft": "#FFF2F5",
}


def node(title: str, *children: dict | str) -> dict:
    return {"title": title, "children": list(children)}


REQUIREMENTS = node(
    "PlanPilot 需求梳理",
    node(
        "用户情境",
        node("在职备考", "考期固定", "每周时间波动", "已有课程或题库"),
        node("职业转型", "16 周作品集", "多来源材料", "结果以作品衡量"),
        node("共同触发", "计划已失真", "中断后难恢复", "完成不能证明掌握"),
    ),
    node(
        "核心任务 JTBD",
        node("开始", "今天只做一件什么事", "低容量时的最小版本"),
        node("恢复", "新容量下怎样继续", "不重写已完成历史"),
        node("验证", "解释 / 练习 / 作品证据", "完成与掌握分开"),
        node("治理", "推断从何而来", "怎样纠正、暂停和删除"),
    ),
    node(
        "根因",
        node("计划失真", "远期拆得过细", "容量约束未显式"),
        node("任务不启动", "任务过大", "缺最小完成版本"),
        node("学习无结果", "只记录勾选", "证据没有关联目标"),
        node("AI 不可信", "事实与推断混用", "没有影响解释和授权边界"),
    ),
    node(
        "P0 闭环",
        node("目标合同", "截止日期", "当前能力", "每周时间", "成功证据"),
        node("滚动计划", "可解释里程碑", "确认后只展开两周"),
        node("今日执行", "一个主任务", "一个最小版本"),
        node("恢复与掌握", "三档恢复", "30–90 秒轻验收"),
        node("可信边界", "写前批准", "写后回读", "记忆可治理"),
    ),
    node(
        "验证与非目标",
        node("行为验证", "10 分钟建立目标", "24 小时首次行动", "72 小时偏差恢复", "7 日掌握结果"),
        node("安全底线", "未批准写入 = 0", "严重跨用户访问 = 0", "纠正影响可见"),
        node("不做", "课程内容库存", "通用待办 / 日历", "全自治代理", "羞耻式留存"),
    ),
)


ARCHITECTURE = node(
    "PlanPilot 产品对象架构",
    node("学习执行主链", "目标", "里程碑", "两周计划", "任务 / 日程", "完成 / 掌握证据"),
    node("上下文与校准", "知识资料", "学习笔记", "学习事件", "学习记忆", "下一轮计划"),
    node("Pilo 与受监督行动", "对话 / 澄清", "行动意图", "变更预览", "风险审查", "用户批准", "执行 / 回读 / 撤销"),
    node("治理边界", "模型负责候选与歧义", "规则负责权限和状态", "用户授权具体变更", "数据库回读负责事实"),
    node("延期归因", "原始延期保留", "外部中断排除有效模式样本", "不判断理由真假", "用户可恢复纳入"),
)


FUNCTIONS = node(
    "PlanPilot 功能拆解",
    node(
        "目标与计划",
        node("目标合同", "目标 / 截止 / 能力 / 容量 / 成功证据"),
        node("里程碑草案", "假设 / 依赖 / 容量冲突 / 用户修改"),
        node("两周窗口", "确认后写入 / 仅展开未来两周"),
        node("异常", "输入不足 / 容量不足 / 生成失败"),
    ),
    node(
        "今日与任务",
        node("今日主任务", "意义 / 时长 / 最小版本 / 所属目标"),
        node("任务动作", "开始 / 完成 / 改期 / 求助"),
        node("恢复", "保底缩小 / 标准重排 / 冲刺保护"),
        node("异常", "无计划 / 未生成 / 全完成 / 加载失败"),
    ),
    node(
        "掌握与作品",
        node("轻验收", "短解释 / 变式练习 / 无提示回忆"),
        node("作品证据", "链接 / 文件 / 版本 / 目标关联"),
        node("状态", "已执行 / 已解释 / 已应用 / 待巩固"),
        node("结果", "证据类型 / 7 日结果 / 用户修正"),
    ),
    node(
        "知识与笔记",
        node("知识资料", "文件 / URL / 索引 / 引用 / 版本"),
        node("学习笔记", "编辑 / 保存 / 目标任务关联 / 快记"),
        node("降级", "向量不可用 → 关键词检索"),
        node("来源", "用户材料 / 行为事实 / 模型常识分开"),
    ),
    node(
        "Pilo 与行动",
        node("对话", "解释 / 比较 / 计划 / 复盘"),
        node("意图分流", "对话 / 澄清 / 受支持行动"),
        node("监督写入", "预览 / 审查 / 批准 / 回读 / 撤销"),
        node("失败", "对象不明 / 模型不可用 / 策略拒绝 / 回读不符"),
    ),
    node(
        "学习记忆",
        node("类型", "用户声明 / 行为事实 / 系统推断 / 临时情境"),
        node("解释", "来源 / 证据窗口 / 证据强度 / 影响"),
        node("治理", "纠正 / 暂停 / 删除 / 延期归因"),
        node("边界", "不判断借口真假 / 原始事实不删除 / 有效样本重算"),
    ),
    node(
        "身份与设置",
        node("身份", "游客本机 / 登录账户 / 不静默合并"),
        node("模型", "本地 / 云端 / 健康状态 / 明确降级"),
        node("隐私", "分目的同意 / 导出 / 删除"),
        node("发布", "白名单 / 灰度 / 门禁 / 紧急停用"),
    ),
)


JOURNEY = node(
    "16 周数据分析转岗作品集用户旅程",
    node("1 建立目标", "输入目标、能力、时间和资料", "产出可验证目标合同"),
    node("2 审查草案", "查看里程碑、假设和容量冲突", "修改后确认"),
    node("3 两周执行", "每天一个主任务和最小版本", "完成后留下掌握证据"),
    node("4 中断恢复", "更新剩余时间", "选择保底 / 标准 / 冲刺"),
    node("5 周复盘", "SQL 稳定", "数据叙事多次延期", "查看任务级证据"),
    node("6 纠正归因", "标记一次延期为出差", "保留延期事实", "排除有效模式样本"),
    node("7 重算模式", "按有效样本重算证据强度", "不把 65% → 38% 硬编码"),
    node("8 校准下轮", "缩小叙事任务", "生成下一两周窗口", "继续验证模式"),
)


def uid(path: str) -> str:
    return "t-" + hashlib.sha1(path.encode("utf-8")).hexdigest()[:12]


def xmind_topic(item: dict | str, path: str, depth: int = 0, branch_index: int = 0) -> dict:
    if isinstance(item, str):
        topic = {"id": uid(path + item), "class": "topic", "title": item}
    else:
        topic = {"id": uid(path + item["title"]), "class": "topic", "title": item["title"]}
        if item.get("children"):
            topic["children"] = {
                "attached": [
                    xmind_topic(
                        child,
                        path + "/" + item["title"],
                        depth + 1,
                        index if depth == 0 else branch_index,
                    )
                    for index, child in enumerate(item["children"])
                ]
            }
    # XMind accepts in-topic style maps; if a client ignores them, the concise
    # hierarchy still opens cleanly instead of relying on a vendor theme.
    branch_palette = [
        (C["purple"], C["purple_soft"]),
        (C["blue"], C["blue_soft"]),
        (C["rose"], C["rose_soft"]),
        (C["cyan"], C["cyan_soft"]),
        (C["amber"], C["amber_soft"]),
    ]
    branch, soft = branch_palette[branch_index % len(branch_palette)]
    if depth == 0:
        topic["style"] = {"fillColor": C["ink"], "textColor": "#FFFFFF", "lineColor": C["blue"], "fontWeight": "700"}
    elif depth == 1:
        topic["style"] = {"fillColor": soft, "textColor": C["ink"], "lineColor": branch, "fontWeight": "600"}
    elif depth == 2:
        topic["style"] = {"fillColor": C["paper"], "textColor": C["ink"], "lineColor": branch, "fontWeight": "500"}
    else:
        topic["style"] = {"fillColor": soft, "textColor": C["ink"], "lineColor": branch, "fontWeight": "400"}
    return topic


def write_xmind(filename: str, title: str, root: dict) -> None:
    sheet_id = uid(filename)
    root_topic = xmind_topic(root, filename)
    root_topic["structureClass"] = "org.xmind.ui.logic.right"
    content = [{"id": sheet_id, "class": "sheet", "title": title, "rootTopic": root_topic}]
    metadata = {
        "creator": {"name": "PlanPilot Product Team", "version": "3.0"},
        "activeSheetId": sheet_id,
        "modified": "2026-08-24T00:00:00+08:00",
    }
    manifest = {"file-entries": {"content.json": {}, "metadata.json": {}}}
    with zipfile.ZipFile(OUT / filename, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("content.json", json.dumps(content, ensure_ascii=False, indent=2))
        zf.writestr("metadata.json", json.dumps(metadata, ensure_ascii=False, indent=2))
        zf.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))


def start(width: int, height: int, title: str, desc: str, kicker: str, subtitle: str) -> list[str]:
    out = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" role="img" aria-labelledby="title desc">',
        f'<title id="title">{escape(title)}</title>',
        f'<desc id="desc">{escape(desc)}</desc>',
        "<defs>",
        '<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FBFAFF"/><stop offset=".58" stop-color="#FFFFFF"/><stop offset="1" stop-color="#F2FFFE"/></linearGradient>',
        '<linearGradient id="flow" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#8272FF"/><stop offset=".52" stop-color="#5B74FF"/><stop offset="1" stop-color="#45C7C3"/></linearGradient>',
        '<filter id="shadow" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="8" stdDeviation="14" flood-color="#77759A" flood-opacity=".12"/></filter>',
        '<marker id="arrow-purple" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto"><path d="M0 0 L10 5 L0 10Z" fill="#8272FF"/></marker>',
        '<marker id="arrow-blue" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto"><path d="M0 0 L10 5 L0 10Z" fill="#5B74FF"/></marker>',
        '<marker id="arrow-cyan" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto"><path d="M0 0 L10 5 L0 10Z" fill="#45C7C3"/></marker>',
        '<marker id="arrow-amber" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto"><path d="M0 0 L10 5 L0 10Z" fill="#F0A12D"/></marker>',
        "<style>",
        f'text{{font-family:{FONT}}}',
        ".title{font-size:56px;font-weight:720;letter-spacing:-2px;fill:#090A24}.subtitle{font-size:24px;font-weight:430;fill:#69708A}.kicker{font-size:18px;font-weight:650;letter-spacing:4px;fill:#8272FF}.section{font-size:26px;font-weight:680;fill:#090A24}.h{font-size:22px;font-weight:650;fill:#090A24}.body{font-size:19px;font-weight:470;fill:#282D49}.small{font-size:18px;font-weight:470;fill:#545C78}.tiny{font-size:16px;font-weight:600;fill:#69708A}.white{fill:#FFFFFF}.panel{fill:#FFFFFF;stroke:#DDE0EB;stroke-width:1.4}.soft-purple{fill:#F3F1FF;stroke:#E5E0FF;stroke-width:1}.soft-blue{fill:#EEF1FF;stroke:#DCE3FF;stroke-width:1}.soft-cyan{fill:#EFFBFA;stroke:#CBEFED;stroke-width:1}.soft-amber{fill:#FFF8EB;stroke:#F7DFB4;stroke-width:1}.soft-rose{fill:#FFF2F5;stroke:#F4D4DC;stroke-width:1}.shadow{filter:url(#shadow)}.line{fill:none;stroke:#A8AEC2;stroke-width:1.6}.purple-line{fill:none;stroke:#8272FF;stroke-width:2;marker-end:url(#arrow-purple)}.blue-line{fill:none;stroke:#5B74FF;stroke-width:2;marker-end:url(#arrow-blue)}.cyan-line{fill:none;stroke:#45C7C3;stroke-width:2;marker-end:url(#arrow-cyan)}.amber-line{fill:none;stroke:#F0A12D;stroke-width:2;stroke-dasharray:7 7;marker-end:url(#arrow-amber)}.lifeline{stroke:#C9CDDA;stroke-width:1.5;stroke-dasharray:6 7}",
        "</style>",
        "</defs>",
        f'<rect width="{width}" height="{height}" fill="url(#bg)"/>',
        f'<text x="64" y="56" class="kicker">{escape(kicker)}</text>',
        f'<text x="64" y="120" class="title">{escape(title)}</text>',
        f'<text x="64" y="162" class="subtitle">{escape(subtitle)}</text>',
        f'<text x="{width - 64}" y="55" text-anchor="end" class="section">PlanPilot</text>',
    ]
    return out


def save(filename: str, out: list[str]) -> None:
    out.append("</svg>")
    (OUT / filename).write_text("\n".join(out) + "\n", encoding="utf-8")


def rect(out: list[str], x: float, y: float, w: float, h: float, cls: str = "panel", rx: float = 16, fill: str | None = None) -> None:
    fill_attr = f' fill="{fill}"' if fill else ""
    out.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" class="{cls}"{fill_attr}/>')


def txt(out: list[str], x: float, y: float, value: str, cls: str = "body", anchor: str = "start") -> None:
    out.append(f'<text x="{x}" y="{y}" class="{cls}" text-anchor="{anchor}">{escape(value)}</text>')


def lines(out: list[str], x: float, y: float, values: list[str], cls: str = "body", gap: int = 27, bullet: bool = False) -> None:
    for i, value in enumerate(values):
        txt(out, x, y + i * gap, ("• " if bullet else "") + value, cls)


def draw_requirement_map() -> None:
    w, h = 2200, 1225
    out = start(w, h, "PlanPilot 需求梳理", "从目标用户的真实问题，收敛到 P0 闭环与可观测验收。", "REQUIREMENT MAP · 2026", "从真实问题收敛到可验证需求；不把功能清单伪装成用户洞察")
    # central axis
    out.append('<path d="M250 296 C610 296 700 296 1030 296 C1370 296 1490 296 1930 296" stroke="url(#flow)" stroke-width="2.5" fill="none"/>')
    stages = [
        (250, "01", "用户情境", "谁在何时需要", C["purple"]),
        (670, "02", "核心任务", "开始 / 恢复 / 验证", C["blue"]),
        (1100, "03", "根因", "问题为何反复发生", C["rose"]),
        (1520, "04", "P0 闭环", "产品必须完成什么", C["cyan"]),
        (1930, "05", "验收边界", "如何决定继续投入", C["amber"]),
    ]
    for x, no, name, sub, color in stages:
        out.append(f'<circle cx="{x}" cy="296" r="20" fill="#FFFFFF" stroke="{color}" stroke-width="1.5"/>')
        out.append(f'<circle cx="{x}" cy="296" r="6" fill="{color}"/>')
        txt(out, x - 50, 250, no, "h")
        txt(out, x, 346, name, "h", "middle")
        txt(out, x, 372, sub, "small", "middle")

    # five columns: only decision-bearing content
    cols = [
        (64, 430, 370, 500, "soft-purple", "用户", [
            ("在职备考", ["考期固定", "每周时间波动"]),
            ("职业转型", ["16 周作品集", "多来源材料"]),
            ("共同触发", ["计划失真", "中断后难恢复", "完成≠掌握"]),
        ]),
        (490, 430, 370, 545, "soft-blue", "JTBD", [
            ("开始", ["今天做哪一件事", "最低配版本是什么"]),
            ("恢复", ["新容量下怎样继续", "保留已完成历史"]),
            ("验证", ["解释 / 练习 / 作品"]),
            ("治理", ["看懂并纠正推断"]),
        ]),
        (916, 430, 370, 545, "soft-rose", "根因", [
            ("计划", ["远期过细", "容量未显式"]),
            ("任务", ["粒度过大", "无最小版本"]),
            ("结果", ["只记录勾选", "证据脱离目标"]),
            ("信任", ["事实/推断混用", "无授权与回读"]),
        ]),
        (1342, 430, 370, 650, "soft-cyan", "P0 产品闭环", [
            ("目标合同", ["截止 / 能力 / 时间 / 证据"]),
            ("滚动计划", ["可解释里程碑", "确认后展开两周"]),
            ("今日执行", ["一个主任务 + 最小版本"]),
            ("恢复与掌握", ["三档恢复", "30–90 秒验收"]),
            ("可信边界", ["批准 / 回读 / 可治理记忆"]),
        ]),
        (1768, 430, 370, 520, "soft-amber", "验证与非目标", [
            ("行为", ["10 分钟目标", "24 小时行动", "72 小时恢复", "7 日掌握结果"]),
            ("安全", ["未批准写入 = 0", "纠正影响可见"]),
            ("不做", ["课程内容库存", "通用待办", "全自治 / 羞耻留存"]),
        ]),
    ]
    for x, y, cw, ch, cls, heading, groups in cols:
        rect(out, x, y, cw, ch, cls + " shadow")
        txt(out, x + 26, y + 45, heading, "section")
        out.append(f'<path d="M{x+26} {y+65} L{x+cw-26} {y+65}" class="line"/>')
        yy = y + 112
        for gh, items in groups:
            txt(out, x + 28, yy, gh, "h")
            lines(out, x + 30, yy + 31, items, "small", 25, True)
            yy += 62 + len(items) * 25
    rect(out, 230, 1120, 1740, 72, "panel", 14)
    txt(out, 260, 1154, "追溯规则", "h")
    txt(out, 395, 1154, "每个 P0 必须回溯到一个真实成本，并绑定行为指标或硬安全底线；否则留在文档，不进入产品表面。", "body")
    save("01_需求梳理思维导图.svg", out)


def draw_evidence_flow() -> None:
    w, h = 2100, 1080
    out = start(w, h, "证据到产品决策", "研究、行为和增量证据怎样共同触发 Go / Hold / Pivot / Stop。", "EVIDENCE FLOW · 2026", "把工程门禁和用户价值分开：安全不达标不能扩量，价值不成立也不能继续堆功能")
    phases = [
        ("01", "问题证据", "真实事件访谈", C["purple"]),
        ("02", "概念证据", "任务成功与误解", C["blue"]),
        ("03", "行为证据", "激活 / 恢复 / 掌握", C["cyan"]),
        ("04", "增量证据", "基线 / 消融 / 成本", C["cyan"]),
        ("05", "阶段决策", "Go / Hold / Pivot / Stop", C["amber"]),
    ]
    y = 285
    for i, (no, name, detail, color) in enumerate(phases):
        x = 70 + i * 400
        txt(out, x + 10, 230, no, "h")
        out.append(f'<circle cx="{x+36}" cy="{y}" r="17" fill="#FFFFFF" stroke="{color}" stroke-width="1.5"/><circle cx="{x+36}" cy="{y}" r="5" fill="{color}"/>')
        if i < len(phases) - 1:
            marker = "purple" if i == 0 else ("blue" if i == 1 else "cyan")
            out.append(f'<path d="M{x+54} {y} L{x+382} {y}" stroke="{color}" stroke-width="2" marker-end="url(#arrow-{marker})"/>')
        rect(out, x, 340, 330, 150, "panel shadow")
        txt(out, x + 24, 382, name, "section")
        txt(out, x + 24, 420, detail, "body")

    # dual gates, then decisions
    rect(out, 220, 600, 710, 245, "soft-purple")
    txt(out, 252, 645, "工程 / 安全门禁", "section")
    lines(out, 252, 690, ["Fast Gate 与当前代码一致", "未批准写入、跨用户、重复写入为零", "回读、撤销、紧急停用可运营"], "body", 37, True)
    rect(out, 980, 600, 710, 245, "soft-cyan")
    txt(out, 1012, 645, "用户 / 商业证据", "section")
    lines(out, 1012, 690, ["24 小时首次行动与 72 小时恢复", "W4/W8 WVLU 与掌握证据", "模型与基础设施成本"], "body", 37, True)
    out.append('<path d="M575 490 L575 590" class="purple-line"/>')
    out.append('<path d="M1335 490 L1335 590" class="cyan-line"/>')
    out.append('<path d="M930 725 L970 725" class="purple-line"/>')
    rect(out, 1738, 600, 292, 245, "soft-amber")
    txt(out, 1768, 645, "决策", "section")
    lines(out, 1768, 692, ["Go｜证据达标", "Hold｜问题成立但体验未过", "Pivot｜长期执行需求弱", "Stop｜无行动 / 恢复 / 留存"], "body", 36)
    out.append('<path d="M1690 725 L1728 725" class="amber-line"/>')
    rect(out, 220, 900, 1810, 78, "panel", 14)
    txt(out, 250, 934, "决策纪律", "h")
    txt(out, 375, 934, "合成评测证明工程合同，不证明用户价值；使用量增长但学习结果不增长，不构成产品进展。", "body")
    save("02_证据与产品决策闭环.svg", out)


def draw_action_sequence() -> None:
    w, h = 2300, 1450
    out = start(w, h, "智能行动时序", "以“把错题复盘移到明天”为例，展示从理解到回读与撤销的受监督写入。", "SUPERVISED ACTION · SEQUENCE", "模型提出候选；规则检查边界；用户授权具体版本；数据库回读确认事实")
    actors = [
        (160, "用户"),
        (500, "Pilo",),
        (860, "意图与规划"),
        (1220, "审查与策略"),
        (1580, "执行器"),
        (1940, "数据库 / 审计"),
    ]
    top, bottom = 250, 1310
    for x, name in actors:
        rect(out, x - 110, top, 220, 58, "panel shadow", 14)
        txt(out, x, top + 37, name, "h", "middle")
        out.append(f'<path d="M{x} {top+58} L{x} {bottom}" class="lifeline"/>')

    events = [
        (360, 160, 500, "把错题复盘移到明天", "purple"),
        (440, 500, 860, "NeedFrame：行动；解析任务与明天日期", "purple"),
        (520, 860, 1940, "读取目标、任务、当前日期", "purple"),
        (600, 1940, 860, "返回当前业务事实", "cyan"),
        (680, 860, 1220, "AgentPlan + ChangeSet（修改前 → 修改后）", "purple"),
        (760, 1220, 500, "Review / Policy：需要用户批准", "purple"),
        (840, 500, 160, "展示影响、风险与具体版本", "purple"),
        (920, 160, 500, "批准当前变更版本", "purple"),
        (1000, 500, 1580, "带批准摘要请求执行", "purple"),
        (1080, 1580, 1940, "租约 + 防重复 + 前置条件后写入", "cyan"),
        (1160, 1940, 1580, "回读真实任务状态", "cyan"),
        (1240, 1580, 500, "已验证完成；状态允许时提供撤销", "cyan"),
    ]
    for y, x1, x2, label, kind in events:
        color = C["purple"] if kind == "purple" else C["cyan"]
        marker = "arrow-purple" if kind == "purple" else "arrow-cyan"
        direction = 1 if x2 > x1 else -1
        end = x2 - direction * 10
        out.append(f'<path d="M{x1} {y} L{end} {y}" stroke="{color}" stroke-width="2" marker-end="url(#{marker})"/>')
        mid = (x1 + x2) / 2
        txt(out, mid, y - 13, label, "small", "middle")

    # branch notes
    rect(out, 720, 545, 560, 86, "soft-amber", 12)
    txt(out, 748, 578, "对象不唯一时", "h")
    txt(out, 885, 578, "保存待补充意图并追问；不创建半成品行动。", "body")
    rect(out, 1130, 1268, 910, 88, "soft-cyan", 12)
    txt(out, 1160, 1302, "验证失败或后续有冲突", "h")
    txt(out, 1390, 1302, "不显示成功；撤销也不会覆盖用户之后的新修改。", "body")
    save("03_智能行动可信责任链.svg", out)


def draw_product_object_map() -> None:
    w, h = 2200, 1370
    out = start(w, h, "PlanPilot 产品对象架构", "用户目标如何连接计划、执行、证据、资料、记忆与受监督行动。", "PRODUCT OBJECT MAP · 2026", "这张图回答对象与状态怎样相连；技术部署另见系统架构图")

    # Primary chain
    txt(out, 70, 235, "01  学习执行主链", "section")
    chain = [
        (110, "目标", "截止 / 能力 / 时间 / 成功证据"),
        (485, "里程碑", "长期阶段与依赖"),
        (860, "两周计划", "用户确认后的近期窗口"),
        (1235, "任务 / 日程", "今日主任务与最小版本"),
        (1610, "完成 / 掌握", "解释 / 练习 / 作品证据"),
    ]
    for i, (x, title, detail) in enumerate(chain):
        rect(out, x, 285, 300, 135, "panel shadow")
        txt(out, x + 24, 327, title, "section")
        txt(out, x + 24, 366, detail, "small")
        if i < len(chain) - 1:
            connector = "purple-line" if i == 0 else ("blue-line" if i == 1 else "cyan-line")
            out.append(f'<path d="M{x+300} 352 L{x+365} 352" class="{connector}"/>')

    # Context below
    txt(out, 70, 520, "02  上下文与校准", "section")
    contexts = [
        (110, "知识资料", ["文件 / URL", "索引 / 引用 / 版本"]),
        (485, "学习笔记", ["目标 / 任务关联", "产出与快记"]),
        (860, "学习事件", ["开始 / 完成 / 偏差", "恢复 / 掌握证据"]),
        (1235, "学习记忆", ["声明 / 事实 / 推断 / 临时", "来源 / 影响 / 可治理"]),
        (1610, "下一轮计划", ["按新容量与证据", "重新展开未来两周"]),
    ]
    for x, title, details in contexts:
        context_cls = "soft-purple" if title in ("知识资料", "学习笔记") else ("soft-blue" if title == "下一轮计划" else "soft-cyan")
        rect(out, x, 570, 300, 145, context_cls)
        txt(out, x + 24, 612, title, "section")
        lines(out, x + 24, 650, details, "small", 26)
    out.append('<path d="M260 570 L260 430" class="cyan-line"/>')
    out.append('<path d="M635 570 L635 430" class="cyan-line"/>')
    out.append('<path d="M1010 430 L1010 560" class="cyan-line"/>')
    out.append('<path d="M1160 642 L1225 642" class="cyan-line"/>')
    out.append('<path d="M1535 642 L1600 642" class="cyan-line"/>')
    out.append('<path d="M1760 570 C1760 470 1010 470 1010 430" class="blue-line"/>')

    # Governance / action bridge
    txt(out, 70, 850, "03  Pilo 与受监督行动", "section")
    rect(out, 110, 900, 1800, 200, "soft-blue shadow")
    steps = [
        (150, "对话 / 澄清"),
        (445, "行动意图"),
        (740, "变更预览"),
        (1035, "风险审查"),
        (1330, "用户批准"),
        (1625, "执行 / 回读 / 撤销"),
    ]
    for i, (x, label) in enumerate(steps):
        rect(out, x, 965, 230, 68, "panel", 13)
        txt(out, x + 115, 1007, label, "body", "middle")
        if i < len(steps) - 1:
            out.append(f'<path d="M{x+230} 999 L{x+285} 999" class="blue-line"/>')
    out.append('<path d="M1510 900 C1510 815 1385 815 1385 725" class="blue-line"/>')

    rect(out, 110, 1170, 1800, 90, "soft-amber", 14)
    txt(out, 142, 1207, "治理边界", "h")
    txt(out, 275, 1207, "模型负责候选与歧义；规则负责权限和状态；用户授权具体变更；数据库回读负责事实。", "body")
    txt(out, 142, 1238, "延期归因", "h")
    txt(out, 275, 1238, "原始延期保留；用户归因只改变有效模式样本，不计算理由真假。", "body")
    save("04_产品架构梳理.svg", out)


def draw_function_map() -> None:
    w, h = 2350, 1250
    out = start(w, h, "PlanPilot 功能拆解", "围绕七个产品能力域，保留对象、核心动作、异常与验收。", "CAPABILITY MIND MAP · 2026", "功能按能力域分组；同一对象只出现一次，状态与异常不重复堆叠")
    center_x, center_y = 1175, 650
    rect(out, center_x - 195, center_y - 74, 390, 148, "soft-blue shadow", 26)
    txt(out, center_x, center_y - 12, "PlanPilot", "section", "middle")
    txt(out, center_x, center_y + 28, "可验证学习执行系统", "h", "middle")
    txt(out, center_x, center_y + 56, "目标 → 行动 → 证据 → 恢复", "small", "middle")
    branches = [
        (90, 235, 500, 220, "01 目标与计划", ["对象｜目标 / 里程碑 / 两周计划", "动作｜建目标 / 审草案 / 确认", "异常｜输入不足 / 容量冲突", "验收｜10 分钟目标 + plan_confirmed"], "purple"),
        (90, 505, 500, 220, "02 今日与任务", ["对象｜主任务 / 最小版本 / 日程", "动作｜开始 / 完成 / 改期 / 求助", "异常｜无计划 / 加载失败", "验收｜30 秒下一步 + 24 小时行动"], "blue"),
        (90, 775, 500, 220, "03 掌握与作品", ["对象｜完成 / 解释 / 练习 / 作品", "动作｜轻验收 / 提交证据", "状态｜执行 / 解释 / 应用 / 待巩固", "验收｜7 日结果可复核"], "cyan"),
        (880, 965, 590, 220, "04 知识与笔记", ["资料｜导入 / 索引 / 引用 / 版本", "笔记｜编辑 / 保存 / 目标任务关联", "降级｜向量不可用 → 关键词", "验收｜来源清楚且不丢草稿"], "cyan"),
        (1760, 775, 500, 220, "05 Pilo 与行动", ["对话｜解释 / 比较 / 计划 / 复盘", "分流｜对话 / 澄清 / 受支持行动", "写入｜预览 / 批准 / 回读 / 撤销", "异常｜对象不明 / 策略拒绝 / 回读不符"], "purple"),
        (1760, 505, 500, 220, "06 学习记忆", ["类型｜声明 / 事实 / 推断 / 临时", "解释｜来源 / 窗口 / 强度 / 影响", "治理｜纠正 / 暂停 / 删除 / 归因", "边界｜不判断借口；重算有效样本"], "rose"),
        (1760, 235, 500, 220, "07 身份与设置", ["身份｜游客本机 / 登录账户", "模型｜本地 / 云端 / 明确降级", "隐私｜同意 / 导出 / 删除", "发布｜白名单 / 门禁 / 紧急停用"], "amber"),
    ]
    for x, y, bw, bh, title, details, kind in branches:
        cls = {"purple": "soft-purple", "blue": "soft-blue", "cyan": "soft-cyan", "amber": "soft-amber", "rose": "soft-rose"}[kind]
        rect(out, x, y, bw, bh, cls + " shadow")
        txt(out, x + 28, y + 43, title, "section")
        lines(out, x + 28, y + 84, details, "small", 31)
        sx = x + bw if x < center_x else x
        sy = y + bh / 2
        ex = center_x - 205 if x < center_x else center_x + 205
        ey = center_y
        color = {"amber": C["amber"], "cyan": C["cyan"], "blue": C["blue"], "rose": C["rose"], "purple": C["purple"]}[kind]
        out.append(f'<path d="M{sx} {sy} C{(sx+ex)/2} {sy} {(sx+ex)/2} {ey} {ex} {ey}" fill="none" stroke="{color}" stroke-width="2"/>')
    rect(out, 760, 190, 790, 72, "panel", 14)
    txt(out, 790, 226, "进入近期范围", "h")
    txt(out, 940, 226, "必须改善首次价值、恢复、掌握、留存或可信之一，并定义验证方法。", "body")
    save("05_功能拆解思维导图.svg", out)


def draw_journey() -> None:
    w, h = 2500, 1440
    out = start(w, h, "16 周数据分析转岗旅程", "从目标建立到两周校准，突出用户决定、系统响应、证据和失效护栏。", "USER JOURNEY · CAREER TRANSITION", "删除重复说明，只保留阶段决策、系统承诺、证据与风险")
    left, top, label_w, col_w = 45, 270, 240, 270
    stages = [
        ("01", "建立目标", "第 0 天", "purple"),
        ("02", "审查草案", "第 0 天", "blue"),
        ("03", "两周执行", "第 1–14 天", "cyan"),
        ("04", "中断恢复", "事件触发", "amber"),
        ("05", "留下证据", "任务后", "cyan"),
        ("06", "周复盘", "每周", "purple"),
        ("07", "纠正归因", "复盘后", "rose"),
        ("08", "校准下轮", "每两周", "blue"),
    ]
    for i, (no, name, timing, kind) in enumerate(stages):
        x = left + label_w + i * col_w
        cls = {"purple": "soft-purple", "blue": "soft-blue", "cyan": "soft-cyan", "amber": "soft-amber", "rose": "soft-rose"}[kind]
        rect(out, x, 220, col_w - 8, 100, cls, 13)
        txt(out, x + 18, 252, no, "h")
        txt(out, x + 18, 283, name, "section")
        txt(out, x + col_w - 28, 306, timing, "tiny", "end")
    lanes = [
        ("用户决定", 150, [
            "输入目标、能力、\n每周时间和资料", "修改里程碑、\n接受关键取舍", "执行主任务；忙时\n选择最小版本", "更新剩余时间；选择\n保底/标准/冲刺", "提交短解释、练习\n结果或作品链接", "判断系统观察\n是否准确", "标记一次延期为\n出差 / 外部中断", "审查下一两周；\n接受或修改建议"
        ]),
        ("系统承诺", 185, [
            "形成目标合同；暴露\n截止、容量和成功证据", "说明假设和冲突；\n确认后只展开两周", "每天只给一个主任务\n和一个最小版本", "展示三档方案的影响；\n保留已完成历史", "按任务类型提供\n30–90 秒轻验收", "展示：SQL 稳定；数据叙事\n多次延期，并列出证据", "保留延期事实；该事件\n排除出有效模式样本", "按新容量与证据；\n缩小叙事任务"
        ]),
        ("形成证据", 155, [
            "Goal + 约束 +\n成功证据定义", "plan_confirmed +\n两周 Task 集", "task_started /\ntask_completed", "deviation + recovery\nselected / completed", "mastery_evidence_added +\n解释 / 练习 / 作品", "支持 / 反向证据 +\n证据时间窗口", "DelayAttributionRecorded +\n重算后的模式", "adjusted pattern +\n下一窗口版本"
        ]),
        ("风险 / 护栏", 210, [
            "风险：像填问卷\n护栏：只采集最小约束", "风险：宏大计划制造新鲜感\n护栏：显示容量与依赖", "风险：任务仍太大\n护栏：连续失败缩小粒度", "风险：重写历史或隐藏代价\n护栏：影响预览后批准", "风险：验收负担过高\n护栏：低价值任务免验收", "风险：相关性贴人格标签\n护栏：展示任务级事实", "风险：判断用户是否找借口\n护栏：事实与解释分离", "风险：65→38 硬编码\n护栏：按样本重算"
        ]),
        ("成功信号", 150, [
            "≤10 分钟形成\n真实目标", "计划确认后立即有\n首项行动", "≤30 秒说出下一步；\n24 小时内开始", "72 小时内恢复；\n维护时间下降", "证据可复核；\n7 日结果可追踪", "用户能解释结论依据；\n接受或纠正", "纠正影响可见；\n无动机羞辱", "两周后叙事推进；\n模式继续可校准"
        ]),
    ]
    y = 350
    for li, (label, lh, cells) in enumerate(lanes):
        fill = C["ink"] if li in (0, 2) else "#30354D"
        out.append(f'<rect x="{left}" y="{y}" width="{label_w-8}" height="{lh}" fill="{fill}"/>')
        txt(out, left + 24, y + 42, label, "h")
        out[-1] = out[-1].replace('class="h"', 'class="h white"')
        for i, cell in enumerate(cells):
            x = left + label_w + i * col_w
            out.append(f'<rect x="{x}" y="{y}" width="{col_w-8}" height="{lh}" fill="#FFFFFF" stroke="#DDE0EB" stroke-width="1"/>')
            lines(out, x + 16, y + 38, cell.split("\n"), "small", 28)
        y += lh
    rect(out, 45, y + 30, 2370, 110, "soft-amber", 14)
    txt(out, 73, y + 70, "归因边界", "h")
    txt(out, 205, y + 70, "系统记录延期事实和用户归因，但不计算‘理由是否真实’；外部中断只改变有效模式样本。", "body")
    txt(out, 205, y + 104, "证据强度按样本重算，不能把 65% → 38% 写成固定业务规则；用户可恢复把事件纳入模式。", "body")
    save("06_用户旅程图_职业转型作品集.svg", out)


def main() -> None:
    draw_requirement_map()
    draw_evidence_flow()
    draw_action_sequence()
    draw_product_object_map()
    draw_function_map()
    draw_journey()
    write_xmind("01_需求梳理思维导图.xmind", "PlanPilot 需求梳理", REQUIREMENTS)
    write_xmind("04_产品架构梳理.xmind", "PlanPilot 产品对象架构", ARCHITECTURE)
    write_xmind("05_功能拆解思维导图.xmind", "PlanPilot 功能拆解", FUNCTIONS)
    write_xmind("06_用户旅程图_职业转型作品集.xmind", "16 周数据分析转岗作品集用户旅程", JOURNEY)


if __name__ == "__main__":
    main()
