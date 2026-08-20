import { LegalPage } from "@/components/app/LegalPage";

export default function PrivacyPage() {
  return (
    <LegalPage title="隐私政策" updatedAt="2026 年 8 月 5 日">
      <section>
        <h2>1. 我们处理的信息</h2>
        <p>为提供服务，我们会处理账号信息、学习目标、任务、学习记录、笔记、界面偏好以及必要的服务运行日志。</p>
      </section>
      <section>
        <h2>2. 使用目的</h2>
        <p>这些信息用于身份验证、保存学习进度、生成个性化建议、保障账号安全以及改进服务可靠性。</p>
      </section>
      <section>
        <h2>3. 存储与保护</h2>
        <p>我们采用访问控制、密码哈希与必要的安全日志等措施保护数据。请勿在学习内容中提交不必要的敏感个人信息。</p>
      </section>
      <section>
        <h2>4. 你的选择</h2>
        <p>你可以在账号设置中更新资料、修改密码或申请删除账号及相关个人学习数据。</p>
      </section>
    </LegalPage>
  );
}
