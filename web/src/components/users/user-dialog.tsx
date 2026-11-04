import React, { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DatePicker } from "@/components/ui/date-picker";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DesktopUser, CreateUserPayload, UpdateUserPayload } from "@/types/user";
import { ProxyItem } from "@/types/proxy";
import { AdminUser } from "@/types/admin";
import { generateRandomPassword, cn } from "@/lib/utils";
import { Sparkles, Copy, Check, Eye, EyeOff } from "lucide-react";
import { toast } from "sonner";

interface UserDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userToEdit?: DesktopUser | null;
  onSubmitCreate: (payload: CreateUserPayload) => Promise<void>;
  onSubmitUpdate: (id: number, payload: UpdateUserPayload) => Promise<void>;
  /** 仅超级管理员可见：可指派的 VPN 节点列表（含停用节点，供编辑展示）。 */
  proxies?: ProxyItem[];
  /** 仅超级管理员可见：可绑定的管理员列表。 */
  admins?: AdminUser[];
  canAssignVpn?: boolean;
}

interface UserEditFormValues {
  name: string;
  company: string;
  phone: string;
  expiresAt: string;
  maxSessions: number;
  remark: string;
  status: DesktopUser["status"];
  /** 仅超级管理员的表单会带上这两个字段；普通管理员的表单保持缺省。 */
  proxyId?: number | null;
  boundAdminId?: number | null;
}

export function buildUserUpdatePayload(
  originalUser: Pick<DesktopUser, "status">,
  values: UserEditFormValues,
): UpdateUserPayload {
  const payload: UpdateUserPayload = {
    name: values.name.trim(),
    company: values.company.trim() || null,
    phone: values.phone.trim() || null,
    expiresAt: values.expiresAt || null,
    maxSessions: Number(values.maxSessions) || 1,
    remark: values.remark.trim() || null,
  };

  if (values.status !== originalUser.status) {
    payload.status = values.status;
  }

  // 只有超管的表单会提交 VPN 指派与绑定管理员；普通管理员不触碰这两个字段。
  if (values.proxyId !== undefined) {
    payload.proxyId = values.proxyId;
  }
  if (values.boundAdminId !== undefined) {
    payload.boundAdminId = values.boundAdminId;
  }

  return payload;
}

/** 表单分区：左侧小标题 + 贯穿的分隔线，让长表单有可扫读的段落。 */
function FormSection({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-3 flex items-baseline gap-2.5">
        <h3 className="shrink-0 text-[11px] font-semibold tracking-[0.06em] text-foreground/60">
          {title}
        </h3>
        <div className="h-px flex-1 bg-border/60" />
        {hint && (
          <span className="shrink-0 text-[10.5px] text-muted-foreground/70">{hint}</span>
        )}
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-3.5">{children}</div>
    </section>
  );
}

const FIELD = "h-10";

const ICON_BTN =
  "inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50";

export function UserDialog({
  open,
  onOpenChange,
  userToEdit,
  onSubmitCreate,
  onSubmitUpdate,
  proxies = [],
  admins = [],
  canAssignVpn = false,
}: UserDialogProps) {
  const isEditing = !!userToEdit;

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [company, setCompany] = useState("");
  const [phone, setPhone] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [maxSessions, setMaxSessions] = useState(1);
  const [remark, setRemark] = useState("");
  const [status, setStatus] = useState<DesktopUser["status"]>("active");
  /** "default" 表示跟随默认代理；其余为 ProxyItem.id 的字符串形式。 */
  const [proxyChoice, setProxyChoice] = useState("default");
  /** "none" 表示不绑定；其余为 AdminUser.id 的字符串形式。 */
  const [adminChoice, setAdminChoice] = useState("none");

  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    if (userToEdit) {
      setUsername(userToEdit.username || "");
      setPassword("");
      setName(userToEdit.name || "");
      setCompany(userToEdit.company || "");
      setPhone(userToEdit.phone || "");
      setExpiresAt(
        userToEdit.expiresAt ? userToEdit.expiresAt.substring(0, 10) : ""
      );
      setMaxSessions(userToEdit.maxSessions || 1);
      setRemark(userToEdit.remark || "");
      setStatus(userToEdit.status);
      setProxyChoice(userToEdit.proxyId ? String(userToEdit.proxyId) : "default");
      setAdminChoice(userToEdit.boundAdminId ? String(userToEdit.boundAdminId) : "none");
    } else {
      setUsername("");
      setPassword(generateRandomPassword(10));
      setName("");
      setCompany("");
      setPhone("");
      setExpiresAt("");
      setMaxSessions(1);
      setRemark("");
      setStatus("active");
      setProxyChoice("default");
      setAdminChoice("none");
    }
  }, [userToEdit, open]);

  const handleGeneratePassword = () => {
    const pwd = generateRandomPassword(12);
    setPassword(pwd);
    setShowPassword(true);
    toast.info("已生成随机强密码");
  };

  const handleCopyPassword = () => {
    navigator.clipboard.writeText(password);
    setCopied(true);
    toast.success("密码已复制到剪贴板");
    setTimeout(() => setCopied(false), 2000);
  };

  const resolvedProxyId = (): number | null =>
    proxyChoice === "default" ? null : Number(proxyChoice);
  const resolvedBoundAdminId = (): number | null =>
    adminChoice === "none" ? null : Number(adminChoice);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      toast.error("用户名称不能为空");
      return;
    }

    setLoading(true);
    try {
      if (isEditing && userToEdit) {
        await onSubmitUpdate(
          userToEdit.id,
          buildUserUpdatePayload(userToEdit, {
            name,
            company,
            phone,
            expiresAt,
            maxSessions,
            remark,
            status,
            // 普通管理员的表单没有这两个选择器，不提交这两个字段：服务端把它们
            // 视为超管专属，凭空带上去只会收到 403。
            ...(canAssignVpn
              ? { proxyId: resolvedProxyId(), boundAdminId: resolvedBoundAdminId() }
              : {}),
          }),
        );
        toast.success(`用户 ${userToEdit.username} 已更新`);
      } else {
        if (!username.trim() || !password) {
          toast.error("账号和初始密码不能为空");
          return;
        }
        await onSubmitCreate({
          username: username.trim(),
          password,
          name: name.trim(),
          company: company.trim() || null,
          phone: phone.trim() || null,
          expiresAt: expiresAt || null,
          maxSessions: Number(maxSessions) || 1,
          remark: remark.trim() || null,
          proxyId: canAssignVpn ? resolvedProxyId() : undefined,
          boundAdminId: canAssignVpn ? resolvedBoundAdminId() : undefined,
        });
        toast.success(`桌面端用户 ${username} 创建成功`);
      }
      onOpenChange(false);
    } catch (err: any) {
      toast.error(isEditing ? "更新失败" : "创建失败", {
        description: err.message || "请检查输入数据",
      });
    } finally {
      setLoading(false);
    }
  };

  // 可选节点 = 当前启用的节点；编辑时若当前指派的节点已停用，也要能显示出来。
  const proxyOptions = proxies.filter(
    (p) => p.status === "active" || (userToEdit?.proxyId && p.id === userToEdit.proxyId)
  );
  const adminOptions = admins.filter(
    (a) => a.status === "active" || (userToEdit?.boundAdminId && a.id === userToEdit.boundAdminId)
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[88vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[620px]">
        {/* 头部：固定不滚动 */}
        <div className="shrink-0 border-b border-border/60 px-6 pb-4 pr-14 pt-5">
          <DialogTitle className="text-[17px] font-semibold leading-tight tracking-[-0.01em]">
            {isEditing ? "编辑桌面端用户" : "开通桌面端账号"}
          </DialogTitle>
          <DialogDescription className="mt-1.5 text-xs leading-relaxed">
            {isEditing
              ? "修改基本资料、授权有效期、并发上限与节点指派"
              : "创建全新的桌面客户端授权账号，并设定初始密码"}
          </DialogDescription>
        </div>

        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
          {/* 表单主体：唯一可滚动区域 */}
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5">
            <FormSection
              title="账号凭据"
              hint={isEditing ? "登录账号不可修改" : undefined}
            >
              <div className="space-y-1.5">
                <Label htmlFor="u-username" required={!isEditing}>
                  登录账号
                </Label>
                <Input
                  id="u-username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="例如 client01"
                  className={`${FIELD} font-mono text-[13px]`}
                  disabled={isEditing || loading}
                  required
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="u-name" required>
                  用户姓名 / 简称
                </Label>
                <Input
                  id="u-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="例如 张三"
                  className={FIELD}
                  disabled={loading}
                  required
                />
              </div>

              {!isEditing && (
                <div className="col-span-2 space-y-1.5">
                  <Label htmlFor="u-password" required>
                    初始密码
                  </Label>
                  <div className="relative">
                    <Input
                      id="u-password"
                      type={showPassword ? "text" : "password"}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="至少 6 位密码"
                      className={`${FIELD} pr-[108px] font-mono text-[13px]`}
                      minLength={6}
                      required
                      disabled={loading}
                    />
                    <div className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
                      <button
                        type="button"
                        title={showPassword ? "隐藏密码" : "显示密码"}
                        onClick={() => setShowPassword((v) => !v)}
                        className={ICON_BTN}
                        disabled={loading}
                      >
                        {showPassword ? (
                          <EyeOff className="h-3.5 w-3.5" />
                        ) : (
                          <Eye className="h-3.5 w-3.5" />
                        )}
                      </button>
                      <button
                        type="button"
                        title="生成随机强密码"
                        onClick={handleGeneratePassword}
                        className={ICON_BTN}
                        disabled={loading}
                      >
                        <Sparkles className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        title="复制密码"
                        onClick={handleCopyPassword}
                        className={ICON_BTN}
                        disabled={loading}
                      >
                        {copied ? (
                          <Check className="h-3.5 w-3.5 text-success" />
                        ) : (
                          <Copy className="h-3.5 w-3.5" />
                        )}
                      </button>
                    </div>
                  </div>
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    创建后请把密码转交用户，并提醒其首次登录后自行修改
                  </p>
                </div>
              )}

              <div className="space-y-1.5">
                <Label htmlFor="u-company">所属企业 / 团队</Label>
                <Input
                  id="u-company"
                  value={company}
                  onChange={(e) => setCompany(e.target.value)}
                  placeholder="例如 智能科技"
                  className={FIELD}
                  disabled={loading}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="u-phone">联系电话</Label>
                <Input
                  id="u-phone"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="例如 13800000000"
                  className={`${FIELD} tabular-nums`}
                  disabled={loading}
                />
              </div>

              <div className="col-span-2 space-y-1.5">
                <Label htmlFor="u-remark">备注说明</Label>
                <Input
                  id="u-remark"
                  value={remark}
                  onChange={(e) => setRemark(e.target.value)}
                  placeholder="可选，例如对接人、合同编号"
                  className={FIELD}
                  disabled={loading}
                />
              </div>
            </FormSection>

            <FormSection title="授权与配额" hint="到期日留空表示永久有效">
              <div className="space-y-1.5">
                <Label htmlFor="u-expires">授权到期日</Label>
                <DatePicker
                  id="u-expires"
                  value={expiresAt}
                  onChange={(val) => setExpiresAt(val)}
                  disabled={loading}
                  placeholder="永久有效"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="u-sessions" required>
                  最大登录并发数
                </Label>
                <Input
                  id="u-sessions"
                  type="number"
                  min={1}
                  max={50}
                  value={maxSessions}
                  onChange={(e) => setMaxSessions(Number(e.target.value))}
                  className={`${FIELD} tabular-nums`}
                  required
                  disabled={loading}
                />
              </div>

              {isEditing && (
                <div className="col-span-2 space-y-1.5">
                  <Label htmlFor="u-status">账号状态</Label>
                  <div
                    id="u-status"
                    role="radiogroup"
                    aria-label="账号状态"
                    className="grid grid-cols-3 gap-1 rounded-[10px] border border-border/70 bg-muted/40 p-1"
                  >
                    {(
                      [
                        { value: "active", label: "正常启用", dot: "bg-success" },
                        { value: "disabled", label: "禁用访问", dot: "bg-muted-foreground/50" },
                        { value: "locked", label: "已锁定", dot: "bg-warning" },
                      ] as const
                    ).map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        role="radio"
                        aria-checked={status === opt.value}
                        onClick={() => setStatus(opt.value)}
                        disabled={loading}
                        className={cn(
                          "flex items-center justify-center gap-1.5 rounded-[7px] py-1.5 text-[12px] font-medium transition-all",
                          status === opt.value
                            ? "bg-card text-foreground shadow-xs"
                            : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        <i
                          className={cn(
                            "h-1.5 w-1.5 rounded-full",
                            opt.dot,
                            status !== opt.value && "opacity-45",
                          )}
                        />
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </FormSection>

            {canAssignVpn && (
              <FormSection title="分配关系" hint="留空则继承全局默认">
                <div className="space-y-1.5">
                  <Label htmlFor="u-proxy">指定 VPN 节点</Label>
                  <Select
                    value={proxyChoice}
                    onValueChange={(val: string) => setProxyChoice(val)}
                  >
                    <SelectTrigger id="u-proxy" className={FIELD}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="default">默认（跟随默认代理）</SelectItem>
                      {proxyOptions.map((proxy) => (
                        <SelectItem key={proxy.id} value={String(proxy.id)}>
                          {proxy.name}
                          {proxy.status !== "active" ? "（已停用）" : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    未单独配置的用户使用代理池中的默认节点
                  </p>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="u-bound-admin">绑定管理员</Label>
                  <Select
                    value={adminChoice}
                    onValueChange={(val: string) => setAdminChoice(val)}
                  >
                    <SelectTrigger id="u-bound-admin" className={FIELD}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">不绑定（仅超管可见）</SelectItem>
                      {adminOptions.map((admin) => (
                        <SelectItem key={admin.id} value={String(admin.id)}>
                          {admin.name}（{admin.username}）
                          {admin.status !== "active" ? "（已停用）" : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    该管理员只能查看绑定用户的操作数据
                  </p>
                </div>
              </FormSection>
            )}
          </div>

          {/* 底部操作区：固定不滚动 */}
          <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border/60 bg-muted/30 px-6 py-3.5">
            <span className="text-[11px] text-muted-foreground">
              带 <span className="text-destructive">*</span> 为必填项
            </span>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={loading}
              >
                取消
              </Button>
              <Button type="submit" loading={loading}>
                {isEditing ? "保存变更" : "确认开通"}
              </Button>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
