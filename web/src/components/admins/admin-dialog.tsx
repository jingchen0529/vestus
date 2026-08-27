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
import { AdminUser, CreateAdminPayload, UpdateAdminPayload } from "@/types/admin";
import { AdminRole } from "@/types/auth";
import { generateRandomPassword } from "@/lib/utils";
import { ShieldCheck, Sparkles, Copy, Check } from "lucide-react";
import { toast } from "sonner";

interface AdminDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  adminToEdit?: AdminUser | null;
  onSubmitCreate: (payload: CreateAdminPayload) => Promise<void>;
  onSubmitUpdate: (id: number, payload: UpdateAdminPayload) => Promise<void>;
}

export function AdminDialog({
  open,
  onOpenChange,
  adminToEdit,
  onSubmitCreate,
  onSubmitUpdate,
}: AdminDialogProps) {
  const isEditing = !!adminToEdit;

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<AdminRole>("admin");
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (adminToEdit) {
      setUsername(adminToEdit.username || "");
      setPassword("");
      setName(adminToEdit.name || "");
      setRole(adminToEdit.role || "admin");
    } else {
      setUsername("");
      setPassword(generateRandomPassword(12));
      setName("");
      setRole("admin");
    }
  }, [adminToEdit, open]);

  const handleGeneratePassword = () => {
    const pwd = generateRandomPassword(12);
    setPassword(pwd);
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
      toast.error("请输入管理员姓名");
      return;
    }

    setLoading(true);
    try {
      if (isEditing && adminToEdit) {
        await onSubmitUpdate(adminToEdit.id, {
          name: name.trim(),
          role,
        });
        toast.success(`管理员 ${adminToEdit.username} 资料已更新`);
      } else {
        if (!username.trim() || !password) {
          toast.error("账号和初始密码不能为空");
          setLoading(false);
          return;
        }
        await onSubmitCreate({
          username: username.trim(),
          password,
          name: name.trim(),
          role,
        });
        toast.success(`管理员 ${username} 创建成功`);
      }
      onOpenChange(false);
    } catch (err: any) {
      toast.error(isEditing ? "保存失败" : "创建失败", {
        description: err.message || "请核对参数",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <div className="flex items-center gap-2 text-primary mb-1">
            <ShieldCheck className="h-5 w-5" />
            <DialogTitle>{isEditing ? "编辑管理员信息" : "添加新系统管理员"}</DialogTitle>
          </div>
          <DialogDescription className="text-xs">
            {isEditing
              ? "修改管理员姓名及受权角色"
              : "创建管理后台操作账号并分配相应的管理角色"}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 py-2">
          {/* Username */}
          <div className="space-y-1.5">
            <Label htmlFor="adm-username" required={!isEditing}>
              管理员账号
            </Label>
            <Input
              id="adm-username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="例如: admin_dev"
              required={!isEditing}
              disabled={isEditing || loading}
            />
          </div>

          {/* Password (for creation) */}
          {!isEditing && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="adm-pwd" required>
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
                id="adm-pwd"
                type="text"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                minLength={6}
                required
                disabled={loading}
              />
            </div>
          )}

          {/* Name */}
          <div className="space-y-1.5">
            <Label htmlFor="adm-name" required>
              姓名 / 备注
            </Label>
            <Input
              id="adm-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如: 运维专员"
              required
              disabled={loading}
            />
          </div>

          {/* Role Selection */}
          <div className="space-y-1.5">
            <Label htmlFor="adm-role">权限角色</Label>
            <Select
              value={role}
              onValueChange={(val: AdminRole) => setRole(val)}
            >
              <SelectTrigger id="adm-role" className="h-9 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="admin">普通管理员 (管理桌面用户与配置)</SelectItem>
                <SelectItem value="super_admin">超级管理员 (拥有全部管理权限及成员分配)</SelectItem>
              </SelectContent>
            </Select>
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
              {isEditing ? "保存修改" : "创建管理员"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
