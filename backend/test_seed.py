"""
PlanPilot 丰富测试数据生成 + 全局接口验证
用法: cd backend && python test_seed.py
"""
import requests, json, sys, uuid
from datetime import date, timedelta
from typing import Any

BASE = "http://localhost:8000"
ADMIN_EMAIL = "admin@planpilot.dev"
ADMIN_PASSWORD = "Admin123!"

OK   = "\033[92m✓\033[0m"
FAIL = "\033[91m✗\033[0m"
INFO = "\033[94m→\033[0m"
WARN = "\033[93m!\033[0m"

errors = []

def section(title: str):
    print(f"\n\033[1m{'═'*55}\n  {title}\n{'═'*55}\033[0m")

def check(label: str, resp: requests.Response, expected: int = 200) -> Any:
    ok = resp.status_code == expected
    icon = OK if ok else FAIL
    print(f"  {icon}  [{resp.status_code}] {label}")
    if not ok:
        errors.append(f"[{resp.status_code}] {label}")
        try:    print(f"       {resp.json()}")
        except: print(f"       {resp.text[:300]}")
    try:    return resp.json()
    except: return None

def d(offset: int) -> str:
    return (date.today() - timedelta(days=offset)).isoformat()

# ══════════════════════════════════════════════════════════
section("1. 认证模块")

r = requests.post(f"{BASE}/api/v1/auth/register", json={
    "email": ADMIN_EMAIL, "username": "Admin", "password": ADMIN_PASSWORD,
})
if r.status_code == 200:
    print(f"  {OK}  账号已创建")
elif r.status_code in (400, 409):
    print(f"  {INFO}  账号已存在，直接登录")
else:
    check("register", r, 200)

r = requests.post(f"{BASE}/api/v1/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
data = check("POST /auth/login", r)
if not data or "access_token" not in data:
    print("  登录失败，终止"); sys.exit(1)

TOKEN = data["access_token"]
H = {"Authorization": f"Bearer {TOKEN}"}

check("GET  /auth/me",         requests.get(f"{BASE}/api/v1/auth/me", headers=H))
check("PATCH /auth/me",        requests.patch(f"{BASE}/api/v1/auth/me", json={"username": "Admin"}, headers=H))

# ══════════════════════════════════════════════════════════
section("2. 知识库模块")

kbs_payload = [
    {"name": "Python 数据科学",   "description": "Pandas / NumPy / Matplotlib / Scikit-learn"},
    {"name": "雅思备考资料",       "description": "词汇 + 语法 + 四项技能真题"},
    {"name": "AWS 云架构",         "description": "SAA / CLF 考试备考笔记"},
    {"name": "前端工程化",         "description": "React / TypeScript / Next.js 进阶"},
    {"name": "算法与数据结构",     "description": "LeetCode 题解 + 复杂度分析"},
]
kb_ids = []
for kb in kbs_payload:
    r = requests.post(f"{BASE}/api/v1/knowledge/kbs", json=kb, headers=H)
    data = check(f"POST /kbs ({kb['name'][:16]})", r, expected=201)
    if data and "id" in data:
        kb_ids.append(data["id"])
    elif r.status_code in (400, 409):
        # already exists — fetch
        existing = requests.get(f"{BASE}/api/v1/knowledge/kbs", headers=H).json()
        match = next((x for x in (existing if isinstance(existing, list) else existing.get("items", [])) if x.get("name") == kb["name"]), None)
        if match:
            kb_ids.append(match["id"])

print(f"  {INFO}  知识库共 {len(kb_ids)} 个")

check("GET  /kbs",             requests.get(f"{BASE}/api/v1/knowledge/kbs", headers=H))
if kb_ids:
    check("GET  /kbs/{id}",    requests.get(f"{BASE}/api/v1/knowledge/kbs/{kb_ids[0]}", headers=H))
    check("PATCH /kbs/{id}",   requests.patch(f"{BASE}/api/v1/knowledge/kbs/{kb_ids[0]}", json={"description": "已更新描述"}, headers=H))

# ══════════════════════════════════════════════════════════
section("3. 目标模块")

kb0 = kb_ids[0] if len(kb_ids) > 0 else None
kb1 = kb_ids[1] if len(kb_ids) > 1 else None
kb2 = kb_ids[2] if len(kb_ids) > 2 else None
kb3 = kb_ids[3] if len(kb_ids) > 3 else None

goals_payload = [
    {"title": "掌握 Python 数据分析",    "type": "skill",         "deadline": d(-90),  "daily_hours": 2.0, "current_level": "beginner",      "work_schedule": "weekdays", "kb_id": kb0},
    {"title": "雅思备考 7.0 分",          "type": "exam",          "deadline": d(-120), "daily_hours": 1.5, "current_level": "intermediate",  "work_schedule": "all",      "kb_id": kb1},
    {"title": "AWS 云从业者认证 CLF",     "type": "certification", "deadline": d(-60),  "daily_hours": 1.0, "current_level": "beginner",      "work_schedule": "weekends", "kb_id": kb2},
    {"title": "React 高级模式与性能优化", "type": "skill",         "deadline": d(-180), "daily_hours": 1.5, "current_level": "intermediate",  "work_schedule": "all",      "kb_id": kb3},
    {"title": "LeetCode 每日一题",        "type": "skill",         "deadline": d(-365), "daily_hours": 0.5, "current_level": "intermediate",  "work_schedule": "all"},
    {"title": "机器学习入门（Coursera）", "type": "certification", "deadline": d(-90),  "daily_hours": 1.0, "current_level": "beginner",      "work_schedule": "weekdays"},
]
# 使用负数 offset 会超出deadline，改为未来
goals_payload = [
    {"title": "掌握 Python 数据分析",    "type": "skill",         "deadline": (date.today()+timedelta(days=90)).isoformat(),  "daily_hours": 2.0, "current_level": "beginner",      "work_schedule": "weekdays", "kb_id": kb0},
    {"title": "雅思备考 7.0 分",          "type": "exam",          "deadline": (date.today()+timedelta(days=120)).isoformat(), "daily_hours": 1.5, "current_level": "intermediate",  "work_schedule": "all",      "kb_id": kb1},
    {"title": "AWS 云从业者认证 CLF",     "type": "certification", "deadline": (date.today()+timedelta(days=60)).isoformat(),  "daily_hours": 1.0, "current_level": "beginner",      "work_schedule": "weekends", "kb_id": kb2},
    {"title": "React 高级模式与性能优化", "type": "skill",         "deadline": (date.today()+timedelta(days=180)).isoformat(), "daily_hours": 1.5, "current_level": "intermediate",  "work_schedule": "all",      "kb_id": kb3},
    {"title": "LeetCode 每日一题",        "type": "skill",         "deadline": (date.today()+timedelta(days=365)).isoformat(), "daily_hours": 0.5, "current_level": "intermediate",  "work_schedule": "all"},
    {"title": "机器学习入门（Coursera）", "type": "certification", "deadline": (date.today()+timedelta(days=90)).isoformat(),  "daily_hours": 1.0, "current_level": "beginner",      "work_schedule": "weekdays"},
]

goal_ids = []
for g in goals_payload:
    r = requests.post(f"{BASE}/api/v1/goals", json=g, headers=H)
    data = check(f"POST /goals  ({g['title'][:22]})", r, expected=201)
    if data and "id" in data:
        goal_ids.append(data["id"])

print(f"  {INFO}  共创建 {len(goal_ids)} 个目标")

check("GET  /goals (列表)",   requests.get(f"{BASE}/api/v1/goals", headers=H))
if goal_ids:
    check("GET  /goals/{id}", requests.get(f"{BASE}/api/v1/goals/{goal_ids[0]}", headers=H))
    check("GET  /goals/{id}/progress", requests.get(f"{BASE}/api/v1/goals/{goal_ids[0]}/progress", headers=H))
    check("PATCH /goals/{id}", requests.patch(f"{BASE}/api/v1/goals/{goal_ids[0]}", json={"daily_hours": 2.5}, headers=H))

# ══════════════════════════════════════════════════════════
section("4. 任务模块（大量数据）")

# 每个目标在过去 14 天 + 今天各生成任务
task_templates = {
    0: [  # Python 数据分析
        ("Pandas DataFrame 基础操作",    "high",   60),
        ("NumPy 矩阵运算与广播机制",      "high",   45),
        ("Matplotlib 子图与样式调整",     "medium", 40),
        ("数据清洗：缺失值与异常值处理",  "high",   75),
        ("Seaborn 高级可视化",            "medium", 50),
        ("Pandas 时间序列分析",           "medium", 60),
        ("Scikit-learn 分类模型入门",     "high",   90),
        ("特征工程实战练习",              "medium", 60),
    ],
    1: [  # 雅思
        ("词汇：Academic Word List Day1", "high",   30),
        ("精读雅思阅读 Cambridge 15 T1",  "high",   60),
        ("写作 Task1：折线图描述练习",    "medium", 45),
        ("听力 Section3 精听训练",         "medium", 40),
        ("词汇：AWL Day2",                "high",   30),
        ("口语 Part2：描述城市话题",      "medium", 25),
        ("阅读填空题专项训练",            "high",   50),
        ("写作 Task2：观点类范文精读",    "high",   45),
        ("语法：定语从句专项练习",        "medium", 35),
    ],
    2: [  # AWS
        ("IAM 用户 / 角色 / 策略原理",   "high",   45),
        ("EC2 实例类型与定价模型",        "medium", 40),
        ("S3 存储类型与生命周期策略",     "medium", 35),
        ("VPC 子网与安全组配置",          "high",   50),
        ("RDS vs DynamoDB 使用场景",      "medium", 40),
        ("CloudFront + Route53 实践",     "high",   45),
        ("CLF 模拟题 40 道",              "high",   60),
        ("Well-Architected Framework",    "medium", 50),
    ],
    3: [  # React
        ("React.memo 与 useMemo 对比",    "high",   45),
        ("useCallback 依赖数组陷阱",      "high",   40),
        ("Context API 性能优化方案",      "medium", 50),
        ("React Query 数据缓存策略",      "high",   60),
        ("虚拟列表 react-window 实践",    "medium", 45),
        ("Server Components 工作原理",   "high",   60),
        ("自定义 Hook 设计模式",          "medium", 40),
    ],
    4: [  # LeetCode
        ("两数之和（Hash Map）",           "medium", 20),
        ("滑动窗口：最长无重复子串",       "high",   25),
        ("二分查找变体题 ×3",              "high",   30),
        ("链表：反转与合并",               "medium", 25),
        ("动态规划：爬楼梯系列",           "high",   35),
        ("BFS 岛屿数量",                   "medium", 30),
        ("前缀和 + 哈希",                  "high",   25),
    ],
    5: [  # 机器学习
        ("线性回归原理与梯度下降",         "high",   60),
        ("逻辑回归与 SoftMax",             "high",   50),
        ("决策树与随机森林",               "medium", 45),
        ("交叉验证与超参数调优",           "medium", 40),
        ("神经网络前向传播推导",           "high",   60),
    ],
}

task_ids = []
tasks_by_goal: dict[str, list[str]] = {}

for goal_idx, gid in enumerate(goal_ids):
    templates = task_templates.get(goal_idx, [])
    days_back = list(range(0, min(len(templates), 14)))
    for i, (title, priority, mins) in enumerate(templates):
        day_offset = days_back[i] if i < len(days_back) else i % 7
        task_date = (date.today() - timedelta(days=day_offset)).isoformat()
        r = requests.post(f"{BASE}/api/v1/tasks", json={
            "title": title, "goalId": gid, "date": task_date,
            "priority": priority, "estimatedMinutes": mins,
        }, headers=H)
        data = check(f"POST /tasks ({title[:24]})", r, expected=201)
        if data and "id" in data:
            task_ids.append(data["id"])
            tasks_by_goal.setdefault(gid, []).append(data["id"])

print(f"  {INFO}  共创建 {len(task_ids)} 个任务")

check("GET  /tasks (列表)",    requests.get(f"{BASE}/api/v1/tasks", headers=H))
check("GET  /tasks?date=today", requests.get(f"{BASE}/api/v1/tasks?date={date.today().isoformat()}", headers=H))

# 标记大部分历史任务为完成（保留今日任务作 pending）
completed_tasks = []
for gid, tids in tasks_by_goal.items():
    for tid in tids[1:]:   # 跳过第一条（今日 pending）
        r = requests.patch(f"{BASE}/api/v1/tasks/{tid}", json={
            "done": True, "mastery_level": "intermediate"
        }, headers=H)
        if r.ok:
            completed_tasks.append(tid)

print(f"  {OK}  标记 {len(completed_tasks)} 个任务已完成，{len(task_ids)-len(completed_tasks)} 个保留 pending")

# DELETE 测试（新建一条再删）
r = requests.post(f"{BASE}/api/v1/tasks", json={
    "title": "临时任务（将被删除）", "goalId": goal_ids[0],
    "date": date.today().isoformat(), "priority": "low", "estimatedMinutes": 10,
}, headers=H)
if r.ok and r.json().get("id"):
    tmp_tid = r.json()["id"]
    check("DELETE /tasks/{id}", requests.delete(f"{BASE}/api/v1/tasks/{tmp_tid}", headers=H), expected=204)

# ══════════════════════════════════════════════════════════
section("5. Check-in 模块（多日）")

checkin_count = 0
for day_offset in range(7, 0, -1):   # 过去 7 天
    for goal_idx, gid in enumerate(goal_ids):
        tids_for_goal = tasks_by_goal.get(gid, [])
        done_tids = [t for t in tids_for_goal if t in completed_tasks]
        if done_tids and day_offset <= len(done_tids):
            payload = {
                "mode": "task_list",
                "tasks": [
                    {"task_id": tid, "status": "completed",
                     "mastery": "intermediate", "note": f"第{day_offset}天完成"}
                    for tid in done_tids[:2]
                ]
            }
        else:
            rates = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 0.75]
            payload = {
                "mode": "quick",
                "quick_status": "good",
                "completion_rate": rates[day_offset % len(rates)],
            }
        r = requests.post(f"{BASE}/api/v1/checkin/{gid}", json=payload, headers=H)
        if r.ok:
            checkin_count += 1

print(f"  {OK}  共提交 {checkin_count} 次 check-in（覆盖 7 天 × {len(goal_ids)} 目标）")

# ══════════════════════════════════════════════════════════
section("6. 计划模块")

for i, gid in enumerate(goal_ids):
    check(f"GET /plans/{gid[:8]}.../today (goal {i+1})",
          requests.get(f"{BASE}/api/v1/plans/{gid}/today", headers=H))

# ══════════════════════════════════════════════════════════
section("7. 笔记模块（大量）")

notes_data = [
    (0, "Pandas: df.groupby('col').agg({'val': ['mean','sum']}) 是最常用的聚合模式"),
    (0, "axis=0 表示沿行方向操作（对每列），axis=1 表示沿列方向操作（对每行）"),
    (0, "read_csv 的 parse_dates 参数可直接将字符串列解析为 datetime64"),
    (0, "nunique() vs value_counts()：前者返回唯一数量，后者返回频率分布"),
    (1, "雅思写作 Task2 四段式：引言(2句)+立场, 论点A(3句), 论点B(3句), 结论(2句)"),
    (1, "高频词替换：important→crucial/significant, show→demonstrate/illustrate"),
    (1, "阅读 True/False/Not Given：NG 指原文未提及，不能从文中推断"),
    (1, "听力 Section4 是学术讲座，注意预读题目中的关键词和同义词替换"),
    (2, "AWS S3 存储类型：Standard(热数据) → IA(不频繁) → Glacier(归档) 成本递减"),
    (2, "安全责任共担模型：AWS 负责云的安全，客户负责云中的安全"),
    (2, "EC2 购买选项：按需实例(灵活) / 预留实例(省60%) / Spot(省90%,可中断)"),
    (3, "React 18 并发特性：startTransition 标记非紧急更新，避免阻塞用户输入"),
    (3, "useMemo 应在计算开销大(>1ms)或引用相等性重要时使用，否则徒增复杂度"),
    (3, "Server Components 在服务端渲染，不能使用 useState/useEffect/事件处理器"),
    (4, "滑动窗口模板：用 left/right 双指针，满足条件时缩小窗口"),
    (4, "前缀和 prefix[i] = prefix[i-1] + nums[i-1]，区间和 = prefix[r]-prefix[l]"),
    (5, "过拟合处理：增加数据量 / L1-L2正则 / Dropout / Early Stopping"),
    (5, "梯度消失：ReLU 替代 Sigmoid，残差连接（ResNet）有效缓解深层网络梯度消失"),
]

note_ids = []
for goal_idx, content in notes_data:
    if goal_idx < len(goal_ids):
        r = requests.post(f"{BASE}/api/v1/knowledge/notes", json={
            "goalId": goal_ids[goal_idx], "content": content
        }, headers=H)
        data = check(f"POST /notes ({content[:28]}...)", r, expected=201)
        if data and "id" in data:
            note_ids.append(data["id"])

print(f"  {INFO}  共创建 {len(note_ids)} 条笔记")
check("GET  /notes (全部)",    requests.get(f"{BASE}/api/v1/knowledge/notes", headers=H))
if note_ids:
    check("GET  /notes/{id}",  requests.get(f"{BASE}/api/v1/knowledge/notes/{note_ids[0]}", headers=H))
    check("PATCH /notes/{id}", requests.patch(f"{BASE}/api/v1/knowledge/notes/{note_ids[0]}",
        json={"content": note_ids and notes_data[0][1] + "（已更新）"}, headers=H))
check("GET  /knowledge/search?q=Pandas", requests.get(
    f"{BASE}/api/v1/knowledge/search?q=Pandas&limit=10", headers=H))
check("GET  /knowledge/search?q=雅思",   requests.get(
    f"{BASE}/api/v1/knowledge/search?q=雅思&limit=5", headers=H))

# ══════════════════════════════════════════════════════════
section("8. 时间规划模块")

colors = ["#3b82f6","#8b5cf6","#059669","#f59e0b","#ef4444","#06b6d4"]
schedule_items = [
    ("Python 数据清洗", 0, 8.5,  75, 0.8),
    ("雅思阅读真题",    1, 10.0, 60, 0.6),
    ("AWS 模拟题",      2, 13.0, 45, 0.5),
    ("React 性能优化",  3, 14.5, 60, 0.3),
    ("LeetCode 每日题", 4, 16.5, 30, 1.0),
    ("ML 课程视频",     5, 19.0, 50, 0.4),
    ("复盘 & 笔记整理", None, 21.0, 30, 0.0),
]
blocks = []
for i, (label, goal_idx, start, dur, progress) in enumerate(schedule_items):
    gid = goal_ids[goal_idx] if goal_idx is not None and goal_idx < len(goal_ids) else None
    blocks.append({
        "id": str(uuid.uuid4()), "label": label, "taskId": gid,
        "startHour": start, "durationMinutes": dur,
        "color": colors[i % len(colors)], "progress": progress,
    })

check("PUT  /schedule/today",  requests.put(f"{BASE}/api/v1/schedule/today", json={"blocks": blocks}, headers=H))
r = requests.get(f"{BASE}/api/v1/schedule/today", headers=H)
data = check("GET  /schedule/today",  r)
if data:
    print(f"  {INFO}  持久化时间块: {len(data.get('blocks', []))} 个")

# ══════════════════════════════════════════════════════════
section("9. AI 简报模块")

r = requests.get(f"{BASE}/api/v1/agent/daily-brief", headers=H)
if r.status_code == 200:
    brief = r.json()
    print(f"  {OK}  [200] GET /agent/daily-brief")
    print(f"  {INFO}  summary:           {brief.get('summary','')[:70]}...")
    print(f"  {INFO}  recommendedAction: {brief.get('recommendedAction','(空)')}")
    print(f"  {INFO}  goalReviews 数量:  {len(brief.get('goalReviews', []))}")
    for gr in brief.get("goalReviews", []):
        print(f"         · {gr.get('goalTitle','?')} — {len(gr.get('questions',[]))} 题")
else:
    check("GET /agent/daily-brief", r)

# ══════════════════════════════════════════════════════════
section("10. 知识文件模块")

check("GET  /knowledge/files", requests.get(f"{BASE}/api/v1/knowledge/files", headers=H))
check("GET  /knowledge/search?q=AWS",   requests.get(
    f"{BASE}/api/v1/knowledge/search?q=AWS&limit=5", headers=H))
check("GET  /knowledge/search?q=React", requests.get(
    f"{BASE}/api/v1/knowledge/search?q=React&limit=5", headers=H))

# ══════════════════════════════════════════════════════════
section("11. 边界 & 错误处理测试")

check("GET  /goals/nonexistent (404)",
    requests.get(f"{BASE}/api/v1/goals/nonexistent-id-000", headers=H), expected=404)
check("POST /goals (缺必填字段 400)",
    requests.post(f"{BASE}/api/v1/goals", json={"title": ""}, headers=H), expected=422)
check("GET  /auth/me (无 token 401)",
    requests.get(f"{BASE}/api/v1/auth/me"), expected=401)
check("POST /checkin/nonexistent (404/422)",
    requests.post(f"{BASE}/api/v1/checkin/nonexistent-id", json={"mode":"quick","quick_status":"good","completion_rate":0.5}, headers=H), expected=404)

# ══════════════════════════════════════════════════════════
section("汇总")
print(f"  {INFO}  知识库:  {len(kb_ids)} 个")
print(f"  {INFO}  目标:    {len(goal_ids)} 个")
print(f"  {INFO}  任务:    {len(task_ids)} 个  (已完成: {len(completed_tasks)}，pending: {len(task_ids)-len(completed_tasks)})")
print(f"  {INFO}  笔记:    {len(note_ids)} 条")
print(f"  {INFO}  Check-in:{checkin_count} 次")
print(f"  {INFO}  时间块:  {len(blocks)} 个")

if errors:
    print(f"\n  {WARN}  共 {len(errors)} 个接口异常：")
    for e in errors:
        print(f"     {FAIL}  {e}")
else:
    print(f"\n  {OK}  \033[92m所有接口测试通过\033[0m")
print()
