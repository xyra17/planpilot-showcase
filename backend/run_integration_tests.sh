#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

REPORT_DIR="tests/integration/reports"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
REPORT_FILE="$REPORT_DIR/report_${TIMESTAMP}.html"
SNAPSHOT_FILE="$REPORT_DIR/test_data_snapshot.json"

echo "============================="
echo " PlanPilot 集成测试"
echo " $(date '+%Y-%m-%d %H:%M:%S')"
echo "============================="

# 激活虚拟环境（如存在）
if [ -f ".venv/bin/activate" ]; then
    source .venv/bin/activate
fi

# 安装测试依赖
pip install -q -r requirements-test.txt

# 检查 PostgreSQL 连接
TEST_DB_URL="${TEST_DATABASE_URL:-postgresql://planpilot:password@localhost:5432/planpilot_test}"
echo ""
echo "[1/3] 检查 PostgreSQL 连接..."
python -c "
import asyncio, sys
import asyncpg
async def check():
    url = '${TEST_DB_URL}'.replace('postgresql+asyncpg://', 'postgresql://').replace('postgresql://', '')
    try:
        conn = await asyncpg.connect('postgresql://${TEST_DB_URL#*://}')
        await conn.close()
        print('    ✓ PostgreSQL 连接成功')
    except Exception as e:
        print(f'    ✗ PostgreSQL 连接失败: {e}')
        print('    请确保 PostgreSQL 已启动，且 planpilot_test 数据库已创建：')
        print('      createdb planpilot_test')
        sys.exit(1)
asyncio.run(check())
" 2>/dev/null || {
    echo "    提示：如未安装 asyncpg，请先运行: pip install asyncpg"
    echo "    继续尝试运行测试..."
}

echo ""
echo "[2/3] 运行集成测试..."
echo ""

# 运行测试（-p no:warnings 减少噪音）
pytest tests/integration/ \
    -v \
    --tb=short \
    -p no:warnings \
    --html="$REPORT_FILE" \
    --self-contained-html \
    -m integration \
    "$@"

EXIT_CODE=$?

echo ""
echo "============================="
echo "[3/3] 测试完成"
echo "============================="
echo ""
echo "  HTML 报告: $REPORT_FILE"
echo "  数据快照:  $SNAPSHOT_FILE"
echo ""

if [ $EXIT_CODE -eq 0 ]; then
    echo "  状态: ✓ 全部通过"
else
    echo "  状态: ✗ 部分失败（退出码: $EXIT_CODE）"
fi

echo ""

# macOS 自动打开报告
if [ "$(uname)" = "Darwin" ] && [ -f "$REPORT_FILE" ]; then
    open "$REPORT_FILE"
fi

exit $EXIT_CODE
