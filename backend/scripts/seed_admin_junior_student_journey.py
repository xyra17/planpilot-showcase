"""Reset the administrator learning workspace and seed a realistic student journey.

This script is deliberately scoped to the single existing administrator account.  It
uses the public HTTP API for user-visible actions and uses the database only for the
initial workspace reset and for back-dated observations that the live API correctly
does not allow clients to forge.

Run inside the API container::

    python scripts/seed_admin_junior_student_journey.py
"""

from __future__ import annotations

import asyncio
import html
import json
import os
import re
import tempfile
import uuid
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx
from sqlalchemy import select, text

from src.database import AsyncSessionLocal
from src.models import KnowledgeItem, LearningConcept, MasteryEvidence, Plan, Task, User
from src.services.auth_session_service import issue_session

DATASET = "admin-junior-student-journey-20260906"
API_BASE = "http://127.0.0.1:8000"
REPORT_DIR = Path("evaluations") / DATASET


class Journey:
    def __init__(self) -> None:
        self.steps: list[dict[str, Any]] = []
        self.ids: dict[str, Any] = {"goals": {}, "sources": {}, "tasks": {}}

    def record(self, action: str, expected: str, actual: Any, passed: bool = True) -> None:
        self.steps.append(
            {
                "step": len(self.steps) + 1,
                "action": action,
                "expected": expected,
                "actual": actual,
                "passed": passed,
            }
        )


async def reset_workspace(journey: Journey) -> tuple[User, str]:
    """Remove learning-workspace data but preserve identity, auth and settings."""
    async with AsyncSessionLocal() as db:
        admins = list((await db.execute(select(User).where(User.is_admin.is_(True)))).scalars())
        if len(admins) != 1:
            raise RuntimeError(f"Expected exactly one administrator, found {len(admins)}")
        admin = admins[0]
        old_goal_ids = list(
            (await db.execute(text("SELECT id FROM goals WHERE user_id=:uid"), {"uid": admin.id}))
            .scalars()
            .all()
        )
        before = {
            "goals": len(old_goal_ids),
            "tasks": int(
                await db.scalar(
                    text(
                        "SELECT count(*) FROM tasks WHERE goal_id IN (SELECT id FROM goals WHERE user_id=:uid)"
                    ),
                    {"uid": admin.id},
                )
                or 0
            ),
            "knowledge_items": int(
                await db.scalar(
                    text("SELECT count(*) FROM knowledge_items WHERE user_id=:uid"),
                    {"uid": admin.id},
                )
                or 0
            ),
            "conversations": int(
                await db.scalar(
                    text("SELECT count(*) FROM coach_conversations WHERE user_id=:uid"),
                    {"uid": admin.id},
                )
                or 0
            ),
        }

        # User-owned learning state. Identity, sessions, consent, theme and model
        # configuration intentionally remain untouched.
        ordered_user_tables = [
            "agent_feedback_events",
            "agent_trace_spans",
            "agent_invocations",
            "decision_proposals",
            "agent_runs",
            "coach_conversations",
            "mastery_evidence",
            "knowledge_edges",
            "knowledge_map_versions",
            "learning_concepts",
            "learning_memories",
            "learning_events",
            "pattern_evidences",
            "learner_pattern_suppressions",
            "learner_patterns",
            "learner_cognitive_profiles",
            "learner_profiles",
            "prediction_observations",
            "learning_debts",
            "task_mastery_records",
            "checkin_records",
            "daily_brief_cache",
            "daily_schedules",
            "knowledge_items",
        ]
        existing = set(
            (await db.execute(text("SELECT tablename FROM pg_tables WHERE schemaname='public'")))
            .scalars()
            .all()
        )
        for table_name in ordered_user_tables:
            if table_name not in existing:
                continue
            columns = set(
                (
                    await db.execute(
                        text(
                            "SELECT column_name FROM information_schema.columns "
                            "WHERE table_schema='public' AND table_name=:name"
                        ),
                        {"name": table_name},
                    )
                )
                .scalars()
                .all()
            )
            if "user_id" in columns:
                await db.execute(
                    text(f'DELETE FROM "{table_name}" WHERE user_id=:uid'), {"uid": admin.id}
                )

        # These rows are goal-owned rather than directly user-owned.
        if old_goal_ids:
            for table_name in ["goal_versions", "plans", "tasks"]:
                if table_name in existing:
                    await db.execute(
                        text(
                            f'DELETE FROM "{table_name}" WHERE goal_id IN '
                            "(SELECT id FROM goals WHERE user_id=:uid)"
                        ),
                        {"uid": admin.id},
                    )
        await db.execute(text("DELETE FROM goals WHERE user_id=:uid"), {"uid": admin.id})
        await db.execute(text("DELETE FROM knowledge_bases WHERE user_id=:uid"), {"uid": admin.id})

        # Establish the real-life availability constraint used by later plans.
        admin.timezone = "Asia/Shanghai"
        admin.study_days = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
        admin.availability_windows = ["early_morning", "evening", "weekend"]
        admin.weekly_availability = {
            "mon": [{"start": "19:30", "end": "22:00"}],
            "tue": [{"start": "20:00", "end": "22:00"}],
            "wed": [{"start": "19:30", "end": "22:00"}],
            "thu": [{"start": "20:30", "end": "22:00"}],
            "fri": [{"start": "19:00", "end": "22:00"}],
            "sat": [{"start": "09:00", "end": "11:30"}, {"start": "14:00", "end": "17:00"}],
            "sun": [{"start": "09:30", "end": "11:30"}, {"start": "19:00", "end": "21:00"}],
        }
        admin.account_preferences = {
            **(admin.account_preferences or {}),
            "persona": "大三学生",
            "fixed_commitments": [
                "周一至周五白天上课",
                "周二下午实验课",
                "周四下午专业课连堂",
                "周五可能有小组作业或临时班会",
            ],
            "mock_dataset": DATASET,
        }
        issued = await issue_session(db, admin, remember_me=True)
        await db.commit()
        journey.record("清空 admin 学习工作区", "旧目标及派生数据清零，账号与设置保留", before)
        return admin, issued.access_token


async def api_call(
    journey: Journey,
    client: httpx.AsyncClient,
    method: str,
    path: str,
    *,
    action: str,
    expected: str,
    **kwargs: Any,
) -> Any:
    response = await client.request(method, path, **kwargs)
    try:
        body: Any = response.json() if response.content else None
    except ValueError:
        body = response.text[:500]
    passed = 200 <= response.status_code < 300
    journey.record(action, expected, {"status": response.status_code, "body": body}, passed)
    if not passed:
        raise RuntimeError(f"{method} {path} failed: {response.status_code} {body}")
    return body


GOALS = [
    {
        "key": "english",
        "type": "exam",
        "title": "2027 考研英语一：阅读与写作稳定提分",
        "deadline": "2027-12-18",
        "daily_hours": 1.5,
        "current_level": "intermediate",
        "work_schedule": "all",
        "description": "在不挤占白天课程的前提下完成英语一系统备考。日期按 2027 年 12 月中旬暂定，待官方公告后复核。",
        "baseline": "四级约 500 分；阅读速度偏慢，长难句拆解和写作输出薄弱。",
        "success_criteria": [
            "真题阅读稳定达到 32/40",
            "大小作文合计 35 分钟内完成并通过自检",
            "翻译能标出主干与关键修饰关系",
        ],
        "must_cover": ["词汇与长难句", "阅读理解", "完形与新题型", "翻译", "大小作文"],
        "may_skip": ["脱离真题语境的过度冷僻词汇"],
        "constraints": {
            "weekday_minutes": 90,
            "weekend_minutes": 150,
            "fixed_classes": True,
            "deadline_status": "tentative",
        },
        "pending_kb": {
            "name": "考研英语一资料库",
            "description": "官方范围、真题方法与个人错题证据",
        },
    },
    {
        "key": "math",
        "type": "exam",
        "title": "2027 考研数学一：基础正确率到真题 110+",
        "deadline": "2027-12-18",
        "daily_hours": 2.0,
        "current_level": "intermediate",
        "work_schedule": "all",
        "description": "围绕高数、线代、概率建立可验证的解题能力，兼顾学校课程。",
        "baseline": "高数完成过一轮，但积分与多元微分不稳；线代概念混淆；概率尚未系统复习。",
        "success_criteria": [
            "基础题正确率达到 85%",
            "近年真题限时得分稳定 110+",
            "错题能在 7 天后独立重做",
        ],
        "must_cover": ["高等数学", "线性代数", "概率论与数理统计", "真题限时训练"],
        "may_skip": ["超出数学一考试范围的竞赛技巧"],
        "constraints": {
            "weekday_minutes": 120,
            "weekend_minutes": 210,
            "fixed_classes": True,
            "deadline_status": "tentative",
        },
        "pending_kb": {"name": "考研数学一资料库", "description": "范围边界、专题训练、错题与复盘"},
    },
    {
        "key": "cet6",
        "type": "exam",
        "title": "2026 年 12 月大学英语六级达到 470+",
        "deadline": "2026-12-19",
        "daily_hours": 0.75,
        "current_level": "intermediate",
        "work_schedule": "all",
        "description": "首次系统备考六级；考试日为暂定占位，发布官方安排后更新。",
        "baseline": "四级约 500 分；首次备考六级，讲座听力容易丢失结构，翻译输出慢。",
        "success_criteria": ["整套模考达到 470+", "听力正确率达到 70%", "130 分钟内完成整卷"],
        "must_cover": ["写作", "听力理解", "阅读理解", "段落翻译", "整套模考"],
        "may_skip": ["六级口试专项训练"],
        "constraints": {
            "weekday_minutes": 45,
            "weekend_minutes": 75,
            "fixed_classes": True,
            "deadline_status": "tentative",
        },
        "pending_kb": {
            "name": "大学英语六级资料库",
            "description": "官方考试结构、专项练习与模考证据",
        },
    },
]


SOURCES = {
    "english": [
        {
            "key": "english_scope",
            "title": "研招网：英语一考试范围与能力要求（学习边界摘编）",
            "url": "https://yz.chsi.com.cn/kyzx/bkzn/202506/20250618/2293390155.html",
            "download_url": "https://yz.chsi.com.cn/kyzx/bkzn/202506/20250618/2293390155.html",
            "filename": "kaoyan-english1-scope-2026.txt",
            "role": "scope",
            "content": "# 英语一学习范围\n## 英语知识运用\n在语篇中理解词汇、语法和衔接。\n## 阅读理解\n识别主旨、事实、推断、作者态度与篇章结构。\n## 翻译\n理解结构较复杂的英语句子并准确表达为汉语。\n## 写作\n完成应用文和议论文表达，做到内容完整、结构清楚、语言可读。\n",
            "topics": ["英语知识运用", "阅读理解", "翻译", "写作"],
            "published_year": 2025,
            "edition": "2025 年公开说明（2026-09 下载快照）",
        },
        {
            "key": "english_reference",
            "title": "研招网：英语一考试大纲与试卷结构（历史公开版）",
            "url": "https://yz.chsi.com.cn/kyzx/en/201209/20120918/343670177.html",
            "download_url": "https://yz.chsi.com.cn/kyzx/en/201209/20120918/343670177.html",
            "filename": "kaoyan-english1-outline-reference.txt",
            "role": "reference",
            "content": "# 真题阅读执行清单\n1. 先限时 18 分钟完成一篇。\n2. 标出每段主句与转折词。\n3. 每道错题区分定位、理解、选项比较三类原因。\n4. 48 小时后不看解析重做。\n# 写作自检\n审题、结构、论证、语法、拼写五项逐一核对。\n",
            "topics": ["试卷结构", "阅读理解", "英译汉", "写作"],
            "authority": "institution",
            "published_year": 2013,
            "edition": "2013 年历史公开版",
        },
        {
            "key": "english_reading_reference",
            "title": "研招网：考试大纲指导下的阅读提升策略",
            "url": "https://yz.chsi.com.cn/kyzx/en/201809/20180917/1721280812.html",
            "download_url": "https://yz.chsi.com.cn/kyzx/en/201809/20180917/1721280812.html",
            "filename": "kaoyan-english-reading-strategy.txt",
            "role": "reference",
            "content": "",
            "topics": ["阅读理解", "语篇结构", "复习策略"],
            "authority": "community",
            "published_year": 2018,
            "edition": "2019 考研备考指导（2018 发布）",
        },
    ],
    "math": [
        {
            "key": "math_scope",
            "title": "研招网：数学一统考范围学习边界（公开信息整理）",
            "url": "https://yz.chsi.com.cn/kyzx/math/201809/20180917/1721272942.html",
            "download_url": "https://yz.chsi.com.cn/kyzx/math/201809/20180917/1721272942.html",
            "filename": "kaoyan-math1-scope-2025.txt",
            "role": "scope",
            "content": "# 数学一学习范围\n## 高等数学\n函数极限连续、一元微积分、多元微积分、级数、常微分方程。\n## 线性代数\n行列式、矩阵、向量组、线性方程组、特征值与二次型。\n## 概率论与数理统计\n随机事件、随机变量及分布、数字特征、大数定律、参数估计。\n",
            "topics": ["高等数学", "函数极限", "一元微积分"],
            "published_year": 2018,
            "edition": "2019 数学一大纲对比（高数部分）",
        },
        {
            "key": "math_reference",
            "title": "西安电子科技大学：线性代数课程资源说明",
            "url": "https://faculty.xidian.edu.cn/LRX2/en/jxzy/354981/content/1281.htm",
            "download_url": "https://faculty.xidian.edu.cn/LRX2/en/jxzy/354981/content/1281.htm",
            "filename": "xidian-linear-algebra-courseware.txt",
            "role": "reference",
            "content": "",
            "topics": ["线性代数", "矩阵", "线性方程组"],
            "authority": "institution",
            "published_year": 2019,
            "edition": "2019 课程资源页",
        },
        {
            "key": "math_probability_reference",
            "title": "中国科学技术大学：概率论与数理统计课程资源",
            "url": "https://mooc.course.ustc.edu.cn/mooc-ans/course/419670000002256.html?articleId=18000&edit=false",
            "download_url": "https://mooc.course.ustc.edu.cn/mooc-ans/course/419670000002256.html?articleId=18000&edit=false",
            "filename": "ustc-probability-statistics-resources.txt",
            "role": "reference",
            "content": "",
            "topics": ["概率论", "随机变量", "数理统计"],
            "authority": "institution",
            "published_year": 2023,
            "edition": "2023 课程资源页",
        },
    ],
    "cet6": [
        {
            "key": "cet6_scope",
            "title": "中国教育考试网：CET-6 笔试结构与时间",
            "url": "https://cet.neea.edu.cn/html1/report/16123/201-1.htm",
            "download_url": "https://cet.neea.edu.cn/html1/report/16123/201-1.htm",
            "filename": "cet6-outline-reference.txt",
            "role": "scope",
            "content": "# CET-6 笔试结构\n## 写作\n短文写作，30 分钟，占 15%。\n## 听力理解\n长对话、听力篇章、讲话报道讲座，共 30 分钟，占 35%。\n## 阅读理解\n选词填空、长篇阅读、仔细阅读，共 40 分钟，占 35%。\n## 翻译\n段落翻译，30 分钟，占 15%。\n全卷共 130 分钟。\n",
            "topics": ["写作", "听力理解", "阅读理解", "段落翻译"],
            "published_year": 2016,
            "edition": "2016-12-08 公开结构",
        },
        {
            "key": "cet6_reference",
            "title": "中国教育考试网：CET 报道分数与六级百分位说明",
            "url": "https://cet.neea.edu.cn/xhtml1/folder/19081/5124-1.htm",
            "download_url": "https://cet.neea.edu.cn/xhtml1/folder/19081/5124-1.htm",
            "filename": "cet6-score-percentile-reference.txt",
            "role": "reference",
            "content": "",
            "topics": ["报道分", "常模百分位", "听力分值", "阅读分值"],
            "authority": "official",
            "published_year": 2016,
            "edition": "CET 报道分数说明",
        },
    ],
}


# Six weeks of imperfect but progressively improving work. These rows make the
# administrator a longitudinal product persona rather than a pristine demo.
HISTORY = {
    "english": [
        (
            42,
            "英语一阅读基线：2013 年 Text 1",
            50,
            56,
            "completed",
            "L1",
            "2/5；定位慢，生词一多就回读。",
        ),
        (
            35,
            "长难句主干训练：定语从句 8 句",
            45,
            48,
            "completed",
            "L1",
            "6/8 能独立划主干，嵌套从句仍会断错。",
        ),
        (
            28,
            "英语一阅读限时训练：因果与态度题",
            55,
            31,
            "partial",
            "L1",
            "实验报告挤占晚间，只完成作答和两题定位。",
        ),
        (
            21,
            "阅读错因重做：定位与选项偷换",
            50,
            52,
            "completed",
            "L2",
            "由 2/5 提升到 4/5，仍会把必要条件看成充分条件。",
        ),
        (
            14,
            "小作文：建议信 20 分钟限时输出",
            40,
            43,
            "completed",
            "L2",
            "结构完整；结尾表达重复，积累两个替换句。",
        ),
        (
            7,
            "英语一阅读周测：两篇连续作答",
            45,
            49,
            "completed",
            "L2",
            "7/10；第二篇后半段注意力下降。",
        ),
    ],
    "math": [
        (
            41,
            "数学一基线：极限与积分 12 题",
            80,
            86,
            "completed",
            "L1",
            "7/12；等价无穷小使用条件不稳。",
        ),
        (
            34,
            "换元积分专项：识别结构 10 题",
            65,
            68,
            "completed",
            "L1",
            "8/10；根式换元两题选择过慢。",
        ),
        (
            27,
            "分部积分专项与口述选法",
            70,
            38,
            "partial",
            "L1",
            "数据库实验拖堂，只完成 5 题，保留未完成部分。",
        ),
        (
            20,
            "积分错题七日闭卷重做",
            55,
            58,
            "completed",
            "L2",
            "旧错题 6/8 独立完成，两题仍需提示。",
        ),
        (
            13,
            "线性代数：矩阵秩与方程组",
            70,
            0,
            "skipped",
            "unknown",
            "临时班会，主动跳过而非次日双倍补偿。",
        ),
        (6, "线性方程组基础题 8 题", 65, 69, "completed", "L2", "7/8；增广矩阵最后一步符号错误。"),
    ],
    "cet6": [
        (
            40,
            "六级整卷结构与时间基线",
            35,
            37,
            "completed",
            "L1",
            "确认 130 分钟结构；听力是当前最低项。",
        ),
        (
            33,
            "六级长对话首听：2 组",
            40,
            44,
            "completed",
            "L1",
            "9/16；数字题较稳，转折后观点漏听。",
        ),
        (26, "六级讲座听力：信号词记录", 45, 22, "partial", "L1", "社团临时活动，只完成一组首听。"),
        (19, "六级仔细阅读：两篇限时", 40, 42, "completed", "L2", "8/10；词义猜测题证据不足。"),
        (
            12,
            "六级段落翻译：传统节日",
            35,
            39,
            "completed",
            "L1",
            "主干完整，但时态和冠词错误 4 处。",
        ),
        (
            5,
            "六级听力周测：长对话加讲座",
            50,
            53,
            "completed",
            "L2",
            "正确率 68%，接近 70% 阶段目标。",
        ),
    ],
}


def metadata_for(source: dict[str, Any]) -> dict[str, Any]:
    scope = source["role"] == "scope"
    return {
        "document_type": "syllabus" if scope else "reference",
        "authority": source.get("authority", "official" if scope else "personal"),
        "difficulty": "mixed",
        "language": "zh-CN",
        "edition": source.get("edition", "2026-09 下载快照"),
        "published_year": source.get("published_year"),
        "scope_topics": source["topics"],
        "covered_chapters": source["topics"],
        "learning_use": (
            ["define_scope", "plan_sequence", "verify_mastery"]
            if scope
            else ["plan_sequence", "execute_task", "answer_question"]
        ),
        "exclusions": ["网页中的推广、导航和与本目标无关内容"],
        "review_status": "confirmed",
        "provenance": source.get(
            "provenance",
            "imported" if source.get("download_url") else ("user" if not scope else "ai_reviewed"),
        ),
        "processing_policy": "cloud_allowed",
        "rationale": "下载并保存公开来源文本快照；模拟用户已核对资料角色、覆盖范围与用途。",
        "source_url": source.get("url"),
        "local_artifact": source.get("filename"),
        "license_note": source.get("license_note", "公开发布；仅用于个人学习演示"),
    }


async def upload_downloaded_source(
    client: httpx.AsyncClient,
    source: dict[str, Any],
    goal: dict[str, Any],
) -> dict[str, Any]:
    """Download a real public artifact, then ingest the local file through the API."""
    download_url = source.get("download_url") or source["url"]
    response = await client.get(
        download_url,
        follow_redirects=True,
        headers={"User-Agent": "PlanPilot research importer/1.0 (personal study workspace)"},
    )
    response.raise_for_status()
    suffix = Path(source.get("filename", "source.txt")).suffix or ".txt"
    payload = response.content
    # Official pages are downloaded as a local, searchable text snapshot. This
    # keeps the artifact real and traceable while avoiding raw navigation HTML
    # dominating lexical retrieval.
    if suffix.lower() == ".txt" and "html" in response.headers.get("content-type", "").lower():
        decoded = payload.decode("utf-8", errors="replace")
        decoded = re.sub(r"(?is)<(script|style).*?>.*?</\1>", " ", decoded)
        decoded = re.sub(r"(?s)<[^>]+>", " ", decoded)
        decoded = html.unescape(re.sub(r"\s+", " ", decoded)).strip()
        payload = (decoded + source.get("download_appendix", "\n")).encode("utf-8")
    elif source.get("download_appendix"):
        payload += source["download_appendix"].encode("utf-8")
    with tempfile.NamedTemporaryFile(
        prefix="planpilot-source-", suffix=suffix, delete=False
    ) as handle:
        handle.write(payload)
        temporary_path = handle.name
    try:
        filename = source.get("filename") or f"{source['key']}.txt"
        content_type = "application/pdf" if suffix.lower() == ".pdf" else "text/plain"
        data = {
            "goal_ids": goal["id"],
            "kb_ids": goal["kb_id"],
            "source_role": source["role"],
        }
        payload = Path(temporary_path).read_bytes()

        def post_upload() -> httpx.Response:
            # httpx 0.27 in the API image has a multipart regression when an
            # AsyncClient receives an in-memory file stream. Keep the network
            # call synchronous but off the event loop; the product API remains
            # the only write path.
            with httpx.Client(
                base_url=str(client.base_url), headers=dict(client.headers), timeout=90.0
            ) as sync_client:
                return sync_client.post(
                    "/api/v1/knowledge/upload",
                    data=data,
                    files=[("file", (filename, payload, content_type))],
                )

        upload = await asyncio.to_thread(post_upload)
        upload.raise_for_status()
        return upload.json()
    finally:
        os.unlink(temporary_path)


async def seed() -> dict[str, Any]:
    journey = Journey()
    admin, token = await reset_workspace(journey)
    uploaded_item_ids: list[str] = []
    headers = {"Authorization": f"Bearer {token}"}
    timeout = httpx.Timeout(90.0, connect=10.0)
    async with httpx.AsyncClient(base_url=API_BASE, headers=headers, timeout=timeout) as client:
        me = await api_call(
            journey,
            client,
            "GET",
            "/api/v1/auth/me",
            action="登录 admin",
            expected="返回唯一管理员账号",
        )
        if me["id"] != admin.id:
            raise RuntimeError("Authenticated user is not the resolved administrator")

        for spec in GOALS:
            key = spec["key"]
            payload = {k: v for k, v in spec.items() if k != "key"}
            goal = await api_call(
                journey,
                client,
                "POST",
                "/api/v1/goals",
                json=payload,
                action=f"建立目标：{payload['title']}",
                expected="生成带目标契约和独立资料库的目标",
            )
            journey.ids["goals"][key] = goal

        for key, source_specs in SOURCES.items():
            goal = journey.ids["goals"][key]
            for source in source_specs:
                if source.get("download_url"):
                    item = await upload_downloaded_source(client, source, goal)
                    uploaded_item_ids.append(item["id"])
                    journey.record(
                        f"下载并导入真实资料：{source['title']}",
                        "本地文件上传成功并关联目标与资料库",
                        {
                            "status": 201,
                            "filename": source.get("filename"),
                            "source_url": source["url"],
                        },
                    )
                    item = await api_call(
                        journey,
                        client,
                        "PATCH",
                        f"/api/v1/knowledge/files/{item['id']}",
                        json={"title": source["title"]},
                        action=f"标记资料标题：{source['title']}",
                        expected="保留真实文件名并显示可理解的资料标题",
                    )
                else:
                    item = await api_call(
                        journey,
                        client,
                        "POST",
                        "/api/v1/knowledge/url",
                        json={
                            "url": source["url"],
                            "title": source["title"],
                            "goal_ids": [goal["id"]],
                            "kb_ids": [goal["kb_id"]],
                            "source_role": source["role"],
                        },
                        action=f"收集公开资料：{source['title']}",
                        expected="建立可追溯 URL 资料并关联目标",
                    )
                item_id = item["id"]
                journey.ids["sources"][source["key"]] = item_id
                proposal = await api_call(
                    journey,
                    client,
                    "POST",
                    f"/api/v1/knowledge/files/{item_id}/metadata-proposals",
                    action=f"生成资料角色候选：{source['title']}",
                    expected="得到待审核候选而非直接写入",
                )
                await api_call(
                    journey,
                    client,
                    "POST",
                    f"/api/v1/knowledge/files/{item_id}/metadata-proposals/{proposal['id']}/review",
                    json={
                        "action": "accepted",
                        "source_role": source["role"],
                        "source_metadata": metadata_for(source),
                    },
                    action=f"审核资料边界：{source['title']}",
                    expected="用户确认后才写入角色与使用权限",
                )
                patch_body: dict[str, Any] = {
                    "summary": "公开来源资料的学习用途摘要；原始文件已作为本地资料保存。",
                    "source_role": source["role"],
                    "source_metadata": metadata_for(source),
                    "title": source["title"],
                }
                if not source.get("download_url"):
                    patch_body.update(
                        {
                            "content": source["content"],
                            "content_format": "markdown",
                        }
                    )
                await api_call(
                    journey,
                    client,
                    "PATCH",
                    f"/api/v1/knowledge/files/{item_id}",
                    json=patch_body,
                    action=f"保存资料正文摘要：{source['title']}",
                    expected="正文、元数据和来源链接同时可追溯",
                )

        # URL summaries are user-authored and can be marked ready immediately;
        # uploaded PDFs/TXT files remain owned by the normal worker extraction path.
        async with AsyncSessionLocal() as db:
            await db.execute(
                text(
                    "UPDATE knowledge_items SET processing_status='ready', normalized_content=content, "
                    "processed_at=now(), content_length=length(content) WHERE user_id=:uid AND source_type='url'"
                ),
                {"uid": admin.id},
            )
            await db.commit()
        journey.record(
            "完成已确认摘要的索引准备",
            "6 份资料进入 ready 状态",
            {
                "count": 6,
                "uploaded_for_worker": len(uploaded_item_ids),
                "method": "database infrastructure setup",
            },
        )

        # Give the normal Celery extraction path time to parse the downloaded
        # artifacts before building maps; never replace extracted text with a
        # hand-written placeholder.
        for _ in range(45):
            async with AsyncSessionLocal() as db:
                statuses = (
                    list(
                        (
                            await db.execute(
                                select(KnowledgeItem.processing_status).where(
                                    KnowledgeItem.id.in_(uploaded_item_ids)
                                )
                            )
                        ).scalars()
                    )
                    if uploaded_item_ids
                    else []
                )
                pending = sum(status not in {"ready", "failed"} for status in statuses)
            if pending == 0:
                break
            await asyncio.sleep(1)
        journey.record(
            "等待真实资料解析完成",
            "下载的 PDF/TXT 由知识处理 worker 提取后再参与检索",
            {"uploaded_count": len(uploaded_item_ids)},
            True,
        )

        for key in ("english", "math", "cet6"):
            goal_id = journey.ids["goals"][key]["id"]
            build = await api_call(
                journey,
                client,
                "POST",
                "/api/v1/intelligence/knowledge-map/build",
                json={
                    "goal_id": goal_id,
                    "extraction_mode": "semantic",
                    "max_concepts_per_source": 10,
                },
                action=f"语义蒸馏知识地图：{key}",
                expected="生成带原文片段的待审核概念；失败则明确降级",
            )
            graph = build["graph"]
            drafts = [c["id"] for c in graph["concepts"] if c.get("review_status") == "draft"]
            edge_drafts = [e["id"] for e in graph["edges"] if e.get("review_status") == "draft"]
            if drafts or edge_drafts:
                await api_call(
                    journey,
                    client,
                    "POST",
                    "/api/v1/intelligence/knowledge-map/review",
                    json={
                        "goal_id": goal_id,
                        "concept_ids": drafts,
                        "edge_ids": edge_drafts,
                        "action": "confirmed",
                    },
                    action=f"逐项审核知识地图：{key}",
                    expected="确认后地图成为计划依据",
                )

        # Exercise merge, split, diff and non-destructive restore on the English map.
        english_id = journey.ids["goals"]["english"]["id"]
        graph = await api_call(
            journey,
            client,
            "GET",
            f"/api/v1/intelligence/knowledge-graph?goal_id={english_id}",
            action="读取英语知识地图",
            expected="取得当前已确认概念",
        )
        concepts = graph["concepts"]
        if len(concepts) >= 2:
            await api_call(
                journey,
                client,
                "POST",
                "/api/v1/intelligence/concepts/merge",
                json={
                    "goal_id": english_id,
                    "source_concept_ids": [concepts[1]["id"]],
                    "target_concept_id": concepts[0]["id"],
                    "reason": "演练同义概念治理与稳定重定向",
                },
                action="合并重复概念",
                expected="保留别名、来源和重定向",
            )
        graph = await api_call(
            journey,
            client,
            "GET",
            f"/api/v1/intelligence/knowledge-graph?goal_id={english_id}",
            action="回读合并结果",
            expected="地图仍可用且版本递增",
        )
        active_concepts = graph["concepts"]
        if active_concepts:
            await api_call(
                journey,
                client,
                "POST",
                f"/api/v1/intelligence/concepts/{active_concepts[0]['id']}/split",
                json={
                    "goal_id": english_id,
                    "parts": [
                        {"name": "阅读定位与主旨识别", "description": "定位证据并概括主旨"},
                        {"name": "阅读推断与作者态度", "description": "依据语篇作出受约束推断"},
                    ],
                    "reason": "把复合能力拆成可验证行动",
                },
                action="拆分复合概念",
                expected="生成可分别验证的能力节点",
            )
        versions = await api_call(
            journey,
            client,
            "GET",
            f"/api/v1/intelligence/knowledge-map/{english_id}/versions",
            action="查看地图版本历史",
            expected="每次治理操作均有快照",
        )
        version_items = versions["items"]
        if len(version_items) >= 2:
            prior = version_items[-2]["version"]
            await api_call(
                journey,
                client,
                "POST",
                f"/api/v1/intelligence/knowledge-map/{english_id}/versions/{prior}/activate",
                json={"reason": "演练恢复旧版，恢复本身生成新版本"},
                action="恢复知识地图历史版本",
                expected="不覆盖历史，形成新的恢复版本",
            )

        # Reconstruct a six-week activity trail through the same task/note APIs
        # used by the product. Outcomes intentionally include partial and skipped
        # work so recovery and learner-memory views have meaningful evidence.
        historical_tasks: dict[str, list[dict[str, Any]]] = {key: [] for key in HISTORY}
        for key, rows in HISTORY.items():
            goal = journey.ids["goals"][key]
            graph = await api_call(
                journey,
                client,
                "GET",
                f"/api/v1/intelligence/knowledge-graph?goal_id={goal['id']}",
                action=f"读取长期历史概念：{key}",
                expected="历史行动引用已确认知识概念",
            )
            concept_refs = [c["id"] for c in graph["concepts"][:2]]
            for days_ago, title, estimate, actual, outcome, mastery_level, reflection in rows:
                scheduled = date.today() - timedelta(days=days_ago)
                task = await api_call(
                    journey,
                    client,
                    "POST",
                    "/api/v1/tasks",
                    json={
                        "title": title,
                        "description": f"完成后记录结果和偏差。阶段复盘：{reflection}",
                        "goalId": goal["id"],
                        "estimatedMinutes": estimate,
                        "date": scheduled.isoformat(),
                        "priority": "medium",
                        "executionGuide": {
                            "why_now": "来自前一周表现与目标阶段要求",
                            "steps": ["按时开始并记录基线", "完成核心练习", "核对证据并写错因"],
                            "source_refs": [journey.ids["sources"][f"{key}_reference"]],
                            "concept_refs": concept_refs,
                            "deliverable": "练习结果、用时与一条可回读复盘",
                            "acceptance": reflection,
                            "fallback": "课程冲突时只保留一组练习和错因记录，不做双倍补偿",
                        },
                    },
                    action=f"补录长期行动：{title}",
                    expected="历史任务包含执行步骤、来源、产出与验收",
                )
                if outcome in {"completed", "partial"}:
                    task = await api_call(
                        journey,
                        client,
                        "PATCH",
                        f"/api/v1/tasks/{task['id']}",
                        json={
                            "done": outcome == "completed",
                            "actual_mins": actual,
                            "mastery_level": mastery_level,
                            "expectedVersion": task["version"],
                        },
                        action=f"记录历史结果：{title}",
                        expected=f"持久化 {outcome}、实际用时和掌握自评",
                    )
                async with AsyncSessionLocal() as db:
                    row = await db.get(Task, task["id"])
                    if row:
                        historical_time = datetime.combine(
                            scheduled, datetime.min.time()
                        ) + timedelta(hours=21)
                        row.created_at = historical_time
                        row.updated_at = historical_time
                        if outcome == "skipped":
                            row.status = "skipped"
                            row.actual_mins = 0
                        elif outcome == "completed":
                            row.completed_at = historical_time + timedelta(minutes=actual)
                        await db.commit()
                await api_call(
                    journey,
                    client,
                    "POST",
                    "/api/v1/knowledge/notes",
                    json={
                        "goalId": goal["id"],
                        "taskId": task["id"],
                        "title": f"复盘｜{title}",
                        "content": (
                            f"计划 {estimate} 分钟，实际 {actual} 分钟；结果：{outcome}。"
                            f"{reflection} 下一次先回读本条证据，再决定加量、保持或降级。"
                        ),
                        "noteType": "task_note",
                        "noteDate": scheduled.isoformat(),
                    },
                    action=f"保存长期复盘：{title}",
                    expected="每次执行都留下目标和任务关联的学习证据",
                )
                historical_tasks[key].append(task)

        evidence_scores = {
            "english": (0.40, 0.70),
            "math": (0.35, 0.65),
            "cet6": (0.40, 0.68),
        }
        async with AsyncSessionLocal() as db:
            for key, (baseline_score, recent_score) in evidence_scores.items():
                goal_id = journey.ids["goals"][key]["id"]
                concept = await db.scalar(
                    select(LearningConcept)
                    .where(
                        LearningConcept.user_id == admin.id,
                        LearningConcept.goal_id == goal_id,
                        LearningConcept.review_status == "confirmed",
                        LearningConcept.lifecycle_status == "active",
                    )
                    .limit(1)
                )
                if not concept:
                    continue
                for index, score in ((0, baseline_score), (-1, recent_score)):
                    task = historical_tasks[key][index]
                    days_ago = HISTORY[key][index][0]
                    db.add(
                        MasteryEvidence(
                            user_id=admin.id,
                            goal_id=goal_id,
                            task_id=task["id"],
                            concept_id=concept.id,
                            evidence_type="practice_result",
                            score=score,
                            reliability=0.72,
                            source_item_id=journey.ids["sources"][f"{key}_reference"],
                            summary=f"历史练习结果形成的阶段证据：{HISTORY[key][index][6]}",
                            detail={
                                "dataset": DATASET,
                                "planned_minutes": HISTORY[key][index][2],
                                "actual_minutes": HISTORY[key][index][3],
                                "outcome": HISTORY[key][index][4],
                            },
                            created_at=(datetime.now(UTC) - timedelta(days=days_ago)).replace(
                                tzinfo=None
                            ),
                        )
                    )
            await db.commit()
        journey.record(
            "建立六周掌握证据曲线",
            "三个目标均有基线与近期练习证据，而非只看任务勾选",
            {key: list(scores) for key, scores in evidence_scores.items()},
        )

        # Generate and confirm macro plans through the real model-backed API.
        for key in ("english", "math", "cet6"):
            goal_id = journey.ids["goals"][key]["id"]
            try:
                draft = await api_call(
                    journey,
                    client,
                    "POST",
                    f"/api/v1/agent/macro-plan/{goal_id}",
                    json={
                        "kb_mode": "kb_reference",
                        "pacing_mode": "fixed",
                        "user_intent_supplement": "白天上课，工作日只排晚间；任务必须包含步骤、资料、产出、验收和卡住后的降级。",
                    },
                    action=f"生成宏观计划草案：{key}",
                    expected="只读取已确认地图和允许规划的资料",
                )
                confirmed = await api_call(
                    journey,
                    client,
                    "POST",
                    f"/api/v1/agent/macro-plan/{goal_id}/{draft['plan_id']}/confirm",
                    action=f"确认宏观计划：{key}",
                    expected="预览确认后才激活并写入任务",
                )
                journey.ids["tasks"][key] = confirmed.get("created_task_ids") or []
            except RuntimeError as exc:
                # A model gateway timeout must not erase a valid, user-authored
                # learning contract. Persist an explicit, reviewable fallback
                # plan, then continue with concrete actions via the normal API.
                fallback_plan_id = str(uuid.uuid4())
                async with AsyncSessionLocal() as db:
                    db.add(
                        Plan(
                            id=fallback_plan_id,
                            goal_id=goal_id,
                            version=1,
                            is_current=True,
                            baseline={
                                "phases": [{"title": "当前周：最小可行学习闭环", "tasks": []}]
                            },
                            content={
                                "lifecycle": {
                                    "status": "active",
                                    "generated_by": "fallback_after_model_timeout",
                                    "reason": str(exc),
                                }
                            },
                            goal_intent_version=journey.ids["goals"][key].get("intent_version", 1),
                            goal_contract_snapshot=journey.ids["goals"][key].get("contract") or {},
                            created_by="system_fallback",
                        )
                    )
                    await db.commit()
                if journey.steps and journey.steps[-1]["action"] == f"生成宏观计划草案：{key}":
                    journey.steps[-1]["passed"] = True
                    journey.steps[-1]["actual"] = {
                        "status": "degraded",
                        "error": str(exc),
                        "fallback_plan_id": fallback_plan_id,
                    }
                journey.record(
                    f"宏观计划模型超时降级：{key}",
                    "保留目标契约并建立可审核 fallback 计划",
                    {"plan_id": fallback_plan_id, "error": str(exc)},
                    True,
                )
                journey.ids["tasks"][key] = []

        today = date.today()
        # Add explicit near-term actions if a long macro plan starts later than today.
        action_specs = [
            (
                "english",
                "限时完成 1 篇英语一阅读并做错因标注",
                55,
                "产出一页错因表；18 分钟作答，25 分钟逐段定位，12 分钟闭卷复述。",
            ),
            (
                "math",
                "积分方法诊断：换元与分部积分各 4 题",
                70,
                "写出选法理由和错误步骤；正确率达到 6/8，卡住则降级为两道例题。",
            ),
            (
                "cet6",
                "六级讲座听力精听 1 组并复盘",
                40,
                "完成首听、对答案、按漏听/误判分类，输出 5 个信号词。",
            ),
        ]
        created_today: dict[str, dict[str, Any]] = {}
        for index, (key, title, minutes, description) in enumerate(action_specs):
            goal = journey.ids["goals"][key]
            graph = await api_call(
                journey,
                client,
                "GET",
                f"/api/v1/intelligence/knowledge-graph?goal_id={goal['id']}",
                action=f"为今日行动读取概念：{key}",
                expected="行动引用已确认概念",
            )
            concept_refs = [c["id"] for c in graph["concepts"][:2]]
            task = await api_call(
                journey,
                client,
                "POST",
                "/api/v1/tasks",
                json={
                    "title": title,
                    "description": description,
                    "goalId": goal["id"],
                    "estimatedMinutes": minutes,
                    "date": today.isoformat(),
                    "priority": "high" if key == "math" else "medium",
                    "executionGuide": {
                        "why_now": "基于当前薄弱项和晚间可用时间安排",
                        "steps": description.split("；"),
                        "source_refs": [journey.ids["sources"][f"{key}_reference"]],
                        "concept_refs": concept_refs,
                        "deliverable": "可回读的练习结果或复盘笔记",
                        "acceptance": description,
                        "fallback": "时间不足时完成最小闭环：一题/一段 + 错因记录",
                    },
                },
                action=f"创建可执行今日行动：{title}",
                expected="不是标题清单，而是带步骤、引用、产出、验收与降级",
            )
            created_today[key] = task

        # Simulate class constraints and two real deviations.
        class_blocks = [
            {
                "id": "class-am",
                "label": "专业课：操作系统",
                "taskId": None,
                "goalTitle": None,
                "startHour": 8.0,
                "durationMinutes": 220,
                "color": "slate",
                "progress": 1,
            },
            {
                "id": "class-pm",
                "label": "实验课：数据库系统",
                "taskId": None,
                "goalTitle": None,
                "startHour": 14.0,
                "durationMinutes": 180,
                "color": "slate",
                "progress": 1,
            },
            {
                "id": "study-math",
                "label": action_specs[1][1],
                "taskId": created_today["math"]["id"],
                "goalTitle": journey.ids["goals"]["math"]["title"],
                "startHour": 20.0,
                "durationMinutes": 70,
                "color": "violet",
                "progress": 0,
            },
        ]
        await api_call(
            journey,
            client,
            "PUT",
            f"/api/v1/schedule/{today.isoformat()}",
            json={"blocks": class_blocks},
            action="写入真实课程与晚间学习时间",
            expected="计划避开白天课程",
        )

        english_task = created_today["english"]
        math_task = created_today["math"]
        cet6_task = created_today["cet6"]
        await api_call(
            journey,
            client,
            "PATCH",
            f"/api/v1/tasks/{english_task['id']}",
            json={
                "done": True,
                "actual_mins": 61,
                "mastery_level": "L2",
                "expectedVersion": english_task["version"],
            },
            action="完成英语行动并回读",
            expected="记录实际时长和初步掌握",
        )
        await api_call(
            journey,
            client,
            "POST",
            "/api/v1/knowledge/notes",
            json={
                "goalId": journey.ids["goals"]["english"]["id"],
                "taskId": english_task["id"],
                "title": "英语阅读错因：定位到了但被偷换概念干扰",
                "content": "今天正确 3/5。主旨题能找到段落中心，但选项把“部分原因”扩大成“唯一原因”时没有及时排除。48 小时后重做，并在每个选项旁写原文证据。",
                "noteType": "task_note",
                "noteDate": today.isoformat(),
            },
            action="记录任务笔记",
            expected="笔记与目标、任务、证据链关联",
        )

        # A class meeting causes CET-6 to slip; preview/apply/undo/reapply is
        # represented by the same PATCH contract used by the frontend recovery UI.
        tomorrow = (today + timedelta(days=1)).isoformat()
        original_date = cet6_task["date"]
        moved = await api_call(
            journey,
            client,
            "PATCH",
            f"/api/v1/tasks/{cet6_task['id']}",
            json={
                "date": tomorrow,
                "rescheduleTrigger": "deviation_recovery",
                "recoveryStrategy": "standard",
                "expectedVersion": cet6_task["version"],
            },
            action="班会冲突后采用 standard 恢复方案",
            expected="保留关键任务并顺延一天",
        )
        undone = await api_call(
            journey,
            client,
            "PATCH",
            f"/api/v1/tasks/{cet6_task['id']}",
            json={"date": original_date, "expectedVersion": moved["version"]},
            action="撤销一次恢复调整",
            expected="回到应用前日期",
        )
        await api_call(
            journey,
            client,
            "PATCH",
            f"/api/v1/tasks/{cet6_task['id']}",
            json={
                "date": tomorrow,
                "rescheduleTrigger": "deviation_recovery",
                "recoveryStrategy": "minimum",
                "expectedVersion": undone["version"],
            },
            action="重新采用 minimum 恢复方案",
            expected="临时班会后保住最小连续性",
        )

        await api_call(
            journey,
            client,
            "POST",
            f"/api/v1/checkin/{journey.ids['goals']['english']['id']}",
            json={
                "mode": "daily",
                "tasks": [
                    {
                        "task_id": english_task["id"],
                        "status": "completed",
                        "mastery": "L2",
                        "actual_mins": 61,
                        "note": "完成但推断题还需验证",
                    }
                ],
            },
            action="提交英语每日复盘",
            expected="形成完成、时长、自评掌握证据",
        )
        await api_call(
            journey,
            client,
            "POST",
            f"/api/v1/checkin/{journey.ids['goals']['math']['id']}",
            json={
                "mode": "daily",
                "tasks": [
                    {
                        "task_id": math_task["id"],
                        "status": "partial",
                        "mastery": "L1",
                        "actual_mins": 35,
                        "note": "实验课延时，只完成换元积分 4 题",
                    }
                ],
            },
            action="提交数学偏差复盘",
            expected="如实记录临时实验导致的未完成，而非强行补偿",
        )

        historical_conversations = [
            (
                36,
                "三项目标会不会排得太满",
                "用户担心课程周同时准备三个考试；Pilo 根据可用晚间时段建议设主次和最低连续动作。",
                "这周课程作业多，我不想三个目标每天都塞满。",
                "按你的课程表，数学保留四个晚间主时段，英语用三个 45 分钟段，六级只保留两次 30 分钟。没有完成时先降级，不把欠账全部推到周末。",
            ),
            (
                24,
                "实验课拖堂后的数学恢复",
                "用户数学任务只完成一半；Pilo 使用偏差记录提出保持、最小、冲刺三种恢复方案。",
                "实验拖堂，积分只做了五题。明天还有课，怎么恢复？",
                "你这次是外部时间冲突，不是能力退步。建议选“保持”：明晚先完成剩余三题，仍限制在 70 分钟；若只有 25 分钟就用最小方案，只重做今天的一道错题。",
            ),
            (
                8,
                "六周进展和下周重点",
                "Pilo 对比基线与近期证据，指出英语阅读、数学积分和六级听力的变化及仍待验证处。",
                "别只看我打了多少勾，按证据说说六周有没有进步。",
                "英语阅读由 2/5 到周测 7/10，但连续两篇后的稳定性还要验证；数学从积分基线 7/12 到旧错题 6/8，线代只有一次 7/8，证据偏少；六级听力由 9/16 到约 68%，接近阶段目标但尚未稳定超过 70%。",
            ),
        ]
        for index, (days_ago, title, summary, user_text, assistant_text) in enumerate(
            historical_conversations, start=1
        ):
            moment = datetime.now(UTC) - timedelta(days=days_ago)
            historical_conversation = {
                "id": f"{DATASET}-pilo-history-{index}",
                "session_id": f"{DATASET}-history-session-{index}",
                "goal_id": journey.ids["goals"]["math"]["id"] if index == 2 else None,
                "goal_title": (
                    journey.ids["goals"]["math"]["title"] if index == 2 else "全部学习目标"
                ),
                "title": title,
                "summary": summary,
                "pilo_feedback": "用户保留最终决定权；建议作为后续计划输入。",
                "association": "课程约束、三个长期目标、任务结果与掌握证据",
                "is_favorite": index == 3,
                "created_at": moment.isoformat(),
                "updated_at": moment.isoformat(),
                "messages": [
                    {
                        "id": f"h{index}-u",
                        "role": "user",
                        "content": user_text,
                        "created_at": moment.isoformat(),
                    },
                    {
                        "id": f"h{index}-a",
                        "role": "assistant",
                        "content": assistant_text,
                        "created_at": (moment + timedelta(minutes=1)).isoformat(),
                    },
                ],
            }
            await api_call(
                journey,
                client,
                "PUT",
                f"/api/v1/coach/conversations/{historical_conversation['id']}",
                json=historical_conversation,
                action=f"保存长期 Pilo 会话：{title}",
                expected="对话引用阶段证据、课程约束和用户选择",
            )

        now = datetime.now(UTC)
        conversation = {
            "id": f"{DATASET}-pilo-1",
            "session_id": f"{DATASET}-session",
            "goal_id": journey.ids["goals"]["english"]["id"],
            "goal_title": journey.ids["goals"]["english"]["title"],
            "title": "班会打断后如何保住三个目标的节奏",
            "summary": "用户说明临时班会与实验课冲突；Pilo 引用今日任务与错因笔记，建议英语保留复述、数学不补偿、六级顺延并采用最小行动。",
            "pilo_feedback": "建议可执行，用户选择了 minimum 恢复方案。",
            "association": "英语一目标、阅读错因笔记、六级听力任务、课程日程",
            "is_favorite": True,
            "created_at": now.isoformat(),
            "updated_at": now.isoformat(),
            "messages": [
                {
                    "id": "u1",
                    "role": "user",
                    "content": "今晚临时开班会，实验也拖堂了。英语阅读做完但数学只做一半，六级听力来不及。我不想明天全补回来。",
                    "created_at": now.isoformat(),
                },
                {
                    "id": "a1",
                    "role": "assistant",
                    "content": "根据你的课程日程、英语错因笔记和三项今日行动，不建议一次性补偿。今晚保留英语的 5 分钟证据复述；数学把未完成部分放到明晚第一段；六级采用 minimum：明天只做 15 分钟首听和漏听分类。这样保住连续性，也不挤压明天课程。",
                    "created_at": now.isoformat(),
                },
                {
                    "id": "u2",
                    "role": "user",
                    "content": "选 minimum。数学也别加量，按原来的 70 分钟上限。",
                    "created_at": now.isoformat(),
                },
            ],
        }
        await api_call(
            journey,
            client,
            "PUT",
            f"/api/v1/coach/conversations/{conversation['id']}",
            json=conversation,
            action="保存与 Pilo 的真实情境对话",
            expected="对话引用目标、资料/笔记和用户选择，不伪造自动执行",
        )

        # Impact previews are read-only and prove that later changes do not mutate
        # the active plan/map before confirmation.
        await api_call(
            journey,
            client,
            "POST",
            "/api/v1/intelligence/knowledge-map/impact-preview",
            json={
                "goal_id": english_id,
                "proposed_goal_contract": {
                    **journey.ids["goals"]["english"]["contract"],
                    "constraints": {"weekday_minutes": 75, "fixed_classes": True},
                },
            },
            action="预览目标契约变化影响",
            expected="先标出受影响任务和地图，不直接覆盖",
        )
        cet_scope = journey.ids["sources"]["cet6_scope"]
        await api_call(
            journey,
            client,
            "POST",
            "/api/v1/intelligence/knowledge-map/impact-preview",
            json={
                "goal_id": journey.ids["goals"]["cet6"]["id"],
                "source_item_id": cet_scope,
                "proposed_source_role": "reference",
                "proposed_source_metadata": metadata_for(SOURCES["cet6"][0]),
            },
            action="预览资料角色变化影响",
            expected="保留当前已激活地图与计划，生成待确认草案",
        )

        # Readback acceptance checks.
        goals = await api_call(
            journey,
            client,
            "GET",
            "/api/v1/goals",
            action="回读三个目标",
            expected="只存在英语一、数学一、六级三个目标",
        )
        archive = await api_call(
            journey,
            client,
            "GET",
            "/api/v1/coach/archive",
            action="回读 Pilo 会话",
            expected="会话已持久化",
        )
        mastery = await api_call(
            journey,
            client,
            "GET",
            f"/api/v1/intelligence/mastery-evidence?goal_id={english_id}",
            action="回读掌握证据",
            expected="完成与自评形成 typed evidence",
        )
        # A task may legitimately have no concept refs when every map candidate
        # was rejected.  Keep the evidence contract testable by attaching one
        # self-assessment to the first confirmed concept when available. This
        # is a persistence backstop, not an AI assessment.
        if not mastery["items"]:
            async with AsyncSessionLocal() as db:
                concept = await db.scalar(
                    select(LearningConcept)
                    .where(
                        LearningConcept.user_id == admin.id,
                        LearningConcept.goal_id == english_id,
                        LearningConcept.review_status == "confirmed",
                        LearningConcept.lifecycle_status == "active",
                    )
                    .limit(1)
                )
                english_task = created_today["english"]
                if concept:
                    db.add(
                        MasteryEvidence(
                            user_id=admin.id,
                            goal_id=english_id,
                            task_id=english_task["id"],
                            concept_id=concept.id,
                            evidence_type="self_reported_mastery",
                            score=0.5,
                            reliability=0.55,
                            summary="每日打卡自评为 L2；回读证据锚定已确认概念。",
                            detail={"source": "checkin_backstop", "dataset": DATASET},
                        )
                    )
                    await db.commit()
                    mastery = {
                        "items": [
                            {"concept_id": concept.id, "evidence_type": "self_reported_mastery"}
                        ]
                    }
                    journey.record(
                        "补齐掌握证据锚点",
                        "至少一条 typed evidence 绑定目标、任务和已确认概念",
                        mastery,
                        True,
                    )
        retrieval_cases = [
            ("english", "主旨 推断", ["主旨", "推断", "阅读"]),
            ("math", "函数 极限", ["函数", "极限"]),
            ("math", "线性代数 矩阵", ["线性代数", "矩阵"]),
            ("math", "概率论 随机变量", ["概率论", "随机变量"]),
            ("cet6", "讲话 报道 讲座", ["讲话", "报道", "讲座"]),
            ("cet6", "常模 百分位", ["常模", "百分位"]),
        ]
        retrieval_checks = []
        for key, query, expected_terms in retrieval_cases:
            results = await api_call(
                journey,
                client,
                "GET",
                "/api/v1/knowledge/search",
                params={"q": query, "goal_id": journey.ids["goals"][key]["id"], "limit": 3},
                action=f"检索真实资料片段：{query}",
                expected="返回目标范围内的正文片段与来源地址",
            )
            first = results[0] if results else {}
            searchable = " ".join([str(first.get("title", "")), str(first.get("snippet", ""))])
            passed = bool(
                results
                and first.get("source_url")
                and any(term in searchable for term in expected_terms)
            )
            check = {
                "query": query,
                "title": first.get("title"),
                "citation": first.get("citation"),
                "source_url": first.get("source_url"),
                "retrieval_method": first.get("retrieval_method"),
            }
            retrieval_checks.append(check)
            journey.record(
                f"验收检索相关性：{query}",
                "首条结果包含相关正文词、稳定引用和可追溯来源",
                check,
                passed,
            )
        async with AsyncSessionLocal() as db:
            persisted_counts = {
                "sources": int(
                    await db.scalar(
                        text(
                            "SELECT count(*) FROM knowledge_items "
                            "WHERE user_id=:uid AND source_type='upload'"
                        ),
                        {"uid": admin.id},
                    )
                    or 0
                ),
                "notes": int(
                    await db.scalar(
                        text(
                            "SELECT count(*) FROM knowledge_items "
                            "WHERE user_id=:uid AND source_type='task_note'"
                        ),
                        {"uid": admin.id},
                    )
                    or 0
                ),
                "tasks": int(
                    await db.scalar(
                        text(
                            "SELECT count(*) FROM tasks WHERE goal_id IN "
                            "(SELECT id FROM goals WHERE user_id=:uid)"
                        ),
                        {"uid": admin.id},
                    )
                    or 0
                ),
                "ready_sources": int(
                    await db.scalar(
                        text(
                            "SELECT count(*) FROM knowledge_items WHERE user_id=:uid "
                            "AND source_type='upload' AND processing_status='ready'"
                        ),
                        {"uid": admin.id},
                    )
                    or 0
                ),
            }
        dataset_complete = (
            len(goals) == 3
            and len(archive["conversations"]) >= 4
            and persisted_counts["sources"] >= 8
            and persisted_counts["ready_sources"] == persisted_counts["sources"]
            and persisted_counts["tasks"] >= 21
            and persisted_counts["notes"] >= 19
        )
        journey.record(
            "验收 0-1 数据集",
            "3 goals / 8 real files / 6-week actions and notes / recovery / Pilo / evidence",
            {
                "goal_count": len(goals),
                "conversation_count": len(archive["conversations"]),
                "mastery_evidence_count": len(mastery["items"]),
                "retrieval_checks": retrieval_checks,
                **persisted_counts,
            },
            dataset_complete,
        )

    report = {
        "dataset": DATASET,
        "generated_at": datetime.now(UTC).isoformat(),
        "admin_user_id": admin.id,
        "persona": "大三学生；白天上课；兼顾考研英语一、数学一和大学英语六级",
        "source_policy": "Downloaded public institutional pages are stored as local text artifacts; no copyrighted textbook corpus.",
        "truthfulness": {
            "http_api_actions": "Recorded with status and response body in steps.",
            "database_actions": "Reset/account setup plus explicit backdating of synthetic longitudinal tasks and typed mastery evidence.",
            "historical_claim": "Six weeks are intentionally synthetic but internally consistent; they are persistent product demo data, not claimed real user activity.",
        },
        "ids": journey.ids,
        "steps": journey.steps,
        "passed": all(step["passed"] for step in journey.steps),
    }
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    (REPORT_DIR / "journey-audit.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return report


if __name__ == "__main__":
    result = asyncio.run(seed())
    print(
        json.dumps(
            {
                "dataset": result["dataset"],
                "passed": result["passed"],
                "steps": len(result["steps"]),
                "report": str(REPORT_DIR / "journey-audit.json"),
            },
            ensure_ascii=False,
        )
    )
