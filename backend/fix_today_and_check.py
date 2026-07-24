"""
1. 为最新 6 个目标各补充 4 条今日待完成任务（总计 5 条/目标）
2. 生成 AI 智能规划时间块并持久化
3. 全局一致性检查：热力图 / 学习趋势 / 任务日历 / 进度 vs 剩余天数
"""
import requests, json
from datetime import date, timedelta, datetime
from collections import defaultdict

BASE  = "http://localhost:8000"
EMAIL = "admin@planpilot.dev"
PWD   = "Admin123!"
TODAY = date.today().isoformat()

OK   = "\033[92m✓\033[0m"
FAIL = "\033[91m✗\033[0m"
INFO = "\033[94m→\033[0m"
WARN = "\033[93m!\033[0m"

def section(t): print(f"\n\033[1m{'═'*60}\n  {t}\n{'═'*60}\033[0m")

r = requests.post(f"{BASE}/api/v1/auth/login", json={"email": EMAIL, "password": PWD})
TOKEN = r.json()["access_token"]
H = {"Authorization": f"Bearer {TOKEN}"}

# ── 最新 6 个目标 ─────────────────────────────────────────────
all_goals = requests.get(f"{BASE}/api/v1/goals", headers=H).json()
goals = all_goals[:6]   # ordered by created_at desc

# ── 1. 补充今日任务 ─────────────────────────────────────────────
section("1. 为最新 6 个目标补充今日待完成任务")

extra_today = {
    0: [  # 机器学习入门
        ("反向传播算法推导练习", "high",   55),
        ("CNN 卷积层与池化层原理", "high",   50),
        ("TensorFlow/PyTorch 入门实战", "medium", 60),
        ("Kaggle 数据集 EDA 练习", "medium", 45),
    ],
    1: [  # LeetCode 每日一题
        ("贪心算法：跳跃游戏", "high",   25),
        ("字符串：最长公共前缀", "medium", 20),
        ("栈：括号匹配系列 ×2", "medium", 30),
        ("图论：课程表（拓扑排序）", "high",   35),
    ],
    2: [  # React 高级模式与性能优化
        ("Suspense + lazy 代码分割实践", "high",   50),
        ("Zustand 状态管理 vs Redux", "medium", 45),
        ("React DevTools 性能分析", "medium", 40),
        ("微前端架构 Module Federation", "high",   55),
    ],
    3: [  # AWS 云从业者认证 CLF
        ("Lambda 无服务器函数实践", "high",   45),
        ("CloudWatch 监控与告警配置", "medium", 40),
        ("Cost Explorer 成本优化分析", "medium", 35),
        ("AWS CLF 模拟题 ×20 道", "high",   50),
    ],
    4: [  # 雅思备考 7.0 分
        ("写作 Task2：双方观点类练习", "high",   50),
        ("阅读：匹配段落信息题型", "high",   45),
        ("词汇：Academic Word List Day3", "medium", 30),
        ("口语 Part3：社会议题扩展练习", "medium", 35),
    ],
    5: [  # 掌握 Python 数据分析
        ("Scikit-learn Pipeline 构建", "high",   65),
        ("XGBoost 调参实战", "high",   60),
        ("SHAP 特征重要性解释", "medium", 45),
        ("数据可视化报告综合项目", "medium", 55),
    ],
}

added = 0
goal_task_map: dict[str, list[str]] = {}  # goal_id -> [task_id, ...]

for i, goal in enumerate(goals):
    gid = goal["id"]
    templates = extra_today.get(i, [])
    goal_task_map[gid] = []
    for title, priority, mins in templates:
        r = requests.post(f"{BASE}/api/v1/tasks", json={
            "title": title, "goalId": gid, "date": TODAY,
            "priority": priority, "estimatedMinutes": mins,
        }, headers=H)
        if r.status_code == 201 and r.json().get("id"):
            goal_task_map[gid].append(r.json()["id"])
            added += 1

print(f"  {OK}  新增 {added} 条今日任务（{added//4 if added else 0} 个目标 ×4）")

# ── 2. AI 智能规划时间块 ──────────────────────────────────────────
section("2. 生成 AI 智能规划时间块并持久化")

# 获取今日待完成任务（最新6个目标）
today_tasks_all = requests.get(f"{BASE}/api/v1/tasks?date={TODAY}", headers=H).json()
latest_goal_ids = {g["id"] for g in goals}
pending_today = [
    t for t in today_tasks_all
    if not t.get("done") and t.get("goalId") in latest_goal_ids
]
print(f"  {INFO}  今日待完成任务（最新6目标）: {len(pending_today)} 条")

# 按优先级排序，生成时间块
priority_order = {"high": 0, "medium": 1, "low": 2}
pending_today.sort(key=lambda t: priority_order.get(t.get("priority","low"), 2))

import uuid, math
colors = ["#3b82f6","#8b5cf6","#059669","#f59e0b","#ef4444","#06b6d4","#ec4899","#14b8a6","#f97316","#a855f7"]
# 可用时段: 上午9:00, 上午10:30, 下午13:30, 下午15:00, 下午16:30, 晚上19:00, 晚上20:30
TIME_SLOTS = [9.0, 10.5, 13.5, 15.0, 16.5, 19.0, 20.5, 9.0, 10.5, 13.5, 15.0]
blocks = []
for idx, task in enumerate(pending_today[:10]):
    start_hour = TIME_SLOTS[idx % len(TIME_SLOTS)]
    dur = task.get("estimatedMinutes", 45)
    blocks.append({
        "id": str(uuid.uuid4()),
        "label": task["title"][:30],
        "taskId": task["id"],
        "goalTitle": task.get("goalTitle", ""),
        "startHour": start_hour,
        "durationMinutes": dur,
        "color": colors[idx % len(colors)],
        "progress": 0.0,
    })

r = requests.put(f"{BASE}/api/v1/schedule/today", json={"blocks": blocks}, headers=H)
if r.status_code == 200:
    print(f"  {OK}  持久化时间块 {len(blocks)} 个")
    for b in blocks:
        h = int(b["startHour"])
        m = int((b["startHour"] % 1) * 60)
        print(f"       {h:02d}:{m:02d}  {b['label'][:35]:<35s} ({b['durationMinutes']}分钟)")
else:
    print(f"  {FAIL}  保存时间块失败: {r.status_code}")

# ── 3. 一致性检查 ─────────────────────────────────────────────
section("3. 学习时间一致性检查（热力图 / 趋势图 / 任务日历）")

# 获取所有任务
all_tasks = requests.get(f"{BASE}/api/v1/tasks", headers=H).json()

# 按日期聚合已完成任务的 estimatedMinutes
heatmap: dict[str, int] = defaultdict(int)
for t in all_tasks:
    if t.get("done") and t.get("estimatedMinutes") and t.get("date"):
        heatmap[t["date"]] += t["estimatedMinutes"]

# 最近 14 天
print(f"\n  热力图 / 趋势图 / 日历应显示（已完成任务 estimatedMinutes 累加）：")
print(f"  {'日期':<12} {'分钟':>6} {'小时':>6}  {'色阶'}")
print(f"  {'-'*40}")
recent_dates = sorted(heatmap.keys(), reverse=True)[:14]
for dt in recent_dates:
    mins = heatmap[dt]
    hrs  = mins / 60
    if   mins == 0:  tier = "⬜ 0 (无)"
    elif mins < 30:  tier = "🟦 1 (<30分)"
    elif mins < 60:  tier = "🟦 2 (<60分)"
    elif mins < 120: tier = "🟦 3 (<120分)"
    else:            tier = "🟦 4 (≥120分)"
    print(f"  {dt:<12} {mins:>6} {hrs:>6.1f}h  {tier}")

# 周统计（前端 weeklyHours 逻辑）
from datetime import date as dt_cls
today_dt = dt_cls.today()
week_start = today_dt - timedelta(days=today_dt.weekday())  # 本周周一
print(f"\n  本周（{week_start} 起）每日学习时长:")
for i in range(7):
    d = (week_start + timedelta(days=i)).isoformat()
    mins = heatmap.get(d, 0)
    label = ["周一","周二","周三","周四","周五","周六","周日"][i]
    bar = "█" * min(int(mins/30), 20)
    print(f"    {label} {d}: {mins:4}分 {bar}")

# ── 4. 进度 vs 剩余天数一致性检查 ────────────────────────────────
section("4. 目标进度 vs 剩余天数一致性检查")

print(f"  {'目标':<26} {'完成%':>6} {'时间消耗%':>8} {'偏差':>6} {'剩余天数':>8} {'状态'}")
print(f"  {'-'*70}")

issues = []
for goal in goals:
    gid  = goal["id"]
    prog = requests.get(f"{BASE}/api/v1/goals/{gid}/progress", headers=H).json()

    deadline_dt = dt_cls.fromisoformat(goal["deadline"])
    created_str = goal["created_at"][:10]
    created_dt  = dt_cls.fromisoformat(created_str)
    total_days  = max(1, (deadline_dt - created_dt).days)
    elapsed     = max(0, (today_dt - created_dt).days)
    days_left   = max(0, (deadline_dt - today_dt).days)

    # 时间消耗百分比（应做多少）
    time_pct    = round(elapsed / total_days * 100, 1)
    # 任务完成百分比（实际做了多少）
    total_t     = prog["total_tasks"]
    done_t      = prog["completed_tasks"]
    task_pct    = round(done_t / max(1, total_t) * 100, 1)
    diff        = round(task_pct - time_pct, 1)
    ahead_behind = prog["days_ahead_or_behind"]

    if diff > 20:
        status = f"  {OK} 大幅超前 +{diff}%"
    elif diff > 0:
        status = f"  {OK} 超前 +{diff}%"
    elif diff > -20:
        status = f"  {WARN} 落后 {diff}%"
    else:
        status = f"  {FAIL} 严重落后 {diff}%"

    # 检查逻辑一致性：days_ahead_or_behind 与 diff 方向是否一致
    if (ahead_behind > 0) != (diff >= 0) and total_t > 0 and done_t > 0:
        issues.append(f"  ⚠ {goal['title'][:20]}: task_pct({task_pct}%) vs time_pct({time_pct}%) 方向与 days_ahead_or_behind({ahead_behind}) 不一致")

    print(f"  {goal['title'][:25]:<26} {task_pct:>5.1f}% {time_pct:>7.1f}%  {diff:>+6.1f}% {days_left:>6}天{status}")

    # 进度公式验证：days_ahead_or_behind 推导
    if total_t > 0 and done_t > 0:
        ratio = done_t / total_t
        est_days = int(elapsed / ratio)
        est_end  = created_dt + timedelta(days=est_days)
        calc_ahead = (deadline_dt - est_end).days
        match = "✓" if calc_ahead == ahead_behind else f"✗(计算:{calc_ahead} 后端:{ahead_behind})"
        print(f"    └ days_ahead_or_behind 公式验证: {match}  预计完成:{est_end.isoformat()}")

if issues:
    print(f"\n  {WARN} 发现逻辑不一致:")
    for iss in issues:
        print(iss)
else:
    print(f"\n  {OK}  进度 vs 剩余天数方向一致，无逻辑错误")

# ── 5. 汇总 ──────────────────────────────────────────────────
section("5. 汇总")

# check-in 记录 vs 任务完成率对比
checkins_total = 0
for goal in goals:
    gid = goal["id"]
    prog = requests.get(f"{BASE}/api/v1/goals/{gid}/progress", headers=H).json()
    checkins_total += prog.get("streak_days", 0)

today_tasks_check = requests.get(f"{BASE}/api/v1/tasks?date={TODAY}", headers=H).json()
t_pending = [t for t in today_tasks_check if not t.get("done") and t.get("goalId") in latest_goal_ids]
t_done    = [t for t in today_tasks_check if t.get("done") and t.get("goalId") in latest_goal_ids]

print(f"  {INFO}  最新6目标 今日任务: 待完成 {len(t_pending)} 条，已完成 {len(t_done)} 条")
print(f"  {INFO}  热力图覆盖天数: {len(heatmap)} 天，总学习分钟: {sum(heatmap.values())}")
print(f"  {INFO}  本周学习分钟: {sum(heatmap.get((week_start+timedelta(days=i)).isoformat(),0) for i in range(7))}")
print(f"  {INFO}  AI 规划时间块: {len(blocks)} 个，已持久化至 /api/v1/schedule/today")
print(f"\n  {OK}  检查完成")
print()
