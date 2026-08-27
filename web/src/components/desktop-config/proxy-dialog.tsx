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
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ProxyItem, CreateProxyPayload, UpdateProxyPayload } from "@/types/proxy";
import { toast } from "sonner";
import { Server, Eye, EyeOff, ShieldCheck, ShieldOff } from "lucide-react";

interface ProxyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  proxyToEdit?: ProxyItem | null;
  onSubmitCreate: (payload: CreateProxyPayload) => Promise<void>;
  onSubmitUpdate: (id: number, payload: UpdateProxyPayload) => Promise<void>;
}

/** 一行一个主机名；同时容忍逗号、分号和空格分隔，便于从表格里粘贴。 */
function parseBypassHosts(raw: string): string[] {
  return raw
    .split(/[\s,;]+/)
    .map((host) => host.trim())
    .filter(Boolean);
}

export function ProxyDialog({
  open,
  onOpenChange,
  proxyToEdit,
  onSubmitCreate,
  onSubmitUpdate,
}: ProxyDialogProps) {
  const isEditing = !!proxyToEdit;

  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState<number | string>(8080);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [bypassHosts, setBypassHosts] = useState("");
  const [status, setStatus] = useState<"active" | "disabled">("active");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (proxyToEdit) {
      setName(proxyToEdit.name || "");
      setHost(proxyToEdit.host || "");
      setPort(proxyToEdit.port || 8080);
      setUsername(proxyToEdit.username || "");
      setPassword("");
      setBypassHosts((proxyToEdit.bypassHosts || []).join("\n"));
      setStatus(proxyToEdit.status || "active");
    } else {
      setName("");
      setHost("");
      setPort(8080);
      setUsername("");
      setPassword("");
      setBypassHosts("");
      setStatus("active");
    }
  }, [proxyToEdit, open]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const portNum = Number(port);
    if (!name.trim() || !host.trim() || !username.trim()) {
      toast.error("请完整填写代理名称、主机地址与认证账号");
      return;
    }
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      toast.error("代理端口必须在 1 到 65535 之间");
      return;
    }

    setLoading(true);
    try {
      const directHosts = parseBypassHosts(bypassHosts);
      if (isEditing && proxyToEdit) {
        const payload: UpdateProxyPayload = {
          name: name.trim(),
          host: host.trim(),
          port: portNum,
          username: username.trim(),
          bypassHosts: directHosts,
          status,
        };
        if (password) {
          payload.password = password;
        }
        await onSubmitUpdate(proxyToEdit.id, payload);
        toast.success(`代理配置 ${name} 已更新`);
      } else {
        if (!password) {
          toast.error("创建新代理时必须填写认证密码");
          setLoading(false);
          return;
        }
        await onSubmitCreate({
          name: name.trim(),
          host: host.trim(),
          port: portNum,
          username: username.trim(),
          password,
          bypassHosts: directHosts,
          status,
        });
        toast.success(`代理 ${name} 创建成功`);
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
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400 mb-1">
            <Server className="h-5 w-5" />
            <DialogTitle>{isEditing ? "编辑专属代理" : "新增专属网络代理"}</DialogTitle>
          </div>
          <DialogDescription className="text-xs">
            配置用于桌面端浏览器网络中继的 HTTP/SOCKS 代理节点信息
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 py-2">
          {/* Proxy Name */}
          <div className="space-y-1.5">
            <Label htmlFor="p-name" required>
              代理节点名称
            </Label>
            <Input
              id="p-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如: 华东机房高速代理01"
              required
              disabled={loading}
            />
          </div>

          <div className="grid grid-cols-3 gap-3">
            {/* Host */}
            <div className="col-span-2 space-y-1.5">
              <Label htmlFor="p-host" required>
                服务器主机 / IP
              </Label>
              <Input
                id="p-host"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="127.0.0.1 或 域名"
                className="font-mono text-xs"
                required
                disabled={loading}
              />
            </div>

            {/* Port */}
            <div className="space-y-1.5">
              <Label htmlFor="p-port" required>
                端口号
              </Label>
              <Input
                id="p-port"
                type="number"
                min={1}
                max={65535}
                value={port}
                onChange={(e) => setPort(e.target.value)}
                className="font-mono text-xs"
                required
                disabled={loading}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            {/* Username */}
            <div className="space-y-1.5">
              <Label htmlFor="p-username" required>
                认证账号
              </Label>
              <Input
                id="p-username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="代理账号"
                required
                disabled={loading}
              />
            </div>

            {/* Password */}
            <div className="space-y-1.5">
              <Label htmlFor="p-password" required={!isEditing}>
                认证密码 {isEditing && <span className="text-muted-foreground font-normal">(留空不改)</span>}
              </Label>
              <div className="relative">
                <Input
                  id="p-password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={isEditing ? "保持原密码" : "必填"}
                  required={!isEditing}
                  disabled={loading}
                  className="pr-8"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-2.5 top-2.5 text-muted-foreground hover:text-foreground"
                  tabIndex={-1}
                >
                  {showPassword ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </button>
              </div>
            </div>
          </div>

          {/* Direct-connect exceptions */}
          <div className="space-y-1.5">
            <Label htmlFor="p-bypass">直连域名（不走代理）</Label>
            <Textarea
              id="p-bypass"
              value={bypassHosts}
              onChange={(e) => setBypassHosts(e.target.value)}
              placeholder={"每行一个，例如：\nlf3-ad-platform.byteadverts.com\n*.byteadverts.com"}
              className="font-mono text-xs"
              rows={3}
              disabled={loading}
            />
            <p className="text-[11px] leading-4 text-muted-foreground">
              留空表示全部流量走代理。只填主机名，不要带协议、端口或路径；不接受 IP 与 localhost。
              <code className="mx-1">*.example.com</code>
              只匹配子域，不含 example.com 本身。
            </p>
          </div>

          {/* Status */}
          <div className="space-y-1.5">
            <Label htmlFor="p-status">可用状态</Label>
            <Select
              value={status}
              onValueChange={(val: "active" | "disabled") => setStatus(val)}
            >
              <SelectTrigger id="p-status" className="h-9 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="active">正常启用</SelectItem>
                <SelectItem value="disabled">暂时停用</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center gap-2 rounded-lg bg-muted/40 p-2.5 text-[11px] text-muted-foreground">
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
            <span>密码采用 Fernet 安全对称加密存储，仅在受权客户端建立连接时解密分发。</span>
          </div>

          {parseBypassHosts(bypassHosts).length > 0 && (
            <div className="flex items-center gap-2 rounded-lg bg-amber-500/10 p-2.5 text-[11px] text-amber-700 dark:text-amber-400">
              <ShieldOff className="h-3.5 w-3.5 shrink-0" />
              <span>直连域名不经过代理，会暴露用户本机的真实出口 IP，请只填确实需要直连的站点。</span>
            </div>
          )}

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
              {isEditing ? "保存代理变更" : "创建代理"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
