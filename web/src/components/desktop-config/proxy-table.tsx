import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { ProxyItem } from "@/types/proxy";
import { Server, Plus, Edit2, CheckCircle2, XCircle, RefreshCw } from "lucide-react";

interface ProxyTableProps {
  proxies: ProxyItem[];
  onOpenCreate: () => void;
  onEditProxy: (proxy: ProxyItem) => void;
  onRefresh: () => void;
  isLoading?: boolean;
}

export function ProxyTable({
  proxies,
  onOpenCreate,
  onEditProxy,
  onRefresh,
  isLoading,
}: ProxyTableProps) {
  const activeCount = proxies.filter((p) => p.status === "active").length;

  return (
    <Card className="border-border/80 shadow-sm">
      <CardHeader className="flex flex-row items-center justify-between pb-3">
        <div>
          <CardTitle className="text-base flex items-center gap-2">
            <Server className="h-4 w-4 text-emerald-500" />
            <span>代理池管理 ({proxies.length} 套)</span>
          </CardTitle>
          <CardDescription className="text-xs">
            在线启用: {activeCount} 套 · 已停用: {proxies.length - activeCount} 套
          </CardDescription>
        </div>
        <div className="flex items-center gap-2">
          <Button
            onClick={onOpenCreate}
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 text-xs rounded-lg border-border/80 bg-background hover:bg-accent text-foreground shadow-xs font-normal"
          >
            <Plus className="h-3.5 w-3.5 text-muted-foreground" />
            <span>新增代理</span>
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onRefresh}
            disabled={isLoading}
            className="h-8 gap-1.5 text-xs rounded-lg border-border/80 bg-background hover:bg-accent text-foreground shadow-xs font-normal"
          >
            <RefreshCw className={`h-3.5 w-3.5 text-muted-foreground ${isLoading ? "animate-spin" : ""}`} />
            <span>刷新</span>
          </Button>
        </div>
      </CardHeader>

      <CardContent className="p-0">
        {proxies.length === 0 ? (
          <div className="py-10 text-center text-xs text-muted-foreground">
            暂无代理配置，点击右上角【新增代理】录入节点
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>代理节点名称</TableHead>
                <TableHead>主机 / 端口</TableHead>
                <TableHead>认证账号</TableHead>
                <TableHead>状态</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {proxies.map((proxy) => (
                <TableRow key={proxy.id} className="hover:bg-muted/40 transition-colors text-xs">
                  <TableCell>
                    <div className="flex flex-col">
                      <span className="font-semibold text-foreground">{proxy.name}</span>
                      <span className="text-[11px] text-muted-foreground">#{proxy.id}</span>
                    </div>
                  </TableCell>
                  <TableCell className="font-mono">
                    {proxy.host}:{proxy.port}
                    {(proxy.bypassHosts?.length ?? 0) > 0 && (
                      <span
                        className="mt-0.5 block font-sans text-[11px] text-amber-600 dark:text-amber-400"
                        title={proxy.bypassHosts!.join("\n")}
                      >
                        直连 {proxy.bypassHosts!.length} 个域名
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-muted-foreground">
                    {proxy.username || "—"}
                  </TableCell>
                  <TableCell>
                    {proxy.status === "active" ? (
                      <Badge variant="success" className="gap-1 text-[10px]">
                        <CheckCircle2 className="h-3 w-3" />
                        <span>启用</span>
                      </Badge>
                    ) : (
                      <Badge variant="secondary" className="gap-1 text-[10px]">
                        <XCircle className="h-3 w-3" />
                        <span>停用</span>
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onEditProxy(proxy)}
                      className="h-7 px-2.5 text-xs gap-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/70 border border-border/40 hover:border-border/70 shadow-none font-normal transition-colors"
                    >
                      <Edit2 className="h-3.5 w-3.5 text-muted-foreground" />
                      <span>编辑</span>
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
