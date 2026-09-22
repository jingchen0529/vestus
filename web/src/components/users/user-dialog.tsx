import React, { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DatePicker } from "@/components/ui/date-picker";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DesktopUser, CreateUserPayload, UpdateUserPayload } from "@/types/user";
import { ProxyItem } from "@/types/proxy";
import { AdminUser } from "@/types/admin";
import { generateRandomPassword } from "@/lib/utils";
import { Sparkles, Copy, Check, Globe, UserCog } from "lucide-react";
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
            proxyId: resolvedProxyId(),
            boundAdminId: resolvedBoundAdminId(),
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
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>{isEditing ? "编辑桌面端用户" : "开通桌面端账号"}</DialogTitle>
          <DialogDescription className="text-xs">
            {isEditing
              ? "修改用户基本资料、授权有效期、最大并发数或 VPN 指派"
              : "创建全新的桌面客户端受权账号，并设置初始密码"}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 py-2">
          <div className="grid grid-cols-2 gap-3">
            {/* Username */}
            <div className="space-y-1.5">
              <Label htmlFor="u-username" required={!isEditing}>
                登录账号
              </Label>
              <Input
                id="u-username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="例如: client01"
                disabled={isEditing || loading}
                required
              />
            </div>

            {/* Name */}
            <div className="space-y-1.5">
              <Label htmlFor="u-name" required>
                用户姓名 / 简称
              </Label>
              <Input
                id="u-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例如: 张三"
                disabled={loading}
                required
              />
            </div>
          </div>

          {/* Password for creation */}
          {!isEditing && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="u-password" required>
                  初始密码
                </Label>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleGeneratePassword}
                    className="text-[11px] text-primary hover:underline flex items-center gap-1"
                  >
                    <Sparkles className="h-3 w-3" />
                    <span>生成强密码</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleCopyPassword}
                    className="text-[11px] text-muted-foreground hover:text-foreground flex items-center gap-1"
                  >
                    {copied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
                    <span>{copied ? "已复制" : "复制"}</span>
                  </button>
                </div>
              </div>
              <Input
                id="u-password"
                type="text"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="至少 6 位密码"
                minLength={6}
                required
                disabled={loading}
              />
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            {/* Company */}
            <div className="space-y-1.5">
              <Label htmlFor="u-company">所属企业 / 团队</Label>
              <Input
                id="u-company"
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                placeholder="例如: 智能科技"
                disabled={loading}
              />
            </div>

            {/* Phone */}
            <div className="space-y-1.5">
              <Label htmlFor="u-phone">联系电话</Label>
              <Input
                id="u-phone"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="例如: 13800000000"
                disabled={loading}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            {/* Expires At */}
            <div className="space-y-1.5">
              <Label htmlFor="u-expires">授权到期日</Label>
              <DatePicker
                id="u-expires"
                value={expiresAt}
                onChange={(val) => setExpiresAt(val)}
                disabled={loading}
                placeholder="永久有效"
              />
              <span className="text-[11px] text-muted-foreground">留空表示永久有效</span>
            </div>

            {/* Max Sessions */}
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
                required
                disabled={loading}
              />
            </div>
          </div>

          {isEditing && (
            <div className="space-y-1.5">
              <Label htmlFor="u-status">账号状态</Label>
              <Select
                value={status}
                onValueChange={(val: DesktopUser["status"]) => setStatus(val)}
              >
                <SelectTrigger id="u-status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">正常启用</SelectItem>
                  <SelectItem value="disabled">禁用访问</SelectItem>
                  <SelectItem value="locked">已锁定</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          {canAssignVpn && (
            <div className="grid grid-cols-2 gap-3">
              {/* Assigned VPN */}
              <div className="space-y-1.5">
                <Label htmlFor="u-proxy" className="flex items-center gap-1.5">
                  <Globe className="h-3.5 w-3.5 text-emerald-500" />
                  <span>指定 VPN 节点</span>
                </Label>
                <Select
                  value={proxyChoice}
                  onValueChange={(val: string) => setProxyChoice(val)}
                >
                  <SelectTrigger id="u-proxy" className="text-xs">
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
                <span className="text-[11px] text-muted-foreground">
                  未单独配置的用户使用代理池中的默认节点
                </span>
              </div>

              {/* Bound admin */}
              <div className="space-y-1.5">
                <Label htmlFor="u-bound-admin" className="flex items-center gap-1.5">
                  <UserCog className="h-3.5 w-3.5 text-emerald-500" />
                  <span>绑定管理员</span>
                </Label>
                <Select
                  value={adminChoice}
                  onValueChange={(val: string) => setAdminChoice(val)}
                >
                  <SelectTrigger id="u-bound-admin" className="text-xs">
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
                <span className="text-[11px] text-muted-foreground">
                  该管理员只能查看绑定用户的操作数据
                </span>
              </div>
            </div>
          )}

          {/* Remark */}
          <div className="space-y-1.5">
            <Label htmlFor="u-remark">备注说明</Label>
            <Input
              id="u-remark"
              value={remark}
              onChange={(e) => setRemark(e.target.value)}
              placeholder="可选的备注信息"
              disabled={loading}
            />
          </div>

          <DialogFooter className="pt-2">
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
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
