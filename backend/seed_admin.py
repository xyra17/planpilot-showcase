"""
为 admin 账户创建演示数据（含历史打卡记录、任务、计划、知识库）。
运行：python seed_admin.py
"""
import asyncio
import json
import random
import uuid
from datetime import date, datetime, timedelta

import httpx
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

DATABASE_URL = "postgresql+asyncpg://planpilot:password@localhost:5432/planpilot"
BASE = "http://localhost:8000"
ADMIN_EMAIL = "admin@text.com"
ADMIN_PASSWORD = "123456"

# 近 60 天打卡模式
GOALS_CONFIG = [
    {
        "type": "exam",
        "title": "CPA 注册会计师",
        "deadline_days": 150,
        "daily_hours": 3.0,
        "current_level": "intermediate",
        "meta": {
            "subjects": ["财务管理", "审计", "会计", "税法", "经济法"],
            "target_score": 60,
        },
        "checkin_days": {0, 1, 2, 3, 4},
        "weights": {"all_done": 0.40, "mostly_done": 0.35, "half_done": 0.15, "barely_done": 0.07, "explain": 0.03},
        "task_templates": [
            ("《财务管理》习题精练", 60),
            ("审计准则知识点复习", 45),
            ("税法主要税种对比练习", 50),
            ("经济法案例分析训练", 40),
            ("错题本整理与复盘", 30),
            ("财管综合计算题专练", 90),
            ("模拟真题限时作答", 120),
            ("《会计》难点章节精读", 55),
        ],
        "knowledge": [
            ("财务管理公式速查表", "资金时间价值：F=P(1+i)ⁿ\n年金现值：PVA=A×PVIFA(i,n)\nNPV=-C₀+Σ[CFt/(1+r)ᵗ]\nIRR：令NPV=0求解折现率\n\n流动比率=流动资产/流动负债（>2为健康）\n速动比率=(流动资产-存货)/流动负债（>1为健康）\n资产负债率=负债总额/资产总额×100%"),
            ("审计重点章节笔记", "重要性原则：审计重要性=重要性基准×适用百分比\n风险导向审计：审计风险=重大错报风险×检查风险\n\n内部控制五要素：控制环境、风险评估、控制活动、信息与沟通、监督\n\n审计报告类型：标准无保留意见、带强调事项段无保留意见、保留意见、否定意见、无法表示意见"),
            ("税法主要税种对比", "增值税：一般纳税人税率13%/9%/6%，小规模3%\n企业所得税：基本税率25%，小型微利企业20%\n个人所得税：工资薪金适用3%-45%七级超额累进\n消费税：在生产/委托加工/进口环节征收\n\n税收优惠：高新技术企业减按15%征收企业所得税"),
        ],
    },
    {
        "type": "skill",
        "title": "Python 全栈开发",
        "deadline_days": 90,
        "daily_hours": 2.0,
        "current_level": "beginner",
        "meta": {
            "topics": ["FastAPI", "React", "PostgreSQL", "Docker"],
            "project": "个人博客系统",
        },
        "checkin_days": {0, 1, 2, 3, 4, 5},
        "weights": {"all_done": 0.45, "mostly_done": 0.30, "half_done": 0.15, "barely_done": 0.07, "explain": 0.03},
        "task_templates": [
            ("FastAPI 路由与依赖注入实践", 60),
            ("React Hooks 深度学习", 50),
            ("PostgreSQL 查询优化练习", 45),
            ("Docker Compose 多容器编排", 60),
            ("博客系统用户认证模块", 90),
            ("单元测试与 pytest 实践", 50),
            ("前端状态管理 Zustand 实战", 45),
            ("API 错误处理与日志规范", 40),
        ],
        "knowledge": [
            ("FastAPI 核心概念速查", "路由装饰器：@app.get/post/put/delete\n依赖注入：Depends(func) 实现认证、DB session\nPydantic 模型：自动验证+序列化\nAsyncSession：async with session.begin() 管理事务\n\n典型目录结构：\n  src/\n    api/      # 路由\n    models.py # SQLAlchemy ORM\n    schemas/  # Pydantic\n    deps.py   # 公共依赖\n    database.py"),
            ("PostgreSQL 索引优化技巧", "B-tree 索引：默认类型，适合等值和范围查询\nGIN 索引：适合 JSONB、数组、全文搜索\nPartial 索引：CREATE INDEX ... WHERE condition\n\nEXPLAIN ANALYZE 查看执行计划\n避免 SELECT *，明确列名\n对高频 WHERE/JOIN 列建索引\n\n连接池：asyncpg pool_size=10, max_overflow=20"),
            ("React + TypeScript 最佳实践", "useState + useCallback 避免不必要渲染\nuseMemo 缓存计算结果\nZustand store：create<State>((set,get)=>({...}))\n\nAPI 请求模式：\n  useEffect(() => { api.get(...).then(setData) }, [])\n\n类型安全：interface Props，避免 any\nTailwind：cn() 合并条件类名"),
        ],
    },
    {
        "type": "certification",
        "title": "英语 CET-6 备考",
        "deadline_days": 55,
        "daily_hours": 1.5,
        "current_level": "intermediate",
        "meta": {
            "target_score": 550,
            "weak_areas": ["阅读理解", "翻译"],
        },
        "checkin_days": {0, 1, 2, 3, 6},
        "weights": {"all_done": 0.35, "mostly_done": 0.35, "half_done": 0.18, "barely_done": 0.09, "explain": 0.03},
        "task_templates": [
            ("单词记忆训练（50词）", 30),
            ("阅读理解精读训练", 40),
            ("翻译专项练习（汉译英）", 35),
            ("听力模拟题 Section A", 30),
            ("写作范文分析与仿写", 45),
            ("完型填空限时练习", 25),
            ("长难句分析训练", 35),
            ("历年真题精析", 60),
        ],
        "knowledge": [
            ("CET-6 高频词汇分类表", "经济类：inflation通胀 / fiscal财政 / deficit赤字 / stimulus刺激\n社会类：demographic人口 / welfare福利 / inequality不平等\n科技类：algorithm算法 / genome基因组 / renewable可再生\n\n易混淆词组：\n  affect(动词影响) vs effect(名词效果)\n  principle(原则) vs principal(主要的/校长)\n  complement(补充) vs compliment(恭维)"),
            ("阅读理解解题技巧", "题型分类：\n1. 主旨题 → 看首尾段，关键词法\n2. 细节题 → 定位原文，同义替换\n3. 推断题 → 不过度推断，选最接近原文的\n4. 词义题 → 上下文语境推断\n\n时间分配：每篇15分钟\n先读题目再读文章（细节题）\n长难句：主干+修饰成分拆解"),
            ("翻译技巧与常见句式", "四六级翻译方向：汉译英\n\n常用句式：\n  强调句：It is...that...\n  倒装：Not only...but also...\n  非谓语：分词做状语，不定式表目的\n\n文化词翻译：\n  春节=Spring Festival\n  中医=Traditional Chinese Medicine\n  四合院=quadrangle courtyard\n\n数字：十亿=billion，万=ten thousand"),
        ],
    },
]

RATE_MAP = {"all_done": 1.0, "mostly_done": 0.75, "half_done": 0.5, "barely_done": 0.1, "explain": 0.0}


def pick_status(weights: dict[str, float]) -> str:
    keys = list(weights.keys())
    vals = [weights[k] for k in keys]
    return random.choices(keys, vals)[0]


async def get_token(client: httpx.AsyncClient) -> str:
    r = await client.post(f"{BASE}/api/v1/auth/login",
                          json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
    if r.status_code != 200:
        raise RuntimeError(f"登录失败: {r.status_code} {r.text}")
    print("✓ 登录成功")
    return r.json()["access_token"]


async def delete_old_goals(engine, admin_id: str):
    async with engine.begin() as conn:
        result = await conn.execute(
            text("SELECT id, title FROM goals WHERE user_id = :uid"), {"uid": admin_id}
        )
        old_goals = result.fetchall()
        if not old_goals:
            print("  (无旧目标)")
            return
        ids = [r[0] for r in old_goals]
        titles = [r[1] for r in old_goals]
        for gid in ids:
            await conn.execute(text("DELETE FROM checkin_records WHERE goal_id = :gid"), {"gid": gid})
            await conn.execute(text("DELETE FROM tasks WHERE goal_id = :gid"), {"gid": gid})
            await conn.execute(text("DELETE FROM plans WHERE goal_id = :gid"), {"gid": gid})
        # 同时清除知识库
        await conn.execute(text("DELETE FROM knowledge_items WHERE user_id = :uid"), {"uid": admin_id})
        await conn.execute(text("DELETE FROM goals WHERE user_id = :uid"), {"uid": admin_id})
        print(f"  ✗ 已删除旧目标: {', '.join(titles)}")


async def create_goals_via_api(client: httpx.AsyncClient, headers: dict) -> list[dict]:
    today = date.today()
    created = []
    for g in GOALS_CONFIG:
        payload = {
            "type": g["type"],
            "title": g["title"],
            "deadline": (today + timedelta(days=g["deadline_days"])).isoformat(),
            "daily_hours": g["daily_hours"],
            "current_level": g["current_level"],
            "meta": g["meta"],
        }
        r = await client.post(f"{BASE}/api/v1/goals", json=payload, headers=headers)
        if r.status_code in (200, 201):
            goal = r.json()
            created.append(goal)
            print(f"  ✓ 目标: {goal['title']} ({goal['id'][:8]}...)")
        else:
            raise RuntimeError(f"创建目标失败: {g['title']} → {r.status_code} {r.text}")
    return created


async def insert_checkin_history(engine, goals: list[dict], admin_id: str):
    today = date.today()
    records = []
    for goal, cfg in zip(goals, GOALS_CONFIG):
        goal_id = goal["id"]
        for days_ago in range(60, 0, -1):
            d = today - timedelta(days=days_ago)
            if d.weekday() not in cfg["checkin_days"]:
                continue
            qs = pick_status(cfg["weights"])
            rate = RATE_MAP[qs]
            records.append({
                "id": str(uuid.uuid4()),
                "goal_id": goal_id,
                "user_id": admin_id,
                "date": d.isoformat(),
                "mode": "quick",
                "quick_status": qs,
                "natural_text": None,
                "completion_rate": rate,
                "stats": "{}",
                "feedback": "",
                "replan_triggered": False,
                "created_at": datetime.combine(d, datetime.min.time()),
            })

    async with engine.begin() as conn:
        for r in records:
            await conn.execute(text("""
                INSERT INTO checkin_records
                    (id, goal_id, user_id, date, mode, quick_status,
                     natural_text, completion_rate, stats, feedback,
                     replan_triggered, created_at)
                VALUES
                    (:id, :goal_id, :user_id, :date, :mode, :quick_status,
                     :natural_text, :completion_rate, CAST(:stats AS jsonb),
                     :feedback, :replan_triggered, :created_at)
            """), r)
    print(f"  ✓ 插入历史打卡记录 {len(records)} 条（近60天）")


async def insert_tasks(engine, goals: list[dict], admin_id: str):
    today = date.today()
    records = []

    for goal, cfg in zip(goals, GOALS_CONFIG):
        goal_id = goal["id"]
        templates = cfg["task_templates"]

        # 过去 14 天：每个打卡日插入 2~3 条任务（大部分已完成）
        for days_ago in range(14, 0, -1):
            d = today - timedelta(days=days_ago)
            if d.weekday() not in cfg["checkin_days"]:
                continue
            n_tasks = random.choice([2, 2, 3])
            chosen = random.sample(templates, min(n_tasks, len(templates)))
            for i, (title, estimated_mins) in enumerate(chosen):
                done_prob = 0.85 if days_ago > 3 else 0.70
                status = "completed" if random.random() < done_prob else "pending"
                completed_at = datetime.combine(d, datetime.min.time().replace(hour=random.randint(20, 22))) if status == "completed" else None
                records.append({
                    "id": str(uuid.uuid4()),
                    "goal_id": goal_id,
                    "plan_id": None,
                    "title": title,
                    "estimated_mins": estimated_mins,
                    "actual_mins": None,
                    "status": status,
                    "type": "study",
                    "kb_refs": "[]",
                    "mastery_level": "unknown",
                    "scheduled_date": d.isoformat(),
                    "completed_at": completed_at,
                    "created_at": datetime.combine(d, datetime.min.time().replace(hour=8)),
                })

        # 今日任务：3 条（1 完成 + 2 待完成）
        today_templates = random.sample(templates, min(3, len(templates)))
        for i, (title, estimated_mins) in enumerate(today_templates):
            status = "completed" if i == 0 else "pending"
            records.append({
                "id": str(uuid.uuid4()),
                "goal_id": goal_id,
                "plan_id": None,
                "title": title,
                "estimated_mins": estimated_mins,
                "actual_mins": estimated_mins if status == "completed" else None,
                "status": status,
                "type": "study",
                "kb_refs": "[]",
                "mastery_level": "unknown",
                "scheduled_date": today.isoformat(),
                "completed_at": datetime.combine(today, datetime.min.time().replace(hour=9)) if status == "completed" else None,
                "created_at": datetime.combine(today, datetime.min.time().replace(hour=7, minute=30)),
            })

    async with engine.begin() as conn:
        for r in records:
            await conn.execute(text("""
                INSERT INTO tasks
                    (id, goal_id, plan_id, title, estimated_mins, actual_mins,
                     status, type, kb_refs, mastery_level, scheduled_date,
                     completed_at, created_at)
                VALUES
                    (:id, :goal_id, :plan_id, :title, :estimated_mins, :actual_mins,
                     :status, :type, CAST(:kb_refs AS jsonb), :mastery_level, :scheduled_date,
                     :completed_at, :created_at)
            """), r)
    print(f"  ✓ 插入任务 {len(records)} 条（今日 {3 * len(goals)} 条 + 近14天历史）")


async def insert_plans(engine, goals: list[dict]):
    today = date.today()
    records = []

    for goal, cfg in zip(goals, GOALS_CONFIG):
        goal_id = goal["id"]
        templates = cfg["task_templates"]

        # 生成阶段性学习计划内容
        weeks = []
        for w in range(1, 5):
            week_tasks = [{"title": t[0], "estimated_mins": t[1], "days": list(cfg["checkin_days"])} for t in templates[:4]]
            weeks.append({"week": w, "focus": f"第{w}周重点突破", "tasks": week_tasks})

        content = {
            "phases": weeks,
            "daily_target_hours": cfg["daily_hours"],
            "generated_at": today.isoformat(),
            "note": "AI 自动生成的学习路径规划",
        }
        baseline = content.copy()

        records.append({
            "id": str(uuid.uuid4()),
            "goal_id": goal_id,
            "version": 1,
            "is_current": True,
            "baseline": json.dumps(baseline, ensure_ascii=False),
            "content": json.dumps(content, ensure_ascii=False),
            "replan_reason": None,
            "created_at": today - timedelta(days=60),
        })

    async with engine.begin() as conn:
        for r in records:
            await conn.execute(text("""
                INSERT INTO plans
                    (id, goal_id, version, is_current, baseline, content, replan_reason, created_at)
                VALUES
                    (:id, :goal_id, :version, :is_current,
                     CAST(:baseline AS jsonb), CAST(:content AS jsonb),
                     :replan_reason, :created_at)
            """), r)
    print(f"  ✓ 插入计划 {len(records)} 条（每目标1份）")


async def insert_knowledge(engine, goals: list[dict], admin_id: str):
    today = date.today()
    records = []

    for goal, cfg in zip(goals, GOALS_CONFIG):
        goal_id = goal["id"]
        for i, (title, content) in enumerate(cfg["knowledge"]):
            records.append({
                "id": str(uuid.uuid4()),
                "user_id": admin_id,
                "goal_id": goal_id,
                "title": title,
                "content": content,
                "source_type": "system",
                "source_url": None,
                "file_path": None,
                "tags": json.dumps([], ensure_ascii=False),
                "embedding": None,
                "created_at": today - timedelta(days=random.randint(3, 30)),
            })

    async with engine.begin() as conn:
        for r in records:
            await conn.execute(text("""
                INSERT INTO knowledge_items
                    (id, user_id, goal_id, title, content, source_type,
                     source_url, file_path, tags, embedding, created_at)
                VALUES
                    (:id, :user_id, :goal_id, :title, :content, :source_type,
                     :source_url, :file_path, CAST(:tags AS jsonb), :embedding, :created_at)
            """), r)
    print(f"  ✓ 插入知识库条目 {len(records)} 条（每目标3条）")


async def main():
    random.seed(42)
    engine = create_async_engine(DATABASE_URL, echo=False)

    async with httpx.AsyncClient(timeout=15) as client:
        print("=== PlanPilot Admin 数据初始化 ===\n")

        token = await get_token(client)
        headers = {"Authorization": f"Bearer {token}"}

        me = await client.get(f"{BASE}/api/v1/auth/me", headers=headers)
        admin_id = me.json()["id"]

        print("\n清理旧数据...")
        await delete_old_goals(engine, admin_id)

        print("\n创建演示目标...")
        goals = await create_goals_via_api(client, headers)

        print("\n插入历史打卡记录...")
        await insert_checkin_history(engine, goals, admin_id)

        print("\n插入任务数据（今日 + 近14天）...")
        await insert_tasks(engine, goals, admin_id)

        print("\n插入学习计划...")
        await insert_plans(engine, goals)

        print("\n插入知识库条目...")
        await insert_knowledge(engine, goals, admin_id)

        print(f"""
=== 完成 ===
账户:    {ADMIN_EMAIL}  /  {ADMIN_PASSWORD}
目标数:  {len(goals)}（CPA · Python全栈 · CET-6）
打卡:    近60天历史记录
任务:    今日 {3 * len(goals)} 条（待完成+已完成）+ 近14天历史
计划:    每目标1份阶段性规划
知识库:  {3 * len(goals)} 条（每目标3条笔记）

新注册用户天然空白，数据按 user_id 隔离。
""")

    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
