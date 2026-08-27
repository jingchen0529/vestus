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
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DesktopUser, CreateUserPayload, UpdateUserPayload } from "@/types/user";
import { generateRandomPassword } from "@/lib/utils";
import { Sparkles, Copy, Check } from "lucide-react";
import { toast } from "sonner";

interface UserDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userToEdit?: DesktopUser | null;
  onSubmitCreate: (payload: CreateUserPayload) => Promise<void>;
  onSubmitUpdate: (id: number, payload: UpdateUserPayload) => Promise<void>;
}

interface UserEditFormValues {
  name: string;
  company: string;
  phone: string;
  expiresAt: string;
  maxSessions: number;
  remark: string;
  status: DesktopUser["status"];
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

  return payload;
}

export function UserDialog({
  open,
  onOpenChange,
  userToEdit,
  onSubmitCreate,
  onSubmitUpdate,
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>{isEditing ? "编辑桌面端用户" : "开通桌面端账号"}</DialogTitle>
          <DialogDescription className="text-xs">
            {isEditing
              ? "修改用户基本资料、授权有效期或最大并发数"
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
              <Input
                id="u-expires"
                type="date"
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
                disabled={loading}
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
