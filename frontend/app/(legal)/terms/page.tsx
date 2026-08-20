import { LegalPage } from "@/components/app/LegalPage";

export default function TermsPage() {
  return (
    <LegalPage title="用户协议" updatedAt="2026 年 8 月 5 日">
      <section>
        <h2>1. 服务说明</h2>
        <p>PlanPilot 提供目标、任务、学习记录与智能学习建议等工具。智能建议仅用于辅助学习决策，最终计划与执行由你确认。</p>
      </section>
      <section>
        <h2>2. 账号使用</h2>
        <p>你应提供真实、有效的注册信息，妥善保管账号与密码，并对账号下发生的操作负责。发现异常使用时，请及时修改密码或联系管理员。</p>
      </section>
      <section>
        <h2>3. 使用规范</h2>
        <p>不得利用本服务上传违法、有害或侵害他人权益的内容，也不得破坏服务安全、绕过访问控制或干扰其他用户正常使用。</p>
      </section>
      <section>
        <h2>4. 服务变更</h2>
        <p>为改善产品、安全性或合规要求，我们可能调整功能与规则；重要变化会通过产品内适当方式提示。</p>
      </section>
    </LegalPage>
  );
}
