import { useState, useEffect } from "react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { DesktopUser } from "@/types/user";
import { ProxyItem } from "@/types/proxy";
import { DesktopConfigResponse, PlatformItem } from "@/types/platform";
import { Sliders, Server, Globe, Save, RefreshCw } from "lucide-react";
import { toast } from "sonner";

interface UserConfigCardProps {
  users: DesktopUser[];
  proxies: ProxyItem[];
  platforms: PlatformItem[];
  selectedUserId: number | null;
  onSelectUser: (userId: number | null) => void;
  config: DesktopConfigResponse | null;
  isLoadingConfig?: boolean;
  onSaveConfig: (userId: number, proxyId: number | null, platformIds: number[]) => Promise<void>;
  onRefreshAll: () => void;
}

export function buildDesktopConfigSelection(
  proxyId: string,
  platformIds: number[],
): { proxyId: number | null; platformIds: number[] } {
  return {
    proxyId: proxyId && proxyId !== "none" ? Number(proxyId) : null,
    platformIds: [...platformIds],
  };
}

export function UserConfigCard({
  users,
  proxies,
  platforms,
  selectedUserId,
  onSelectUser,
  config,
  isLoadingConfig,
  onSaveConfig,
  onRefreshAll,
}: UserConfigCardProps) {
  const [proxyId, setProxyId] = useState<string>("");
  const [platformIds, setPlatformIds] = useState<number[]>([]);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (config) {
      const assignedProxy =
        config.proxy && config.proxy.id !== undefined
          ? String(config.proxy.id)
          : config.proxyId
          ? String(config.proxyId)
          : "";
      setProxyId(assignedProxy);
      setPlatformIds(
        config.platformIds !== undefined
          ? [...config.platformIds]
          : (config.platforms || []).map((platform) => platform.id),
      );
    } else {
      setProxyId("");
      setPlatformIds([]);
    }
  }, [config, selectedUserId]);

  const handleSave = async () => {
    if (!selectedUserId) {
      toast.error("请先选择要配置的桌面端用户");
      return;
    }

    setIsSaving(true);
    try {
      const selection = buildDesktopConfigSelection(proxyId, platformIds);
      await onSaveConfig(
        selectedUserId,
        selection.proxyId,
        selection.platformIds,
      );
      const user = users.find((u) => u.id === selectedUserId);
      toast.success(`用户 ${user?.username || ""} 桌面配置已保存`, {
        description: `代理: ${selection.proxyId ? "已绑定" : "直连"} · 平台: ${selection.platformIds.length} 个`,
      });
    } catch (err: any) {
      toast.error("保存失败", { description: err.message || "请稍后重试" });
    } finally {
      setIsSaving(false);
    }
  };

  const selectedUser = users.find((u) => u.id === selectedUserId);
  const currentAssignedProxy = proxies.find((p) => String(p.id) === proxyId);

  return (
    <Card className="border-border/80 shadow-sm">
      <CardHeader className="flex flex-row items-center justify-between pb-3">
        <div>
          <CardTitle className="text-base flex items-center gap-2">
            <Sliders className="h-4 w-4 text-primary" />
            <span>用户桌面配置分配</span>
          </CardTitle>
          <CardDescription className="text-xs">
            为桌面客户端用户分配独立网络代理节点和可访问的业务平台
          </CardDescription>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={onRefreshAll}
          className="h-8 gap-1 text-xs"
        >
          <RefreshCw className="h-3 w-3" />
          <span>刷新全部配置</span>
        </Button>
      </CardHeader>

      <CardContent className="space-y-5 pt-2">
        {/* User & Proxy Selection Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Target User */}
          <div className="space-y-2">
            <Label htmlFor="target-user" className="text-xs font-semibold">
              目标桌面端用户
            </Label>
            <Select
              value={selectedUserId ? String(selectedUserId) : ""}
              onValueChange={(val) => onSelectUser(val ? Number(val) : null)}
            >
              <SelectTrigger id="target-user" className="h-10 text-xs">
                <SelectValue placeholder="请选择要配置的用户账号" />
              </SelectTrigger>
              <SelectContent>
                {users.map((u) => (
                  <SelectItem key={u.id} value={String(u.id)} className="text-xs">
                    <span className="font-semibold">{u.username}</span>
                    <span className="text-muted-foreground ml-1.5">
                      · {u.name} {u.company ? `(${u.company})` : ""}
                    </span>
                    {u.status !== "active" && (
                      <span className="text-destructive text-[10px] ml-1">
                        [不可用]
                      </span>
                    )}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selectedUser && (
              <div className="text-[11px] text-muted-foreground flex items-center gap-2">
                <span>用户编号: #{selectedUser.id}</span>
                <span>并发限制: {selectedUser.maxSessions} 路</span>
                <span>状态: {selectedUser.status === "active" ? "正常" : "受限"}</span>
              </div>
            )}
          </div>

          {/* Assigned Proxy */}
          <div className="space-y-2">
            <Label htmlFor="target-proxy" className="text-xs font-semibold">
              分配专属网络代理
            </Label>
            <Select
              value={proxyId}
              onValueChange={setProxyId}
              disabled={!selectedUserId || isLoadingConfig}
            >
              <SelectTrigger id="target-proxy" className="h-10 text-xs">
                <SelectValue placeholder="不分配代理（直连模式）" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none" className="text-xs text-muted-foreground">
                  不分配代理（直连模式）
                </SelectItem>
                {proxies.map((p) => (
                  <SelectItem key={p.id} value={String(p.id)} className="text-xs">
                    <span className="font-semibold">{p.name}</span>
                    <span className="font-mono text-muted-foreground ml-1.5">
                      ({p.host}:{p.port})
                    </span>
                    {p.status !== "active" && (
                      <span className="text-amber-500 text-[10px] ml-1">
                        [已停用]
                      </span>
                    )}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {currentAssignedProxy && (
              <div className="text-[11px] text-muted-foreground flex items-center gap-2">
                <Server className="h-3 w-3 text-emerald-500" />
                <span>
                  认证账号: {currentAssignedProxy.username || "—"} · 状态:{" "}
                  {currentAssignedProxy.status === "active" ? "正常" : "停用"}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Assigned Platforms */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-xs font-semibold">分配可访问平台</Label>
            <span className="text-[11px] text-muted-foreground">
              已选择 {platformIds.length} / {platforms.length}
            </span>
          </div>
          <div className="grid max-h-52 grid-cols-1 gap-2 overflow-y-auto rounded-xl border bg-muted/10 p-3 md:grid-cols-2">
            {platforms.length === 0 ? (
              <div className="col-span-full flex items-center gap-2 py-3 text-xs text-muted-foreground">
                <Globe className="h-4 w-4" />
                <span>暂无业务平台，请先到【平台管理】中创建</span>
              </div>
            ) : (
              platforms.map((platform) => {
                const isActive = platform.status === "active";
                const checked = platformIds.includes(platform.id);
                return (
                  <div
                    key={platform.id}
                    className="flex items-center justify-between gap-3 rounded-lg border bg-background px-3 py-2"
                  >
                    <Label
                      htmlFor={`desktop-platform-${platform.id}`}
                      className="min-w-0 cursor-pointer text-xs font-normal"
                    >
                      <span className="block truncate font-semibold text-foreground">
                        {platform.name}
                      </span>
                      <span className="block truncate text-[10px] text-muted-foreground">
                        {isActive ? platform.url : "已停用，暂不可分配"}
                      </span>
                    </Label>
                    <Switch
                      id={`desktop-platform-${platform.id}`}
                      checked={checked}
                      disabled={!selectedUserId || isLoadingConfig || (!isActive && !checked)}
                      onCheckedChange={(nextChecked) => {
                        setPlatformIds((current) =>
                          nextChecked
                            ? current.includes(platform.id)
                              ? current
                              : [...current, platform.id]
                            : current.filter((id) => id !== platform.id),
                        );
                      }}
                      aria-label={`${checked ? "取消" : "分配"}平台 ${platform.name}`}
                    />
                  </div>
                );
              })
            )}
          </div>
        </div>
      </CardContent>

      <CardFooter className="flex items-center justify-between border-t bg-muted/20 px-6 py-3">
        <div className="text-xs text-muted-foreground">
          {selectedUserId ? (
            <span>正在编辑用户 #{selectedUserId} 的桌面配置</span>
          ) : (
            <span>未选择用户</span>
          )}
        </div>

        <Button
          onClick={handleSave}
          disabled={!selectedUserId || isSaving || isLoadingConfig}
          loading={isSaving}
          className="h-9 gap-1.5 text-xs bg-primary hover:bg-primary/90 text-primary-foreground font-semibold shadow-sm"
        >
          <Save className="h-3.5 w-3.5" />
          <span>保存桌面配置</span>
        </Button>
      </CardFooter>
    </Card>
  );
}
